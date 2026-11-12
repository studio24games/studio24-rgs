# Stage 1 pilot: wallet engine + provably fair Keno

**Purpose.** The cheap test from the RGS plan ("case C"): can Barry and Carol, with Claude writing the code, build
the hardest part of an RGS to a standard an outside engineer signs off? If yes, the build continues this way; if
not, the plan falls back to hiring (case A). This pilot is the velocity check at gate G1.

## Scope

| In the pilot | Not yet |
|---|---|
| Seamless wallet engine compatible with the S24 wallet API (authenticate, transaction, cancel; HMAC signing) | Back office, reporting, invoicing |
| Round lifecycle with idempotent requests, safe retries, cancels and a durable payout outbox | Tequity game-server and Connector compatibility layers |
| Crash recovery (bets left in flight, rounds left unpaid) | Other games; multiplayer Crash |
| Provably fair randomness (commit-reveal, HMAC-SHA256, rejection sampling) and a public checker | Game client UI (API only) |
| Keno: 40 numbers, 10 drawn, 1-10 picks, own paytable at 97% RTP (exact maths) | Rules parity with Tequity's Keno (to capture in demo mode) |
| Player data minimisation: per-casino pseudonyms; the casino's player id encrypted at rest | Secrets manager, key rotation, admin auth, rate limits |
| Simulated casino wallet with fault injection; reconciliation; chaos run | Load test, deployment, monitoring |

## Acceptance criteria

1. **Money is exact under failure.** The chaos run (concurrent players, ~18% of wallet calls failing in every mode:
   before applying, after applying, dropped connection, late reply) ends with the casino's ledger and the RGS's
   records matching transaction by transaction and every player's balance matching to the cent. *Status: passing*
   (1,200 rounds: 1,189 settled, 190 of them paid by the recovery worker; 11 refunded by cancel; zero differences).
2. **Spec compliance.** Withdraws retried with the same transactionId, then cancelled if unknown;
   INSUFFICIENT_FUNDS / LOSS_LIMIT / TRANSACTION_FAILED never cancelled; deposits retried until confirmed; cancels
   retried until confirmed or TRANSACTION_NOT_FOUND. *Status: implemented and tested.*
3. **Fairness.** Every round reproducible from the revealed server seed, client seed and nonce; draws uniform
   (chi-square), hit counts match the exact distribution. *Status: passing.*
4. **Maths.** Exact RTP per pick count within 0.03 points of 97%; pays rise with hits. *Status: passing.*
5. **Outside review** of `src/rgs.ts`, `src/wallet/client.ts`, `src/fair/fair.ts`, `src/money.ts` and the tests
   finds no critical issue. *Status: to do.*
6. **Pace** extrapolates to Tequity-off within the plan's window. *Status: first pass built in one evening session.*

## Brief for the outside reviewer

Please review for correctness under failure, not style:

- `src/rgs.ts` `play()` and `processDue()`: can any interleaving of the request path, the recovery worker, retries
  and crashes lose money, pay twice, take a bet twice, or leave a round stuck? Every state change is a conditional
  `UPDATE ... WHERE state = ...`; check that this is enough.
- Cancel semantics: a cancel row is created only when a withdraw's result is unknown or refused with a code other
  than INSUFFICIENT_FUNDS, LOSS_LIMIT and TRANSACTION_FAILED. Is that the right call?
- The recovery worker's stale window must exceed the longest inline retry (enforced at start-up). Multi-instance:
  leasing uses `FOR UPDATE SKIP LOCKED`; abandonment relies on conditional updates.
- `src/fair/fair.ts`: commit-reveal and the unbiased integer mapping.
- `src/money.ts`: integer micro-units; wins rounded down to whole cents.
- What the tests don't cover that they should.

## How to run

See the README. `npm test` runs everything including a 300-round chaos test; `npm run chaos -- 30 40` runs the
1,200-round version and prints the reconciliation.
