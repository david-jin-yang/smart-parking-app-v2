/**
 * __tests__/sim.test.ts
 *
 * Tests for the simulation components.
 * Zero I/O — no DB, no engine start.
 */

import { SeededRng } from '../lib/sim/rng'
import { generateTrips } from '../lib/sim/trips'
import { percentileFromHistogram } from '../lib/sim/aggregates'

// ── SeededRng ─────────────────────────────────────────────────────────────────

describe('SeededRng', () => {
  test('same seed produces same sequence', () => {
    const a = new SeededRng(42)
    const b = new SeededRng(42)
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  test('different seeds produce different sequences', () => {
    const a = new SeededRng(42)
    const b = new SeededRng(99)
    const results_a = Array.from({ length: 20 }, () => a.next())
    const results_b = Array.from({ length: 20 }, () => b.next())
    expect(results_a).not.toEqual(results_b)
  })

  test('next() always returns value in [0, 1)', () => {
    const rng = new SeededRng(1234)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test('int() respects min/max bounds', () => {
    const rng = new SeededRng(7)
    for (let i = 0; i < 500; i++) {
      const v = rng.int(5, 10)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThanOrEqual(10)
    }
  })

  test('weightedPick() always returns a valid item', () => {
    const rng = new SeededRng(3)
    const items = ['a', 'b', 'c']
    const weights = [0.5, 0.3, 0.2]
    for (let i = 0; i < 200; i++) {
      expect(items).toContain(rng.weightedPick(items, weights))
    }
  })

  test('weightedPick() respects distribution roughly', () => {
    const rng = new SeededRng(42)
    const items = ['rare', 'common']
    const weights = [0.1, 0.9]
    const counts = { rare: 0, common: 0 }
    for (let i = 0; i < 1000; i++) {
      const pick = rng.weightedPick(items, weights)
      counts[pick as keyof typeof counts]++
    }
    // 'common' should be picked ~9x more often
    expect(counts.common).toBeGreaterThan(counts.rare * 5)
  })

  test('gaussian() returns values near the mean', () => {
    const rng = new SeededRng(42)
    const samples = Array.from({ length: 500 }, () => rng.gaussian(100, 10))
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length
    expect(mean).toBeGreaterThan(95)
    expect(mean).toBeLessThan(105)
  })

  test('gaussian() clamps to min/max when provided', () => {
    const rng = new SeededRng(42)
    for (let i = 0; i < 200; i++) {
      const v = rng.gaussian(100, 50, 50, 150)
      expect(v).toBeGreaterThanOrEqual(50)
      expect(v).toBeLessThanOrEqual(150)
    }
  })
})

// ── generateTrips ─────────────────────────────────────────────────────────────

describe('generateTrips', () => {
  const BASE_PARAMS = {
    seed: 42,
    user_count: 100,
    sim_day_hours: 14,
    non_app_pct: 0.15,
    eta_threshold_minutes: 8,
    event_mode: false,
  }

  test('deterministic — same params produce same trips', () => {
    const a = generateTrips(BASE_PARAMS)
    const b = generateTrips(BASE_PARAMS)
    expect(a.length).toBe(b.length)
    expect(a[0]).toEqual(b[0])
    expect(a[a.length - 1]).toEqual(b[b.length - 1])
  })

  test('different seeds produce different trips', () => {
    const a = generateTrips({ ...BASE_PARAMS, seed: 42 })
    const b = generateTrips({ ...BASE_PARAMS, seed: 99 })
    expect(a[0].arrival_minute).not.toBe(b[0].arrival_minute)
  })

  test('returns trips sorted by arrival_minute ascending', () => {
    const trips = generateTrips(BASE_PARAMS)
    for (let i = 1; i < trips.length; i++) {
      expect(trips[i].arrival_minute).toBeGreaterThanOrEqual(trips[i - 1].arrival_minute)
    }
  })

  test('all arrival_minutes within sim_day_hours window', () => {
    const trips = generateTrips(BASE_PARAMS)
    const maxMinute = BASE_PARAMS.sim_day_hours * 60
    for (const trip of trips) {
      expect(trip.arrival_minute).toBeGreaterThanOrEqual(0)
      expect(trip.arrival_minute).toBeLessThan(maxMinute)
    }
  })

  test('dwell_minutes in valid range', () => {
    const trips = generateTrips(BASE_PARAMS)
    for (const trip of trips) {
      expect(trip.dwell_minutes).toBeGreaterThanOrEqual(15)
      expect(trip.dwell_minutes).toBeLessThanOrEqual(240)
    }
  })

  test('approximately non_app_pct trips are non-app users', () => {
    const trips = generateTrips({ ...BASE_PARAMS, user_count: 500, non_app_pct: 0.20 })
    const nonApp = trips.filter(t => t.is_non_app_user).length
    const pct = nonApp / trips.length
    // Allow ±5% deviation
    expect(pct).toBeGreaterThan(0.10)
    expect(pct).toBeLessThan(0.35)
  })

  test('event_mode produces ~3x more trips', () => {
    const normal = generateTrips({ ...BASE_PARAMS, user_count: 100 })
    const event = generateTrips({ ...BASE_PARAMS, user_count: 100, event_mode: true })
    expect(event.length).toBeCloseTo(normal.length * 3, -1)
  })

  test('eta_trigger_minute is before arrival_minute', () => {
    const trips = generateTrips(BASE_PARAMS)
    for (const trip of trips) {
      expect(trip.eta_trigger_minute).toBeLessThanOrEqual(trip.arrival_minute)
    }
  })

  test('all lot_ids are valid', () => {
    const valid = ['lot_century_city', 'lot_glendale_galleria', 'lot_old_town_pasadena']
    const trips = generateTrips(BASE_PARAMS)
    for (const trip of trips) {
      expect(valid).toContain(trip.lot_id)
    }
  })

  test('all age_ranges are valid', () => {
    const valid = ['16-24', '25-34', '35-44', '45-54', '55-64', '65-80']
    const trips = generateTrips(BASE_PARAMS)
    for (const trip of trips) {
      expect(valid).toContain(trip.age_range)
    }
  })
})

// ── percentileFromHistogram ───────────────────────────────────────────────────

describe('percentileFromHistogram', () => {
  test('returns null for empty histogram', () => {
    expect(percentileFromHistogram('{}', 50)).toBeNull()
  })

  test('p50 of uniform distribution', () => {
    const hist = JSON.stringify({ '0': 10, '30': 10, '60': 10, '120': 10 })
    const p50 = percentileFromHistogram(hist, 50)
    expect(p50).not.toBeNull()
    // 50th percentile of 40 items: at item 20, which lands in the '30' or '60' bin
    expect([30, 60]).toContain(p50)
  })

  test('p90 is in higher bins than p50', () => {
    const hist = JSON.stringify({ '0': 50, '30': 30, '60': 15, '300': 5 })
    const p50 = percentileFromHistogram(hist, 50)
    const p90 = percentileFromHistogram(hist, 90)
    expect(p90!).toBeGreaterThanOrEqual(p50!)
  })

  test('p100 returns the highest bin', () => {
    const hist = JSON.stringify({ '0': 5, '30': 5, '600': 5 })
    expect(percentileFromHistogram(hist, 100)).toBe(600)
  })

  test('handles malformed JSON gracefully', () => {
    expect(percentileFromHistogram('not-json', 50)).toBeNull()
  })
})
