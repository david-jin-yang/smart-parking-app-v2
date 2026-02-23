/**
 * lib/db/queries.ts
 * Typed query wrappers for common DB operations.
 * All functions accept a db instance so they can be called
 * inside transactions or standalone.
 */

import type Database from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string
  display_name: string
  age_range: string | null
  gender: string | null
  is_synthetic: number
  created_at: number
}

export interface Lot {
  id: string
  name: string
  address: string
  lat: number
  lng: number
  floors: number
  rows_per_floor: number
  spots_per_row: number
  hourly_rate: number
  surcharge_rate: number
  grace_minutes: number
  eta_threshold_min: number
}

export interface Spot {
  id: string
  lot_id: string
  floor: number
  row: number
  position: number
  spot_type: 'standard' | 'ada' | 'ev' | 'reserved'
  status: 'available' | 'occupied' | 'reserved' | 'maintenance'
}

export interface Session {
  id: string
  user_id: string
  lot_id: string
  spot_id: string | null
  state: SessionState
  created_at: number
  assigned_at: number | null
  arrived_lot_at: number | null
  parked_at: number | null
  timer_end_at: number | null
  timer_ended_at: number | null
  grace_end_at: number | null
  exiting_at: number | null
  closed_at: number | null
  booked_minutes: number
  actual_minutes: number | null
  base_charge: number | null
  surcharge: number
  total_charge: number | null
  is_synthetic: number
  assignment_latency_ms: number | null
}

export type SessionState =
  | 'CREATED'
  | 'ASSIGNED'
  | 'ARRIVED_LOT'
  | 'PARKED'
  | 'TIMER_ENDED'
  | 'EXITING'
  | 'CLOSED'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'ABANDONED'

export interface DbEvent {
  id: number
  session_id: string | null
  user_id: string | null
  lot_id: string | null
  event_type: string
  payload: string | null
  sim_minute: number | null
  ts: number
}

export interface MetricsAggregate {
  id: number
  date: string
  hour_bucket: number
  lot_id: string
  age_range: string
  gender: string
  session_count: number
  parked_count: number
  conflict_count: number
  abandon_count: number
  overstay_count: number
  sum_time_to_spot_ms: number
  sum_dwell_minutes: number
  sum_surcharge: number
  sum_revenue: number
  tts_histogram: string
  dwell_histogram: string
}

// ── User queries ─────────────────────────────────────────────────────────────

export function getUserById(db: Database.Database, id: string): User | null {
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User) ?? null
}

export function getUsers(
  db: Database.Database,
  limit = 50,
  offset = 0
): User[] {
  return db
    .prepare('SELECT * FROM users ORDER BY id LIMIT ? OFFSET ?')
    .all(limit, offset) as User[]
}

export function getUserCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
  return row.n
}

// ── Lot queries ──────────────────────────────────────────────────────────────

export function getLots(db: Database.Database): Lot[] {
  return db.prepare('SELECT * FROM lots').all() as Lot[]
}

export function getLotById(db: Database.Database, id: string): Lot | null {
  return (db.prepare('SELECT * FROM lots WHERE id = ?').get(id) as Lot) ?? null
}

export function getLotOccupancy(
  db: Database.Database,
  lotId: string
): { total: number; occupied: number; available: number; reserved: number } {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) as reserved
       FROM spots
       WHERE lot_id = ? AND spot_type != 'ada'`
    )
    .get(lotId) as { total: number; occupied: number; available: number; reserved: number }
  return row
}

// ── Spot queries ─────────────────────────────────────────────────────────────

export function getSpotsByLot(db: Database.Database, lotId: string): Spot[] {
  return db
    .prepare('SELECT * FROM spots WHERE lot_id = ? ORDER BY floor, row, position')
    .all(lotId) as Spot[]
}

export function getAvailableSpots(
  db: Database.Database,
  lotId: string,
  limit = 1
): Spot[] {
  return db
    .prepare(
      `SELECT * FROM spots
       WHERE lot_id = ? AND status = 'available' AND spot_type = 'standard'
       ORDER BY floor ASC, row ASC, position ASC
       LIMIT ?`
    )
    .all(lotId, limit) as Spot[]
}

export function setSpotStatus(
  db: Database.Database,
  spotId: string,
  status: Spot['status']
): void {
  db.prepare("UPDATE spots SET status = ? WHERE id = ?").run(status, spotId)
}

// ── Session queries ──────────────────────────────────────────────────────────

export function getSessionById(
  db: Database.Database,
  id: string
): Session | null {
  return (
    (db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session) ??
    null
  )
}

export function getActiveSessionForUser(
  db: Database.Database,
  userId: string
): Session | null {
  return (
    db
      .prepare(
        `SELECT * FROM sessions
         WHERE user_id = ? AND state NOT IN ('CLOSED','CANCELLED','ABANDONED')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId) as Session
  ) ?? null
}

export function updateSessionState(
  db: Database.Database,
  sessionId: string,
  state: SessionState,
  extra: Partial<Session> = {}
): void {
  const fields: string[] = ['state = @state']
  const params: Record<string, unknown> = { id: sessionId, state }

  for (const [k, v] of Object.entries(extra)) {
    fields.push(`${k} = @${k}`)
    params[k] = v
  }

  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`).run(params)
}

// ── Event logging ────────────────────────────────────────────────────────────

export function logEvent(
  db: Database.Database,
  event: Omit<DbEvent, 'id'>
): void {
  db.prepare(
    `INSERT INTO events (session_id, user_id, lot_id, event_type, payload, sim_minute, ts)
     VALUES (@session_id, @user_id, @lot_id, @event_type, @payload, @sim_minute, @ts)`
  ).run(event)
}

export function getRecentEvents(
  db: Database.Database,
  limit = 100,
  lotId?: string
): DbEvent[] {
  if (lotId) {
    return db
      .prepare(
        'SELECT * FROM events WHERE lot_id = ? ORDER BY id DESC LIMIT ?'
      )
      .all(lotId, limit) as DbEvent[]
  }
  return db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit) as DbEvent[]
}

// ── Metrics aggregates ────────────────────────────────────────────────────────

export function upsertAggregate(
  db: Database.Database,
  key: Pick<MetricsAggregate, 'date' | 'hour_bucket' | 'lot_id' | 'age_range' | 'gender'>,
  increments: {
    session_count?: number
    parked_count?: number
    conflict_count?: number
    abandon_count?: number
    overstay_count?: number
    sum_time_to_spot_ms?: number
    sum_dwell_minutes?: number
    sum_surcharge?: number
    sum_revenue?: number
  }
): void {
  // Insert row if missing
  db.prepare(
    `INSERT OR IGNORE INTO metrics_aggregate
       (date, hour_bucket, lot_id, age_range, gender)
     VALUES (@date, @hour_bucket, @lot_id, @age_range, @gender)`
  ).run(key)

  // Build incremental update
  const updates: string[] = []
  const params: Record<string, unknown> = { ...key }

  for (const [field, delta] of Object.entries(increments)) {
    if (delta !== undefined && delta !== 0) {
      updates.push(`${field} = ${field} + @${field}`)
      params[field] = delta
    }
  }

  if (updates.length > 0) {
    db.prepare(
      `UPDATE metrics_aggregate SET ${updates.join(', ')}
       WHERE date = @date AND hour_bucket = @hour_bucket
         AND lot_id = @lot_id AND age_range = @age_range AND gender = @gender`
    ).run(params)
  }
}

export function getAggregates(
  db: Database.Database,
  filters: { date?: string; lot_id?: string; age_range?: string; gender?: string }
): MetricsAggregate[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (filters.date) { where.push('date = @date'); params.date = filters.date }
  if (filters.lot_id) { where.push('lot_id = @lot_id'); params.lot_id = filters.lot_id }
  if (filters.age_range) { where.push('age_range = @age_range'); params.age_range = filters.age_range }
  if (filters.gender) { where.push('gender = @gender'); params.gender = filters.gender }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .prepare(`SELECT * FROM metrics_aggregate ${clause} ORDER BY date, hour_bucket`)
    .all(params) as MetricsAggregate[]
}
