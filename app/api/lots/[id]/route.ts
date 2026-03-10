import { NextRequest, NextResponse } from 'next/server'
import { getLotProvider } from '@/lib/providers/LotProvider'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const provider = getLotProvider()
    const [layout, occupancy] = await Promise.all([
      provider.getLotLayout(params.id),
      provider.getOccupancy(params.id),
    ])

    // Flatten nested floors → rows → spots into a flat array for the grid
    const spots = layout.floors.flatMap(f =>
      f.rows.flatMap(r =>
        r.spots.map(s => ({
          id: s.id,
          floor: s.floor,
          row: s.row,
          position: s.position,
          spot_type: s.spot_type,
          status: s.status,
        }))
      )
    )

    return NextResponse.json({ lot: layout.lot, floors: layout.floors, spots, occupancy })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch lot'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
