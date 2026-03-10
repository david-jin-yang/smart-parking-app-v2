'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'

// ── Types ────────────────────────────────────────────────────────────────────

interface SimStatus {
  run_id: number | null
  status: 'idle' | 'running' | 'paused' | 'complete'
  sim_minute: number
  sim_day_hours: number
  speed_multiplier: number
  trips_total: number
  trips_processed: number
  events_emitted: number
  occupancy: Record<string, number>
  started_at: number | null
  elapsed_real_ms: number
}

interface OccupancySnapshot {
  lot_id: string
  total: number
  available: number
  occupied: number
  reserved: number
  occupancy_pct: number
}

interface SimEvent {
  type: string
  session_id?: string
  user_id?: string
  lot_id?: string
  spot_id?: string
  sim_minute?: number
  ts: number
  payload?: Record<string, unknown>
}

interface Lot {
  id: string
  name: string
  floors: number
  rows_per_floor: number
  spots_per_row: number
}

interface SpotData {
  id: string
  floor: number
  row: number
  position: number
  spot_type: string
  status: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function simTimeLabel(minute: number): string {
  const startHour = 8
  const totalMinutes = startHour * 60 + minute
  const h = Math.floor(totalMinutes / 60) % 24
  const m = totalMinutes % 60
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

function simProgress(minute: number, dayHours: number): number {
  return Math.min(1, minute / (dayHours * 60))
}

const LOT_LABELS: Record<string, string> = {
  lot_century_city: 'Century City',
  lot_glendale_galleria: 'Glendale',
  lot_old_town_pasadena: 'Pasadena',
}

const EVENT_COLORS: Record<string, string> = {
  SPOT_ASSIGNED:   'var(--accent)',
  PARKED:          'var(--success)',
  CLOSED:          'var(--text-tertiary)',
  CONFLICT:        'var(--danger)',
  REASSIGNED:      'var(--warning)',
  ARRIVED_LOT:     'var(--accent)',
  SESSION_CREATED: 'var(--text-tertiary)',
  TIMER_ENDED:     'var(--warning)',
  ABANDONED:       'var(--danger)',
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="glass" style={{ borderRadius: 'var(--r-md)', padding: 'var(--sp-3) var(--sp-4)', flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
      <div className="mono" style={{ fontSize: '18px', fontWeight: 500, color: color ?? 'var(--text-primary)', letterSpacing: '-0.02em' }}>{value}</div>
    </div>
  )
}

function OccupancyMeter({ lot_id, pct }: { lot_id: string; pct: number }) {
  const color = pct > 0.85 ? 'var(--danger)' : pct > 0.6 ? 'var(--warning)' : 'var(--success)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{LOT_LABELS[lot_id] ?? lot_id}</span>
        <span className="mono" style={{ fontSize: '12px', color }}>{Math.round(pct * 100)}%</span>
      </div>
      <div className="occ-bar">
        <div className="occ-bar-fill" style={{ width: `${Math.round(pct * 100)}%`, background: color }} />
      </div>
    </div>
  )
}

function SpotGrid({ spots, floor }: { spots: SpotData[]; floor: number }) {
  const floorSpots = spots.filter(s => s.floor === floor)
  if (!floorSpots.length) return null
  const maxRow = Math.max(...floorSpots.map(s => s.row))
  const maxPos = Math.max(...floorSpots.map(s => s.position))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      {Array.from({ length: maxRow }, (_, ri) => (
        <div key={ri} style={{ display: 'flex', gap: '3px' }}>
          {Array.from({ length: maxPos }, (_, pi) => {
            const spot = floorSpots.find(s => s.row === ri + 1 && s.position === pi + 1)
            if (!spot) return <div key={pi} style={{ width: 10, height: 10 }} />
            const bg = spot.status === 'occupied' ? 'var(--danger)'
              : spot.status === 'reserved' ? 'var(--warning)'
              : spot.spot_type === 'ada' ? 'var(--accent-dim)'
              : spot.spot_type === 'ev' ? 'rgba(48,209,88,0.3)'
              : 'rgba(255,255,255,0.12)'
            return (
              <div
                key={pi}
                title={`${spot.id} · ${spot.status}`}
                style={{
                  width: 10, height: 10,
                  borderRadius: 2,
                  background: bg,
                  transition: 'background 0.4s ease',
                }}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

function EventLog({ events }: { events: SimEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  return (
    <div style={{
      height: 240,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
    }}>
      {events.length === 0 && (
        <div style={{ color: 'var(--text-tertiary)', padding: 'var(--sp-4)', textAlign: 'center' }}>
          Start simulation to see events…
        </div>
      )}
      {events.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'baseline', padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, fontSize: '10px' }}>
            {e.sim_minute !== undefined ? simTimeLabel(e.sim_minute) : '——'}
          </span>
          <span style={{ color: EVENT_COLORS[e.type] ?? 'var(--text-secondary)', flexShrink: 0 }}>
            {e.type}
          </span>
          <span style={{ color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.lot_id ? LOT_LABELS[e.lot_id] ?? e.lot_id : ''}{e.spot_id ? ` · ${e.spot_id.split('_').slice(-3).join('-')}` : ''}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const router = useRouter()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Sim state
  const [status, setStatus] = useState<SimStatus | null>(null)
  const [events, setEvents] = useState<SimEvent[]>([])
  const [occupancy, setOccupancy] = useState<Record<string, number>>({})

  // Lots + spots
  const [lots, setLots] = useState<Lot[]>([])
  const [spots, setSpots] = useState<Record<string, SpotData[]>>({})
  const [activeLot, setActiveLot] = useState<string>('lot_century_city')
  const [activeFloor, setActiveFloor] = useState(1)

  // Sim params
  const [seed, setSeed] = useState(42)
  const [speed, setSpeed] = useState(60)
  const [eventMode, setEventMode] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)

  const sseRef = useRef<EventSource | null>(null)

  // Fetch lots + spots
  const fetchLots = useCallback(async () => {
    const res = await fetch('/api/lots')
    const data = await res.json()
    setLots(data.lots ?? [])
    const snap: Record<string, number> = {}
    for (const lot of data.lots ?? []) {
      snap[lot.id] = lot.occupancy?.occupancy_pct ?? 0
    }
    setOccupancy(snap)
  }, [])

  const fetchSpots = useCallback(async (lot_id: string) => {
    const res = await fetch(`/api/lots/${lot_id}`)
    const data = await res.json()
    setSpots(prev => ({ ...prev, [lot_id]: data.spots ?? [] }))
  }, [])

  useEffect(() => {
    fetchLots()
    fetch('/api/sim/status').then(r => r.json()).then(setStatus)
  }, [fetchLots])

  useEffect(() => {
    fetchSpots(activeLot)
  }, [activeLot, fetchSpots])

  // SSE connection
  useEffect(() => {
    const es = new EventSource('/api/sim/events/stream')
    sseRef.current = es

    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      setStatus(data)
      if (data.occupancy) setOccupancy(data.occupancy)
    })

    es.addEventListener('sim_event', (e) => {
      const data = JSON.parse(e.data) as SimEvent
      setEvents(prev => [...prev.slice(-199), data])
    })

    es.addEventListener('occupancy', (e) => {
      const snapshots = JSON.parse(e.data) as OccupancySnapshot[]
      const snap: Record<string, number> = {}
      for (const s of snapshots) snap[s.lot_id] = s.occupancy_pct
      setOccupancy(snap)
      // Refresh spot grid for active lot
      fetchSpots(activeLot)
    })

    return () => es.close()
  }, [activeLot, fetchSpots])

  // Sim actions
  const startSim = async () => {
    setActionLoading(true)
    await fetch('/api/sim/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed, speed_multiplier: speed, event_mode: eventMode }),
    })
    const s = await fetch('/api/sim/status').then(r => r.json())
    setStatus(s)
    setActionLoading(false)
  }

  const pauseSim = async () => {
    setActionLoading(true)
    await fetch('/api/sim/pause', { method: 'POST' })
    const s = await fetch('/api/sim/status').then(r => r.json())
    setStatus(s)
    setActionLoading(false)
  }

  const resetSim = async () => {
    setActionLoading(true)
    await fetch('/api/sim/reset', { method: 'POST' })
    const s = await fetch('/api/sim/status').then(r => r.json())
    setStatus(s)
    setOccupancy({})
    setEvents([])
    fetchLots()
    setActionLoading(false)
  }

  const isRunning = status?.status === 'running'
  const isPaused  = status?.status === 'paused'
  const isIdle    = !status || status.status === 'idle'
  const progressPct = status ? simProgress(status.sim_minute, status.sim_day_hours) * 100 : 0
  const currentLotSpots = spots[activeLot] ?? []

  return (
    <div className="shell">
      <div className="bg-mesh" />

      {/* ── Nav ── */}
      <nav className="nav-bar">
        <button className="nav-logo" onClick={() => router.push('/')}>
          Park<span className="accent">Flow</span>
          <span className="sub">Admin</span>
        </button>
        <div className="nav-right">
          <div className="nav-dropdown" ref={dropdownRef}>
            <button className="nav-dropdown-btn" onClick={() => setDropdownOpen(o => !o)} aria-label="Navigation">☰</button>
            {dropdownOpen && (
              <div className="nav-dropdown-menu">
                <button className="nav-dropdown-item" onClick={() => { router.push('/'); setDropdownOpen(false) }}>
                  <span className="item-icon">🏠</span> Home
                </button>
                <div className="nav-dropdown-divider" />
                <button className="nav-dropdown-item active" onClick={() => { router.push('/admin'); setDropdownOpen(false) }}>
                  <span className="item-icon">⚙️</span> Admin
                </button>
                <button className="nav-dropdown-item" onClick={() => { router.push('/analytics'); setDropdownOpen(false) }}>
                  <span className="item-icon">📊</span> Analytics
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* ── Content ── */}
      <div className="content">
        <div className="admin-layout" style={{ paddingTop: 'var(--sp-6)', paddingBottom: 'var(--sp-8)' }}>

          {/* ── LEFT: Controls panel ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)', position: 'sticky', top: 72 }}>

            {/* Sim Controls */}
            <section>
              <SectionLabel>Simulation Control</SectionLabel>
              <div className="glass-md glass-card" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: isRunning ? 'var(--success)' : isPaused ? 'var(--warning)' : 'var(--text-tertiary)',
                      animation: isRunning ? 'pulse-ring 1.5s ease-out infinite' : 'none',
                    }} />
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                      {status?.status ?? 'idle'}
                    </span>
                  </div>
                  <span className="mono" style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                    {status && status.sim_minute > 0 ? simTimeLabel(status.sim_minute) : '—'}
                  </span>
                </div>
                <div className="occ-bar" style={{ height: 6 }}>
                  <div className="occ-bar-fill" style={{ width: `${progressPct}%`, background: 'var(--accent)' }} />
                </div>
                <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-end' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>SEED</label>
                    <input className="input-glass" type="number" value={seed} onChange={e => setSeed(Number(e.target.value))} disabled={isRunning} style={{ padding: '7px 10px', fontSize: '13px' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>SPEED ×</label>
                    <input className="input-glass" type="number" value={speed} min={1} max={600} onChange={e => setSpeed(Number(e.target.value))} disabled={isRunning} style={{ padding: '7px 10px', fontSize: '13px' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: 'var(--text-tertiary)', letterSpacing: '0.04em' }}>EVENTS</label>
                    <button className={`btn-glass ${eventMode ? 'primary' : ''}`} onClick={() => setEventMode(v => !v)} disabled={isRunning} style={{ padding: '7px 14px', fontSize: '12px', minHeight: 38 }}>
                      {eventMode ? '3× ON' : 'OFF'}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
                  {(isIdle || isPaused) && (
                    <button className="btn-glass primary" onClick={startSim} disabled={actionLoading} style={{ flex: 1 }}>
                      {isPaused ? 'Resume' : 'Start'}
                    </button>
                  )}
                  {isRunning && (
                    <button className="btn-glass" onClick={pauseSim} disabled={actionLoading} style={{ flex: 1 }}>Pause</button>
                  )}
                  <button className="btn-glass danger" onClick={resetSim} disabled={actionLoading} style={{ flex: isRunning ? 0 : 1, padding: '11px 18px' }}>
                    Reset
                  </button>
                </div>
              </div>
            </section>

            {/* Live Stats */}
            <section>
              <SectionLabel>Live Stats</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--sp-2)' }}>
                <StatPill label="Trips" value={status?.trips_total ?? 0} />
                <StatPill label="Processed" value={status?.trips_processed ?? 0} color="var(--success)" />
                <StatPill label="Events" value={status?.events_emitted ?? 0} color="var(--accent)" />
              </div>
            </section>

            {/* Occupancy */}
            <section>
              <SectionLabel>Occupancy</SectionLabel>
              <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                {lots.length === 0 ? (
                  <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Loading lots…</span>
                ) : (
                  lots.map(lot => <OccupancyMeter key={lot.id} lot_id={lot.id} pct={occupancy[lot.id] ?? 0} />)
                )}
              </div>
            </section>
          </div>

          {/* ── RIGHT: Spot grid + events ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>

            {/* Spot Grid */}
            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-3)' }}>
                <SectionLabel style={{ marginBottom: 0 }}>Spot Grid</SectionLabel>
                <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                  {lots.map(lot => (
                    <button key={lot.id} className={`btn-glass ${activeLot === lot.id ? 'primary' : ''}`}
                      onClick={() => setActiveLot(lot.id)} style={{ padding: '4px 10px', fontSize: '11px', minHeight: 28 }}>
                      {LOT_LABELS[lot.id] ?? lot.id}
                    </button>
                  ))}
                </div>
              </div>
              <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                  {[1, 2, 3, 4].map(f => (
                    <button key={f} className={`btn-glass ${activeFloor === f ? 'primary' : ''}`}
                      onClick={() => setActiveFloor(f)} style={{ padding: '4px 12px', fontSize: '12px', minHeight: 28 }}>
                      F{f}
                    </button>
                  ))}
                </div>
                {currentLotSpots.length > 0 ? (
                  <SpotGrid spots={currentLotSpots} floor={activeFloor} />
                ) : (
                  <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Loading spots…</span>
                )}
                <div style={{ display: 'flex', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
                  {[
                    { color: 'rgba(79,120,200,0.10)', label: 'Free' },
                    { color: 'var(--danger)', label: 'Occupied' },
                    { color: 'var(--warning)', label: 'Reserved' },
                    { color: 'var(--accent-dim)', label: 'ADA' },
                    { color: 'rgba(24,168,74,0.25)', label: 'EV' },
                  ].map(({ color, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Event Log */}
            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-3)' }}>
                <SectionLabel style={{ marginBottom: 0 }}>Live Events</SectionLabel>
                <button className="btn-glass" onClick={() => setEvents([])} style={{ padding: '4px 10px', fontSize: '11px', minHeight: 28 }}>Clear</button>
              </div>
              <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-4) var(--sp-5)' }}>
                <EventLog events={events} />
              </div>
            </section>

          </div>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <h2 style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 'var(--sp-3)', ...style }}>
      {children}
    </h2>
  )
}
