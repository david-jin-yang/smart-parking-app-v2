import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requireSession } from '@/lib/sessionHelper'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { user, error } = await requireAuth(req)
  if (error) return error
  const { session, error: sessError } = requireSession(params.id, user!.user_id)
  if (sessError) return sessError
  return NextResponse.json({ session })
}
