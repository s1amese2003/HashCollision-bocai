import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { reconcile } from '../src/ledger.js';
import { SCALE } from '../src/market/lmsr.js';
import { maxStake, payoutFor } from '../src/odds.js';
import { resetAll } from '../src/reset.js';

process.env.NODE_ENV = 'test';

let clock: number;
let cfg: Config;
let db: DB;
let app: App;

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 5, 4, 0, 0);
  // Real defaults: 100-point signup, 10-point minimum deposit.
  cfg = loadConfig({ dbPath: ':memory:', adminUsernames: ['admin'], webDir: '' });
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
const P = (points: number) => Math.round(points * SCALE);

/** 主胜 1.85 / 平 3.20 / 客胜 4.00 with the given deposit. */
async function newBook(cookie: string, depositPoints = 50, extra: Json = {}): Promise<{ id: number; opts: Json[] }> {
  const r = await call('POST', '/api/markets', cookie, {
    kind: 'ODDS',
    title: '周六 A 队 vs B 队',
    rules: '以 90 分钟比分为准（含伤停补时，不含加时和点球）',
    closeAt: clock + 24 * 3600_000,
    deposit: P(depositPoints),
    options: [
      { label: '主胜', odds: 185 },
      { label: '平', odds: 320 },
      { label: '客胜', odds: 400 },
    ],
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const m = (await call('GET', `/api/markets/${r.body.id}`)).body.market;
  return { id: r.body.id, opts: m.options };
}

const bet = (cookie: string, id: number, optionId: number, points: number, odds: number) =>
  call('POST', `/api/markets/${id}/bet`, cookie, { optionId, stake: P(points), odds });

const scalar = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { s: number }).s;

function conserved(): boolean {
  const held =
    scalar('SELECT COALESCE(SUM(balance), 0) AS s FROM users') + scalar('SELECT COALESCE(SUM(pool), 0) AS s FROM markets');
  const issued = scalar(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE reason IN ('signup', 'house_mint', 'reset')`,
  );
  return held === issued;
}

describe('maxStake', () => {
  it('is the exact boundary of the solvency condition', () => {
    for (const [pool, liability, odds] of [
      [50_000, 0, 185],
      [123_457, 99_999, 320],
      [10_000, 10_000, 101],
      [7, 3, 10_000],
    ] as const) {
      const s = maxStake(pool, liability, odds);
      expect(liability + payoutFor(s, odds)).toBeLessThanOrEqual(pool + s);
      expect(liability + payoutFor(s + 1, odds)).toBeGreaterThan(pool + s + 1);
    }
  });
});

describe('creating a fixed-odds market', () => {
  it('debits the deposit and exposes options instead of a price', async () => {
    const book = await signup('alice');
    const { id, opts } = await newBook(book, 50);
    expect(await balanceOf(book)).toBe(P(50));
    const m = (await call('GET', `/api/markets/${id}`)).body.market;
    expect(m).toMatchObject({ kind: 'ODDS', priceYes: null, subsidy: P(50), status: 'OPEN', positionCap: null });
    expect(opts.map((o) => [o.label, o.odds])).toEqual([
      ['主胜', 185],
      ['平', 320],
      ['客胜', 400],
    ]);
    // With nothing staked, a bet of s on 主胜 needs 0.85 s <= 50.
    expect(opts[0]!.maxStake).toBe(maxStake(P(50), 0, 185));
    expect((await call('GET', '/api/markets')).body.markets[0].options).toHaveLength(3);
    expect(reconcile(db).ok).toBe(true);
  });

  it('validates options, odds and deposit', async () => {
    const book = await signup('alice');
    const bad = async (extra: Json) =>
      (
        await call('POST', '/api/markets', book, {
          kind: 'ODDS',
          title: '周六 A 队 vs B 队',
          rules: '以 90 分钟比分为准',
          closeAt: clock + 3600_000,
          deposit: P(20),
          options: [
            { label: '主胜', odds: 185 },
            { label: '客胜', odds: 200 },
          ],
          ...extra,
        })
      ).body.error?.code;
    expect(await bad({ options: [{ label: '主胜', odds: 185 }] })).toBe('VALIDATION');
    expect(await bad({ options: [{ label: '主胜', odds: 185 }, { label: '主胜', odds: 200 }] })).toBe('BAD_OPTIONS');
    expect(await bad({ options: [{ label: '主胜', odds: 100 }, { label: '客胜', odds: 200 }] })).toBe('BAD_ODDS');
    expect(await bad({ options: [{ label: '主胜', odds: 1.5 }, { label: '客胜', odds: 200 }] })).toBe('VALIDATION');
    expect(await bad({ deposit: P(5) })).toBe('BAD_DEPOSIT');
    expect(await bad({ deposit: P(500) })).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(book)).toBe(P(100));
  });
});

describe('betting', () => {
  it('locks the odds, debits the stake and grows the pool', async () => {
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book);
    const r = await bet(bob, id, opts[0]!.id, 20, 185);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.bet).toMatchObject({ stake: P(20), odds: 185, payout: P(37), label: '主胜' });
    expect(r.body.balance).toBe(P(80));
    const d = (await call('GET', `/api/markets/${id}`, bob)).body;
    expect(d.market.volume).toBe(P(20));
    expect(d.market.options[0]).toMatchObject({ stakeTotal: P(20), liability: P(37) });
    expect(d.myBets).toHaveLength(1);
    expect(d.bets[0].username).toBe('bob');
    expect(scalar('SELECT pool AS s FROM markets WHERE id = ?', id)).toBe(P(70));
    expect(reconcile(db).ok).toBe(true);
  });

  it('rejects the bookmaker, stale odds and tiny stakes', async () => {
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book);
    expect((await bet(book, id, opts[0]!.id, 5, 185)).status).toBe(403);
    expect((await bet(bob, id, opts[0]!.id, 5, 190)).body.error.code).toBe('SLIPPAGE');
    expect((await bet(bob, id, opts[0]!.id, 0.5, 185)).body.error.code).toBe('BAD_STAKE');
    expect(await balanceOf(bob)).toBe(P(100));
  });

  it('stops accepting bets on an option once the deposit cannot cover it', async () => {
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book, 30); // 客胜 at 4.00: s * 3 <= 30 -> 10 points
    const away = opts[2]!;
    expect(away.maxStake).toBe(P(10));
    const over = await bet(bob, id, away.id, 10.001, 400);
    expect(over.body.error.code).toBe('LIABILITY_LIMIT');
    expect(over.body.error.message).toContain('最多还能下注 10 积分');
    expect((await bet(bob, id, away.id, 10, 400)).status).toBe(200);
    const after = (await call('GET', `/api/markets/${id}`)).body.market.options;
    expect(after[2].maxStake).toBe(0);
    // Stakes on 客胜 raise the pool, so the other options can now take more.
    expect(after[0].maxStake).toBeGreaterThan(away.maxStake);
    expect((await bet(bob, id, away.id, 1, 400)).body.error.message).toContain('暂时不能再下注');

    // Topping up the deposit makes room again.
    expect((await call('POST', `/api/markets/${id}/deposit`, bob, { amount: P(10) })).status).toBe(403);
    expect((await call('POST', `/api/markets/${id}/deposit`, book, { amount: P(15) })).status).toBe(200);
    expect(await balanceOf(book)).toBe(P(55));
    expect((await bet(bob, id, away.id, 5, 400)).status).toBe(200);
    expect(reconcile(db).ok).toBe(true);
  });

  it('odds changes apply to new bets only, and only the creator can make them while open', async () => {
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book);
    await bet(bob, id, opts[0]!.id, 10, 185);
    const odds = { odds: [{ optionId: opts[0]!.id, odds: 150 }] };
    expect((await call('POST', `/api/markets/${id}/odds`, bob, odds)).status).toBe(403);
    expect((await call('POST', `/api/markets/${id}/odds`, book, odds)).status).toBe(200);
    expect((await bet(bob, id, opts[0]!.id, 10, 185)).body.error.code).toBe('SLIPPAGE');
    expect((await bet(bob, id, opts[0]!.id, 10, 150)).body.bet.payout).toBe(P(15));
    const mine = (await call('GET', `/api/markets/${id}`, bob)).body.myBets;
    expect(mine.map((b: Json) => b.odds).sort()).toEqual([150, 185]);

    const other = await newBook(book, 10);
    expect(
      (await call('POST', `/api/markets/${id}/odds`, book, { odds: [{ optionId: other.opts[0]!.id, odds: 150 }] })).body
        .error.code,
    ).toBe('BAD_OPTION');
    clock += 25 * 3600_000;
    expect((await call('POST', `/api/markets/${id}/odds`, book, odds)).body.error.code).toBe('MARKET_NOT_OPEN');
    expect((await bet(bob, id, opts[0]!.id, 1, 150)).body.error.code).toBe('MARKET_NOT_OPEN');
  });

  it('respects pause and the global halt', async () => {
    const admin = await signup('admin');
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book);
    await call('POST', `/api/markets/${id}/pause`, admin, { paused: true });
    expect((await bet(bob, id, opts[0]!.id, 1, 185)).body.error.code).toBe('MARKET_PAUSED');
    await call('POST', `/api/markets/${id}/pause`, admin, { paused: false });
    await call('POST', '/api/admin/halt', admin, { halted: true });
    expect((await bet(bob, id, opts[0]!.id, 1, 185)).body.error.code).toBe('TRADING_HALTED');
  });

  it('LMSR-only endpoints refuse fixed-odds markets', async () => {
    const admin = await signup('admin');
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id } = await newBook(book);
    const trade = { outcome: 'YES', side: 'BUY', amount: P(5) };
    expect((await call('POST', `/api/markets/${id}/quote`, bob, trade)).body.error.code).toBe('WRONG_KIND');
    expect((await call('POST', `/api/markets/${id}/trade`, bob, trade)).body.error.code).toBe('WRONG_KIND');
    expect((await call('POST', `/api/markets/${id}/liquidity`, admin, { amount: P(5) })).body.error.code).toBe('WRONG_KIND');
    expect((await call('GET', `/api/markets/${id}/history`)).body.points).toEqual([]);
  });
});

describe('settlement', () => {
  it('pays the winning bets at their locked odds; the bookmaker keeps the rest', async () => {
    const admin = await signup('admin');
    const book = await signup('alice');
    const bob = await signup('bob');
    const carol = await signup('carol');
    const { id, opts } = await newBook(book, 50);
    const [home, draw] = [opts[0]!, opts[1]!];
    await bet(bob, id, home.id, 20, 185); // returns 37
    await bet(carol, id, draw.id, 10, 320); // loses
    await call('POST', `/api/markets/${id}/odds`, book, { odds: [{ optionId: home.id, odds: 170 }] });
    await bet(carol, id, home.id, 10, 170); // returns 17

    expect((await call('POST', `/api/markets/${id}/propose`, book, { outcome: 'YES' })).body.error.code).toBe('BAD_OUTCOME');
    expect((await call('POST', `/api/markets/${id}/propose`, book, { optionId: home.id })).status).toBe(200);
    expect((await call('GET', `/api/markets/${id}`)).body.market).toMatchObject({ status: 'PROPOSED', proposedOptionId: home.id });

    clock += cfg.disputeWindowMs + 1;
    app.tick();
    const m = (await call('GET', `/api/markets/${id}`)).body.market;
    expect(m).toMatchObject({ status: 'RESOLVED', resolvedOptionId: home.id });
    expect(await balanceOf(bob)).toBe(P(100 - 20 + 37));
    expect(await balanceOf(carol)).toBe(P(100 - 20 + 17));
    // Pool was 50 + 40 = 90; 54 paid out; 36 back to the bookmaker (net -14).
    expect(await balanceOf(book)).toBe(P(50 + 36));
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
    expect(admin).toBeTruthy();
  });

  it('admin can override the proposal; a losing favourite leaves the bookmaker in profit', async () => {
    const admin = await signup('admin');
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book, 50);
    await bet(bob, id, opts[0]!.id, 20, 185);
    await call('POST', `/api/markets/${id}/propose`, book, { optionId: opts[0]!.id });
    expect((await call('POST', `/api/markets/${id}/resolve`, admin, { optionId: opts[2]!.id })).status).toBe(200);
    expect(await balanceOf(bob)).toBe(P(80));
    expect(await balanceOf(book)).toBe(P(120));
    const lb = (await call('GET', '/api/leaderboard')).body.leaderboard;
    expect(lb.find((r: Json) => r.username === 'alice').profit).toBe(P(20));
    expect(lb.find((r: Json) => r.username === 'bob').profit).toBe(P(-20));
    expect(conserved()).toBe(true);
  });

  it('cancel refunds every stake and the deposit; creators cannot cancel once bets exist', async () => {
    const admin = await signup('admin');
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book, 50);
    await bet(bob, id, opts[0]!.id, 20, 185);
    await bet(bob, id, opts[1]!.id, 5, 320);
    expect((await call('POST', `/api/markets/${id}/cancel`, book, {})).status).toBe(403);
    expect((await call('POST', `/api/markets/${id}/cancel`, admin, {})).status).toBe(200);
    expect(await balanceOf(bob)).toBe(P(100));
    expect(await balanceOf(book)).toBe(P(100));

    const empty = await newBook(book, 30);
    expect((await call('POST', `/api/markets/${empty.id}/cancel`, book, {})).status).toBe(200);
    expect(await balanceOf(book)).toBe(P(100));
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
  });

  it('open bets show in the portfolio and count at stake on the leaderboard', async () => {
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book, 50);
    await bet(bob, id, opts[1]!.id, 10, 320);
    const pf = (await call('GET', '/api/portfolio', bob)).body;
    expect(pf.bets).toHaveLength(1);
    expect(pf.bets[0]).toMatchObject({ marketId: id, label: '平', stake: P(10), odds: 320, payout: P(32), status: 'OPEN' });
    const lb = (await call('GET', '/api/leaderboard')).body.leaderboard;
    expect(lb.every((r: Json) => r.profit === 0)).toBe(true);
  });
});

describe('random betting', () => {
  it('never lets the pool fall short and conserves points', async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const admin = await signup('admin');
    const users = [await signup('u1'), await signup('u2'), await signup('u3'), await signup('u4')];
    const books = [await newBook(users[0]!, 40), await newBook(users[1]!, 15)];
    for (let i = 0; i < 300; i++) {
      const b = books[Math.floor(rnd() * books.length)]!;
      const m = (await call('GET', `/api/markets/${b.id}`)).body.market;
      const creator = users.find((_, k) => k === books.indexOf(b))!;
      const r = rnd();
      if (r < 0.08) {
        const o = m.options[Math.floor(rnd() * m.options.length)];
        await call('POST', `/api/markets/${b.id}/odds`, creator, { odds: [{ optionId: o.id, odds: 101 + Math.floor(rnd() * 600) }] });
      } else if (r < 0.12) {
        await call('POST', `/api/markets/${b.id}/deposit`, creator, { amount: P(1 + Math.floor(rnd() * 5)) });
      } else {
        const u = users[Math.floor(rnd() * users.length)]!;
        const o = m.options[Math.floor(rnd() * m.options.length)];
        await bet(u, b.id, o.id, 1 + Math.floor(rnd() * 15), o.odds);
      }
      if (i % 50 === 0) expect(reconcile(db).ok).toBe(true);
    }
    expect(scalar('SELECT COUNT(*) AS s FROM bets')).toBeGreaterThan(50);
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);

    const m0 = (await call('GET', `/api/markets/${books[0]!.id}`)).body.market;
    const worst = m0.options.reduce((a: Json, o: Json) => (o.liability > a.liability ? o : a));
    expect((await call('POST', `/api/markets/${books[0]!.id}/resolve`, admin, { optionId: worst.id })).status).toBe(200);
    expect((await call('POST', `/api/markets/${books[1]!.id}/cancel`, admin, {})).status).toBe(200);
    const rep = reconcile(db);
    expect(rep, JSON.stringify(rep)).toMatchObject({ ok: true });
    expect(conserved()).toBe(true);
  });
});

describe('reset', () => {
  it('wipes markets and history, keeps accounts, gives everyone the same balance', async () => {
    const book = await signup('alice');
    const bob = await signup('bob');
    const { id, opts } = await newBook(book, 30);
    await bet(bob, id, opts[0]!.id, 10, 185);
    await call('POST', '/api/markets', bob, {
      title: '明天会下雨吗？',
      rules: '以气象台发布的数据为准',
      closeAt: clock + 3600_000,
      subsidy: P(50),
    });
    await call('POST', '/api/markets/2/trade', book, { outcome: 'YES', side: 'BUY', amount: P(10) });

    const summary = resetAll(db, P(100), clock);
    expect(summary).toMatchObject({ users: 2, markets: 2, bets: 1, trades: 1 });
    for (const t of ['markets', 'odds_options', 'bets', 'trades', 'positions']) {
      expect(scalar(`SELECT COUNT(*) AS s FROM ${t}`)).toBe(0);
    }
    expect(await balanceOf(book)).toBe(P(100));
    expect(await balanceOf(bob)).toBe(P(100));
    expect(scalar(`SELECT balance AS s FROM users WHERE username = '__house__'`)).toBe(0);
    expect(reconcile(db).ok).toBe(true);
    expect(conserved()).toBe(true);
    expect((await call('GET', '/api/leaderboard')).body.leaderboard.every((r: Json) => r.profit === 0)).toBe(true);
    // Sessions survive and the site keeps working.
    expect((await newBook(book, 20)).id).toBe(1);
  });
});
