export const SCALE = 1000;

export type Outcome = 'YES' | 'NO';
export type Side = 'BUY' | 'SELL';
export type MarketStatus = 'OPEN' | 'CLOSED' | 'PROPOSED' | 'RESOLVED' | 'CANCELLED';

export interface Me {
  id: number;
  username: string;
  role: 'user' | 'admin';
  balance: number;
  checkedInToday: boolean;
}

export interface SiteConfig {
  scale: number;
  signupBonus: number;
  checkinBonus: number;
  minSubsidy: number;
  maxSubsidy: number;
  houseSubsidy: number;
  disputeWindowMs: number;
}

export interface Market {
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
  houseSubsidy: number;
  paused: boolean;
  volume: number;
  closeAt: number;
  proposedOutcome: Outcome | null;
  proposedAt: number | null;
  proposalNote: string | null;
  finalizesAt: number | null;
  resolution: Outcome | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
  createdAt: number;
}

export interface TradeRow {
  id: number;
  username: string;
  outcome: Outcome;
  side: Side;
  shares: number;
  amount: number;
  priceAfter: number;
  createdAt: number;
}

export interface Position {
  shares: number;
  cost_basis: number;
}

export interface Quote {
  outcome: Outcome;
  side: Side;
  shares: number;
  amount: number;
  priceYesBefore: number;
  priceYesAfter: number;
  avgPrice: number;
  /** True when the trade was truncated to keep the price within 1%-99%. */
  capped: boolean;
}

export interface LiquidityQuote {
  bBefore: number;
  bAfter: number;
  deposit: number;
  priceYes: number;
}

export interface PortfolioItem {
  marketId: number;
  title: string;
  status: MarketStatus;
  outcome: Outcome;
  shares: number;
  costBasis: number;
  value: number;
}

export interface LedgerRow {
  id: number;
  delta: number;
  balanceAfter: number;
  reason: string;
  refId: string;
  createdAt: number;
}

export interface LeaderRow {
  userId: number;
  username: string;
  netWorth: number;
  profit: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'HTTP', err.message ?? `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: Me | null; config: SiteConfig; tradingHalted: boolean }>('GET', '/api/me'),
  register: (username: string, password: string) =>
    request<{ user: Me }>('POST', '/api/register', { username, password }),
  login: (username: string, password: string) =>
    request<{ user: Me }>('POST', '/api/login', { username, password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/logout', {}),
  checkin: () => request<{ user: Me }>('POST', '/api/checkin', {}),

  markets: (filter: string) => request<{ markets: Market[] }>('GET', `/api/markets?filter=${filter}`),
  market: (id: number) =>
    request<{ market: Market; trades: TradeRow[]; positions: Record<Outcome, Position> | null }>(
      'GET',
      `/api/markets/${id}`,
    ),
  history: (id: number) => request<{ points: { t: number; p: number }[] }>('GET', `/api/markets/${id}/history`),
  createMarket: (body: {
    title: string;
    description: string;
    rules: string;
    sourceUrl: string;
    closeAt: number;
    subsidy: number;
  }) => request<{ id: number }>('POST', '/api/markets', body),
  quote: (id: number, body: object) => request<{ quote: Quote }>('POST', `/api/markets/${id}/quote`, body),
  trade: (id: number, body: object) =>
    request<{ quote: Quote; balance: number }>('POST', `/api/markets/${id}/trade`, body),
  propose: (id: number, outcome: Outcome, note: string) =>
    request<{ market: Market }>('POST', `/api/markets/${id}/propose`, { outcome, note }),
  resolve: (id: number, outcome: Outcome, note: string) =>
    request<{ market: Market }>('POST', `/api/markets/${id}/resolve`, { outcome, note }),
  cancel: (id: number, note: string) => request<{ market: Market }>('POST', `/api/markets/${id}/cancel`, { note }),
  pause: (id: number, paused: boolean) => request<{ market: Market }>('POST', `/api/markets/${id}/pause`, { paused }),
  halt: (halted: boolean) => request<{ tradingHalted: boolean }>('POST', '/api/admin/halt', { halted }),
  liquidityQuote: (id: number, amount: number) =>
    request<{ quote: LiquidityQuote }>('POST', `/api/markets/${id}/liquidity/quote`, { amount }),
  addLiquidity: (id: number, amount: number, maxDeposit: number) =>
    request<{ quote: LiquidityQuote; market: Market }>('POST', `/api/markets/${id}/liquidity`, { amount, maxDeposit }),

  portfolio: () => request<{ positions: PortfolioItem[]; ledger: LedgerRow[] }>('GET', '/api/portfolio'),
  leaderboard: () => request<{ leaderboard: LeaderRow[] }>('GET', '/api/leaderboard'),
};

// --- formatting -------------------------------------------------------------

/** Units -> points string, up to 2 decimals. */
export function pts(units: number): string {
  const v = units / SCALE;
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

export function toUnits(points: number): number {
  return Math.round(points * SCALE);
}

export function pct(p: number): string {
  const v = p * 100;
  if (v > 0 && v < 1) return '<1%';
  if (v < 100 && v > 99) return '>99%';
  return `${Math.round(v)}%`;
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relative(ms: number, now = Date.now()): string {
  const d = ms - now;
  const abs = Math.abs(d);
  const unit =
    abs < 3600_000
      ? `${Math.max(1, Math.round(abs / 60_000))} 分钟`
      : abs < 86400_000
        ? `${Math.round(abs / 3600_000)} 小时`
        : `${Math.round(abs / 86400_000)} 天`;
  return d >= 0 ? `${unit}后` : `${unit}前`;
}

export const STATUS_LABEL: Record<MarketStatus, string> = {
  OPEN: '交易中',
  CLOSED: '待判定',
  PROPOSED: '公示中',
  RESOLVED: '已结算',
  CANCELLED: '已作废',
};

export const OUTCOME_LABEL: Record<Outcome, string> = { YES: '是', NO: '否' };

export const REASON_LABEL: Record<string, string> = {
  signup: '注册奖励',
  checkin: '每日签到',
  trade: '交易',
  subsidy: '创建市场补贴',
  payout: '结算兑付',
  subsidy_return: '补贴返还',
  cancel_refund: '作废退款',
  house_mint: '平台注资',
};
