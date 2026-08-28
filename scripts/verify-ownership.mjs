// verify-ownership.mjs — what an author may delete, and who may write a hint.
// Run: node scripts/verify-ownership.mjs
//
// Both rules are about other people's work, which is why they are worth a gate
// rather than a careful read of the route.
//
// **Delete stops at PUBLIC.** A public level has been played, rated, commented
// on and solved by other people, and those solves are theirs — an author who
// could delete the level would be deleting them. Unpublishing is the reversible
// step and it keeps everything; deleting is for work that never had an audience.
// The same argument, one level down, applies to a single solve.
//
// **Unlisted is on the deletable side of that line**, and used to be refused
// with it. An unlisted level was never listed anywhere: it reached exactly the
// people its author handed the link to — a private level plus one deliberate
// act of sharing — so making them unpublish it to private and *then* delete
// protected nobody and read as the button being broken.
// Live stakes block a delete outright rather than being refunded on the way
// out: the challenge routes own the points ledger (§11.8), and a second place
// that moves points is a second place for that arithmetic to be wrong.
//
// **Hints stopped being officials-only.** A Workshop author who writes a level
// that needs a nudge now has a way to give one, and clearing the hint is what
// removes the Hint button from the play screen.
//
// Runs the REAL server on a scratch database, like verify-validation.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gates } from './gatekit.mjs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// same helper the other suites use, for importing a client module by path
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { gate, section, summary } = gates();

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifirik-own-'));
const scratchDb = path.join(scratch, 'db.sqlite');
const port = await freePort();

// An ADMIN, made the only way one can be made: `invite.mjs` against the
// scratch database, BEFORE the server boots and loads it into memory. The
// register route never grants the flag and no route can promote without an
// admin already signed in, so there is no bootstrap over HTTP — which is
// correct, and is why this runs first.
{
  const r = spawnSync(process.execPath,
    // --force because 'root' is a RESERVED name (auth.mjs) — which is the
    // rule working: this harness mints a staff account deliberately, and
    // that is exactly the case the override exists for.
    [path.join(root, 'scripts', 'invite.mjs'), 'root', '--admin', '--force', '--password', 'passw0rd'],
    { cwd: root, env: { ...process.env, LIFIRIK_DB: scratchDb }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not seed an admin: ' + (r.stderr || r.stdout));
}

const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
         LIFIRIK_DB: scratchDb, RATE_LIMIT_DISABLED: '1' },
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
async function call(method, url, { token, body } = {}) {
  const r = await fetch(base() + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 204s */ }
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
const solvePayload = (over = {}) => ({
  won: true, visibility: 'private', time: 10, pieces: 6, kg: 4,
  wood: 3, water: 0, wheels: 1, poweredWheels: 1,
  untampered: true, nailedIt: false, boomerang: false, name: 'run', ...over,
});

try {
  await ready;
  const reg = async (name) => {
    const r = await call('POST', '/api/auth/register', { body: { name, password: 'passw0rd' } });
    if (!r.token) throw new Error(`register ${name} failed: ${r.status} ${r.error}`);
    return { token: r.token, id: r.user.id, name };
  };
  const ada = await reg('ada');
  const bob = await reg('bob');
  const mk = async (who, over = {}) => call('POST', '/api/levels', {
    token: who.token, body: { name: 'L', desc: '', data: levelData(), ...over },
  });

  // ---------- gate 1: deleting a level ----------
  {
    const pub = await mk(ada, { name: 'Public one', visibility: 'public' });
    const unl = await mk(ada, { name: 'Unlisted one', visibility: 'unlisted' });
    const priv = await mk(ada, { name: 'Private one', visibility: 'private' });

    const r1 = await call('DELETE', `/api/levels/${pub.id}`, { token: ada.token });
    gate('1. a PUBLIC level can\'t be deleted', r1.status === 400, `${r1.status} ${r1.error || ''}`);
    const r2 = await call('DELETE', `/api/levels/${unl.id}`, { token: ada.token });
    // Unlisted CAN go. It was never listed anywhere — it reached exactly the
    // people its author sent the link to, which is a private level plus one
    // deliberate act of sharing, and making them unpublish it to private first
    // protected nothing.
    gate('1. an UNLISTED level CAN be deleted by its author', r2.status === 200 && r2.ok, `${r2.status} ${r2.error || ''}`);
    gate('1. …and it is really gone',
      (await call('GET', `/api/levels/${unl.id}`)).status === 404);
    const r3 = await call('DELETE', `/api/levels/${priv.id}`, { token: bob.token });
    gate('1. somebody else\'s private level can\'t be deleted', r3.status === 403, String(r3.status));
    const r4 = await call('DELETE', `/api/levels/${priv.id}`, { token: null });
    gate('1. signed out can\'t delete', r4.status === 401, String(r4.status));

    const r5 = await call('DELETE', `/api/levels/${priv.id}`, { token: ada.token });
    gate('1. the author CAN delete their own private level', r5.status === 200 && r5.ok, String(r5.status));
    const gone = await call('GET', `/api/levels/${priv.id}`);
    gate('1. and it is really gone', gone.status === 404, String(gone.status));
    // the survivors are untouched
    const still = await call('GET', `/api/levels/${pub.id}`);
    gate('1. the public one is untouched', still.status === 200 && still.name === 'Public one');
  }

  // ---------- gate 2: a delete must survive a restart ----------
  //
  // The row is removed from memory; the save hint has to mark it so the store
  // issues a DELETE. A made-up hint key marks nothing, and the level would
  // reappear at the next boot — invisible until the worst possible moment.
  {
    const doomed = await mk(ada, { name: 'Doomed', visibility: 'private' });
    await call('DELETE', `/api/levels/${doomed.id}`, { token: ada.token });
    await call('GET', '/api/config');                 // let the debounced save land
    await new Promise(r => setTimeout(r, 1200));
    const list = await call('GET', '/api/levels');
    const names = (list.list || []).map(l => l.name);
    gate('2. the delete is persisted, not just in memory', !names.includes('Doomed'), names.join(',') || 'none listed');
  }

  // ---------- gate 3: deleting a solve ----------
  {
    const lvl = await mk(ada, { name: 'Solve host', visibility: 'public' });
    const pubSolve = await call('POST', `/api/levels/${lvl.id}/solve`, {
      token: bob.token, body: solvePayload({ visibility: 'public' }),
    });
    const privSolve = await call('POST', `/api/levels/${lvl.id}/solve`, {
      token: bob.token, body: solvePayload({ visibility: 'private' }),
    });
    const unlSolve = await call('POST', `/api/levels/${lvl.id}/solve`, {
      token: bob.token, body: solvePayload({ visibility: 'unlisted' }),
    });

    const r1 = await call('DELETE', `/api/levels/${lvl.id}/solves/${pubSolve.id}`, { token: bob.token });
    gate('3. a PUBLIC solve can\'t be deleted', r1.status === 400, `${r1.status} ${r1.error || ''}`);
    const r2 = await call('DELETE', `/api/levels/${lvl.id}/solves/${privSolve.id}`, { token: ada.token });
    gate('3. the LEVEL author can\'t delete somebody\'s solve', r2.status === 403, String(r2.status));
    const r3 = await call('DELETE', `/api/levels/${lvl.id}/solves/${privSolve.id}`, { token: bob.token });
    gate('3. the solve\'s owner CAN delete their own private one', r3.status === 200 && r3.ok, String(r3.status));
    const detail = await call('GET', `/api/levels/${lvl.id}`, { token: bob.token });
    const ids = (detail.solveList || []).map(s => s.id);
    gate('3. and it is gone from the level', !ids.includes(privSolve.id), `${ids.length} left`);
    gate('3. the public solve survived', ids.includes(pubSolve.id));
    // …and an UNLISTED one goes too — same line as a level: never listed,
    // so it is the author's to remove
    const r4 = await call('DELETE', `/api/levels/${lvl.id}/solves/${unlSolve.id}`, { token: bob.token });
    gate('3. an UNLISTED solve CAN be deleted by its owner', r4.status === 200 && r4.ok, `${r4.status} ${r4.error || ''}`);
    const after = await call('GET', `/api/levels/${lvl.id}`, { token: bob.token });
    gate('3. …and it is gone too',
      !(after.solveList || []).map(s => s.id).includes(unlSolve.id));
  }

  // ---------- gate 4: hints are the author's, on any level ----------
  {
    const lvl = await mk(ada, { name: 'Hinted', visibility: 'public', hint: 'Bolt it to the pin.' });
    let d = await call('GET', `/api/levels/${lvl.id}`);
    gate('4. a hint can be set at publish on a NON-official level',
      d.hint === 'Bolt it to the pin.', JSON.stringify(d.hint));

    await call('PUT', `/api/levels/${lvl.id}`, { token: ada.token, body: { hint: 'Two wheels, one stick.' } });
    d = await call('GET', `/api/levels/${lvl.id}`);
    gate('4. and changed on a later save', d.hint === 'Two wheels, one stick.', JSON.stringify(d.hint));

    // '' clears it — which is what takes the Hint button off the play screen
    await call('PUT', `/api/levels/${lvl.id}`, { token: ada.token, body: { hint: '   ' } });
    d = await call('GET', `/api/levels/${lvl.id}`);
    gate('4. an empty hint CLEARS it (no hint → no Hint button)', d.hint === undefined, JSON.stringify(d.hint));

    const r = await call('PUT', `/api/levels/${lvl.id}`, { token: bob.token, body: { hint: 'mine now' } });
    gate('4. somebody else can\'t write your hint', r.status === 403, String(r.status));
  }

  // ---------- gate 5: the admin password reset (§13) ----------
  //
  // The only recovery path that doesn't need a shell and a stopped server, so
  // it has the shape of a real credential operation and is gated like one:
  // who may call it, that the password it hands back actually WORKS, and that
  // it takes every existing session with it.
  {
    const login = (name, password) => call('POST', '/api/auth/login', { body: { name, password } });
    const rootTok = (await login('root', 'passw0rd')).token;
    gate('5. the seeded admin can sign in', !!rootTok);

    const reset = (name, body, token = rootTok) =>
      call('POST', `/api/admin/users/${encodeURIComponent(name)}/reset-password`, { token, body });

    // who may not
    gate('5. a non-admin cannot reset anybody\'s password',
      (await reset('bob', {}, ada.token)).status === 403);
    // 403, not 401 — every admin route in this file answers a signed-out
    // caller the same way a signed-in non-admin is answered (requireAdmin),
    // and a new one must not invent its own convention
    gate('5. …nor can a signed-out caller',
      (await reset('bob', {}, null)).status === 403);
    gate('5. an unknown user is a 404, not a silent ok',
      (await reset('nobody-here', {})).status === 404);
    gate('5. a password under the sign-in form\'s own floor is refused',
      (await reset('bob', { password: 'abc' })).status === 400);

    // the generated case: the answer carries a password, and it WORKS
    {
      const before = (await login('bob', 'passw0rd')).token;
      const r = await reset('bob', {});
      const stale = await call('GET', '/api/auth/me', { token: before });
      const fresh = await login('bob', r.password);
      gate('5. a generated reset returns a password that signs the user in',
        r.status === 200 && r.generated === true && !!r.password && !!fresh.token,
        `password ${r.password ? r.password.length + ' chars' : 'missing'}`);
      gate('5. …the old password stops working',
        !(await login('bob', 'passw0rd')).token);
      gate('5. …and every session it had is signed out',
        r.signedOut >= 1 && stale.status === 401,
        `dropped ${r.signedOut}, stale token now ${stale.status}`);
    }

    // an explicit one is honoured, because an admin sometimes needs a password
    // they can say out loud
    {
      const r = await reset('bob', { password: 'chosen-one' });
      gate('5. an explicitly chosen password is used as given',
        r.status === 200 && r.password === 'chosen-one' && r.generated === false
        && !!(await login('bob', 'chosen-one')).token);
    }

    // resetting your OWN password keeps the tab you are working in — signing
    // yourself out of it is a surprise, not a security gain
    {
      const r = await reset('root', { password: 'new-root-pw' });
      const mine = await call('GET', '/api/auth/me', { token: rootTok });
      gate('5. an admin resetting their own password keeps the session they did it from',
        r.status === 200 && mine.status === 200,
        `own token still ${mine.status}`);
      gate('5. …and the new password is live', !!(await login('root', 'new-root-pw')).token);
    }
  }

  // ---------- gate 6: editing your own level in place (§11.9) ----------
  //
  // An author kept getting a NEW level every time they saved, because the Maker
  // only ever POSTed. The server already had PUT; what it did not have was a
  // line saying when the layout stops being the author's to change.
  //
  // **That line is the first other player, not publishing.** A solve is a
  // REPLAY against the level's geometry (§5.8), so moving one block silently
  // invalidates every recorded time — but until somebody else has been there,
  // there is nothing to invalidate and no reason to stop an author fixing their
  // own work. Publishing is not the event; being played is.
  //
  // The two halves that make it usable rather than merely safe: the author's
  // OWN plays must not count (testing your level would otherwise lock it
  // against you), and only `data` freezes — name, description and hint stay
  // editable for life, since none of them can break a replay.
  {
    // A FRESH stranger, not `bob`: gate 5 resets bob's password and signs out
    // every session he has, so his token is dead by the time this runs. A gate
    // that reuses a fixture an earlier gate MUTATES is a gate that fails for a
    // reason it is not about — this one lost two assertions to it.
    const cid = await reg('cid');
    // gate 5 changed root's password, so sign in with whatever it is now
    const adminTok = ((await call('POST', '/api/auth/login', { body: { name: 'root', password: 'new-root-pw' } })).token)
      || ((await call('POST', '/api/auth/login', { body: { name: 'root', password: 'passw0rd' } })).token);
    const lvl = await mk(ada, { name: 'Editable', visibility: 'public' });
    const move = (dx) => ({ ...levelData(), goalObjs: [{ shape: 'ball', x: -300 + dx, y: -15, r: 15 }] });
    const put = (who, body) => call('PUT', `/api/levels/${lvl.id}`, { token: who.token, body });

    gate('6. a level nobody has played yet reports itself editable',
      (await call('GET', `/api/levels/${lvl.id}`, { token: ada.token })).settled === undefined,
      'settled is absent');
    gate('6. …and its author may change the LAYOUT',
      (await put(ada, { data: move(10) })).status === 200);

    // the author's own play must not count — otherwise testing it locks it
    await call('POST', `/api/levels/${lvl.id}/play`, { token: ada.token });
    gate('6. the AUTHOR playing their own level does not lock it',
      (await put(ada, { data: move(20) })).status === 200,
      'author play ignored');

    // …and somebody else's does
    await call('POST', `/api/levels/${lvl.id}/play`, { token: cid.token });
    const after = await put(ada, { data: move(30) });
    gate('6. somebody ELSE playing it fixes the layout', after.status === 409, `${after.status}`);
    gate('6. …and says why, naming what it protects',
      /played/i.test(after.error || '') && /solve/i.test(after.error || ''), after.error);
    gate('6. …and the level now reports itself settled',
      (await call('GET', `/api/levels/${lvl.id}`, { token: ada.token })).settled === true);

    // THE OTHER HALF, and the reason the rule is narrow enough to be fair:
    // everything that cannot break a replay still saves.
    const text = await put(ada, { name: 'Renamed', desc: 'new pitch', hint: 'try the ramp' });
    const now = await call('GET', `/api/levels/${lvl.id}`, { token: ada.token });
    gate('6. …while the name, description and hint still save on a played level',
      text.status === 200 && now.name === 'Renamed' && now.desc === 'new pitch' && now.hint === 'try the ramp',
      `${now.name} / ${now.desc} / ${now.hint}`);
    // and the layout really is untouched by that call
    gate('6. …and that save did not quietly move the level',
      now.data.goalObjs[0].x === -300 + 20, `goal x ${now.data.goalObjs[0].x}`);

    // an ADMIN is exempt: editing a played level in place is what the official
    // path is for, done knowing what it costs
    gate('6. an admin may still edit a played level in place',
      (await call('PUT', `/api/levels/${lvl.id}`, { token: adminTok, body: { data: move(40) } })).status === 200);

    // …and none of this weakens who may write at all
    gate('6. a stranger still cannot edit it', (await put(cid, { name: 'theirs' })).status === 403);

    // A SIGNED-OUT visitor is always "somebody else" — they have no id to
    // compare, and an audience the author cannot account for is exactly the
    // thing the rule is about.
    const anon = await mk(ada, { name: 'Anon-played', visibility: 'public' });
    await call('POST', `/api/levels/${anon.id}/play`);
    gate('6. a signed-out play counts as somebody else',
      (await call('PUT', `/api/levels/${anon.id}`, { token: ada.token, body: { data: move(5) } })).status === 409);

    // A SOLVE by someone else locks it even with no plays recorded — the two
    // are independent doors and the gate would pass on either alone.
    const solved = await mk(ada, { name: 'Solved', visibility: 'public' });
    await call('POST', `/api/levels/${solved.id}/solve`, { token: cid.token, body: solvePayload() });
    gate('6. …and somebody else\'s SOLVE locks it with no plays at all',
      (await call('PUT', `/api/levels/${solved.id}`, { token: ada.token, body: { data: move(5) } })).status === 409);
    // the author's own solve does not, for the same reason their play does not
    const selfSolved = await mk(ada, { name: 'Self-solved', visibility: 'public' });
    await call('POST', `/api/levels/${selfSolved.id}/solve`, { token: ada.token, body: solvePayload() });
    gate('6. …while the author\'s own solve leaves it editable',
      (await call('PUT', `/api/levels/${selfSolved.id}`, { token: ada.token, body: { data: move(5) } })).status === 200);
  }

  // ---------- gate 7: the replay preroll (§11.3) ----------
  //
  // Watching somebody else's solve opens with a title card naming them, and
  // `replayPreroll` decides what it says. Pure, and gated here because it is a
  // rule about presenting OTHER PEOPLE'S work — the same reason the rest of this
  // file exists. The card is the only place their name appears before the
  // machine moves, so getting it wrong is getting the attribution wrong.
  {
    const { replayPreroll } = await import(u('public/js/util.js'));
    const won = { by: 'ada', won: true, time: 9.25, pieces: 6, kg: 4.5, wood: 3, wheels: 1, poweredWheels: 1, at: 1000 };

    gate('7. the card names the person, and their numbers',
      (() => { const p = replayPreroll(won); return p.who === 'ada' && p.stats === '9.3s · 6 pcs · 4.5 kg'; })(),
      JSON.stringify(replayPreroll(won).stats));
    gate('7. a solve with no name on it is anonymous rather than blank',
      replayPreroll({ won: true }).who === 'anonymous');
    // A LOCAL save never reached the server, so it has no `by` and fell through
    // to that same fallback — crediting your own run, on your own machine, to
    // "anonymous". It is the one card whose author is never in doubt.
    gate('7. …but a LOCAL save is yours, and the card says so instead',
      replayPreroll({ ...won, by: null, local: true }).who === 'your local save',
      replayPreroll({ ...won, by: null, local: true }).who);

    // An ATTEMPT is watchable, and must not be dressed as a finish. `time` on a
    // run that never won is the moment it was abandoned, and printing that as a
    // result would be the card lying about the number people read first.
    const att = replayPreroll({ ...won, won: false });
    gate('7. an attempt claims no time, pieces or weight',
      att.stats === '' && att.won === false, JSON.stringify(att.stats));
    gate('7. …but is still attributed', att.who === 'ada');

    // Both free-text fields are a person's typing, landing in a card over the
    // level — flattened and capped exactly like a challenge message.
    const typed = replayPreroll({ ...won, name: '  the\n\nbig   one ', comment: 'took\tme all night ' });
    gate('7. the run\'s name is flattened to one line', typed.title === 'the big one', JSON.stringify(typed.title));
    gate('7. …and so is what they said about it', typed.said === 'took me all night', JSON.stringify(typed.said));
    gate('7. nothing typed leaves empty strings, not undefined',
      replayPreroll(won).title === '' && replayPreroll(won).said === '');

    // The badges shown are the ones the RUN earned, from the same function every
    // other surface asks — a card claiming a badge the solve row denies would be
    // two answers to one question.
    const { computeBadges } = await import(u('public/js/util.js'));
    gate('7. the badges are computeBadges\' answer, not a second opinion',
      JSON.stringify(replayPreroll(won).badges) === JSON.stringify(computeBadges(won)),
      JSON.stringify(replayPreroll(won).badges));
    gate('7. no solve at all is no card, rather than a card about nobody',
      replayPreroll(null) === null && replayPreroll(undefined) === null);
  }

  // ---------- gate 8: goal tampering is derived from positions (§11.3/§11.4) ----------
  //
  // `deriveGoalMoved` is the rule Untampered hangs off when a machine arrives
  // from storage or from somebody's solve — the flags cannot be trusted from
  // the record, so they are recomputed from where the pieces actually sit. It
  // lived inline in two GameScreen methods, where the audit that added the
  // second copy is the audit that nearly got it wrong; now it is one pure
  // function, and this is the gate that could not reach it before.
  {
    const { deriveGoalMoved, GOAL_MOVED_TOLERANCE } = await import(u('public/js/util.js'));
    const goals = [{ x: 100, y: 50 }, { x: -40, y: 0 }];

    gate('8. pieces sitting where the level puts them are untouched',
      deriveGoalMoved([{ x: 100, y: 50 }, { x: -40, y: 0 }], goals).every(m => m === false));
    gate('8. a piece away from its authored spot is moved — and only that piece',
      JSON.stringify(deriveGoalMoved([{ x: 100, y: 50 }, { x: -40, y: 8 }], goals)) === '[false,true]');
    // The boundary. **Dyadic offsets on purpose**: 0.01 is not representable in
    // binary, so "exactly at the tolerance" does not exist as a float — the
    // first draft of this gate tested `100 + 0.01 − 100`, which lands a hair
    // ABOVE the constant, and failed against a correct rule. 2^-7 and 3·2^-8
    // survive the subtraction exactly, so these two test the comparison and not
    // the rounding.
    gate('8. under the tolerance is storage noise, not a move',
      deriveGoalMoved([{ x: 100 + 0.0078125, y: 50 }], goals)[0] === false,
      `Δ 0.0078125 < ${GOAL_MOVED_TOLERANCE}`);
    gate('8. …past it is a hand',
      deriveGoalMoved([{ x: 100 + 0.01171875, y: 50 }], goals)[0] === true,
      `Δ 0.01171875 > ${GOAL_MOVED_TOLERANCE}`);
    gate('8. the two axes accumulate rather than being judged alone',
      deriveGoalMoved([{ x: 100.006, y: 50.006 }], goals)[0] === true);
    gate('8. a position with no authored goal under it is never "moved"',
      deriveGoalMoved([{ x: 100, y: 50 }, { x: 0, y: 0 }, { x: 9, y: 9 }], goals)[2] === false);
    gate('8. one flag per POSITION, so the sim indexes it safely',
      deriveGoalMoved([{ x: 0, y: 0 }], goals).length === 1
      && deriveGoalMoved([], goals).length === 0
      && deriveGoalMoved(null, goals).length === 0);
  }

  // ---------- gate 9: remix credit (§11.3) ----------
  //
  // "After <name>", on a run built from somebody's loaded solve. A claim about
  // another person's work, which is why it is gated with the rest of this file
  // — and why the NAME is never taken from the client: the wire carries only
  // the id of the solve that was loaded, and the server looks the person up in
  // its own records.
  {
    const dee = await reg('dee');
    const eve = await reg('eve');
    const made = await call('POST', '/api/levels', {
      token: dee.token, body: { name: 'Remix Base', desc: '', data: levelData(), visibility: 'public' },
    });
    const original = await call('POST', `/api/levels/${made.id}/solve`, {
      token: dee.token, body: solvePayload({ visibility: 'public', design: [{ t: 'wheel', kind: 'cw', x: -280, y: -20, r: 15, id: 'w1' }] }),
    });
    gate('9. the base run saved', original.status === 200, `${original.status} ${original.error || ''}`);

    const remix = await call('POST', `/api/levels/${made.id}/solve`, {
      token: eve.token,
      body: solvePayload({ visibility: 'public', basedOnSolveId: original.id,
        // a forged name rides along and must be ignored — only the id is read
        basedOn: { by: 'somebody else entirely' } }),
    });
    const detail = await call('GET', `/api/levels/${made.id}`, { token: eve.token });
    const row = detail.solveList.find((s) => s.id === remix.id);
    gate('9. the credit names the ORIGINAL author, resolved server-side',
      row?.basedOn?.by === 'dee' && row?.basedOn?.solveId === original.id, JSON.stringify(row?.basedOn));
    gate('9. …and a forged name in the payload changed nothing',
      row?.basedOn?.by !== 'somebody else entirely');
    gate('9. the single-solve route carries it too — that is where the preroll reads',
      (await call('GET', `/api/levels/${made.id}/solve/${remix.id}`, { token: eve.token })).basedOn?.by === 'dee');

    const bogus = await call('POST', `/api/levels/${made.id}/solve`, {
      token: eve.token, body: solvePayload({ basedOnSolveId: 'no-such-solve' }),
    });
    gate('9. an id that names nothing credits nobody, and does not fail the save',
      bogus.status === 200
      && (await call('GET', `/api/levels/${made.id}`, { token: eve.token })).solveList
        .find((s) => s.id === bogus.id)?.basedOn === undefined, `${bogus.status}`);

    const self = await call('POST', `/api/levels/${made.id}/solve`, {
      token: dee.token, body: solvePayload({ basedOnSolveId: original.id }),
    });
    gate('9. crediting your own solve is noise, and is dropped',
      self.status === 200
      && (await call('GET', `/api/levels/${made.id}`, { token: dee.token })).solveList
        .find((s) => s.id === self.id)?.basedOn === undefined);

    // The pure half: the preroll passes the byline through for the title card.
    const { replayPreroll } = await import(u('public/js/util.js'));
    gate('9. the preroll carries the byline for the title card',
      replayPreroll({ by: 'eve', won: true, basedOn: { by: 'dee' } }).after === 'dee');
    gate('9. …and no credit is an empty string, never undefined',
      replayPreroll({ by: 'eve', won: true }).after === '');
  }

  // ---------- gate 10: "inspired by" — the level-side credit (§11.9) ----------
  //
  // The solve side has remix credit; levels now carry the same idea by hand:
  // an author pastes the link that sparked theirs, the server resolves the id
  // and stores a SNAPSHOT — so the credit survives the source being renamed
  // or deleted (credit is not a row lock, §11.3), junk ids are refused
  // outright, and a private level cannot be named by anyone but its owner
  // (the credit would leak that it exists).
  {
    const alice = await call('POST', '/api/auth/register', { body: { name: 'muse', password: 'passw0rd' } });
    const bobby = await call('POST', '/api/auth/register', { body: { name: 'admirer', password: 'passw0rd' } });
    const src = await call('POST', '/api/levels', {
      token: alice.token, body: { name: 'The Original', desc: '', data: levelData(), visibility: 'public' },
    });
    const junk = await call('POST', '/api/levels', {
      token: bobby.token, body: { name: 'Homage', desc: '', data: levelData(), visibility: 'public', inspiredBy: 'no-such-level' },
    });
    gate('10. an id that points at nothing is refused, not stored', junk.status === 400, `${junk.status}`);
    const hom = await call('POST', '/api/levels', {
      token: bobby.token, body: { name: 'Homage', desc: '', data: levelData(), visibility: 'public', inspiredBy: src.id },
    });
    gate('10. a real id is resolved into a snapshot with the source\'s name and author',
      hom.status === 200 && hom.inspiredBy?.levelId === src.id
      && hom.inspiredBy?.name === 'The Original' && hom.inspiredBy?.by === 'muse',
      JSON.stringify(hom.inspiredBy));
    // rename the source: the credit keeps the name it was given under
    await call('PUT', `/api/levels/${src.id}`, { token: alice.token, body: { name: 'Renamed Original' } });
    const after = await call('GET', `/api/levels/${hom.id}`);
    gate('10. …and the snapshot survives the source being renamed',
      after.inspiredBy?.name === 'The Original', after.inspiredBy?.name);
    // a PRIVATE level cannot be credited by a stranger — the credit leaks it
    const secret = await call('POST', '/api/levels', {
      token: alice.token, body: { name: 'Secret', desc: '', data: levelData(), visibility: 'private' },
    });
    const leak = await call('POST', '/api/levels', {
      token: bobby.token, body: { name: 'Leak', desc: '', data: levelData(), visibility: 'public', inspiredBy: secret.id },
    });
    gate('10. a stranger cannot credit a PRIVATE level', leak.status === 400, `${leak.status}`);
    const own = await call('POST', '/api/levels', {
      token: alice.token, body: { name: 'Sequel', desc: '', data: levelData(), visibility: 'public', inspiredBy: secret.id },
    });
    gate('10. …but its own author can — that is what a sequel is', own.status === 200 && own.inspiredBy?.levelId === secret.id,
      `${own.status}`);
    // editable like the hint: '' clears
    const cleared = await call('PUT', `/api/levels/${hom.id}`, { token: bobby.token, body: { inspiredBy: '' } });
    gate('10. an empty string clears the credit on update, like the hint',
      cleared.status === 200 && cleared.inspiredBy === undefined, `${cleared.status} ${JSON.stringify(cleared.inspiredBy)}`);
    const back = await call('PUT', `/api/levels/${hom.id}`, { token: bobby.token, body: { inspiredBy: src.id } });
    gate('10. …and can be set again, snapshotting the CURRENT name this time',
      back.status === 200 && back.inspiredBy?.name === 'Renamed Original', back.inspiredBy?.name);

    // the pure half: what the credit box accepts
    const { levelIdFrom } = await import(u('public/js/util.js'));
    gate('10. the credit box reads a pasted /play link, a bare id, and refuses junk',
      levelIdFrom(`http://localhost:3000/play/${src.id}`) === src.id
      && levelIdFrom(src.id) === src.id
      && levelIdFrom('') === ''
      && levelIdFrom('not a level!!') === null
      && levelIdFrom('https://example.com/other/path') === null,
      `link→${levelIdFrom('http://x/play/' + src.id)}`);
  }

  // ---------- gate 11: the visibility dial on PUT (§11.9) ----------
  //
  // The spreadsheets' dropdown speaks `visibility` — one field, three stops,
  // the same vocabulary the publish dialog uses. Unpublishing has always been
  // the reversible step (`listed`); this reaches the third stop, private,
  // whose whole meaning is "a guessed link 404s" — so that exact promise is
  // what the gate checks, from a stranger's seat.
  {
    const owner = await call('POST', '/api/auth/register', { body: { name: 'filer', password: 'passw0rd' } });
    const other = await call('POST', '/api/auth/register', { body: { name: 'nosy', password: 'passw0rd' } });
    const lv = await call('POST', '/api/levels', {
      token: owner.token, body: { name: 'Dial', desc: '', data: levelData(), visibility: 'public' },
    });
    const put = (v, tok = owner.token) => call('PUT', `/api/levels/${lv.id}`, { token: tok, body: { visibility: v } });
    const strangerSees = async () => (await call('GET', `/api/levels/${lv.id}`, { token: other.token })).status;

    const priv = await put('private');
    gate('11. public → private in one field', priv.status === 200 && priv.private === true && priv.listed === false,
      `${priv.status} private=${priv.private} listed=${priv.listed}`);
    gate('11. …and a stranger\'s guessed link now 404s', await strangerSees() === 404, 'GET as stranger');
    const unl = await put('unlisted');
    gate('11. private → unlisted: the link works again, the listing stays hidden',
      unl.status === 200 && unl.private === undefined && unl.listed === false && await strangerSees() === 200,
      `${unl.status} private=${JSON.stringify(unl.private)} listed=${JSON.stringify(unl.listed)} stranger=${await strangerSees()}`);
    const pub = await put('public');
    gate('11. …and back to public clears both flags', pub.status === 200 && pub.listed === undefined && pub.private === undefined,
      `${pub.status}`);
    const junk = await put('sideways');
    gate('11. a made-up stop is refused', junk.status === 400, `${junk.status}`);
    const notMine = await put('private', other.token);
    gate('11. …and the dial is the owner\'s (or an admin\'s), nobody else\'s', notMine.status === 403, `${notMine.status}`);
  }
} catch (e) {
  fail++;
  console.log('FAIL  harness error: ' + (e?.stack || e));
} finally {
  cleanup();
}

summary();
