/**
 * Operator CLI. On the server use the `predictctl` wrapper, which runs this as
 * the service user with /etc/predict.env loaded:
 *
 *   predictctl status
 *   predictctl halt on|off          # pause / resume trading on every market
 *   predictctl pause <id> on|off    # pause / resume one market
 *   predictctl reconcile
 *   predictctl liquidity <id> <points>                    # dry run: shows the deposit
 *   predictctl liquidity <id> <points> --max <deposit>    # execute; refuses if the deposit exceeds <deposit>
 *   predictctl reset <points>              # dry run: what a full reset would wipe
 *   predictctl reset <points> --confirm    # back up the database, wipe all markets and history, every user starts at <points>
 *
 * Changes take effect immediately: the server reads these flags on every trade.
 */
import { loadConfig } from './config.js';
import { isTradingHalted, openDb, setSetting } from './db.js';
import type { User } from './auth.js';
import { reconcile } from './ledger.js';
import { SCALE } from './market/lmsr.js';
import { addLiquidity, quoteLiquidity } from './markets.js';
import { planReset, resetAll } from './reset.js';

const [cmd, ...args] = process.argv.slice(2);
const dbPath = loadConfig().dbPath;
const db = openDb(dbPath);

function onOff(v: string | undefined): boolean {
  if (v === 'on') return true;
  if (v === 'off') return false;
  usage();
}

function usage(): never {
  console.error(
    'usage: predictctl status | halt on|off | pause <marketId> on|off | reconcile | liquidity <marketId> <points> [--max <deposit>] | reset <points> [--confirm]',
  );
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

try {
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
    const maxIdx = args.indexOf('--max');
    if (maxIdx < 0) {
      // Execution is a separate, deliberate step: the operator must re-run with the deposit they accept.
      console.log(`（试算，未执行。确认请运行：predictctl liquidity ${id} ${points} --max ${Math.ceil(q.deposit / SCALE)}）`);
      break;
    }
    const maxPoints = Number(args[maxIdx + 1]);
    if (!(maxPoints > 0)) usage();
    // The operator CLI acts with admin authority; the user record is only used for the role check.
    const operator = { id: 0, username: 'predictctl', role: 'admin' } as User;
    const done = addLiquidity(db, operator, id, extra, Date.now(), Math.round(maxPoints * SCALE));
    console.log(`已执行：b = ${fmt(done.bAfter)}，平台出资 ${fmt(done.deposit)} 积分`);
    break;
  }
  case 'reset': {
    const points = Number(args[0]);
    if (!Number.isInteger(points) || points < 0) usage();
    const fmt = (u: number) => (u / SCALE).toFixed(1);
    const p = planReset(db, points * SCALE);
    console.log(
      `将删除 ${p.markets} 个市场、${p.trades} 笔交易、${p.bets} 笔投注和全部积分流水；` +
        `${p.users} 个用户（当前余额合计 ${fmt(p.balancesBefore)}）每人重置为 ${points} 积分。账号和密码保留。`,
    );
    if (!args.includes('--confirm')) {
      console.log(`（试算，未执行。确认请运行：predictctl reset ${points} --confirm）`);
      break;
    }
    const backup = `${dbPath}.before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    db.prepare('VACUUM INTO ?').run(backup);
    console.log(`已备份到 ${backup}`);
    resetAll(db, points * SCALE, Date.now());
    const rep = reconcile(db);
    console.log(`已重置。对账：${rep.ok ? '正常' : JSON.stringify(rep)}`);
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
} catch (e) {
  // Business errors (AppError) carry a readable message; anything else is a bug worth a stack.
  if (e instanceof Error && e.name === 'AppError') {
    console.error(`失败：${e.message}`);
    process.exit(1);
  }
  throw e;
}
db.close();
