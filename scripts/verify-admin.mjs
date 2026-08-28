// verify-admin.mjs — the admin surfaces (§13.1): passwords, roles, the
// editable text, and the tuning dials.
// Run: node scripts/verify-admin.mjs
//
// Four features that have almost nothing to do with each other except WHO they
// answer to, which is exactly why they share a suite: every one of them is a
// route that changes something for other people, and the interesting cases are
// all "who is allowed" rather than "does it compute".
//
// The password gates are the sharp ones. A bearer token is what an unattended
// tab hands to whoever sits down at it, so `POST /auth/password` demands the
// CURRENT password as well — and the run below proves both halves: the wrong
// current password is refused, and a successful change kills every other
// session while leaving the caller signed in.
//
// Runs the REAL server on a scratch database, like verify-ownership. Rate
// limiting is off (RATE_LIMIT_DISABLED) so the deliberate wrong-password
// attempts don't lock the account out mid-suite.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gates } from './gatekit.mjs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { gate, section, summary } = gates();

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifirik-admin-'));
const scratchDb = path.join(scratch, 'db.sqlite');
const port = await freePort();

// The admin is seeded through invite.mjs before the server boots, for the same
// reason verify-ownership does it: there is no way to make the first admin over
// HTTP, and that is correct.
{
  const r = spawnSync(process.execPath,
    // --force because 'root' is a RESERVED name (auth.mjs) — which is the
    // rule working: this harness mints a staff account deliberately, and
    // that is exactly the case the override exists for.
    [path.join(root, 'scripts', 'invite.mjs'), 'root', '--admin', '--force', '--password', 'passw0rd'],
    { cwd: root, env: { ...process.env, LIFIRIK_DB: scratchDb }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not seed an admin: ' + (r.stderr || r.stdout));
}

// **The dials are set to NON-DEFAULT values on purpose.** A tuning test against
// the defaults cannot tell a live dial from a dead one — it would pass just as
// happily if nothing read the environment at all.
const ENV = {
  PORT: String(port), HOST: '127.0.0.1', LIFIRIK_DB: scratchDb, RATE_LIMIT_DISABLED: '1',
  PASSWORD_MIN: '6', WELCOME_POINTS: '7', LIMIT_LEVELS: '3', PRIZE_MAX: '9',
  TEST_ECONOMY: '1',
};
let child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
const wire = (c) => { c.stdout.on('data', d => { serverLog += d; }); c.stderr.on('data', d => { serverLog += d; }); };
wire(child);
const waitUp = () => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server did not start in 20 s:\n' + serverLog)), 20_000);
  const poll = setInterval(() => {
    if (/listening on/.test(serverLog)) { clearInterval(poll); clearTimeout(t); res(); }
  }, 50);
});
function cleanup() {
  try { child.kill(); } catch { /* already gone */ }
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

try {
  await waitUp();
  const login = async (name, password) => (await call('POST', '/api/auth/login', { body: { name, password } }));
  const root0 = await login('root', 'passw0rd');
  gate('0. the seeded admin can sign in', root0.status === 200 && root0.user?.isAdmin === true,
    `${root0.status} admin=${root0.user?.isAdmin}`);
  const adminTok = root0.token;

  // ---------- gate 1: the tuning dials are real ----------
  //
  // Each one is checked through the BEHAVIOUR it governs, not just read back
  // out of the panel — a panel that reports its own input proves nothing.
  {
    const t = await call('GET', '/api/admin/tuning', { token: adminTok });
    gate('1. the tuning panel answers an admin', t.status === 200 && Array.isArray(t.dials), `${t.status}`);
    const dial = (k) => t.dials.find(d => d.key === k);
    gate('1. …and reports the values this process actually started with',
      dial('passwordMin')?.value === 6 && dial('welcomePoints')?.value === 7 && dial('limitLevels')?.value === 3,
      `passwordMin ${dial('passwordMin')?.value}, welcomePoints ${dial('welcomePoints')?.value}, limitLevels ${dial('limitLevels')?.value}`);
    gate('1. …marking which came from the environment and which are defaults',
      dial('passwordMin')?.set === true && dial('sessionDays')?.set === false,
      `PASSWORD_MIN set=${dial('passwordMin')?.set}, SESSION_DAYS set=${dial('sessionDays')?.set}`);
    gate('1. …and names the env var for each, so the panel is actionable',
      dial('limitLevels')?.env === 'LIMIT_LEVELS' && dial('beatmeMaxDays')?.env === 'BEATME_MAX_DAYS');
    const anon = await call('GET', '/api/admin/tuning');
    gate('1. a stranger cannot read the configuration', anon.status === 401 || anon.status === 403, `${anon.status}`);
  }

  // PASSWORD_MIN really governs registration...
  {
    const short = await call('POST', '/api/auth/register', { body: { name: 'shorty', password: '12345' } });
    gate('1. PASSWORD_MIN is enforced on register (5 chars against a min of 6)',
      short.status === 400 && /at least 6/.test(short.error || ''), `${short.status}: ${short.error}`);
  }
  // ...and WELCOME_POINTS really decides what a new account opens with.
  const bob = await call('POST', '/api/auth/register', { body: { name: 'bobby', password: 'passw0rd' } });
  gate('1. WELCOME_POINTS decides the opening balance', bob.user?.points === 7, `opened with ${bob.user?.points}`);

  // ---------- gate 2: changing your own password ----------
  {
    const wrong = await call('POST', '/api/auth/password', { token: bob.token, body: { current: 'nope', next: 'newpassw0rd' } });
    gate('2. the wrong current password is refused', wrong.status === 403, `${wrong.status}: ${wrong.error}`);
    const stillIn = await call('POST', '/api/auth/login', { body: { name: 'bobby', password: 'passw0rd' } });
    gate('2. …and the old one still works, so nothing was half-changed', stillIn.status === 200);

    const tooShort = await call('POST', '/api/auth/password', { token: bob.token, body: { current: 'passw0rd', next: 'abc' } });
    gate('2. the new password must clear PASSWORD_MIN too',
      tooShort.status === 400 && /at least 6/.test(tooShort.error || ''), `${tooShort.status}: ${tooShort.error}`);
    const same = await call('POST', '/api/auth/password', { token: bob.token, body: { current: 'passw0rd', next: 'passw0rd' } });
    gate('2. …and cannot be the one you already have', same.status === 400, `${same.status}`);
    const anon = await call('POST', '/api/auth/password', { body: { current: 'passw0rd', next: 'newpassw0rd' } });
    gate('2. signed out, there is no password to change', anon.status === 401, `${anon.status}`);

    // A SECOND session for bob, so the sign-out has something to sign out.
    const other = await login('bobby', 'passw0rd');
    gate('2. bob has a second session open', other.status === 200 && other.token !== bob.token);

    const done = await call('POST', '/api/auth/password', { token: bob.token, body: { current: 'passw0rd', next: 'newpassw0rd' } });
    gate('2. the right current password changes it', done.status === 200, `${done.status}: ${done.error || ''}`);
    // Two, not one: bob has a session from `register`, one from the "old one
    // still works" check above, and one from `other`. The caller's is kept and
    // the other two go — which is the rule, stated as the number it produces.
    gate('2. …and says how many other sessions it closed', done.signedOut === 2, `signedOut ${done.signedOut}`);

    const meStill = await call('GET', '/api/auth/me', { token: bob.token });
    gate('2. THIS session survives — changing your password is not a punishment',
      meStill.status === 200 && meStill.user?.name === 'bobby', `${meStill.status}`);
    const otherGone = await call('GET', '/api/auth/me', { token: other.token });
    gate('2. …every other session is gone, which is the whole point',
      otherGone.status === 401, `${otherGone.status}`);

    const oldPw = await call('POST', '/api/auth/login', { body: { name: 'bobby', password: 'passw0rd' } });
    gate('2. the old password no longer signs in', oldPw.status === 401, `${oldPw.status}`);
    const newPw = await call('POST', '/api/auth/login', { body: { name: 'bobby', password: 'newpassw0rd' } });
    gate('2. the new one does', newPw.status === 200, `${newPw.status}`);
  }

  // ---------- gate 3: giving and taking roles ----------
  {
    const notAdmin = await call('POST', '/api/admin/users/bobby/role', { token: bob.token, body: { isAdmin: true } });
    gate('3. an ordinary account cannot promote itself', notAdmin.status === 403 || notAdmin.status === 401, `${notAdmin.status}`);

    const up = await call('POST', '/api/admin/users/bobby/role', { token: adminTok, body: { isAdmin: true } });
    gate('3. an admin can grant Admin', up.status === 200 && up.isAdmin === true, `${up.status}`);
    const nowAdmin = await call('GET', '/api/auth/me', { token: bob.token });
    gate('3. …and the promoted account sees it immediately', nowAdmin.user?.isAdmin === true);

    const mod = await call('POST', '/api/admin/users/bobby/role', { token: adminTok, body: { isModerator: true } });
    gate('3. Moderator is a separate flag, not a rank below Admin',
      mod.isAdmin === true && mod.isModerator === true, `admin=${mod.isAdmin} mod=${mod.isModerator}`);
    // one field at a time: absent keys must be left alone, or a UI that sends
    // only what changed would silently clear the other role
    const partial = await call('POST', '/api/admin/users/bobby/role', { token: adminTok, body: { isAdmin: false } });
    gate('3. a patch touching one role leaves the other alone',
      partial.isAdmin === false && partial.isModerator === true, `admin=${partial.isAdmin} mod=${partial.isModerator}`);
    const down = await call('POST', '/api/admin/users/bobby/role', { token: adminTok, body: { isModerator: false } });
    gate('3. …and both can be taken away again', down.isAdmin === false && down.isModerator === false);
    const ghost = await call('POST', '/api/admin/users/nobody/role', { token: adminTok, body: { isAdmin: true } });
    gate('3. a name that does not exist is a 404, not a new admin', ghost.status === 404, `${ghost.status}`);
  }

  // ---------- gate 4: the editable text ----------
  {
    const empty = await call('GET', '/api/content');
    gate('4. a fresh install has no overrides at all — the defaults ARE the site',
      empty.status === 200 && Object.keys(empty).filter(k => k !== 'status').length === 0,
      JSON.stringify(empty));

    const notAdmin = await call('POST', '/api/admin/content', { token: bob.token, body: { key: 'home.tagline', text: 'mine now' } });
    gate('4. an ordinary account cannot rewrite the site', notAdmin.status === 403 || notAdmin.status === 401, `${notAdmin.status}`);

    const set = await call('POST', '/api/admin/content', { token: adminTok, body: { key: 'home.tagline', text: '  Machines, mostly.  ' } });
    gate('4. an admin can set an override, trimmed on the way in',
      set.status === 200 && set.text === 'Machines, mostly.', JSON.stringify(set.text));
    const pub = await call('GET', '/api/content');
    gate('4. …and it is public immediately, for everybody', pub['home.tagline'] === 'Machines, mostly.');

    const blank = await call('POST', '/api/admin/content', { token: adminTok, body: { key: 'home.tagline', text: '   ' } });
    gate('4. clearing it removes the key rather than storing an empty string',
      blank.status === 200 && blank.text === null, JSON.stringify(blank));
    const after = await call('GET', '/api/content');
    gate('4. …so the shipped default is what everybody gets again', after['home.tagline'] === undefined);

    const badKey = await call('POST', '/api/admin/content', { token: adminTok, body: { key: 'no spaces allowed', text: 'x' } });
    gate('4. a malformed key is refused', badKey.status === 400, `${badKey.status}`);
    // The server deliberately does NOT know the key list (a second copy of
    // content.js here would rot); an unknown key is inert rather than refused,
    // because the client falls back to its own default for anything it does not
    // recognise.
    const unknown = await call('POST', '/api/admin/content', { token: adminTok, body: { key: 'not.a.real.key', text: 'hello' } });
    gate('4. an unknown key is accepted and simply ignored by the client', unknown.status === 200, `${unknown.status}`);

    const long = await call('POST', '/api/admin/content', { token: adminTok, body: { key: 'tour.play.pink.body', text: 'z'.repeat(5000) } });
    gate('4. an over-long override is truncated, not refused',
      long.status === 200 && long.text.length === 4000, `${long.status}, ${long.text?.length} chars`);
  }

  // ---------- gate 5: overrides SURVIVE A RESTART ----------
  //
  // The one that would have caught the real bug here: `content` needed a table
  // in storage.mjs and a set in server.js's `dirty`, and without either the
  // override lives in memory, reads back perfectly for the rest of the session
  // and is gone in the morning.
  {
    await call('POST', '/api/admin/content', { token: adminTok, body: { key: 'home.fresh', text: 'Newest first' } });
    await new Promise(r => setTimeout(r, 900));   // past the 400 ms save debounce
    child.kill();
    await new Promise(r => setTimeout(r, 700));
    serverLog = '';
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    wire(child);
    await waitUp();
    const back = await call('GET', '/api/content');
    gate('5. a text override survives a restart', back['home.fresh'] === 'Newest first', JSON.stringify(back['home.fresh']));
    gate('5. …and the one that was cleared stays cleared', back['home.tagline'] === undefined);
  }

  // ---------- gate 5b: the test economy has an OFF switch (§13.2) ----------
  //
  // TEST_ECONOMY is off in the shipped default. This suite turns it ON in
  // ENV so the grant path is exercised, then restarts with it OFF. Both
  // directions, because a switch gated one-way passes for the wrong reason:
  // ON grants, OFF refuses with a 403 while ordinary routes stay up.
  {
    const on = await call('POST', '/api/points/test-buy', { token: adminTok });
    gate('5b. with the dial ON a signed-in buy grants points', on.ok === true && on.testMode === true, JSON.stringify(on));

    child.kill();
    await new Promise(r => setTimeout(r, 700));
    serverLog = '';
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...process.env, ...ENV, TEST_ECONOMY: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    wire(child);
    await waitUp();
    const buyOff = await call('POST', '/api/points/test-buy', { token: adminTok });
    const subOff = await call('POST', '/api/points/test-subscribe', { token: adminTok });
    const stillUp = await call('GET', '/api/content');
    gate('5b. …with it OFF both shop routes refuse', /switched off/.test(buyOff.error || '') && /switched off/.test(subOff.error || ''),
      JSON.stringify([buyOff.error, subOff.error]));
    gate('5b. …and the rest of the server is unbothered', typeof stillUp === 'object' && !stillUp.error, JSON.stringify(stillUp.error));

    // back to the shipped config (TEST_ECONOMY off) so later gates match it
    child.kill();
    await new Promise(r => setTimeout(r, 700));
    serverLog = '';
    const shipped = { ...ENV };
    delete shipped.TEST_ECONOMY;
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...process.env, ...shipped }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    wire(child);
    await waitUp();
  }

  // ---------- gate 6: the client's half of the content system ----------
  //
  // Pure functions, called directly — the registry, the fallback, and the tiny
  // markup the admin types into those boxes.
  {
    const c = await import(u('public/js/content.js'));
    const el = (tag, attrs, ...kids) => ({ tag, attrs, kids: kids.flat() });
    const keys = (...k) => ({ tag: 'kbd', keys: k });
    const flat = (n) => typeof n === 'string' ? n
      : n.tag === 'kbd' ? '[' + n.keys.join('+') + ']'
        : n.kids.map(flat).join('');

    gate('6. every registry entry has a key, a label, a group and a default',
      c.CONTENT.every(x => x.key && x.label && x.group && typeof x.def === 'string'), `${c.CONTENT.length} entries`);
    const dupes = c.CONTENT.map(x => x.key).filter((k, i, a) => a.indexOf(k) !== i);
    gate('6. …and no two share a key, which is what the database stores against',
      dupes.length === 0, dupes.join(', ') || 'all distinct');

    c.setOverrides({});
    gate('6. with no overrides, txt() is the shipped default',
      c.txt('home.fresh') === 'Fresh from the Workshop', c.txt('home.fresh'));
    c.setOverrides({ 'home.fresh': 'Newest first' });
    gate('6. an override wins', c.txt('home.fresh') === 'Newest first');
    c.setOverrides({ 'home.fresh': '   ' });
    gate('6. …but a blank one does not — it falls back rather than blanking the site',
      c.txt('home.fresh') === 'Fresh from the Workshop');
    c.setOverrides({});
    gate('6. an unknown key is an empty string, never undefined in the DOM', c.txt('nope.nope') === '');

    const ps = c.parseRich('one **bold** and [[Ctrl+Z]]\n\n~a quiet aside', { el, keys });
    gate('6. blank lines split paragraphs', ps.length === 2, `${ps.length}`);
    gate('6. ~ marks a paragraph muted', ps[1].attrs.class === 'muted');
    gate('6. **bold** becomes a real element, not asterisks',
      ps[0].kids.some(k => k.tag === 'b') && !flat(ps[0]).includes('*'), flat(ps[0]));
    gate('6. [[Ctrl+Z]] becomes a two-key chord', flat(ps[0]).includes('[Ctrl+Z]'), flat(ps[0]));

    const link = c.parseRich('see [the keys](#/keys)', { el, keys })[0].kids.find(k => k.tag === 'a');
    gate('6. a leftover #/ link becomes a path', link?.attrs.href === '/keys', link?.attrs.href);
    const pathLink = c.parseRich('see [the keys](/keys)', { el, keys })[0].kids.find(k => k.tag === 'a');
    gate('6. a path link stays a path', pathLink?.attrs.href === '/keys', pathLink?.attrs.href);
    const evil = c.parseRich('[click](javascript:alert(1))', { el, keys })[0].kids.find(k => k.tag === 'a');
    gate('6. …and a javascript: href is defused, because an admin is still a person who can paste one',
      evil?.attrs.href === '#', evil?.attrs.href);
    gate('6. a stray asterisk is left alone rather than eaten',
      flat(c.parseRich('2 * 3 = 6', { el, keys })[0]) === '2 * 3 = 6');
    gate('6. every shipped default parses to at least one paragraph',
      c.CONTENT.filter(x => x.rich).every(x => c.parseRich(x.def, { el, keys }).length > 0));
  }

  // ---------- gate 7: the campaign's running order (§13) ----------
  //
  // An admin assigning a level a campaign number, and the whole point of doing
  // it here rather than by re-seeding: the level KEEPS ITS ID, so its solves,
  // comments and ratings come with it. Re-seeding is the other way of changing
  // the campaign and it deletes every official to rebuild it — which is what
  // these gates exist to make unnecessary.
  {
    const levelData = () => ({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      props: [],
      buildZones: [{ x: -300, y: -75, w: 240, h: 150 }],
      goalZones: [{ x: 300, y: -52, w: 130, h: 104 }],
      goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
      win: 'goalObj',
    });
    const mk = async (name, over = {}) => {
      const r = await call('POST', '/api/levels', {
        token: adminTok,
        body: { name, desc: '', data: levelData(), visibility: 'public', ...over },
      });
      if (!r.id) throw new Error(`could not make ${name}: ${r.status} ${r.error}`);
      return r.id;
    };
    // This suite runs with LIMIT_LEVELS=3 on purpose (it is how gate 1 proves
    // the dial is live), and this block needs seven levels — so root's own quota
    // is lifted through the route that exists for exactly that.
    await call('POST', '/api/admin/users/root/limits', { token: adminTok, body: { levels: 500 } });
    // A plain account, made here rather than borrowed: bobby is promoted to
    // admin by gate 3, so he is the wrong person to ask "may a non-admin?".
    const plain = await call('POST', '/api/auth/register', { token: null, body: { name: 'plainjane', password: 'passw0rd' } });
    const plainTok = plain.token;
    const campaign = async () => (await call('GET', '/api/levels?official=1&sort=slot', {})).list;
    const numbers = async () => (await campaign()).map(l => `${l.slot + 1}:${l.name}`).join(' ');
    const put = (id, number) => call('PUT', `/api/admin/levels/${id}/slot`, { token: adminTok, body: { number } });

    const a = await mk('Alpha'), b = await mk('Bravo'), c2 = await mk('Charlie');
    gate('7. a fresh workshop level is not in the campaign', (await campaign()).length === 0);

    await put(a, 1); await put(b, 2); await put(c2, 3);
    gate('7. levels take the numbers they are given',
      await numbers() === '1:Alpha 2:Bravo 3:Charlie', await numbers());

    // The headline: insert at 2, and Bravo — which WAS 2 — moves down rather
    // than being overwritten. "Old campaign 13 just gets a new number."
    const delta = await mk('Delta');
    await put(delta, 2);
    gate('7. inserting at a number moves the old holder DOWN, it does not replace it',
      await numbers() === '1:Alpha 2:Delta 3:Bravo 4:Charlie', await numbers());

    // Moving one already in the campaign is the same operation, and must not
    // leave a hole where it came from.
    await put(a, 4);
    gate('7. moving a level already in the campaign closes the gap behind it',
      await numbers() === '1:Delta 2:Bravo 3:Charlie 4:Alpha', await numbers());
    gate('7. slots stay a dense 0..n-1 run after every move',
      (await campaign()).every((l, i) => l.slot === i), JSON.stringify((await campaign()).map(l => l.slot)));

    // §11.2: an official's num IS its campaign number, so an exported file and
    // the card agree about what "4" means.
    gate('7. num tracks the campaign number, as the seed stamps it',
      (await campaign()).every(l => l.num === l.slot + 1),
      JSON.stringify((await campaign()).map(l => [l.slot, l.num])));

    // Past the end is "put it last" rather than an error or a hole at 98.
    const echo = await mk('Echo');
    await put(echo, 99);
    gate('7. a number past the end lands on the end, and makes no gap',
      await numbers() === '1:Delta 2:Bravo 3:Charlie 4:Alpha 5:Echo', await numbers());

    // ---- the reason this exists at all: the level survives ----
    const solved = await call('POST', `/api/levels/${b}/solve`, {
      token: adminTok,
      body: { won: true, visibility: 'public', time: 9, pieces: 4, kg: 3, wood: 2, water: 0, wheels: 1, poweredWheels: 1, name: 'run' },
    });
    gate('7. a campaign level takes a solve', solved.status === 200, `${solved.status} ${solved.error || ''}`);
    await put(b, 5);
    const moved = await call('GET', `/api/levels/${b}`, { token: adminTok });
    gate('7. …and moving it keeps the id, so the solve is still on it',
      moved.status === 200 && moved.solveList.length === 1 && moved.slot === 4,
      `slot ${moved.slot}, ${moved.solveList?.length} solve(s)`);
    gate('7. …which is the whole difference from re-seeding',
      moved.solveList[0].time === 9);

    // ---- out again ----
    const out = await call('DELETE', `/api/admin/levels/${c2}/slot`, { token: adminTok });
    gate('7. a level can leave the campaign', out.status === 200, `${out.status} ${out.error || ''}`);
    gate('7. …the rest close up behind it',
      await numbers() === '1:Delta 2:Alpha 3:Echo 4:Bravo', await numbers());
    const gone = await call('GET', `/api/levels/${c2}`, { token: adminTok });
    gate('7. …and it is an ordinary workshop level again, not a deleted one',
      gone.status === 200 && !gone.official && gone.slot === undefined, `official=${gone.official} slot=${gone.slot}`);
    gate('7. …carrying a community number rather than someone else\'s campaign one',
      gone.num >= 10000, `num ${gone.num}`);
    gate('7. leaving twice is refused rather than silently reflowing',
      (await call('DELETE', `/api/admin/levels/${c2}/slot`, { token: adminTok })).status === 400);

    // ---- who may, and what may ----
    gate('7. a stranger cannot renumber the campaign',
      (await call('PUT', `/api/admin/levels/${a}/slot`, { body: { number: 1 } })).status === 403);
    gate('7. nor a signed-in non-admin',
      (await call('PUT', `/api/admin/levels/${a}/slot`, { token: plainTok, body: { number: 1 } })).status === 403);
    for (const bad of [0, -3, 2.5, '4', null]) {
      gate(`7. ${JSON.stringify(bad)} is not a campaign number`,
        (await put(a, bad)).status === 400);
    }
    gate('7. …and the order is unharmed by every one of those',
      await numbers() === '1:Delta 2:Alpha 3:Echo 4:Bravo', await numbers());

    // A campaign level must be one people can actually open, and must not be
    // carrying a competition — POST /challenges already refuses an official, so
    // letting one in this way would break the invariant from the other side.
    const priv = await mk('Private One', { visibility: 'private' });
    const privRes = await put(priv, 1);
    gate('7. a private level is refused a campaign number', privRes.status === 400, privRes.error);
    const unlisted = await mk('Unlisted One');
    await call('PUT', `/api/levels/${unlisted}`, { token: adminTok, body: { listed: false } });
    gate('7. …so is an unpublished one',
      (await put(unlisted, 1)).status === 400);
    gate('7. and the campaign still reads the same after both refusals',
      await numbers() === '1:Delta 2:Alpha 3:Echo 4:Bravo', await numbers());

    // ---- local progress, which was keyed by the thing that now moves ----
    //
    // Pure, so it is called directly. The rule it encodes is the one that stops
    // "solve campaign 7, move that level to 3" from crediting the run to
    // whatever landed on 7.
    {
      const { migrateProgressToIds } = await import(u('public/js/util.js'));
      const officials = [{ id: 'aaa', slot: 0 }, { id: 'bbb', slot: 1 }];
      const done = { time: 9, pieces: 4, kg: 3 };
      const out = migrateProgressToIds({ 0: done, 1: { time: 5 } }, officials);
      gate('7. slot-keyed progress is carried onto the level it was set on',
        out.aaa === done && out.bbb.time === 5, JSON.stringify(out));
      gate('7. …and the slot keys do not survive the move',
        !('0' in out) && !('1' in out), JSON.stringify(Object.keys(out)));
      gate('7. a slot nobody holds any more is dropped, not guessed at',
        migrateProgressToIds({ 7: done }, officials).hasOwnProperty('7') === false
        && Object.keys(migrateProgressToIds({ 7: done }, officials)).length === 0);
      gate('7. an already-migrated store is left alone, and says so with null',
        migrateProgressToIds({ aaa: done }, officials) === null);
      gate('7. …so nothing is rewritten to storage on every campaign visit',
        migrateProgressToIds({}, officials) === null);
      // An id is 11 base64url chars and a slot is 1-3 digits; the two are told
      // apart by shape, so a level id must never be mistaken for a slot.
      gate('7. an 11-character level id is not read as a slot number',
        migrateProgressToIds({ '01234567890': done }, officials) === null);
    }
  }

  // ---------- gate 7b: reserved names ----------
  //
  // "Banned list of usernames. Admin/Moderator/SuperUser etc. I have already
  // claimed LIFIRIK" (2026-08-07). Holding one of these names is a claim
  // about who you are — a player called "Moderator" needs no exploit for
  // every comment they leave to read as the site talking. The fold is what
  // makes it worth having: case, spacing, punctuation and the obvious digit
  // swaps are all ways of typing the same claim.
  {
    const tryName = async (n) => (await call('POST', '/api/auth/register', { token: null, body: { name: n, password: 'passw0rd' } }));
    const refused = [];
    const allowed = [];
    for (const n of ['LIFIRIK', 'lifirik', 'L1F1R1K', 'Admin', 'ADMIN', 'A-D-M-I-N', 'Moderator',
      'M0derator', 'xX_Moderator_Xx', 'SuperUser', 'the administrator', 'staff', 'support', 'root']) {
      const r = await tryName(n);
      (r.status === 409 ? refused : allowed).push(`${n}:${r.status}`);
    }
    gate('7b. every shape of a reserved name is refused', allowed.length === 0,
      allowed.length ? 'got through: ' + allowed.join(', ') : `${refused.length} refused`);
    // …and the blunt instrument stays blunt in the right direction: ordinary
    // names that merely CONTAIN reserved letters must still register
    const okNames = ['modern', 'Rooted', 'Bobby Tables', 'moddy', 'rootbeer', 'Officiala'];
    const blocked = [];
    for (const n of okNames) {
      const r = await tryName(n);
      if (r.status !== 200) blocked.push(`${n}:${r.status}`);
    }
    gate('7b. …while ordinary names that merely contain those letters are fine',
      blocked.length === 0, blocked.length ? 'wrongly refused: ' + blocked.join(', ') : okNames.join(', '));
    // the refusal SAYS which word it objected to, or "reserved" reads as a bug
    const said = await tryName('Moderator');
    gate('7b. the refusal names the word it objected to',
      /moderator/i.test(said.error || ''), said.error);
    // the pure half, and the fold that does the work
    const { reservedName, foldName } = await import(u('auth.mjs'));
    gate('7b. the fold collapses case, punctuation and leetspeak onto one word',
      foldName('L1F-1R.1K') === 'lifirik' && foldName('  A d m 1 n ') === 'admin'
      && reservedName('Sup3rUser') === 'superuser' && reservedName('walter') === null,
      `L1F-1R.1K → ${foldName('L1F-1R.1K')}`);
  }

  // ---------- gate 8: delete a user, and everything they own goes too ----------
  //
  // The no-undo admin tool ("Add option to delete user and all their
  // solves/levels. With 'Are you sure!?'", 2026-08-06). The interesting
  // surface is the same as every admin route — who may — plus the two things
  // deletion is uniquely able to get wrong: the CASCADE (something of theirs
  // survives) and its opposite (something of somebody ELSE'S goes with them).
  // So the fixture is a doomed account and a bystander with mirrored content:
  // each has a level, each solved the other's, the doomed one commented and
  // rated — and the gates check both directions of every edge. The restart at
  // the end is the same trap gate 5 exists for: a delete that lives only in
  // memory reads back perfectly all session and is back in the morning.
  {
    const levelData = () => ({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      props: [],
      buildZones: [{ x: -300, y: -75, w: 240, h: 150 }],
      goalZones: [{ x: 300, y: -52, w: 130, h: 104 }],
      goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
      win: 'goalObj',
    });
    const doomed = await call('POST', '/api/auth/register', { token: null, body: { name: 'doomed', password: 'passw0rd' } });
    const keeper = await call('POST', '/api/auth/register', { token: null, body: { name: 'keeper', password: 'passw0rd' } });
    const mkLvl = async (tok, name) => {
      const r = await call('POST', '/api/levels', { token: tok, body: { name, desc: '', data: levelData(), visibility: 'public' } });
      if (!r.id) throw new Error(`gate 8 could not make ${name}: ${r.status} ${r.error}`);
      return r.id;
    };
    const doomedLvl = await mkLvl(doomed.token, 'Doomed Tower');
    const keeperLvl = await mkLvl(keeper.token, 'Keeper Keep');
    const solve = (tok, lvl) => call('POST', `/api/levels/${lvl}/solve`, {
      token: tok,
      body: { won: true, visibility: 'public', time: 5, pieces: 3, kg: 2, wood: 1, water: 0, wheels: 2, poweredWheels: 2, name: 'run' },
    });
    await solve(doomed.token, keeperLvl);   // must die with the account
    await solve(keeper.token, doomedLvl);   // must die with the LEVEL (stated, not mourned)
    await call('POST', `/api/levels/${keeperLvl}/comments`, { token: doomed.token, body: { text: 'spam spam spam' } });
    await call('POST', `/api/levels/${keeperLvl}/rate`, { token: doomed.token, body: { stars: 1 } });

    // who may: not a non-admin, not yourself, not an admin, not without the name
    const asKeeper = await call('DELETE', '/api/admin/users/doomed', { token: keeper.token, body: { confirm: 'doomed' } });
    gate('8. an ordinary account cannot delete anybody', asKeeper.status === 403, `${asKeeper.status}`);
    const self = await call('DELETE', '/api/admin/users/root', { token: adminTok, body: { confirm: 'root' } });
    gate('8. an admin cannot delete their own account', self.status === 400, `${self.status}`);
    // promoted for exactly this probe and demoted after — bobby would have
    // been the natural target, but gate 3 gives him the role and takes it
    // back, so "is he an admin right now" depends on suite order
    await call('POST', '/api/admin/users/keeper/role', { token: adminTok, body: { isAdmin: true } });
    const anAdmin = await call('DELETE', '/api/admin/users/keeper', { token: adminTok, body: { confirm: 'keeper' } });
    gate('8. …or another ADMIN — the role comes off first, deliberately', anAdmin.status === 400, `${anAdmin.status} ${anAdmin.error || ''}`);
    await call('POST', '/api/admin/users/keeper/role', { token: adminTok, body: { isAdmin: false } });
    const wrong = await call('DELETE', '/api/admin/users/doomed', { token: adminTok, body: { confirm: 'Doomed' } });
    gate('8. the typed-back name is the "Are you sure!?", enforced server-side (case and all)',
      wrong.status === 400, `${wrong.status}`);

    // the deed, and the receipt
    const done8 = await call('DELETE', '/api/admin/users/doomed', { token: adminTok, body: { confirm: 'doomed' } });
    gate('8. the delete itself answers with a receipt of what went',
      done8.status === 200 && done8.levels === 1 && done8.solves === 1 && done8.comments === 1 && done8.ratings === 1 && done8.sessions >= 1,
      `${done8.status}: ${done8.levels} lvl, ${done8.solves} solves, ${done8.comments} comments, ${done8.ratings} ratings, ${done8.sessions} sessions`);

    const check = async (label) => {
      const lvlGone = await call('GET', `/api/levels/${doomedLvl}`, { token: adminTok });
      gate(`8. ${label}their level is gone — solves on it and all`, lvlGone.status === 404, `${lvlGone.status}`);
      const kl = await call('GET', `/api/levels/${keeperLvl}`, { token: adminTok });
      gate(`8. ${label}their solve is off the bystander's level`,
        kl.status === 200 && kl.solveList.length === 0, `${kl.solveList?.length} solves`);
      gate(`8. ${label}…and their comment with it`, (kl.comments || []).length === 0, `${kl.comments?.length} comments`);
      gate(`8. ${label}…and their rating no longer steers the average`,
        !kl.ratingCount, `ratingCount ${kl.ratingCount}`);
      const ghost = await call('POST', '/api/auth/login', { body: { name: 'doomed', password: 'passw0rd' } });
      gate(`8. ${label}the account itself cannot sign back in`, ghost.status === 401, `${ghost.status}`);
      const bystander = await call('GET', `/api/levels/${keeperLvl}`, { token: keeper.token });
      gate(`8. ${label}the bystander and their level are untouched`, bystander.status === 200, `${bystander.status}`);
    };
    const dead = await call('GET', '/api/me', { token: doomed.token });
    gate('8. their live session died with them', dead.status === 401 || dead.status === 404, `${dead.status}`);
    await check('');

    // the morning-after half: a delete is only a delete if the disk agrees
    await new Promise(r => setTimeout(r, 900));   // past the save debounce
    child.kill();
    await new Promise(r => setTimeout(r, 700));
    serverLog = '';
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    wire(child);
    await waitUp();
    await check('after a restart, ');
  }
  // ---------- gate 14: admin-defined campaigns ----------
  {
    const pub = await call('GET', '/api/campaigns');
    gate('14. the public list answers without a token',
      pub.status === 200 && Array.isArray(pub.campaigns) && pub.campaigns.length >= 1,
      `${pub.status} n=${pub.campaigns?.length}`);
    gate('14. …and ships Starters as 1,16 until an admin changes it',
      pub.campaigns?.[0]?.id === 'starters' && pub.campaigns[0].from === 1 && pub.campaigns[0].to === 16,
      JSON.stringify(pub.campaigns?.[0]));
    gate('14. …with two sections, 1–8 and 9–16',
      pub.campaigns?.[0]?.sections?.length === 2
      && pub.campaigns[0].sections[0].from === 1 && pub.campaigns[0].sections[0].to === 8
      && pub.campaigns[0].sections[1].from === 9 && pub.campaigns[0].sections[1].to === 16,
      JSON.stringify(pub.campaigns?.[0]?.sections));
    gate('14. …and Main Course covers 17–32',
      pub.campaigns?.[1]?.id === 'main-course' && pub.campaigns[1].from === 17 && pub.campaigns[1].to === 32,
      JSON.stringify(pub.campaigns?.[1]));
    const cfg = await call('GET', '/api/config');
    gate('14. /api/config carries the same list',
      Array.isArray(cfg.campaigns) && cfg.campaigns[0]?.id === 'starters', `${cfg.campaigns?.[0]?.id}`);
    const stranger = await call('PUT', '/api/admin/campaigns', { body: { campaigns: [] } });
    gate('14. a stranger cannot rewrite campaigns',
      stranger.status === 401 || stranger.status === 403, `${stranger.status}`);
    const empty = await call('PUT', '/api/admin/campaigns', { token: adminTok, body: { campaigns: [] } });
    gate('14. an empty list is refused — keep at least one',
      empty.status === 400, `${empty.status}: ${empty.error}`);
    const overlap = await call('PUT', '/api/admin/campaigns', {
      token: adminTok,
      body: { campaigns: [
        { title: 'A', byline: '', range: '1,10' },
        { title: 'B', byline: '', range: '10,20' },
      ] },
    });
    gate('14. overlapping ranges are refused',
      overlap.status === 400 && /overlap/i.test(overlap.error || ''), `${overlap.status}: ${overlap.error}`);
    const bad = await call('PUT', '/api/admin/campaigns', {
      token: adminTok, body: { campaigns: [{ title: 'A', range: 'nope' }] },
    });
    gate('14. a junk range is refused', bad.status === 400, `${bad.status}: ${bad.error}`);
    const secOverlap = await call('PUT', '/api/admin/campaigns', {
      token: adminTok,
      body: { campaigns: [{ title: 'A', sections: [{ title: 'X', range: '1,8' }, { title: 'Y', range: '8,16' }] }] },
    });
    gate('14. overlapping sections inside a campaign are refused',
      secOverlap.status === 400 && /overlap/i.test(secOverlap.error || ''), `${secOverlap.status}: ${secOverlap.error}`);
    const saved = await call('PUT', '/api/admin/campaigns', {
      token: adminTok,
      body: { campaigns: [
        { id: 'starters', title: 'Starters', byline: 'Learn the game.', range: '1,16' },
        { title: 'Later', byline: 'The rest.', range: '17,32' },
      ] },
    });
    gate('14. two disjoint ranges save',
      saved.status === 200 && saved.campaigns?.length === 2
      && saved.campaigns[0].to === 16 && saved.campaigns[1].id === 'later',
      JSON.stringify(saved.campaigns));
    gate('14. …and a campaign-level range becomes one section',
      saved.campaigns?.[0]?.sections?.length === 1 && saved.campaigns[0].sections[0].from === 1
      && saved.campaigns[1].sections?.[0]?.from === 17,
      JSON.stringify(saved.campaigns?.map((c) => c.sections)));
    const again = await call('GET', '/api/campaigns');
    gate('14. …and the public list agrees',
      again.campaigns?.length === 2 && again.campaigns[1].from === 17, JSON.stringify(again.campaigns));
  }

} catch (e) {
  fail++;
  console.log('FAIL  harness error: ' + (e?.stack || e));
} finally {
  cleanup();
}

summary();
