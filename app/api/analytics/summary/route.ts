import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { percentileFromHistogram } from '@/lib/sim/aggregates'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lot_id = searchParams.get('lot_id') ?? undefined
  const date = searchParams.get('date') ?? new Date().toISOString().split('T')[0]
  const db = getDb()
  const where = lot_id
    ? `WHERE date = ? AND lot_id = ? AND age_range = '__all__' AND gender = '__all__'`
    : `WHERE date = ? AND age_range = '__all__' AND gender = '__all__'`
  const args = lot_id ? [date, lot_id] : [date]
  const totals = db.prepare(
    `SELECT SUM(session_count) as total_sessions, SUM(parked_count) as total_parked,
       SUM(conflict_count) as total_conflicts, SUM(abandon_count) as total_abandoned,
       SUM(overstay_count) as total_overstays, SUM(sum_dwell_minutes) as total_dwell_min,
       SUM(sum_time_to_spot_ms) as total_tts_ms, SUM(sum_revenue) as total_revenue,
       SUM(sum_surcharge) as total_surcharge
     FROM metrics_aggregate ${where}`
  ).get(...args) as Record<string, number> ?? {}
  const histRows = db.prepare(`SELECT tts_histogram, dwell_histogram FROM metrics_aggregate ${where}`)
    .all(...args) as Array<{ tts_histogram: string; dwell_histogram: string }>
  const mergedTts: Record<string, number> = {}
  const mergedDwell: Record<string, number> = {}
  for (const row of histRows) {
    for (const [k, v] of Object.entries(JSON.parse(row.tts_histogram || '{}'))) mergedTts[k] = (mergedTts[k] ?? 0) + (v as number)
    for (const [k, v] of Object.entries(JSON.parse(row.dwell_histogram || '{}'))) mergedDwell[k] = (mergedDwell[k] ?? 0) + (v as number)
  }
  const total_sessions = totals.total_sessions ?? 0
  const total_parked = totals.total_parked ?? 0
  const hourly = db.prepare(
    `SELECT hour_bucket, SUM(session_count) as sessions, SUM(parked_count) as parked, SUM(sum_revenue) as revenue
     FROM metrics_aggregate ${where} GROUP BY hour_bucket ORDER BY hour_bucket`
  ).all(...args)
  return NextResponse.json({
    date, lot_id: lot_id ?? 'all',
    kpis: {
      total_sessions, total_parked,
      total_conflicts: totals.total_conflicts ?? 0, total_abandoned: totals.total_abandoned ?? 0,
      total_overstays: totals.total_overstays ?? 0,
      avg_dwell_minutes: total_parked > 0 ? Math.round((totals.total_dwell_min ?? 0) / total_parked) : 0,
      avg_tts_seconds: total_parked > 0 ? Math.round((totals.total_tts_ms ?? 0) / total_parked / 1000) : 0,
      conflict_rate: total_sessions > 0 ? Math.round(((totals.total_conflicts ?? 0) / total_sessions) * 1000) / 10 : 0,
      abandon_rate: total_sessions > 0 ? Math.round(((totals.total_abandoned ?? 0) / total_sessions) * 1000) / 10 : 0,
      overstay_rate: total_parked > 0 ? Math.round(((totals.total_overstays ?? 0) / total_parked) * 1000) / 10 : 0,
      total_revenue: Math.round((totals.total_revenue ?? 0) * 100) / 100,
      total_surcharge: Math.round((totals.total_surcharge ?? 0) * 100) / 100,
    },
    percentiles: {
      tts_p50: percentileFromHistogram(JSON.stringify(mergedTts), 50),
      tts_p90: percentileFromHistogram(JSON.stringify(mergedTts), 90),
      dwell_p50: percentileFromHistogram(JSON.stringify(mergedDwell), 50),
      dwell_p90: percentileFromHistogram(JSON.stringify(mergedDwell), 90),
    },
    hourly_trend: hourly,
  })
}
