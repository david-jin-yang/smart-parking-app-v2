'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

interface Session {
  id: string
  lot_id: string
  spot_id: string | null
  parked_at: number | null
  closed_at: number | null
  actual_minutes: number | null
  base_charge: number | null
  surcharge: number | null
  total_charge: number | null
  booked_minutes: number | null
}

function formatDuration(minutes: number | null): string {
  if (!minutes) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function parseSpotId(id: string | null): string {
  if (!id) return '—'
  const parts = id.split('_')
  if (parts.length >= 4) {
    return `F${parts[parts.length - 3]} · R${parts[parts.length - 2]} · #${parts[parts.length - 1]}`
  }
  return id
}

function ReceiptPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('id')
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/sessions/${sessionId}`)
      .then(r => r.json())
      .then(d => { if (d.session) setSession(d.session); setLoading(false) })
  }, [sessionId])

  if (loading) return (
    <div className="page" style={{ paddingTop: 'var(--sp-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading receipt…</div>
  )

  if (!session) return (
    <div className="page" style={{ paddingTop: 'var(--sp-8)', textAlign: 'center' }}>
      <p style={{ color: 'var(--text-secondary)' }}>Session not found.</p>
      <button className="btn-glass" onClick={() => router.push('/')} style={{ marginTop: 'var(--sp-4)' }}>← Home</button>
    </div>
  )

  const lotName = session.lot_id.replace('lot_', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const hasOverstay = (session.surcharge ?? 0) > 0
  const parkedTime = session.parked_at ? new Date(session.parked_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
  const exitTime = session.closed_at ? new Date(session.closed_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'
  const date = session.parked_at ? new Date(session.parked_at * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '—'

  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <nav className="nav-bar">
        <div style={{ width: 60 }} />
        <div className="nav-logo">Park<span>Flow</span></div>
        <div style={{ width: 60 }} />
      </nav>

      <div style={{ paddingTop: 'var(--sp-8)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)', alignItems: 'center' }}>

        {/* Success icon */}
        <div className="fade-up" style={{ textAlign: 'center' }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'var(--success-dim)',
            border: '1px solid rgba(48,209,88,0.25)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto var(--sp-4)',
            fontSize: '26px',
          }}>✓</div>
          <h1 className="section-title" style={{ textAlign: 'center', fontSize: '24px' }}>Session Complete</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginTop: 'var(--sp-1)' }}>{date} · {lotName}</p>
        </div>

        {/* Total charge — hero */}
        <div className="glass-hi fade-up fade-up-1" style={{
          borderRadius: 'var(--r-2xl)',
          padding: 'var(--sp-8) var(--sp-8) var(--sp-6)',
          width: '100%',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 'var(--sp-2)' }}>
            Total Charged
          </div>
          <div className="mono" style={{
            fontSize: '52px',
            fontWeight: 300,
            letterSpacing: '-0.04em',
            color: hasOverstay ? 'var(--warning)' : 'var(--text-primary)',
            lineHeight: 1,
          }}>
            ${(session.total_charge ?? 0).toFixed(2)}
          </div>
          {hasOverstay && (
            <div style={{ marginTop: 'var(--sp-3)', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: 'var(--r-cap)', background: 'var(--warning-dim)', border: '1px solid rgba(255,159,10,0.2)' }}>
              <span style={{ fontSize: '12px', color: 'var(--warning)', fontWeight: 500 }}>⚠ Overstay surcharge applied</span>
            </div>
          )}
        </div>

        {/* Breakdown */}
        <div className="glass fade-up fade-up-2" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)', width: '100%' }}>
          <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 'var(--sp-3)' }}>
            Receipt Breakdown
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
            <ReceiptRow label="Spot" value={parseSpotId(session.spot_id)} mono />
            <ReceiptRow label="Parked" value={parkedTime} />
            <ReceiptRow label="Exited" value={exitTime} />
            <ReceiptRow label="Duration" value={formatDuration(session.actual_minutes)} mono />
            <ReceiptRow label="Booked" value={formatDuration(session.booked_minutes)} mono />
            <div className="divider" style={{ margin: 'var(--sp-2) 0' }} />
            <ReceiptRow label="Base charge" value={`$${(session.base_charge ?? 0).toFixed(2)}`} mono />
            {hasOverstay && <ReceiptRow label="Overstay surcharge" value={`$${(session.surcharge ?? 0).toFixed(2)}`} mono warn />}
            <div className="divider" style={{ margin: 'var(--sp-2) 0' }} />
            <ReceiptRow label="Total" value={`$${(session.total_charge ?? 0).toFixed(2)}`} mono bold />
          </div>
        </div>

        {/* CTA */}
        <div className="fade-up fade-up-3" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          <button className="btn-glass primary" onClick={() => router.push('/')} style={{ width: '100%' }}>
            Park Again
          </button>
        </div>

        <div style={{ paddingBottom: 'var(--sp-8)', textAlign: 'center' }}>
          <span className="mono" style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
            {sessionId?.slice(0, 20)}
          </span>
        </div>
      </div>
    </div>
  )
}

function ReceiptRow({ label, value, mono, bold, warn }: { label: string; value: string; mono?: boolean; bold?: boolean; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--sp-1) 0' }}>
      <span style={{ fontSize: '13px', color: warn ? 'var(--warning)' : 'var(--text-tertiary)' }}>{label}</span>
      <span
        className={mono ? 'mono' : ''}
        style={{ fontSize: bold ? '15px' : '13px', fontWeight: bold ? 600 : 400, color: warn ? 'var(--warning)' : bold ? 'var(--text-primary)' : 'var(--text-secondary)' }}
      >
        {value}
      </span>
    </div>
  )
}

export default function ReceiptPage() {
  return (
    <Suspense fallback={<div className="page" style={{ paddingTop: 'var(--sp-16)', textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading…</div>}>
      <ReceiptPageInner />
    </Suspense>
  )
}
