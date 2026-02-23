import { NextResponse } from 'next/server'
import { simEngine } from '@/lib/sim/engine'
export async function GET() {
  return NextResponse.json(simEngine.getStatus())
}
