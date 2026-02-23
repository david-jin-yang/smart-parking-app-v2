import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lot_id = searchParams.get('lot_id') ?? undefined
  const date = searchParams.get('date') ?? new Date().toISOString().split('T')[0]
  const dimension = (searchParams.get('dimension') ?? 'age_range') as 'age_range' | 'gender'
  const db = getDb()
  const lotFilter = lot_id ? 'AND lot_id = ?' : ''
  const lotArgs = lot_id ? [lot_id] : []
  const cohortField = dimension === 'age_range' ? 'age_range' : 'gender'
  const otherField = dimension === 'age_range' ? 'gender' : 'age_range'
  const rows = db.prepare(
    `SELECT ${cohortField} as cohort,
       SUM(session_count) as sessions, SUM(parked_count) as parked,
       SUM(conflict_count) as conflicts, SUM(overstay_count) as overstays,
       SUM(sum_dwell_minutes) as total_dwell, SUM(sum_revenue) as revenue
     FROM metrics_aggregate
     WHERE date = ? AND ${cohortField} != '__all__' AND ${otherField} = '__all__' ${lotFilter}
     GROUP BY ${cohortField} ORDER BY sessions DESC`
  ).all(date, ...lotArgs) as Array<{ cohort: string; sessions: number; parked: number; conflicts: number; overstays: number; total_dwell: number; revenue: number }>
  const cohorts = rows.map(row => ({
    cohort: row.cohort, sessions: row.sessions, parked: row.parked,
    conflict_rate: row.sessions > 0 ? Math.round((row.conflicts / row.sessions) * 1000) / 10 : 0,
    overstay_rate: row.parked > 0 ? Math.round((row.overstays / row.parked) * 1000) / 10 : 0,
    avg_dwell_minutes: row.parked > 0 ? Math.round(row.total_dwell / row.parked) : 0,
    revenue: Math.round(row.revenue * 100) / 100,
  }))
  return NextResponse.json({ date, dimension, lot_id: lot_id ?? 'all', cohorts })
}
