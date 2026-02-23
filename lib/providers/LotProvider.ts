/**
 * lib/providers/LotProvider.ts
 *
 * The provider abstraction that decouples the parking domain logic
 * from its data source. Switch between sim and hardware by setting:
 *
 *   LOT_PROVIDER=sim      (default — uses SQLite + SimLotProvider)
 *   LOT_PROVIDER=hardware (production — uses HardwareLotProvider)
 *
 * NOTHING outside lib/providers should import SimLotProvider or
 * HardwareLotProvider directly. Always use getLotProvider().
 */

import type {
  Lot,
  LotOccupancy,
  LotLayout,
  AssignSpotParams,
  AssignSpotResult,
  Spot,
} from '../core/types'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface LotProvider {
  /** Return all configured lots */
  getAllLots(): Promise<Lot[]>

  /**
   * Return the full floor/row/spot layout for a single lot.
   * Used to render the spot grid UI and admin heatmaps.
   */
  getLotLayout(lotId: string): Promise<LotLayout>

  /**
   * Return real-time (or sim-time) occupancy counts for a lot.
   * Called frequently — implementors should cache aggressively.
   */
  getOccupancy(lotId: string): Promise<LotOccupancy>

  /**
   * Reserve the best available standard spot for a session.
   * - Must exclude ADA spots entirely.
   * - Must be atomic (no double-assignment under concurrent load).
   * - Returns the reserved spot and a conflict flag.
   */
  assignSpot(params: AssignSpotParams): Promise<AssignSpotResult>

  /**
   * Release a spot back to 'available'.
   * Called on session CLOSED, CANCELLED, ABANDONED, or CONFLICT reassign.
   */
  releaseSpot(spotId: string): Promise<void>

  /**
   * Confirm an external event (hardware webhook or sim event).
   * The provider updates spot status and any internal state accordingly.
   *
   * event_type examples: 'VEHICLE_DETECTED' | 'VEHICLE_EXITED' | 'GATE_OPENED'
   */
  confirmEvent(eventType: string, payload: Record<string, unknown>): Promise<void>
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _provider: LotProvider | null = null

export function getLotProvider(): LotProvider {
  if (_provider) return _provider

  const mode = process.env.LOT_PROVIDER ?? 'sim'

  if (mode === 'sim') {
    // Lazy import to avoid loading better-sqlite3 in edge runtimes
    const { SimLotProvider } = require('./SimLotProvider') as typeof import('./SimLotProvider')
    _provider = new SimLotProvider()
  } else if (mode === 'hardware') {
    const { HardwareLotProvider } = require('./HardwareLotProvider') as typeof import('./HardwareLotProvider')
    _provider = new HardwareLotProvider()
  } else {
    throw new Error(`Unknown LOT_PROVIDER: "${mode}". Valid values: sim | hardware`)
  }

  return _provider
}

/**
 * Reset the singleton — useful in tests to force a fresh provider instance.
 */
export function resetLotProvider(): void {
  _provider = null
}
