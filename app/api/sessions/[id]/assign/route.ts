import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { getLotProvider } from '@/lib/providers/LotProvider'
import { applyEvent } from '@/lib/core/sessionMachine'
import { requireAuth, requireSession, nowSecs } from '@/lib/sessionHelper'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const { session, error: sessError } = requireSession(params.id, user!.user_id)
  if (sessError) return sessError
  if (session!.state !== 'CREATED' && session!.state !== 'CONFLICT') {
    return NextResponse.json({ error: `Cannot assign from state: ${session!.state}` }, { status: 409 })
  }
  const assignStart = Date.now()
  let assignResult
  try {
    const provider = getLotProvider()
    assignResult = await provider.assignSpot({ lot_id: session!.lot_id, user_id: user!.user_id, session_id: params.id })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'No spots available'
    return NextResponse.json({ error: message }, { status: 409 })
  }
  const now = nowSecs()
  const latency_ms = Date.now() - assignStart
  const eventType = session!.state === 'CONFLICT' ? 'REASSIGN' : 'ASSIGN'
  const { error: machineError } = applyEvent(session!, { type: eventType, ts: now, spot_id: assignResult.spot.id })
  if (machineError) {
    await getLotProvider().releaseSpot(assignResult.spot.id)
    return NextResponse.json({ error: machineError }, { status: 409 })
  }
  const db = getDb()
  db.prepare(
    `UPDATE sessions SET state = 'ASSIGNED', spot_id = ?, assigned_at = ?, assignment_latency_ms = ? WHERE id = ?`
  ).run(assignResult.spot.id, now, latency_ms, params.id)
  db.prepare(
    `INSERT INTO events (session_id, user_id, lot_id, event_type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(params.id, user!.user_id, session!.lot_id,
    assignResult.conflict_detected ? 'REASSIGNED' : 'SPOT_ASSIGNED',
    JSON.stringify({ spot_id: assignResult.spot.id, latency_ms, conflict: assignResult.conflict_detected }), now)
  return NextResponse.json({
    session_id: params.id, state: 'ASSIGNED', spot: assignResult.spot,
    assigned_at: now, assignment_latency_ms: latency_ms, conflict_detected: assignResult.conflict_detected,
  })
}
