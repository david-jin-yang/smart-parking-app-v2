/**
 * lib/sim/trips.ts
 *
 * Generates synthetic parking trips from user profiles.
 * Called by the engine each sim run — no DB writes here, pure data.
 */

import { SeededRng } from './rng'

// ── Constants ─────────────────────────────────────────────────────────────────

const LOT_IDS = [
  'lot_century_city',
  'lot_glendale_galleria',
  'lot_old_town_pasadena',
]

// Dwell time means by age cohort (minutes)
const DWELL_MEANS: Record<string, number> = {
  '16-24': 75,
  '25-34': 90,
  '35-44': 105,
  '45-54': 95,
  '55-64': 80,
  '65-80': 70,
}

const AGE_RANGES = ['16-24', '25-34', '35-44', '45-54', '55-64', '65-80']
const AGE_WEIGHTS = [0.12, 0.25, 0.22, 0.18, 0.13, 0.10]

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyntheticUser {
  id: string
  age_range: string
  avg_dwell_minutes: number
  dwell_std: number
  preferred_lots: string[]   // 1-3 lots this user tends to visit
}

export interface SyntheticTrip {
  id: string
  user_id: string
  lot_id: string
  age_range: string
  /** Minutes from sim day start (e.g. 0 = 8am) */
  arrival_minute: number
  dwell_minutes: number
  is_non_app_user: boolean
  /** Minutes before arrival to trigger spot assignment */
  eta_trigger_minute: number
}

// ── Generator ─────────────────────────────────────────────────────────────────

export interface TripGenParams {
  seed: number
  user_count: number
  sim_day_hours: number        // operating hours e.g. 14 = 8am–10pm
  non_app_pct: number          // fraction who bypass the app
  eta_threshold_minutes: number // assign when ETA <= this
  event_mode: boolean          // true = 3x traffic
}

/**
 * Generates all trips for a simulation run.
 * Returns trips sorted by arrival_minute ascending.
 * Pure function — no I/O.
 */
export function generateTrips(params: TripGenParams): SyntheticTrip[] {
  const rng = new SeededRng(params.seed)
  const dayMinutes = params.sim_day_hours * 60
  const trafficMultiplier = params.event_mode ? 3 : 1

  // Generate synthetic user profiles
  const users: SyntheticUser[] = []
  for (let i = 1; i <= params.user_count; i++) {
    const age_range = rng.weightedPick(AGE_RANGES, AGE_WEIGHTS)
    const avg_dwell = DWELL_MEANS[age_range] ?? 90
    const lot_count = rng.int(1, 3)
    const preferred_lots: string[] = []
    for (let j = 0; j < lot_count; j++) {
      preferred_lots.push(rng.pick(LOT_IDS))
    }
    users.push({
      id: `user_${String(i).padStart(6, '0')}`,
      age_range,
      avg_dwell_minutes: avg_dwell,
      dwell_std: 20,
      preferred_lots,
    })
  }

  // Generate one trip per user (scaled by traffic multiplier)
  const trips: SyntheticTrip[] = []
  const totalTrips = Math.floor(params.user_count * trafficMultiplier)

  for (let t = 0; t < totalTrips; t++) {
    const user = users[t % users.length]
    const lot_id = rng.pick(user.preferred_lots)

    // Arrival: weighted toward midday (gaussian centered at 60% of day)
    const arrival_minute = Math.round(
      rng.gaussian(dayMinutes * 0.6, dayMinutes * 0.2, 0, dayMinutes - 30)
    )

    // Dwell: gaussian, clipped to [15, 240] min; 5% chance of max overstay
    let dwell_minutes: number
    if (rng.next() < 0.05) {
      // Overstay trip — goes well past booked time
      dwell_minutes = Math.round(rng.gaussian(150, 20, 130, 240))
    } else {
      dwell_minutes = Math.round(
        rng.gaussian(user.avg_dwell_minutes, user.dwell_std, 15, 120)
      )
    }

    const is_non_app_user = rng.next() < params.non_app_pct
    const eta_trigger_minute = Math.max(0, arrival_minute - params.eta_threshold_minutes)

    trips.push({
      id: `trip_${user.id}_${t}`,
      user_id: user.id,
      lot_id,
      age_range: user.age_range,
      arrival_minute,
      dwell_minutes,
      is_non_app_user,
      eta_trigger_minute,
    })
  }

  // Sort by arrival time for the engine's linear scan
  trips.sort((a, b) => a.arrival_minute - b.arrival_minute)
  return trips
}
