/**
 * scripts/seed.ts
 * Run: npm run seed
 *
 * Generates:
 * - 3 lots with proximity-scored spots (960 total)
 * - 5,000 synthetic users with full trait profiles
 *   (age, gender, user_type, home coords, is_handicap, is_ev_driver)
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

// ── Config ───────────────────────────────────────────────────────────────────

const DB_PATH = process.env.SQLITE_DB_PATH ?? './data/parkflow.db'
const resolved = path.resolve(process.cwd(), DB_PATH)
const schemaPath = path.resolve(process.cwd(), 'schema.sql')

const USER_COUNT = 5000
const NOW = Math.floor(Date.now() / 1000)

// ── Lot definitions ──────────────────────────────────────────────────────────

const LOTS = [
  {
    id: 'lot_century_city',
    name: 'Century City',
    address: '10250 Santa Monica Blvd, Los Angeles, CA 90067',
    lat: 34.0559,
    lng: -118.4155,
  },
  {
    id: 'lot_glendale_galleria',
    name: 'Glendale Galleria',
    address: '100 W Broadway, Glendale, CA 91210',
    lat: 34.1473,
    lng: -118.2559,
  },
  {
    id: 'lot_old_town_pasadena',
    name: 'Old Town Pasadena',
    address: '280 E Colorado Blvd, Pasadena, CA 91101',
    lat: 34.1478,
    lng: -118.1445,
  },
]

const LOT_DEFAULTS = {
  floors: 4,
  rows_per_floor: 8,
  spots_per_row: 10,
  hourly_rate: 3.0,
  surcharge_rate: 5.0,
  grace_minutes: 10,
  eta_threshold_min: 8,
}

// ── Demographics ─────────────────────────────────────────────────────────────

const AGE_RANGES = ['16-24', '25-34', '35-44', '45-54', '55-64', '65-80']
const AGE_WEIGHTS = [0.12, 0.25, 0.22, 0.18, 0.13, 0.10]

const GENDERS = ['male', 'female', 'non_binary', 'prefer_not_to_say', null]
const GENDER_WEIGHTS = [0.42, 0.42, 0.05, 0.06, 0.05]

// ── LA metro bounding box ────────────────────────────────────────────────────

const LA_CENTER_LAT = 34.05
const LA_CENTER_LNG = -118.25
const LA_STD_LAT    = 0.18   // ~12 miles N/S spread
const LA_STD_LNG    = 0.22   // ~15 miles E/W spread
const LA_MIN_LAT    = 33.70
const LA_MAX_LAT    = 34.35
const LA_MIN_LNG    = -118.70
const LA_MAX_LNG    = -117.90

// ── Proximity score formula ───────────────────────────────────────────────────
//
// Entrance = top-left corner (car entrance: row 1, pos 1)
// Best spot = right-wall center (mall entrance: row 4-5, pos 10)
//
// score = floor_penalty + distance_penalty
// Lower score = better spot, assigned first
//
// Arc boundaries per floor (arc spans from ARC_START[f] to pos 10):
//   Floor 1 → p6-p10   (arc covers 50% of row)
//   Floor 2 → p7-p10   (arc covers 40%)
//   Floor 3 → p9-p10   (arc covers 20%, trapezoid)
//   Floor 4 → p10 only  (2 center spots only)

const ARC_START: Record<number, number> = { 1: 6, 2: 7, 3: 9, 4: 10 }

const ARC_WEIGHTS: Record<number, number> = {
  1: 0.50,  // position matters a lot on floor 1
  2: 0.30,  // less on floor 2
  3: 0.12,  // barely on floor 3
  4: 0.04,  // nearly irrelevant on floor 4
}

function floorPenalty(floor: number): number {
  return Math.pow(floor - 1, 2.5) * 0.50
}

function proximityScore(floor: number, row: number, pos: number): number {
  const row_dist = Math.abs(row - 4.5) / 3.5   // 0 at center rows, 1 at corners
  const pos_dist = Math.abs(pos - 10) / 9       // 0 at pos10, 1 at pos1

  const w          = ARC_WEIGHTS[floor]
  const arc_start  = ARC_START[floor]
  const inside_arc = pos >= arc_start &&
    (floor < 4 || (row >= 4 && row <= 5))

  const dist_penalty = inside_arc
    ? (row_dist * 0.6 + pos_dist * 0.4) * w
    : (row_dist * 0.6 + pos_dist * 0.4) * w
      + (arc_start - Math.min(pos, arc_start)) * 0.20

  return Math.round((floorPenalty(floor) + dist_penalty) * 1000) / 1000
}

// ── Spot type determination ───────────────────────────────────────────────────
//
// Floor 1 special zones:
//   HC  (handicap): p9-p10, r1-r3  → 6 spots
//   EV  (electric):  p7-p8,  r1-r3  → 6 spots
//   All other floors: standard only

function spotType(floor: number, row: number, pos: number): string {
  if (floor === 1) {
    if (row <= 3 && pos >= 9) return 'ada'   // handicap
    if (row <= 3 && pos >= 7) return 'ev'    // electric vehicle
  }
  return 'standard'
}

// ── Seeded RNG (simple mulberry32) ───────────────────────────────────────────

let rngState = 12345

function rngNext(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function rngGaussian(mean: number, std: number, min: number, max: number): number {
  const u1 = Math.max(1e-10, rngNext())
  const u2 = rngNext()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(min, Math.min(max, mean + z * std))
}

function weightedPick<T>(items: T[], weights: number[]): T {
  const r = rngNext()
  let cumulative = 0
  for (let i = 0; i < items.length; i++) {
    cumulative += weights[i]
    if (r < cumulative) return items[i]
  }
  return items[items.length - 1]
}

// ── Main ─────────────────────────────────────────────────────────────────────

const dataDir = path.dirname(resolved)
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

console.log(`[seed] DB: ${resolved}`)

const db = new Database(resolved)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const schema = fs.readFileSync(schemaPath, 'utf-8')
db.exec(schema)
console.log('[seed] Schema applied')

// ── Migrations for new columns ────────────────────────────────────────────────

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
  // parking queue table
  `CREATE TABLE IF NOT EXISTS parking_queue (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id                TEXT NOT NULL,
    user_id                TEXT NOT NULL,
    lot_id                 TEXT NOT NULL,
    priority               TEXT NOT NULL DEFAULT 'type1_active',
    estimated_arrival_minute INTEGER NOT NULL,
    drive_time_minutes     REAL NOT NULL,
    home_distance_miles    REAL NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'queued',
    created_at_minute      INTEGER NOT NULL,
    assigned_at_minute     INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_status ON parking_queue(status, lot_id)`,
  `CREATE INDEX IF NOT EXISTS idx_queue_arrival ON parking_queue(estimated_arrival_minute)`,
]

for (const sql of migrations) {
  try { db.exec(sql) } catch { /* column/table already exists */ }
}
console.log('[seed] Migrations applied')

// ── Prepared statements ───────────────────────────────────────────────────────

const insertLot = db.prepare(`
  INSERT OR IGNORE INTO lots
    (id, name, address, lat, lng, floors, rows_per_floor, spots_per_row,
     hourly_rate, surcharge_rate, grace_minutes, eta_threshold_min)
  VALUES
    (@id, @name, @address, @lat, @lng, @floors, @rows_per_floor, @spots_per_row,
     @hourly_rate, @surcharge_rate, @grace_minutes, @eta_threshold_min)
`)

// Use INSERT OR REPLACE so re-seeding updates proximity_score
const insertSpot = db.prepare(`
  INSERT OR REPLACE INTO spots (id, lot_id, floor, row, position, spot_type, status, proximity_score)
  VALUES (@id, @lot_id, @floor, @row, @position, @spot_type, @status, @proximity_score)
`)

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users
    (id, display_name, age_range, gender, is_synthetic, created_at,
     home_lat, home_lng, is_handicap, is_ev_driver, user_type)
  VALUES
    (@id, @display_name, @age_range, @gender, 1, @created_at,
     @home_lat, @home_lng, @is_handicap, @is_ev_driver, @user_type)
`)

// ── Single transaction ────────────────────────────────────────────────────────

const seedAll = db.transaction(() => {
  // 1. Lots
  for (const lot of LOTS) {
    insertLot.run({ ...lot, ...LOT_DEFAULTS })
  }
  console.log(`[seed] ✓ ${LOTS.length} lots`)

  // 2. Spots — 3 lots × 4 floors × 8 rows × 10 spots = 960 total
  let spotCount = 0
  for (const lot of LOTS) {
    const prefix = lot.id.replace('lot_', '')
    for (let f = 1; f <= LOT_DEFAULTS.floors; f++) {
      for (let r = 1; r <= LOT_DEFAULTS.rows_per_floor; r++) {
        for (let p = 1; p <= LOT_DEFAULTS.spots_per_row; p++) {
          const type  = spotType(f, r, p)
          const score = proximityScore(f, r, p)
          insertSpot.run({
            id: `${prefix}_F${f}_R${r}_S${String(p).padStart(2, '0')}`,
            lot_id: lot.id,
            floor: f,
            row: r,
            position: p,
            spot_type: type,
            status: 'available',
            proximity_score: score,
          })
          spotCount++
        }
      }
    }
  }
  console.log(`[seed] ✓ ${spotCount} spots (with proximity scores)`)

  // 3. Users — 5,000 synthetic users
  //
  // Trait probabilities:
  //   user_type:   type1_active 70% / type2_passive 30%
  //   is_handicap: 3.2%  (~160 users)
  //   is_ev_driver: 15%  (~750 users)
  //   home coords: gaussian around LA center, clamped to metro bbox

  let type1Count = 0, type2Count = 0, hcCount = 0, evCount = 0

  for (let i = 1; i <= USER_COUNT; i++) {
    const id        = `user_${String(i).padStart(6, '0')}`
    const age_range = weightedPick(AGE_RANGES, AGE_WEIGHTS)
    const gender    = weightedPick(GENDERS, GENDER_WEIGHTS)
    const user_type = rngNext() < 0.70 ? 'type1_active' : 'type2_passive'
    const is_handicap  = rngNext() < 0.032 ? 1 : 0
    const is_ev_driver = rngNext() < 0.15  ? 1 : 0

    const home_lat = rngGaussian(LA_CENTER_LAT, LA_STD_LAT, LA_MIN_LAT, LA_MAX_LAT)
    const home_lng = rngGaussian(LA_CENTER_LNG, LA_STD_LNG, LA_MIN_LNG, LA_MAX_LNG)

    if (user_type === 'type1_active') type1Count++
    else type2Count++
    if (is_handicap)  hcCount++
    if (is_ev_driver) evCount++

    insertUser.run({
      id,
      display_name: `Parking User ${i}`,
      age_range,
      gender,
      created_at: NOW,
      home_lat:     Math.round(home_lat * 100000) / 100000,
      home_lng:     Math.round(home_lng * 100000) / 100000,
      is_handicap,
      is_ev_driver,
      user_type,
    })
  }

  console.log(`[seed] ✓ ${USER_COUNT} users`)
  console.log(`[seed]   Type1 active:  ${type1Count} (${Math.round(type1Count/USER_COUNT*100)}%)`)
  console.log(`[seed]   Type2 passive: ${type2Count} (${Math.round(type2Count/USER_COUNT*100)}%)`)
  console.log(`[seed]   Handicap:      ${hcCount}    (${Math.round(hcCount/USER_COUNT*100)}%)`)
  console.log(`[seed]   EV drivers:    ${evCount}    (${Math.round(evCount/USER_COUNT*100)}%)`)
})

const start = Date.now()
seedAll()
const elapsed = Date.now() - start
console.log(`[seed] ✅ Complete in ${elapsed}ms`)
db.close()
