import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { getLotProvider } from '@/lib/providers/LotProvider'
import { requireAuth, requireSession, nowSecs } from '@/lib/sessionHelper'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const { session, error: sessError } = requireSession(params.id, user!.user_id)
  if (sessError) return sessError
  if (session!.state !== 'ARRIVED_LOT') {
    return NextResponse.json({ error: `Cannot park from state: ${session!.state}` }, { status: 409 })
  }
  const now = nowSecs()
  const db = getDb()
  const lot = db.prepare('SELECT hourly_rate, grace_minutes, surcharge_rate FROM lots WHERE id = ?')
    .get(session!.lot_id) as { hourly_rate: number; grace_minutes: number; surcharge_rate: number }
  const booked_minutes = session!.booked_minutes ?? 120
  const timer_end_at = now + booked_minutes * 60
  const grace_end_at = timer_end_at + lot.grace_minutes * 60
  const base_charge = Math.ceil((booked_minutes / 60) * lot.hourly_rate * 100) / 100
  db.prepare(
    `UPDATE sessions SET state = 'PARKED', parked_at = ?, timer_end_at = ?, grace_end_at = ?, base_charge = ? WHERE id = ?`
  ).run(now, timer_end_at, grace_end_at, base_charge, params.id)
  if (session!.spot_id) {
    await getLotProvider().confirmEvent('VEHICLE_DETECTED', { spot_id: session!.spot_id, lot_id: session!.lot_id })
  }
  db.prepare(`INSERT INTO events (session_id, user_id, lot_id, event_type, payload, ts) VALUES (?, ?, ?, 'PARKED', ?, ?)`)
    .run(params.id, user!.user_id, session!.lot_id, JSON.stringify({ timer_end_at, grace_end_at, base_charge }), now)
  return NextResponse.json({ session_id: params.id, state: 'PARKED', spot_id: session!.spot_id,
    parked_at: now, timer_end_at, grace_end_at, booked_minutes, base_charge })
}
