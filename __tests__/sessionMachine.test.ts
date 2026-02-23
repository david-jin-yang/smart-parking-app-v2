/**
 * __tests__/sessionMachine.test.ts
 *
 * Unit tests for lib/core/sessionMachine.ts
 * Zero I/O — no DB, no provider.
 *
 * Run: npm test
 */

import {
  canTransition,
  applyEvent,
  computeCharges,
  closeSession,
  isOverstay,
  overstayMinutes,
} from '../lib/core/sessionMachine'
import type { Session, SessionState, ChargeInput } from '../lib/core/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_test_001',
    user_id: 'user_000001',
    lot_id: 'lot_century_city',
    spot_id: null,
    state: 'CREATED',
    created_at: 1700000000,
    assigned_at: null,
    arrived_lot_at: null,
    parked_at: null,
    timer_end_at: null,
    timer_ended_at: null,
    grace_end_at: null,
    exiting_at: null,
    closed_at: null,
    booked_minutes: 120,
    actual_minutes: null,
    base_charge: null,
    surcharge: 0,
    total_charge: null,
    is_synthetic: 0,
    assignment_latency_ms: null,
    ...overrides,
  }
}

const BASE_LOT = {
  hourly_rate: 3.0,
  grace_minutes: 10,
  surcharge_rate: 5.0,
}

// ── canTransition ─────────────────────────────────────────────────────────────

describe('canTransition', () => {
  describe('valid transitions', () => {
    const valid: [SessionState, SessionState][] = [
      ['CREATED', 'ASSIGNED'],
      ['CREATED', 'CANCELLED'],
      ['ASSIGNED', 'ARRIVED_LOT'],
      ['ASSIGNED', 'CONFLICT'],
      ['ASSIGNED', 'CANCELLED'],
      ['CONFLICT', 'ASSIGNED'],
      ['CONFLICT', 'CANCELLED'],
      ['ARRIVED_LOT', 'PARKED'],
      ['ARRIVED_LOT', 'ABANDONED'],
      ['ARRIVED_LOT', 'CANCELLED'],
      ['PARKED', 'TIMER_ENDED'],
      ['PARKED', 'EXITING'],      // early exit
      ['TIMER_ENDED', 'EXITING'],
      ['EXITING', 'CLOSED'],
    ]

    test.each(valid)('%s → %s is valid', (from, to) => {
      expect(canTransition(from, to)).toBe(true)
    })
  })

  describe('invalid transitions', () => {
    const invalid: [SessionState, SessionState][] = [
      ['CREATED', 'PARKED'],
      ['CREATED', 'CLOSED'],
      ['ASSIGNED', 'PARKED'],
      ['ARRIVED_LOT', 'ASSIGNED'],
      ['PARKED', 'CREATED'],
      ['PARKED', 'ASSIGNED'],
      ['CLOSED', 'CREATED'],
      ['CLOSED', 'PARKED'],
      ['CANCELLED', 'ASSIGNED'],
      ['ABANDONED', 'PARKED'],
      ['TIMER_ENDED', 'PARKED'],
    ]

    test.each(invalid)('%s → %s is invalid', (from, to) => {
      expect(canTransition(from, to)).toBe(false)
    })
  })

  test('terminal states have no valid outgoing transitions', () => {
    const terminals: SessionState[] = ['CLOSED', 'CANCELLED', 'ABANDONED']
    const allStates: SessionState[] = [
      'CREATED', 'ASSIGNED', 'ARRIVED_LOT', 'PARKED',
      'TIMER_ENDED', 'EXITING', 'CLOSED', 'CANCELLED', 'CONFLICT', 'ABANDONED',
    ]
    for (const terminal of terminals) {
      for (const target of allStates) {
        expect(canTransition(terminal, target)).toBe(false)
      }
    }
  })
})

// ── applyEvent ────────────────────────────────────────────────────────────────

describe('applyEvent', () => {
  test('ASSIGN sets assigned_at, spot_id, state', () => {
    const session = makeSession()
    const ts = 1700000100

    const { nextSession, emittedEvents, error } = applyEvent(session, {
      type: 'ASSIGN',
      ts,
      spot_id: 'lot_cc_F1_R1_S03',
    })

    expect(error).toBeUndefined()
    expect(nextSession.state).toBe('ASSIGNED')
    expect(nextSession.assigned_at).toBe(ts)
    expect(nextSession.spot_id).toBe('lot_cc_F1_R1_S03')
    expect(emittedEvents[0].event_type).toBe('SPOT_ASSIGNED')
  })

  test('REASSIGN emits REASSIGNED event type', () => {
    const session = makeSession({ state: 'CONFLICT', spot_id: 'old_spot' })
    const { nextSession, emittedEvents } = applyEvent(session, {
      type: 'REASSIGN',
      ts: 1700000200,
      spot_id: 'new_spot',
    })

    expect(nextSession.state).toBe('ASSIGNED')
    expect(nextSession.spot_id).toBe('new_spot')
    expect(emittedEvents[0].event_type).toBe('REASSIGNED')
  })

  test('PARK sets parked_at and timer_end_at based on booked_minutes', () => {
    const session = makeSession({
      state: 'ARRIVED_LOT',
      arrived_lot_at: 1700001000,
      spot_id: 'lot_cc_F1_R2_S05',
    })
    const ts = 1700001500 // 500 seconds after arrival

    const { nextSession } = applyEvent(session, { type: 'PARK', ts })

    expect(nextSession.state).toBe('PARKED')
    expect(nextSession.parked_at).toBe(ts)
    // timer_end_at = ts + 120 min * 60 = ts + 7200
    expect(nextSession.timer_end_at).toBe(ts + 7200)
    // grace_end_at = timer_end_at + 600
    expect(nextSession.grace_end_at).toBe(ts + 7800)
  })

  test('invalid event returns error without mutating session', () => {
    const session = makeSession({ state: 'CREATED' })

    const { nextSession, error } = applyEvent(session, { type: 'PARK', ts: 1700000000 })

    expect(error).toMatch(/Invalid transition/)
    expect(nextSession.state).toBe('CREATED')   // not mutated
    expect(nextSession).toBe(session)            // same reference (original returned)
  })

  test('EXIT from PARKED (early exit) is valid', () => {
    const session = makeSession({
      state: 'PARKED',
      parked_at: 1700000000,
    })

    const { nextSession, error } = applyEvent(session, { type: 'EXIT', ts: 1700003600 })

    expect(error).toBeUndefined()
    expect(nextSession.state).toBe('EXITING')
    expect(nextSession.exiting_at).toBe(1700003600)
  })

  test('EXIT from TIMER_ENDED is valid', () => {
    const session = makeSession({
      state: 'TIMER_ENDED',
      parked_at: 1700000000,
      timer_ended_at: 1700007200,
    })

    const { error, nextSession } = applyEvent(session, { type: 'EXIT', ts: 1700007500 })

    expect(error).toBeUndefined()
    expect(nextSession.state).toBe('EXITING')
  })

  test('CONFLICT emits event with original spot_id', () => {
    const session = makeSession({
      state: 'ASSIGNED',
      spot_id: 'original_spot',
    })

    const { nextSession, emittedEvents } = applyEvent(session, {
      type: 'CONFLICT',
      ts: 1700000200,
    })

    expect(nextSession.state).toBe('CONFLICT')
    expect(emittedEvents[0].event_type).toBe('CONFLICT')
    expect(emittedEvents[0].payload.original_spot_id).toBe('original_spot')
  })

  test('assignment_latency_ms is computed from created_at', () => {
    const session = makeSession({ created_at: 1700000000 })
    const ts = 1700000045 // 45 seconds later

    const { nextSession } = applyEvent(session, {
      type: 'ASSIGN',
      ts,
      spot_id: 'lot_cc_F1_R1_S01',
    })

    // latency = (45000) ms — session machine stores seconds * 1000
    expect(nextSession.assignment_latency_ms).toBe(45000)
  })
})

// ── computeCharges ────────────────────────────────────────────────────────────

describe('computeCharges', () => {
  function makeChargeInput(overrides: Partial<ChargeInput> = {}): ChargeInput {
    return {
      parked_at: 1700000000,
      exited_at: 1700007200,   // exactly 120 min default
      hourly_rate: 3.0,
      booked_minutes: 120,
      grace_minutes: 10,
      surcharge_rate: 5.0,
      ...overrides,
    }
  }

  // ── Basic cases ─────────────────────────────────────────────────────────────

  test('exactly 120 min → base=$6.00, no surcharge', () => {
    const result = computeCharges(makeChargeInput())
    expect(result.dwell_minutes).toBe(120)
    expect(result.over_minutes).toBe(0)
    expect(result.base_charge).toBe(6.00)
    expect(result.surcharge).toBe(0)
    expect(result.total_charge).toBe(6.00)
  })

  test('30 min session → $1.50', () => {
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 1800,  // 30 min
    }))
    expect(result.dwell_minutes).toBe(30)
    expect(result.base_charge).toBe(1.50)
    expect(result.surcharge).toBe(0)
    expect(result.total_charge).toBe(1.50)
  })

  test('1 second session → ceil to 1 minute → $0.05', () => {
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 1,  // 1 second
    }))
    expect(result.dwell_minutes).toBe(1)
    expect(result.base_charge).toBe(0.05)
    expect(result.total_charge).toBe(0.05)
  })

  test('zero dwell → 0 charge', () => {
    const result = computeCharges(makeChargeInput({
      parked_at: 1700000000,
      exited_at: 1700000000,
    }))
    expect(result.dwell_minutes).toBe(0)
    expect(result.base_charge).toBe(0)
    expect(result.total_charge).toBe(0)
  })

  // ── Surcharge boundary tests ─────────────────────────────────────────────────

  test('120 min booked + 10 min grace = at boundary, no surcharge', () => {
    // Exits exactly at grace end: 120 + 10 = 130 min
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 130 * 60,
    }))
    expect(result.dwell_minutes).toBe(130)
    expect(result.over_minutes).toBe(0)
    expect(result.surcharge).toBe(0)
    // base: ceil(130/60 * 3.0 * 100) / 100 = ceil(6.5 * 100)/100 = 650/100 = 6.50
    expect(result.base_charge).toBe(6.50)
    expect(result.total_charge).toBe(6.50)
  })

  test('1 minute past grace (131 min) → over_minutes=1, no surcharge yet', () => {
    // over_minutes = 1, but floor(1/15) = 0, so still no surcharge
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 131 * 60,
    }))
    expect(result.over_minutes).toBe(1)
    expect(result.surcharge).toBe(0)
  })

  test('14 min past grace → over_minutes=14, still 0 surcharge intervals', () => {
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 144 * 60,
    }))
    expect(result.over_minutes).toBe(14)
    expect(result.surcharge).toBe(0)
  })

  test('exactly 15 min past grace → 1 surcharge interval = $5.00', () => {
    // dwell = 120 + 10 + 15 = 145 min
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 145 * 60,
    }))
    expect(result.over_minutes).toBe(15)
    expect(result.surcharge).toBe(5.00)
    expect(result.total_charge).toBe(result.base_charge + 5.00)
  })

  test('30 min past grace → 2 surcharge intervals = $10.00', () => {
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 160 * 60,  // 120+10+30
    }))
    expect(result.over_minutes).toBe(30)
    expect(result.surcharge).toBe(10.00)
  })

  test('29 min past grace → 1 interval only (floor, not round)', () => {
    const result = computeCharges(makeChargeInput({
      exited_at: 1700000000 + 159 * 60,  // 120+10+29
    }))
    expect(result.over_minutes).toBe(29)
    expect(result.surcharge).toBe(5.00)   // floor(29/15) = 1
  })

  // ── Different lot rates ──────────────────────────────────────────────────────

  test('Glendale rate $2.50/hr, 90 min session', () => {
    const result = computeCharges({
      parked_at: 1700000000,
      exited_at: 1700000000 + 90 * 60,
      hourly_rate: 2.5,
      booked_minutes: 120,
      grace_minutes: 10,
      surcharge_rate: 4.0,
    })
    // base = ceil(90/60 * 2.5 * 100) / 100 = ceil(375) / 100 = 3.75
    expect(result.base_charge).toBe(3.75)
    expect(result.surcharge).toBe(0)
    expect(result.total_charge).toBe(3.75)
  })

  test('Pasadena rate $2.00/hr, 15 min grace, 145 min session', () => {
    // over_minutes = 145 - 120 - 15 = 10 → no surcharge interval
    const result = computeCharges({
      parked_at: 1700000000,
      exited_at: 1700000000 + 145 * 60,
      hourly_rate: 2.0,
      booked_minutes: 120,
      grace_minutes: 15,
      surcharge_rate: 3.0,
    })
    expect(result.over_minutes).toBe(10)
    expect(result.surcharge).toBe(0)
  })

  test('total_charge has no floating point drift at 2dp', () => {
    // Use a rate that could cause .1 + .2 = .30000000004 style issues
    const result = computeCharges({
      parked_at: 1700000000,
      exited_at: 1700000000 + 75 * 60,
      hourly_rate: 2.0,
      booked_minutes: 60,
      grace_minutes: 10,
      surcharge_rate: 2.0,
    })
    // dwell=75, over=75-60-10=5, surcharge=0 (floor(5/15)=0)
    // base = ceil(75/60 * 2.0 * 100)/100 = ceil(250)/100 = 2.50
    expect(result.total_charge.toString()).not.toContain('000000')
    expect(Number.isFinite(result.total_charge)).toBe(true)
  })
})

// ── closeSession ──────────────────────────────────────────────────────────────

describe('closeSession', () => {
  test('produces CLOSED session with computed charges', () => {
    const parked_at = 1700000000
    const exitTs = parked_at + 135 * 60  // 135 min (5 min past grace)

    const session = makeSession({
      state: 'PARKED',
      parked_at,
      timer_end_at: parked_at + 120 * 60,
      grace_end_at: parked_at + 130 * 60,
      booked_minutes: 120,
    })

    const { closedSession, charges } = closeSession(session, exitTs, BASE_LOT)

    expect(closedSession.state).toBe('CLOSED')
    expect(closedSession.closed_at).toBe(exitTs)
    expect(closedSession.actual_minutes).toBe(135)
    expect(charges.surcharge).toBe(0)  // only 5 min over, needs 15 for first interval
    expect(closedSession.total_charge).toBe(charges.total_charge)
  })

  test('overstay session has surcharge in closed receipt', () => {
    const parked_at = 1700000000
    const exitTs = parked_at + 145 * 60  // 15 min past grace

    const session = makeSession({
      state: 'PARKED',
      parked_at,
      timer_end_at: parked_at + 120 * 60,
      grace_end_at: parked_at + 130 * 60,
      booked_minutes: 120,
    })

    const { charges, closedSession } = closeSession(session, exitTs, BASE_LOT)

    expect(charges.surcharge).toBe(5.00)
    expect(closedSession.surcharge).toBe(5.00)
    expect(closedSession.total_charge).toBe(charges.total_charge)
  })

  test('throws on invalid starting state', () => {
    const session = makeSession({ state: 'CREATED' })
    expect(() => closeSession(session, 1700000000, BASE_LOT)).toThrow()
  })
})

// ── isOverstay / overstayMinutes ──────────────────────────────────────────────

describe('isOverstay', () => {
  const parked_at = 1700000000
  const grace_end = parked_at + 130 * 60  // 120 booked + 10 grace

  const session = makeSession({
    state: 'PARKED',
    parked_at,
    grace_end_at: grace_end,
  })

  test('before grace end → not overstay', () => {
    expect(isOverstay(session, parked_at + 100 * 60)).toBe(false)
    expect(isOverstay(session, grace_end - 1)).toBe(false)
  })

  test('exactly at grace end → not overstay (> not >=)', () => {
    expect(isOverstay(session, grace_end)).toBe(false)
  })

  test('1 second past grace end → overstay', () => {
    expect(isOverstay(session, grace_end + 1)).toBe(true)
  })

  test('unparked session → never overstay', () => {
    expect(isOverstay(makeSession(), Date.now())).toBe(false)
  })
})

describe('overstayMinutes', () => {
  const parked_at = 1700000000
  const grace_end = parked_at + 130 * 60
  const session = makeSession({ state: 'PARKED', parked_at, grace_end_at: grace_end })

  test('before grace → 0 minutes', () => {
    expect(overstayMinutes(session, grace_end - 60)).toBe(0)
  })

  test('5 minutes past grace → 5 minutes', () => {
    expect(overstayMinutes(session, grace_end + 5 * 60)).toBe(5)
  })

  test('partial minute rounds up', () => {
    expect(overstayMinutes(session, grace_end + 1)).toBe(1)  // ceil(1/60) = 1
  })
})
