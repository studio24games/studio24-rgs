// Exact Keno probabilities. 40 numbers, 10 drawn.
export const KENO_NUMBERS = 40;
export const KENO_DRAWN = 10;
export const KENO_MAX_PICKS = 10;

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** P(hits = h) for h = 0..picks, when the player picks `picks` numbers (hypergeometric). */
export function hitProbabilities(picks: number): number[] {
  const total = choose(KENO_NUMBERS, KENO_DRAWN);
  return Array.from({ length: picks + 1 }, (_, h) => (choose(picks, h) * choose(KENO_NUMBERS - picks, KENO_DRAWN - h)) / total);
}

/** Exact return to player for a paytable row (multipliers in hundredths). */
export function exactRtp(picks: number, row: readonly number[]): number {
  return hitProbabilities(picks).reduce((s, p, h) => s + p * ((row[h] ?? 0) / 100), 0);
}
