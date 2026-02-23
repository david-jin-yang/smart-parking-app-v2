'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

interface Session {
  id: string
  lot_id: string
  state: string
  spot_id: string | null
  parked_at: number | null
  timer_end_at: number | null
  grace_end_at: number | null
  booked_minutes: number | null
  base_charge: number | null
  total_charge: number | null
}

interface SpotInfo {
  id: string
  floor?: number
  row?: string
  position?: number
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function parseSpotId(id: string | null): string {
  if (!id) return '—'
  const parts = id.split('_')
  if (parts.length >= 4) {
    return `Floor ${parts[parts.length - 3]} · Row ${parts[parts.length - 2]} · Spot ${parts[parts.length - 1]}`
  }
  return id
}

const STATE_CONFIG: Record<string, { label: string; color: string; bg: string; desc: string }> = {
  CREATED:     { label: 'Finding Spot',  color: 'var(--accent)',   bg: 'var(--accent-dim)',   desc: 'Searching for available spot…' },
  ASSIGNED:    { label: 'Spot Reserved', color: 'var(--accent)',   bg: 'var(--accent-dim)',   desc: 'Head to the lot now' },
  ARRIVED_LOT: { label: 'At the Lot',   color: 'var(--warning)',  bg: 'var(--warning-dim)',  desc: 'Park in your assigned spot' },
  PARKED:      { label: 'Parked',        color: 'var(--success)',  bg: 'var(--success-dim)',  desc: 'Timer is running' },
  TIMER_ENDED: { label: 'Time Up',       color: 'var(--warning)',  bg: 'var(--warning-dim)',  desc: 'Grace period active — exit now' },
  EXITING:     { label: 'Exiting',       color: 'var(--text-secondary)', bg: 'var(--glass-fill-md)', desc: 'Processing exit…' },
  CONFLICT:    { label: 'Conflict',      color: 'var(--danger)',   bg: 'var(--danger-dim)',   desc: 'Spot taken — reassigning' },
  CLOSED:      { label: 'Complete',      color: 'var(--success)',  bg: 'var(--success-dim)',  desc: 'Session closed' },
}

function TimerRing({ secondsLeft, totalSeconds }: { secondsLeft: number; totalSeconds: number }) {
  const pct = Math.max(0, Math.min(1, secondsLeft / totalSeconds))
  const r = 54
  const circ = 2 * Math.PI * r
  const dash = pct * circ
  const isOverstay = secondsLeft < 0
  const displaySeconds = Math.abs(secondsLeft)
  const color = secondsLeft < 0 ? 'var(--danger)' : secondsLeft < 300 ? 'var(--warning)' : 'var(--accent)'

  return (
    <div style={{ position: 'relative', width: 140, height: 140, margin: '0 auto' }}>
      <svg width="140" height="140" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--glass-fill-md)" strokeWidth="6" />
        <circle
          cx="70" cy="70" r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1s linear, stroke 0.5s ease' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {isOverstay && <div style={{ fontSize: '9px', fontWeight: 600, color: 'var(--danger)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '2px' }}>+overstay</div>}
        <div className="mono" style={{ fontSize: '26px', fontWeight: 500, color, letterSpacing: '-0.03em', lineHeight: 1 }}>
          {formatTime(displaySeconds)}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
          {isOverstay ? 'over time' : 'remaining'}
        </div>
      </div>
    </div>
  )
}

function SessionPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('id')

  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Clock tick
  useEffect(() => {
    timerRef.current = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const fetchSession = useCallback(async () => {
    if (!sessionId) return
    const res = await fetch(`/api/sessions/${sessionId}`)
    const data = await res.json()
    if (data.session) setSession(data.session)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    fetchSession()
    const interval = setInterval(fetchSession, 5000)
    return () => clearInterval(interval)
  }, [fetchSession])

  const doAction = async (endpoint: string) => {
    if (!sessionId) return
    setActionLoading(true)
    setError(null)
    const res = await fetch(`/api/sessions/${sessionId}/${endpoint}`, { method: 'POST' })
    const data = await res.json()
    setActionLoading(false)
    if (data.error) { setError(data.error); return }
    if (data.state === 'CLOSED') {
      router.push(`/receipt?id=${sessionId}`)
    } else {
      await fetchSession()
    }
  }

  if (!sessionId) {
    return (
      <div className="page" style={{ paddingTop: 'var(--sp-8)', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>No session ID provided.</p>
        <button className="btn-glass" onClick={() => router.push('/')} style={{ marginTop: 'var(--sp-4)' }}>← Back</button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="page" style={{ paddingTop: 'var(--sp-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>
        Loading session…
      </div>
    )
  }

  if (!session) {
    return (
      <div className="page" style={{ paddingTop: 'var(--sp-8)', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)' }}>Session not found.</p>
        <button className="btn-glass" onClick={() => router.push('/')} style={{ marginTop: 'var(--sp-4)' }}>← Back</button>
      </div>
    )
  }

  const cfg = STATE_CONFIG[session.state] ?? STATE_CONFIG.CREATED
  const secondsLeft = session.timer_end_at ? session.timer_end_at - now : 0
  const graceLeft = session.grace_end_at ? session.grace_end_at - now : 0
  const totalSeconds = (session.booked_minutes ?? 120) * 60
  const isParked = ['PARKED', 'TIMER_ENDED'].includes(session.state)
  const lotName = session.lot_id.replace('lot_', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      {/* Nav */}
      <nav className="nav-bar">
        <button className="btn-glass" onClick={() => router.push('/')} style={{ padding: '6px 14px', fontSize: '12px' }}>
          ← Lots
        </button>
        <div className="nav-logo">Park<span>Flow</span></div>
        <div style={{ width: 80 }} />
      </nav>

      <div style={{ paddingTop: 'var(--sp-6)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>

        {/* Status badge */}
        <div className="fade-up" style={{ textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 16px', borderRadius: 'var(--r-cap)', background: cfg.bg, border: `1px solid ${cfg.color}22` }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: cfg.color, boxShadow: `0 0 0 0 ${cfg.color}`, animation: isParked ? 'pulse-ring 1.5s ease-out infinite' : 'none' }} />
            <span style={{ fontSize: '13px', fontWeight: 500, color: cfg.color }}>{cfg.label}</span>
          </div>
          <p style={{ marginTop: 'var(--sp-2)', fontSize: '13px', color: 'var(--text-tertiary)' }}>{cfg.desc}</p>
        </div>

        {/* Timer (when parked) */}
        {isParked && (
          <div className="glass-md fade-up fade-up-1" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-6) var(--sp-6) var(--sp-5)' }}>
            <TimerRing secondsLeft={session.state === 'TIMER_ENDED' ? -graceLeft : secondsLeft} totalSeconds={totalSeconds} />
            {session.state === 'TIMER_ENDED' && graceLeft > 0 && (
              <div style={{ textAlign: 'center', marginTop: 'var(--sp-3)', padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-cap)', background: 'var(--warning-dim)', display: 'inline-block', fontSize: '12px', color: 'var(--warning)', fontWeight: 500 }}>
                Grace period: {formatTime(graceLeft)} left
              </div>
            )}
          </div>
        )}

        {/* Session details */}
        <div className="glass fade-up fade-up-2" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
          <Row label="Lot" value={lotName} />
          <div className="divider" style={{ margin: 'var(--sp-2) 0' }} />
          {session.spot_id && <Row label="Spot" value={parseSpotId(session.spot_id)} mono />}
          <Row label="Session" value={session.id.slice(0, 16) + '…'} mono />
          {session.base_charge !== null && <Row label="Base charge" value={`$${session.base_charge.toFixed(2)}`} mono />}
          {session.parked_at && <Row label="Parked at" value={new Date(session.parked_at * 1000).toLocaleTimeString()} />}
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: 'var(--sp-3) var(--sp-4)', borderRadius: 'var(--r-md)', background: 'var(--danger-dim)', border: '1px solid rgba(255,69,58,0.2)', fontSize: '13px', color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="fade-up fade-up-3" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          {session.state === 'CREATED' && (
            <button className="btn-glass primary" onClick={() => doAction('assign')} disabled={actionLoading} style={{ width: '100%' }}>
              {actionLoading ? 'Assigning…' : 'Assign Spot'}
            </button>
          )}
          {session.state === 'ASSIGNED' && (
            <button className="btn-glass primary" onClick={() => doAction('arrive')} disabled={actionLoading} style={{ width: '100%' }}>
              {actionLoading ? 'Confirming…' : 'I\'ve Arrived at the Lot'}
            </button>
          )}
          {session.state === 'ARRIVED_LOT' && (
            <button className="btn-glass primary" onClick={() => doAction('park')} disabled={actionLoading} style={{ width: '100%' }}>
              {actionLoading ? 'Starting…' : 'I\'m Parked — Start Timer'}
            </button>
          )}
          {(session.state === 'PARKED' || session.state === 'TIMER_ENDED') && (
            <button className="btn-glass primary" onClick={() => doAction('exit')} disabled={actionLoading} style={{ width: '100%' }}>
              {actionLoading ? 'Processing…' : 'Exit & Pay'}
            </button>
          )}
          {!['CLOSED', 'CANCELLED', 'ABANDONED'].includes(session.state) && (
            <button className="btn-glass danger" onClick={() => doAction('exit')} disabled={actionLoading} style={{ width: '100%' }}>
              Cancel Session
            </button>
          )}
        </div>

        <div style={{ paddingBottom: 'var(--sp-8)' }} />
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--sp-1) 0' }}>
      <span style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{label}</span>
      <span className={mono ? 'mono' : ''} style={{ fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

export default function SessionPage() {
  return (
    <Suspense fallback={<div className="page" style={{ paddingTop: 'var(--sp-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading…</div>}>
      <SessionPageInner />
    </Suspense>
  )
}
