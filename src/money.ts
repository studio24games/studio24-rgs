// Money as integer micro-units (1 unit of currency = 1,000,000 micro-units).
// The casino wallet API speaks decimals with 2 places, so every amount on the wire is a whole number of cents.

export const MICRO = 1_000_000;
const CENT = 10_000; // micro-units per cent

/** Parse a wire amount (number with at most 2 decimals) into micro-units. Throws on anything else. */
export function fromWire(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`invalid amount: ${String(v)}`);
  const cents = Math.round(v * 100);
  if (Math.abs(cents - v * 100) > 1e-6) throw new Error(`more than 2 decimals: ${v}`);
  return cents * CENT;
}

/** Micro-units to a 2-decimal wire amount. Only whole cents are allowed on the wire. */
export function toWire(micro: number): number {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new Error(`invalid micro amount: ${micro}`);
  if (micro % CENT !== 0) throw new Error(`not a whole cent: ${micro}`);
  return micro / CENT / 100;
}

/** Win = bet x multiplier, rounded DOWN to a whole cent (the house never over-pays by rounding). */
export function winFor(betMicro: number, multiplierHundredths: number): number {
  // multiplier is held as an integer number of hundredths (e.g. 3.85x = 385) to avoid float maths.
  const raw = (BigInt(betMicro) * BigInt(multiplierHundredths)) / 100n;
  const floored = (raw / BigInt(CENT)) * BigInt(CENT);
  return Number(floored);
}
