import type { User } from './auth.js';
import type { Config } from './config.js';
import { type DB, houseId, isTradingHalted } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { applyDelta } from './ledger.js';
import {
  LmsrError,
  PRICE_CAP,
  cost,
  maxBuyShares,
  maxSellShares,
  type Outcome,
  type PoolState,
  type Quote,
  type Side,
  priceOf,
  priceYes,
  quoteBuyAmount,
  quoteBuyShares,
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
  house_subsidy: number;
  v_yes: number;
  v_no: number;
  paused: number;
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
  /** Creator's subsidy, in units. */
  subsidy: number;
  /** Platform-funded liquidity, in units. */
  houseSubsidy: number;
  paused: boolean;
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

/** LMSR state: user-held shares plus the pool's virtual shares. */
function pool(m: MarketRow): PoolState {
  return { b: m.b, qYes: m.q_yes + m.v_yes, qNo: m.q_no + m.v_no };
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
    houseSubsidy: m.house_subsidy,
    paused: m.paused === 1,
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
  // Liquidity = creator subsidy + platform subsidy. Choose the largest b whose
  // worst-case loss is covered by the combined pool.
  const house = cfg.houseSubsidy;
  const total = input.subsidy + house;
  const b = Math.floor(total / Math.LN2);
  if (requiredSubsidy(b) > total) throw new Error('subsidy rounding');

  return db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO markets (creator_id, title, description, rules, source_url, b, subsidy, house_subsidy,
                              pool, status, close_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
      )
      .run(
        user.id,
        input.title,
        input.description,
        input.rules,
        input.sourceUrl ?? null,
        b,
        input.subsidy,
        house,
        total,
        input.closeAt,
        now,
      );
    const id = Number(r.lastInsertRowid);
    applyDelta(db, user.id, -input.subsidy, 'subsidy', `m${id}`, now);
    if (house > 0) fundFromHouse(db, house, `m${id}`, now);
    return id;
  })();
}

/**
 * Debit `amount` from the house account, minting any shortfall first so the
 * platform's contributions are fully journaled. Must run inside a transaction.
 */
function fundFromHouse(db: DB, amount: number, refId: string, now: number): void {
  const id = houseId(db);
  const { balance } = db.prepare('SELECT balance FROM users WHERE id = ?').get(id) as { balance: number };
  if (balance < amount) applyDelta(db, id, amount - balance, 'house_mint', refId, now);
  applyDelta(db, id, -amount, 'subsidy', refId, now);
}

/**
 * Return what is left in a settled market's pool to its liquidity providers,
 * pro-rata to what each put in (creator vs. platform). Must run inside a transaction.
 */
function returnLeftover(db: DB, m: MarketRow, left: number, now: number): void {
  if (left <= 0) return;
  const total = m.subsidy + m.house_subsidy;
  const toCreator = total > 0 ? Math.floor((left * m.subsidy) / total) : left;
  const toHouse = left - toCreator;
  if (toCreator > 0) applyDelta(db, m.creator_id, toCreator, 'subsidy_return', `m${m.id}`, now);
  if (toHouse > 0) applyDelta(db, houseId(db), toHouse, 'subsidy_return', `m${m.id}`, now);
}

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

export interface LiquidityQuote {
  bBefore: number;
  bAfter: number;
  /** Points the platform must put in, in units. */
  deposit: number;
  priceYes: number;
}

/**
 * Platform adds liquidity without moving the price.
 *
 * Raising b alone would pull the price toward 50%, so the pool also takes
 * virtual shares on the leading side to keep (qYes - qNo) / b unchanged.
 * Safety invariant (constant across trades, must stay >= 0):
 *     pool - C_b(q + v) + min(vYes, vNo)
 * so the deposit is whatever keeps that margin unchanged after the change.
 * Adding liquidity near the price band is expensive by design: it lets traders
 * buy the cheap side over a much wider range.
 */
function planLiquidity(m: MarketRow, extra: number): LiquidityQuote & { vYes: number; vNo: number } {
  const s = pool(m);
  const p = priceYes(s);
  if (p < 1 - PRICE_CAP || p > PRICE_CAP) {
    throw conflict('PRICE_OUT_OF_BAND', '当前价格超出 1%–99%，等价格回到区间内再追加流动性');
  }
  const bAfter = m.b + Math.floor(extra / Math.LN2);
  if (bAfter <= m.b) throw badRequest('BAD_AMOUNT', '追加数量太小');

  const d = s.qYes - s.qNo;
  const grow = Math.round((Math.abs(d) * bAfter) / m.b) - Math.abs(d);
  const vYes = m.v_yes + (d > 0 ? grow : 0);
  const vNo = m.v_no + (d < 0 ? grow : 0);
  const after: PoolState = { b: bAfter, qYes: m.q_yes + vYes, qNo: m.q_no + vNo };

  const deposit = Math.max(
    0,
    Math.ceil(cost(after) - cost(s) - (Math.min(vYes, vNo) - Math.min(m.v_yes, m.v_no))),
  );
  return { bBefore: m.b, bAfter, deposit, priceYes: priceYes(after), vYes, vNo };
}

export function quoteLiquidity(db: DB, marketId: number, extra: number, now: number): LiquidityQuote {
  const m = getRow(db, marketId);
  if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '只能给交易中的市场追加流动性');
  const { vYes: _y, vNo: _n, ...q } = planLiquidity(m, extra);
  return q;
}

export function addLiquidity(
  db: DB,
  admin: User,
  marketId: number,
  extra: number,
  now: number,
  maxDeposit?: number,
): LiquidityQuote {
  if (admin.role !== 'admin') throw forbidden();
  return db.transaction(() => {
    const m = getRow(db, marketId);
    if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '只能给交易中的市场追加流动性');
    const plan = planLiquidity(m, extra);
    if (maxDeposit !== undefined && plan.deposit > maxDeposit) {
      throw conflict('SLIPPAGE', '价格已变动，所需注资增加，请重新确认');
    }
    if (plan.deposit > 0) fundFromHouse(db, plan.deposit, `m${m.id}:b${plan.bAfter}`, now);
    db.prepare(
      `UPDATE markets SET b = ?, v_yes = ?, v_no = ?, pool = pool + ?, house_subsidy = house_subsidy + ?
       WHERE id = ?`,
    ).run(plan.bAfter, plan.vYes, plan.vNo, plan.deposit, plan.deposit, m.id);
    const { vYes: _y, vNo: _n, ...q } = plan;
    return q;
  })();
}

// ---------------------------------------------------------------------------
// Pausing
// ---------------------------------------------------------------------------

export function setMarketPaused(db: DB, admin: User, marketId: number, paused: boolean): void {
  if (admin.role !== 'admin') throw forbidden();
  const m = getRow(db, marketId);
  if (SETTLED.includes(m.status)) throw conflict('BAD_STATUS', '市场已结算');
  db.prepare('UPDATE markets SET paused = ? WHERE id = ?').run(paused ? 1 : 0, marketId);
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

function assertTradable(db: DB, m: MarketRow, now: number): void {
  if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '市场已停止交易');
  if (isTradingHalted(db)) throw conflict('TRADING_HALTED', '全站交易已暂停');
  if (m.paused) throw conflict('MARKET_PAUSED', '该市场已被管理员暂停交易');
}

/** A quote, possibly truncated so the price stays inside the allowed band. */
export type BoundedQuote = Quote & { capped: boolean };

const OUTCOME_CN: Record<Outcome, string> = { YES: '是', NO: '否' };
const CAP_PCT = Math.round(PRICE_CAP * 100);

function computeQuote(m: MarketRow, req: TradeRequest): BoundedQuote {
  const s = pool(m);
  try {
    if (req.side === 'BUY') {
      if (!req.amount) throw badRequest('BAD_AMOUNT', '请输入买入金额');
      const limit = maxBuyShares(s, req.outcome);
      if (limit < 1) {
        throw badRequest('PRICE_LIMIT', `「${OUTCOME_CN[req.outcome]}」的价格已达 ${CAP_PCT}% 上限，暂时不能继续买入`);
      }
      const q = quoteBuyAmount(s, req.outcome, req.amount);
      if (q.shares <= limit) return { ...q, capped: false };
      return { ...quoteBuyShares(s, req.outcome, limit), capped: true };
    }
    if (!req.shares) throw badRequest('BAD_SHARES', '请输入卖出份数');
    const other: Outcome = req.outcome === 'YES' ? 'NO' : 'YES';
    const limit = maxSellShares(s, req.outcome);
    if (limit < 1) {
      throw badRequest('PRICE_LIMIT', `「${OUTCOME_CN[other]}」的价格已达 ${CAP_PCT}% 上限，暂时不能继续卖出`);
    }
    if (req.shares <= limit) return { ...quoteSellShares(s, req.outcome, req.shares), capped: false };
    return { ...quoteSellShares(s, req.outcome, limit), capped: true };
  } catch (e) {
    if (e instanceof LmsrError) throw badRequest('BAD_TRADE', '数量无效或太小');
    throw e;
  }
}

export function quoteTrade(db: DB, marketId: number, req: TradeRequest, now: number): BoundedQuote {
  const m = getRow(db, marketId);
  assertTradable(db, m, now);
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
  quote: BoundedQuote;
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
    assertTradable(db, m, now);
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

    // q.next is the LMSR state, which includes the pool's virtual shares; store user-held shares only.
    db.prepare('UPDATE markets SET q_yes = ?, q_no = ?, pool = pool + ?, volume = volume + ? WHERE id = ?').run(
      q.next.qYes - m.v_yes,
      q.next.qNo - m.v_no,
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
  returnLeftover(db, m, poolLeft, now);

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
    returnLeftover(db, m, poolLeft, now);

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
       FROM users u WHERE u.username != '__house__'`,
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
