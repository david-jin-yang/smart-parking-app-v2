import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const session = await getCurrentUser(req)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const db = getDb()
  const user = db.prepare('SELECT id, display_name, age_range, gender FROM users WHERE id = ?')
    .get(session.user_id) as { id: string; display_name: string; age_range: string | null; gender: string | null } | undefined
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  return NextResponse.json({ user })
}
