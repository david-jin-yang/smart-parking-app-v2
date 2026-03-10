/**
 * lib/sim/trips.ts
 *
 * Generates synthetic parking trips from user profiles.
 * Pure function — no DB writes, no side effects.
 *
 * v3: adds user_type (type1/type2), home coordinates,
 *     haversine drive time, EV charge-purpose trips,
 *     handicap/EV spot preferences.
 */

import { SeededRng } from './rng'

// ── Constants ─────────────────────────────────────────────────────────────────

const LOT_IDS = [
  'lot_century_city',
  'lot_glendale_galleria',
  'lot_old_town_pasadena',
]

// Lot coordinates (must match seed.ts)
const LOT_COORDS: Record<string, { lat: number; lng: number }> = {
  lot_century_city:       { lat: 34.0559, lng: -118.4155 },
  lot_glendale_galleria:  { lat: 34.1473, lng: -118.2559 },
  lot_old_town_pasadena:  { lat: 34.1478, lng: -118.1445 },
}

// Dwell time means by age cohort (minutes)
const DWELL_MEANS: Record<string, number> = {
  '16-24': 75,
  '25-34': 90,
  '35-44': 105,
  '45-54': 95,
  '55-64': 80,
  '65-80': 70,
}

const AGE_RANGES  = ['16-24', '25-34', '35-44', '45-54', '55-64', '65-80']
const AGE_WEIGHTS = [0.12, 0.25, 0.22, 0.18, 0.13, 0.10]

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyntheticUser {
  id: string
  age_range: string
  avg_dwell_minutes: number
  dwell_std: number
  preferred_lots: string[]
  home_lat: number
  home_lng: number
  is_handicap: boolean
  is_ev_driver: boolean
  user_type: 'type1_active' | 'type2_passive'
}

export interface SyntheticTrip {
  id: string
  user_id: string
  lot_id: string
  age_range: string
  arrival_minute: number          // minutes from sim day start (0 = 8am)
  dwell_minutes: number
  user_type: 'type1_active' | 'type2_passive'
  is_handicap: boolean
  is_ev_driver: boolean
  charge_purpose: boolean         // true = came specifically to charge EV
  home_distance_miles: number     // haversine distance to this lot
  drive_time_minutes: number      // estimated drive time based on hour
  eta_trigger_minute: number      // minute engine starts processing this trip
  /**
   * For type2 / non-app baseline only:
   * Simulated manual search time if no spot pre-assigned.
   */
  non_app_search_minutes: number | null
}

// ── Generator params ──────────────────────────────────────────────────────────

export interface TripGenParams {
  seed: number
  user_count: number
  sim_day_hours: number
  non_app_pct: number          // kept for legacy, now maps to type2 ratio
  eta_threshold_minutes: number
  event_mode: boolean
}

// ── Haversine distance ────────────────────────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 3958.8  // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
              + Math.cos(lat1 * Math.PI / 180)
              * Math.cos(lat2 * Math.PI / 180)
              * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

// ── Drive time by hour of day ─────────────────────────────────────────────────

function driveTimeMinutes(miles: number, simHour: number): number {
  // LA average speeds by time of day
  const speed = simHour >= 7  && simHour <= 9  ? 18   // morning rush
              : simHour >= 16 && simHour <= 19 ? 18   // evening rush
              : simHour >= 10 && simHour <= 15 ? 28   // midday
              : 35                                     // off-peak
  return (miles / speed) * 60
}

// ── Trip generator ────────────────────────────────────────────────────────────

export function generateTrips(params: TripGenParams): SyntheticTrip[] {
  const rng        = new SeededRng(params.seed)
  const dayMinutes = params.sim_day_hours * 60
  const simStartHr = 8  // sim day starts at 8am
  const multiplier = params.event_mode ? 3 : 1

  // ── Generate synthetic user profiles ──────────────────────────────────────

  const users: SyntheticUser[] = []
  for (let i = 1; i <= params.user_count; i++) {
    const age_range   = rng.weightedPick(AGE_RANGES, AGE_WEIGHTS)
    const avg_dwell   = DWELL_MEANS[age_range] ?? 90
    const lot_count   = rng.int(1, 3)
    const preferred_lots: string[] = []
    for (let j = 0; j < lot_count; j++) preferred_lots.push(rng.pick(LOT_IDS))

    // User type: 70% type1_active, 30% type2_passive
    const user_type   = rng.next() < 0.70 ? 'type1_active' : 'type2_passive'
    const is_handicap  = rng.next() < 0.032
    const is_ev_driver = rng.next() < 0.15

    // Home coordinates — gaussian around LA center
    const home_lat = rng.gaussian(34.05, 0.18, 33.70, 34.35)
    const home_lng = rng.gaussian(-118.25, 0.22, -118.70, -117.90)

    users.push({
      id: `user_${String(i).padStart(6, '0')}`,
      age_range,
      avg_dwell_minutes: avg_dwell,
      dwell_std: 20,
      preferred_lots,
      home_lat,
      home_lng,
      is_handicap,
      is_ev_driver,
      user_type: user_type as 'type1_active' | 'type2_passive',
    })
  }

  // ── Generate trips ─────────────────────────────────────────────────────────

  const trips: SyntheticTrip[] = []
  const totalTrips = Math.floor(params.user_count * multiplier)

  // 1% of trips are EV charge-purpose — generated separately with evening timing
  const chargeTripCount = Math.floor(totalTrips * 0.01)
  const regularTripCount = totalTrips - chargeTripCount

  // Regular trips
  for (let t = 0; t < regularTripCount; t++) {
    const user   = users[t % users.length]
    const lot_id = rng.pick(user.preferred_lots)

    // Arrival: weighted toward midday
    const arrival_minute = Math.round(
      rng.gaussian(dayMinutes * 0.6, dayMinutes * 0.2, 0, dayMinutes - 30)
    )

    // Dwell time by age cohort
    let dwell_minutes: number
    if (rng.next() < 0.05) {
      dwell_minutes = Math.round(rng.gaussian(150, 20, 130, 240))  // overstay
    } else {
      dwell_minutes = Math.round(
        rng.gaussian(user.avg_dwell_minutes, user.dwell_std, 15, 120)
      )
    }

    // Distance and drive time to this specific lot
    const lot_coords          = LOT_COORDS[lot_id]
    const home_distance_miles = haversine(
      user.home_lat, user.home_lng,
      lot_coords.lat, lot_coords.lng
    )
    const arrival_hour        = simStartHr + Math.floor(arrival_minute / 60)
    const drive_time_minutes  = driveTimeMinutes(home_distance_miles, arrival_hour)

    // Type1: enter queue when they start driving (arrival_minute - drive_time)
    //        spot is assigned when drive_time_remaining ≤ 5 min (in engine)
    // Type2: trigger at arrival — no queue
    const eta_trigger_minute = user.user_type === 'type1_active'
      ? Math.max(0, arrival_minute - Math.ceil(drive_time_minutes))
      : arrival_minute

    // Non-app search minutes removed — TTS is now derived from
    // the proximity score of the assigned spot in the engine
    const non_app_search_minutes = null

    trips.push({
      id:                   `trip_${user.id}_${t}`,
      user_id:              user.id,
      lot_id,
      age_range:            user.age_range,
      arrival_minute,
      dwell_minutes,
      user_type:            user.user_type,
      is_handicap:          user.is_handicap,
      is_ev_driver:         user.is_ev_driver,
      charge_purpose:       false,
      home_distance_miles:  Math.round(home_distance_miles * 10) / 10,
      drive_time_minutes:   Math.round(drive_time_minutes * 10) / 10,
      eta_trigger_minute,
      non_app_search_minutes,
    })
  }

  // EV charge-purpose trips — evening arrival, must get EV spot or leave
  // Arrival: gaussian centered at 5:30pm (sim minute 570 from 8am start)
  // σ = 45 min, range 4:00pm–7:30pm (minutes 480–690)
  const evUsers = users.filter(u => u.is_ev_driver)
  for (let t = 0; t < chargeTripCount; t++) {
    const user   = evUsers.length > 0
      ? evUsers[t % evUsers.length]
      : users[t % users.length]
    const lot_id = rng.pick(user.preferred_lots)

    const arrival_minute = Math.round(rng.gaussian(570, 45, 480, 690))
    const dwell_minutes  = Math.round(rng.gaussian(45, 15, 25, 75))  // shorter stay

    const lot_coords          = LOT_COORDS[lot_id]
    const home_distance_miles = haversine(
      user.home_lat, user.home_lng,
      lot_coords.lat, lot_coords.lng
    )
    const arrival_hour       = simStartHr + Math.floor(arrival_minute / 60)
    const drive_time_minutes = driveTimeMinutes(home_distance_miles, arrival_hour)

    const eta_trigger_minute = Math.max(0, arrival_minute - Math.ceil(drive_time_minutes))

    trips.push({
      id:                   `trip_charge_${t}`,
      user_id:              user.id,
      lot_id,
      age_range:            user.age_range,
      arrival_minute,
      dwell_minutes,
      user_type:            'type1_active',  // charge trips behave like type1
      is_handicap:          user.is_handicap,
      is_ev_driver:         true,
      charge_purpose:       true,
      home_distance_miles:  Math.round(home_distance_miles * 10) / 10,
      drive_time_minutes:   Math.round(drive_time_minutes * 10) / 10,
      eta_trigger_minute,
      non_app_search_minutes: null,
    })
  }

  // Sort by eta_trigger_minute for engine's linear scan
  trips.sort((a, b) => a.eta_trigger_minute - b.eta_trigger_minute)
  return trips
}
