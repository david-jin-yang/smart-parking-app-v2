import { NextResponse } from 'next/server'
import { getLotProvider } from '@/lib/providers/LotProvider'

export async function GET() {
  try {
    const provider = getLotProvider()
    const lots = await provider.getAllLots()
    const lotsWithOccupancy = await Promise.all(
      lots.map(async (lot) => {
        const occ = await provider.getOccupancy(lot.id)
        return { ...lot, occupancy: occ }
      })
    )
    return NextResponse.json({ lots: lotsWithOccupancy })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch lots' }, { status: 500 })
  }
}
