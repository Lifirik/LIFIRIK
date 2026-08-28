// verify-challenges.mjs — the Challenge system (§11.8) and the WET badge (§11.4).
// Run: node scripts/verify-challenges.mjs
//
// Two things are being guarded here and they are different in kind.
//
// The WET fix is arithmetic: a badge rule that was wrong for the whole life of
// the game (it ignored wheels, so a machine with three powered wheels and one
// water stick wore 💧). Badges are derived and never stored, so the corrected
// rule rewrites history the moment it ships — which is exactly why the two
// copies of it, client and server, have to be tested against the SAME table.
//
// The challenge system is a ledger. Points move between accounts, and the only
// way to be sure a prize is neither minted nor lost is to add up both sides
// before and after. Every case below therefore checks balances, not just
// outcomes. Runs the REAL server on a scratch database, like verify-validation.
//
// Gate 8 rides along on that same harness: a level's three records and, more to
// the point, who holds them. It belongs with the competition rules for the same
// reason — it is decided at the moment a public win is posted, and its tie-break
// ("first to set it keeps it") is the kind of thing only a real posted sequence
// can prove.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gates } from './gatekit.mjs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { gate, section, summary } = gates();

// ---------- gate 1: WET, on both copies of the rule ----------
//
// The client's computeBadges is imported directly. The server's is not
// importable (server.js starts listening on import), so its copy is exercised
// through a published level's badge union further down — here we pin the pure
// function and the ladder it now supports.
{
  const { computeBadges, badgeRank, BADGE_RANKS } = await import(u('public/js/util.js'));
  const wet = (s) => computeBadges({ won: true, ...s }).includes('wet');
  const cases = [
    ['water sticks only', { water: 3, wood: 0, wheels: 0, poweredWheels: 0 }, true],
    // the case that was wrong: wheels never used to be looked at
    ['water sticks + wheels', { water: 3, wood: 0, wheels: 2, poweredWheels: 2 }, false],
    ['water sticks + one free wheel', { water: 3, wood: 0, wheels: 1, poweredWheels: 0 }, false],
    ['water + wood', { water: 3, wood: 1, wheels: 0, poweredWheels: 0 }, false],
    ['wood only', { water: 0, wood: 4, wheels: 0, poweredWheels: 0 }, false],
    ['wheels only', { water: 0, wood: 0, wheels: 3, poweredWheels: 3 }, false],
    // the empty machine: no wood and no wheels is the purest form of both, so
    // it takes wet as well as rods and powerless
    ['no pieces at all', { water: 0, wood: 0, wheels: 0, poweredWheels: 0 }, true],
  ];
  for (const [what, stats, want] of cases) {
    gate(`1. WET — ${what}`, wet(stats) === want, want ? 'earns 💧' : 'no 💧');
  }
  {
    const empty = computeBadges({ won: true, pieces: 0, water: 0, wood: 0, wheels: 0, poweredWheels: 0 });
    gate('1. a no-piece solve takes wet, rods AND powerless',
      ['wet', 'rods', 'powerless'].every(b => empty.includes(b)),
      empty.join(','));
  }
  {
    // **There is no POWERED badge** (2026-08-04) — it marked the ordinary case
    // rather than a constraint. Asserted on a machine that would plainly have
    // earned it, and asserted in BOTH lists, since the badge table is
    // deliberately duplicated between util.js and server.js.
    const driven = computeBadges({ won: true, wheels: 2, poweredWheels: 2, wood: 3 });
    gate('1. a powered machine earns no "powered" badge — the badge is gone',
      !driven.includes('powered') && driven.includes('solved'), driven.join(','));
    gate('1. …and neither list still defines one',
      !fs.readFileSync(path.join(root, 'public/js/util.js'), 'utf8').includes("id: 'powered'")
      && !fs.readFileSync(path.join(root, 'server.js'), 'utf8').includes("id: 'powered'"),
      'util.js and server.js agree it is removed');
  }
  // The ladder has to NEST, or "at least rods" would reject a wet solve and the
  // whole bar system would be a lie.
  const wetSolve = { won: true, water: 2, wood: 0, wheels: 0, poweredWheels: 0 };
  const rodsSolve = { won: true, water: 0, wood: 2, wheels: 0, poweredWheels: 0 };
  const freeWheel = { won: true, water: 0, wood: 2, wheels: 1, poweredWheels: 0 };
  const powered = { won: true, water: 0, wood: 2, wheels: 1, poweredWheels: 1 };
  gate('1. ladder ranks wet 3 > rods 2 > powerless 1 > 0',
    badgeRank(wetSolve) === 3 && badgeRank(rodsSolve) === 2 && badgeRank(freeWheel) === 1 && badgeRank(powered) === 0,
    `${badgeRank(wetSolve)}/${badgeRank(rodsSolve)}/${badgeRank(freeWheel)}/${badgeRank(powered)}`);
  gate('1. every wet solve also clears a rods bar and a powerless bar',
    badgeRank(wetSolve) >= 2 && badgeRank(wetSolve) >= 1 && badgeRank(rodsSolve) >= 1);

  // ---------- SWEEP, the client's copy ----------
  //
  // "Every piece you built ended in the void." The empty machine takes it for
  // free, on exactly the reasoning WET uses: no pieces is the LIMIT of "all of
  // them fell out of the world", not an exception to it. Requires the win —
  // a machine that threw itself away without delivering anything hasn't swept
  // up, it has fallen over.
  const sweep = (s) => computeBadges({ won: true, ...s }).includes('sweep');
  gate('1. SWEEP — machine gone', sweep({ pieces: 4, sweep: true }));
  gate('1. SWEEP — machine still standing', !sweep({ pieces: 4, sweep: false }));
  gate('1. SWEEP — a no-piece solve takes it for free', sweep({ pieces: 0, sweep: true }));
  gate('1. SWEEP — not awarded on a run that never won',
    !computeBadges({ won: false, pieces: 0, sweep: true }).includes('sweep'));
  // It is NOT a sparseness badge: the ladder is about how little you built,
  // and sweeping is about what became of it. Putting it on the ladder would
  // make "at least rods" satisfiable by a machine that fell off the world.
  gate('1. SWEEP is not on the challenge ladder',
    badgeRank({ ...powered, sweep: true }) === badgeRank(powered) &&
    !BADGE_RANKS.includes('sweep'));

  // ---- NRW — No Ridiculous Weights (§11.4) ----
  //
  // Counted per PIN, not per rod, which is the whole point: two heavy sticks
  // bolted to one point must not slip through separately. `PIN_WEIGHT_SAFE` is
  // 200 since 2026-08-12 — two sticks at the ×100 ceiling — and is restated
  // here, because a test that silently follows a constant is not gating it.
  const NRW_BAR = 200;
  const nrw = (s) => computeBadges({ won: true, ...s }).includes('nrw');
  gate('1. NRW — a light machine takes it', nrw({ maxPinWeight: 1 }));
  gate('1. NRW — exactly at the bar still takes it', nrw({ maxPinWeight: NRW_BAR }));
  gate('1. NRW — one over the bar does not', !nrw({ maxPinWeight: NRW_BAR + 1 }));
  gate('1. NRW — a machine with no sticks at all takes it, like WET and SWEEP',
    nrw({ maxPinWeight: 0 }));
  // **The unknown case, which is the one that could quietly hand out badges.**
  // A solve recorded before the stat existed carries no `maxPinWeight`, and
  // "nobody measured" is not "nothing heavy".
  gate('1. NRW — a solve with no measurement does NOT get it',
    !nrw({}) && !nrw({ maxPinWeight: null }) && !nrw({ maxPinWeight: undefined }));
  // …and it is a separate badge, not a rung: the ladder is about which part
  // TYPES you did without, and this is about how heavy they are.
  gate('1. NRW is not on the challenge ladder',
    badgeRank({ ...powered, maxPinWeight: 1 }) === badgeRank(powered) &&
    !BADGE_RANKS.includes('nrw'));

  // The rule as `designStats` actually computes it — two 200s meeting at one
  // pin are a 400 there, which no per-rod test would catch.
  {
    const { designStats } = await import(u('public/js/util.js'));
    const pinned = (w1, w2) => designStats([
      { t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 50, y2: 0, weight: w1 },
      { t: 'rod', kind: 'wood', x1: 50, y1: 0, x2: 100, y2: 0, weight: w2 },
    ]).maxPinWeight;
    gate('1. NRW — two rods sharing a pin sum there',
      pinned(200, 200) === 400, `${pinned(200, 200)}, want 400`);
    gate('1. NRW — …so 2×200 is refused where 2×100 passes',
      !nrw({ maxPinWeight: pinned(200, 200) }) && nrw({ maxPinWeight: pinned(100, 100) }),
      `2x200 -> ${pinned(200, 200)}, 2x100 -> ${pinned(100, 100)}`);
    gate('1. NRW — a lone heavy rod fails on its own endpoints',
      designStats([{ t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 50, y2: 0, weight: 300 }]).maxPinWeight === 300);
    gate('1. NRW — a rod with no weight field counts as 1',
      designStats([{ t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 50, y2: 0 }]).maxPinWeight === 1);
    gate('1. NRW — a wheels-only machine has no loaded pins',
      designStats([{ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15 }]).maxPinWeight === 0);
  }

  // **The server keeps its OWN badge list** (util.js carries DOM helpers and
  // cannot be loaded there), so the two can drift — a badge added on one side
  // only would show on a solve row and not in a challenge, or the reverse.
  // Read the ids straight out of the source rather than asking a running
  // server, so this holds even with nothing deployed.
  {
    const fs = await import('node:fs');
    const { BADGE_DEFS } = await import(u('public/js/util.js'));
    const src = fs.readFileSync(new URL(u('server.js')), 'utf8');
    const block = src.slice(src.indexOf('const BADGE_DEFS = ['));
    const serverIds = [...block.slice(0, block.indexOf('\n];')).matchAll(/\{\s*id:\s*'([a-zA-Z]+)'/g)].map(m => m[1]);
    const clientIds = BADGE_DEFS.map(b => b.id);
    gate('1. the server\'s badge list matches the client\'s, id for id',
      serverIds.join(',') === clientIds.join(','),
      `server [${serverIds.join(', ')}]  client [${clientIds.join(', ')}]`);
    // …and the new one is genuinely in both, so the gate above cannot pass by
    // both lists being empty or by the slice missing the block
    gate('1. …and NRW is in that list',
      serverIds.includes('nrw') && clientIds.includes('nrw'),
      `${serverIds.length} server ids, ${clientIds.length} client ids`);
  }
}

// ---------- the server ----------

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifirik-chal-'));
const port = await freePort();
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    LIFIRIK_DB: path.join(scratch, 'db.sqlite'),
    RATE_LIMIT_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

const ready = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start in 20 s:\n' + serverLog)), 20_000);
  child.on('exit', (code) => { clearTimeout(t); rej(new Error(`server exited (${code}):\n` + serverLog)); });
  const poll = setInterval(() => {
    if (/listening on/.test(serverLog)) { clearInterval(poll); clearTimeout(t); res(); }
  }, 50);
});

function cleanup() {
  child.kill();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

const base = () => `http://127.0.0.1:${port}`;
const nap = (ms) => new Promise(r => setTimeout(r, ms));

async function call(method, url, { token, body } = {}) {
  const r = await fetch(base() + url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 204s and the like */ }
  // an array response (the level list) must NOT be spread into the envelope —
  // `{...[a,b]}` quietly becomes {0:a,1:b} and every assertion against it is
  // then testing nothing
  if (Array.isArray(json)) return { status: r.status, list: json };
  return { status: r.status, ...(json || {}) };
}

const levelData = () => ({
  terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
  props: [],
  buildZones: [{ x: -300, y: -75, w: 240, h: 150 }],
  goalZones: [{ x: 300, y: -52, w: 130, h: 104 }],
  goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
  win: 'goalObj',
});

// A solve payload that wins with wood sticks and a powered wheel unless told
// otherwise — deliberately NOT wet, so badge bars have somewhere to move.
const solvePayload = (over = {}) => ({
  won: true, visibility: 'public',
  time: 10, pieces: 6, kg: 4,
  wood: 3, water: 0, wheels: 1, poweredWheels: 1,
  untampered: true, nailedIt: false, boomerang: false,
  name: 'run',
  ...over,
});

try {
  await ready;

  const reg = async (name) => {
    const r = await call('POST', '/api/auth/register', { body: { name, password: 'passw0rd' } });
    if (!r.token) throw new Error(`register ${name} failed: ${r.status} ${r.error}`);
    return { token: r.token, id: r.user.id, name, atSignup: r.user.points };
  };
  const points = async (who) => (await call('GET', '/api/auth/me', { token: who.token })).user.points;

  const ada = await reg('ada');
  const bob = await reg('bob');
  const cid = await reg('cid');

  // ---------- gate 2: the welcome grant ----------
  //
  // Read off the registration response, not a later /auth/me: the first
  // authenticated request of the day also fires the +1 daily-activity grant
  // (§11.5), so /me would report 101 and the assertion would be measuring two
  // features at once.
  gate('2. a new account opens with 100 points', ada.atSignup === 100, `ada signed up with ${ada.atSignup}`);
  gate('2. every new account, not just the first', bob.atSignup === 100 && cid.atSignup === 100);

  // the ledger baseline: everything from here is transfers and refunds, so the
  // three balances together must never change again
  const totalNow = async () => (await points(ada)) + (await points(bob)) + (await points(cid));
  const total0 = await totalNow();

  // ---------- gate 3: the race ----------
  //
  // A challenge is made from a level you already saved private — an afterthought,
  // not a checkbox on the save dialog (§11.8). So: publish private, then convert.
  const startAda = await points(ada);
  const privLvl = await call('POST', '/api/levels', {
    token: ada.token,
    body: { name: 'Mystery Box', desc: 'sealed', data: levelData(), visibility: 'private' },
  });
  gate('3. a level published private is not yet a challenge',
    privLvl.status === 200 && !privLvl.race && privLvl.private === true, `status ${privLvl.status}`);
  {
    const pub = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Public One', desc: '', data: levelData() },
    });
    const refused = await call('POST', `/api/levels/${pub.id}/race`, {
      token: ada.token, body: { revealAt: Date.now() + 60_000, prize: 1 },
    });
    gate('3. a level that is already public can\'t become a timed challenge',
      refused.status === 400 && /Private/i.test(refused.error || ''), `${refused.status}: ${refused.error}`);
    const notMine = await call('POST', `/api/levels/${privLvl.id}/race`, {
      token: bob.token, body: { revealAt: Date.now() + 60_000, prize: 1 },
    });
    gate('3. and not somebody else\'s level', notMine.status === 403);
  }
  let race = await call('POST', `/api/levels/${privLvl.id}/race`, {
    token: ada.token, body: { revealAt: Date.now() + 1500, prize: 5 },
  });
  gate('3. converting a private level seals it as a challenge',
    race.status === 200 && race.sealed === true && race.race?.sealed === true, `status ${race.status} ${race.error || ''}`);
  gate('3. staking debits the poster immediately', await points(ada) === startAda - 5,
    `${startAda} -> ${await points(ada)}`);

  {
    const teaser = await call('GET', `/api/levels/${race.id}`, { token: bob.token });
    gate('3. a sealed race answers a stranger with a teaser, not a 404', teaser.status === 200 && teaser.sealed === true);
    gate('3. the teaser carries no level data, preview or description',
      teaser.data === undefined && teaser.preview === undefined && teaser.desc === undefined,
      `keys: ${Object.keys(teaser).filter(k => ['data', 'preview', 'desc'].includes(k)).join(',') || 'none of them'}`);
    gate('3. the teaser still says when it opens and what is staked',
      teaser.race?.revealAt > Date.now() && teaser.race?.prize === 5);
    const own = await call('GET', `/api/levels/${race.id}`, { token: ada.token });
    gate('3. the author can still open their own sealed level', own.status === 200 && !!own.data);
    const list = await call('GET', '/api/levels');
    const row = list.list.find(l => l.id === race.id);
    gate('3. the sealed race is listed for everyone (the countdown is the point)',
      !!row && row.sealed === true, row ? 'listed as a teaser' : 'missing from the list');
    gate('3. and the list teaser is sealed too', !!row && row.preview === undefined && row.data === undefined);
  }

  // nobody can win it while it is sealed
  {
    const early = await call('POST', `/api/levels/${race.id}/solve`, { token: bob.token, body: solvePayload() });
    gate('3. a solve before the reveal cannot claim the race', early.status === 200 && !early.raceWon);
  }

  await nap(1700);
  await call('GET', '/api/levels');   // the lazy sweep, as a browser would trigger it
  {
    const open = await call('GET', `/api/levels/${race.id}`, { token: bob.token });
    gate('3. the reveal opens the level to everyone', open.status === 200 && !!open.data && !open.sealed,
      `sealed=${open.sealed}`);
  }

  // the author cannot win their own race
  {
    const selfish = await call('POST', `/api/levels/${race.id}/solve`, { token: ada.token, body: solvePayload() });
    gate('3. the author cannot win their own race', !selfish.raceWon);
  }
  // a private win doesn't count either
  {
    const quiet = await call('POST', `/api/levels/${race.id}/solve`, { token: bob.token, body: solvePayload({ visibility: 'private' }) });
    gate('3. a private win cannot claim the race', !quiet.raceWon);
  }

  const bobBefore = await points(bob);
  const winning = await call('POST', `/api/levels/${race.id}/solve`, { token: bob.token, body: solvePayload() });
  gate('3. the first public win takes the race', winning.raceWon?.prize === 5, JSON.stringify(winning.raceWon));
  gate('3. the prize lands on the winner', await points(bob) === bobBefore + 5, `${bobBefore} -> ${await points(bob)}`);
  {
    const after = await call('GET', `/api/levels/${race.id}`, { token: bob.token });
    gate('3. the winner is named at the front of the description',
      /^🏁 First solved by bob/.test(after.desc || ''), JSON.stringify(after.desc));
    gate('3. the race records its winner', after.race?.winner?.name === 'bob');
    const second = await call('POST', `/api/levels/${race.id}/solve`, { token: cid.token, body: solvePayload({ time: 1 }) });
    gate('3. a later win cannot steal it', !second.raceWon);
  }

  // ---------- gate 3b: calling one off before it opens ----------
  {
    const lvlX = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Called Off', desc: '', data: levelData(), visibility: 'private' },
    });
    const before = await points(ada);
    await call('POST', `/api/levels/${lvlX.id}/race`, { token: ada.token, body: { revealAt: Date.now() + 3600_000, prize: 4 } });
    gate('3b. staked', await points(ada) === before - 4);
    const off = await call('DELETE', `/api/levels/${lvlX.id}/race`, { token: ada.token });
    gate('3b. calling it off refunds the stake', off.status === 200 && await points(ada) === before,
      `${before - 4} -> ${await points(ada)}`);
    const after = await call('GET', `/api/levels/${lvlX.id}`, { token: ada.token });
    gate('3b. and the level is an ordinary private level again', !after.race && !after.sealed);
    // an OPENED race can't be called off — people have played it by then
    const cancelOpen = await call('DELETE', `/api/levels/${race.id}/race`, { token: ada.token });
    gate('3b. an opened challenge can\'t be called off', cancelOpen.status === 400, `${cancelOpen.status}`);
  }

  // ---------- gate 4: match/beat me ----------
  const lvl = await call('POST', '/api/levels', {
    token: ada.token, body: { name: 'Bar Level', desc: '', data: levelData() },
  });
  // ada's own private benchmark: 10 s, 6 pieces, 4 kg, wood sticks and one
  // FREE wheel — rank 1 (powerless), so a powerless bar is hers to set and a
  // rods or wet bar is not
  const mine = await call('POST', `/api/levels/${lvl.id}/solve`, {
    token: ada.token, body: solvePayload({ visibility: 'private', name: 'mine', poweredWheels: 0 }),
  });
  const post = (body, token = ada.token) => call('POST', `/api/levels/${lvl.id}/challenges`, { token, body });

  gate('4. a bar better than your own solve is refused',
    (await post({ solveId: mine.id, bars: { time: 5 }, days: 1 })).status === 400);
  gate('4. a wet bar from a non-wet solve is refused',
    (await post({ solveId: mine.id, badge: 3, days: 1 })).status === 400);
  gate('4. a rods bar from a solve with a wheel is refused',
    (await post({ solveId: mine.id, badge: 2, days: 1 })).status === 400);
  gate('4. Nailed It you did not earn is refused',
    (await post({ solveId: mine.id, nailedIt: true, days: 1 })).status === 400);
  gate('4. Sweep you did not earn is refused',
    (await post({ solveId: mine.id, sweep: true, days: 1 })).status === 400);
  // (A challenge with nothing to beat used to be asserted REFUSED here. It is
  // accepted now - "just solve it" - and gate 4c owns that on a level of its
  // own. It cannot be tested here: this level is deliberately littered with
  // published near-misses, and there is no way to post one and tidy up after
  // it, because BOTH closing and withdrawing publish the challenger's solve -
  // which then refuses every posting gate below this line. Two runs were spent
  // learning that.)
  gate('4. a challenge on someone else\'s solve is refused',
    (await post({ solveId: mine.id, bars: { time: 12 }, days: 1 }, bob.token)).status === 403);
  gate('4. a prize beyond your balance is refused',
    (await post({ solveId: mine.id, bars: { time: 12 }, days: 1, prize: 10_000 })).status === 400);
  gate('4. a zero prize is refused (every challenge carries a token)',
    (await post({ solveId: mine.id, bars: { time: 12 }, days: 1, prize: 0 })).status === 400);

  const adaBefore = await points(ada);
  const ch = await post({ solveId: mine.id, bars: { time: 10, pieces: 6 }, badge: 1, days: 0, hours: 2, prize: 3 });
  gate('4. a bar at exactly your own numbers is allowed (match me)', ch.status === 200, `status ${ch.status} ${ch.error || ''}`);
  gate('4. the stake is debited on posting', await points(ada) === adaBefore - 3);
  gate('4. one live challenge per person per level',
    (await post({ solveId: mine.id, bars: { time: 12 }, days: 1 })).status === 409);
  {
    const detail = await call('GET', `/api/levels/${lvl.id}`, { token: bob.token });
    const own = detail.solveList.find(s => s.id === mine.id);
    gate('4. the challenger\'s solve stays hidden while it runs', own === undefined);
    gate('4. the bar itself is public', detail.challenges?.[0]?.bars?.time === 10);
  }

  // near misses first — each fails on exactly one criterion
  const tryBeat = (over, token = bob.token) =>
    call('POST', `/api/levels/${lvl.id}/solve`, { token, body: solvePayload(over) });

  const missed = async (what, over) => {
    const r = await tryBeat(over);
    gate(`4. ${what}`, !r.challengesWon, r.challengesWon ? 'WON when it should not have' : 'no win');
  };
  await missed('one piece over the bar does not qualify', { time: 9, pieces: 7, poweredWheels: 0 });
  await missed('a hundredth of a second over does not qualify', { time: 10.01, pieces: 6, poweredWheels: 0 });
  await missed('a powered wheel misses a powerless bar', { time: 9, pieces: 5, wheels: 1, poweredWheels: 1 });
  await missed('a private run cannot win it', { time: 5, pieces: 4, poweredWheels: 0, visibility: 'private' });

  const bobBefore2 = await points(bob);
  const beat = await tryBeat({ time: 10, pieces: 6, wheels: 1, poweredWheels: 0 });   // exact match, powerless
  gate('4. matching the bar exactly wins it', beat.challengesWon?.length === 1, JSON.stringify(beat.challengesWon));
  gate('4. the prize moves to the winner', await points(bob) === bobBefore2 + 3);
  {
    const detail = await call('GET', `/api/levels/${lvl.id}`, { token: cid.token });
    const own = detail.solveList.find(s => s.id === mine.id);
    gate('4. closing publishes the challenger\'s own solve', !!own && own.public === true);
    gate('4. the closed challenge is off the live list', !(detail.challenges || []).some(c => c.id === ch.id));
    const board = await call('GET', '/api/challenges');
    gate('4. the board remembers it as decided',
      board.decided.some(d => d.challenge?.id === ch.id && d.challenge?.winner?.name === 'bob'));
  }

  // ---------- gate 4b: a bar the board has already cleared ----------
  //
  // The reported case: someone posts "beat my RODS run" on a level that already
  // has a published WET solve. The ladder nests, so that solve clears a rods
  // bar and the challenge would be winnable by loading it and pressing save.
  {
    const lvl2 = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Already Beaten', desc: '', data: levelData() },
    });
    // bob publishes a WET run: water sticks only, no wheels -> rank 3. Fast and
    // few pieces, but HEAVY — so it clears a badge or time bar and leaves room
    // for a weight bar, which is what makes the "still allowed" case below a
    // real test rather than an accident.
    await call('POST', `/api/levels/${lvl2.id}/solve`, {
      token: bob.token,
      body: solvePayload({ visibility: 'public', time: 6, pieces: 3, kg: 12, wood: 0, water: 3, wheels: 0, poweredWheels: 0 }),
    });
    // ada's own private run is RODS (wood sticks, no wheels) -> rank 2
    const rods = await call('POST', `/api/levels/${lvl2.id}/solve`, {
      token: ada.token,
      body: solvePayload({ visibility: 'private', time: 20, pieces: 9, kg: 8, wood: 4, water: 0, wheels: 0, poweredWheels: 0 }),
    });
    const post2 = (body) => call('POST', `/api/levels/${lvl2.id}/challenges`, { token: ada.token, body });

    const refused = await post2({ solveId: rods.id, badge: 2, days: 1 });
    gate('4b. a RODS bar is refused when a published WET solve already clears it',
      refused.status === 409 && /already done that/i.test(refused.error || ''), `${refused.status}: ${refused.error}`);
    // the same is true of a plain numbers bar the board has beaten
    const refused2 = await post2({ solveId: rods.id, bars: { time: 20 }, days: 1 });
    gate('4b. and a time bar someone has already published under',
      refused2.status === 409, `${refused2.status}`);
    // a bar nobody has cleared is still fine: bob's run is 12 kg, ada's is 8,
    // so a weight bar at her own 8 is one the board has NOT beaten
    const ok = await post2({ solveId: rods.id, bars: { kg: 8 }, badge: 2, days: 1 });
    gate('4b. a bar nothing published has reached is still allowed',
      ok.status === 200, `${ok.status} ${ok.error || ''}`);
    if (ok.id) await call('DELETE', `/api/levels/${lvl2.id}/challenges/${ok.id}`, { token: ada.token });

    // ---------- publishing an OLD solve settles too ----------
    const mine4 = await call('POST', `/api/levels/${lvl2.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', time: 12, pieces: 7, kg: 6, wood: 3, water: 0, wheels: 1, poweredWheels: 0 }),
    });
    // includes kg, or bob's 6 s / 3 pcs run would already have cleared it
    const live = await post2({ solveId: mine4.id, bars: { time: 12, pieces: 7, kg: 6 }, days: 1, prize: 2 });
    gate('4b. posted a fresh bar to test the back door', live.status === 200, `${live.status} ${live.error || ''}`);
    // cid saves a qualifying run PRIVATELY — no win, the challenge stands
    const quiet = await call('POST', `/api/levels/${lvl2.id}/solve`, {
      token: cid.token, body: solvePayload({ visibility: 'private', time: 11, pieces: 6, kg: 5, wood: 3, water: 0, wheels: 1, poweredWheels: 0 }),
    });
    gate('4b. a private qualifying run wins nothing yet', !quiet.challengesWon);
    const cidBefore = await points(cid);
    // ...then publishes it later. That IS the moment it became public.
    const flip = await call('POST', `/api/levels/${lvl2.id}/solve/${quiet.id}/visibility`, {
      token: cid.token, body: { visibility: 'public' },
    });
    gate('4b. publishing it afterwards wins the challenge', flip.challengesWon?.length === 1,
      JSON.stringify(flip.challengesWon));
    gate('4b. and pays the prize', await points(cid) === cidBefore + 2, `${cidBefore} -> ${await points(cid)}`);
  }

  // ---------- gate 4c: a challenge with NO terms is "just solve it" ----------
  //
  // "A challenge without a focus is to try to solve it anyway! Still a valid
  // challenge if no published solutions yet" (2026-08-08). The server used to
  // refuse this outright - "a challenge needs at least one thing to beat" -
  // which was wrong about a level nobody has published a win on: there,
  // finishing it at all IS the bar, and the hardest one the level has.
  //
  // Nothing had to be added to protect it, which is the point: `alreadyBeaten`
  // was already the rule that stops a pointless challenge, and with no terms
  // `meetsBars` is true of EVERY published win - so a bar-less challenge is
  // refused the moment one exists, and allowed while none does. Both halves
  // are asserted, because "allowed" alone would be a hole.
  {
    const lvlN = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Bare Challenge', desc: '', data: levelData() },
    });
    const postN = (body) => call('POST', `/api/levels/${lvlN.id}/challenges`, { token: ada.token, body });
    const mineN = await call('POST', `/api/levels/${lvlN.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', time: 9, pieces: 5 }),
    });
    const bare = await postN({ solveId: mineN.id, days: 1, prize: 1 });
    gate('4c. a challenge with no bars, no badge and no aftermath is accepted',
      bare.status === 200, `${bare.status} ${bare.error || ''}`);
    gate('4c. …and it really has no terms on it',
      bare.status === 200 && !Object.keys(bare.bars || {}).length && !bare.badge,
      JSON.stringify({ bars: bare.bars, badge: bare.badge }));
    // anyone finishing it wins - there is nothing else to clear
    const beatN = await call('POST', `/api/levels/${lvlN.id}/solve`, {
      token: bob.token, body: solvePayload({ time: 30, pieces: 20, kg: 99 }),
    });
    gate('4c. …so any published win takes it, however slow',
      beatN.challengesWon?.length === 1, JSON.stringify(beatN.challengesWon));
    // …and now that a win IS published, a bare challenge is refused. On a
    // FRESH private solve: closing the first one published `mineN`, and a
    // published solve is refused earlier and for a different reason (the
    // machine has to stay hidden while a challenge runs), which would let this
    // pass without ever reaching the rule it is about.
    const mineN2 = await call('POST', `/api/levels/${lvlN.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', time: 8, pieces: 4 }),
    });
    const again = await postN({ solveId: mineN2.id, days: 1, prize: 1 });
    gate('4c. …but a second bare one is refused once a win is on the board',
      again.status === 409 && /already solved this one/i.test(again.error || ''),
      `${again.status}: ${again.error}`);
  }

  // ---------- gate 5: expiry and withdrawal both return the stake ----------
  //
  // On its own level with no published solves, so the "already beaten" rule
  // (gate 4b) can't refuse the fixtures — `lvl` above is littered with the
  // public near-misses those gates needed.
  {
    const lvl3 = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Stake Level', desc: '', data: levelData() },
    });
    const post3 = (body) => call('POST', `/api/levels/${lvl3.id}/challenges`, { token: ada.token, body });
    const mine2 = await call('POST', `/api/levels/${lvl3.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'second' }),
    });
    const before = await points(ada);
    const c2 = await post3({ solveId: mine2.id, bars: { time: 12 }, days: 0, hours: 1, prize: 7 });
    gate('5. staked again', c2.status === 200 && await points(ada) === before - 7, `${c2.status} ${c2.error || ''}`);
    const del = await call('DELETE', `/api/levels/${lvl3.id}/challenges/${c2.id}`, { token: ada.token });
    gate('5. withdrawing refunds the stake', del.status === 200 && await points(ada) === before,
      `${before - 7} -> ${await points(ada)}`);
    const detail = await call('GET', `/api/levels/${lvl3.id}`, { token: bob.token });
    gate('5. withdrawing still publishes the solve', !!detail.solveList.find(s => s.id === mine2.id && s.public));

    // an under-15-minute window is refused, so expiry itself is tested by the
    // sweep rather than a clock the test can't fast-forward — what's checked
    // here is the boundary rejection
    const mine3 = await call('POST', `/api/levels/${lvl3.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'third', time: 3, pieces: 2, kg: 1 }),
    });
    gate('5. a window under 15 minutes is refused',
      (await post3({ solveId: mine3.id, bars: { time: 3 }, hours: 0, days: 0 })).status === 400);
    gate('5. a window over 30 days is refused',
      (await post3({ solveId: mine3.id, bars: { time: 3 }, days: 31 })).status === 400);

    // and the challenger publishing their OWN backing solve ends it
    const mine5 = await call('POST', `/api/levels/${lvl3.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'fifth', time: 2, pieces: 2, kg: 1 }),
    });
    const beforeSelf = await points(ada);
    const c3 = await post3({ solveId: mine5.id, bars: { time: 2 }, days: 1, prize: 5 });
    gate('5. staked for the self-publish case', c3.status === 200 && await points(ada) === beforeSelf - 5,
      `${c3.status} ${c3.error || ''}`);
    await call('POST', `/api/levels/${lvl3.id}/solve/${mine5.id}/visibility`, {
      token: ada.token, body: { visibility: 'public' },
    });
    const after = await call('GET', `/api/levels/${lvl3.id}`, { token: bob.token });
    gate('5. publishing your own backing solve closes the challenge',
      !(after.challenges || []).some(c => c.id === c3.id));
    gate('5. and returns the stake', await points(ada) === beforeSelf, `${beforeSelf - 5} -> ${await points(ada)}`);
  }

  // ---------- gate 6: the ledger balances ----------
  //
  // Every movement above is a transfer or a refund between these three
  // accounts, so the total is the invariant. Checked against a baseline taken
  // after signup rather than a hard-coded number, so the daily-activity grant
  // (which has already fired for all three) can't quietly pass for a prize.
  {
    const a = await points(ada), b = await points(bob), c = await points(cid);
    gate('6. no points were minted or destroyed', a + b + c === total0,
      `ada ${a} + bob ${b} + cid ${c} = ${a + b + c}, baseline ${total0}`);
    gate('6. and the prizes actually moved', b > c,
      `bob (won 5 + 3) ${b} vs cid (played nothing) ${c}`);
  }

  // ---------- gate 7: the server's own WET copy, through a real level ----------
  {
    const wetLvl = await call('POST', '/api/levels', {
      token: cid.token, body: { name: 'Wet Test', desc: '', data: levelData() },
    });
    await call('POST', `/api/levels/${wetLvl.id}/solve`, {
      token: cid.token, body: solvePayload({ wood: 0, water: 3, wheels: 2, poweredWheels: 2 }),
    });
    let detail = await call('GET', `/api/levels/${wetLvl.id}`);
    gate('7. server: water sticks + wheels earns no 💧', !detail.badges.includes('wet'),
      `badges: ${detail.badges.join(',')}`);
    await call('POST', `/api/levels/${wetLvl.id}/solve`, {
      token: cid.token, body: solvePayload({ wood: 0, water: 3, wheels: 0, poweredWheels: 0 }),
    });
    detail = await call('GET', `/api/levels/${wetLvl.id}`);
    gate('7. server: water sticks alone earns 💧', detail.badges.includes('wet'),
      `badges: ${detail.badges.join(',')}`);
  }

  // ---------- gate 4b: SWEEP as a challenge term ----------
  //
  // Sweep is demandable like Nailed It and Boomerang — a flag, not a rung on
  // the sparseness ladder (`badge`), because the ladder ranks how little you
  // built and sweeping is about what became of it. The worked example is the
  // one that motivated it: **time < 3.0 · Nailed It · Sweep**.
  {
    const swLvl = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Sweep Challenge', desc: '', data: levelData() },
    });
    // a run that earned all three
    const ace = await call('POST', `/api/levels/${swLvl.id}/solve`, {
      token: ada.token,
      body: solvePayload({ visibility: 'private', name: 'ace', time: 2.5, nailedIt: true, sweep: true }),
    });
    const postSw = (body, token = ada.token) =>
      call('POST', `/api/levels/${swLvl.id}/challenges`, { token, body });

    const ch = await postSw({ solveId: ace.id, bars: { time: 3 }, nailedIt: true, sweep: true, days: 1, prize: 1 });
    gate('4. time + Nailed It + Sweep posts as one challenge', !!ch.id, `id ${ch.id || ch.error}`);

    const { challengeTerms, qualifies } = await import(u('public/js/util.js'));
    const terms = challengeTerms({ bars: { time: 3 }, nailedIt: true, sweep: true });
    gate('4. ...and reads back as terms a player can understand',
      /Nailed It/.test(terms) && /Sweep/.test(terms) && /3/.test(terms), `"${terms}"`);

    // the client's own qualifier must agree with the server about each term
    const base = { won: true, time: 2.5, pieces: 6, kg: 4, wood: 3, wheels: 1, poweredWheels: 1 };
    const chObj = { bars: { time: 3 }, nailedIt: true, sweep: true };
    gate('4. a run with all three qualifies',
      qualifies({ ...base, nailedIt: true, sweep: true }, chObj));
    gate('4. ...missing Sweep does not',
      !qualifies({ ...base, nailedIt: true, sweep: false }, chObj));
    gate('4. ...missing Nailed It does not',
      !qualifies({ ...base, nailedIt: false, sweep: true }, chObj));
    gate('4. ...over the time bar does not',
      !qualifies({ ...base, time: 3.5, nailedIt: true, sweep: true }, chObj));

    // and the server agrees: bob's matching run takes it
    const bobRun = await call('POST', `/api/levels/${swLvl.id}/solve`, {
      token: bob.token,
      body: solvePayload({ visibility: 'public', name: 'bob ace', time: 2.4, nailedIt: true, sweep: true }),
    });
    gate('4. the server awards it to a run that meets all three',
      (bobRun.challengesWon || []).some(c => c.id === ch.id),
      `won ${JSON.stringify((bobRun.challengesWon || []).map(c => c.id))}`);
  }

  // ---------- gate 7: the server's SWEEP copy, and the round trip ----------
  //
  // The two copies of the badge rules can only be held together from outside,
  // so: post a solve that swept, and one that didn't, and read the level's
  // badge union back. A `sweep` the server dropped on the way in (it has to be
  // persisted on the record, not just computed from it) shows up here as a
  // badge that never appears no matter what is posted.
  {
    const swLvl = await call('POST', '/api/levels', {
      token: cid.token, body: { name: 'Sweep Test', desc: '', data: levelData() },
    });
    await call('POST', `/api/levels/${swLvl.id}/solve`, {
      token: cid.token, body: solvePayload({ sweep: false }),
    });
    let detail = await call('GET', `/api/levels/${swLvl.id}`);
    gate('7. server: a machine left standing earns no 🧹', !detail.badges.includes('sweep'),
      `badges: ${detail.badges.join(',')}`);

    await call('POST', `/api/levels/${swLvl.id}/solve`, {
      token: cid.token, body: solvePayload({ sweep: true }),
    });
    detail = await call('GET', `/api/levels/${swLvl.id}`);
    gate('7. server: a machine that swept itself away earns 🧹', detail.badges.includes('sweep'),
      `badges: ${detail.badges.join(',')}`);

    // ...and it survives the round trip on the solve ROW, not just in the
    // union — the profile and the solves screen read the row.
    const rows = detail.solveList.filter(s => s.sweep);
    gate('7. server: sweep is stored on the solve record itself', rows.length === 1,
      `${rows.length} of ${detail.solveList.length} rows carry it`);

    // The client's own copy, run over what the server sent back, must reach
    // the same verdict — that is the drift check, and the reason both halves
    // of this gate exist.
    const { computeBadges } = await import(u('public/js/util.js'));
    const agree = detail.solveList.every(s => computeBadges(s).includes('sweep') === !!s.sweep);
    gate('7. server and client agree about 🧹 on every row', agree);
  }

  // ---------- gate 8: level records name their holder, ties go to the first ----------
  //
  // `levelBest` is three separate leaders, and the Solves screen prints a name
  // under each. The subtle half is the tie: `solveLog` is newest-first, so the
  // obvious `<` comparison hands a matched record to the LATEST claimant —
  // exactly backwards. Matching a record does not take it off the person who
  // set it.
  {
    const lvl = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Records', desc: '', data: levelData() },
    });
    // ada first, with a middling run on all three axes
    await call('POST', `/api/levels/${lvl.id}/solve`, {
      token: ada.token, body: solvePayload({ time: 10, pieces: 6, kg: 4 }),
    });
    let d = await call('GET', `/api/levels/${lvl.id}`);
    gate('8. a lone solve holds all three records',
      d.best.timeBy?.name === 'ada' && d.best.piecesBy?.name === 'ada' && d.best.kgBy?.name === 'ada',
      `${d.best.timeBy?.name}/${d.best.piecesBy?.name}/${d.best.kgBy?.name}`);

    // bob EQUALS the time, and beats the weight. The tie must stay with ada;
    // the strict improvement must move.
    await nap(5);
    await call('POST', `/api/levels/${lvl.id}/solve`, {
      token: bob.token, body: solvePayload({ time: 10, pieces: 6, kg: 2 }),
    });
    d = await call('GET', `/api/levels/${lvl.id}`);
    gate('8. matching a record leaves it with whoever set it first',
      d.best.time === 10 && d.best.timeBy?.name === 'ada', `time ${d.best.time} held by ${d.best.timeBy?.name}`);
    gate('8. matching the piece count likewise',
      d.best.pieces === 6 && d.best.piecesBy?.name === 'ada', `pieces ${d.best.pieces} held by ${d.best.piecesBy?.name}`);
    gate('8. beating a record takes it',
      d.best.kg === 2 && d.best.kgBy?.name === 'bob', `kg ${d.best.kg} held by ${d.best.kgBy?.name}`);

    // a private run sets nothing: a record nobody can look at isn't a record
    await call('POST', `/api/levels/${lvl.id}/solve`, {
      token: cid.token, body: solvePayload({ time: 1, pieces: 1, kg: 1, visibility: 'private' }),
    });
    d = await call('GET', `/api/levels/${lvl.id}`);
    gate('8. a private run sets no record',
      d.best.time === 10 && d.best.timeBy?.name === 'ada' && d.best.kg === 2,
      `time ${d.best.time} (${d.best.timeBy?.name}), kg ${d.best.kg}`);

    // holders carry an id, which is what makes the name a link to the profile
    gate('8. a holder carries the account id the profile link needs',
      d.best.timeBy?.id === ada.id, String(d.best.timeBy?.id === ada.id));

    // and the bookkeeping the tie-break uses never reaches the client
    gate('8. the tie-break\'s own timestamps stay server-side',
      !('timeAt' in d.best) && !('kgAt' in d.best) && !('piecesAt' in d.best),
      Object.keys(d.best).join(','));
  }

  // ---------- gate 9: the message (§11.8) ----------
  //
  // The challenger's own line, carried with the countdown. Two halves, and they
  // are different in kind — the same split as gate 1 and gate 7.
  //
  // The PURE half is util.js's `cleanMessage`/`challengeTip`, called directly.
  // The SERVER half is the copy that decides what is stored, driven over HTTP.
  // `MESSAGE_MAX` is read out of util.js and used to BUILD the strings the server
  // is fed, so moving the number in one place and not the other stops the suite
  // — the trick gate 54 in the editor suite uses on WRAP_PAD.
  {
    const { cleanMessage, challengeTip, MESSAGE_MAX, BADGE_RANKS, badgeDef } = await import(u('public/js/util.js'));
    const NUL = String.fromCharCode(0);

    // ---- the pure rule ----
    gate('9. a message is flattened to one line',
      cleanMessage('line one\n\n\nline two') === 'line one line two',
      JSON.stringify(cleanMessage('line one\n\n\nline two')));
    gate('9. control characters and tabs go too',
      cleanMessage(`a${NUL}b\tc  d `) === 'a b c d', JSON.stringify(cleanMessage(`a${NUL}b\tc  d `)));
    gate('9. anything that is not a string is no message at all',
      cleanMessage(null) === '' && cleanMessage(undefined) === '' && cleanMessage(42) === '' && cleanMessage({}) === '');
    gate('9. whitespace on its own is no message at all',
      cleanMessage('   \n\t  ') === '');
    // **The cap counts CHARACTERS.** A message is exactly the kind of string that
    // ends in an emoji, and cutting a surrogate pair in half stores a � for
    // good. The two cases either side of the boundary say it precisely.
    {
      const fits = 'x'.repeat(MESSAGE_MAX - 1) + '🏁';         // MESSAGE_MAX chars, one of them a pair
      const over = 'x'.repeat(MESSAGE_MAX) + '🏁';             // one too many
      gate('9. a message ending in an emoji exactly at the cap survives whole',
        cleanMessage(fits) === fits && [...cleanMessage(fits)].length === MESSAGE_MAX,
        `${[...cleanMessage(fits)].length} chars, ${cleanMessage(fits).length} code units`);
      gate('9. one over the cap loses the emoji rather than half of it',
        cleanMessage(over) === 'x'.repeat(MESSAGE_MAX),
        JSON.stringify(cleanMessage(over).slice(-4)));
    }

    // ---- the hover popup: prize and badge requirements, as asked for ----
    {
      const ch = {
        by: 'ada', bars: { time: 10, pieces: 6 }, badge: 2,
        nailedIt: true, sweep: true, prize: 3,
        endsAt: Date.UTC(2026, 7, 20, 9, 0), message: 'good luck matching that',
      };
      const tip = challengeTip(ch, 'beatme');
      const rods = badgeDef(BADGE_RANKS[2]);
      gate('9. the popup quotes the message', tip.includes('good luck matching that'));
      gate('9. …says what is staked', /🏅 3 points/.test(tip), JSON.stringify(tip.match(/🏅[^\n]*/)?.[0]));
      gate('9. …spells the badge requirement OUT, not just its name',
        tip.includes(rods.name) && tip.includes(rods.desc),
        `wanted "${rods.name}" AND "${rods.desc}"`);
      gate('9. …lists the demanded badges', /Nailed It/.test(tip) && /Sweep/.test(tip));
      gate('9. …and the numbers to beat', /10\.0s/.test(tip) && /6 pcs/.test(tip));
      // The deadline in a tip is ABSOLUTE. A `data-tip` is built once when the
      // card is drawn and read on hover, so a relative "ends in 4d" baked into
      // it is a lie by the second time anybody looks at that card.
      gate('9. …with an absolute deadline, not a countdown that goes stale',
        /Ends /.test(tip) && !/Ends in/.test(tip), JSON.stringify(tip.match(/Ends[^\n]*/)?.[0]));
      const bare = challengeTip({ by: 'bob', bars: {}, prize: 0, endsAt: Date.now() }, 'beatme');
      gate('9. a bar with no terms still says so rather than showing an empty line',
        /Anything goes/.test(bare), JSON.stringify(bare));
      const race = challengeTip({ by: 'ada', revealAt: Date.now() + 1000, prize: 5, sealed: true, message: 'bring a shovel' }, 'race');
      gate('9. a race popup quotes the message and says what is staked',
        race.includes('bring a shovel') && /🏅 5 points/.test(race), JSON.stringify(race));
    }

    // ---- the server's own copy, over the wire ----
    //
    // A fresh level per case: `lvl` and friends above are littered with public
    // near-misses, and gate 4b's "already beaten" rule would refuse the
    // fixtures for reasons that have nothing to do with messages.
    const msgLvl = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Message Level', desc: '', data: levelData() },
    });
    const mineT = await call('POST', `/api/levels/${msgLvl.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'said', time: 9, pieces: 5, kg: 3 }),
    });
    const postT = (body) => call('POST', `/api/levels/${msgLvl.id}/challenges`, { token: ada.token, body });

    const withMessage = await postT({
      solveId: mineT.id, bars: { time: 9 }, days: 1, prize: 1,
      message: '  you will  never\n\ndo it in nine  ',
    });
    gate('9. the server stores a message, flattened and trimmed',
      withMessage.message === 'you will never do it in nine', JSON.stringify(withMessage.message));
    {
      const detail = await call('GET', `/api/levels/${msgLvl.id}`, { token: bob.token });
      const live = (detail.challenges || []).find(c => c.id === withMessage.id);
      gate('9. …and hands it back on the level, where the countdown is',
        live?.message === 'you will never do it in nine', JSON.stringify(live?.message));
      const board = await call('GET', '/api/challenges');
      const row = board.live.find(r => r.challenge?.id === withMessage.id);
      gate('9. …and on the board', row?.challenge?.message === 'you will never do it in nine',
        JSON.stringify(row?.challenge?.message));
    }
    // Winning it quotes what you just answered.
    {
      const won = await call('POST', `/api/levels/${msgLvl.id}/solve`, {
        token: bob.token, body: solvePayload({ time: 8, pieces: 5, kg: 3 }),
      });
      const c = (won.challengesWon || [])[0];
      gate('9. the win card is told the message it just beat',
        c?.message === 'you will never do it in nine', JSON.stringify(c?.message));
    }

    // A client that never opens the composer is still held to the same rule:
    // the cap TRUNCATES rather than refusing (a challenge with a staked prize
    // is far too big a thing to reject over one line of trash talk), and it
    // truncates to util.js's own number.
    {
      const lvl9 = await call('POST', '/api/levels', {
        token: bob.token, body: { name: 'Long Message', desc: '', data: levelData() },
      });
      const mine9 = await call('POST', `/api/levels/${lvl9.id}/solve`, {
        token: bob.token, body: solvePayload({ visibility: 'private', name: 'long', time: 7, pieces: 4, kg: 2 }),
      });
      const shout = 'z'.repeat(MESSAGE_MAX + 60);
      const posted = await call('POST', `/api/levels/${lvl9.id}/challenges`, {
        token: bob.token, body: { solveId: mine9.id, bars: { time: 7 }, days: 1, prize: 1, message: shout },
      });
      gate('9. an over-long message is truncated, not refused', posted.status === 200, `${posted.status} ${posted.error || ''}`);
      gate('9. …to exactly util.js\'s MESSAGE_MAX', posted.message === 'z'.repeat(MESSAGE_MAX),
        `${(posted.message || '').length} chars, want ${MESSAGE_MAX}`);
    }
    // Its own level, because withdrawing the bar above would PUBLISH the solve
    // behind it and one poster gets one live bar per level — reusing either
    // would fail this case for a reason that has nothing to do with messages.
    {
      const lvlJ = await call('POST', '/api/levels', {
        token: bob.token, body: { name: 'Junk Message', desc: '', data: levelData() },
      });
      const mineJ = await call('POST', `/api/levels/${lvlJ.id}/solve`, {
        token: bob.token, body: solvePayload({ visibility: 'private', name: 'junk', time: 7, pieces: 4, kg: 2 }),
      });
      const junk = await call('POST', `/api/levels/${lvlJ.id}/challenges`, {
        token: bob.token, body: { solveId: mineJ.id, bars: { time: 7 }, days: 1, prize: 1, message: { evil: true } },
      });
      gate('9. a message that is not a string leaves no key behind',
        junk.status === 200 && !('message' in junk), `status ${junk.status}, message ${JSON.stringify(junk.message)}`);
    }

    // ---- the race: the message has to reach the SEALED teaser ----
    //
    // This is the case the whole feature was asked for: a level nobody may look
    // at yet, whose card is a name, a clock and a stake. The message is the only
    // thing on it written by a person, so it has to clear the teaser filter —
    // while everything the filter exists for stays behind it.
    {
      const sealedLvl = await call('POST', '/api/levels', {
        token: cid.token, body: { name: 'Race With Words', desc: 'the secret pitch', data: levelData(), visibility: 'private' },
      });
      const made = await call('POST', `/api/levels/${sealedLvl.id}/race`, {
        token: cid.token, body: { revealAt: Date.now() + 1500, prize: 2, message: 'bring a shovel' },
      });
      gate('9. a race takes a message', made.race?.message === 'bring a shovel', JSON.stringify(made.race?.message));
      const teaser = await call('GET', `/api/levels/${sealedLvl.id}`, { token: bob.token });
      gate('9. the sealed teaser carries it — that is the countdown it is for',
        teaser.sealed === true && teaser.race?.message === 'bring a shovel', JSON.stringify(teaser.race?.message));
      gate('9. …and still hides everything the seal is actually for',
        teaser.data === undefined && teaser.preview === undefined && teaser.desc === undefined,
        `leaked: ${['data', 'preview', 'desc'].filter(k => teaser[k] !== undefined).join(',') || 'nothing'}`);
      const listed = (await call('GET', '/api/levels')).list.find(l => l.id === sealedLvl.id);
      gate('9. …on the Workshop card too', listed?.race?.message === 'bring a shovel', JSON.stringify(listed?.race?.message));

      await nap(1700);
      await call('GET', '/api/levels');   // the lazy sweep opens it
      const win = await call('POST', `/api/levels/${sealedLvl.id}/solve`, {
        token: ada.token, body: solvePayload({ time: 4, pieces: 3, kg: 2 }),
      });
      gate('9. and the race win card is told the message as well',
        win.raceWon?.message === 'bring a shovel', JSON.stringify(win.raceWon));

      // ...and once it is WON, the words stand. A decided challenge is a
      // record, and letting its author reword it afterwards would let them
      // rewrite what they said before they knew how it went.
      const late = await call('POST', `/api/levels/${sealedLvl.id}/race/message`, {
        token: cid.token, body: { message: 'i meant to say something else' },
      });
      gate('9e. a won race refuses a rewrite', late.status === 400, `${late.status}: ${late.error}`);
    }

    // ---------- gate 9e: rewriting the message on a LIVE challenge ----------
    //
    // **The terms are written once; the words are not.** A bar is clamped at
    // post time because people are playing against it. The message is flavour —
    // nothing anyone has to beat depends on it — so whoever wrote it can rewrite
    // it, and clear it.
    //
    // The rule started out as "written once" for both, and that was wrong in the
    // most ordinary case there is: every challenge that already existed when the
    // feature shipped could never show a message at all, and the only way to add
    // one was to destroy the challenge and re-make it — which for a bar
    // publishes the solve behind it. Found by the user, on their own challenge,
    // about ten minutes after it shipped.
    {
      const lvlE = await call('POST', '/api/levels', {
        token: ada.token, body: { name: 'Rewrite Me', desc: '', data: levelData() },
      });
      // poweredWheels 0 so the run is rank 1 (powerless) and a `badge: 1` bar is
      // hers to set — the default payload has a powered wheel and rank 0
      const mineE = await call('POST', `/api/levels/${lvlE.id}/solve`, {
        token: ada.token,
        body: solvePayload({ visibility: 'private', name: 'rewrite', time: 6, pieces: 4, kg: 2, poweredWheels: 0 }),
      });
      // posted with NO message, exactly like every challenge that predates this
      const chE = await call('POST', `/api/levels/${lvlE.id}/challenges`, {
        token: ada.token, body: { solveId: mineE.id, bars: { time: 6, kg: 2 }, badge: 1, days: 1, prize: 1 },
      });
      gate('9e. posted with nothing to say', chE.status === 200 && chE.message === undefined,
        `${chE.status} ${chE.error || ''}`);

      const url = `/api/levels/${lvlE.id}/challenges/${chE.id}/message`;
      const readBack = async () => {
        const d = await call('GET', `/api/levels/${lvlE.id}`, { token: bob.token });
        return (d.challenges || []).find(c => c.id === chE.id);
      };

      const added = await call('POST', url, { token: ada.token, body: { message: 'Who is gunna beat this!' } });
      gate('9e. the poster can add one afterwards',
        added.status === 200 && added.message === 'Who is gunna beat this!', `${added.status}: ${added.error || added.message}`);
      gate('9e. …and it is there for everybody else',
        (await readBack())?.message === 'Who is gunna beat this!');

      // The terms must come through the edit untouched — that is the whole
      // reason a separate route exists rather than a general "edit challenge".
      {
        const now = await readBack();
        gate('9e. the terms are untouched by a rewrite',
          now.bars?.time === 6 && now.bars?.kg === 2 && now.badge === 1 &&
          now.prize === 1 && now.endsAt === chE.endsAt && now.solveId === chE.solveId,
          JSON.stringify({ bars: now.bars, badge: now.badge, prize: now.prize, sameEnd: now.endsAt === chE.endsAt }));
      }

      // the same flattening and the same cap as the way in
      const messy = await call('POST', url, { token: ada.token, body: { message: `  two\n\nlines  and   spaces ` } });
      gate('9e. a rewrite is flattened like a first draft',
        messy.message === 'two lines and spaces', JSON.stringify(messy.message));
      const long = await call('POST', url, { token: ada.token, body: { message: 'q'.repeat(MESSAGE_MAX + 40) } });
      gate('9e. …and capped like one', long.message === 'q'.repeat(MESSAGE_MAX),
        `${(long.message || '').length}, want ${MESSAGE_MAX}`);

      // Somebody else's challenge is not yours to write on.
      const notMine = await call('POST', url, { token: bob.token, body: { message: 'ada is rubbish' } });
      gate('9e. a stranger cannot put words in your mouth', notMine.status === 403, `${notMine.status}`);
      gate('9e. …and the message is unchanged after they tried',
        (await readBack())?.message === 'q'.repeat(MESSAGE_MAX));

      // **Clearing is a legitimate answer**, and it removes the key rather than
      // storing '' — otherwise every reader has to test for two kinds of empty.
      const cleared = await call('POST', url, { token: ada.token, body: { message: '' } });
      gate('9e. clearing it leaves no key behind',
        cleared.status === 200 && !('message' in cleared && cleared.message !== undefined) &&
        (await readBack())?.message === undefined,
        JSON.stringify(cleared));

      // a closed challenge refuses: `withMessage` on msgLvl was won by bob above
      const closed = await call('POST', `/api/levels/${msgLvl.id}/challenges/${withMessage.id}/message`, {
        token: ada.token, body: { message: 'too late' },
      });
      gate('9e. a decided challenge refuses a rewrite', closed.status === 400, `${closed.status}: ${closed.error}`);
      const nothing = await call('POST', `/api/levels/${lvlE.id}/race/message`, {
        token: ada.token, body: { message: 'there is no race here' },
      });
      gate('9e. a level with no race has no message to set', nothing.status === 404, `${nothing.status}`);
      const noSuch = await call('POST', `/api/levels/${lvlE.id}/challenges/nope/message`, {
        token: ada.token, body: { message: 'hello?' },
      });
      gate('9e. nor does a challenge id that does not exist', noSuch.status === 404, `${noSuch.status}`);
    }

    // No message at all is the common case, and it must leave no trace: an empty
    // string in the record would have every reader drawing an empty quotation.
    {
      const quiet = await call('POST', '/api/levels', {
        token: cid.token, body: { name: 'Quiet Race', desc: '', data: levelData(), visibility: 'private' },
      });
      const made = await call('POST', `/api/levels/${quiet.id}/race`, {
        token: cid.token, body: { revealAt: Date.now() + 3600_000, prize: 1 },
      });
      gate('9. a challenge with nothing to say carries no message key',
        made.status === 200 && made.race?.message === undefined, JSON.stringify(made.race));
      const blank = await call('POST', '/api/levels', {
        token: cid.token, body: { name: 'Blank Message', desc: '', data: levelData(), visibility: 'private' },
      });
      const made2 = await call('POST', `/api/levels/${blank.id}/race`, {
        token: cid.token, body: { revealAt: Date.now() + 3600_000, prize: 1, message: '   \n  ' },
      });
      gate('9. …and neither does one that typed only whitespace',
        made2.race?.message === undefined, JSON.stringify(made2.race?.message));
      // called off again: both were scheduled an hour out purely to be looked
      // at, and a sealed race left behind is a level the later gates in this
      // file would have to keep stepping around
      await call('DELETE', `/api/levels/${quiet.id}/race`, { token: cid.token });
      await call('DELETE', `/api/levels/${blank.id}/race`, { token: cid.token });
    }
  }

  // ---------- gate 10: what a level is carrying, and the clock on it (§11.8) ----------
  //
  // `liveChallenges` is the ONE answer to "what is running on this level", and
  // it got that job when the challenge chip moved onto the level itself. The
  // Workshop card, the Challenges tab's own filter and the chip on the play
  // screen are three surfaces that must never disagree about whether a level has
  // anything on it — a tab listing a level whose card then shows nothing is a
  // bug nobody reports, because it reads as having misread the screen. They
  // cannot disagree now: all three ask this.
  //
  // Pure, and therefore gated here rather than eyeballed in a browser — which is
  // the whole reason it lives in util.js and not beside the DOM that draws it
  // (§16). The chip's ASSEMBLY is DOM and stays unreachable; every decision it
  // makes is in here.
  {
    const { liveChallenges, countdownText, challengeTerms } = await import(u('public/js/util.js'));
    const now = Date.now();
    const bar = (over, extra = {}) => ({ id: 'b' + over, by: 'ada', endsAt: now + over, prize: 1, bars: {}, ...extra });

    gate('10. a level with nothing running on it carries no chip',
      liveChallenges({}).length === 0 && liveChallenges({ challenges: [] }).length === 0);
    gate('10. …and neither does a record that never arrived',
      liveChallenges(null).length === 0 && liveChallenges(undefined).length === 0);

    gate('10. the race leads, then the bars in the order they were posted',
      liveChallenges({
        race: { by: 'dolly', sealed: true, revealAt: now + 60_000, prize: 5 },
        challenges: [bar(1000), bar(2000)],
      }).map(c => c.kind + ':' + c.id).join(',') === 'race:race,beatme:b1000,beatme:b2000');

    // What is over does not show, and both halves of that matter: the DETAIL
    // route sends decided bars along with live ones, so the filter has to be
    // here rather than assumed of the payload.
    gate('10. a race that has been won is history, and shows nothing',
      liveChallenges({ race: { by: 'ada', winner: { name: 'bob' } } }).length === 0);
    gate('10. a closed bar is history too, though the detail route still sends it',
      liveChallenges({ challenges: [bar(1000, { closedAt: now - 1 })] }).length === 0);
    gate('10. …and it is dropped from among the live ones, not with them',
      liveChallenges({ challenges: [bar(1000, { closedAt: now - 1 }), bar(2000)] })
        .map(c => c.id).join(',') === 'b2000');

    // A SEALED race counts down to its reveal. An OPENED one has no clock at all
    // — it ends when somebody wins it, which is not a time anything can display,
    // and `at: null` is what tells a chip to say so instead of counting to it.
    gate('10. a sealed race counts down to its reveal',
      liveChallenges({ race: { by: 'a', sealed: true, revealAt: now + 5000 } })[0].at === now + 5000);
    gate('10. an opened race has no clock — it ends when somebody wins it',
      liveChallenges({ race: { by: 'a', sealed: false, revealAt: now - 5000 } })[0].at === null);

    const termed = liveChallenges({ challenges: [bar(1000, { bars: { time: 10, pieces: 6 } })] })[0];
    gate('10. the terms are the string challengeTerms writes, not a second rendering of it',
      termed.terms === challengeTerms({ bars: { time: 10, pieces: 6 } }), JSON.stringify(termed.terms));
    gate('10. a bar with nothing to beat still reads as a challenge',
      liveChallenges({ challenges: [bar(1000)] })[0].terms === 'anything goes');

    // Flattened on the way through, exactly as it is everywhere else the message
    // rides with the countdown — and a chip is the surface with the least room
    // of any of them.
    gate('10. the message arrives flattened, like everywhere the countdown goes',
      liveChallenges({ challenges: [bar(1000, { message: ' beat\n\nthat ' })] })[0].message === 'beat that',
      JSON.stringify(liveChallenges({ challenges: [bar(1000, { message: ' beat\n\nthat ' })] })[0].message));
    gate('10. …and nothing said is an empty string, never undefined',
      liveChallenges({ challenges: [bar(1000)] })[0].message === '');

    // The clock itself. Two verbs, because the kinds count to opposite events:
    // "ends in" over a sealed race reads as though it were being taken away.
    gate('10. a bar ENDS and a race OPENS',
      /^ends in /.test(countdownText('beatme', now + 90_000))
      && /^opens in /.test(countdownText('race', now + 90_000)),
      countdownText('beatme', now + 90_000) + ' / ' + countdownText('race', now + 90_000));
    gate('10. a clock that has run out says which way it went',
      countdownText('beatme', now - 1) === 'closing…' && countdownText('race', now - 1) === 'opening…');
  }

  // ---------- gate 11: a live stake freezes the filing dial ----------
  //
  // "The visibility dropdowns need some logic. ie At least: no change if it
  // is currently a Challenge" (2026-08-07). The mechanism's own words are the
  // rule: a challenge HIDES the machine until it ends, and competitors staked
  // points against a level they can reach — so while either bar is live, the
  // backing solve and the level itself hold still, and the close's reveal is
  // the one thing that re-files them. Both directions gated: the refusals
  // while live, and the dial coming back the moment the stake is gone.
  {
    const lvlV = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Frozen Dial', desc: '', data: levelData(), visibility: 'public' },
    });
    const backing = await call('POST', `/api/levels/${lvlV.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'sealed run' }),
    });
    const bystander = await call('POST', `/api/levels/${lvlV.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'free run' }),
    });
    const chV = await call('POST', `/api/levels/${lvlV.id}/challenges`, {
      token: ada.token, body: { solveId: backing.id, bars: { time: 999 }, hours: 2, prize: 1 },
    });
    gate('11. (a live challenge is up)', chV.status === 200, `${chV.status} ${chV.error || ''}`);

    const solveVis = (id, v) => call('POST', `/api/levels/${lvlV.id}/solve/${id}/visibility`, {
      token: ada.token, body: { visibility: v },
    });
    // The lock is a ONE-WAY door. Unlisted is the move it exists to refuse:
    // a challenge hides the machine until it ends, and a working link to it
    // is exactly what competitors are paying to guess at.
    const leak = await solveVis(backing.id, 'unlisted');
    gate('11. the BACKING run cannot be quietly re-filed — unlisted would leak the machine',
      leak.status === 409, `${leak.status} ${leak.error || ''}`);
    const noop = await solveVis(backing.id, 'private');
    gate('11. …re-asserting where it already stands passes (nothing moved)', noop.status === 200, `${noop.status}`);
    const freeTry = await solveVis(bystander.id, 'unlisted');
    gate('11. …while a bystander run on the same level re-files freely', freeTry.status === 200, `${freeTry.status}`);
    // …and PUBLISHING is still allowed, because it is the concede: gate 5
    // owns that path end-to-end (it closes the bar and refunds the stake), so
    // this only holds that the new lock did not wall it off.
    const stillOpen = (await call('GET', `/api/levels/${lvlV.id}`, { token: ada.token }))
      .challenges?.some(c => c.id === chV.id);
    gate('11. …and the challenge is still live, so publishing remains the way out', !!stillOpen);

    const lvlTry = await call('PUT', `/api/levels/${lvlV.id}`, { token: ada.token, body: { visibility: 'private' } });
    gate('11. the LEVEL cannot leave public while the bar is live', lvlTry.status === 409, `${lvlTry.status}`);
    const oldPath = await call('PUT', `/api/levels/${lvlV.id}`, { token: ada.token, body: { listed: false } });
    gate('11. …and the old unpublish boolean is the same dial, refused the same way',
      oldPath.status === 409, `${oldPath.status}`);
    const samePlace = await call('PUT', `/api/levels/${lvlV.id}`, { token: ada.token, body: { visibility: 'public' } });
    gate('11. re-asserting where it already stands is not a change, and passes',
      samePlace.status === 200, `${samePlace.status}`);

    // the stake closes (withdrawn) — the dial thaws, both layers
    const off = await call('DELETE', `/api/levels/${lvlV.id}/challenges/${chV.id}`, { token: ada.token });
    gate('11. (the challenge was withdrawn)', off.status === 200, `${off.status} ${off.error || ''}`);
    const thawSolve = await solveVis(backing.id, 'unlisted');
    const thawLevel = await call('PUT', `/api/levels/${lvlV.id}`, { token: ada.token, body: { visibility: 'unlisted' } });
    gate('11. …and the dial thaws the moment the stake is gone',
      thawSolve.status === 200 && thawLevel.status === 200, `solve ${thawSolve.status}, level ${thawLevel.status}`);

    // the RACE flavour: a sealed countdown owns the level's visibility
    const lvlR = await call('POST', '/api/levels', {
      token: ada.token, body: { name: 'Sealed Dial', desc: '', data: levelData(), visibility: 'private' },
    });
    await call('POST', `/api/levels/${lvlR.id}/solve`, {
      token: ada.token, body: solvePayload({ visibility: 'private', name: 'race run' }),
    });
    const race = await call('POST', `/api/levels/${lvlR.id}/race`, {
      token: ada.token, body: { revealAt: Date.now() + 3600_000, prize: 1 },
    });
    gate('11. (a sealed race is up)', race.status === 200, `${race.status} ${race.error || ''}`);
    const unseal = await call('PUT', `/api/levels/${lvlR.id}`, { token: ada.token, body: { visibility: 'public' } });
    gate('11. a SEALED race\'s level cannot be revealed by the dial — that is the countdown\'s job',
      unseal.status === 409, `${unseal.status} ${unseal.error || ''}`);
  }
} catch (e) {
  fail++;
  console.log('FAIL  harness error: ' + (e?.stack || e));
} finally {
  cleanup();
}

summary();
