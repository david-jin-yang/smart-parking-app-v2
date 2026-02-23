import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { requireAuth, requireSession, nowSecs } from '@/lib/sessionHelper'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const { session, error: sessError } = requireSession(params.id, user!.user_id)
  if (sessError) return sessError
  if (session!.state !== 'ASSIGNED') {
    return NextResponse.json({ error: `Cannot arrive from state: ${session!.state}` }, { status: 409 })
  }
  const now = nowSecs()
  const db = getDb()
  db.prepare(`UPDATE sessions SET state = 'ARRIVED_LOT', arrived_lot_at = ? WHERE id = ?`).run(now, params.id)
  db.prepare(`INSERT INTO events (session_id, user_id, lot_id, event_type, ts) VALUES (?, ?, ?, 'ARRIVED_LOT', ?)`)
    .run(params.id, user!.user_id, session!.lot_id, now)
  return NextResponse.json({ session_id: params.id, state: 'ARRIVED_LOT', arrived_lot_at: now, spot: { id: session!.spot_id } })
}
