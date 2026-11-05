import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { reconcile } from '../src/ledger.js';
import { SCALE } from '../src/market/lmsr.js';

process.env.NODE_ENV = 'test';

const HOUR = 3600_000;
const clock = Date.UTC(2026, 10, 1, 4, 0, 0);
let cfg: Config;
let db: DB;
let app: App;

beforeEach(async () => {
  cfg = loadConfig({ dbPath: ':memory:', adminUsernames: ['admin'], webDir: '', houseSubsidy: 500 * SCALE, positionCapB: 0, signupBonus: 1000 * SCALE });
  db = openDb(':memory:');
  app = await buildApp({ cfg, db, now: () => clock, rateLimit: false });
});

afterEach(async () => {
  await app.fastify.close();
  db.close();
});

type Json = Record<string, any>;

async function call(method: 'GET' | 'POST', url: string, cookie?: string, body?: unknown) {
  const res = await app.fastify.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(body !== undefined ? { payload: body as Json } : {}),
  });
  return { status: res.statusCode, body: res.json() as Json, res };
}

async function signup(name: string): Promise<string> {
  const r = await call('POST', '/api/register', undefined, { username: name, password: 'secret123' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return `sid=${r.res.cookies.find((c) => c.name === 'sid')!.value}`;
}

const balanceOf = async (cookie: string): Promise<number> => (await call('GET', '/api/me', cookie)).body.user.balance;

async function newMarket(cookie: string, subsidyPoints = 100): Promise<number> {
  const r = await call('POST', '/api/markets', cookie, {
    title: '明天会下雨吗？',
    rules: '以气象台发布的数据为准',
    closeAt: clock + 24 * HOUR,
    subsidy: subsidyPoints * SCALE,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id;
}

const scalar = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { s: number }).s;

/** Every point in existence is either in someone's balance or in a market pool. */
function conserved(): boolean {
  const held = scalar('SELECT COALESCE(SUM(balance), 0) AS s FROM users') + scalar('SELECT COALESCE(SUM(pool), 0) AS s FROM markets');
  const issued = scalar(`SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE reason IN ('signup', 'checkin', 'house_mint')`);
  return held === issued;
}

/** House profit: balance minus everything minted for it (negative = platform lost points). */
function houseNet(): number {
  const id = scalar(`SELECT id AS s FROM users WHERE username = '__house__'`);
  return (
    scalar('SELECT balance AS s FROM users WHERE id = ?', id) -
    scalar(`SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE user_id = ? AND reason = 'house_mint'`, id)
  );
}

describe('platform liquidity', () => {
  it('adds house liquidity to new markets and splits the leftover pro-rata', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const whale = await signup('bob');
    const id = await newMarket(creator, 100);

    const row = db.prepare('SELECT b, pool, house_subsidy FROM markets WHERE id = ?').get(id) as Json;
    expect(row.house_subsidy).toBe(500 * SCALE);
    expect(row.pool).toBe(600 * SCALE);
    expect(row.b).toBe(Math.floor((600 * SCALE) / Math.LN2));
    expect(await balanceOf(creator)).toBe(cfg.signupBonus - 100 * SCALE);

    // A 1000-point bet no longer slams the price to the cap.
    const t = await call('POST', `/api/markets/${id}/trade`, whale, { outcome: 'YES', side: 'BUY', amount: 1000 * SCALE });
    expect(t.body.quote.capped).toBe(false);
    expect(t.body.quote.priceYesAfter).toBeLessThan(0.9);

    const before = await balanceOf(creator);
    await call('POST', `/api/markets/${id}/resolve`, admin, { outcome: 'NO' });
    const pool = 600 * SCALE + t.body.quote.amount; // nobody holds NO, so the whole pool is left over
    const toCreator = Math.floor((pool * 100) / 600);
    expect(await balanceOf(creator)).toBe(before + toCreator);
    expect(houseNet()).toBe(pool - toCreator - 500 * SCALE);
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
  });

  it('admin adds liquidity without moving the price, and the pool stays solvent', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const a = await signup('bob');
    const b = await signup('carol');
    const id = await newMarket(creator, 100);
    await call('POST', `/api/markets/${id}/trade`, a, { outcome: 'YES', side: 'BUY', amount: 300 * SCALE });

    expect((await call('POST', `/api/markets/${id}/liquidity/quote`, a, { amount: 500 * SCALE })).status).toBe(403);

    const p0 = (await call('GET', `/api/markets/${id}`)).body.market.priceYes;
    const q = await call('POST', `/api/markets/${id}/liquidity/quote`, admin, { amount: 500 * SCALE });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.quote.bAfter).toBeGreaterThan(q.body.quote.bBefore);
    expect(q.body.quote.deposit).toBeGreaterThan(500 * SCALE); // off-centre price costs more than at 50%

    const low = await call('POST', `/api/markets/${id}/liquidity`, admin, { amount: 500 * SCALE, maxDeposit: 1 });
    expect(low.status).toBe(409);

    const r = await call('POST', `/api/markets/${id}/liquidity`, admin, {
      amount: 500 * SCALE,
      maxDeposit: q.body.quote.deposit,
    });
    expect(r.status).toBe(200);
    expect(r.body.market.priceYes).toBeCloseTo(p0, 3);
    expect(r.body.market.b).toBe(q.body.quote.bAfter);
    expect(reconcile(db).ok).toBe(true);

    // Worst case for the pool: traders pile into the side without virtual shares, then it wins.
    for (let i = 0; i < 8; i++) {
      await call('POST', `/api/markets/${id}/trade`, b, { outcome: 'NO', side: 'BUY', amount: 120 * SCALE });
      await call('POST', `/api/markets/${id}/trade`, a, { outcome: 'NO', side: 'BUY', amount: 80 * SCALE });
    }
    { const rr = reconcile(db); expect(rr, JSON.stringify(rr) + JSON.stringify(db.prepare("SELECT b,q_yes,q_no,v_yes,v_no,pool FROM markets").all())).toMatchObject({ ok: true }); }
    const res = await call('POST', `/api/markets/${id}/resolve`, admin, { outcome: 'NO' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
  });

  it('adding liquidity at 50% costs about the requested amount', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const id = await newMarket(creator, 100);
    const q = await call('POST', `/api/markets/${id}/liquidity/quote`, admin, { amount: 300 * SCALE });
    expect(q.body.quote.deposit).toBeGreaterThanOrEqual(299 * SCALE);
    expect(q.body.quote.deposit).toBeLessThanOrEqual(300 * SCALE);
  });

  it('refuses to add liquidity while the price is outside the band', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const id = await newMarket(creator, 100);
    db.prepare('UPDATE markets SET v_yes = b * 6 WHERE id = ?').run(id); // simulate a legacy market at ~100%
    const r = await call('POST', `/api/markets/${id}/liquidity/quote`, admin, { amount: 100 * SCALE });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PRICE_OUT_OF_BAND');
  });
});

describe('liquidity price band', () => {
  it('allows adding liquidity at ~85% but refuses at ~91%', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const id = await newMarket(creator, 100);
    const quote = () => call('POST', `/api/markets/${id}/liquidity/quote`, admin, { amount: 100 * SCALE });

    db.prepare('UPDATE markets SET v_yes = CAST(b * 1.7 AS INTEGER) WHERE id = ?').run(id); // p ≈ 0.845
    expect((await quote()).status).toBe(200);

    db.prepare('UPDATE markets SET v_yes = CAST(b * 2.3 AS INTEGER) WHERE id = ?').run(id); // p ≈ 0.909
    const r = await quote();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PRICE_OUT_OF_BAND');
  });
});

describe('pausing', () => {
  it('admin can pause and resume a single market', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const trader = await signup('bob');
    const id = await newMarket(creator, 100);

    expect((await call('POST', `/api/markets/${id}/pause`, creator, { paused: true })).status).toBe(403);
    const p = await call('POST', `/api/markets/${id}/pause`, admin, { paused: true });
    expect(p.body.market.paused).toBe(true);

    const t = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: 10 * SCALE });
    expect(t.status).toBe(409);
    expect(t.body.error.code).toBe('MARKET_PAUSED');
    const quote = await call('POST', `/api/markets/${id}/quote`, undefined, { outcome: 'YES', side: 'BUY', amount: SCALE });
    expect(quote.status).toBe(409);

    await call('POST', `/api/markets/${id}/pause`, admin, { paused: false });
    const ok = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: 10 * SCALE });
    expect(ok.status).toBe(200);
  });

  it('global halt stops trading everywhere', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const trader = await signup('bob');
    const id = await newMarket(creator, 100);

    expect((await call('POST', '/api/admin/halt', trader, { halted: true })).status).toBe(403);
    expect((await call('POST', '/api/admin/halt', admin, { halted: true })).status).toBe(200);
    expect((await call('GET', '/api/me')).body.tradingHalted).toBe(true);
    const t = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: 10 * SCALE });
    expect(t.body.error.code).toBe('TRADING_HALTED');

    await call('POST', '/api/admin/halt', admin, { halted: false });
    const ok = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: 10 * SCALE });
    expect(ok.status).toBe(200);
  });
});

describe('house account', () => {
  it('cannot be registered or logged into', async () => {
    const r = await call('POST', '/api/register', undefined, { username: '__house__', password: 'secret123' });
    expect(r.status).toBe(400);
    const l = await call('POST', '/api/login', undefined, { username: '__house__', password: 'secret123' });
    expect(l.status).toBe(400);
  });

  it('is excluded from the leaderboard, and users + house stay zero-sum', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const trader = await signup('bob');
    const id = await newMarket(creator, 100);
    await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: 200 * SCALE });
    await call('POST', `/api/markets/${id}/resolve`, admin, { outcome: 'YES' });

    const lb = (await call('GET', '/api/leaderboard')).body.leaderboard as Json[];
    expect(lb.find((r) => r.username === '__house__')).toBeUndefined();
    const sum = lb.reduce((s, r) => s + r.profit, 0);
    expect(sum + houseNet()).toBe(0);
  });
});

describe('random trading with liquidity changes', () => {
  it('keeps every invariant through trades, liquidity adds and settlement', async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const admin = await signup('admin');
    const users = [await signup('u1'), await signup('u2'), await signup('u3'), await signup('u4')];
    const markets = [await newMarket(users[0]!, 50), await newMarket(users[1]!, 200), await newMarket(users[2]!, 300)];

    for (let i = 0; i < 300; i++) {
      const id = markets[Math.floor(rnd() * markets.length)]!;
      if (rnd() < 0.05) {
        await call('POST', `/api/markets/${id}/liquidity`, admin, { amount: (50 + Math.floor(rnd() * 300)) * SCALE });
      } else {
        const u = users[Math.floor(rnd() * users.length)]!;
        const outcome = rnd() < 0.5 ? 'YES' : 'NO';
        if (rnd() < 0.3) {
          const pos = (await call('GET', `/api/markets/${id}`, u)).body.positions[outcome].shares;
          if (pos > 0) {
            await call('POST', `/api/markets/${id}/trade`, u, { outcome, side: 'SELL', shares: 1 + Math.floor(rnd() * pos) });
          }
        } else {
          await call('POST', `/api/markets/${id}/trade`, u, { outcome, side: 'BUY', amount: 1 + Math.floor(rnd() * 150 * SCALE) });
        }
      }
      if (i % 50 === 0) expect(reconcile(db).ok).toBe(true);
    }
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);

    await call('POST', `/api/markets/${markets[0]}/resolve`, admin, { outcome: 'YES' });
    await call('POST', `/api/markets/${markets[1]}/resolve`, admin, { outcome: 'NO' });
    await call('POST', `/api/markets/${markets[2]}/cancel`, admin, {});
    const r = reconcile(db);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(conserved()).toBe(true);
    const lb = (await call('GET', '/api/leaderboard')).body.leaderboard as Json[];
    expect(lb.reduce((s, x) => s + x.profit, 0) + houseNet()).toBe(0);
  });
});
