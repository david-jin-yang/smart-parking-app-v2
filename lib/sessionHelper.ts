/**
 * lib/sessionHelper.ts
 *
 * Shared helpers for session API routes.
 * Keeps individual route files lean.
 */

import { NextRequest, NextResponse } from 'next/server'
import getDb from './db'
import { getCurrentUser } from './auth'
import type { Session } from './core/types'

export async function requireAuth(req: NextRequest) {
  const user = await getCurrentUser(req)
  if (!user) {
    return { user: null, error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  }
  return { user, error: null }
}

export function getSession(sessionId: string): Session | null {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | null
}

export function requireSession(
  sessionId: string,
  userId: string
): { session: Session | null; error: NextResponse | null } {
  const session = getSession(sessionId)
  if (!session) {
    return { session: null, error: NextResponse.json({ error: 'Session not found' }, { status: 404 }) }
  }
  if (session.user_id !== userId) {
    return { session: null, error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { session, error: null }
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}
