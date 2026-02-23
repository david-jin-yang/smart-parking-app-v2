/**
 * lib/core/types.ts
 *
 * Single source of truth for all shared TypeScript types.
 * Fields mirror the SQLite schema column names exactly — no renaming.
 */

// ── Session state ─────────────────────────────────────────────────────────────

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

// Terminal states — no further transitions allowed
export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  'CLOSED',
  'CANCELLED',
  'ABANDONED',
])

// ── Domain types (mirror DB columns) ─────────────────────────────────────────

export interface User {
  id: string                     // 'user_000001'
  display_name: string
  age_range: string | null       // '25-34' | null
  gender: string | null          // 'male'|'female'|'non_binary'|'prefer_not_to_say'|null
  is_synthetic: number           // 1 = sim-generated
  created_at: number             // unix seconds (NOT NULL)
}

export interface Lot {
  id: string                     // 'lot_century_city'
  name: string
  address: string | null
  lat: number
  lng: number
  floors: number
  rows_per_floor: number
  spots_per_row: number
  hourly_rate: number
  surcharge_rate: number         // per 15-min interval over grace
  grace_minutes: number
  eta_threshold_min: number      // assign when ETA <= this (minutes)
}

export interface Spot {
  id: string                     // 'lot_cc_F1_R3_S07'
  lot_id: string
  floor: number
  row: number                    // column name is 'row' in schema
  position: number
  spot_type: SpotType
  status: SpotStatus
}

export type SpotType = 'standard' | 'ada' | 'ev' | 'reserved'
export type SpotStatus = 'available' | 'occupied' | 'reserved' | 'maintenance'

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
  timer_end_at: number | null      // parked_at + booked_minutes * 60
  timer_ended_at: number | null    // actual moment timer hit zero
  grace_end_at: number | null      // timer_end_at + grace_minutes * 60
  exiting_at: number | null
  closed_at: number | null
  booked_minutes: number           // default 120
  actual_minutes: number | null    // computed on exit
  base_charge: number | null
  surcharge: number                // default 0
  total_charge: number | null
  is_synthetic: number             // 0 = real user, 1 = sim
  assignment_latency_ms: number | null
}

// ── Session events (used by state machine) ────────────────────────────────────

export type SessionEventType =
  | 'ASSIGN'         // trigger: ETA threshold reached
  | 'ARRIVE_LOT'     // trigger: user confirms at lot entrance
  | 'PARK'           // trigger: user confirms at spot
  | 'TIMER_END'      // trigger: timer_end_at reached
  | 'EXIT'           // trigger: user taps exit (any post-PARKED state)
  | 'CANCEL'         // trigger: user cancels before PARKED
  | 'CONFLICT'       // trigger: spot was taken; reassign needed
  | 'ABANDON'        // trigger: no activity 30+ min in ARRIVED_LOT
  | 'REASSIGN'       // trigger: after CONFLICT, new spot found

export interface SessionEvent {
  type: SessionEventType
  ts: number                    // unix seconds
  spot_id?: string              // for ASSIGN / REASSIGN
  sim_minute?: number           // set by sim engine
}

// ── Charge calculation ────────────────────────────────────────────────────────

export interface ChargeInput {
  parked_at: number             // unix seconds
  exited_at: number             // unix seconds
  hourly_rate: number
  booked_minutes: number        // how long the session was booked for
  grace_minutes: number
  surcharge_rate: number        // $ per 15-min interval over grace
}

export interface ChargeBreakdown {
  dwell_minutes: number         // actual time parked (rounded up to nearest minute)
  over_minutes: number          // minutes past booked_minutes + grace
  base_charge: number           // ceil((dwell / 60) * hourly_rate, 2dp)
  surcharge: number             // floor(over_minutes / 15) * surcharge_rate
  total_charge: number
}

// ── Provider types ────────────────────────────────────────────────────────────

export interface LotOccupancy {
  lot_id: string
  total: number
  available: number
  occupied: number
  reserved: number
  occupancy_pct: number         // (occupied + reserved) / total
}

export interface LotLayout {
  lot: Lot
  floors: FloorLayout[]
}

export interface FloorLayout {
  floor: number
  rows: RowLayout[]
}

export interface RowLayout {
  row: number
  spots: Spot[]
}

export interface AssignSpotParams {
  lot_id: string
  user_id: string
  session_id: string
}

export interface AssignSpotResult {
  spot: Spot
  conflict_detected: boolean    // true if a previous reservation had to be cleared
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface MetricsAggregate {
  id: number
  date: string                  // 'YYYY-MM-DD'
  hour_bucket: number           // 0-23
  lot_id: string
  age_range: string             // bucketed or '__all__'
  gender: string                // or '__all__'
  session_count: number
  parked_count: number
  conflict_count: number
  abandon_count: number
  overstay_count: number
  sum_time_to_spot_ms: number
  sum_dwell_minutes: number
  sum_surcharge: number
  sum_revenue: number
  tts_histogram: string         // JSON: {"0":N,"30":N,...}
  dwell_histogram: string       // JSON: {"15":N,"30":N,...}
}

export interface SimRun {
  id: number
  seed: number
  speed_mult: number
  user_count: number
  non_app_pct: number
  conflict_pct: number
  event_mode: number
  sim_day_hours: number
  status: 'pending' | 'running' | 'paused' | 'complete' | 'error'
  sim_minute: number
  started_at: number | null
  paused_at: number | null
  ended_at: number | null
}

// ── DB event log ──────────────────────────────────────────────────────────────

export interface DbEvent {
  id: number
  session_id: string | null
  user_id: string | null
  lot_id: string | null
  event_type: string
  payload: string | null        // JSON blob
  sim_minute: number | null
  ts: number
}
