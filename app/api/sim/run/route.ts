import { NextRequest, NextResponse } from 'next/server'
import { simEngine, DEFAULT_PARAMS } from '@/lib/sim/engine'
import type { SimParams } from '@/lib/sim/engine'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as Partial<SimParams>
    const params: Partial<SimParams> = {
      seed: body.seed ?? DEFAULT_PARAMS.seed,
      speed_multiplier: body.speed_multiplier ?? DEFAULT_PARAMS.speed_multiplier,
      user_count: body.user_count ?? DEFAULT_PARAMS.user_count,
      sim_day_hours: body.sim_day_hours ?? DEFAULT_PARAMS.sim_day_hours,
      non_app_pct: body.non_app_pct ?? DEFAULT_PARAMS.non_app_pct,
      conflict_pct: body.conflict_pct ?? DEFAULT_PARAMS.conflict_pct,
      event_mode: body.event_mode ?? DEFAULT_PARAMS.event_mode,
      eta_threshold_minutes: body.eta_threshold_minutes ?? DEFAULT_PARAMS.eta_threshold_minutes,
    }
    const run_id = simEngine.start(params)
    return NextResponse.json({ ok: true, run_id, status: simEngine.getStatus() })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to start simulation'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
