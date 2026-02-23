/**
 * lib/providers/HardwareLotProvider.ts
 *
 * Production provider stub. Implements the LotProvider interface against
 * real hardware: LPR cameras, pressure sensors, gate controllers.
 *
 * To activate: set LOT_PROVIDER=hardware in .env.local
 *
 * Implementation guide:
 *   1. Replace each TODO section with your hardware API client calls.
 *   2. All methods must remain async and return the same types as SimLotProvider.
 *   3. Hardware events arrive via POST /api/hardware/events (see that route).
 *      The HMAC-SHA256 verification belongs in that route, not here.
 *
 * Suggested hardware API surface (REST, operator-provided):
 *   GET  /hardware/lots                      → lot list + config
 *   GET  /hardware/lots/{id}/occupancy       → live sensor counts
 *   GET  /hardware/lots/{id}/layout          → spot grid w/ sensor IDs
 *   POST /hardware/spots/{id}/reserve        → reserve spot (opens gate lane)
 *   POST /hardware/spots/{id}/release        → release spot
 *   POST /hardware/events                    → inbound event webhook
 */

import type { LotProvider } from './LotProvider'
import type {
  Lot,
  LotOccupancy,
  LotLayout,
  AssignSpotParams,
  AssignSpotResult,
} from '../core/types'

export class HardwareLotProvider implements LotProvider {
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor() {
    // TODO: load from env
    this.baseUrl = process.env.HARDWARE_API_URL ?? 'https://hardware.example.com'
    this.apiKey = process.env.HARDWARE_API_KEY ?? ''

    if (!this.apiKey) {
      console.warn('[HardwareLotProvider] HARDWARE_API_KEY is not set')
    }
  }

  // ── getAllLots ──────────────────────────────────────────────────────────────

  async getAllLots(): Promise<Lot[]> {
    // TODO: Replace with real API call
    // const res = await fetch(`${this.baseUrl}/lots`, {
    //   headers: { Authorization: `Bearer ${this.apiKey}` },
    // })
    // const data = await res.json()
    // return data.lots.map(mapHardwareLotToLot)

    throw new NotImplementedError('HardwareLotProvider.getAllLots')
  }

  // ── getLotLayout ────────────────────────────────────────────────────────────

  async getLotLayout(lotId: string): Promise<LotLayout> {
    // TODO: Replace with real API call
    // GET /hardware/lots/{lotId}/layout
    // Map sensor IDs to spot positions in the response transform.
    //
    // NOTE: Indoor positioning won't give you exact GPS coords per spot.
    // The layout is typically floor plans from the lot operator.
    // Store the mapping (sensor_id → spot_id) in a config file or DB table.

    throw new NotImplementedError(`HardwareLotProvider.getLotLayout(${lotId})`)
  }

  // ── getOccupancy ────────────────────────────────────────────────────────────

  async getOccupancy(lotId: string): Promise<LotOccupancy> {
    // TODO: Replace with real API call
    // GET /hardware/lots/{lotId}/occupancy
    //
    // Caching recommendation: cache for 5-10 seconds.
    // Sensor updates are typically push (webhook) not poll-based.
    // Consider maintaining a local in-memory cache that gets invalidated
    // by VEHICLE_DETECTED / VEHICLE_EXITED webhook events.

    throw new NotImplementedError(`HardwareLotProvider.getOccupancy(${lotId})`)
  }

  // ── assignSpot ──────────────────────────────────────────────────────────────

  async assignSpot(params: AssignSpotParams): Promise<AssignSpotResult> {
    // TODO: Replace with real gate/reservation API
    // POST /hardware/spots/reserve
    // Body: { lot_id, session_id, user_id }
    //
    // The hardware API should:
    //   1. Find the best available spot (same priority: floor/row/position)
    //   2. Mark it reserved in the hardware system
    //   3. Optionally open a specific gate lane or display spot number on signage
    //   4. Return the reserved spot details
    //
    // The hardware system is the authoritative source of spot availability —
    // do NOT also update the local SQLite spots table unless you're mirroring it.
    // If you mirror, make sure hardware webhook events keep the mirror in sync.

    throw new NotImplementedError(`HardwareLotProvider.assignSpot(${params.lot_id})`)
  }

  // ── releaseSpot ─────────────────────────────────────────────────────────────

  async releaseSpot(spotId: string): Promise<void> {
    // TODO: Replace with real API call
    // POST /hardware/spots/{spotId}/release
    //
    // This should signal the gate controller that the spot is now available,
    // update electronic signage, and clear any barrier that was set.

    throw new NotImplementedError(`HardwareLotProvider.releaseSpot(${spotId})`)
  }

  // ── confirmEvent ────────────────────────────────────────────────────────────

  async confirmEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    // TODO: Handle inbound events from hardware webhooks
    //
    // This is called by POST /api/hardware/events after HMAC verification.
    // Update your local state / mirror tables based on the event.
    //
    // Common event types from hardware:
    //   VEHICLE_DETECTED  → payload: { sensor_id, spot_id, lot_id, ts }
    //   VEHICLE_EXITED    → payload: { sensor_id, spot_id, lot_id, ts }
    //   GATE_OPENED       → payload: { gate_id, lot_id, session_id, ts }
    //   GATE_CLOSED       → payload: { gate_id, lot_id, ts }
    //   SENSOR_FAULT      → payload: { sensor_id, fault_code, ts }
    //
    // For SENSOR_FAULT, alert the lot operator and mark affected spots 'maintenance'.

    throw new NotImplementedError(`HardwareLotProvider.confirmEvent(${eventType})`)
  }
}

// ── Error type ────────────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`[HardwareLotProvider] Not implemented: ${method}. Set LOT_PROVIDER=sim for demo mode.`)
    this.name = 'NotImplementedError'
  }
}
