import { SCALE } from './market/lmsr.js';

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Directory of the built frontend (served as static files), or '' to disable. */
  webDir: string;
  cookieSecure: boolean;
  /** Usernames that are granted the admin role on registration/startup. */
  adminUsernames: string[];
  /** Points granted on signup / daily check-in, in units. */
  signupBonus: number;
  checkinBonus: number;
  /** Minutes offset from UTC that defines the "day" for check-ins (480 = UTC+8). */
  dayOffsetMinutes: number;
  /** Subsidy limits for market creation, in units. */
  minSubsidy: number;
  maxSubsidy: number;
  /** Liquidity the platform adds to every new market on top of the creator's subsidy. */
  houseSubsidy: number;
  /** Trading fee in basis points of the LMSR amount (200 = 2%), paid into the pool. */
  feeBps: number;
  /** Per-user, per-side share cap as a multiple of b (0 = no cap). */
  positionCapB: number;
  /** How long a creator's proposed resolution can be overridden by an admin. */
  disputeWindowMs: number;
  sessionTtlMs: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: int('PORT', 8090),
    dbPath: process.env.DB_PATH ?? 'data/app.db',
    webDir: process.env.WEB_DIR ?? '',
    cookieSecure: process.env.COOKIE_SECURE === '1',
    adminUsernames: (process.env.ADMIN_USERNAMES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    signupBonus: int('SIGNUP_BONUS', 1000) * SCALE,
    checkinBonus: int('CHECKIN_BONUS', 100) * SCALE,
    dayOffsetMinutes: int('DAY_OFFSET_MINUTES', 480),
    minSubsidy: int('MIN_SUBSIDY', 50) * SCALE,
    maxSubsidy: int('MAX_SUBSIDY', 2000) * SCALE,
    houseSubsidy: int('HOUSE_SUBSIDY', 500) * SCALE,
    feeBps: int('TRADE_FEE_BPS', 200),
    positionCapB: int('POSITION_CAP_B', 2),
    disputeWindowMs: int('DISPUTE_WINDOW_HOURS', 24) * 3600_000,
    sessionTtlMs: int('SESSION_TTL_DAYS', 30) * 86400_000,
    ...overrides,
  };
}
