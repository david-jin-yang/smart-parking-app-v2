# ParkFlow — Smart Parking Intelligence

A production-grade smart parking application with a clean provider abstraction
that separates simulation from hardware. The same app runs in demo mode against
synthetic data or against real LPR cameras and sensors by flipping one env var.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Seed the database (lots, spots, 5,000 synthetic users)
npm run seed

# 3. Start the dev server
npm run dev

# 4. Open the app
open http://localhost:3000

# Run unit tests
npm test
```

### Demo Login
- User IDs: `user_000001` through `user_005000`
- No password required in demo mode
- **Test Mode** (amber badge) bypasses proximity check so you can demo the full flow instantly

### Key Routes
| Route | Description |
|-------|-------------|
| `/` | User app (lot selection → session → receipt) |
| `/admin` | Simulation controls + occupancy heatmaps + live event log |
| `/analytics` | KPI dashboard + cohort breakdowns + hourly trends |

---

## Architecture

```
parkflow/
├── app/
│   ├── api/
│   │   ├── demo/          # Demo auth (login/logout/me)
│   │   ├── lots/          # Lot listing + detail
│   │   ├── sessions/      # Full session state machine endpoints
│   │   ├── sim/           # Simulation control + SSE event stream
│   │   ├── analytics/     # KPI summary + cohort queries
│   │   └── hardware/      # Stub for future hardware webhooks
│   ├── screens/           # Mobile-first user flow screens
│   ├── components/        # Shared UI (NavBar, SpotGrid, TimerRing)
│   ├── admin/             # Admin dashboard page
│   └── analytics/         # Analytics dashboard page
├── lib/
│   ├── core/
│   │   ├── types.ts       # All shared TypeScript types
│   │   └── sessionMachine.ts  # Pure state machine logic + charge calc
│   ├── db/
│   │   └── index.ts       # SQLite schema + connection
│   ├── providers/
│   │   └── LotProvider.ts # Interface + SimLotProvider + HardwareLotProvider stub
│   └── sim/
│       └── engine.ts      # Deterministic simulation engine
├── scripts/
│   └── seed.ts            # Database seeding script
└── __tests__/
    └── sessionMachine.test.ts  # Unit tests for state machine + charges
```

---

## Provider Abstraction

### Switching Providers

The `LOT_PROVIDER` environment variable controls which provider is used:

```bash
# Demo / simulation mode (default)
LOT_PROVIDER=sim npm run dev

# Real hardware mode
LOT_PROVIDER=hardware npm run dev
```

### Adding a New Provider

1. Create a class implementing `LotProvider` in `lib/providers/`:

```typescript
export class MyProvider implements LotProvider {
  async getOccupancy(lotId: string) { /* ... */ }
  async getLotLayout(lotId: string) { /* ... */ }
  async assignSpot(params) { /* ... */ }
  async confirmEvent(eventType, payload) { /* ... */ }
  async releaseSpot(spotId) { /* ... */ }
  async getAllLots() { /* ... */ }
}
```

2. Register it in `getLotProvider()` in `LotProvider.ts`:

```typescript
if (mode === 'my-provider') {
  _provider = new MyProvider()
}
```

### HardwareLotProvider Implementation Guide

The stub in `lib/providers/LotProvider.ts` shows the TODOs:

- `getOccupancy`: Query camera/pressure sensor API `GET /lots/{id}/occupancy`
- `assignSpot`: Send gate open + spot reservation command to gate controller
- `confirmEvent`: Validate HMAC-SHA256 webhook from hardware, update spot status in DB
- `releaseSpot`: Send release command to gate/barrier controller
- Hardware events come in via `POST /api/hardware/events` (see that route for the payload schema)

---

## Session State Machine

```
CREATED → ASSIGNED → ARRIVED_LOT → PARKED → TIMER_ENDED → SURCHARGE_ACCRUING → EXITING → CLOSED
              ↓                                                                        ↑
           CONFLICT → ASSIGNED                                                         │
              ↓                                                                        │
           CANCELLED ←─────────────────────────────────────────────────────────────────┤
ARRIVED_LOT → ABANDONED (no activity 30+ min)                                         │
PARKED → EXITING (early exit skips timer states)  ────────────────────────────────────┘
```

The state machine is pure functions in `lib/core/sessionMachine.ts` with no I/O,
making it fully unit-testable.

**Charge calculation:**
```
base_charge = ceil(dwell_minutes / 60 × hourly_rate, 2 decimals)
over_minutes = max(0, dwell_minutes - timer_minutes - grace_minutes)
surcharge = floor(over_minutes / 15) × surcharge_per_15min
total = base_charge + surcharge
```

---

## Simulation Engine

The engine in `lib/sim/engine.ts` is deterministic (seeded RNG, no `Math.random()`):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `seed` | 42 | RNG seed for reproducible runs |
| `speed_multiplier` | 60 | Simulated minutes per real second |
| `user_count` | 5,000 | Synthetic users |
| `sim_day_hours` | 14 | Hours simulated (8am–10pm) |
| `non_app_user_pct` | 0.15 | Fraction who bypass the app |
| `conflict_probability` | 0.03 | Spot conflict rate |
| `event_mode` | false | 3× traffic multiplier |
| `eta_threshold_minutes` | 8 | Minutes before arrival to assign |

Real-time occupancy snapshots are broadcast via SSE every 5 simulated minutes.

---

## Analytics Data Model

The `metrics_aggregate` table is keyed by `(date_bucket, hour_bucket, lot_id, age_range, gender)`
and supports fast analytics without full table scans:

```sql
SELECT age_range, SUM(total_dwell_min) / SUM(completed_count) as avg_dwell
FROM metrics_aggregate
GROUP BY age_range
```

**Primary KPIs tracked:**
- `time_to_spot` (assign → parked)
- `time_in_lot_to_park` (arrived_lot → parked)
- `dwell_time` (parked → exit)
- `conflict_rate`, `abandon_rate`, `overstay_rate`
- Revenue and surcharge totals

**Cohort dimensions:** `age_range` (optional), `gender` (optional, defaults to `unknown`)

---

## Security Notes

| Area | Implementation |
|------|----------------|
| Auth cookie | `httpOnly`, `sameSite=strict`, 7-day expiry |
| SQL injection | Parameterized queries via `better-sqlite3` |
| No real PII | All users synthetic; no email, no exact DOB |
| ADA compliance | ADA spots excluded from app assignment pool entirely |
| Data minimization | Location not stored server-side; proximity is UI-only |
| Event log bounds | Pruned to last 50,000 events |

---

## Database

SQLite via `better-sqlite3`. Database file: `data/parkflow.db` (auto-created).

**Tables:** `users`, `lots`, `spots`, `sessions`, `events`, `metrics_aggregate`, `sim_runs`

Re-seed at any time:
```bash
npm run seed  # Clears and re-creates all data
```

---

## Lot Configuration

3 simulated LA lots (real coordinates):

| Lot | Address | Rate |
|-----|---------|------|
| Century City Mall | 10250 Santa Monica Blvd | $3.00/hr |
| Glendale Galleria | 2148 Glendale Galleria | $2.50/hr |
| Old Town Pasadena | 30 N Garfield Ave | $2.00/hr |

Each lot: 4 floors × 8 rows × 10 spots = 320 spots
- First 2 spots in Row 1 = ADA (walk-up only, excluded from app assignment)
- Last spot in each row = EV charging

---

## Running Tests

```bash
npm test
# or with coverage:
npm test -- --coverage
```

Tests cover:
- All state machine transitions (valid + invalid)
- Charge calculation edge cases (at boundary, over grace, 0 dwell)
- Surcharge interval calculation
- Rounding correctness

---

## Production Roadmap

To move from demo → production:

1. **Replace `SimLotProvider`** with `HardwareLotProvider` (implement the TODOs)
2. **Add real auth** — swap demo cookie login with OAuth or magic link
3. **Add push notifications** — POST to `/api/sessions/{id}/assign` triggers should push via FCM/APNs
4. **Enable GPS proximity** — client sends actual lat/lng to `/api/sessions/{id}/assign` instead of bypass
5. **Add Stripe** — `/api/sessions/{id}/exit` calls `stripe.paymentIntents.create()`
6. **Deploy** — works on Vercel (Next.js) + Fly.io (SQLite with persistent volume) or Railway
