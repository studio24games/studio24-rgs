// Chaos run: many players play at once while the simulated casino randomly fails wallet calls in every way
// that matters (error before applying, error after applying, dropped connection after applying, reply after
// the RGS has timed out). Players also retry failed requests with the same requestId. Afterwards the worker
// drains and the two ledgers are reconciled transaction by transaction.
//
// Usage: node scripts/chaos.ts [players=30] [roundsEach=40]
import { setup, call, openSession, reconcile } from '../test/harness.ts';

export async function runChaos(players = 30, roundsEach = 40, faultRate = 0.05) {
  const h = await setup({ faults: { errorBefore: faultRate, errorAfter: faultRate, dropAfter: faultRate, slowAfter: faultRate * 0.6, slowAfterMs: 1500 } });
  const t0 = Date.now();
  const outcomes: Record<string, number> = {};
  const note = (k: string) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };
  try {
    await Promise.all(Array.from({ length: players }, async (_, p) => {
      const s = await openSession(h, `player-${p}`, 200);
      for (let i = 0; i < roundsEach; i++) {
        const body = { requestId: `p${p}-r${i}`, bet: Math.round((0.1 + Math.random() * 4.9) * 100) / 100, params: { picks: [1, 8, 15, 22, 29, 36].slice(0, 1 + (i % 6)) } };
        for (let attempt = 0; attempt < 2; attempt++) { // a game client retries once with the same requestId
          try {
            const r = await call(h.base, 'POST', '/api/play', body, s.sessionToken);
            note(r.status === 200 ? `200 ${r.body.state}` : `${r.status} ${r.body.error?.code}`);
            if (r.status < 500) break;
          } catch { note('client network error'); }
        }
      }
    }));
    const played = Date.now() - t0;
    h.casino.faults.errorBefore = h.casino.faults.errorAfter = h.casino.faults.dropAfter = h.casino.faults.slowAfter = 0;
    await new Promise(r => setTimeout(r, 4600)); // let in-flight withdraws pass the stale window
    await h.rgs.drain();
    const rec = await reconcile(h);
    const att = await h.db.query<{ kind: string; n: string; tries: string }>(`SELECT kind, count(*)::text AS n, sum(attempts)::text AS tries FROM wallet_tx GROUP BY kind ORDER BY kind`);
    return { ...rec, outcomes, playedMs: played, casinoRequests: h.casino.requests, walletTx: att.rows };
  } finally { await h.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runChaos(Number(process.argv[2] ?? 30), Number(process.argv[3] ?? 40));
  console.log(JSON.stringify({ stats: r.stats, outcomes: r.outcomes, walletTx: r.walletTx, casinoRequests: r.casinoRequests, playedMs: r.playedMs }, null, 2));
  console.log(r.problems.length ? `PROBLEMS (${r.problems.length}):\n${r.problems.slice(0, 20).join('\n')}` : 'RECONCILED: casino ledger and RGS records match exactly');
  process.exit(r.problems.length ? 1 : 0);
}
