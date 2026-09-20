import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS publication_ledger (
  publication_id   TEXT PRIMARY KEY,
  channel          TEXT NOT NULL,
  account          TEXT,
  content_hash     TEXT NOT NULL,
  content_type     TEXT,
  source_evidence  TEXT,
  risk_class       TEXT NOT NULL,
  approval_state   TEXT NOT NULL,
  scheduled_at     TEXT,
  published_at     TEXT,
  external_id      TEXT,
  external_url     TEXT,
  campaign         TEXT,
  utm              TEXT,
  result           TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(channel, content_hash)
);

CREATE TABLE IF NOT EXISTS marketing_memory (
  content_id        TEXT PRIMARY KEY,
  channel           TEXT,
  campaign          TEXT,
  topic             TEXT,
  angle             TEXT,
  audience          TEXT,
  content_hash      TEXT,
  published_at      TEXT,
  url               TEXT,
  utm               TEXT,
  impressions       INTEGER,
  clicks            INTEGER,
  ctr               REAL,
  engagement        INTEGER,
  video_completion  REAL,
  landing_visits    INTEGER,
  checkout_starts   INTEGER,
  conversions       INTEGER,
  lesson            TEXT,
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
  run_id        TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  status        TEXT NOT NULL,
  mode          TEXT NOT NULL,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS operator_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  host        TEXT,
  started_at  TEXT NOT NULL
);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db) {
  db.close();
}
