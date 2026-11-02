import type { User } from './auth.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { applyDelta } from './ledger.js';
import {
  LmsrError,
  type Outcome,
  type PoolState,
  type Quote,
  type Side,
  priceOf,
  priceYes,
  quoteBuyAmount,
  quoteSellShares,
  requiredSubsidy,
} from './market/lmsr.js';

export type MarketStatus = 'OPEN' | 'CLOSED' | 'PROPOSED' | 'RESOLVED' | 'CANCELLED';

export interface MarketRow {
  id: number;
  creator_id: number;
  title: string;
  description: string;
  rules: string;
  source_url: string | null;
  b: number;
  q_yes: number;
  q_no: number;
  subsidy: number;
  pool: number;
  volume: number;
  status: MarketStatus;
  close_at: number;
  proposed_outcome: Outcome | null;
  proposed_at: number | null;
  proposal_note: string | null;
  resolution: Outcome | null;
  resolved_by: number | null;
  resolved_at: number | null;
  resolution_note: string | null;
  created_at: number;
}

export interface MarketView {
  id: number;
  creatorId: number;
  creatorName: string;
  title: string;
  description: string;
  rules: string;
  sourceUrl: string | null;
  status: MarketStatus;
  priceYes: number;
  b: number;
  subsidy: number;
  volume: number;
  closeAt: number;
  proposedOutcome: Outcome | null;
  proposedAt: number | null;
  proposalNote: string | null;
  /** When an unchallenged proposal becomes final. */
  finalizesAt: number | null;
  resolution: Outcome | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
  createdAt: number;
}

const SETTLED: MarketStatus[] = ['RESOLVED', 'CANCELLED'];

function pool(m: MarketRow): PoolState {
  return { b: m.b, qYes: m.q_yes, qNo: m.q_no };
}

/** OPEN markets past their close time are reported as CLOSED even before the sweeper runs. */
function effectiveStatus(m: MarketRow, now: number): MarketStatus {
  return m.status === 'OPEN' && now >= m.close_at ? 'CLOSED' : m.status;
}

export function toView(
  m: MarketRow & { creator_name: string },
  cfg: Config,
  now: number,
): MarketView {
  return {
    id: m.id,
    creatorId: m.creator_id,
    creatorName: m.creator_name,
    title: m.title,
    description: m.description,
    rules: m.rules,
    sourceUrl: m.source_url,
    status: effectiveStatus(m, now),
    priceYes: priceYes(pool(m)),
    b: m.b,
    subsidy: m.subsidy,
    volume: m.volume,
    closeAt: m.close_at,
    proposedOutcome: m.proposed_outcome,
    proposedAt: m.proposed_at,
    proposalNote: m.proposal_note,
    finalizesAt: m.proposed_at === null ? null : m.proposed_at + cfg.disputeWindowMs,
    resolution: m.resolution,
    resolvedAt: m.resolved_at,
    resolutionNote: m.resolution_note,
    createdAt: m.created_at,
  };
}

const VIEW_SQL = `SELECT m.*, u.username AS creator_name FROM markets m JOIN users u ON u.id = m.creator_id`;

function getRow(db: DB, id: number): MarketRow {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(id) as MarketRow | undefined;
  if (!m) throw notFound('市场不存在');
  return m;
}

export function getMarket(db: DB, cfg: Config, id: number, now: number): MarketView {
  const m = db.prepare(`${VIEW_SQL} WHERE m.id = ?`).get(id) as
    | (MarketRow & { creator_name: string })
    | undefined;
  if (!m) throw notFound('市场不存在');
  return toView(m, cfg, now);
}

export type ListFilter = 'active' | 'closed' | 'settled' | 'all';

export function listMarkets(db: DB, cfg: Config, filter: ListFilter, now: number): MarketView[] {
  const where: Record<ListFilter, string> = {
    active: `m.status = 'OPEN' AND m.close_at > @now`,
    closed: `(m.status IN ('CLOSED', 'PROPOSED') OR (m.status = 'OPEN' AND m.close_at <= @now))`,
    settled: `m.status IN ('RESOLVED', 'CANCELLED')`,
    all: '1 = 1',
  };
  const order = filter === 'active' ? 'm.volume DESC, m.id DESC' : 'm.id DESC';
  const rows = db
    .prepare(`${VIEW_SQL} WHERE ${where[filter]} ORDER BY ${order} LIMIT 200`)
    .all({ now }) as (MarketRow & { creator_name: string })[];
  return rows.map((r) => toView(r, cfg, now));
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateMarketInput {
  title: string;
  description: string;
  rules: string;
  sourceUrl?: string | null;
  closeAt: number;
  /** Liquidity subsidy paid by the creator, in units. */
  subsidy: number;
}

export function createMarket(
  db: DB,
  cfg: Config,
  user: User,
  input: CreateMarketInput,
  now: number,
): number {
  if (input.closeAt <= now + 60_000) throw badRequest('BAD_CLOSE_AT', '截止时间至少要在 1 分钟之后');
  if (input.closeAt > now + 366 * 86400_000) throw badRequest('BAD_CLOSE_AT', '截止时间不能超过一年');
  if (input.subsidy < cfg.minSubsidy || input.subsidy > cfg.maxSubsidy) {
    throw badRequest('BAD_SUBSIDY', '补贴超出允许范围');
  }
  // Choose the largest b whose worst-case loss is covered by the subsidy.
  const b = Math.floor(input.subsidy / Math.LN2);
  if (requiredSubsidy(b) > input.subsidy) throw new Error('subsidy rounding');

  return db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO markets (creator_id, title, description, rules, source_url, b, subsidy, pool,
                              status, close_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
      )
      .run(
        user.id,
        input.title,
        input.description,
        input.rules,
        input.sourceUrl ?? null,
        b,
        input.subsidy,
        input.subsidy,
        input.closeAt,
        now,
      );
    const id = Number(r.lastInsertRowid);
    applyDelta(db, user.id, -input.subsidy, 'subsidy', `m${id}`, now);
    return id;
  })();
}

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export interface TradeRequest {
  outcome: Outcome;
  side: Side;
  /** BUY: points to spend, in units. */
  amount?: number;
  /** SELL: shares to sell, in units. */
  shares?: number;
  /** Slippage guards from a previous quote. */
  minShares?: number;
  minAmount?: number;
}

function assertTradable(m: MarketRow, now: number): void {
  if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '市场已停止交易');
}

function computeQuote(m: MarketRow, req: TradeRequest): Quote {
  try {
    if (req.side === 'BUY') {
      if (!req.amount) throw badRequest('BAD_AMOUNT', '请输入买入金额');
      return quoteBuyAmount(pool(m), req.outcome, req.amount);
    }
    if (!req.shares) throw badRequest('BAD_SHARES', '请输入卖出份数');
    return quoteSellShares(pool(m), req.outcome, req.shares);
  } catch (e) {
    if (e instanceof LmsrError) throw badRequest('BAD_TRADE', '数量无效或太小');
    throw e;
  }
}

export function quoteTrade(db: DB, marketId: number, req: TradeRequest, now: number): Quote {
  const m = getRow(db, marketId);
  assertTradable(m, now);
  return computeQuote(m, req);
}

interface PositionRow {
  shares: number;
  cost_basis: number;
}

function getPosition(db: DB, userId: number, marketId: number, outcome: Outcome): PositionRow {
  return (
    (db
      .prepare('SELECT shares, cost_basis FROM positions WHERE user_id = ? AND market_id = ? AND outcome = ?')
      .get(userId, marketId, outcome) as PositionRow | undefined) ?? { shares: 0, cost_basis: 0 }
  );
}

function setPosition(db: DB, userId: number, marketId: number, outcome: Outcome, p: PositionRow) {
  db.prepare(
    `INSERT INTO positions (user_id, market_id, outcome, shares, cost_basis) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, market_id, outcome) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis`,
  ).run(userId, marketId, outcome, p.shares, p.cost_basis);
}

export interface TradeResult {
  tradeId: number;
  quote: Quote;
  balance: number;
}

export function executeTrade(
  db: DB,
  userId: number,
  marketId: number,
  req: TradeRequest,
  now: number,
): TradeResult {
  return db.transaction(() => {
    const m = getRow(db, marketId);
    assertTradable(m, now);
    const pos = getPosition(db, userId, marketId, req.outcome);
    if (req.side === 'SELL' && (req.shares ?? 0) > pos.shares) {
      throw badRequest('INSUFFICIENT_SHARES', '持有份数不足');
    }

    const q = computeQuote(m, req);
    if (req.side === 'BUY' && req.minShares !== undefined && q.shares < req.minShares) {
      throw conflict('SLIPPAGE', '价格已变动，请重新确认');
    }
    if (req.side === 'SELL') {
      if (q.amount <= 0) throw badRequest('BAD_TRADE', '卖出数量太小');
      if (req.minAmount !== undefined && q.amount < req.minAmount) {
        throw conflict('SLIPPAGE', '价格已变动，请重新确认');
      }
    }

    const tr = db
      .prepare(
        `INSERT INTO trades (market_id, user_id, outcome, side, shares, amount, price_before, price_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(marketId, userId, q.outcome, q.side, q.shares, q.amount, q.priceYesBefore, q.priceYesAfter, now);
    const tradeId = Number(tr.lastInsertRowid);

    const delta = q.side === 'BUY' ? -q.amount : q.amount;
    const balance = applyDelta(db, userId, delta, 'trade', `t${tradeId}`, now);

    if (q.side === 'BUY') {
      setPosition(db, userId, marketId, q.outcome, {
        shares: pos.shares + q.shares,
        cost_basis: pos.cost_basis + q.amount,
      });
    } else {
      const remaining = pos.shares - q.shares;
      const removed = remaining === 0 ? pos.cost_basis : Math.round((pos.cost_basis * q.shares) / pos.shares);
      setPosition(db, userId, marketId, q.outcome, {
        shares: remaining,
        cost_basis: pos.cost_basis - removed,
      });
    }

    db.prepare('UPDATE markets SET q_yes = ?, q_no = ?, pool = pool + ?, volume = volume + ? WHERE id = ?').run(
      q.next.qYes,
      q.next.qNo,
      -delta,
      q.amount,
      marketId,
    );
    return { tradeId, quote: q, balance };
  })();
}

// ---------------------------------------------------------------------------
// Lifecycle: close, propose, resolve, cancel
// ---------------------------------------------------------------------------

/** Flip OPEN markets past their close time to CLOSED. Returns affected ids. */
export function closeExpired(db: DB, now: number): number[] {
  const rows = db
    .prepare(`UPDATE markets SET status = 'CLOSED' WHERE status = 'OPEN' AND close_at <= ? RETURNING id`)
    .all(now) as { id: number }[];
  return rows.map((r) => r.id);
}

/** Creator proposes an outcome; it becomes final after the dispute window unless an admin overrides. */
export function proposeResolution(
  db: DB,
  user: User,
  marketId: number,
  outcome: Outcome,
  note: string,
  now: number,
): void {
  db.transaction(() => {
    const m = getRow(db, marketId);
    if (m.creator_id !== user.id) throw forbidden('只有创建者可以提交结果');
    if (m.status !== 'OPEN' && m.status !== 'CLOSED') throw conflict('BAD_STATUS', '当前状态不能提交结果');
    db.prepare(
      `UPDATE markets SET status = 'PROPOSED', proposed_outcome = ?, proposed_at = ?, proposal_note = ?,
              close_at = MIN(close_at, ?) WHERE id = ?`,
    ).run(outcome, now, note, now, marketId);
  })();
}

/** Pay winners, return the leftover pool to the creator, mark RESOLVED. Runs inside a transaction. */
function settleResolved(db: DB, m: MarketRow, outcome: Outcome, by: number, note: string, now: number) {
  const winners = db
    .prepare('SELECT user_id, shares FROM positions WHERE market_id = ? AND outcome = ? AND shares > 0')
    .all(m.id, outcome) as { user_id: number; shares: number }[];
  let poolLeft = m.pool;
  for (const w of winners) {
    // Each share unit pays one point unit.
    applyDelta(db, w.user_id, w.shares, 'payout', `m${m.id}`, now);
    poolLeft -= w.shares;
  }
  if (poolLeft < 0) throw new Error(`market ${m.id} pool insufficient for payout`);
  if (poolLeft > 0) applyDelta(db, m.creator_id, poolLeft, 'subsidy_return', `m${m.id}`, now);

  db.prepare(
    `UPDATE markets SET status = 'RESOLVED', resolution = ?, resolved_by = ?, resolved_at = ?,
            resolution_note = ?, pool = 0, close_at = MIN(close_at, ?) WHERE id = ?`,
  ).run(outcome, by, now, note, now, m.id);
}

/** Admin: final resolution, overriding any proposal. */
export function adminResolve(
  db: DB,
  admin: User,
  marketId: number,
  outcome: Outcome,
  note: string,
  now: number,
): void {
  if (admin.role !== 'admin') throw forbidden();
  db.transaction(() => {
    const m = getRow(db, marketId);
    if (SETTLED.includes(m.status)) throw conflict('BAD_STATUS', '市场已结算');
    settleResolved(db, m, outcome, admin.id, note, now);
  })();
}

/** Finalize proposals whose dispute window has elapsed. Returns affected ids. */
export function finalizeProposals(db: DB, cfg: Config, now: number): number[] {
  const due = db
    .prepare(`SELECT * FROM markets WHERE status = 'PROPOSED' AND proposed_at <= ?`)
    .all(now - cfg.disputeWindowMs) as MarketRow[];
  for (const m of due) {
    db.transaction(() => {
      const fresh = getRow(db, m.id);
      if (fresh.status !== 'PROPOSED') return;
      settleResolved(db, fresh, fresh.proposed_outcome!, fresh.creator_id, fresh.proposal_note ?? '', now);
    })();
  }
  return due.map((m) => m.id);
}

/**
 * Void the market: refund each trader's net spend (buys - sells, floored at 0),
 * pro-rata if the pool can't cover it; anything left goes back to the creator.
 * Admins can cancel any unsettled market; creators only while nobody has traded.
 */
export function cancelMarket(db: DB, user: User, marketId: number, note: string, now: number): void {
  db.transaction(() => {
    const m = getRow(db, marketId);
    if (SETTLED.includes(m.status)) throw conflict('BAD_STATUS', '市场已结算');
    if (user.role !== 'admin') {
      if (m.creator_id !== user.id) throw forbidden();
      const traded = db.prepare('SELECT 1 FROM trades WHERE market_id = ? LIMIT 1').get(m.id);
      if (traded) throw forbidden('已有交易的市场只能由管理员作废');
    }

    const spends = db
      .prepare(
        `SELECT user_id, SUM(CASE side WHEN 'BUY' THEN amount ELSE -amount END) AS net
         FROM trades WHERE market_id = ? GROUP BY user_id HAVING net > 0`,
      )
      .all(m.id) as { user_id: number; net: number }[];
    const total = spends.reduce((s, r) => s + r.net, 0);
    let poolLeft = m.pool;
    for (const r of spends) {
      const refund = total <= m.pool ? r.net : Math.floor((m.pool * r.net) / total);
      if (refund > 0) applyDelta(db, r.user_id, refund, 'cancel_refund', `m${m.id}`, now);
      poolLeft -= refund;
    }
    if (poolLeft > 0) applyDelta(db, m.creator_id, poolLeft, 'subsidy_return', `m${m.id}`, now);

    db.prepare(
      `UPDATE markets SET status = 'CANCELLED', resolved_by = ?, resolved_at = ?, resolution_note = ?,
              pool = 0, close_at = MIN(close_at, ?) WHERE id = ?`,
    ).run(user.id, now, note, now, m.id);
  })();
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export function priceHistory(db: DB, marketId: number): { t: number; p: number }[] {
  const m = getRow(db, marketId);
  const rows = db
    .prepare('SELECT created_at AS t, price_after AS p FROM trades WHERE market_id = ? ORDER BY id')
    .all(marketId) as { t: number; p: number }[];
  return [{ t: m.created_at, p: 0.5 }, ...rows];
}

export function recentTrades(db: DB, marketId: number, limit = 30) {
  return db
    .prepare(
      `SELECT t.id, u.username, t.outcome, t.side, t.shares, t.amount, t.price_after AS priceAfter, t.created_at AS createdAt
       FROM trades t JOIN users u ON u.id = t.user_id WHERE t.market_id = ? ORDER BY t.id DESC LIMIT ?`,
    )
    .all(marketId, limit);
}

export function userPositions(db: DB, userId: number, marketId: number) {
  const out: Record<Outcome, PositionRow> = {
    YES: getPosition(db, userId, marketId, 'YES'),
    NO: getPosition(db, userId, marketId, 'NO'),
  };
  return out;
}

export interface PortfolioItem {
  marketId: number;
  title: string;
  status: MarketStatus;
  outcome: Outcome;
  shares: number;
  costBasis: number;
  /** Mark-to-market value at the current price, in units. */
  value: number;
}

export function portfolio(db: DB, userId: number, now: number) {
  const rows = db
    .prepare(
      `SELECT p.*, m.title, m.status, m.close_at, m.b, m.q_yes, m.q_no
       FROM positions p JOIN markets m ON m.id = p.market_id
       WHERE p.user_id = ? AND p.shares > 0 AND m.status NOT IN ('RESOLVED', 'CANCELLED')
       ORDER BY m.close_at`,
    )
    .all(userId) as (PositionRow & {
    market_id: number;
    outcome: Outcome;
    title: string;
    status: MarketStatus;
    close_at: number;
    b: number;
    q_yes: number;
    q_no: number;
  })[];
  const positions: PortfolioItem[] = rows.map((r) => ({
    marketId: r.market_id,
    title: r.title,
    status: r.status === 'OPEN' && now >= r.close_at ? 'CLOSED' : r.status,
    outcome: r.outcome,
    shares: r.shares,
    costBasis: r.cost_basis,
    value: Math.floor(r.shares * priceOf({ b: r.b, qYes: r.q_yes, qNo: r.q_no }, r.outcome)),
  }));
  const ledger = db
    .prepare(
      `SELECT id, delta, balance_after AS balanceAfter, reason, ref_id AS refId, created_at AS createdAt
       FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(userId);
  return { positions, ledger };
}

/**
 * Rank by profit = net worth - points granted by the system, where net worth is
 * balance + open positions at current prices + subsidies locked in own unsettled markets.
 */
export function leaderboard(db: DB, limit = 50) {
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.balance,
         COALESCE((SELECT SUM(delta) FROM ledger l WHERE l.user_id = u.id AND l.reason IN ('signup', 'checkin')), 0) AS granted,
         COALESCE((SELECT SUM(subsidy) FROM markets m WHERE m.creator_id = u.id AND m.status NOT IN ('RESOLVED', 'CANCELLED')), 0) AS locked
       FROM users u`,
    )
    .all() as { id: number; username: string; balance: number; granted: number; locked: number }[];
  const positions = db
    .prepare(
      `SELECT p.user_id, p.outcome, p.shares, m.b, m.q_yes, m.q_no
       FROM positions p JOIN markets m ON m.id = p.market_id
       WHERE p.shares > 0 AND m.status NOT IN ('RESOLVED', 'CANCELLED')`,
    )
    .all() as { user_id: number; outcome: Outcome; shares: number; b: number; q_yes: number; q_no: number }[];
  const value = new Map<number, number>();
  for (const p of positions) {
    const v = p.shares * priceOf({ b: p.b, qYes: p.q_yes, qNo: p.q_no }, p.outcome);
    value.set(p.user_id, (value.get(p.user_id) ?? 0) + v);
  }
  return users
    .map((u) => {
      const netWorth = Math.floor(u.balance + (value.get(u.id) ?? 0) + u.locked);
      return { userId: u.id, username: u.username, netWorth, profit: netWorth - u.granted };
    })
    .sort((a, b) => b.profit - a.profit)
    .slice(0, limit);
}
