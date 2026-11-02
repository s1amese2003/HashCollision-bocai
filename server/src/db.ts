import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/**
 * Schema migrations, applied in order. Index + 1 is stored in PRAGMA user_version.
 * Never edit an existing entry once deployed; append a new one instead.
 *
 * All point / share amounts are integers in units (1 point = 1000 units).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id               INTEGER PRIMARY KEY,
    username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash    TEXT NOT NULL,
    role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    balance          INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    last_checkin_day TEXT,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Append-only journal. SUM(delta) per user must always equal users.balance.
  CREATE TABLE ledger (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    delta         INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    ref_id        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    UNIQUE (user_id, reason, ref_id)
  );

  CREATE TABLE markets (
    id               INTEGER PRIMARY KEY,
    creator_id       INTEGER NOT NULL REFERENCES users(id),
    title            TEXT NOT NULL,
    description      TEXT NOT NULL,
    rules            TEXT NOT NULL,
    source_url       TEXT,
    b                INTEGER NOT NULL,
    q_yes            INTEGER NOT NULL DEFAULT 0,
    q_no             INTEGER NOT NULL DEFAULT 0,
    subsidy          INTEGER NOT NULL,
    -- Points held by the market: subsidy + buys - sells - payouts.
    pool             INTEGER NOT NULL CHECK (pool >= 0),
    volume           INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL
                     CHECK (status IN ('OPEN', 'CLOSED', 'PROPOSED', 'RESOLVED', 'CANCELLED')),
    close_at         INTEGER NOT NULL,
    proposed_outcome TEXT CHECK (proposed_outcome IN ('YES', 'NO')),
    proposed_at      INTEGER,
    proposal_note    TEXT,
    resolution       TEXT CHECK (resolution IN ('YES', 'NO')),
    resolved_by      INTEGER REFERENCES users(id),
    resolved_at      INTEGER,
    resolution_note  TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX markets_status ON markets(status, close_at);

  CREATE TABLE positions (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    market_id  INTEGER NOT NULL REFERENCES markets(id),
    outcome    TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
    shares     INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
    cost_basis INTEGER NOT NULL DEFAULT 0 CHECK (cost_basis >= 0),
    PRIMARY KEY (user_id, market_id, outcome)
  );
  CREATE INDEX positions_market ON positions(market_id);

  CREATE TABLE trades (
    id           INTEGER PRIMARY KEY,
    market_id    INTEGER NOT NULL REFERENCES markets(id),
    user_id      INTEGER NOT NULL REFERENCES users(id),
    outcome      TEXT NOT NULL CHECK (outcome IN ('YES', 'NO')),
    side         TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    shares       INTEGER NOT NULL,
    amount       INTEGER NOT NULL,
    price_before REAL NOT NULL,
    price_after  REAL NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX trades_market ON trades(market_id, id);
  CREATE INDEX trades_user ON trades(user_id, id);
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
