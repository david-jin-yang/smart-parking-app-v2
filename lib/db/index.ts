// lib/db/index.ts

import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

let db: Database.Database | null = null

export default function getDb() {
  if (db) return db

  const dataDir = path.join(process.cwd(), 'data')
  const dbPath  = path.join(dataDir, 'parkflow.db')

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const hasUsers = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`)
    .get()

  if (!hasUsers) {
    console.log('📦 Initializing database schema...')
    const schemaPath = path.join(process.cwd(), 'lib/db/schema.sql')
    if (!fs.existsSync(schemaPath)) throw new Error('schema.sql not found')
    db.exec(fs.readFileSync(schemaPath, 'utf8'))
    console.log('✅ Schema applied')
  }

  // ── Additive migrations — safe to run every startup ──────────────────────
  const migrations = [
    // spots
    `ALTER TABLE spots ADD COLUMN proximity_score REAL NOT NULL DEFAULT 0`,
    // users
    `ALTER TABLE users ADD COLUMN home_lat REAL`,
    `ALTER TABLE users ADD COLUMN home_lng REAL`,
    `ALTER TABLE users ADD COLUMN is_handicap INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN is_ev_driver INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'type1_active'`,
    // sessions
    `ALTER TABLE sessions ADD COLUMN priority TEXT DEFAULT 'type1_active'`,
    `ALTER TABLE sessions ADD COLUMN home_distance_miles REAL`,
    `ALTER TABLE sessions ADD COLUMN drive_time_minutes REAL`,
    `ALTER TABLE sessions ADD COLUMN charge_purpose INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sessions ADD COLUMN queued_at_minute INTEGER`,
    // metrics
    `ALTER TABLE metrics_aggregate ADD COLUMN app_session_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN non_app_session_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN sum_non_app_search_minutes REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN non_app_search_histogram TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE metrics_aggregate ADD COLUMN type1_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN type2_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN sum_type1_tts_ms REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN sum_type2_wait_ms REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN ev_charge_trips INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN ev_charge_turned_away INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN handicap_trips INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE metrics_aggregate ADD COLUMN handicap_overflow INTEGER NOT NULL DEFAULT 0`,
    // parking queue
    `CREATE TABLE IF NOT EXISTS parking_queue (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id                  TEXT NOT NULL,
      user_id                  TEXT NOT NULL,
      lot_id                   TEXT NOT NULL,
      priority                 TEXT NOT NULL DEFAULT 'type1_active',
      estimated_arrival_minute INTEGER NOT NULL,
      drive_time_minutes       REAL NOT NULL,
      home_distance_miles      REAL NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'queued',
      created_at_minute        INTEGER NOT NULL,
      assigned_at_minute       INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_queue_status ON parking_queue(status, lot_id)`,
    `CREATE INDEX IF NOT EXISTS idx_queue_arrival ON parking_queue(estimated_arrival_minute)`,
  ]

  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* already exists */ }
  }

  return db
}
