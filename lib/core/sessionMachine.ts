/**
 * lib/core/sessionMachine.ts
 *
 * Pure state machine for parking sessions.
 * Zero I/O — all functions are deterministic given their inputs.
 * This makes the logic fully unit-testable without a DB or provider.
 *
 * Charge formula (from spec):
 *   base_charge  = ceil((dwell_minutes / 60) * hourly_rate, 2dp)
 *   over_minutes = max(0, dwell_minutes - booked_minutes - grace_minutes)
 *   surcharge    = floor(over_minutes / 15) * surcharge_rate
 *   total        = base_charge + surcharge
 */

import type {
  Session,
  SessionState,
  SessionEvent,
  SessionEventType,
  ChargeInput,
  ChargeBreakdown,
} from './types'

// ── Valid transitions ─────────────────────────────────────────────────────────
//
// Map of: fromState → Set of valid toStates
// Only explicit entries are allowed — anything else throws.

const TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ARRIVED_LOT', 'CONFLICT', 'CANCELLED'],
  CONFLICT: ['ASSIGNED', 'CANCELLED'],       // reassign attempt after conflict
  ARRIVED_LOT: ['PARKED', 'ABANDONED', 'CANCELLED'],
  PARKED: ['TIMER_ENDED', 'EXITING'],        // EXITING = early exit
  TIMER_ENDED: ['EXITING'],
  EXITING: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
  ABANDONED: [],
}

// Map SessionEventType → expected target state (used by applyEvent)
const EVENT_TO_STATE: Record<SessionEventType, SessionState> = {
  ASSIGN: 'ASSIGNED',
  REASSIGN: 'ASSIGNED',
  ARRIVE_LOT: 'ARRIVED_LOT',
  PARK: 'PARKED',
  TIMER_END: 'TIMER_ENDED',
  EXIT: 'EXITING',
  CANCEL: 'CANCELLED',
  CONFLICT: 'CONFLICT',
  ABANDON: 'ABANDONED',
}

// ── canTransition ─────────────────────────────────────────────────────────────

/**
 * Returns true if transitioning from `from` to `to` is valid.
 * Does NOT throw — safe to use in conditionals.
 */
export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

// ── applyEvent ────────────────────────────────────────────────────────────────

export interface ApplyEventResult {
  /** Updated session snapshot (original is not mutated) */
  nextSession: Session
  /** Event types that should be persisted to the events log */
  emittedEvents: Array<{ event_type: string; payload: Record<string, unknown> }>
  /** Human-readable error if transition was rejected */
  error?: string
}

/**
 * Applies a domain event to a session, returning the next session state.
 * Never mutates the input session.
 * Returns an error (not throws) for invalid transitions so callers can
 * handle gracefully.
 */
export function applyEvent(session: Session, event: SessionEvent): ApplyEventResult {
  const targetState = EVENT_TO_STATE[event.type]

  if (!canTransition(session.state, targetState)) {
    return {
      nextSession: session,
      emittedEvents: [],
      error: `Invalid transition: ${session.state} → ${targetState} (event: ${event.type})`,
    }
  }

  // Build the state update patch
  const patch: Partial<Session> = { state: targetState }
  const emittedEvents: ApplyEventResult['emittedEvents'] = []

  switch (event.type) {
    case 'ASSIGN':
    case 'REASSIGN': {
      patch.assigned_at = event.ts
      patch.spot_id = event.spot_id ?? session.spot_id
      patch.assignment_latency_ms = session.created_at
        ? (event.ts - session.created_at) * 1000  // seconds → ms (sim uses second precision)
        : null
      emittedEvents.push({
        event_type: event.type === 'REASSIGN' ? 'REASSIGNED' : 'SPOT_ASSIGNED',
        payload: { spot_id: patch.spot_id, latency_ms: patch.assignment_latency_ms },
      })
      break
    }

    case 'ARRIVE_LOT': {
      patch.arrived_lot_at = event.ts
      emittedEvents.push({ event_type: 'ARRIVED_LOT', payload: {} })
      break
    }

    case 'PARK': {
      patch.parked_at = event.ts
      // timer_end_at is set by caller (booked_minutes comes from the session)
      const timerEndAt = event.ts + session.booked_minutes * 60
      const graceEndAt = timerEndAt + 10 * 60  // default grace; caller can override
      patch.timer_end_at = timerEndAt
      patch.grace_end_at = graceEndAt
      emittedEvents.push({
        event_type: 'PARKED',
        payload: { timer_end_at: timerEndAt, grace_end_at: graceEndAt },
      })
      break
    }

    case 'TIMER_END': {
      patch.timer_ended_at = event.ts
      emittedEvents.push({ event_type: 'TIMER_ENDED', payload: {} })
      break
    }

    case 'EXIT': {
      patch.exiting_at = event.ts
      emittedEvents.push({ event_type: 'EXITING', payload: {} })
      break
    }

    case 'CONFLICT': {
      emittedEvents.push({
        event_type: 'CONFLICT',
        payload: { original_spot_id: session.spot_id },
      })
      break
    }

    case 'CANCEL': {
      emittedEvents.push({ event_type: 'CANCELLED', payload: {} })
      break
    }

    case 'ABANDON': {
      emittedEvents.push({ event_type: 'ABANDONED', payload: {} })
      break
    }
  }

  return {
    nextSession: { ...session, ...patch },
    emittedEvents,
  }
}

// ── computeCharges ────────────────────────────────────────────────────────────

/**
 * Pure charge calculation. No rounding surprises — uses integer arithmetic
 * where possible, then rounds only at output boundaries.
 *
 * Formula:
 *   dwell_minutes  = ceil((exited_at - parked_at) / 60)
 *   base_charge    = ceil((dwell_minutes / 60) * hourly_rate * 100) / 100
 *   over_minutes   = max(0, dwell_minutes - booked_minutes - grace_minutes)
 *   surcharge      = floor(over_minutes / 15) * surcharge_rate
 *   total          = round(base_charge + surcharge, 2)
 */
export function computeCharges(input: ChargeInput): ChargeBreakdown {
  const {
    parked_at,
    exited_at,
    hourly_rate,
    booked_minutes,
    grace_minutes,
    surcharge_rate,
  } = input

  // Dwell in whole minutes, rounded up (1 second over = 1 extra minute)
  const dwell_seconds = Math.max(0, exited_at - parked_at)
  const dwell_minutes = Math.ceil(dwell_seconds / 60)

  // Base charge: round up to nearest cent
  const base_charge = Math.ceil((dwell_minutes / 60) * hourly_rate * 100) / 100

  // Overstay: only counts after booked window + grace
  const over_minutes = Math.max(0, dwell_minutes - booked_minutes - grace_minutes)

  // Surcharge: whole 15-min intervals only
  const surcharge = Math.floor(over_minutes / 15) * surcharge_rate

  // Total: round to 2dp to avoid floating point drift
  const total_charge = Math.round((base_charge + surcharge) * 100) / 100

  return { dwell_minutes, over_minutes, base_charge, surcharge, total_charge }
}

// ── closeSession ──────────────────────────────────────────────────────────────

/**
 * Convenience: applies EXIT then CLOSE to a session and computes charges.
 * Returns the fully closed session snapshot.
 * Caller is responsible for persisting to DB.
 */
export function closeSession(
  session: Session,
  exitTs: number,
  lot: { hourly_rate: number; grace_minutes: number; surcharge_rate: number }
): { closedSession: Session; charges: ChargeBreakdown; emittedEvents: ApplyEventResult['emittedEvents'] } {
  // Step 1: EXITING
  const exitResult = applyEvent(session, { type: 'EXIT', ts: exitTs })
  if (exitResult.error) {
    throw new Error(exitResult.error)
  }

  // Step 2: CLOSED
  const closeResult = applyEvent(exitResult.nextSession, {
    type: 'EXIT',  // no CLOSE event type; we manually set state
    ts: exitTs,
  })

  // Manually force CLOSED state (EXIT → CLOSED is the next step)
  const parked_at = session.parked_at ?? exitTs

  const charges = computeCharges({
    parked_at,
    exited_at: exitTs,
    hourly_rate: lot.hourly_rate,
    booked_minutes: session.booked_minutes,
    grace_minutes: lot.grace_minutes,
    surcharge_rate: lot.surcharge_rate,
  })

  const closedSession: Session = {
    ...exitResult.nextSession,
    state: 'CLOSED',
    closed_at: exitTs,
    actual_minutes: charges.dwell_minutes,
    base_charge: charges.base_charge,
    surcharge: charges.surcharge,
    total_charge: charges.total_charge,
  }

  const allEvents = [
    ...exitResult.emittedEvents,
    {
      event_type: 'CLOSED',
      payload: {
        dwell_minutes: charges.dwell_minutes,
        base_charge: charges.base_charge,
        surcharge: charges.surcharge,
        total_charge: charges.total_charge,
      },
    },
  ]

  return { closedSession, charges, emittedEvents: allEvents }
}

// ── isOverstay ────────────────────────────────────────────────────────────────

/** Returns true if the session has exceeded booked_minutes + grace */
export function isOverstay(session: Session, nowTs: number): boolean {
  if (!session.parked_at) return false
  const graceEnd = session.grace_end_at
    ?? (session.parked_at + (session.booked_minutes + 10) * 60)
  return nowTs > graceEnd
}

/** Returns minutes of overstay (0 if none) */
export function overstayMinutes(session: Session, nowTs: number): number {
  if (!session.parked_at) return 0
  const graceEnd = session.grace_end_at
    ?? (session.parked_at + (session.booked_minutes + 10) * 60)
  return Math.max(0, Math.ceil((nowTs - graceEnd) / 60))
}
