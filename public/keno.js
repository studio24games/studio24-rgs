// Keno game client. Talks only to the RGS API; all outcomes and money come from the server.
// A casino launches it as /keno?operator=<id>&key=<one-time key>. In demo mode it gets a key from /demo/launch.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const BET_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  const REVEAL_MS = 140;
  const state = { rules: null, token: null, currency: 'usd', balance: null, limits: null, picks: new Set(), busy: false,
    betIdx: 3, fairness: null, history: [], lastRound: null, revealed: null };

  const money = v => (v == null ? '—' : `${state.currency === 'usd' ? '$' : ''}${Number(v).toFixed(2)}${state.currency === 'usd' ? '' : ' ' + state.currency.toUpperCase()}`);
  const mult = m => `${Number(m).toLocaleString('en-US', { maximumFractionDigits: 2 })}x`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function api(method, path, body, retryId) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (state.token) opts.headers.Authorization = `Bearer ${state.token}`;
    if (body) opts.body = JSON.stringify(body);
    let res;
    try { res = await fetch(path, opts); }
    catch (e) { if (retryId) { await sleep(500); return api(method, path, body, false); } throw { code: 'NETWORK', message: 'Connection problem. Please try again.' }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw data.error || { code: 'HTTP_' + res.status, message: 'Something went wrong.' };
    return data;
  }

  // ------------------------------------------------------------------ rendering
  function buildBoard() {
    const board = $('board');
    for (let n = 1; n <= state.rules.numbers; n++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cell'; b.textContent = String(n); b.dataset.n = String(n);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => toggle(n));
      board.append(b);
    }
  }
  const cell = n => document.querySelector(`.cell[data-n="${n}"]`);

  function toggle(n) {
    if (state.busy) return;
    clearDraw();
    if (state.picks.has(n)) state.picks.delete(n);
    else if (state.picks.size < state.rules.maxPicks) state.picks.add(n);
    else return banner(`You can pick up to ${state.rules.maxPicks} numbers.`, 'error');
    render();
  }

  function clearDraw() { document.querySelectorAll('.cell.drawn').forEach(c => c.classList.remove('drawn')); banner(''); highlightPay(-1); }

  function render() {
    document.querySelectorAll('.cell').forEach(c => {
      const on = state.picks.has(Number(c.dataset.n));
      c.classList.toggle('picked', on); c.setAttribute('aria-pressed', String(on)); c.disabled = state.busy;
    });
    const k = state.picks.size;
    $('pickCount').textContent = String(k);
    const pt = $('paytable'); pt.replaceChildren();
    if (k > 0) {
      state.rules.paytable[k].forEach((m, h) => {
        const d = document.createElement('div'); d.className = 'pay' + (m > 0 ? '' : ' zero'); d.dataset.h = String(h);
        const hs = document.createElement('span'); hs.className = 'h'; hs.textContent = `${h} hit${h === 1 ? '' : 's'}`;
        const ms = document.createElement('span'); ms.className = 'm'; ms.textContent = m > 0 ? mult(m) : '0x';
        d.append(hs, ms); pt.append(d);
      });
    } else {
      const p = document.createElement('span'); p.className = 'muted small'; p.textContent = 'Pick 1 to 10 numbers to see what they pay.'; pt.append(p);
    }
    const bet = BET_STEPS[state.betIdx];
    $('bet').textContent = bet.toFixed(2);
    $('betDown').disabled = state.busy || state.betIdx === 0 || BET_STEPS[state.betIdx - 1] < state.limits.minBet;
    $('betUp').disabled = state.busy || state.betIdx === BET_STEPS.length - 1 || BET_STEPS[state.betIdx + 1] > state.limits.maxBet;
    $('random').disabled = $('clear').disabled = state.busy;
    const play = $('play');
    play.disabled = state.busy || k === 0 || !state.token;
    play.textContent = state.busy ? 'Drawing…' : k === 0 ? 'Pick numbers' : `Play ${money(bet)}`;
    $('balance').textContent = money(state.balance);
    if (state.fairness) {
      $('seedHash').textContent = state.fairness.serverSeedHash;
      if (document.activeElement !== $('clientSeed')) $('clientSeed').value = state.fairness.clientSeed;
      $('nonce').textContent = String(state.fairness.nonce);
    }
    $('rotate').disabled = state.busy || !state.token;
  }

  function banner(text, kind) { const b = $('banner'); b.textContent = text; b.className = 'banner' + (kind ? ' ' + kind : ''); }
  function highlightPay(h) { document.querySelectorAll('.pay').forEach(p => p.classList.toggle('on', Number(p.dataset.h) === h)); }

  function addHistory(r) {
    state.history.unshift(r); state.history = state.history.slice(0, 10);
    const ol = $('history'); ol.replaceChildren();
    for (const x of state.history) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.textContent = `${x.hits.length}/${x.picks.length} hits · ${mult(x.multiplier)}`;
      const b = document.createElement('span'); b.textContent = x.win > 0 ? `+${money(x.win)}` : `−${money(x.bet)}`; if (x.win > 0) b.className = 'w';
      li.append(a, b); ol.append(li);
    }
  }

  // ------------------------------------------------------------------ actions
  async function play() {
    if (state.busy || state.picks.size === 0) return;
    const bet = BET_STEPS[state.betIdx];
    const picks = [...state.picks].sort((a, b) => a - b);
    state.busy = true; clearDraw(); render();
    const requestId = crypto.randomUUID();
    try {
      const r = await api('POST', '/api/play', { requestId, bet, params: { picks } }, requestId);
      if (!r.drawn) throw { code: r.state, message: 'The round did not complete. Your bet was not taken.' };
      if (state.balance != null) state.balance = Math.round((state.balance - bet) * 100) / 100;
      render();
      for (const n of r.drawn) { cell(n)?.classList.add('drawn'); if (!reduced) await sleep(REVEAL_MS); }
      highlightPay(r.hits.length);
      state.balance = r.balance != null ? r.balance : Math.round((state.balance + r.win) * 100) / 100;
      banner(r.win > 0 ? `${r.hits.length} hits · ${mult(r.multiplier)} · you win ${money(r.win)}` : `${r.hits.length} hit${r.hits.length === 1 ? '' : 's'} · no win`, r.win > 0 ? 'win' : '');
      if (r.payoutPending) banner($('banner').textContent + ' (payout on its way)', r.win > 0 ? 'win' : '');
      state.fairness = { ...r.fairness, nonce: r.fairness.nonce + 1 };
      state.lastRound = r; addHistory(r);
    } catch (e) {
      const msg = { INSUFFICIENT_FUNDS: 'Not enough balance for this bet.', BET_NOT_PLACED: 'The casino did not confirm the bet. It has not been taken.',
        BET_CANCELLED: 'The bet timed out and has been refunded.', SESSION_INVALID: 'Your session has ended. Please reopen the game.' }[e.code] || e.message || 'Something went wrong.';
      banner(msg, 'error');
    } finally { state.busy = false; render(); }
  }

  async function rotate() {
    const clientSeed = $('clientSeed').value.trim();
    const prev = state.lastRound;
    try {
      const r = await api('POST', '/api/fairness/rotate', clientSeed && clientSeed !== state.fairness.clientSeed ? { clientSeed } : {});
      state.fairness = r.next;
      state.revealed = { ...r.revealed, round: prev && prev.fairness.serverSeedHash === r.revealed.serverSeedHash ? prev : null };
      $('revSeed').textContent = r.revealed.serverSeed; $('revHash').textContent = r.revealed.serverSeedHash;
      $('revealed').hidden = false; $('verify').disabled = !state.revealed.round; $('verifyResult').textContent = state.revealed.round ? '' : 'No round was played with that seed.';
      render();
    } catch (e) { $('verifyResult').textContent = e.message || 'Could not change seeds.'; }
  }

  async function verify() {
    const v = state.revealed, r = v && v.round; if (!r) return;
    const out = $('verifyResult');
    try {
      const c = await api('POST', '/api/fairness/verify-keno', { serverSeed: v.serverSeed, clientSeed: r.fairness.clientSeed, nonce: r.fairness.nonce, picks: r.picks });
      const same = c.serverSeedHash === r.fairness.serverSeedHash && JSON.stringify(c.drawn) === JSON.stringify(r.drawn) && c.multiplier === r.multiplier;
      out.className = 'small ' + (same ? 'ok' : 'bad');
      out.textContent = same ? `✓ Matches: the seed's hash is the one shown before you bet, and it reproduces the draw ${c.drawn.join(', ')}.` : '✗ Does not match.';
    } catch (e) { out.className = 'small bad'; out.textContent = e.message || 'Check failed.'; }
  }

  function randomPick() {
    if (state.busy) return;
    clearDraw();
    const k = state.picks.size || 5;
    const pool = Array.from({ length: state.rules.numbers }, (_, i) => i + 1);
    const a = new Uint32Array(pool.length); crypto.getRandomValues(a);
    pool.sort((x, y) => a[x - 1] - a[y - 1]);
    state.picks = new Set(pool.slice(0, k)); render();
  }

  // ------------------------------------------------------------------ start
  async function start() {
    state.rules = await api('GET', '/api/games/keno');
    $('rtp').textContent = `RTP ${(state.rules.targetRtp * 100).toFixed(0)}%`;
    buildBoard();
    const q = new URLSearchParams(location.search);
    let operator = q.get('operator'), key = q.get('key');
    if (!operator || !key) {
      try { ({ operator, key } = await api('POST', '/demo/launch')); $('mode').textContent = 'Demo: playing against a simulated casino wallet with play money.'; }
      catch { state.limits = { minBet: 0.1, maxBet: 100 }; render(); return banner('Open this game from your casino.', 'error'); }
    }
    history.replaceState(null, '', location.pathname); // the key is single-use; keep it out of the address bar
    try {
      const s = await api('POST', '/api/session', { operator, key, game: 'keno' });
      Object.assign(state, { token: s.sessionToken, currency: s.currency, balance: s.balance, limits: s.limits, fairness: s.fairness });
    } catch (e) { state.limits = { minBet: 0.1, maxBet: 100 }; banner(e.code === 'AUTH_FAILED' ? 'This game link has expired. Please reopen it from your casino.' : e.message, 'error'); }
    render();
  }

  $('play').addEventListener('click', play);
  $('random').addEventListener('click', randomPick);
  $('clear').addEventListener('click', () => { if (!state.busy) { state.picks.clear(); clearDraw(); render(); } });
  $('betDown').addEventListener('click', () => { if (state.betIdx > 0) { state.betIdx--; render(); } });
  $('betUp').addEventListener('click', () => { if (state.betIdx < BET_STEPS.length - 1) { state.betIdx++; render(); } });
  $('rotate').addEventListener('click', rotate);
  $('verify').addEventListener('click', verify);
  document.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && e.target === document.body) { e.preventDefault(); play(); } });
  start().catch(e => banner(e.message || 'Could not start the game.', 'error'));
})();
