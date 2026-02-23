import { NextResponse } from 'next/server'
import { simEngine } from '@/lib/sim/engine'
export async function POST() {
  simEngine.reset()
  return NextResponse.json({ ok: true, status: simEngine.getStatus() })
}
