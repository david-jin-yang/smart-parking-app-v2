/**
 * lib/sim/aggregates.ts
 *
 * Updates the metrics_aggregate table as the simulation runs.
 * Also used by real session API routes for live data.
 *
 * Design: upsert-based — safe to call multiple times for the same key.
 */

import type Database from 'better-sqlite3'

// ── Histogram helpers ─────────────────────────────────────────────────────────

// time_to_spot bins in seconds
const TTS_BINS = [0, 30, 60, 120, 300, 600, 1800]

// dwell bins in minutes
const DWELL_BINS = [15, 30, 60, 90, 120, 150, 180, 240]

function ttsbin(seconds: number): number {
  for (let i = TTS_BINS.length - 1; i >= 0; i--) {
    if (seconds >= TTS_BINS[i]) return TTS_BINS[i]
  }
  return 0
}

function dwellBin(minutes: number): number {
  for (let i = DWELL_BINS.length - 1; i >= 0; i--) {
    if (minutes >= DWELL_BINS[i]) return DWELL_BINS[i]
  }
  return 15
}

function parseHistogram(json: string): Record<string, number> {
  try {
    return JSON.parse(json) as Record<string, number>
  } catch {
    return {}
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionMetrics {
  date: string          // 'YYYY-MM-DD'
  hour_bucket: number   // 0-23
  lot_id: string
  age_range: string | null
  gender: string | null
  // what happened
  parked: boolean
  conflict: boolean
  abandoned: boolean
  overstay: boolean
  time_to_spot_ms: number | null
  dwell_minutes: number | null
  surcharge: number
  revenue: number
}

// ── Main upsert function ──────────────────────────────────────────────────────

/**
 * Atomically increments all aggregate counters for a completed session event.
 * Writes two rows per call: one for the specific cohort, one for '__all__'.
 */
export function recordSessionMetrics(
  db: Database.Database,
  m: SessionMetrics
): void {
  const age_range = m.age_range ?? '__all__'
  const gender = m.gender ?? '__all__'

  // Write specific cohort row + rollup row
  const cohortKeys = [
    { age_range, gender },
    { age_range: '__all__', gender: '__all__' },
  ]

  for (const key of cohortKeys) {
    upsertAgg(db, {
      date: m.date,
      hour_bucket: m.hour_bucket,
      lot_id: m.lot_id,
      ...key,
      parked: m.parked,
      conflict: m.conflict,
      abandoned: m.abandoned,
      overstay: m.overstay,
      time_to_spot_ms: m.time_to_spot_ms,
      dwell_minutes: m.dwell_minutes,
      surcharge: m.surcharge,
      revenue: m.revenue,
    })
  }
}

function upsertAgg(
  db: Database.Database,
  m: {
    date: string
    hour_bucket: number
    lot_id: string
    age_range: string
    gender: string
    parked: boolean
    conflict: boolean
    abandoned: boolean
    overstay: boolean
    time_to_spot_ms: number | null
    dwell_minutes: number | null
    surcharge: number
    revenue: number
  }
): void {
  // Ensure row exists
  db.prepare(
    `INSERT OR IGNORE INTO metrics_aggregate
       (date, hour_bucket, lot_id, age_range, gender)
     VALUES (?, ?, ?, ?, ?)`
  ).run(m.date, m.hour_bucket, m.lot_id, m.age_range, m.gender)

  // Fetch current histograms to update them
  const row = db.prepare(
    `SELECT tts_histogram, dwell_histogram FROM metrics_aggregate
     WHERE date = ? AND hour_bucket = ? AND lot_id = ? AND age_range = ? AND gender = ?`
  ).get(m.date, m.hour_bucket, m.lot_id, m.age_range, m.gender) as
    { tts_histogram: string; dwell_histogram: string } | undefined

  const ttsHist = parseHistogram(row?.tts_histogram ?? '{}')
  const dwellHist = parseHistogram(row?.dwell_histogram ?? '{}')

  // Update histogram bins
  if (m.time_to_spot_ms !== null) {
    const bin = String(ttsbin(Math.round(m.time_to_spot_ms / 1000)))
    ttsHist[bin] = (ttsHist[bin] ?? 0) + 1
  }
  if (m.dwell_minutes !== null) {
    const bin = String(dwellBin(Math.round(m.dwell_minutes)))
    dwellHist[bin] = (dwellHist[bin] ?? 0) + 1
  }

  // Atomic increment update
  db.prepare(
    `UPDATE metrics_aggregate SET
       session_count  = session_count  + 1,
       parked_count   = parked_count   + ?,
       conflict_count = conflict_count + ?,
       abandon_count  = abandon_count  + ?,
       overstay_count = overstay_count + ?,
       sum_time_to_spot_ms = sum_time_to_spot_ms + ?,
       sum_dwell_minutes   = sum_dwell_minutes   + ?,
       sum_surcharge       = sum_surcharge       + ?,
       sum_revenue         = sum_revenue         + ?,
       tts_histogram       = ?,
       dwell_histogram     = ?
     WHERE date = ? AND hour_bucket = ? AND lot_id = ? AND age_range = ? AND gender = ?`
  ).run(
    m.parked ? 1 : 0,
    m.conflict ? 1 : 0,
    m.abandoned ? 1 : 0,
    m.overstay ? 1 : 0,
    m.time_to_spot_ms ?? 0,
    m.dwell_minutes ?? 0,
    m.surcharge,
    m.revenue,
    JSON.stringify(ttsHist),
    JSON.stringify(dwellHist),
    m.date,
    m.hour_bucket,
    m.lot_id,
    m.age_range,
    m.gender,
  )
}

// ── p50/p90 from histogram ────────────────────────────────────────────────────

/**
 * Compute approximate percentile from a stored histogram.
 * Returns the bin value at or above the requested percentile.
 */
export function percentileFromHistogram(
  histJson: string,
  percentile: number   // 0-100
): number | null {
  const hist = parseHistogram(histJson)
  const entries = Object.entries(hist)
    .map(([bin, count]) => ({ bin: Number(bin), count }))
    .sort((a, b) => a.bin - b.bin)

  if (entries.length === 0) return null

  const total = entries.reduce((sum, e) => sum + e.count, 0)
  const target = (percentile / 100) * total

  let cumulative = 0
  for (const entry of entries) {
    cumulative += entry.count
    if (cumulative >= target) return entry.bin
  }

  return entries[entries.length - 1].bin
}
