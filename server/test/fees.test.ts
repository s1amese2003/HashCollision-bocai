import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { reconcile } from '../src/ledger.js';
import { SCALE } from '../src/market/lmsr.js';

process.env.NODE_ENV = 'test';

const clock = Date.UTC(2026, 10, 1, 4, 0, 0);
let cfg: Config;
let db: DB;
let app: App;

beforeEach(async () => {
  cfg = loadConfig({
    dbPath: ':memory:',
    adminUsernames: ['admin'],
    webDir: '',
    houseSubsidy: 500 * SCALE,
    feeBps: 200,
    positionCapB: 2,
  });
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
    closeAt: clock + 24 * 3600_000,
    subsidy: subsidyPoints * SCALE,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id;
}

const scalar = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { s: number }).s;

function conserved(): boolean {
  const held =
    scalar('SELECT COALESCE(SUM(balance), 0) AS s FROM users') + scalar('SELECT COALESCE(SUM(pool), 0) AS s FROM markets');
  const issued = scalar(`SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE reason IN ('signup', 'checkin', 'house_mint')`);
  return held === issued;
}

const buy = (cookie: string, id: number, outcome: 'YES' | 'NO', points: number) =>
  call('POST', `/api/markets/${id}/trade`, cookie, { outcome, side: 'BUY', amount: Math.round(points * SCALE) });

describe('trading fee', () => {
  it('buy: total = cost + 2% fee, never above the budget, and fee goes to the pool', async () => {
    const creator = await signup('alice');
    const trader = await signup('bob');
    const id = await newMarket(creator);
    const poolBefore = scalar('SELECT pool AS s FROM markets WHERE id = ?', id);

    const r = await buy(trader, id, 'YES', 100);
    expect(r.status).toBe(200);
    const q = r.body.quote;
    expect(q.fee).toBe(Math.ceil(q.amount * 0.02));
    expect(q.total).toBe(q.amount + q.fee);
    expect(q.total).toBeLessThanOrEqual(100 * SCALE);
    expect(q.total).toBeGreaterThan(99 * SCALE); // budget is (nearly) fully used
    expect(r.body.balance).toBe(cfg.signupBonus - q.total);

    expect(scalar('SELECT pool AS s FROM markets WHERE id = ?', id)).toBe(poolBefore + q.total);
    expect(scalar('SELECT fees AS s FROM markets WHERE id = ?', id)).toBe(q.fee);
    expect(reconcile(db).ok).toBe(true);
  });

  it('sell: user receives proceeds - fee, so a round trip costs about 4%', async () => {
    const creator = await signup('alice');
    const trader = await signup('bob');
    const id = await newMarket(creator);
    const b = await buy(trader, id, 'YES', 100);
    const shares = b.body.quote.shares;

    const s = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'SELL', shares });
    expect(s.status).toBe(200);
    expect(s.body.quote.total).toBe(s.body.quote.amount - s.body.quote.fee);

    const lost = cfg.signupBonus - (await balanceOf(trader));
    expect(lost).toBeGreaterThan(3.5 * SCALE);
    expect(lost).toBeLessThan(4.5 * SCALE);
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
  });

  it('sell slippage guard compares against what the user actually receives', async () => {
    const creator = await signup('alice');
    const trader = await signup('bob');
    const id = await newMarket(creator);
    const shares = (await buy(trader, id, 'YES', 50)).body.quote.shares;
    const q = await call('POST', `/api/markets/${id}/quote`, trader, { outcome: 'YES', side: 'SELL', shares });
    const tooGreedy = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'YES',
      side: 'SELL',
      shares,
      minAmount: q.body.quote.amount, // gross, i.e. ignoring the fee: must be rejected
    });
    expect(tooGreedy.status).toBe(409);
    const ok = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'YES',
      side: 'SELL',
      shares,
      minAmount: q.body.quote.total,
    });
    expect(ok.status).toBe(200);
  });

  it('fees end up with the liquidity providers at settlement, and cancel refunds fees too', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const a = await signup('bob');
    const c = await signup('carol');

    const m1 = await newMarket(creator);
    await buy(a, m1, 'YES', 100);
    await buy(c, m1, 'NO', 100);
    await call('POST', `/api/markets/${m1}/resolve`, admin, { outcome: 'YES' });
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);

    const m2 = await newMarket(creator);
    const before = await balanceOf(a);
    await buy(a, m2, 'YES', 100);
    await call('POST', `/api/markets/${m2}/cancel`, admin, {});
    expect(await balanceOf(a)).toBe(before); // full refund including the fee
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
  });
});

describe('position cap', () => {
  it('truncates a buy at 2b shares and then rejects further buys on that side', async () => {
    const creator = await signup('alice');
    const whale = await signup('bob');
    const id = await newMarket(creator); // b = (100 + 500) / ln2 ≈ 866 points -> cap ≈ 1731 shares
    const market = (await call('GET', `/api/markets/${id}`)).body.market;
    expect(market.positionCap).toBe(Math.floor(market.b * 2));

    // Top the whale up (journaled like a grant) so they can afford to reach the cap.
    db.prepare('UPDATE users SET balance = balance + ? WHERE username = ?').run(2000 * SCALE, 'bob');
    db.prepare(`INSERT INTO ledger (user_id, delta, balance_after, reason, ref_id, created_at)
                SELECT id, ?, balance, 'checkin', 'test-topup', 0 FROM users WHERE username = 'bob'`).run(2000 * SCALE);

    let held = 0;
    for (let i = 0; i < 5; i++) {
      const r = await buy(whale, id, 'YES', 400);
      if (r.status !== 200) {
        expect(r.body.error.code).toMatch(/POSITION_LIMIT|PRICE_LIMIT/);
        break;
      }
      held += r.body.quote.shares;
      if (r.body.quote.capped) expect(r.body.quote.cappedBy).toBe('POSITION');
    }
    expect(held).toBe(market.positionCap);
    const again = await buy(whale, id, 'YES', 10);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('POSITION_LIMIT');

    // The other side and selling are unaffected.
    expect((await buy(whale, id, 'NO', 10)).status).toBe(200);
    const s = await call('POST', `/api/markets/${id}/trade`, whale, { outcome: 'YES', side: 'SELL', shares: 100 * SCALE });
    expect(s.status).toBe(200);
    expect(reconcile(db).ok).toBe(true);
  });

  it('the quote reflects the logged-in user\'s remaining room', async () => {
    const creator = await signup('alice');
    const id = await newMarket(creator);
    const cap = (await call('GET', `/api/markets/${id}`)).body.market.positionCap;
    db.prepare(
      `INSERT INTO positions (user_id, market_id, outcome, shares, cost_basis)
       SELECT id, ?, 'YES', ?, 0 FROM users WHERE username = 'alice'`,
    ).run(id, cap - 10 * SCALE);
    const q = await call('POST', `/api/markets/${id}/quote`, creator, { outcome: 'YES', side: 'BUY', amount: 100 * SCALE });
    expect(q.body.quote.capped).toBe(true);
    expect(q.body.quote.cappedBy).toBe('POSITION');
    expect(q.body.quote.shares).toBe(10 * SCALE);
    const anon = await call('POST', `/api/markets/${id}/quote`, undefined, { outcome: 'YES', side: 'BUY', amount: 100 * SCALE });
    expect(anon.body.quote.capped).toBe(false);
  });
});

describe('random trading with fees and caps', () => {
  it('conserves points and keeps every invariant', async () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const admin = await signup('admin');
    const users = [await signup('u1'), await signup('u2'), await signup('u3'), await signup('u4')];
    const markets = [await newMarket(users[0]!, 50), await newMarket(users[1]!, 200)];

    for (let i = 0; i < 300; i++) {
      const id = markets[Math.floor(rnd() * markets.length)]!;
      if (rnd() < 0.04) {
        await call('POST', `/api/markets/${id}/liquidity`, admin, { amount: (50 + Math.floor(rnd() * 200)) * SCALE });
        continue;
      }
      const u = users[Math.floor(rnd() * users.length)]!;
      const outcome = rnd() < 0.5 ? 'YES' : 'NO';
      if (rnd() < 0.35) {
        const pos = (await call('GET', `/api/markets/${id}`, u)).body.positions[outcome].shares;
        if (pos > 0) {
          await call('POST', `/api/markets/${id}/trade`, u, { outcome, side: 'SELL', shares: 1 + Math.floor(rnd() * pos) });
        }
      } else {
        await buy(u, id, outcome, 1 + rnd() * 200);
      }
      if (i % 60 === 0) expect(reconcile(db).ok).toBe(true);
    }
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);

    await call('POST', `/api/markets/${markets[0]}/resolve`, admin, { outcome: 'NO' });
    await call('POST', `/api/markets/${markets[1]}/cancel`, admin, {});
    const r = reconcile(db);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(conserved()).toBe(true);
  });
});
