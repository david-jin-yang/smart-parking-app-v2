import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { percentileFromHistogram } from '@/lib/sim/aggregates'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lot_id = searchParams.get('lot_id') ?? undefined
  const date   = searchParams.get('date') ?? new Date().toISOString().split('T')[0]

  const db    = getDb()
  const where = lot_id
    ? `WHERE date=? AND lot_id=? AND age_range='__all__' AND gender='__all__'`
    : `WHERE date=? AND age_range='__all__' AND gender='__all__'`
  const args  = lot_id ? [date, lot_id] : [date]

  const t = (db.prepare(
    `SELECT
       SUM(session_count)             as total_sessions,
       SUM(type1_count)               as total_type1,
       SUM(type2_count)               as total_type2,
       SUM(parked_count)              as total_parked,
       SUM(conflict_count)            as total_conflicts,
       SUM(abandon_count)             as total_abandoned,
       SUM(overstay_count)            as total_overstays,
       SUM(sum_dwell_minutes)         as total_dwell_min,
       SUM(sum_type1_tts_ms)          as total_type1_tts_ms,
       SUM(sum_type2_wait_ms)         as total_type2_wait_ms,
       SUM(sum_non_app_search_minutes) as total_search_min,
       SUM(sum_revenue)               as total_revenue,
       SUM(sum_surcharge)             as total_surcharge,
       SUM(ev_charge_trips)           as total_ev_charge,
       SUM(ev_charge_turned_away)     as total_ev_turnaway,
       SUM(handicap_trips)            as total_hc,
       SUM(handicap_overflow)         as total_hc_overflow
     FROM metrics_aggregate ${where}`
  ).get(...args) ?? {}) as Record<string, number>

  const total_sessions = t.total_sessions ?? 0
  const total_parked   = t.total_parked   ?? 0
  const total_type1    = t.total_type1    ?? 0
  const total_type2    = t.total_type2    ?? 0

  // Merge histograms
  const histRows = db.prepare(
    `SELECT tts_histogram, dwell_histogram, non_app_search_histogram
     FROM metrics_aggregate ${where}`
  ).all(...args) as Array<{ tts_histogram: string; dwell_histogram: string; non_app_search_histogram: string }>

  const mTts: Record<string, number>    = {}
  const mDwell: Record<string, number>  = {}
  const mSearch: Record<string, number> = {}

  for (const row of histRows) {
    for (const [k,v] of Object.entries(JSON.parse(row.tts_histogram    || '{}') as Record<string,number>)) mTts[k]    = (mTts[k]    ?? 0) + v
    for (const [k,v] of Object.entries(JSON.parse(row.dwell_histogram  || '{}') as Record<string,number>)) mDwell[k]  = (mDwell[k]  ?? 0) + v
    for (const [k,v] of Object.entries(JSON.parse(row.non_app_search_histogram || '{}') as Record<string,number>)) mSearch[k] = (mSearch[k] ?? 0) + v
  }

  const tts_p50    = percentileFromHistogram(JSON.stringify(mTts),    50)
  const tts_p90    = percentileFromHistogram(JSON.stringify(mTts),    90)
  const dwell_p50  = percentileFromHistogram(JSON.stringify(mDwell),  50)
  const dwell_p90  = percentileFromHistogram(JSON.stringify(mDwell),  90)
  const search_p50 = percentileFromHistogram(JSON.stringify(mSearch), 50)
  const search_p90 = percentileFromHistogram(JSON.stringify(mSearch), 90)

  const avg_type1_tts_seconds  = total_type1 > 0 ? Math.round((t.total_type1_tts_ms  ?? 0) / total_type1 / 1000) : 0
  const avg_type2_wait_minutes = total_type2 > 0 ? Math.round(((t.total_search_min   ?? 0) / total_type2) * 10) / 10 : 0
  const avg_time_saved         = total_type2 > 0 && total_type1 > 0
    ? Math.round((avg_type2_wait_minutes - avg_type1_tts_seconds / 60) * 10) / 10
    : null

  const hourly = db.prepare(
    `SELECT hour_bucket,
       SUM(session_count)  as sessions,
       SUM(type1_count)    as type1,
       SUM(type2_count)    as type2,
       SUM(parked_count)   as parked,
       SUM(sum_revenue)    as revenue
     FROM metrics_aggregate ${where}
     GROUP BY hour_bucket ORDER BY hour_bucket`
  ).all(...args) as Array<{ hour_bucket: number; sessions: number; type1: number; type2: number; parked: number; revenue: number }>

  return NextResponse.json({
    date, lot_id: lot_id ?? 'all',
    kpis: {
      total_sessions, total_parked,
      total_conflicts:   t.total_conflicts  ?? 0,
      total_abandoned:   t.total_abandoned  ?? 0,
      total_overstays:   t.total_overstays  ?? 0,
      avg_dwell_minutes: total_parked > 0 ? Math.round((t.total_dwell_min ?? 0) / total_parked) : 0,
      conflict_rate: total_sessions > 0 ? Math.round(((t.total_conflicts ?? 0) / total_sessions) * 1000) / 10 : 0,
      abandon_rate:  total_sessions > 0 ? Math.round(((t.total_abandoned ?? 0) / total_sessions) * 1000) / 10 : 0,
      overstay_rate: total_parked   > 0 ? Math.round(((t.total_overstays ?? 0) / total_parked)   * 1000) / 10 : 0,
      total_revenue:   Math.round((t.total_revenue   ?? 0) * 100) / 100,
      total_surcharge: Math.round((t.total_surcharge ?? 0) * 100) / 100,
    },
    comparison: {
      type1: {
        sessions: total_type1,
        avg_tts_seconds: avg_type1_tts_seconds,
        tts_p50, tts_p90,
        label: 'Active (pre-assigned)',
      },
      type2: {
        sessions: total_type2,
        avg_search_minutes: avg_type2_wait_minutes,
        search_p50, search_p90,
        label: 'Passive (gate arrival)',
      },
      avg_time_saved_minutes: avg_time_saved,
    },
    special_spots: {
      ev_charge_trips:    t.total_ev_charge   ?? 0,
      ev_charge_turnaway: t.total_ev_turnaway ?? 0,
      ev_turnaway_rate:   (t.total_ev_charge ?? 0) > 0
        ? Math.round(((t.total_ev_turnaway ?? 0) / (t.total_ev_charge ?? 1)) * 1000) / 10
        : 0,
      handicap_trips:    t.total_hc          ?? 0,
      handicap_overflow: t.total_hc_overflow ?? 0,
      hc_overflow_rate:  (t.total_hc ?? 0) > 0
        ? Math.round(((t.total_hc_overflow ?? 0) / (t.total_hc ?? 1)) * 1000) / 10
        : 0,
    },
    percentiles: { tts_p50, tts_p90, dwell_p50, dwell_p90, search_p50, search_p90 },
    hourly_trend: hourly,
  })
}
