/**
 * lib/providers/SimLotProvider.ts
 *
 * Simulation provider. Uses the SQLite spots/lots tables as ground truth.
 * Spot assignment is atomic via a SQLite transaction — no double-booking.
 */

import type { LotProvider } from './LotProvider'
import type {
  Lot,
  LotOccupancy,
  LotLayout,
  FloorLayout,
  RowLayout,
  Spot,
  AssignSpotParams,
  AssignSpotResult,
} from '../core/types'
import getDb from '../db'

export class SimLotProvider implements LotProvider {
  // ── getAllLots ──────────────────────────────────────────────────────────────

  async getAllLots(): Promise<Lot[]> {
    const db = getDb()
    return db.prepare('SELECT * FROM lots ORDER BY name').all() as Lot[]
  }

  // ── getLotLayout ────────────────────────────────────────────────────────────

  async getLotLayout(lotId: string): Promise<LotLayout> {
    const db = getDb()

    const lot = db.prepare('SELECT * FROM lots WHERE id = ?').get(lotId) as Lot | undefined
    if (!lot) throw new Error(`Lot not found: ${lotId}`)

    const spots = db
      .prepare('SELECT * FROM spots WHERE lot_id = ? ORDER BY floor, row, position')
      .all(lotId) as Spot[]

    // Group into floor → row → spots
    const floorMap = new Map<number, Map<number, Spot[]>>()

    for (const spot of spots) {
      if (!floorMap.has(spot.floor)) floorMap.set(spot.floor, new Map())
      const rowMap = floorMap.get(spot.floor)!
      if (!rowMap.has(spot.row)) rowMap.set(spot.row, [])
      rowMap.get(spot.row)!.push(spot)
    }

    const floors: FloorLayout[] = Array.from(floorMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([floor, rowMap]) => ({
        floor,
        rows: Array.from(rowMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([row, rowSpots]) => ({
            row,
            spots: rowSpots,
          } satisfies RowLayout)),
      } satisfies FloorLayout))

    return { lot, floors }
  }

  // ── getOccupancy ────────────────────────────────────────────────────────────

  async getOccupancy(lotId: string): Promise<LotOccupancy> {
    const db = getDb()

    const row = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'available'   THEN 1 ELSE 0 END) as available,
           SUM(CASE WHEN status = 'occupied'    THEN 1 ELSE 0 END) as occupied,
           SUM(CASE WHEN status = 'reserved'    THEN 1 ELSE 0 END) as reserved
         FROM spots
         WHERE lot_id = ? AND spot_type != 'ada'`
      )
      .get(lotId) as { total: number; available: number; occupied: number; reserved: number }

    const in_use = (row.occupied ?? 0) + (row.reserved ?? 0)
    const total = row.total ?? 0

    return {
      lot_id: lotId,
      total,
      available: row.available ?? 0,
      occupied: row.occupied ?? 0,
      reserved: row.reserved ?? 0,
      occupancy_pct: total > 0 ? Math.round((in_use / total) * 100) / 100 : 0,
    }
  }

  // ── assignSpot ──────────────────────────────────────────────────────────────
  //
  // Atomically finds the best available standard spot and marks it 'reserved'.
  // Uses a SQLite transaction so two concurrent requests can't get the same spot.
  //
  // Exclusion rules (hard):
  //   - spot_type = 'ada' → never assigned via app
  //   - status != 'available' → skip

  async assignSpot(params: AssignSpotParams): Promise<AssignSpotResult> {
    const db = getDb()

    const assign = db.transaction((): AssignSpotResult => {
      // Select the first available standard spot (floor/row/position priority)
      const spot = db
        .prepare(
          `SELECT * FROM spots
           WHERE lot_id = ?
             AND status = 'available'
             AND spot_type IN ('standard', 'ev')
           ORDER BY floor ASC, row ASC, position ASC
           LIMIT 1`
        )
        .get(params.lot_id) as Spot | undefined

      if (!spot) {
        throw new NoSpotAvailableError(`No available spots in lot ${params.lot_id}`)
      }

      // Mark reserved — inside the same transaction, so it's atomic
      const changed = db
        .prepare(
          `UPDATE spots
           SET status = 'reserved'
           WHERE id = ? AND status = 'available'`
        )
        .run(spot.id)

      // If 0 rows updated, another request won the race — retry once
      if (changed.changes === 0) {
        const fallback = db
          .prepare(
            `SELECT * FROM spots
             WHERE lot_id = ?
               AND status = 'available'
               AND spot_type IN ('standard', 'ev')
             ORDER BY floor ASC, row ASC, position ASC
             LIMIT 1`
          )
          .get(params.lot_id) as Spot | undefined

        if (!fallback) {
          throw new NoSpotAvailableError(`No available spots in lot ${params.lot_id} (post-race)`)
        }

        db.prepare(`UPDATE spots SET status = 'reserved' WHERE id = ?`).run(fallback.id)

        return {
          spot: { ...fallback, status: 'reserved' },
          conflict_detected: true,
        }
      }

      return {
        spot: { ...spot, status: 'reserved' },
        conflict_detected: false,
      }
    })

    return assign()
  }

  // ── releaseSpot ─────────────────────────────────────────────────────────────

  async releaseSpot(spotId: string): Promise<void> {
    const db = getDb()
    db.prepare(
      `UPDATE spots SET status = 'available' WHERE id = ? AND status IN ('reserved', 'occupied')`
    ).run(spotId)
  }

  // ── confirmEvent ────────────────────────────────────────────────────────────
  //
  // In simulation mode, hardware events are synthesized by the sim engine.
  // This method handles them uniformly so the same API route works in production.

  async confirmEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const db = getDb()

    switch (eventType) {
      case 'VEHICLE_DETECTED': {
        // A vehicle has physically entered a spot → mark occupied
        const spotId = payload.spot_id as string | undefined
        if (spotId) {
          db.prepare(
            `UPDATE spots SET status = 'occupied' WHERE id = ? AND status = 'reserved'`
          ).run(spotId)
        }
        break
      }

      case 'VEHICLE_EXITED': {
        // Vehicle has left the spot → mark available
        const spotId = payload.spot_id as string | undefined
        if (spotId) {
          db.prepare(
            `UPDATE spots SET status = 'available' WHERE id = ? AND status IN ('reserved','occupied')`
          ).run(spotId)
        }
        break
      }

      case 'GATE_OPENED':
      case 'GATE_CLOSED':
        // No spot-level action in sim; log is handled by the API route
        break

      default:
        // Unknown events are silently ignored in sim mode
        // In production, HardwareLotProvider would log/alert
        break
    }
  }
}

// ── Custom error ──────────────────────────────────────────────────────────────

export class NoSpotAvailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoSpotAvailableError'
  }
}
