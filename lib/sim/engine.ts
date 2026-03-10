/**
 * lib/sim/engine.ts
 *
 * v3: Type1/Type2 priority queue, proximity-ordered assignment,
 *     spot type filtering (HC/EV), EV charge-purpose turnaway,
 *     haversine-based ETA trigger.
 */

import { EventEmitter } from 'events'
import getDb from '../db'
import { generateTrips, type SyntheticTrip } from './trips'
import { recordSessionMetrics } from './aggregates'
import { computeCharges } from '../core/sessionMachine'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SimParams {
  seed: number
  speed_multiplier: number
  user_count: number
  sim_day_hours: number
  non_app_pct: number
  conflict_pct: number
  event_mode: boolean
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
  occupancy: Record<string, number>
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

export const DEFAULT_PARAMS: SimParams = {
  seed: 42,
  speed_multiplier: 60,
  user_count: 5000,
  sim_day_hours: 14,
  non_app_pct: 0.30,       // now represents type2_passive ratio
  conflict_pct: 0.03,
  event_mode: false,
  eta_threshold_minutes: 12,
}

// ── Assignment window ─────────────────────────────────────────────────────────
// Type1 assigned when drive_time_remaining ≤ 5 min
// 5 min drive + ~3-4 min nav = ~9 min total hold time max
const ASSIGNMENT_WINDOW_MINUTES = 5

// Nav time from lot entrance to spot, derived from proximity score
// base 1 min + 0.4 min per proximity point
// Best spot (0.04): ~1.0 min  |  Floor 4 worst (9.63): ~4.9 min
function navTimeMinutes(proximityScore: number): number {
  return Math.round((1.0 + proximityScore * 0.4) * 10) / 10
}

// Gate processing delay for Type 2 (account recognition, ~30 sec avg)
function gateWaitMinutes(): number {
  const u1 = Math.max(1e-10, Math.random())
  const u2 = Math.random()
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(0.2, Math.min(1.5, 0.5 + z * 0.2))
}

// ── Engine ────────────────────────────────────────────────────────────────────

class SimEngine extends EventEmitter {
  private status: SimStatus['status'] = 'idle'
  private sim_minute = 0
  private run_id: number | null = null
  private tick_interval: ReturnType<typeof setInterval> | null = null
  private params: SimParams = DEFAULT_PARAMS

  private trips: SyntheticTrip[] = []
  private arrival_cursor = 0
  private departure_map  = new Map<number, SyntheticTrip[]>()
  private active_trips   = new Map<string, { trip: SyntheticTrip; spot_id: string; parked_at_minute: number; tts_ms: number }>()

  // Queue: trip_id → trip (type1 users waiting for assignment window)
  private queue = new Map<string, SyntheticTrip>()

  private events_emitted = 0
  private trips_processed = 0
  private started_at: number | null = null
  private sim_date = ''
  private sim_start_hour = 8

  // ── Public API ───────────────────────────────────────────────────────────────

  start(params: Partial<SimParams> = {}): number {
    if (this.status === 'running') throw new Error('Already running. Pause or reset first.')

    this.params   = { ...DEFAULT_PARAMS, ...params }
    this.sim_date = new Date().toISOString().split('T')[0]

    if (this.status !== 'paused') {
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

      const db     = getDb()
      const result = db.prepare(
        `INSERT INTO sim_runs
           (seed, speed_mult, user_count, non_app_pct, conflict_pct, event_mode,
            sim_day_hours, status, sim_minute, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 0, ?)`
      ).run(
        this.params.seed, this.params.speed_multiplier, this.params.user_count,
        this.params.non_app_pct, this.params.conflict_pct,
        this.params.event_mode ? 1 : 0,
        this.params.sim_day_hours, Math.floor(Date.now() / 1000)
      )
      this.run_id = result.lastInsertRowid as number
    } else {
      if (this.run_id) {
        getDb().prepare(`UPDATE sim_runs SET status='running', paused_at=NULL WHERE id=?`)
          .run(this.run_id)
      }
    }

    this.status     = 'running'
    this.started_at = this.started_at ?? Date.now()

    this.tick_interval = setInterval(() => {
      for (let i = 0; i < this.params.speed_multiplier; i++) {
        this._tick()
        if (this.status !== 'running') { this._stop_interval(); return }
      }
      if (this.sim_minute % 5 === 0) this._emit_occupancy()
    }, 1000)

    this._emit_status()
    return this.run_id!
  }

  pause(): void {
    if (this.status !== 'running') return
    this._stop_interval()
    this.status = 'paused'
    if (this.run_id) {
      getDb().prepare(`UPDATE sim_runs SET status='paused', paused_at=? WHERE id=?`)
        .run(Math.floor(Date.now() / 1000), this.run_id)
    }
    this._emit_status()
  }

  reset(): void {
    this._stop_interval()
    this._reset_spots()
    this._reset_queue_table()
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

  // ── Core tick ────────────────────────────────────────────────────────────────

  private _tick(): void {
    const total_minutes = this.params.sim_day_hours * 60
    if (this.sim_minute >= total_minutes) { this._complete(); return }

    // 1. Advance arrival cursor — add trips to queue or process type2 directly
    while (
      this.arrival_cursor < this.trips.length &&
      this.trips[this.arrival_cursor].eta_trigger_minute <= this.sim_minute
    ) {
      const trip = this.trips[this.arrival_cursor++]
      if (trip.user_type === 'type1_active' || trip.charge_purpose) {
        // Type1: enter queue, will be assigned when window opens
        this.queue.set(trip.id, trip)
        this._emit_event({
          type: 'QUEUED',
          lot_id: trip.lot_id,
          trip_id: trip.id,
          user_id: trip.user_id,
          sim_minute: this.sim_minute,
          ts: Date.now(),
          payload: {
            drive_time_minutes: trip.drive_time_minutes,
            home_distance_miles: trip.home_distance_miles,
            user_type: trip.user_type,
            charge_purpose: trip.charge_purpose,
          },
        })
      } else {
        // Type2 passive: process at arrival, no queue
        this._process_type2_arrival(trip)
      }
    }

    // 2. Process queue — assign type1 trips whose window has opened
    for (const [trip_id, trip] of this.queue) {
      const drive_time_remaining = trip.arrival_minute - this.sim_minute
      if (drive_time_remaining <= ASSIGNMENT_WINDOW_MINUTES) {
        this.queue.delete(trip_id)
        this._process_type1_assignment(trip)
      }
    }

    // 3. Process departures
    const departures = this.departure_map.get(this.sim_minute)
    if (departures) {
      for (const trip of departures) this._process_departure(trip)
    }

    this.sim_minute++

    if (this.sim_minute % 30 === 0 && this.run_id) {
      getDb().prepare(`UPDATE sim_runs SET sim_minute=? WHERE id=?`)
        .run(this.sim_minute, this.run_id)
    }
  }

  // ── Spot assignment helpers ───────────────────────────────────────────────────

  /**
   * Returns best available spot for the given user type constraints.
   * Ordered by proximity_score ASC (lower = better).
   *
   * Spot type rules:
   *   HC user      → try 'ada' first, fallback to 'standard'/'ev'
   *   EV + charge  → must get 'ev', no fallback (turned away)
   *   EV + shop    → try 'ev' first, fallback to 'standard'
   *   Standard     → 'standard' only (cannot take 'ada' or 'ev')
   */
  private _assign_spot(
    lot_id: string,
    is_handicap: boolean,
    is_ev_driver: boolean,
    charge_purpose: boolean
  ): { spot_id: string; spot_type: string; overflow: boolean } | null {
    const db = getDb()

    return db.transaction((): { spot_id: string; spot_type: string; overflow: boolean } | null => {
      // Handicap: try ada first
      if (is_handicap) {
        const ada = db.prepare(
          `SELECT id, spot_type FROM spots
           WHERE lot_id=? AND status='available' AND spot_type='ada'
           ORDER BY proximity_score ASC LIMIT 1`
        ).get(lot_id) as { id: string; spot_type: string } | undefined

        if (ada) {
          db.prepare(`UPDATE spots SET status='reserved' WHERE id=?`).run(ada.id)
          return { spot_id: ada.id, spot_type: ada.spot_type, overflow: false }
        }
        // Overflow to standard
        const std = db.prepare(
          `SELECT id, spot_type FROM spots
           WHERE lot_id=? AND status='available' AND spot_type IN ('standard','ev')
           ORDER BY proximity_score ASC LIMIT 1`
        ).get(lot_id) as { id: string; spot_type: string } | undefined

        if (std) {
          db.prepare(`UPDATE spots SET status='reserved' WHERE id=?`).run(std.id)
          return { spot_id: std.id, spot_type: std.spot_type, overflow: true }
        }
        return null
      }

      // EV charge-purpose: must get EV spot, no fallback
      if (charge_purpose) {
        const ev = db.prepare(
          `SELECT id, spot_type FROM spots
           WHERE lot_id=? AND status='available' AND spot_type='ev'
           ORDER BY proximity_score ASC LIMIT 1`
        ).get(lot_id) as { id: string; spot_type: string } | undefined

        if (ev) {
          db.prepare(`UPDATE spots SET status='reserved' WHERE id=?`).run(ev.id)
          return { spot_id: ev.id, spot_type: ev.spot_type, overflow: false }
        }
        return null  // turned away
      }

      // EV shopper: try ev, fallback to standard
      if (is_ev_driver) {
        const ev = db.prepare(
          `SELECT id, spot_type FROM spots
           WHERE lot_id=? AND status='available' AND spot_type='ev'
           ORDER BY proximity_score ASC LIMIT 1`
        ).get(lot_id) as { id: string; spot_type: string } | undefined

        if (ev) {
          db.prepare(`UPDATE spots SET status='reserved' WHERE id=?`).run(ev.id)
          return { spot_id: ev.id, spot_type: ev.spot_type, overflow: false }
        }
        // Fallback to standard
        const std = db.prepare(
          `SELECT id, spot_type FROM spots
           WHERE lot_id=? AND status='available' AND spot_type='standard'
           ORDER BY proximity_score ASC LIMIT 1`
        ).get(lot_id) as { id: string; spot_type: string } | undefined

        if (std) {
          db.prepare(`UPDATE spots SET status='reserved' WHERE id=?`).run(std.id)
          return { spot_id: std.id, spot_type: std.spot_type, overflow: false }
        }
        return null
      }

      // Standard user: standard spots only
      const spot = db.prepare(
        `SELECT id, spot_type FROM spots
         WHERE lot_id=? AND status='available' AND spot_type='standard'
         ORDER BY proximity_score ASC LIMIT 1`
      ).get(lot_id) as { id: string; spot_type: string } | undefined

      if (spot) {
        db.prepare(`UPDATE spots SET status='reserved' WHERE id=?`).run(spot.id)
        return { spot_id: spot.id, spot_type: spot.spot_type, overflow: false }
      }
      return null
    })()
  }

  // ── Type 1 assignment (pre-arrival, queued) ───────────────────────────────────

  private _process_type1_assignment(trip: SyntheticTrip): void {
    const assignment = this._assign_spot(
      trip.lot_id, trip.is_handicap, trip.is_ev_driver, trip.charge_purpose
    )

    if (!assignment) {
      // Charge-purpose: turned away (no EV spot)
      if (trip.charge_purpose) {
        this._emit_event({
          type: 'EV_CHARGE_TURNED_AWAY',
          lot_id: trip.lot_id, trip_id: trip.id, user_id: trip.user_id,
          sim_minute: this.sim_minute, ts: Date.now(),
        })
        this._record_departure_metrics(trip, null, true, 0)
        this.trips_processed++
        return
      }

      // Lot full
      this._emit_event({
        type: 'NO_SPOT',
        lot_id: trip.lot_id, trip_id: trip.id, user_id: trip.user_id,
        sim_minute: this.sim_minute, ts: Date.now(),
      })
      this.trips_processed++
      return
    }

    // Look up the spot's proximity score to calculate realistic nav time
    const spotRow = getDb().prepare(
      `SELECT proximity_score FROM spots WHERE id=?`
    ).get(assignment.spot_id) as { proximity_score: number } | undefined
    const nav_minutes = navTimeMinutes(spotRow?.proximity_score ?? 1.0)
    const tts_ms = Math.round(nav_minutes * 60 * 1000)

    this.active_trips.set(trip.id, {
      trip,
      spot_id: assignment.spot_id,
      parked_at_minute: trip.arrival_minute,
      tts_ms,
    })

    this._emit_event({
      type: 'ASSIGNED',
      lot_id: trip.lot_id, trip_id: trip.id, user_id: trip.user_id,
      spot_id: assignment.spot_id,
      sim_minute: this.sim_minute, ts: Date.now(),
      payload: {
        user_type: trip.user_type,
        spot_type: assignment.spot_type,
        overflow: assignment.overflow,
        charge_purpose: trip.charge_purpose,
        drive_time_minutes: trip.drive_time_minutes,
        home_distance_miles: trip.home_distance_miles,
        nav_minutes,
        tts_ms,
      },
    })

    this.trips_processed++
  }

  // ── Type 2 arrival (gate, no queue) ─────────────────────────────────────────

  private _process_type2_arrival(trip: SyntheticTrip): void {
    const assignment = this._assign_spot(
      trip.lot_id, trip.is_handicap, trip.is_ev_driver, false
    )

    if (!assignment) {
      this._emit_event({
        type: 'TYPE2_NO_SPOT',
        lot_id: trip.lot_id, trip_id: trip.id, user_id: trip.user_id,
        sim_minute: this.sim_minute, ts: Date.now(),
      })
      this.trips_processed++
      return
    }

    // TTS for Type 2 = gate processing wait + nav time to assigned spot
    const spotRow2 = getDb().prepare(
      `SELECT proximity_score FROM spots WHERE id=?`
    ).get(assignment.spot_id) as { proximity_score: number } | undefined
    const nav_minutes2  = navTimeMinutes(spotRow2?.proximity_score ?? 2.0)
    const gate_wait     = gateWaitMinutes()
    const tts_ms2       = Math.round((gate_wait + nav_minutes2) * 60 * 1000)

    this.active_trips.set(trip.id, {
      trip,
      spot_id: assignment.spot_id,
      parked_at_minute: this.sim_minute,
      tts_ms: tts_ms2,
    })

    this._emit_event({
      type: 'TYPE2_PARKED',
      lot_id: trip.lot_id, trip_id: trip.id, user_id: trip.user_id,
      spot_id: assignment.spot_id,
      sim_minute: this.sim_minute, ts: Date.now(),
      payload: {
        user_type: 'type2_passive',
        spot_type: assignment.spot_type,
        overflow: assignment.overflow,
        gate_wait_minutes: gate_wait,
        nav_minutes: nav_minutes2,
        tts_ms: tts_ms2,
      },
    })

    this.trips_processed++
  }

  // ── Departure ────────────────────────────────────────────────────────────────

  private _process_departure(trip: SyntheticTrip): void {
    const active = this.active_trips.get(trip.id)
    if (!active) return

    const db = getDb()
    db.prepare(`UPDATE spots SET status='available' WHERE id=?`).run(active.spot_id)
    this.active_trips.delete(trip.id)

    this._record_departure_metrics(trip, active.spot_id, false, active.tts_ms)

    this._emit_event({
      type: 'EXITED',
      lot_id: trip.lot_id, trip_id: trip.id, user_id: trip.user_id,
      spot_id: active.spot_id,
      sim_minute: this.sim_minute, ts: Date.now(),
      payload: { dwell_minutes: trip.dwell_minutes, user_type: trip.user_type },
    })
  }

  // ── Metrics recording ─────────────────────────────────────────────────────────

  private _record_departure_metrics(
    trip: SyntheticTrip,
    spot_id: string | null,
    ev_charge_turned_away: boolean,
    tts_ms: number = 0
  ): void {
    const db = getDb()
    const lot = db.prepare(
      `SELECT hourly_rate, grace_minutes, surcharge_rate FROM lots WHERE id=?`
    ).get(trip.lot_id) as { hourly_rate: number; grace_minutes: number; surcharge_rate: number } | undefined

    const now_ts    = Math.floor(Date.now() / 1000)
    const parked_ts = now_ts - trip.dwell_minutes * 60

    const charges = lot ? computeCharges({
      parked_at: parked_ts, exited_at: now_ts,
      hourly_rate: lot.hourly_rate, booked_minutes: 120,
      grace_minutes: lot.grace_minutes, surcharge_rate: lot.surcharge_rate,
    }) : { dwell_minutes: trip.dwell_minutes, over_minutes: 0, base_charge: 0, surcharge: 0, total_charge: 0 }

    const overstay    = charges.over_minutes > 0
    const hour_bucket = Math.min(23, this.sim_start_hour + Math.floor(trip.arrival_minute / 60))

    recordSessionMetrics(db, {
      date: this.sim_date,
      hour_bucket,
      lot_id: trip.lot_id,
      age_range: trip.age_range,
      gender: null,
      parked: spot_id !== null && !ev_charge_turned_away,
      conflict: false,
      abandoned: false,
      overstay,
      time_to_spot_ms: tts_ms > 0 ? tts_ms : null,
      non_app_search_minutes: null,
      dwell_minutes: trip.dwell_minutes,
      surcharge: charges.surcharge,
      revenue: charges.total_charge,
      is_app: true,
      user_type: trip.user_type,
      is_handicap: trip.is_handicap,
      handicap_overflow: false,
      is_ev_driver: trip.is_ev_driver,
      charge_purpose: trip.charge_purpose,
      ev_charge_turned_away,
    })
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _build_departure_map(): void {
    this.departure_map.clear()
    for (const trip of this.trips) {
      const dep = trip.arrival_minute + trip.dwell_minutes
      if (!this.departure_map.has(dep)) this.departure_map.set(dep, [])
      this.departure_map.get(dep)!.push(trip)
    }
  }

  private _reset_state(): void {
    this.sim_minute     = 0
    this.arrival_cursor = 0
    this.departure_map.clear()
    this.active_trips.clear()
    this.queue.clear()
    this.events_emitted  = 0
    this.trips_processed = 0
    this.started_at      = null
    this.trips           = []
  }

  private _reset_spots(): void {
    try {
      getDb().prepare(
        `UPDATE spots SET status='available' WHERE status IN ('reserved','occupied')`
      ).run()
    } catch { /* db not ready */ }
  }

  private _reset_queue_table(): void {
    try {
      getDb().prepare(`DELETE FROM parking_queue`).run()
    } catch { /* table may not exist yet */ }
  }

  private _complete(): void {
    this._stop_interval()
    this.status = 'complete'
    if (this.run_id) {
      getDb().prepare(
        `UPDATE sim_runs SET status='complete', ended_at=?, sim_minute=? WHERE id=?`
      ).run(Math.floor(Date.now() / 1000), this.sim_minute, this.run_id)
    }
    this._emit_occupancy()
    this._emit_status()
  }

  private _stop_interval(): void {
    if (this.tick_interval) { clearInterval(this.tick_interval); this.tick_interval = null }
  }

  private _emit_event(event: SimEvent): void {
    this.events_emitted++
    this.emit('event', event)
    if (this.events_emitted % 10 === 0) {
      try {
        getDb().prepare(
          `INSERT INTO events (lot_id, event_type, payload, sim_minute, ts) VALUES (?,?,?,?,?)`
        ).run(event.lot_id, event.type,
          event.payload ? JSON.stringify(event.payload) : null,
          event.sim_minute, Math.floor(event.ts / 1000))
      } catch { /* non-fatal */ }
    }
  }

  private _emit_occupancy(): void { this.emit('occupancy', this._get_occupancy_snapshot()) }
  private _emit_status():   void { this.emit('status', this.getStatus()) }

  private _get_occupancy_snapshot(): OccupancySnapshot {
    return { sim_minute: this.sim_minute, lots: this._get_occupancy_map_full() }
  }

  private _get_occupancy_map(): Record<string, number> {
    return Object.fromEntries(
      Object.entries(this._get_occupancy_map_full()).map(([id, d]) => [id, d.pct])
    )
  }

  private _get_occupancy_map_full(): OccupancySnapshot['lots'] {
    try {
      const rows = getDb().prepare(
        `SELECT lot_id,
           COUNT(*) as total,
           SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available,
           SUM(CASE WHEN status='occupied'  THEN 1 ELSE 0 END) as occupied,
           SUM(CASE WHEN status='reserved'  THEN 1 ELSE 0 END) as reserved
         FROM spots WHERE spot_type != 'ada' GROUP BY lot_id`
      ).all() as Array<{ lot_id: string; total: number; available: number; occupied: number; reserved: number }>

      const result: OccupancySnapshot['lots'] = {}
      for (const r of rows) {
        const in_use = r.occupied + r.reserved
        result[r.lot_id] = {
          total: r.total, available: r.available,
          occupied: r.occupied, reserved: r.reserved,
          pct: r.total > 0 ? Math.round((in_use / r.total) * 100) / 100 : 0,
        }
      }
      return result
    } catch { return {} }
  }
}

export const simEngine = new SimEngine()
