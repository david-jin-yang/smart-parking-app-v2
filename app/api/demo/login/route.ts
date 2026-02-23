import { NextRequest, NextResponse } from 'next/server'
import getDb from '@/lib/db'
import { signToken, cookieOptions } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const { user_id } = await req.json() as { user_id?: string }
    if (!user_id) {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
    }
    const db = getDb()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id) as
      { id: string; display_name: string } | undefined
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    const token = await signToken({ user_id: user.id, display_name: user.display_name })
    const res = NextResponse.json({ ok: true, user: { id: user.id, display_name: user.display_name } })
    res.cookies.set({ ...cookieOptions(), value: token })
    return res
  } catch {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
