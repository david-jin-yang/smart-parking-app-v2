// lib/db/index.ts

import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

let db: Database.Database | null = null

export default function getDb() {
  if (db) return db

  const dataDir = path.join(process.cwd(), 'data')
  const dbPath = path.join(dataDir, 'parkflow.db')

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  db = new Database(dbPath)

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `)

  const hasUsers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='users'`
    )
    .get()

  if (!hasUsers) {
    console.log('📦 Initializing database schema...')
    const schemaPath = path.join(process.cwd(), 'schema.sql')

    if (!fs.existsSync(schemaPath)) {
      throw new Error('schema.sql not found in project root')
    }

    const schema = fs.readFileSync(schemaPath, 'utf8')
    db.exec(schema)
    console.log('✅ Schema applied')
  }

  return db
}