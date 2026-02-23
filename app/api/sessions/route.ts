import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import getDb from '@/lib/db'
import { requireAuth, nowSecs } from '@/lib/sessionHelper'

export async function POST(req: NextRequest) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const { lot_id } = await req.json() as { lot_id?: string }
  if (!lot_id) return NextResponse.json({ error: 'lot_id is required' }, { status: 400 })
  const db = getDb()
  const lot = db.prepare('SELECT id FROM lots WHERE id = ?').get(lot_id)
  if (!lot) return NextResponse.json({ error: 'Lot not found' }, { status: 404 })
  const existing = db.prepare(
    `SELECT id FROM sessions WHERE user_id = ? AND state NOT IN ('CLOSED','CANCELLED','ABANDONED') LIMIT 1`
  ).get(user!.user_id)
  if (existing) {
    return NextResponse.json(
      { error: 'You already have an active session', session_id: (existing as { id: string }).id },
      { status: 409 }
    )
  }
  const session_id = `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const now = nowSecs()
  db.prepare(
    `INSERT INTO sessions (id, user_id, lot_id, state, created_at, booked_minutes, surcharge, is_synthetic)
     VALUES (?, ?, ?, 'CREATED', ?, 120, 0, 0)`
  ).run(session_id, user!.user_id, lot_id, now)
  db.prepare(
    `INSERT INTO events (session_id, user_id, lot_id, event_type, ts) VALUES (?, ?, ?, 'SESSION_CREATED', ?)`
  ).run(session_id, user!.user_id, lot_id, now)
  return NextResponse.json({ session_id, state: 'CREATED', lot_id, created_at: now }, { status: 201 })
}

export async function GET(req: NextRequest) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const db = getDb()
  const session = db.prepare(
    `SELECT * FROM sessions WHERE user_id = ? AND state NOT IN ('CLOSED','CANCELLED','ABANDONED') ORDER BY created_at DESC LIMIT 1`
  ).get(user!.user_id)
  return NextResponse.json({ session: session ?? null })
}
