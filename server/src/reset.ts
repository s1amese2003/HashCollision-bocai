/**
 * Operator reset: wipe every market, bet, trade, position and journal entry,
 * keep the accounts (usernames, passwords, sessions), and give every user the
 * same starting balance. Run through `predictctl reset`, which backs the
 * database up first.
 */
import { type DB, HOUSE_USERNAME } from './db.js';
import { applyDelta } from './ledger.js';

export interface ResetSummary {
  users: number;
  markets: number;
  trades: number;
  bets: number;
  /** Sum of all user balances before the reset, in units. */
  balancesBefore: number;
  /** Starting balance each user gets, in units. */
  initial: number;
}

const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

export function planReset(db: DB, initial: number): ResetSummary {
  const users = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS s FROM users WHERE username != ?')
    .get(HOUSE_USERNAME) as { n: number; s: number };
  return {
    users: users.n,
    markets: count(db, 'markets'),
    trades: count(db, 'trades'),
    bets: count(db, 'bets'),
    balancesBefore: users.s,
    initial,
  };
}

export function resetAll(db: DB, initial: number, now: number): ResetSummary {
  if (!Number.isSafeInteger(initial) || initial < 0) throw new Error(`invalid initial balance ${initial}`);
  return db.transaction(() => {
    const summary = planReset(db, initial);
    // Children before parents (foreign keys are enforced).
    for (const t of ['bets', 'odds_options', 'positions', 'trades', 'markets', 'ledger']) db.exec(`DELETE FROM ${t}`);
    db.prepare('UPDATE users SET balance = 0').run();
    const users = db.prepare('SELECT id FROM users WHERE username != ?').all(HOUSE_USERNAME) as { id: number }[];
    if (initial > 0) for (const u of users) applyDelta(db, u.id, initial, 'reset', `reset:${now}`, now);
    return summary;
  })();
}
