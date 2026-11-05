import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { reconcile } from '../src/ledger.js';
import { SCALE } from '../src/market/lmsr.js';

process.env.NODE_ENV = 'test';

const HOUR = 3600_000;
let clock = Date.UTC(2026, 10, 1, 4, 0, 0); // 12:00 in UTC+8
let cfg: Config;
let db: DB;
let app: App;

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 1, 4, 0, 0);
  // These tests were written for creator-only liquidity; platform liquidity is covered in features.test.ts.
  cfg = loadConfig({ dbPath: ':memory:', adminUsernames: ['admin'], webDir: '', houseSubsidy: 0, positionCapB: 0, signupBonus: 1000 * SCALE });
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
  expect(r.status).toBe(200);
  const c = r.res.cookies.find((c) => c.name === 'sid');
  return `sid=${c!.value}`;
}

async function balanceOf(cookie: string): Promise<number> {
  return (await call('GET', '/api/me', cookie)).body.user.balance;
}

async function newMarket(cookie: string, subsidyPoints = 100, closeInHours = 24): Promise<number> {
  const r = await call('POST', '/api/markets', cookie, {
    title: '明天会下雨吗？',
    description: '',
    rules: '以气象台发布的数据为准',
    closeAt: clock + closeInHours * HOUR,
    subsidy: subsidyPoints * SCALE,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id;
}

function totalPoints(): number {
  const users = db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM users').get() as { s: number };
  const pools = db.prepare('SELECT COALESCE(SUM(pool), 0) AS s FROM markets').get() as { s: number };
  return users.s + pools.s;
}

function totalGranted(): number {
  return (
    db
      .prepare(`SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE reason IN ('signup', 'checkin', 'house_mint')`)
      .get() as { s: number }
  ).s;
}

describe('auth and check-in', () => {
  it('grants the signup bonus and logs in', async () => {
    const c = await signup('alice');
    expect(await balanceOf(c)).toBe(cfg.signupBonus);

    const dup = await call('POST', '/api/register', undefined, { username: 'ALICE', password: 'secret123' });
    expect(dup.status).toBe(409);

    const bad = await call('POST', '/api/login', undefined, { username: 'alice', password: 'wrong-pass' });
    expect(bad.status).toBe(401);
    const ok = await call('POST', '/api/login', undefined, { username: 'alice', password: 'secret123' });
    expect(ok.status).toBe(200);
  });

  it('rejects unauthenticated requests and bad input', async () => {
    expect((await call('POST', '/api/checkin')).status).toBe(401);
    const r = await call('POST', '/api/register', undefined, { username: 'a', password: '1' });
    expect(r.status).toBe(400);
  });

  it('allows one check-in per day (UTC+8)', async () => {
    const c = await signup('bob');
    expect((await call('POST', '/api/checkin', c)).status).toBe(200);
    expect((await call('POST', '/api/checkin', c)).status).toBe(400);
    clock += 12 * HOUR; // 00:00 next day in UTC+8
    expect((await call('POST', '/api/checkin', c)).status).toBe(200);
    expect(await balanceOf(c)).toBe(cfg.signupBonus + 2 * cfg.checkinBonus);
  });

  it('logout invalidates the session', async () => {
    const c = await signup('carol');
    await call('POST', '/api/logout', c);
    expect((await call('GET', '/api/me', c)).body.user).toBeNull();
  });
});

describe('market lifecycle', () => {
  it('creating a market locks the subsidy', async () => {
    const c = await signup('alice');
    const id = await newMarket(c, 100);
    expect(await balanceOf(c)).toBe(cfg.signupBonus - 100 * SCALE);
    const m = (await call('GET', `/api/markets/${id}`)).body.market;
    expect(m.priceYes).toBeCloseTo(0.5);
    expect(m.status).toBe('OPEN');
  });

  it('validates market input', async () => {
    const c = await signup('alice');
    const past = await call('POST', '/api/markets', c, {
      title: '一个过期的市场',
      rules: '随便写写规则',
      closeAt: clock - 1,
      subsidy: 100 * SCALE,
    });
    expect(past.status).toBe(400);
    const tooBig = await call('POST', '/api/markets', c, {
      title: '补贴太多的市场',
      rules: '随便写写规则',
      closeAt: clock + HOUR,
      subsidy: 999999 * SCALE,
    });
    expect(tooBig.status).toBe(400);
  });

  it('buy, sell, quote, slippage guard', async () => {
    const creator = await signup('alice');
    const trader = await signup('bob');
    const id = await newMarket(creator);

    const quote = await call('POST', `/api/markets/${id}/quote`, undefined, {
      outcome: 'YES',
      side: 'BUY',
      amount: 50 * SCALE,
    });
    expect(quote.status).toBe(200);
    expect(quote.body.quote.priceYesAfter).toBeGreaterThan(0.5);

    const buy = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'YES',
      side: 'BUY',
      amount: 50 * SCALE,
      minShares: quote.body.quote.shares,
    });
    expect(buy.status).toBe(200);
    expect(buy.body.quote.shares).toBe(quote.body.quote.shares);
    expect(buy.body.balance).toBe(cfg.signupBonus - buy.body.quote.amount);

    // Same quote is now stale: price moved, so the guard must reject it.
    const stale = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'YES',
      side: 'BUY',
      amount: 50 * SCALE,
      minShares: quote.body.quote.shares,
    });
    expect(stale.status).toBe(409);

    const detail = (await call('GET', `/api/markets/${id}`, trader)).body;
    const held = detail.positions.YES.shares;
    expect(held).toBe(buy.body.quote.shares);

    const tooMany = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'YES',
      side: 'SELL',
      shares: held + 1,
    });
    expect(tooMany.status).toBe(400);

    const sell = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'SELL', shares: held });
    expect(sell.status).toBe(200);
    expect(sell.body.quote.amount).toBeLessThanOrEqual(buy.body.quote.amount);
    expect(reconcile(db).ok).toBe(true);
  });

  it('rejects trading after close time and when broke', async () => {
    const creator = await signup('alice');
    const trader = await signup('bob');
    const id = await newMarket(creator, 100, 1);

    // A 1000-point buy is truncated at 99%, so it only spends part of the balance...
    const capped = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'YES',
      side: 'BUY',
      amount: cfg.signupBonus,
    });
    expect(capped.body.quote.capped).toBe(true);
    // ...then a NO buy that fits under the cap but exceeds what's left must fail.
    const left = capped.body.balance as number;
    const broke = await call('POST', `/api/markets/${id}/trade`, trader, {
      outcome: 'NO',
      side: 'BUY',
      amount: left + 1,
    });
    expect(broke.status).toBe(400);
    expect(broke.body.error.code).toBe('INSUFFICIENT_BALANCE');

    clock += 2 * HOUR;
    const late = await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: SCALE });
    expect(late.status).toBe(409);
    expect((await call('GET', `/api/markets/${id}`)).body.market.status).toBe('CLOSED');
    app.tick();
    expect((db.prepare('SELECT status FROM markets WHERE id = ?').get(id) as any).status).toBe('CLOSED');
  });

  it('creator proposal is finalized after the dispute window and pays winners', async () => {
    const creator = await signup('alice');
    const yes = await signup('bob');
    const no = await signup('carol');
    const id = await newMarket(creator);

    const b1 = await call('POST', `/api/markets/${id}/trade`, yes, { outcome: 'YES', side: 'BUY', amount: 80 * SCALE });
    await call('POST', `/api/markets/${id}/trade`, no, { outcome: 'NO', side: 'BUY', amount: 30 * SCALE });

    expect((await call('POST', `/api/markets/${id}/propose`, yes, { outcome: 'YES' })).status).toBe(403);
    const p = await call('POST', `/api/markets/${id}/propose`, creator, { outcome: 'YES', note: '确实下雨了' });
    expect(p.status).toBe(200);
    expect(p.body.market.status).toBe('PROPOSED');

    // Trading stops once a result is proposed.
    const t = await call('POST', `/api/markets/${id}/trade`, no, { outcome: 'NO', side: 'BUY', amount: SCALE });
    expect(t.status).toBe(409);

    clock += cfg.disputeWindowMs - 1000;
    app.tick();
    expect((await call('GET', `/api/markets/${id}`)).body.market.status).toBe('PROPOSED');

    const yesBefore = await balanceOf(yes);
    clock += 2000;
    app.tick();
    const m = (await call('GET', `/api/markets/${id}`)).body.market;
    expect(m.status).toBe('RESOLVED');
    expect(m.resolution).toBe('YES');
    expect(await balanceOf(yes)).toBe(yesBefore + b1.body.quote.shares);
    expect(reconcile(db).ok).toBe(true);
    expect(totalPoints()).toBe(totalGranted());
  });

  it('admin can override a proposal before it finalizes', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const no = await signup('carol');
    const id = await newMarket(creator);
    const buy = await call('POST', `/api/markets/${id}/trade`, no, { outcome: 'NO', side: 'BUY', amount: 40 * SCALE });

    await call('POST', `/api/markets/${id}/propose`, creator, { outcome: 'YES' });
    expect((await call('POST', `/api/markets/${id}/resolve`, creator, { outcome: 'YES' })).status).toBe(403);

    const before = await balanceOf(no);
    const r = await call('POST', `/api/markets/${id}/resolve`, admin, { outcome: 'NO', note: '创建者判错了' });
    expect(r.status).toBe(200);
    expect(r.body.market.resolution).toBe('NO');
    expect(await balanceOf(no)).toBe(before + buy.body.quote.shares);

    clock += cfg.disputeWindowMs * 2;
    app.tick(); // must not settle twice
    expect(reconcile(db).ok).toBe(true);
    expect(totalPoints()).toBe(totalGranted());
  });

  it('cancel refunds net spend; creator can only cancel untraded markets', async () => {
    const creator = await signup('alice');
    const admin = await signup('admin');
    const trader = await signup('bob');

    const empty = await newMarket(creator);
    expect((await call('POST', `/api/markets/${empty}/cancel`, creator, {})).status).toBe(200);
    expect(await balanceOf(creator)).toBe(cfg.signupBonus);

    const id = await newMarket(creator);
    await call('POST', `/api/markets/${id}/trade`, trader, { outcome: 'YES', side: 'BUY', amount: 70 * SCALE });
    expect((await call('POST', `/api/markets/${id}/cancel`, creator, {})).status).toBe(403);
    expect((await call('POST', `/api/markets/${id}/cancel`, trader, {})).status).toBe(403);
    expect((await call('POST', `/api/markets/${id}/cancel`, admin, { note: '题目有歧义' })).status).toBe(200);

    expect(await balanceOf(trader)).toBe(cfg.signupBonus);
    expect(await balanceOf(creator)).toBe(cfg.signupBonus);
    expect(reconcile(db).ok).toBe(true);
  });
});

describe('accounting under random trading', () => {
  it('conserves points and keeps every invariant', async () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const admin = await signup('admin');
    const users = [await signup('u1'), await signup('u2'), await signup('u3'), await signup('u4')];
    const markets = [await newMarket(users[0]!, 50), await newMarket(users[1]!, 200), await newMarket(users[2]!, 500)];

    for (let i = 0; i < 400; i++) {
      const u = users[Math.floor(rnd() * users.length)]!;
      const id = markets[Math.floor(rnd() * markets.length)]!;
      const outcome = rnd() < 0.5 ? 'YES' : 'NO';
      if (rnd() < 0.3) {
        const pos = (await call('GET', `/api/markets/${id}`, u)).body.positions[outcome].shares;
        if (pos > 0) {
          await call('POST', `/api/markets/${id}/trade`, u, {
            outcome,
            side: 'SELL',
            shares: 1 + Math.floor(rnd() * pos),
          });
        }
      } else {
        await call('POST', `/api/markets/${id}/trade`, u, {
          outcome,
          side: 'BUY',
          amount: 1 + Math.floor(rnd() * 60 * SCALE),
        });
      }
    }
    expect(reconcile(db).ok).toBe(true);
    expect(totalPoints()).toBe(totalGranted());

    await call('POST', `/api/markets/${markets[0]}/resolve`, admin, { outcome: 'YES' });
    await call('POST', `/api/markets/${markets[1]}/resolve`, admin, { outcome: 'NO' });
    await call('POST', `/api/markets/${markets[2]}/cancel`, admin, {});

    const r = reconcile(db);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(totalPoints()).toBe(totalGranted());

    const lb = (await call('GET', '/api/leaderboard')).body.leaderboard;
    expect(lb.length).toBe(5);
    const sumProfit = lb.reduce((s: number, x: any) => s + x.profit, 0);
    expect(sumProfit).toBe(0); // zero-sum once everything is settled
  });
});

describe('price band 1%-99%', () => {
  it('truncates a buy at 99% and rejects further buys on that side', async () => {
    const creator = await signup('alice');
    const whale = await signup('bob');
    const id = await newMarket(creator, 100); // b ~ 144 points, far below a 1000-point balance

    const q = await call('POST', `/api/markets/${id}/quote`, undefined, { outcome: 'YES', side: 'BUY', amount: 1000 * SCALE });
    expect(q.body.quote.capped).toBe(true);
    expect(q.body.quote.priceYesAfter).toBeLessThanOrEqual(0.99);
    expect(q.body.quote.amount).toBeLessThan(1000 * SCALE);

    const t = await call('POST', `/api/markets/${id}/trade`, whale, {
      outcome: 'YES',
      side: 'BUY',
      amount: 1000 * SCALE,
      minShares: q.body.quote.shares,
    });
    expect(t.status).toBe(200);
    expect(t.body.quote.capped).toBe(true);
    // Only the capped cost was charged.
    expect(t.body.balance).toBe(cfg.signupBonus - t.body.quote.amount);

    const again = await call('POST', `/api/markets/${id}/trade`, whale, { outcome: 'YES', side: 'BUY', amount: 10 * SCALE });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('PRICE_LIMIT');

    // Trading back toward the middle is still allowed.
    const back = await call('POST', `/api/markets/${id}/trade`, whale, { outcome: 'NO', side: 'BUY', amount: 10 * SCALE });
    expect(back.status).toBe(200);
    expect(reconcile(db).ok).toBe(true);
  });

  it('truncates a sell that would push the other side past 99%', async () => {
    const creator = await signup('alice');
    const noHolder = await signup('bob');
    const yesHolder = await signup('carol');
    const id = await newMarket(creator, 100);

    // Build large positions on both sides while staying inside the band.
    for (let i = 0; i < 6; i++) {
      await call('POST', `/api/markets/${id}/trade`, noHolder, { outcome: 'NO', side: 'BUY', amount: 80 * SCALE });
      await call('POST', `/api/markets/${id}/trade`, yesHolder, { outcome: 'YES', side: 'BUY', amount: 80 * SCALE });
    }
    const held = (await call('GET', `/api/markets/${id}`, noHolder)).body.positions.NO.shares;
    const sell = await call('POST', `/api/markets/${id}/trade`, noHolder, { outcome: 'NO', side: 'SELL', shares: held });
    expect(sell.status).toBe(200);
    expect(sell.body.quote.capped).toBe(true);
    expect(sell.body.quote.shares).toBeLessThan(held);
    expect(sell.body.quote.priceYesAfter).toBeLessThanOrEqual(0.99);

    const left = (await call('GET', `/api/markets/${id}`, noHolder)).body.positions.NO.shares;
    expect(left).toBe(held - sell.body.quote.shares);
    const more = await call('POST', `/api/markets/${id}/trade`, noHolder, { outcome: 'NO', side: 'SELL', shares: left });
    expect(more.status).toBe(400);
    expect(more.body.error.code).toBe('PRICE_LIMIT');
    expect(reconcile(db).ok).toBe(true);
    expect(totalPoints()).toBe(totalGranted());
  });

  it('replaying the production exploit no longer lets anyone buy at 100%', async () => {
    const creator = await signup('alice');
    const users = [await signup('u1'), await signup('u2'), await signup('u3')];
    const id = await newMarket(creator, 100);
    for (const u of users) {
      await call('POST', `/api/markets/${id}/trade`, u, { outcome: 'YES', side: 'BUY', amount: 1000 * SCALE });
    }
    const trades = db.prepare('SELECT amount, shares FROM trades WHERE market_id = ?').all(id) as {
      amount: number;
      shares: number;
    }[];
    // Only the first buyer got filled (and only up to 99%); nobody paid ~1 point per share.
    expect(trades.length).toBe(1);
    for (const t of trades) expect(t.amount / t.shares).toBeLessThan(0.99);
  });
});
