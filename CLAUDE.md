# Studio24 RGS: rules for Claude sessions

Studio24's own Remote Gaming Server, built by Barry and Carol with Claude writing the code ("case C" in the RGS
plan). The aim is to phase this platform in as the Tequity platform (Xanadu) is phased out. Read `README.md` and
`docs/PILOT.md` first.

## Stack
- TypeScript run directly by Node 22.18+ (no build step; erasable syntax only: no enums, no parameter properties).
- Postgres 16 via `pg`. Schema in `src/db/schema.sql`, applied on start-up.
- No frameworks. Keep dependencies minimal; ask before adding one.

## Money rules (never weaken these)
- Money is integer micro-units (`src/money.ts`). No floats in balances. Wire amounts are whole cents.
- A round's outcome is drawn and saved before any money moves.
- One transactionId per money movement, reused on every retry. Unknown withdraw -> cancel, never guess.
  INSUFFICIENT_FUNDS, LOSS_LIMIT and TRANSACTION_FAILED are never cancelled. Deposits retry until confirmed.
- Every state change is a conditional `UPDATE ... WHERE state = ...`.
- Any change to `src/rgs.ts`, `src/wallet/`, `src/money.ts` or `src/fair/` must keep `npm test` green, including the
  chaos test, and should be flagged for human review.

## Fairness and maths
- Changing `src/fair/fair.ts` breaks verification of past rounds: don't, unless versioned.
- Paytables are generated (`scripts/keno-paytable.ts`), never edited by hand. Exact RTP is tested.

## Data
- Never store casino player ids in plain text, IPs, nicknames or other personal data. Use `player_ref`.
- No secrets, keys or real player data in the repository.

## Before finishing any task
`npx tsc --noEmit` and `npm test` (needs Postgres; see README) must pass.
