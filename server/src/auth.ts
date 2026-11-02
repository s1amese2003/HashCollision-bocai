import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { badRequest, conflict, unauthorized } from './errors.js';
import { applyDelta } from './ledger.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(key, expected);
}

export interface User {
  id: number;
  username: string;
  role: 'user' | 'admin';
  balance: number;
  last_checkin_day: string | null;
  created_at: number;
}

const USER_COLS = 'id, username, role, balance, last_checkin_day, created_at';

export function getUser(db: DB, id: number): User | undefined {
  return db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as User | undefined;
}

export async function register(
  db: DB,
  cfg: Config,
  username: string,
  password: string,
  now: number,
): Promise<User> {
  const hash = await hashPassword(password);
  const role = cfg.adminUsernames.includes(username.toLowerCase()) ? 'admin' : 'user';
  const id = db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) throw conflict('USERNAME_TAKEN', '用户名已被占用');
    const r = db
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(username, hash, role, now);
    const id = Number(r.lastInsertRowid);
    applyDelta(db, id, cfg.signupBonus, 'signup', 'signup', now);
    return id;
  })();
  return getUser(db, id)!;
}

export async function login(db: DB, username: string, password: string): Promise<User> {
  const row = db
    .prepare(`SELECT id, password_hash FROM users WHERE username = ?`)
    .get(username) as { id: number; password_hash: string } | undefined;
  // Always run scrypt so response time doesn't reveal whether the user exists.
  const ok = await verifyPassword(
    password,
    row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==',
  );
  if (!row || !ok) throw unauthorized('用户名或密码错误');
  return getUser(db, row.id)!;
}

export function createSession(db: DB, cfg: Config, userId: number, now: number): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    now + cfg.sessionTtlMs,
  );
  return token;
}

export function userFromSession(db: DB, token: string | undefined, now: number): User | undefined {
  if (!token) return undefined;
  const row = db
    .prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?')
    .get(token, now) as { user_id: number } | undefined;
  return row ? getUser(db, row.user_id) : undefined;
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions(db: DB, now: number): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

/** Calendar day string (YYYY-MM-DD) in the configured timezone offset. */
export function dayKey(cfg: Config, now: number): string {
  return new Date(now + cfg.dayOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function checkin(db: DB, cfg: Config, userId: number, now: number): User {
  const day = dayKey(cfg, now);
  db.transaction(() => {
    const u = getUser(db, userId)!;
    if (u.last_checkin_day === day) throw badRequest('ALREADY_CHECKED_IN', '今天已经签到过了');
    applyDelta(db, userId, cfg.checkinBonus, 'checkin', day, now);
    db.prepare('UPDATE users SET last_checkin_day = ? WHERE id = ?').run(day, userId);
  })();
  return getUser(db, userId)!;
}

/** Promote configured admin usernames that registered before being listed. */
export function syncAdmins(db: DB, cfg: Config): void {
  const stmt = db.prepare(`UPDATE users SET role = 'admin' WHERE username = ?`);
  for (const name of cfg.adminUsernames) stmt.run(name);
}
