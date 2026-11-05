import type { User } from './auth.js';
import type { Config } from './config.js';
import { type DB, houseId } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { applyDelta } from './ledger.js';
import {
  type MarketKind,
  type MarketRow,
  type MarketStatus,
  SETTLED,
  assertTradable,
  effectiveStatus,
  getRow,
  validateCloseAt,
} from './market-core.js';
import {
  type OddsOptionRow,
  type OddsOptionView,
  assertOptionOf,
  hasBets,
  loadOptions,
  optionViews,
  refundOdds,
  settleOdds,
} from './odds.js';
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

export type { MarketKind, MarketRow, MarketStatus } from './market-core.js';

export interface MarketView {
  id: number;
  kind: MarketKind;
  creatorId: number;
  creatorName: string;
  title: string;
  description: string;
  rules: string;
  sourceUrl: string | null;
  status: MarketStatus;
  /** LMSR only (null for ODDS). */
  priceYes: number | null;
  b: number;
  /** LMSR: creator's subsidy. ODDS: creator's deposit. In units. */
  subsidy: number;
  /** Platform-funded liquidity, in units. */
  houseSubsidy: number;
  paused: boolean;
  /** Max shares one user may hold per side, or null if uncapped. */
  positionCap: number | null;
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
  /** ODDS only (null for LMSR). */
  options: OddsOptionView[] | null;
  proposedOptionId: number | null;
  resolvedOptionId: number | null;
}

/** LMSR state: user-held shares plus the pool's virtual shares. */
function pool(m: MarketRow): PoolState {
  return { b: m.b, qYes: m.q_yes + m.v_yes, qNo: m.q_no + m.v_no };
}

export function toView(
  m: MarketRow & { creator_name: string },
  cfg: Config,
  now: number,
  options: OddsOptionRow[] = [],
): MarketView {
  const lmsr = m.kind === 'LMSR';
  return {
    id: m.id,
    kind: m.kind,
    creatorId: m.creator_id,
    creatorName: m.creator_name,
    title: m.title,
    description: m.description,
    rules: m.rules,
    sourceUrl: m.source_url,
    status: effectiveStatus(m, now),
    priceYes: lmsr ? priceYes(pool(m)) : null,
    b: m.b,
    subsidy: m.subsidy,
    houseSubsidy: m.house_subsidy,
    paused: m.paused === 1,
    positionCap: lmsr && Number.isFinite(positionCap(cfg, m)) ? positionCap(cfg, m) : null,
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
    options: lmsr ? null : optionViews(m, options),
    proposedOptionId: m.proposed_option,
    resolvedOptionId: m.resolved_option,
  };
}

const VIEW_SQL = `SELECT m.*, u.username AS creator_name FROM markets m JOIN users u ON u.id = m.creator_id`;

export function getMarket(db: DB, cfg: Config, id: number, now: number): MarketView {
  const m = db.prepare(`${VIEW_SQL} WHERE m.id = ?`).get(id) as
    | (MarketRow & { creator_name: string })
    | undefined;
  if (!m) throw notFound('市场不存在');
  return toView(m, cfg, now, loadOptions(db, [m.id]).get(m.id));
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
  const options = loadOptions(
    db,
    rows.filter((r) => r.kind === 'ODDS').map((r) => r.id),
  );
  return rows.map((r) => toView(r, cfg, now, options.get(r.id)));
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
  validateCloseAt(input.closeAt, now);
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
/**
 * Liquidity may only be added while the price is within this band. Near the
 * edges, new depth is mostly a pile of cheap shares on the unlikely side that
 * the next trader can scoop up at the platform's expense.
 */
export const LIQUIDITY_PRICE_BAND = 0.9;

function assertLmsr(m: MarketRow): void {
  if (m.kind !== 'LMSR') throw badRequest('WRONG_KIND', '固定赔率市场不支持这个操作');
}

function planLiquidity(m: MarketRow, extra: number): LiquidityQuote & { vYes: number; vNo: number } {
  assertLmsr(m);
  const s = pool(m);
  const p = priceYes(s);
  if (p < 1 - LIQUIDITY_PRICE_BAND || p > LIQUIDITY_PRICE_BAND) {
    throw conflict(
      'PRICE_OUT_OF_BAND',
      `当前价格 ${(p * 100).toFixed(1)}% 超出 10%–90%，等价格回到区间内再追加流动性`,
    );
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

/**
 * A quote after applying the price band and the per-user position cap.
 * `amount` is what the user pays (BUY) or receives (SELL).
 */
export type BoundedQuote = Quote & {
  capped: boolean;
  cappedBy: 'PRICE' | 'POSITION' | null;
};

const OUTCOME_CN: Record<Outcome, string> = { YES: '是', NO: '否' };
const CAP_PCT = Math.round(PRICE_CAP * 100);

/** Max shares one user may hold on one side of a market, or Infinity if uncapped. */
export function positionCap(cfg: Config, m: { b: number }): number {
  return cfg.positionCapB > 0 ? Math.floor(m.b * cfg.positionCapB) : Infinity;
}

/**
 * @param held shares of `req.outcome` the user already holds (0 when quoting anonymously)
 */
function computeQuote(cfg: Config, m: MarketRow, req: TradeRequest, held: number): BoundedQuote {
  assertLmsr(m);
  const s = pool(m);
  try {
    if (req.side === 'BUY') {
      if (!req.amount) throw badRequest('BAD_AMOUNT', '请输入买入金额');
      const priceLimit = maxBuyShares(s, req.outcome);
      if (priceLimit < 1) {
        throw badRequest('PRICE_LIMIT', `「${OUTCOME_CN[req.outcome]}」的价格已达 ${CAP_PCT}% 上限，暂时不能继续买入`);
      }
      const posLimit = positionCap(cfg, m) - held;
      if (posLimit < 1) {
        throw badRequest('POSITION_LIMIT', `你在这个市场的「${OUTCOME_CN[req.outcome]}」持仓已达上限`);
      }
      const limit = Math.min(priceLimit, posLimit);
      const cappedBy = posLimit < priceLimit ? 'POSITION' : 'PRICE';

      const q = quoteBuyAmount(s, req.outcome, req.amount);
      if (q.shares <= limit) return { ...q, capped: false, cappedBy: null };
      return { ...quoteBuyShares(s, req.outcome, limit), capped: true, cappedBy };
    }

    if (!req.shares) throw badRequest('BAD_SHARES', '请输入卖出份数');
    const other: Outcome = req.outcome === 'YES' ? 'NO' : 'YES';
    const limit = maxSellShares(s, req.outcome);
    if (limit < 1) {
      throw badRequest('PRICE_LIMIT', `「${OUTCOME_CN[other]}」的价格已达 ${CAP_PCT}% 上限，暂时不能继续卖出`);
    }
    const capped = req.shares > limit;
    const q = quoteSellShares(s, req.outcome, capped ? limit : req.shares);
    return { ...q, capped, cappedBy: capped ? 'PRICE' : null };
  } catch (e) {
    if (e instanceof LmsrError) throw badRequest('BAD_TRADE', '数量无效或太小');
    throw e;
  }
}

export function quoteTrade(
  db: DB,
  cfg: Config,
  marketId: number,
  req: TradeRequest,
  now: number,
  userId?: number,
): BoundedQuote {
  const m = getRow(db, marketId);
  assertTradable(db, m, now);
  const held = userId === undefined ? 0 : getPosition(db, userId, marketId, req.outcome).shares;
  return computeQuote(cfg, m, req, held);
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
  cfg: Config,
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

    const q = computeQuote(cfg, m, req, pos.shares);
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

/** A market's result: YES/NO for LMSR markets, the winning option for ODDS markets. */
export interface Resolution {
  outcome?: Outcome;
  optionId?: number;
}

/** Normalize a resolution for the market's kind, rejecting a mismatched one. */
function checkResolution(db: DB, m: MarketRow, r: Resolution): { outcome: Outcome | null; optionId: number | null } {
  if (m.kind === 'LMSR') {
    if (!r.outcome || r.optionId !== undefined) throw badRequest('BAD_OUTCOME', '请选择结果「是」或「否」');
    return { outcome: r.outcome, optionId: null };
  }
  if (r.optionId === undefined || r.outcome) throw badRequest('BAD_OUTCOME', '请选择胜出的选项');
  assertOptionOf(db, m, r.optionId);
  return { outcome: null, optionId: r.optionId };
}

/** Creator proposes an outcome; it becomes final after the dispute window unless an admin overrides. */
export function proposeResolution(
  db: DB,
  user: User,
  marketId: number,
  resolution: Resolution,
  note: string,
  now: number,
): void {
  db.transaction(() => {
    const m = getRow(db, marketId);
    if (m.creator_id !== user.id) throw forbidden('只有创建者可以提交结果');
    if (m.status !== 'OPEN' && m.status !== 'CLOSED') throw conflict('BAD_STATUS', '当前状态不能提交结果');
    const r = checkResolution(db, m, resolution);
    db.prepare(
      `UPDATE markets SET status = 'PROPOSED', proposed_outcome = ?, proposed_option = ?, proposed_at = ?,
              proposal_note = ?, close_at = MIN(close_at, ?) WHERE id = ?`,
    ).run(r.outcome, r.optionId, now, note, now, marketId);
  })();
}

/** Pay winners, return the leftover pool to the creator, mark RESOLVED. Runs inside a transaction. */
function settleResolved(db: DB, m: MarketRow, resolution: Resolution, by: number, note: string, now: number) {
  const r = checkResolution(db, m, resolution);
  if (m.kind === 'ODDS') settleOdds(db, m, r.optionId!, now);
  else settleLmsr(db, m, r.outcome!, now);
  db.prepare(
    `UPDATE markets SET status = 'RESOLVED', resolution = ?, resolved_option = ?, resolved_by = ?, resolved_at = ?,
            resolution_note = ?, pool = 0, close_at = MIN(close_at, ?) WHERE id = ?`,
  ).run(r.outcome, r.optionId, by, now, note, now, m.id);
}

function settleLmsr(db: DB, m: MarketRow, outcome: Outcome, now: number) {
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
}

/** Admin: final resolution, overriding any proposal. */
export function adminResolve(
  db: DB,
  admin: User,
  marketId: number,
  resolution: Resolution,
  note: string,
  now: number,
): void {
  if (admin.role !== 'admin') throw forbidden();
  db.transaction(() => {
    const m = getRow(db, marketId);
    if (SETTLED.includes(m.status)) throw conflict('BAD_STATUS', '市场已结算');
    settleResolved(db, m, resolution, admin.id, note, now);
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
      const resolution: Resolution =
        fresh.kind === 'ODDS' ? { optionId: fresh.proposed_option! } : { outcome: fresh.proposed_outcome! };
      settleResolved(db, fresh, resolution, fresh.creator_id, fresh.proposal_note ?? '', now);
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
      const traded =
        m.kind === 'ODDS' ? hasBets(db, m.id) : !!db.prepare('SELECT 1 FROM trades WHERE market_id = ? LIMIT 1').get(m.id);
      if (traded) throw forbidden('已有交易的市场只能由管理员作废');
    }

    if (m.kind === 'ODDS') refundOdds(db, m, now);
    else refundLmsr(db, m, now);
    db.prepare(
      `UPDATE markets SET status = 'CANCELLED', resolved_by = ?, resolved_at = ?, resolution_note = ?,
              pool = 0, close_at = MIN(close_at, ?) WHERE id = ?`,
    ).run(user.id, now, note, now, m.id);
  })();
}

/** LMSR void: refund each trader's net spend, pro-rata if the pool can't cover it. Runs inside a transaction. */
function refundLmsr(db: DB, m: MarketRow, now: number): void {
  // `fee` is 0 for new trades; it is kept here so trades made while a fee was charged refund in full.
  const spends = db
    .prepare(
      `SELECT user_id, SUM(CASE side WHEN 'BUY' THEN amount + fee ELSE -(amount - fee) END) AS net
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
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export function priceHistory(db: DB, marketId: number): { t: number; p: number }[] {
  const m = getRow(db, marketId);
  if (m.kind !== 'LMSR') return [];
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
 * balance + open positions at current prices + open bets at stake + subsidies / deposits
 * locked in own unsettled markets.
 */
export function leaderboard(db: DB, limit = 50) {
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.balance,
         COALESCE((SELECT SUM(delta) FROM ledger l WHERE l.user_id = u.id AND l.reason IN ('signup', 'checkin', 'reset')), 0) AS granted,
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
  // Open fixed-odds bets count at their stake until settled.
  const stakes = db
    .prepare(
      `SELECT b.user_id, SUM(b.stake) AS stake FROM bets b JOIN markets m ON m.id = b.market_id
       WHERE m.status NOT IN ('RESOLVED', 'CANCELLED') GROUP BY b.user_id`,
    )
    .all() as { user_id: number; stake: number }[];
  for (const st of stakes) value.set(st.user_id, st.stake);
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
