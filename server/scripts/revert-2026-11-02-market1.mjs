// One-off correction, 2026-11-02.
//
// At 15:18:48 an operator (Claude, via predictctl) added platform liquidity to
// market #1 while its price had been pushed to 98.9%. Within 20 seconds two
// trades (#248, #249) bought large amounts of the cheap NO side created by that
// liquidity. The market was paused right after. The owner chose to undo both:
//   1. revert trades #248 and #249 with a full refund (cost + fee),
//   2. revert the liquidity add (b back to 144269, virtual shares and the
//      platform deposit removed, deposit returned to the house account).
// Every balance change is journaled (trade_revert / liquidity_revert); the
// reverted trade rows are deleted so they no longer count toward prices or
// cancel refunds, while the ledger keeps the full history.
//
// Usage (as the service user, DB_PATH from /etc/predict.env):
//   node scripts/revert-2026-11-02-market1.mjs           # dry run: checks + preview, rolls back
//   node scripts/revert-2026-11-02-market1.mjs --apply   # commit
import Database from 'better-sqlite3';

const APPLY = process.argv.includes('--apply');
const MARKET = 1;
const TRADE_IDS = [248, 249];
const LIQ_REF = 'm1:b865616';
const B_BEFORE = 144269;
const B_AFTER = 865616;
const NOW = Date.now();

const db = new Database(process.env.DB_PATH ?? 'data/app.db');
db.pragma('foreign_keys = ON');

function fail(msg) {
  throw new Error(`precondition failed: ${msg}`);
}

function credit(userId, delta, reason, refId) {
  const { balance } = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  const after = balance + delta;
  if (after < 0) fail(`user ${userId} would go negative`);
  db.prepare(
    `INSERT INTO ledger (user_id, delta, balance_after, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, delta, after, reason, refId, NOW);
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
}

const priceYes = (m) => 1 / (1 + Math.exp((m.q_no + m.v_no - (m.q_yes + m.v_yes)) / m.b));

const run = db.transaction(() => {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(MARKET);
  if (!m) fail('market missing');
  if (m.paused !== 1) fail('market must be paused');
  if (m.b !== B_AFTER) fail(`b is ${m.b}, expected ${B_AFTER}`);

  const house = db.prepare(`SELECT id FROM users WHERE username = '__house__'`).get();
  const add = db
    .prepare(`SELECT delta, created_at FROM ledger WHERE user_id = ? AND reason = 'subsidy' AND ref_id = ?`)
    .get(house.id, LIQ_REF);
  if (!add) fail('liquidity ledger entry missing');
  const deposit = -add.delta;

  // Exactly the two known trades happened after the liquidity add, and nothing else.
  const after = db
    .prepare('SELECT * FROM trades WHERE market_id = ? AND created_at >= ? ORDER BY id')
    .all(MARKET, add.created_at);
  if (after.map((t) => t.id).join(',') !== TRADE_IDS.join(',')) {
    fail(`trades after the add are [${after.map((t) => t.id)}], expected [${TRADE_IDS}]`);
  }

  console.log(`before: b=${m.b} q=(${m.q_yes},${m.q_no}) v=(${m.v_yes},${m.v_no}) pool=${m.pool} p=${priceYes(m).toFixed(4)}`);

  // 1. Revert the trades, newest first.
  for (const t of [...after].reverse()) {
    if (t.side !== 'BUY') fail(`trade ${t.id} is not a BUY`);
    const total = t.amount + t.fee;
    const pos = db
      .prepare('SELECT shares, cost_basis FROM positions WHERE user_id = ? AND market_id = ? AND outcome = ?')
      .get(t.user_id, MARKET, t.outcome);
    if (!pos || pos.shares < t.shares) fail(`user ${t.user_id} no longer holds the shares from trade ${t.id}`);

    credit(t.user_id, total, 'trade_revert', `t${t.id}`);
    db.prepare('UPDATE positions SET shares = ?, cost_basis = ? WHERE user_id = ? AND market_id = ? AND outcome = ?').run(
      pos.shares - t.shares,
      Math.max(0, pos.cost_basis - total),
      t.user_id,
      MARKET,
      t.outcome,
    );
    const col = t.outcome === 'YES' ? 'q_yes' : 'q_no';
    db.prepare(
      `UPDATE markets SET ${col} = ${col} - ?, pool = pool - ?, volume = volume - ?, fees = fees - ? WHERE id = ?`,
    ).run(t.shares, total, t.amount, t.fee, MARKET);
    db.prepare('DELETE FROM trades WHERE id = ?').run(t.id);
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(t.user_id);
    console.log(`reverted trade #${t.id}: ${u.username} refunded ${total / 1000} points, -${t.shares / 1000} ${t.outcome}`);
  }

  // 2. Revert the liquidity add.
  const cur = db.prepare('SELECT * FROM markets WHERE id = ?').get(MARKET);
  credit(house.id, deposit, 'liquidity_revert', LIQ_REF);
  db.prepare(
    `UPDATE markets SET b = ?, v_yes = 0, v_no = 0, pool = pool - ?, house_subsidy = house_subsidy - ? WHERE id = ?`,
  ).run(B_BEFORE, deposit, deposit, MARKET);
  console.log(`reverted liquidity: b ${cur.b} -> ${B_BEFORE}, removed virtual (${cur.v_yes},${cur.v_no}), deposit ${deposit / 1000} back to house`);

  const fin = db.prepare('SELECT * FROM markets WHERE id = ?').get(MARKET);
  if (fin.pool < Math.max(fin.q_yes, fin.q_no)) fail('pool cannot cover payouts after revert');
  console.log(`after:  b=${fin.b} q=(${fin.q_yes},${fin.q_no}) v=(${fin.v_yes},${fin.v_no}) pool=${fin.pool} p=${priceYes(fin).toFixed(4)}`);

  if (!APPLY) throw new DryRun();
});

class DryRun extends Error {}

try {
  run();
  console.log('APPLIED.');
} catch (e) {
  if (e instanceof DryRun) console.log('DRY RUN: rolled back, nothing changed. Re-run with --apply to commit.');
  else {
    console.error(e.message);
    process.exit(1);
  }
}
