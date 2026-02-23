import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { getLotProvider } from '@/lib/providers/LotProvider'
import { computeCharges } from '@/lib/core/sessionMachine'
import { recordSessionMetrics } from '@/lib/sim/aggregates'
import { requireAuth, requireSession, nowSecs } from '@/lib/sessionHelper'

const VALID_EXIT_STATES = ['PARKED', 'TIMER_ENDED', 'EXITING', 'ARRIVED_LOT', 'ASSIGNED']

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const { session, error: sessError } = requireSession(params.id, user!.user_id)
  if (sessError) return sessError
  if (!VALID_EXIT_STATES.includes(session!.state)) {
    return NextResponse.json({ error: `Cannot exit from state: ${session!.state}` }, { status: 409 })
  }
  const now = nowSecs()
  const db = getDb()
  const lot = db.prepare('SELECT hourly_rate, grace_minutes, surcharge_rate FROM lots WHERE id = ?')
    .get(session!.lot_id) as { hourly_rate: number; grace_minutes: number; surcharge_rate: number }
  let charges = { dwell_minutes: 0, over_minutes: 0, base_charge: 0, surcharge: 0, total_charge: 0 }
  if (session!.parked_at) {
    charges = computeCharges({
      parked_at: session!.parked_at, exited_at: now,
      hourly_rate: lot.hourly_rate, booked_minutes: session!.booked_minutes ?? 120,
      grace_minutes: lot.grace_minutes, surcharge_rate: lot.surcharge_rate,
    })
  }
  db.prepare(
    `UPDATE sessions SET state = 'CLOSED', exiting_at = ?, closed_at = ?, actual_minutes = ?,
     base_charge = ?, surcharge = ?, total_charge = ? WHERE id = ?`
  ).run(now, now, charges.dwell_minutes, charges.base_charge, charges.surcharge, charges.total_charge, params.id)
  if (session!.spot_id) await getLotProvider().releaseSpot(session!.spot_id)
  db.prepare(`INSERT INTO events (session_id, user_id, lot_id, event_type, payload, ts) VALUES (?, ?, ?, 'CLOSED', ?, ?)`)
    .run(params.id, user!.user_id, session!.lot_id, JSON.stringify(charges), now)
  if (session!.parked_at) {
    const hour_bucket = new Date(session!.parked_at * 1000).getHours()
    const date = new Date(session!.parked_at * 1000).toISOString().split('T')[0]
    const userData = db.prepare('SELECT age_range, gender FROM users WHERE id = ?')
      .get(user!.user_id) as { age_range: string | null; gender: string | null } | undefined
    recordSessionMetrics(db, {
      date, hour_bucket, lot_id: session!.lot_id,
      age_range: userData?.age_range ?? null, gender: userData?.gender ?? null,
      parked: true, conflict: false, abandoned: false, overstay: charges.over_minutes > 0,
      time_to_spot_ms: session!.assignment_latency_ms, dwell_minutes: charges.dwell_minutes,
      surcharge: charges.surcharge, revenue: charges.total_charge,
    })
  }
  return NextResponse.json({
    session_id: params.id, state: 'CLOSED',
    receipt: { lot_id: session!.lot_id, spot_id: session!.spot_id, parked_at: session!.parked_at,
      exited_at: now, dwell_minutes: charges.dwell_minutes, base_charge: charges.base_charge,
      surcharge: charges.surcharge, total_charge: charges.total_charge, over_minutes: charges.over_minutes },
  })
}
