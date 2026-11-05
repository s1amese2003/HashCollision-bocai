import type { DB } from './db.js';
import { cost } from './market/lmsr.js';
import { badRequest, conflict } from './errors.js';

export type LedgerReason =
  | 'signup'
  | 'trade'
  | 'subsidy'
  | 'payout'
  | 'subsidy_return'
  | 'cancel_refund'
  | 'house_mint'
  // Fixed-odds markets: a stake, the creator's deposit, and what the creator gets back at settlement.
  | 'bet'
  | 'deposit'
  | 'book_return'
  // Operator reset of every balance (predictctl reset).
  | 'reset'
  // Manual corrections by an operator (see server/scripts).
  | 'trade_revert'
  | 'liquidity_revert';

/**
 * Change a user's balance and append a journal entry. Must be called inside a
 * transaction. (user, reason, refId) is unique, so replays are rejected.
 */
export function applyDelta(
  db: DB,
  userId: number,
  delta: number,
  reason: LedgerReason,
  refId: string,
  now: number,
): number {
  if (!Number.isSafeInteger(delta)) throw new Error(`invalid delta ${delta}`);
  const row = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as
    | { balance: number }
    | undefined;
  if (!row) throw new Error(`user ${userId} not found`);
  const after = row.balance + delta;
  if (after < 0) throw badRequest('INSUFFICIENT_BALANCE', '积分不足');

  try {
    db.prepare(
      `INSERT INTO ledger (user_id, delta, balance_after, reason, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, delta, after, reason, refId, now);
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw conflict('DUPLICATE_ENTRY', '重复操作');
    }
    throw e;
  }
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
  return after;
}

export interface ReconcileReport {
  ok: boolean;
  /** Users whose balance differs from the sum of their journal. */
  balanceMismatches: { userId: number; balance: number; ledgerSum: number }[];
  /** Markets whose pool, shares or bets don't add up. */
  marketMismatches: { marketId: number; problem: string }[];
}

/** Verify the accounting invariants. Cheap enough to run on startup and on demand. */
export function reconcile(db: DB): ReconcileReport {
  const balanceMismatches = db
    .prepare(
      `SELECT u.id AS userId, u.balance AS balance, COALESCE(SUM(l.delta), 0) AS ledgerSum
       FROM users u LEFT JOIN ledger l ON l.user_id = u.id
       GROUP BY u.id HAVING balance != ledgerSum`,
    )
    .all() as ReconcileReport['balanceMismatches'];

  const marketMismatches: ReconcileReport['marketMismatches'] = [];
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.status, m.q_yes, m.q_no, m.pool, m.b, m.v_yes, m.v_no, m.subsidy,
         COALESCE((SELECT SUM(shares) FROM positions p WHERE p.market_id = m.id AND outcome = 'YES'), 0) AS pos_yes,
         COALESCE((SELECT SUM(shares) FROM positions p WHERE p.market_id = m.id AND outcome = 'NO'), 0) AS pos_no
       FROM markets m`,
    )
    .all() as {
    id: number;
    kind: string;
    status: string;
    subsidy: number;
    q_yes: number;
    q_no: number;
    pool: number;
    b: number;
    v_yes: number;
    v_no: number;
    pos_yes: number;
    pos_no: number;
  }[];
  const oddsOptions = db.prepare(
    `SELECT o.id, o.stake_total, o.liability,
       COALESCE((SELECT SUM(stake) FROM bets b WHERE b.option_id = o.id), 0) AS stakes,
       COALESCE((SELECT SUM(payout) FROM bets b WHERE b.option_id = o.id), 0) AS payouts
     FROM odds_options o WHERE o.market_id = ?`,
  );
  for (const r of rows) {
    const settled = r.status === 'RESOLVED' || r.status === 'CANCELLED';
    if (r.kind === 'ODDS') {
      if (settled) {
        if (r.pool !== 0) marketMismatches.push({ marketId: r.id, problem: `settled market still holds ${r.pool}` });
        continue;
      }
      const opts = oddsOptions.all(r.id) as { id: number; stake_total: number; liability: number; stakes: number; payouts: number }[];
      const stakes = opts.reduce((s, o) => s + o.stakes, 0);
      if (r.pool !== r.subsidy + stakes) {
        marketMismatches.push({ marketId: r.id, problem: 'pool != deposit + stakes' });
      }
      for (const o of opts) {
        if (o.stake_total !== o.stakes || o.liability !== o.payouts) {
          marketMismatches.push({ marketId: r.id, problem: `option ${o.id} totals do not match bets` });
        }
        // The bookmaker must be able to pay out whichever option wins.
        if (r.pool < o.liability) {
          marketMismatches.push({ marketId: r.id, problem: `pool cannot cover option ${o.id}` });
        }
      }
      continue;
    }
    if (!settled && (r.q_yes !== r.pos_yes || r.q_no !== r.pos_no)) {
      marketMismatches.push({ marketId: r.id, problem: 'shares do not match positions' });
    }
    if (settled && r.pool !== 0) {
      marketMismatches.push({ marketId: r.id, problem: `settled market still holds ${r.pool}` });
    }
    // Pool must always be able to pay every winning share.
    if (!settled && r.pool < Math.max(r.q_yes, r.q_no)) {
      marketMismatches.push({ marketId: r.id, problem: 'pool cannot cover worst-case payout' });
    }
    // Stronger: pool must cover any future sequence of trades (LMSR loss bound).
    // pool - C(q + v) + min(v) never decreases across trades; allow 1 unit of float noise.
    if (!settled) {
      const c = cost({ b: r.b, qYes: r.q_yes + r.v_yes, qNo: r.q_no + r.v_no });
      if (r.pool - c + Math.min(r.v_yes, r.v_no) < -1) {
        marketMismatches.push({ marketId: r.id, problem: 'pool below LMSR loss bound' });
      }
    }
  }

  return {
    ok: balanceMismatches.length === 0 && marketMismatches.length === 0,
    balanceMismatches,
    marketMismatches,
  };
}
