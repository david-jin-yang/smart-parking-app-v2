import { NextRequest, NextResponse } from 'next/server'
import { getLotProvider } from '@/lib/providers/LotProvider'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const provider = getLotProvider()
    const [layout, occupancy] = await Promise.all([
      provider.getLotLayout(params.id),
      provider.getOccupancy(params.id),
    ])
    return NextResponse.json({ ...layout, occupancy })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch lot'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
