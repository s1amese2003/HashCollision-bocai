/**
 * Operator CLI. On the server use the `predictctl` wrapper, which runs this as
 * the service user with /etc/predict.env loaded:
 *
 *   predictctl status
 *   predictctl halt on|off          # pause / resume trading on every market
 *   predictctl pause <id> on|off    # pause / resume one market
 *   predictctl reconcile
 *   predictctl liquidity <id> <points> [--yes]   # platform adds liquidity (dry run without --yes)
 *
 * Changes take effect immediately: the server reads these flags on every trade.
 */
import { loadConfig } from './config.js';
import { isTradingHalted, openDb, setSetting } from './db.js';
import type { User } from './auth.js';
import { reconcile } from './ledger.js';
import { SCALE } from './market/lmsr.js';
import { addLiquidity, quoteLiquidity } from './markets.js';

const [cmd, ...args] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);

function onOff(v: string | undefined): boolean {
  if (v === 'on') return true;
  if (v === 'off') return false;
  usage();
}

function usage(): never {
  console.error('usage: predictctl status | halt on|off | pause <marketId> on|off | reconcile | liquidity <marketId> <points> [--yes]');
  process.exit(2);
}

function status() {
  console.log(`全站交易: ${isTradingHalted(db) ? '已暂停' : '正常'}`);
  const rows = db
    .prepare(
      `SELECT id, status, paused, substr(title, 1, 40) AS title FROM markets
       WHERE status NOT IN ('RESOLVED', 'CANCELLED') ORDER BY id`,
    )
    .all() as { id: number; status: string; paused: number; title: string }[];
  for (const r of rows) {
    console.log(`#${r.id}\t${r.status}${r.paused ? ' (已暂停)' : ''}\t${r.title}`);
  }
}

switch (cmd) {
  case 'status':
    status();
    break;
  case 'halt':
    setSetting(db, 'trading_halted', onOff(args[0]) ? '1' : '0');
    status();
    break;
  case 'pause': {
    const id = Number(args[0]);
    if (!Number.isInteger(id) || id <= 0) usage();
    const r = db
      .prepare(`UPDATE markets SET paused = ? WHERE id = ? AND status NOT IN ('RESOLVED', 'CANCELLED')`)
      .run(onOff(args[1]) ? 1 : 0, id);
    if (r.changes === 0) {
      console.error(`市场 #${id} 不存在或已结算`);
      process.exit(1);
    }
    status();
    break;
  }
  case 'liquidity': {
    const id = Number(args[0]);
    const points = Number(args[1]);
    if (!Number.isInteger(id) || id <= 0 || !(points > 0)) usage();
    const extra = Math.round(points * SCALE);
    const q = quoteLiquidity(db, id, extra, Date.now());
    const fmt = (u: number) => (u / SCALE).toFixed(1);
    console.log(
      `市场 #${id}: b ${fmt(q.bBefore)} -> ${fmt(q.bAfter)}，平台需出资 ${fmt(q.deposit)} 积分，价格保持 ${(q.priceYes * 100).toFixed(1)}%`,
    );
    if (!args.includes('--yes')) {
      console.log('（试算，未执行。确认请加 --yes）');
      break;
    }
    // The operator CLI acts with admin authority; the user record is only used for the role check.
    const operator = { id: 0, username: 'predictctl', role: 'admin' } as User;
    const done = addLiquidity(db, operator, id, extra, Date.now(), q.deposit);
    console.log(`已执行：b = ${fmt(done.bAfter)}，平台出资 ${fmt(done.deposit)} 积分`);
    break;
  }
  case 'reconcile': {
    const rep = reconcile(db);
    console.log(JSON.stringify(rep, null, 2));
    process.exit(rep.ok ? 0 : 1);
  }
  default:
    usage();
}
db.close();
