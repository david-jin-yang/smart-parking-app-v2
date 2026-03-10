/**
 * lib/sim/aggregates.ts
 *
 * v3: full type1/type2 split, EV charge tracking, handicap tracking.
 */

import type Database from 'better-sqlite3'

// ── Histogram bins ────────────────────────────────────────────────────────────

const TTS_BINS    = [0, 30, 60, 120, 300, 600, 1800]
const SEARCH_BINS = [5, 7, 9, 11, 13, 15, 17, 20]
const DWELL_BINS  = [15, 30, 60, 90, 120, 150, 180, 240]

function ttsBin(s: number)      { for (let i = TTS_BINS.length-1;    i>=0; i--) if (s >= TTS_BINS[i])    return TTS_BINS[i];    return 0  }
function searchBin(m: number)   { for (let i = SEARCH_BINS.length-1; i>=0; i--) if (m >= SEARCH_BINS[i]) return SEARCH_BINS[i]; return 5  }
function dwellBin(m: number)    { for (let i = DWELL_BINS.length-1;  i>=0; i--) if (m >= DWELL_BINS[i])  return DWELL_BINS[i];  return 15 }

function parseHist(json: string): Record<string, number> {
  try { return JSON.parse(json) as Record<string, number> } catch { return {} }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionMetrics {
  date: string
  hour_bucket: number
  lot_id: string
  age_range: string | null
  gender: string | null
  parked: boolean
  conflict: boolean
  abandoned: boolean
  overstay: boolean
  time_to_spot_ms: number | null
  non_app_search_minutes: number | null
  dwell_minutes: number | null
  surcharge: number
  revenue: number
  is_app: boolean
  user_type: 'type1_active' | 'type2_passive'
  is_handicap: boolean
  handicap_overflow: boolean   // true = HC user took standard spot
  is_ev_driver: boolean
  charge_purpose: boolean
  ev_charge_turned_away: boolean
}

// ── Main upsert ───────────────────────────────────────────────────────────────

export function recordSessionMetrics(db: Database.Database, m: SessionMetrics): void {
  const age_range = m.age_range ?? '__all__'
  const gender    = m.gender    ?? '__all__'

  for (const key of [{ age_range, gender }, { age_range: '__all__', gender: '__all__' }]) {
    upsertAgg(db, { ...m, age_range: key.age_range, gender: key.gender })
  }
}

function upsertAgg(db: Database.Database, m: SessionMetrics & { age_range: string; gender: string }): void {
  db.prepare(
    `INSERT OR IGNORE INTO metrics_aggregate (date, hour_bucket, lot_id, age_range, gender)
     VALUES (?, ?, ?, ?, ?)`
  ).run(m.date, m.hour_bucket, m.lot_id, m.age_range, m.gender)

  const row = db.prepare(
    `SELECT tts_histogram, dwell_histogram, non_app_search_histogram
     FROM metrics_aggregate
     WHERE date=? AND hour_bucket=? AND lot_id=? AND age_range=? AND gender=?`
  ).get(m.date, m.hour_bucket, m.lot_id, m.age_range, m.gender) as
    { tts_histogram: string; dwell_histogram: string; non_app_search_histogram: string } | undefined

  const ttsHist    = parseHist(row?.tts_histogram            ?? '{}')
  const dwellHist  = parseHist(row?.dwell_histogram          ?? '{}')
  const searchHist = parseHist(row?.non_app_search_histogram ?? '{}')

  if (m.user_type === 'type1_active' && m.time_to_spot_ms !== null) {
    const bin = String(ttsBin(Math.round(m.time_to_spot_ms / 1000)))
    ttsHist[bin] = (ttsHist[bin] ?? 0) + 1
  }
  if (m.user_type === 'type2_passive' && m.non_app_search_minutes !== null) {
    const bin = String(searchBin(Math.round(m.non_app_search_minutes)))
    searchHist[bin] = (searchHist[bin] ?? 0) + 1
  }
  if (m.dwell_minutes !== null) {
    const bin = String(dwellBin(Math.round(m.dwell_minutes)))
    dwellHist[bin] = (dwellHist[bin] ?? 0) + 1
  }

  db.prepare(
    `UPDATE metrics_aggregate SET
       session_count              = session_count + 1,
       app_session_count          = app_session_count + ?,
       non_app_session_count      = non_app_session_count + ?,
       type1_count                = type1_count + ?,
       type2_count                = type2_count + ?,
       parked_count               = parked_count + ?,
       conflict_count             = conflict_count + ?,
       abandon_count              = abandon_count + ?,
       overstay_count             = overstay_count + ?,
       sum_time_to_spot_ms        = sum_time_to_spot_ms + ?,
       sum_type1_tts_ms           = sum_type1_tts_ms + ?,
       sum_type2_wait_ms          = sum_type2_wait_ms + ?,
       sum_non_app_search_minutes = sum_non_app_search_minutes + ?,
       sum_dwell_minutes          = sum_dwell_minutes + ?,
       sum_surcharge              = sum_surcharge + ?,
       sum_revenue                = sum_revenue + ?,
       ev_charge_trips            = ev_charge_trips + ?,
       ev_charge_turned_away      = ev_charge_turned_away + ?,
       handicap_trips             = handicap_trips + ?,
       handicap_overflow          = handicap_overflow + ?,
       tts_histogram              = ?,
       dwell_histogram            = ?,
       non_app_search_histogram   = ?
     WHERE date=? AND hour_bucket=? AND lot_id=? AND age_range=? AND gender=?`
  ).run(
    m.is_app  ? 1 : 0,
    !m.is_app ? 1 : 0,
    m.user_type === 'type1_active' ? 1 : 0,
    m.user_type === 'type2_passive' ? 1 : 0,
    m.parked    ? 1 : 0,
    m.conflict  ? 1 : 0,
    m.abandoned ? 1 : 0,
    m.overstay  ? 1 : 0,
    // sum_time_to_spot_ms (all app users)
    m.time_to_spot_ms ?? 0,
    // sum_type1_tts_ms
    m.user_type === 'type1_active' && m.time_to_spot_ms ? m.time_to_spot_ms : 0,
    // sum_type2_wait_ms
    m.user_type === 'type2_passive' && m.non_app_search_minutes
      ? m.non_app_search_minutes * 60 * 1000 : 0,
    // sum_non_app_search_minutes
    m.non_app_search_minutes ?? 0,
    m.dwell_minutes ?? 0,
    m.surcharge,
    m.revenue,
    m.charge_purpose ? 1 : 0,
    m.ev_charge_turned_away ? 1 : 0,
    m.is_handicap ? 1 : 0,
    m.handicap_overflow ? 1 : 0,
    JSON.stringify(ttsHist),
    JSON.stringify(dwellHist),
    JSON.stringify(searchHist),
    m.date, m.hour_bucket, m.lot_id, m.age_range, m.gender,
  )
}

// ── Percentile helper ─────────────────────────────────────────────────────────

export function percentileFromHistogram(histJson: string, percentile: number): number | null {
  const hist    = parseHist(histJson)
  const entries = Object.entries(hist)
    .map(([bin, count]) => ({ bin: Number(bin), count }))
    .sort((a, b) => a.bin - b.bin)

  if (!entries.length) return null
  const total  = entries.reduce((s, e) => s + e.count, 0)
  const target = (percentile / 100) * total
  let cum = 0
  for (const e of entries) {
    cum += e.count
    if (cum >= target) return e.bin
  }
  return entries[entries.length - 1].bin
}
