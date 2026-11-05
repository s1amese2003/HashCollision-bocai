/**
 * Fixed-odds markets ("traditional bookmaking").
 *
 * The creator is the bookmaker: they lock a deposit and set decimal odds for
 * 2-10 options. A bet locks the odds at the time it is placed; a winning bet
 * returns floor(stake * odds), stake included. Losing stakes go to the creator.
 *
 * Solvency: the market's pool is deposit + every stake. A bet is only accepted
 * if, after it, the pool still covers the total payout of every option:
 *     pool >= option.liability   for every option
 * A bet on option j only raises j's liability (and the pool by its stake), so
 * only j needs checking. The creator can top up the deposit to accept more.
 */
import type { User } from './auth.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { badRequest, conflict, forbidden } from './errors.js';
import { applyDelta } from './ledger.js';
import { SCALE } from './market/lmsr.js';
import { type MarketRow, SETTLED, assertTradable, effectiveStatus, getRow, validateCloseAt } from './market-core.js';

/** Odds are stored as integers x 100. */
export const ODDS_SCALE = 100;
export const MIN_ODDS = 101;
export const MAX_ODDS = 100 * ODDS_SCALE;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
/** Smallest accepted stake, in units. */
export const MIN_STAKE = SCALE;

export interface OddsOptionRow {
  id: number;
  market_id: number;
  position: number;
  label: string;
  odds: number;
  stake_total: number;
  liability: number;
}

export interface OddsOptionView {
  id: number;
  label: string;
  /** Decimal odds x 100. */
  odds: number;
  stakeTotal: number;
  /** What the market pays out if this option wins, in units. */
  liability: number;
  /** Largest single stake on this option the bookmaker can still cover, in units. */
  maxStake: number;
}

/** Return of a winning bet, stake included, rounded down (in the bookmaker's favour). */
export function payoutFor(stake: number, odds: number): number {
  return Math.floor((stake * odds) / ODDS_SCALE);
}

/**
 * Largest stake s on an option such that its new liability fits in the new pool:
 *   liability + floor(s * odds / 100) <= pool + s
 *   <=> floor(s * (odds - 100) / 100) <= pool - liability
 */
export function maxStake(pool: number, liability: number, odds: number): number {
  const headroom = pool - liability;
  if (headroom < 0) return 0;
  return Math.floor((ODDS_SCALE * (headroom + 1) - 1) / (odds - ODDS_SCALE));
}

function assertOdds(odds: number): void {
  if (!Number.isInteger(odds) || odds < MIN_ODDS || odds > MAX_ODDS) {
    throw badRequest('BAD_ODDS', `赔率需在 ${MIN_ODDS / ODDS_SCALE} 到 ${MAX_ODDS / ODDS_SCALE} 之间，最多两位小数`);
  }
}

export function loadOptions(db: DB, marketIds: number[]): Map<number, OddsOptionRow[]> {
  const out = new Map<number, OddsOptionRow[]>();
  if (marketIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT * FROM odds_options WHERE market_id IN (SELECT value FROM json_each(?)) ORDER BY market_id, position`,
    )
    .all(JSON.stringify(marketIds)) as OddsOptionRow[];
  for (const r of rows) {
    const list = out.get(r.market_id) ?? [];
    list.push(r);
    out.set(r.market_id, list);
  }
  return out;
}

export function optionViews(m: MarketRow, rows: OddsOptionRow[]): OddsOptionView[] {
  return rows.map((o) => ({
    id: o.id,
    label: o.label,
    odds: o.odds,
    stakeTotal: o.stake_total,
    liability: o.liability,
    maxStake: SETTLED.includes(m.status) ? 0 : maxStake(m.pool, o.liability, o.odds),
  }));
}

function getOption(db: DB, m: MarketRow, optionId: number): OddsOptionRow {
  const o = db.prepare('SELECT * FROM odds_options WHERE id = ? AND market_id = ?').get(optionId, m.id) as
    | OddsOptionRow
    | undefined;
  if (!o) throw badRequest('BAD_OPTION', '选项不存在');
  return o;
}

export function assertOddsMarket(m: MarketRow): void {
  if (m.kind !== 'ODDS') throw badRequest('WRONG_KIND', '这不是固定赔率市场');
}

/** Validates that `optionId` belongs to the market. */
export function assertOptionOf(db: DB, m: MarketRow, optionId: number): void {
  getOption(db, m, optionId);
}

// ---------------------------------------------------------------------------
// Creation and bookmaker controls
// ---------------------------------------------------------------------------

export interface CreateOddsMarketInput {
  title: string;
  description: string;
  rules: string;
  sourceUrl?: string | null;
  closeAt: number;
  /** Creator's deposit, in units. */
  deposit: number;
  options: { label: string; odds: number }[];
}

export function createOddsMarket(
  db: DB,
  cfg: Config,
  user: User,
  input: CreateOddsMarketInput,
  now: number,
): number {
  validateCloseAt(input.closeAt, now);
  if (input.deposit < cfg.minDeposit) {
    throw badRequest('BAD_DEPOSIT', `保证金至少 ${cfg.minDeposit / SCALE} 积分`);
  }
  if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
    throw badRequest('BAD_OPTIONS', `选项需要 ${MIN_OPTIONS} 到 ${MAX_OPTIONS} 个`);
  }
  const labels = input.options.map((o) => o.label.trim());
  if (labels.some((l) => l.length === 0)) throw badRequest('BAD_OPTIONS', '选项名称不能为空');
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
    throw badRequest('BAD_OPTIONS', '选项名称不能重复');
  }
  for (const o of input.options) assertOdds(o.odds);

  return db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO markets (kind, creator_id, title, description, rules, source_url, b, subsidy, house_subsidy,
                              pool, status, close_at, created_at)
         VALUES ('ODDS', ?, ?, ?, ?, ?, 0, ?, 0, ?, 'OPEN', ?, ?)`,
      )
      .run(
        user.id,
        input.title,
        input.description,
        input.rules,
        input.sourceUrl ?? null,
        input.deposit,
        input.deposit,
        input.closeAt,
        now,
      );
    const id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO odds_options (market_id, position, label, odds) VALUES (?, ?, ?, ?)');
    input.options.forEach((o, i) => ins.run(id, i, labels[i], o.odds));
    applyDelta(db, user.id, -input.deposit, 'deposit', `m${id}`, now);
    return id;
  })();
}

/** Creator changes odds while the market is open. Existing bets keep the odds they were placed at. */
export function updateOdds(
  db: DB,
  user: User,
  marketId: number,
  updates: { optionId: number; odds: number }[],
  now: number,
): void {
  db.transaction(() => {
    const m = getRow(db, marketId);
    assertOddsMarket(m);
    if (m.creator_id !== user.id) throw forbidden('只有创建者可以调整赔率');
    if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '市场已停止下注，不能再调整赔率');
    const set = db.prepare('UPDATE odds_options SET odds = ? WHERE id = ?');
    for (const u of updates) {
      getOption(db, m, u.optionId);
      assertOdds(u.odds);
      set.run(u.odds, u.optionId);
    }
  })();
}

/** Creator adds to the deposit so more bets can be accepted. */
export function addDeposit(db: DB, user: User, marketId: number, amount: number, now: number): void {
  db.transaction(() => {
    const m = getRow(db, marketId);
    assertOddsMarket(m);
    if (m.creator_id !== user.id) throw forbidden('只有创建者可以追加保证金');
    if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '市场已停止下注，不能再追加保证金');
    const after = m.subsidy + amount;
    // The deposit only grows, so the running total makes a unique journal reference.
    applyDelta(db, user.id, -amount, 'deposit', `m${m.id}:d${after}`, now);
    db.prepare('UPDATE markets SET subsidy = ?, pool = pool + ? WHERE id = ?').run(after, amount, m.id);
  })();
}

// ---------------------------------------------------------------------------
// Betting
// ---------------------------------------------------------------------------

export interface BetRequest {
  optionId: number;
  /** Points to stake, in units. */
  stake: number;
  /** The odds the user saw (x 100); the bet is rejected if they have changed since. */
  odds: number;
}

export interface BetResult {
  betId: number;
  optionId: number;
  label: string;
  stake: number;
  odds: number;
  payout: number;
  balance: number;
}

export function placeBet(db: DB, user: User, marketId: number, req: BetRequest, now: number): BetResult {
  return db.transaction(() => {
    const m = getRow(db, marketId);
    assertOddsMarket(m);
    assertTradable(db, m, now);
    if (m.creator_id === user.id) throw forbidden('庄家不能在自己的盘口下注');
    const o = getOption(db, m, req.optionId);
    if (o.odds !== req.odds) throw conflict('SLIPPAGE', '赔率已变动，请重新确认');
    if (req.stake < MIN_STAKE) throw badRequest('BAD_STAKE', `每注至少 ${MIN_STAKE / SCALE} 积分`);
    const limit = maxStake(m.pool, o.liability, o.odds);
    if (req.stake > limit) {
      throw badRequest(
        'LIABILITY_LIMIT',
        limit < MIN_STAKE
          ? `庄家保证金不足，「${o.label}」暂时不能再下注`
          : `庄家保证金不足，「${o.label}」最多还能下注 ${Math.floor(limit / SCALE)} 积分`,
      );
    }

    const payout = payoutFor(req.stake, o.odds);
    const r = db
      .prepare(
        `INSERT INTO bets (market_id, option_id, user_id, stake, odds, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, o.id, user.id, req.stake, o.odds, payout, now);
    const betId = Number(r.lastInsertRowid);
    const balance = applyDelta(db, user.id, -req.stake, 'bet', `b${betId}`, now);
    db.prepare('UPDATE odds_options SET stake_total = stake_total + ?, liability = liability + ? WHERE id = ?').run(
      req.stake,
      payout,
      o.id,
    );
    db.prepare('UPDATE markets SET pool = pool + ?, volume = volume + ? WHERE id = ?').run(req.stake, req.stake, m.id);
    return { betId, optionId: o.id, label: o.label, stake: req.stake, odds: o.odds, payout, balance };
  })();
}

// ---------------------------------------------------------------------------
// Settlement (called by the shared lifecycle in markets.ts, inside its transaction)
// ---------------------------------------------------------------------------

/** Pay every bet on the winning option; whatever is left in the pool goes to the creator. */
export function settleOdds(db: DB, m: MarketRow, winningOption: number, now: number): void {
  getOption(db, m, winningOption);
  const winners = db
    .prepare('SELECT user_id, SUM(payout) AS total FROM bets WHERE market_id = ? AND option_id = ? GROUP BY user_id')
    .all(m.id, winningOption) as { user_id: number; total: number }[];
  let left = m.pool;
  for (const w of winners) {
    applyDelta(db, w.user_id, w.total, 'payout', `m${m.id}`, now);
    left -= w.total;
  }
  if (left < 0) throw new Error(`market ${m.id} pool insufficient for payout`);
  if (left > 0) applyDelta(db, m.creator_id, left, 'book_return', `m${m.id}`, now);
}

/** Void: every bettor gets their stakes back, the creator gets the deposit back. */
export function refundOdds(db: DB, m: MarketRow, now: number): void {
  const stakes = db
    .prepare('SELECT user_id, SUM(stake) AS total FROM bets WHERE market_id = ? GROUP BY user_id')
    .all(m.id) as { user_id: number; total: number }[];
  let left = m.pool;
  for (const s of stakes) {
    applyDelta(db, s.user_id, s.total, 'cancel_refund', `m${m.id}`, now);
    left -= s.total;
  }
  if (left < 0) throw new Error(`market ${m.id} pool insufficient for refund`);
  if (left > 0) applyDelta(db, m.creator_id, left, 'book_return', `m${m.id}`, now);
}

export function hasBets(db: DB, marketId: number): boolean {
  return !!db.prepare('SELECT 1 FROM bets WHERE market_id = ? LIMIT 1').get(marketId);
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface BetRow {
  id: number;
  username: string;
  optionId: number;
  label: string;
  stake: number;
  odds: number;
  payout: number;
  createdAt: number;
}

const BET_SQL = `SELECT b.id, u.username, b.option_id AS optionId, o.label, b.stake, b.odds, b.payout, b.created_at AS createdAt
  FROM bets b JOIN users u ON u.id = b.user_id JOIN odds_options o ON o.id = b.option_id`;

export function recentBets(db: DB, marketId: number, limit = 30): BetRow[] {
  return db.prepare(`${BET_SQL} WHERE b.market_id = ? ORDER BY b.id DESC LIMIT ?`).all(marketId, limit) as BetRow[];
}

export function userBets(db: DB, userId: number, marketId: number): BetRow[] {
  return db
    .prepare(`${BET_SQL} WHERE b.market_id = ? AND b.user_id = ? ORDER BY b.id DESC`)
    .all(marketId, userId) as BetRow[];
}

export interface OpenBet {
  betId: number;
  marketId: number;
  title: string;
  status: string;
  label: string;
  stake: number;
  odds: number;
  payout: number;
  createdAt: number;
}

/** A user's bets in markets that are not settled yet. */
export function openBets(db: DB, userId: number, now: number): OpenBet[] {
  const rows = db
    .prepare(
      `SELECT b.id AS betId, m.id AS marketId, m.title, m.status, m.close_at, o.label, b.stake, b.odds, b.payout,
              b.created_at AS createdAt
       FROM bets b JOIN markets m ON m.id = b.market_id JOIN odds_options o ON o.id = b.option_id
       WHERE b.user_id = ? AND m.status NOT IN ('RESOLVED', 'CANCELLED')
       ORDER BY m.close_at, b.id`,
    )
    .all(userId) as (OpenBet & { close_at: number })[];
  return rows.map(({ close_at, ...r }) => ({ ...r, status: r.status === 'OPEN' && now >= close_at ? 'CLOSED' : r.status }));
}
