/**
 * lib/sim/engine.ts
 *
 * Deterministic simulation engine.
 *
 * Design principles:
 * - NO setTimeout for departures — all events processed via the tick loop
 * - Departures tracked in a Map<sim_minute, Trip[]> built at trip generation time
 * - Speed multiplier = simulated minutes advanced per real second
 * - Spot assignments are atomic SQLite transactions (same as real sessions)
 * - Aggregates updated at session close, not at every tick
 * - SSE consumers subscribe via engine.on('event' | 'occupancy' | 'status')
 */

import { EventEmitter } from 'events'
import getDb from '../db'
import { generateTrips, type SyntheticTrip } from './trips'
import { recordSessionMetrics } from './aggregates'
import { computeCharges } from '../core/sessionMachine'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SimParams {
  seed: number
  speed_multiplier: number      // sim minutes per real second
  user_count: number
  sim_day_hours: number
  non_app_pct: number
  conflict_pct: number          // probability of a conflict per assignment
  event_mode: boolean           // 3x traffic
  eta_threshold_minutes: number
}

export interface SimStatus {
  run_id: number | null
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error'
  sim_minute: number
  sim_day_hours: number
  speed_multiplier: number
  trips_total: number
  trips_processed: number
  events_emitted: number
  occupancy: Record<string, number>  // lot_id → occupancy_pct
  started_at: number | null
  elapsed_real_ms: number
}

export interface SimEvent {
  type: string
  lot_id: string
  trip_id?: string
  user_id?: string
  spot_id?: string | null
  sim_minute: number
  ts: number
  payload?: Record<string, unknown>
}

export interface OccupancySnapshot {
  sim_minute: number
  lots: Record<string, { total: number; available: number; occupied: number; reserved: number; pct: number }>
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_PARAMS: SimParams = {
  seed: 42,
  speed_multiplier: 60,
  user_count: 5000,
  sim_day_hours: 14,
  non_app_pct: 0.15,
  conflict_pct: 0.03,
  event_mode: false,
  eta_threshold_minutes: 8,
}

// ── Engine singleton ──────────────────────────────────────────────────────────

class SimEngine extends EventEmitter {
  private status: SimStatus['status'] = 'idle'
  private sim_minute = 0
  private run_id: number | null = null
  private tick_interval: ReturnType<typeof setInterval> | null = null
  private params: SimParams = DEFAULT_PARAMS

  // Trip state
  private trips: SyntheticTrip[] = []
  private arrival_cursor = 0       // index into sorted trips array
  private departure_map = new Map<number, SyntheticTrip[]>()
  private active_trips = new Map<string, { trip: SyntheticTrip; spot_id: string }>()

  // Counters
  private events_emitted = 0
  private trips_processed = 0
  private started_at: number | null = null

  // Sim date (used for aggregate keys) — set at start
  private sim_date = ''
  private sim_start_hour = 8  // 8am

  // ── Public API ──────────────────────────────────────────────────────────────

  start(params: Partial<SimParams> = {}): number {
    if (this.status === 'running') {
      throw new Error('Simulation already running. Pause or reset first.')
    }

    this.params = { ...DEFAULT_PARAMS, ...params }
    this.sim_date = new Date().toISOString().split('T')[0]

    if (this.status !== 'paused') {
      // Fresh start — generate trips and reset state
      this._reset_state()
      this.trips = generateTrips({
        seed: this.params.seed,
        user_count: this.params.user_count,
        sim_day_hours: this.params.sim_day_hours,
        non_app_pct: this.params.non_app_pct,
        eta_threshold_minutes: this.params.eta_threshold_minutes,
        event_mode: this.params.event_mode,
      })
      this._build_departure_map()

      // Create DB run record
      const db = getDb()
      const result = db.prepare(
        `INSERT INTO sim_runs
           (seed, speed_mult, user_count, non_app_pct, conflict_pct, event_mode,
            sim_day_hours, status, sim_minute, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)`
      ).run(
        this.params.seed, this.params.speed_multiplier, this.params.user_count,
        this.params.non_app_pct, this.params.conflict_pct, this.params.event_mode ? 1 : 0,
        this.params.sim_day_hours, Math.floor(Date.now() / 1000)
      )
      this.run_id = result.lastInsertRowid as number
    } else {
      // Resume — update DB status
      if (this.run_id) {
        getDb().prepare(`UPDATE sim_runs SET status = 'running', paused_at = NULL WHERE id = ?`)
          .run(this.run_id)
      }
    }

    this.status = 'running'
    this.started_at = this.started_at ?? Date.now()

    // Tick every 1 real second, advance speed_multiplier sim minutes per tick
    const tickMs = 1000
    this.tick_interval = setInterval(() => {
      for (let i = 0; i < this.params.speed_multiplier; i++) {
        this._tick()
        if (this.status !== 'running') {
          this._stop_interval()
          return
        }
      }
      // Emit occupancy snapshot every 5 sim-minutes
      if (this.sim_minute % 5 === 0) {
        this._emit_occupancy()
      }
    }, tickMs)

    this._emit_status()
    return this.run_id!
  }

  pause(): void {
    if (this.status !== 'running') return
    this._stop_interval()
    this.status = 'paused'
    if (this.run_id) {
      getDb().prepare(`UPDATE sim_runs SET status = 'paused', paused_at = ? WHERE id = ?`)
        .run(Math.floor(Date.now() / 1000), this.run_id)
    }
    this._emit_status()
  }

  reset(): void {
    this._stop_interval()
    this._reset_spots()
    this._reset_state()
    this.status = 'idle'
    this.run_id = null
    this._emit_status()
  }

  getStatus(): SimStatus {
    return {
      run_id: this.run_id,
      status: this.status,
      sim_minute: this.sim_minute,
      sim_day_hours: this.params.sim_day_hours,
      speed_multiplier: this.params.speed_multiplier,
      trips_total: this.trips.length,
      trips_processed: this.trips_processed,
      events_emitted: this.events_emitted,
      occupancy: this._get_occupancy_map(),
      started_at: this.started_at,
      elapsed_real_ms: this.started_at ? Date.now() - this.started_at : 0,
    }
  }

  // ── Core tick ───────────────────────────────────────────────────────────────

  private _tick(): void {
    const total_minutes = this.params.sim_day_hours * 60

    if (this.sim_minute >= total_minutes) {
      this._complete()
      return
    }

    // Process arrivals — ETA trigger fires eta_threshold_minutes before arrival
    while (
      this.arrival_cursor < this.trips.length &&
      this.trips[this.arrival_cursor].eta_trigger_minute <= this.sim_minute
    ) {
      const trip = this.trips[this.arrival_cursor++]
      this._process_arrival(trip)
    }

    // Process departures for this sim minute
    const departures = this.departure_map.get(this.sim_minute)
    if (departures) {
      for (const trip of departures) {
        this._process_departure(trip)
      }
    }

    this.sim_minute++

    // Persist sim_minute progress every 30 sim-minutes
    if (this.sim_minute % 30 === 0 && this.run_id) {
      getDb().prepare(`UPDATE sim_runs SET sim_minute = ? WHERE id = ?`)
        .run(this.sim_minute, this.run_id)
    }
  }

  // ── Arrival processing ───────────────────────────────────────────────────────

  private _process_arrival(trip: SyntheticTrip): void {
    if (trip.is_non_app_user) {
      // Non-app users just occupy a spot directly (no reservation flow)
      this._emit_event({
        type: 'NON_APP_ARRIVAL',
        lot_id: trip.lot_id,
        trip_id: trip.id,
        sim_minute: this.sim_minute,
        ts: Date.now(),
      })
      return
    }

    const db = getDb()

    // Attempt atomic spot assignment
    const assignment = db.transaction((): { spot_id: string; conflict: boolean } | null => {
      const spot = db.prepare(
        `SELECT id FROM spots
         WHERE lot_id = ? AND status = 'available' AND spot_type IN ('standard', 'ev')
         ORDER BY floor ASC, row ASC, position ASC
         LIMIT 1`
      ).get(trip.lot_id) as { id: string } | undefined

      if (!spot) return null

      // Simulate conflict — random chance spot is "stolen" before reservation
      const conflict = Math.random() < this.params.conflict_pct
      if (conflict) {
        // Find a different spot
        const fallback = db.prepare(
          `SELECT id FROM spots
           WHERE lot_id = ? AND status = 'available' AND spot_type IN ('standard', 'ev')
             AND id != ?
           ORDER BY floor ASC, row ASC, position ASC
           LIMIT 1`
        ).get(trip.lot_id, spot.id) as { id: string } | undefined

        if (!fallback) return null

        db.prepare(`UPDATE spots SET status = 'reserved' WHERE id = ?`).run(fallback.id)
        return { spot_id: fallback.id, conflict: true }
      }

      db.prepare(`UPDATE spots SET status = 'reserved' WHERE id = ?`).run(spot.id)
      return { spot_id: spot.id, conflict: false }
    })()

    if (!assignment) {
      this._emit_event({
        type: 'NO_SPOT',
        lot_id: trip.lot_id,
        trip_id: trip.id,
        user_id: trip.user_id,
        sim_minute: this.sim_minute,
        ts: Date.now(),
      })
      this.trips_processed++
      return
    }

    if (assignment.conflict) {
      this._emit_event({
        type: 'CONFLICT_RESOLVED',
        lot_id: trip.lot_id,
        trip_id: trip.id,
        spot_id: assignment.spot_id,
        sim_minute: this.sim_minute,
        ts: Date.now(),
      })
    }

    // Track active trip for departure
    this.active_trips.set(trip.id, { trip, spot_id: assignment.spot_id })

    this._emit_event({
      type: 'PARKED',
      lot_id: trip.lot_id,
      trip_id: trip.id,
      user_id: trip.user_id,
      spot_id: assignment.spot_id,
      sim_minute: this.sim_minute,
      ts: Date.now(),
      payload: {
        age_range: trip.age_range,
        dwell_minutes: trip.dwell_minutes,
        conflict: assignment.conflict,
      },
    })

    this.trips_processed++
  }

  // ── Departure processing ─────────────────────────────────────────────────────

  private _process_departure(trip: SyntheticTrip): void {
    const active = this.active_trips.get(trip.id)
    if (!active) return   // non-app user or failed assignment

    const db = getDb()
    db.prepare(
      `UPDATE spots SET status = 'available' WHERE id = ?`
    ).run(active.spot_id)

    this.active_trips.delete(trip.id)

    // Compute charges for aggregate
    const now_ts = Math.floor(Date.now() / 1000)
    const parked_ts = now_ts - trip.dwell_minutes * 60
    const lot = db.prepare(`SELECT hourly_rate, grace_minutes, surcharge_rate FROM lots WHERE id = ?`)
      .get(trip.lot_id) as { hourly_rate: number; grace_minutes: number; surcharge_rate: number } | undefined

    const charges = lot ? computeCharges({
      parked_at: parked_ts,
      exited_at: now_ts,
      hourly_rate: lot.hourly_rate,
      booked_minutes: 120,
      grace_minutes: lot.grace_minutes,
      surcharge_rate: lot.surcharge_rate,
    }) : { dwell_minutes: trip.dwell_minutes, over_minutes: 0, base_charge: 0, surcharge: 0, total_charge: 0 }

    const overstay = charges.over_minutes > 0

    // Record aggregate metrics
    const hour_bucket = this.sim_start_hour + Math.floor(trip.arrival_minute / 60)

    recordSessionMetrics(db, {
      date: this.sim_date,
      hour_bucket: Math.min(23, hour_bucket),
      lot_id: trip.lot_id,
      age_range: trip.age_range,
      gender: null,   // trips don't carry gender; cohort breakdowns use real session data
      parked: true,
      conflict: false,
      abandoned: false,
      overstay,
      time_to_spot_ms: this.params.eta_threshold_minutes * 60 * 1000,
      dwell_minutes: trip.dwell_minutes,
      surcharge: charges.surcharge,
      revenue: charges.total_charge,
    })

    this._emit_event({
      type: 'EXITED',
      lot_id: trip.lot_id,
      trip_id: trip.id,
      user_id: trip.user_id,
      spot_id: active.spot_id,
      sim_minute: this.sim_minute,
      ts: Date.now(),
      payload: {
        dwell_minutes: trip.dwell_minutes,
        surcharge: charges.surcharge,
        total_charge: charges.total_charge,
        overstay,
      },
    })
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _build_departure_map(): void {
    this.departure_map.clear()
    for (const trip of this.trips) {
      const dep_minute = trip.arrival_minute + trip.dwell_minutes
      if (!this.departure_map.has(dep_minute)) {
        this.departure_map.set(dep_minute, [])
      }
      this.departure_map.get(dep_minute)!.push(trip)
    }
  }

  private _reset_state(): void {
    this.sim_minute = 0
    this.arrival_cursor = 0
    this.departure_map.clear()
    this.active_trips.clear()
    this.events_emitted = 0
    this.trips_processed = 0
    this.started_at = null
    this.trips = []
  }

  private _reset_spots(): void {
    try {
      getDb().prepare(
        `UPDATE spots SET status = 'available' WHERE status IN ('reserved', 'occupied')`
      ).run()
    } catch {
      // DB may not be initialized yet
    }
  }

  private _complete(): void {
    this._stop_interval()
    this.status = 'complete'
    if (this.run_id) {
      getDb().prepare(
        `UPDATE sim_runs SET status = 'complete', ended_at = ?, sim_minute = ? WHERE id = ?`
      ).run(Math.floor(Date.now() / 1000), this.sim_minute, this.run_id)
    }
    this._emit_occupancy()
    this._emit_status()
  }

  private _stop_interval(): void {
    if (this.tick_interval) {
      clearInterval(this.tick_interval)
      this.tick_interval = null
    }
  }

  private _emit_event(event: SimEvent): void {
    this.events_emitted++
    this.emit('event', event)

    // Persist to events table (sample every 10th event to avoid DB pressure)
    if (this.events_emitted % 10 === 0) {
      try {
        getDb().prepare(
          `INSERT INTO events (lot_id, event_type, payload, sim_minute, ts)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          event.lot_id,
          event.type,
          event.payload ? JSON.stringify(event.payload) : null,
          event.sim_minute,
          Math.floor(event.ts / 1000)
        )
      } catch {
        // Non-fatal — sim continues even if event log write fails
      }
    }
  }

  private _emit_occupancy(): void {
    const snapshot = this._get_occupancy_snapshot()
    this.emit('occupancy', snapshot)
  }

  private _emit_status(): void {
    this.emit('status', this.getStatus())
  }

  private _get_occupancy_snapshot(): OccupancySnapshot {
    return {
      sim_minute: this.sim_minute,
      lots: this._get_occupancy_map_full(),
    }
  }

  private _get_occupancy_map(): Record<string, number> {
    const full = this._get_occupancy_map_full()
    return Object.fromEntries(
      Object.entries(full).map(([id, data]) => [id, data.pct])
    )
  }

  private _get_occupancy_map_full(): OccupancySnapshot['lots'] {
    try {
      const db = getDb()
      const rows = db.prepare(
        `SELECT lot_id,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
           SUM(CASE WHEN status = 'occupied'  THEN 1 ELSE 0 END) as occupied,
           SUM(CASE WHEN status = 'reserved'  THEN 1 ELSE 0 END) as reserved
         FROM spots
         WHERE spot_type != 'ada'
         GROUP BY lot_id`
      ).all() as Array<{ lot_id: string; total: number; available: number; occupied: number; reserved: number }>

      const result: OccupancySnapshot['lots'] = {}
      for (const row of rows) {
        const in_use = row.occupied + row.reserved
        result[row.lot_id] = {
          total: row.total,
          available: row.available,
          occupied: row.occupied,
          reserved: row.reserved,
          pct: row.total > 0 ? Math.round((in_use / row.total) * 100) / 100 : 0,
        }
      }
      return result
    } catch {
      return {}
    }
  }
}

// ── Export singleton ──────────────────────────────────────────────────────────

export const simEngine = new SimEngine()
