/**
 * lib/sim/rng.ts
 *
 * Deterministic seeded RNG using mulberry32.
 * Same seed → identical simulation every time.
 * Zero dependencies.
 */

export class SeededRng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0  // force uint32
  }

  /** Returns float in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Returns integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  /** Pick one item from array using weighted probabilities */
  weightedPick<T>(items: T[], weights: number[]): T {
    const r = this.next()
    let cumulative = 0
    for (let i = 0; i < items.length; i++) {
      cumulative += weights[i]
      if (r < cumulative) return items[i]
    }
    return items[items.length - 1]
  }

  /** Pick one item from array uniformly */
  pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }

  /**
   * Gaussian approximation via Box-Muller.
   * Returns a sample from N(mean, stdDev).
   * Clamped to [min, max] if provided.
   */
  gaussian(mean: number, stdDev: number, min?: number, max?: number): number {
    // Box-Muller transform
    const u1 = Math.max(1e-10, this.next())
    const u2 = this.next()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const value = mean + z * stdDev
    if (min !== undefined && max !== undefined) {
      return Math.max(min, Math.min(max, value))
    }
    return value
  }
}
