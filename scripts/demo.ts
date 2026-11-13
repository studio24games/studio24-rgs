// One-command demo: the RGS plus a simulated casino wallet, play money, on http://localhost:8080/keno
// Usage: npm run demo        (needs Postgres; DATABASE_URL defaults to postgres://rgs:rgs@127.0.0.1:5432/rgs)
// Every page load gets a fresh simulated player with 1,000.00 to play with.
import { randomBytes } from 'node:crypto';
import { createDb, migrate } from '../src/db/db.ts';
import { loadConfig } from '../src/config.ts';
import { Rgs } from '../src/rgs.ts';
import { createApi } from '../src/api/server.ts';
import { startSimCasino } from '../sim/casino.ts';

const log = (m: string) => console.log(m);
const config = loadConfig({ ...process.env, DATA_KEY: process.env.DATA_KEY ?? randomBytes(32).toString('hex') });
const db = createDb(config.databaseUrl);
await migrate(db);
const casino = await startSimCasino({ secret: randomBytes(16).toString('hex') });
await db.query(
  `INSERT INTO operators (id, wallet_url, hmac_secret, pseudonym_key) VALUES ('demo-casino', $1, $2, $3)
   ON CONFLICT (id) DO UPDATE SET wallet_url = EXCLUDED.wallet_url, hmac_secret = EXCLUDED.hmac_secret`,
  [casino.url, casino.secret, randomBytes(16).toString('hex')]);
const rgs = new Rgs({ db, config, log });
let players = 0;
const api = createApi(rgs, log, {
  demoLaunch: async () => ({ operator: 'demo-casino', key: casino.addPlayer(`demo-${++players}-${randomBytes(3).toString('hex')}`, 1000) }),
});
api.listen(config.port, () => log(`Keno demo: http://localhost:${config.port}/keno  (simulated casino at ${casino.url})`));
const tick = async () => { try { await rgs.processDue(); } catch (e) { log(`worker: ${(e as Error).message}`); } setTimeout(tick, 1000); };
tick();
