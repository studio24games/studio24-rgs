// Starts the RGS: migrates the database, serves the API, and runs the recovery worker every second.
import { loadConfig } from './config.ts';
import { createDb, migrate } from './db/db.ts';
import { Rgs } from './rgs.ts';
import { createApi } from './api/server.ts';

const log = (msg: string) => console.log(JSON.stringify({ time: new Date().toISOString(), msg }));
const config = loadConfig();
const db = createDb(config.databaseUrl);
await migrate(db);
const rgs = new Rgs({ db, config, log });
const server = createApi(rgs, log);
server.listen(config.port, () => log(`RGS listening on :${config.port}`));

let stopping = false;
const tick = async () => {
  if (stopping) return;
  try { await rgs.processDue(); } catch (e) { log(`worker error: ${(e as Error).message}`); }
  setTimeout(tick, 1000);
};
tick();

process.on('SIGTERM', () => { stopping = true; server.close(() => db.end().then(() => process.exit(0))); });
