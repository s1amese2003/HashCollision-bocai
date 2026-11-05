/** Market row and lifecycle checks shared by both market kinds (LMSR and fixed odds). */
import { type DB, isTradingHalted } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import type { Outcome } from './market/lmsr.js';

export type MarketStatus = 'OPEN' | 'CLOSED' | 'PROPOSED' | 'RESOLVED' | 'CANCELLED';
/** LMSR: automated market maker, YES/NO shares. ODDS: creator-set fixed odds, creator is the bookmaker. */
export type MarketKind = 'LMSR' | 'ODDS';

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
  /** LMSR: creator's liquidity subsidy. ODDS: creator's deposit. */
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
  kind: MarketKind;
  proposed_option: number | null;
  resolved_option: number | null;
}

export const SETTLED: MarketStatus[] = ['RESOLVED', 'CANCELLED'];

/** OPEN markets past their close time are reported as CLOSED even before the sweeper runs. */
export function effectiveStatus(m: MarketRow, now: number): MarketStatus {
  return m.status === 'OPEN' && now >= m.close_at ? 'CLOSED' : m.status;
}

export function getRow(db: DB, id: number): MarketRow {
  const m = db.prepare('SELECT * FROM markets WHERE id = ?').get(id) as MarketRow | undefined;
  if (!m) throw notFound('市场不存在');
  return m;
}

export function validateCloseAt(closeAt: number, now: number): void {
  if (closeAt <= now + 60_000) throw badRequest('BAD_CLOSE_AT', '截止时间至少要在 1 分钟之后');
  if (closeAt > now + 366 * 86400_000) throw badRequest('BAD_CLOSE_AT', '截止时间不能超过一年');
}

export function assertTradable(db: DB, m: MarketRow, now: number): void {
  if (effectiveStatus(m, now) !== 'OPEN') throw conflict('MARKET_NOT_OPEN', '市场已停止交易');
  if (isTradingHalted(db)) throw conflict('TRADING_HALTED', '全站交易已暂停');
  if (m.paused) throw conflict('MARKET_PAUSED', '该市场已被管理员暂停交易');
}
