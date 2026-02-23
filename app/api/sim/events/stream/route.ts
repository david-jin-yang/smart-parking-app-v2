import { NextResponse } from 'next/server'
import { simEngine } from '@/lib/sim/engine'
import type { SimEvent, OccupancySnapshot } from '@/lib/sim/engine'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const encoder = new TextEncoder()
  function encode(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encode('status', simEngine.getStatus()))
      const onEvent = (event: SimEvent) => {
        try { controller.enqueue(encode('sim_event', event)) } catch { cleanup() }
      }
      const onOccupancy = (snapshot: OccupancySnapshot) => {
        try { controller.enqueue(encode('occupancy', snapshot)) } catch { cleanup() }
      }
      const onStatus = (status: ReturnType<typeof simEngine.getStatus>) => {
        try { controller.enqueue(encode('status', status)) } catch { cleanup() }
      }
      simEngine.on('event', onEvent)
      simEngine.on('occupancy', onOccupancy)
      simEngine.on('status', onStatus)
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': heartbeat\n\n')) } catch { cleanup() }
      }, 15000)
      function cleanup() {
        simEngine.off('event', onEvent)
        simEngine.off('occupancy', onOccupancy)
        simEngine.off('status', onStatus)
        clearInterval(heartbeat)
        try { controller.close() } catch { /* already closed */ }
      }
    },
  })
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
