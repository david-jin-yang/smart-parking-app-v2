import { NextRequest, NextResponse } from 'next/server'
import { getLotProvider } from '@/lib/providers/LotProvider'
import getDb from '@/lib/db'

export async function POST(req: NextRequest) {
  let body: { event_type?: string; payload?: Record<string, unknown> }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const { event_type, payload } = body
  if (!event_type) return NextResponse.json({ error: 'event_type is required' }, { status: 400 })
  try {
    const provider = getLotProvider()
    await provider.confirmEvent(event_type, payload ?? {})
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Provider error'
    if (message.includes('Not implemented')) {
      return NextResponse.json({ ok: true, note: 'Hardware provider not active. Set LOT_PROVIDER=hardware to enable.' })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
  try {
    getDb().prepare(`INSERT INTO events (event_type, payload, ts) VALUES (?, ?, ?)`)
      .run(event_type, JSON.stringify(payload ?? {}), Math.floor(Date.now() / 1000))
  } catch { /* non-fatal */ }
  return NextResponse.json({ ok: true, event_type })
}
