// Keno: 40 numbers, 10 drawn, the player picks 1-10 distinct numbers. Pure and deterministic given an Rng.
import type { Rng } from '../fair/fair.ts';
import { KENO_NUMBERS, KENO_DRAWN, KENO_MAX_PICKS } from './keno-maths.ts';
import { KENO_PAYTABLE } from './keno-paytable.ts';

export const KENO_ID = 'keno';

export interface KenoParams { picks: number[] }
export interface KenoOutcome { drawn: number[]; hits: number[]; multiplier: number } // multiplier in hundredths

export function parseKenoParams(raw: unknown): KenoParams {
  const picks = (raw as { picks?: unknown } | null)?.picks;
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > KENO_MAX_PICKS) throw new Error(`pick 1 to ${KENO_MAX_PICKS} numbers`);
  const seen = new Set<number>();
  for (const p of picks) {
    if (!Number.isInteger(p) || p < 1 || p > KENO_NUMBERS) throw new Error(`numbers must be 1 to ${KENO_NUMBERS}`);
    if (seen.has(p)) throw new Error('numbers must be different');
    seen.add(p);
  }
  return { picks: [...seen].sort((a, b) => a - b) };
}

/** Draw 10 of 40 by a partial Fisher-Yates shuffle: each draw is one unbiased rng.int call. */
export function drawNumbers(rng: Rng): number[] {
  const pool = Array.from({ length: KENO_NUMBERS }, (_, i) => i + 1);
  for (let i = 0; i < KENO_DRAWN; i++) {
    const j = i + rng.int(KENO_NUMBERS - i);
    const t = pool[i] as number; pool[i] = pool[j] as number; pool[j] = t;
  }
  return pool.slice(0, KENO_DRAWN);
}

export function playKeno(params: KenoParams, rng: Rng): KenoOutcome {
  const drawn = drawNumbers(rng);
  const set = new Set(drawn);
  const hits = params.picks.filter(p => set.has(p));
  const row = KENO_PAYTABLE[params.picks.length];
  if (!row) throw new Error('no paytable');
  return { drawn, hits, multiplier: row[hits.length] ?? 0 };
}

/** Largest multiplier any Keno round can pay (hundredths), for exposure checks. */
export const KENO_MAX_MULTIPLIER = Math.max(...Object.values(KENO_PAYTABLE).flat());
