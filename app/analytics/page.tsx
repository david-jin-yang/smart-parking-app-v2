'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis,
  Tooltip, ResponsiveContainer, Cell
} from 'recharts'

// ── Types ────────────────────────────────────────────────────────────────────

interface KPIs {
  total_sessions: number
  total_parked: number
  total_conflicts: number
  total_abandoned: number
  total_overstays: number
  avg_dwell_minutes: number
  avg_tts_seconds: number
  conflict_rate: number
  abandon_rate: number
  overstay_rate: number
  total_revenue: number
  total_surcharge: number
}

interface Percentiles {
  tts_p50: number | null
  tts_p90: number | null
  dwell_p50: number | null
  dwell_p90: number | null
}

interface HourlyPoint {
  hour_bucket: number
  sessions: number
  parked: number
  revenue: number
}

interface CohortRow {
  cohort: string
  sessions: number
  parked: number
  conflict_rate: number
  overstay_rate: number
  avg_dwell_minutes: number
  revenue: number
}

interface ComparisonSide {
  sessions: number
  avg_tts_seconds?: number
  avg_search_minutes?: number
  tts_p50?: number | null
  tts_p90?: number | null
  search_p50?: number | null
  search_p90?: number | null
  label: string
}

interface Comparison {
  type1: ComparisonSide
  type2: ComparisonSide
  avg_time_saved_minutes: number | null
}

interface SpecialSpots {
  ev_charge_trips: number
  ev_charge_turnaway: number
  ev_turnaway_rate: number
  handicap_trips: number
  handicap_overflow: number
  hc_overflow_rate: number
}

interface SummaryData {
  date: string
  lot_id: string
  kpis: KPIs
  comparison: Comparison
  special_spots: SpecialSpots
  percentiles: Percentiles
  hourly_trend: HourlyPoint[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hourLabel(h: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}${ampm}`
}

const LOT_OPTIONS = [
  { id: 'all', label: 'All Lots' },
  { id: 'lot_century_city', label: 'Century City' },
  { id: 'lot_glendale_galleria', label: 'Glendale' },
  { id: 'lot_old_town_pasadena', label: 'Pasadena' },
]

// ── Custom tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, formatter }: {
  active?: boolean
  payload?: Array<{ value: number; name: string; color: string }>
  label?: string | number
  formatter?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'rgba(15,23,42,0.95)',
      border: '1px solid var(--glass-border)',
      borderRadius: 'var(--r-sm)',
      padding: '8px 12px',
      fontSize: '12px',
    }}>
      <div style={{ color: 'var(--text-tertiary)', marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span>
          <span className="mono">{formatter ? formatter(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="glass glass-card" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--sp-4)', flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div className="mono" style={{ fontSize: '22px', fontWeight: 500, letterSpacing: '-0.03em', color: color ?? 'var(--text-primary)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function CompRow({ label, value, highlight, warn }: { label: string; value: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="mono" style={{ fontSize: '13px', fontWeight: highlight || warn ? 600 : 400, color: highlight ? 'var(--accent)' : warn ? 'var(--warning)' : 'var(--text-secondary)' }}>{value}</span>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 'var(--sp-3)' }}>
      {children}
    </h2>
  )
}

function CohortTable({ rows }: { rows: CohortRow[] }) {
  if (!rows.length) {
    return <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', textAlign: 'center', padding: 'var(--sp-8)' }}>No data yet — run the simulation first.</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            {['Cohort', 'Sessions', 'Parked', 'Conflict%', 'Overstay%', 'Avg Dwell', 'Revenue'].map(h => (
              <th key={h} style={{ textAlign: h === 'Cohort' ? 'left' : 'right', padding: '6px 8px', color: 'var(--text-tertiary)', fontWeight: 500, fontSize: '11px', letterSpacing: '0.04em', borderBottom: '1px solid var(--glass-border)' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <td style={{ padding: '8px 8px', color: 'var(--text-primary)', fontWeight: 500 }}>{row.cohort}</td>
              <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{row.sessions.toLocaleString()}</td>
              <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>{row.parked.toLocaleString()}</td>
              <td style={{ padding: '8px 8px', textAlign: 'right', color: row.conflict_rate > 5 ? 'var(--danger)' : 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{row.conflict_rate}%</td>
              <td style={{ padding: '8px 8px', textAlign: 'right', color: row.overstay_rate > 10 ? 'var(--warning)' : 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{row.overstay_rate}%</td>
              <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>{row.avg_dwell_minutes}m</td>
              <td style={{ padding: '8px 8px', textAlign: 'right', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>${row.revenue.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
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
  const today = new Date().toISOString().split('T')[0]

  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [cohorts, setCohorts] = useState<CohortRow[]>([])
  const [dimension, setDimension] = useState<'age_range' | 'gender'>('age_range')
  const [lotId, setLotId] = useState<string>('all')
  const [date, setDate] = useState(today)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    setLoading(true)
    const lotParam = lotId === 'all' ? '' : `&lot_id=${lotId}`
    const [sumRes, cohRes] = await Promise.all([
      fetch(`/api/analytics/summary?date=${date}${lotParam}`),
      fetch(`/api/analytics/cohorts?date=${date}&dimension=${dimension}${lotParam}`),
    ])
    const [sumData, cohData] = await Promise.all([sumRes.json(), cohRes.json()])
    setSummary(sumData)
    setCohorts(cohData.cohorts ?? [])
    setLoading(false)
  }, [date, lotId, dimension])

  useEffect(() => { fetchData() }, [fetchData])

  const kpis = summary?.kpis
  const pct = summary?.percentiles
  const hourly = summary?.hourly_trend ?? []
  const comp = summary?.comparison
  const special = summary?.special_spots

  const hasData = kpis && kpis.total_sessions > 0

  return (
    <div className="shell">
      <div className="bg-mesh" />

      {/* ── Nav ── */}
      <nav className="nav-bar">
        <button className="nav-logo" onClick={() => router.push('/')}>
          Park<span className="accent">Flow</span>
          <span className="sub">Analytics</span>
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
                <button className="nav-dropdown-item" onClick={() => { router.push('/admin'); setDropdownOpen(false) }}>
                  <span className="item-icon">⚙️</span> Admin
                </button>
                <button className="nav-dropdown-item active" onClick={() => { router.push('/analytics'); setDropdownOpen(false) }}>
                  <span className="item-icon">📊</span> Analytics
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* ── Content ── */}
      <div className="content">
        <div style={{ paddingTop: 'var(--sp-6)', paddingBottom: 'var(--sp-8)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)' }}>

          {/* ── Filters ── */}
          <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input-glass" type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ width: 160, padding: '7px 10px', fontSize: '13px' }} />
            <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              {LOT_OPTIONS.map(opt => (
                <button key={opt.id} className={`btn-glass ${lotId === opt.id ? 'primary' : ''}`}
                  onClick={() => setLotId(opt.id)} style={{ padding: '6px 12px', fontSize: '12px', minHeight: 36 }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {!hasData && !loading && (
            <div className="glass" style={{ borderRadius: 'var(--r-lg)', padding: 'var(--sp-6)', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: 'var(--sp-2)' }}>No data for this date yet.</div>
              <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Run the simulation from the <button className="btn-glass" onClick={() => router.push('/admin')} style={{ padding: '2px 8px', fontSize: '11px', minHeight: 24, display: 'inline-flex' }}>Admin</button> page to generate data.</div>
            </div>
          )}

          {/* ── KPI grid ── */}
          <section>
            <SectionLabel>Key Metrics</SectionLabel>
            <div className="grid-4">
              <KpiCard label="Sessions"  value={(kpis?.total_sessions ?? 0).toLocaleString()} />
              <KpiCard label="Parked"    value={(kpis?.total_parked ?? 0).toLocaleString()} color="var(--success)" />
              <KpiCard label="Revenue"   value={`$${(kpis?.total_revenue ?? 0).toFixed(0)}`} color="var(--accent)" />
              <KpiCard label="Surcharge" value={`$${(kpis?.total_surcharge ?? 0).toFixed(0)}`} color="var(--warning)" />
            </div>
          </section>

          <section>
            <SectionLabel>Performance</SectionLabel>
            <div className="grid-4">
              <KpiCard label="Avg Dwell"     value={`${kpis?.avg_dwell_minutes ?? 0}m`} />
              <KpiCard label="Avg TTS"       value={`${kpis?.avg_tts_seconds ?? 0}s`} sub="time to spot" />
              <KpiCard label="Conflict Rate" value={`${kpis?.conflict_rate ?? 0}%`} color={kpis && kpis.conflict_rate > 5 ? 'var(--danger)' : undefined} />
              <KpiCard label="Overstay Rate" value={`${kpis?.overstay_rate ?? 0}%`} color={kpis && kpis.overstay_rate > 10 ? 'var(--warning)' : undefined} />
            </div>
          </section>

          {/* ── Percentiles ── */}
          {pct && (
            <section>
              <SectionLabel>Latency Percentiles</SectionLabel>
              <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)' }}>
                <div className="grid-4">
                  {[
                    { label: 'TTS p50',   value: pct.tts_p50   != null ? `${pct.tts_p50}s`   : '—' },
                    { label: 'TTS p90',   value: pct.tts_p90   != null ? `${pct.tts_p90}s`   : '—' },
                    { label: 'Dwell p50', value: pct.dwell_p50 != null ? `${pct.dwell_p50}m` : '—' },
                    { label: 'Dwell p90', value: pct.dwell_p90 != null ? `${pct.dwell_p90}m` : '—' },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: 4 }}>{label}</div>
                      <div className="mono" style={{ fontSize: '18px', color: 'var(--text-primary)' }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* ── Charts side-by-side ── */}
          {hourly.length > 0 && (
            <div className="grid-2">
              <section>
                <SectionLabel>Sessions by Hour</SectionLabel>
                <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)' }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={hourly} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                      <XAxis dataKey="hour_bucket" tickFormatter={hourLabel} tick={{ fill: 'rgba(10,18,40,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: 'rgba(10,18,40,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="sessions" name="Sessions" radius={[3, 3, 0, 0]}>
                        {hourly.map((entry, index) => (
                          <Cell key={index} fill={entry.sessions === Math.max(...hourly.map(h => h.sessions)) ? 'var(--accent)' : 'rgba(47,126,245,0.30)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section>
                <SectionLabel>Revenue by Hour</SectionLabel>
                <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)' }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={hourly} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                      <XAxis dataKey="hour_bucket" tickFormatter={hourLabel} tick={{ fill: 'rgba(10,18,40,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: 'rgba(10,18,40,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip content={<ChartTooltip formatter={v => `$${v.toFixed(2)}`} />} />
                      <Line dataKey="revenue" name="Revenue" stroke="var(--success)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>
          )}

          {/* ── Cohort + Type comparison side-by-side ── */}
          <div className="grid-2">
            {/* Cohort Breakdown */}
            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-3)' }}>
                <SectionLabel style={{ marginBottom: 0 } as React.CSSProperties}>Cohort Breakdown</SectionLabel>
                <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                  <button className={`btn-glass ${dimension === 'age_range' ? 'primary' : ''}`} onClick={() => setDimension('age_range')} style={{ padding: '4px 10px', fontSize: '11px', minHeight: 28 }}>Age</button>
                  <button className={`btn-glass ${dimension === 'gender' ? 'primary' : ''}`} onClick={() => setDimension('gender')} style={{ padding: '4px 10px', fontSize: '11px', minHeight: 28 }}>Gender</button>
                </div>
              </div>
              <div className="glass" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)' }}>
                <CohortTable rows={cohorts} />
              </div>
            </section>

            {/* Type1 vs Type2 */}
            {comp && (comp.type1.sessions > 0 || comp.type2.sessions > 0) ? (
              <section>
                <SectionLabel>Active vs Passive: Time to Spot</SectionLabel>
                <div className="glass-md glass-card" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
                  {comp.avg_time_saved_minutes !== null && comp.avg_time_saved_minutes > 0 && (
                    <div style={{ textAlign: 'center', padding: 'var(--sp-4)', borderRadius: 'var(--r-lg)', background: 'var(--success-dim)', border: '1px solid rgba(24,168,74,0.2)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--success)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 'var(--sp-1)' }}>Avg Time Saved</div>
                      <div className="mono" style={{ fontSize: '36px', fontWeight: 300, color: 'var(--success)', letterSpacing: '-0.04em', lineHeight: 1 }}>~{comp.avg_time_saved_minutes}m</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 'var(--sp-1)' }}>Active users have spot waiting on arrival</div>
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
                    <div style={{ padding: 'var(--sp-4)', borderRadius: 'var(--r-lg)', background: 'var(--accent-glass)', border: '1px solid rgba(47,126,245,0.15)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 'var(--sp-3)', fontWeight: 500 }}>Active (Type 1)</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                        <CompRow label="Sessions" value={comp.type1.sessions.toLocaleString()} />
                        <CompRow label="Avg TTS" value="~0.03 min" highlight />
                        <CompRow label="Method" value="Pre-assigned" />
                      </div>
                    </div>
                    <div style={{ padding: 'var(--sp-4)', borderRadius: 'var(--r-lg)', background: 'var(--warning-dim)', border: '1px solid rgba(224,123,0,0.15)' }}>
                      <div style={{ fontSize: '11px', color: 'var(--warning)', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 'var(--sp-3)', fontWeight: 500 }}>Passive (Type 2)</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                        <CompRow label="Sessions" value={comp.type2.sessions.toLocaleString()} />
                        <CompRow label="Avg TTS" value={`${comp.type2.avg_search_minutes ?? '—'} min`} warn />
                        <CompRow label="Method" value="Gate arrival" />
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            ) : <div />}
          </div>

          {/* ── Special spots ── */}
          {special && (special.ev_charge_trips > 0 || special.handicap_trips > 0) && (
            <section>
              <SectionLabel>Special Spot Utilization</SectionLabel>
              <div className="grid-2">
                <div className="glass-md glass-card" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 'var(--sp-3)', fontWeight: 500 }}>⚡ EV Charging</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                    <CompRow label="Charge trips"  value={special.ev_charge_trips.toLocaleString()} />
                    <CompRow label="Turned away"   value={special.ev_charge_turnaway.toLocaleString()} warn={special.ev_charge_turnaway > 0} />
                    <CompRow label="Turnaway rate" value={`${special.ev_turnaway_rate}%`} warn={special.ev_turnaway_rate > 20} />
                  </div>
                </div>
                <div className="glass-md glass-card" style={{ borderRadius: 'var(--r-xl)', padding: 'var(--sp-5)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 'var(--sp-3)', fontWeight: 500 }}>♿ Handicap</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                    <CompRow label="HC trips"      value={special.handicap_trips.toLocaleString()} />
                    <CompRow label="Overflow"      value={special.handicap_overflow.toLocaleString()} warn={special.handicap_overflow > 0} />
                    <CompRow label="Overflow rate" value={`${special.hc_overflow_rate}%`} warn={special.hc_overflow_rate > 30} />
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── Behavior summary ── */}
          {kpis && (
            <section>
              <SectionLabel>Behavior Summary</SectionLabel>
              <div className="grid-3">
                <KpiCard label="Conflicts" value={kpis.total_conflicts.toLocaleString()} color="var(--danger)" />
                <KpiCard label="Abandoned" value={kpis.total_abandoned.toLocaleString()} color="var(--text-secondary)" />
                <KpiCard label="Overstays" value={kpis.total_overstays.toLocaleString()} color="var(--warning)" />
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  )
}
