-- ============================================================
-- ParkFlow Schema
-- ============================================================

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,              -- 'user_000001'
  display_name  TEXT NOT NULL,
  age_range     TEXT,                          -- '25-34' | NULL
  gender        TEXT,                          -- 'male'|'female'|'non_binary'|'prefer_not_to_say'|NULL
  is_synthetic  INTEGER NOT NULL DEFAULT 1,   -- 1 = sim-generated
  created_at    INTEGER NOT NULL               -- unix seconds
);

-- ── Lots ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lots (
  id                TEXT PRIMARY KEY,          -- 'lot_century_city'
  name              TEXT NOT NULL,
  address           TEXT,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  floors            INTEGER NOT NULL DEFAULT 4,
  rows_per_floor    INTEGER NOT NULL DEFAULT 8,
  spots_per_row     INTEGER NOT NULL DEFAULT 10,
  hourly_rate       REAL NOT NULL DEFAULT 3.00,
  surcharge_rate    REAL NOT NULL DEFAULT 5.00, -- per 15 min over grace
  grace_minutes     INTEGER NOT NULL DEFAULT 10,
  eta_threshold_min INTEGER NOT NULL DEFAULT 8  -- assign when ETA <= this
);

-- ── Spots ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spots (
  id          TEXT PRIMARY KEY,                -- 'lot_cc_F1_R3_S07'
  lot_id      TEXT NOT NULL REFERENCES lots(id),
  floor       INTEGER NOT NULL,
  row         INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  spot_type   TEXT NOT NULL DEFAULT 'standard', -- standard|ada|ev|reserved
  status      TEXT NOT NULL DEFAULT 'available' -- available|occupied|reserved|maintenance
);

CREATE INDEX IF NOT EXISTS idx_spots_lot_status ON spots(lot_id, status);
CREATE INDEX IF NOT EXISTS idx_spots_lot_type   ON spots(lot_id, spot_type);

-- ── Sessions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  lot_id          TEXT NOT NULL REFERENCES lots(id),
  spot_id         TEXT REFERENCES spots(id),
  state           TEXT NOT NULL DEFAULT 'CREATED',
  -- state: CREATED|ASSIGNED|ARRIVED_LOT|PARKED|TIMER_ENDED|EXITING|CLOSED
  --        |CANCELLED|CONFLICT|ABANDONED
  created_at      INTEGER NOT NULL,
  assigned_at     INTEGER,
  arrived_lot_at  INTEGER,
  parked_at       INTEGER,
  timer_end_at    INTEGER,     -- scheduled end (parked_at + booked_minutes * 60)
  timer_ended_at  INTEGER,     -- actual moment timer hit zero
  grace_end_at    INTEGER,     -- timer_end_at + grace_minutes * 60
  exiting_at      INTEGER,
  closed_at       INTEGER,
  booked_minutes  INTEGER DEFAULT 120,
  actual_minutes  INTEGER,     -- computed on exit
  base_charge     REAL,
  surcharge       REAL DEFAULT 0,
  total_charge    REAL,
  is_synthetic    INTEGER NOT NULL DEFAULT 0,
  -- analytics denorm
  assignment_latency_ms INTEGER  -- time from CREATED to ASSIGNED in ms
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_lot     ON sessions(lot_id);
CREATE INDEX IF NOT EXISTS idx_sessions_state   ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

-- ── Events (bounded audit log) ────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT REFERENCES sessions(id),
  user_id     TEXT,
  lot_id      TEXT,
  event_type  TEXT NOT NULL,
  -- event_type: SESSION_CREATED|SPOT_ASSIGNED|ARRIVED_LOT|PARKED|
  --             TIMER_ENDED|SURCHARGE_STARTED|EXITING|CLOSED|
  --             CONFLICT|REASSIGNED|CANCELLED|ABANDONED|
  --             SIM_TICK|OCCUPANCY_SNAPSHOT
  payload     TEXT,           -- JSON blob
  sim_minute  INTEGER,        -- sim time when event occurred (NULL for real events)
  ts          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_lot     ON events(lot_id);

-- Trigger: keep events table bounded to last 50k rows
CREATE TRIGGER IF NOT EXISTS trg_events_prune
AFTER INSERT ON events
WHEN (SELECT COUNT(*) FROM events) > 50000
BEGIN
  DELETE FROM events WHERE id IN (
    SELECT id FROM events ORDER BY id ASC LIMIT 1000
  );
END;

-- ── Simulation Runs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sim_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  seed           INTEGER NOT NULL DEFAULT 42,
  speed_mult     INTEGER NOT NULL DEFAULT 60,
  user_count     INTEGER NOT NULL DEFAULT 5000,
  non_app_pct    REAL NOT NULL DEFAULT 0.15,
  conflict_pct   REAL NOT NULL DEFAULT 0.03,
  event_mode     INTEGER NOT NULL DEFAULT 0,
  sim_day_hours  INTEGER NOT NULL DEFAULT 14,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|running|paused|complete|error
  sim_minute     INTEGER NOT NULL DEFAULT 0,       -- current sim progress
  started_at     INTEGER,
  paused_at      INTEGER,
  ended_at       INTEGER
);

-- ── Metrics Aggregates ────────────────────────────────────────
-- Updated by sim engine and real sessions. Used for fast analytics queries.
CREATE TABLE IF NOT EXISTS metrics_aggregate (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,          -- 'YYYY-MM-DD'
  hour_bucket     INTEGER NOT NULL,       -- 0-23
  lot_id          TEXT NOT NULL,
  age_range       TEXT NOT NULL DEFAULT '__all__',  -- bucketed or '__all__'
  gender          TEXT NOT NULL DEFAULT '__all__',  -- or '__all__'
  -- counts
  session_count   INTEGER NOT NULL DEFAULT 0,
  parked_count    INTEGER NOT NULL DEFAULT 0,
  conflict_count  INTEGER NOT NULL DEFAULT 0,
  abandon_count   INTEGER NOT NULL DEFAULT 0,
  overstay_count  INTEGER NOT NULL DEFAULT 0,
  -- sums (for averages)
  sum_time_to_spot_ms   INTEGER NOT NULL DEFAULT 0,  -- assigned_at - created_at
  sum_dwell_minutes     REAL NOT NULL DEFAULT 0,
  sum_surcharge         REAL NOT NULL DEFAULT 0,
  sum_revenue           REAL NOT NULL DEFAULT 0,
  -- histogram bins for p50/p90 approximation (time_to_spot in seconds)
  -- stored as JSON: {"0":N,"30":N,"60":N,"120":N,"300":N,"600":N,"1800":N}
  tts_histogram   TEXT NOT NULL DEFAULT '{}',
  -- dwell histogram bins in minutes
  -- {"15":N,"30":N,"60":N,"90":N,"120":N,"150":N,"180":N,"240":N}
  dwell_histogram TEXT NOT NULL DEFAULT '{}',
  UNIQUE(date, hour_bucket, lot_id, age_range, gender)
);

CREATE INDEX IF NOT EXISTS idx_agg_date_lot ON metrics_aggregate(date, lot_id);
CREATE INDEX IF NOT EXISTS idx_agg_cohort   ON metrics_aggregate(age_range, gender);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_spots_coords
ON spots(lot_id, floor, row, position);