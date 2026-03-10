'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'

interface Occupancy {
  lot_id: string; total: number; available: number
  occupied: number; reserved: number; occupancy_pct: number
}
interface Lot {
  id: string; name: string; address: string; floors: number
  hourly_rate: number; surcharge_rate: number; grace_minutes: number; occupancy: Occupancy
}
interface User { id: string; display_name: string }

function OccupancyBar({ pct }: { pct: number }) {
  const color = pct > 0.85 ? 'var(--danger)' : pct > 0.6 ? 'var(--warning)' : 'var(--success)'
  return <div className="occ-bar"><div className="occ-bar-fill" style={{ width: `${Math.round(pct * 100)}%`, background: color }} /></div>
}

function LotCard({ lot, onSelect, loading }: { lot: Lot; onSelect: (id: string) => void; loading: boolean }) {
  const pct = lot.occupancy.occupancy_pct
  const availPct = Math.round((1 - pct) * 100)
  const statusColor = pct > 0.85 ? 'red' : pct > 0.6 ? 'amber' : 'green'
  const statusLabel = pct > 0.85 ? 'Almost full' : pct > 0.6 ? 'Filling up' : 'Available'

  return (
    <div className="glass-md glass-card" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-6)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--sp-3)' }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2, color: 'var(--text-primary)', marginBottom: '4px' }}>{lot.name}</h3>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', lineHeight: 1.3 }}>{lot.address}</p>
        </div>
        <span className={`badge ${statusColor}`} style={{ flexShrink: 0, marginTop: '2px' }}>{statusLabel}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Occupancy</span>
          <span className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{lot.occupancy.available} of {lot.occupancy.total} free</span>
        </div>
        <OccupancyBar pct={pct} />
      </div>
      <div className="divider" style={{ margin: 0 }} />
      <div style={{ display: 'flex', gap: 'var(--sp-4)' }}>
        <div>
          <div className="mono" style={{ fontSize: '20px', fontWeight: 500, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>${lot.hourly_rate.toFixed(2)}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>per hour</div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: '20px', fontWeight: 500, color: 'var(--warning)', letterSpacing: '-0.02em' }}>${lot.surcharge_rate.toFixed(2)}</div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>/ 15min overstay</div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div className="mono" style={{ fontSize: '20px', fontWeight: 500, color: 'var(--text-secondary)', letterSpacing: '-0.02em' }}>{lot.grace_minutes}m</div>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>grace period</div>
        </div>
      </div>
      <button className="btn-glass primary" onClick={() => onSelect(lot.id)} disabled={loading || availPct === 0} style={{ width: '100%', marginTop: 'var(--sp-1)', minHeight: 44 }}>
        {loading ? 'Reserving…' : availPct === 0 ? 'Lot Full' : 'Reserve a Spot'}
      </button>
    </div>
  )
}

function NavDropdown({ current, dropdownRef, open, setOpen }: { current: string; dropdownRef: React.RefObject<HTMLDivElement>; open: boolean; setOpen: (v: boolean) => void }) {
  const router = useRouter()
  const go = (path: string) => { router.push(path); setOpen(false) }
  return (
    <div className="nav-dropdown" ref={dropdownRef}>
      <button className="nav-dropdown-btn" onClick={() => setOpen(!open)} aria-label="Navigation">☰</button>
      {open && (
        <div className="nav-dropdown-menu">
          <button className={`nav-dropdown-item ${current === '/' ? 'active' : ''}`} onClick={() => go('/')}>
            <span className="item-icon">🏠</span> Home
          </button>
          <div className="nav-dropdown-divider" />
          <button className={`nav-dropdown-item ${current === '/admin' ? 'active' : ''}`} onClick={() => go('/admin')}>
            <span className="item-icon">⚙️</span> Admin
          </button>
          <button className={`nav-dropdown-item ${current === '/analytics' ? 'active' : ''}`} onClick={() => go('/analytics')}>
            <span className="item-icon">📊</span> Analytics
          </button>
        </div>
      )}
    </div>
  )
}

export default function HomePage() {
  const router = useRouter()
  const [lots, setLots] = useState<Lot[]>([])
  const [user, setUser] = useState<User | null>(null)
  const [userId, setUserId] = useState('user_000001')
  const [loadingLots, setLoadingLots] = useState(true)
  const [reserving, setReserving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const fetchLots = useCallback(async () => {
    try {
      const data = await fetch('/api/lots').then(r => r.json())
      setLots(data.lots ?? [])
    } finally { setLoadingLots(false) }
  }, [])

  useEffect(() => {
    fetchLots()
    const iv = setInterval(fetchLots, 10000)
    return () => clearInterval(iv)
  }, [fetchLots])

  useEffect(() => {
    fetch('/api/demo/me').then(r => r.json()).then(d => { if (d.user) setUser(d.user) })
  }, [])

  const login = async () => {
    const res = await fetch('/api/demo/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) })
    const d = await res.json()
    if (d.user) setUser(d.user)
    else setError(d.error ?? 'Login failed')
  }

  const logout = async () => {
    await fetch('/api/demo/logout', { method: 'POST' })
    setUser(null)
  }

  const reserve = async (lot_id: string) => {
    if (!user) { setError('Sign in first'); return }
    setReserving(lot_id); setError(null)
    const existing = await fetch('/api/sessions').then(r => r.json())
    if (existing.session) { router.push(`/session?id=${existing.session.id}`); return }
    const res = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lot_id }),
    })
    const data = await res.json()
    setReserving(null)
    if (data.session_id) router.push(`/session?id=${data.session_id}`)
    else setError(data.error ?? 'Failed to create session')
  }

  return (
    <div className="shell">
      <div className="bg-mesh" />
      <nav className="nav-bar">
        <button className="nav-logo" onClick={() => router.push('/')}>
          Park<span className="accent">Flow</span>
        </button>
        <div className="nav-right">
          {user ? (
            <>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{user.display_name}</span>
              <button className="btn-glass" onClick={logout} style={{ fontSize: '13px', padding: '6px 14px' }}>Sign out</button>
            </>
          ) : null}
          <NavDropdown current="/" dropdownRef={dropdownRef} open={dropdownOpen} setOpen={setDropdownOpen} />
        </div>
      </nav>

      <div className="content-narrow">
        <div style={{ paddingTop: 'var(--sp-10)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-8)' }}>

          <div className="fade-up">
            <h1 className="section-title">Find your<br />spot.</h1>
            <p className="section-subtitle" style={{ marginTop: 'var(--sp-2)', maxWidth: '300px' }}>
              Real-time availability across 3 LA locations.
            </p>
          </div>

          {!user && (
            <div className="glass glass-card fade-up fade-up-1" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--sp-5)' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: 'var(--sp-3)' }}>
                Enter any user ID to demo (user_000001 – user_005000)
              </p>
              <div style={{ display: 'flex', gap: 'var(--sp-3)' }}>
                <input className="input-glass" value={userId} onChange={e => setUserId(e.target.value)}
                  placeholder="user_000001" onKeyDown={e => e.key === 'Enter' && login()} />
                <button className="btn-glass primary" onClick={login} style={{ flexShrink: 0, minHeight: 40 }}>Sign in</button>
              </div>
              {error && <p style={{ fontSize: '12px', color: 'var(--danger)', marginTop: 'var(--sp-2)' }}>{error}</p>}
            </div>
          )}

          {error && user && (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)', borderRadius: 'var(--r-md)', background: 'var(--danger-dim)', border: '1px solid rgba(224,48,48,0.2)', fontSize: '13px', color: 'var(--danger)' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase' }}>Nearby Lots</h2>
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Live · 10s refresh</span>
            </div>
            {loadingLots ? (
              <div style={{ padding: 'var(--sp-16)', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '14px' }}>Loading…</div>
            ) : (
              lots.map(lot => <LotCard key={lot.id} lot={lot} onSelect={reserve} loading={reserving === lot.id} />)
            )}
          </div>

          <div style={{ paddingBottom: 'var(--sp-8)', textAlign: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>ParkFlow · Smart Parking Intelligence</span>
          </div>
        </div>
      </div>
    </div>
  )
}
