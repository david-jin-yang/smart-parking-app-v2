/**
 * lib/auth.ts
 *
 * JWT helpers for demo auth.
 * Uses httpOnly cookies — no localStorage.
 * jose is used for signing (works in both Node and Edge runtimes).
 */

import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'

const COOKIE_NAME = process.env.COOKIE_NAME ?? 'parkflow_session'
const JWT_SECRET = process.env.JWT_SECRET ?? 'parkflow-dev-secret-change-me'
const EXPIRY = '7d'

function getSecret(): Uint8Array {
  return new TextEncoder().encode(JWT_SECRET)
}

export interface SessionPayload {
  user_id: string
  display_name: string
}

// ── Sign ──────────────────────────────────────────────────────────────────────

export async function signToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(getSecret())
}

// ── Verify ────────────────────────────────────────────────────────────────────

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    return payload as unknown as SessionPayload
  } catch {
    return null
  }
}

// ── Get current user from cookie (server component / route handler) ────────────

export async function getCurrentUser(req?: NextRequest): Promise<SessionPayload | null> {
  let token: string | undefined

  if (req) {
    token = req.cookies.get(COOKIE_NAME)?.value
  } else {
    const cookieStore = await cookies()
    token = cookieStore.get(COOKIE_NAME)?.value
  }

  if (!token) return null
  return verifyToken(token)
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

export function cookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,  // 7 days
    secure: process.env.NODE_ENV === 'production',
  }
}
