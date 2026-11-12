# Studio24 RGS

Studio24's own Remote Gaming Server. **Current stage: Stage 1 pilot** (see `docs/PILOT.md`): the wallet engine and a
provably fair Keno game, tested end to end against a simulated casino wallet.

## What's here

| Path | What it is |
|---|---|
| `src/rgs.ts` | The core: sessions, rounds, the wallet money flow, the recovery worker |
| `src/wallet/client.ts` | Client for a casino's seamless wallet (S24 wallet API: authenticate, balance, transaction, cancel) |
| `src/fair/fair.ts` | Provably fair randomness: commit-reveal seeds, HMAC-SHA256, unbiased integers |
| `src/games/keno*.ts` | Keno rules, exact maths, generated paytable (`scripts/keno-paytable.ts`) |
| `src/money.ts` | Money as integer micro-units; wire amounts in whole cents |
| `src/crypto.ts` | Encryption of the casino's player id at rest; per-casino pseudonyms |
| `src/api/server.ts` | Player-facing HTTP API |
| `src/db/schema.sql` | Postgres schema |
| `sim/casino.ts` | Simulated casino wallet with fault injection (tests and demos only) |
| `test/` | Unit tests, end-to-end tests, chaos test, reconciliation |

## Run it

Needs Node 22.18+ (runs TypeScript directly, no build step) and Postgres 16.

```sh
npm install
createdb rgs && createdb rgs_test              # or use DATABASE_URL / TEST_DATABASE_URL
npm test                                      # all tests, including a 300-round chaos run
npm run chaos -- 30 40                        # 1,200-round chaos run with reconciliation report

# Demo: a simulated casino and the RGS
PORT=8091 SIM_SECRET=sim-secret npm run sim-casino      # prints a launch key
DATA_KEY=$(openssl rand -hex 32) PORT=8080 npm start
psql rgs -c "INSERT INTO operators (id, wallet_url, hmac_secret, pseudonym_key) VALUES ('simcasino','http://127.0.0.1:8091','sim-secret','$(openssl rand -hex 16)')"
curl -X POST localhost:8080/api/session -H 'Content-Type: application/json' -d '{"operator":"simcasino","key":"<launch key>","game":"keno"}'
curl -X POST localhost:8080/api/play -H 'Authorization: Bearer <sessionToken>' -H 'Content-Type: application/json' \
     -d '{"requestId":"r1","bet":2,"params":{"picks":[3,7,12,21,33]}}'
```

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | |
| POST | `/api/session` | `{ operator, key, game }` | Authenticates with the casino; returns a session token, balance and the fairness commitment |
| POST | `/api/play` | `{ requestId, bet, params: { picks } }` | Bearer token. Idempotent per `requestId` |
| GET | `/api/round/:id` | | Bearer token |
| POST | `/api/fairness/rotate` | `{ clientSeed? }` | Bearer token. Reveals the old server seed |
| POST | `/api/fairness/verify-keno` | `{ serverSeed, clientSeed, nonce, picks }` | Public checker |

Errors: `{ "error": { "code", "message" } }`.

## Configuration

`DATA_KEY` (required, 64 hex chars), `DATABASE_URL`, `PORT`, `WALLET_TIMEOUT_MS` (5000), `WITHDRAW_ATTEMPTS` (3),
`MIN_BET` (0.1), `MAX_BET` (100), `MAX_WIN` (100000), `SESSION_HOURS` (4).
