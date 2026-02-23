import getDb from '../lib/db'

const LOTS = [
  {
    id: 'lot_century_city',
    name: 'Century City Mall',
    address: '10250 Santa Monica Blvd, Los Angeles, CA 90067',
    lat: 34.0572,
    lng: -118.4164,
    hourly_rate: 3.0,
    grace_minutes: 10,
    surcharge_rate: 5.0,
  },
  {
    id: 'lot_glendale_galleria',
    name: 'Glendale Galleria',
    address: '2148 Glendale Galleria, Glendale, CA 91210',
    lat: 34.1505,
    lng: -118.2548,
    hourly_rate: 2.5,
    grace_minutes: 10,
    surcharge_rate: 4.0,
  },
  {
    id: 'lot_old_town_pasadena',
    name: 'Old Town Pasadena',
    address: '30 N Garfield Ave, Pasadena, CA 91101',
    lat: 34.1478,
    lng: -118.1445,
    hourly_rate: 2.0,
    grace_minutes: 15,
    surcharge_rate: 3.0,
  },
]

const FLOORS = 4
const ROWS_PER_FLOOR = 8
const SPOTS_PER_ROW = 10

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function weightedPick<T extends { weight: number }>(arr: T[], rng: () => number): T {
  const r = rng()
  let cum = 0
  for (const item of arr) {
    cum += item.weight
    if (r < cum) return item
  }
  return arr[arr.length - 1]
}

const AGE_RANGES = [
  { val: '16-24', weight: 0.12 },
  { val: '25-34', weight: 0.25 },
  { val: '35-44', weight: 0.22 },
  { val: '45-54', weight: 0.18 },
  { val: '55-64', weight: 0.13 },
  { val: '65-80', weight: 0.1 },
]

const GENDERS = [
  { val: 'male', weight: 0.45 },
  { val: 'female', weight: 0.45 },
  { val: 'prefer_not_to_say', weight: 0.1 },
]

async function seed() {
  console.log('🌱 Seeding ParkFlow database...')
  const db = getDb()

  // Clear existing data (order matters due to foreign keys)
  db.prepare(`DELETE FROM events`).run()
  db.prepare(`DELETE FROM sessions`).run()
  db.prepare(`DELETE FROM metrics_aggregate`).run()
  db.prepare(`DELETE FROM spots`).run()
  db.prepare(`DELETE FROM lots`).run()
  db.prepare(`DELETE FROM users`).run()
  console.log('  ✓ Cleared existing data')

  // Seed lots (match schema.sql column names)
  const insertLot = db.prepare(`
    INSERT INTO lots (
      id, name, address, lat, lng,
      floors, rows_per_floor, spots_per_row,
      hourly_rate, grace_minutes, surcharge_rate
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const lot of LOTS) {
    insertLot.run(
      lot.id,
      lot.name,
      lot.address,
      lot.lat,
      lot.lng,
      FLOORS,
      ROWS_PER_FLOOR,
      SPOTS_PER_ROW,
      lot.hourly_rate,
      lot.grace_minutes,
      lot.surcharge_rate
    )
  }
  console.log(`  ✓ Seeded ${LOTS.length} lots`)

  // Seed spots (match schema.sql column names: row, not row_num)
  const insertSpot = db.prepare(`
    INSERT INTO spots (id, lot_id, floor, row, position, spot_type, status)
    VALUES (?, ?, ?, ?, ?, ?, 'available')
  `)

  let totalSpots = 0
  const seedSpots = db.transaction(() => {
    for (const lot of LOTS) {
      for (let f = 1; f <= FLOORS; f++) {
        for (let r = 1; r <= ROWS_PER_FLOOR; r++) {
          for (let p = 1; p <= SPOTS_PER_ROW; p++) {
            const spotId = `${lot.id}_F${f}_R${r}_S${String(p).padStart(2, '0')}`

            // Determine spot type
            let spotType = 'standard'
            if (p <= 2 && r === 1) spotType = 'ada' // first 2 spots in row 1
            else if (p === SPOTS_PER_ROW) spotType = 'ev' // last spot in each row

            insertSpot.run(spotId, lot.id, f, r, p, spotType)
            totalSpots++
          }
        }
      }
    }
  })
  seedSpots()
  console.log(`  ✓ Seeded ${totalSpots} spots across ${LOTS.length} lots`)

  // Seed synthetic users (users.created_at is NOT NULL in schema.sql)
  const rng = mulberry32(42)
  const USER_COUNT = 5000
  const now = Math.floor(Date.now() / 1000)

  const insertUser = db.prepare(`
    INSERT INTO users (id, display_name, age_range, gender, is_synthetic, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `)

  const seedUsers = db.transaction(() => {
    for (let i = 1; i <= USER_COUNT; i++) {
      const id = `user_${String(i).padStart(6, '0')}`
      const display_name = `Parking User ${i}`
      const age = weightedPick(AGE_RANGES, rng)
      const gender = weightedPick(GENDERS, rng)

      insertUser.run(id, display_name, age.val, gender.val, now)
    }
  })
  seedUsers()
  console.log(`  ✓ Seeded ${USER_COUNT} synthetic users`)

  console.log('\n✅ Seeding complete!')
  console.log('\nDemo login: Select any user from user_000001 to user_005000')
  console.log('Admin: /admin')
  process.exit(0)
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})