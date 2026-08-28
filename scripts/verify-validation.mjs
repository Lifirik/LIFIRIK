// verify-validation.mjs — the `validateLevelData` gate on POST /api/levels.
// Run: node scripts/verify-validation.mjs
//      node scripts/verify.mjs           (gates 1,2,4,5,6 — physics)
//
// The editor cannot build a malformed piece, so this is not about the editor.
// It is about the three doors hand-written JSON comes through — POST/PUT
// /api/levels and the FC importer — and one specific way through them: a piece
// whose shape is missing or misspelled. sim.js dispatches
// `p.shape === 'ball' ? {circle: p.r} : {box: p}`, so ANY unrecognised shape
// takes the box branch and b2MakeBox gets undefined half-extents. Box2D accepts
// that quietly and hands back NaN poses ~0.3 s later — the piece vanishes and
// the level is broken for everyone who opens it, with nothing anywhere saying
// why. Gate 0 below reproduces exactly that, so the rest of this file is
// measured against a failure that is known to be real rather than imagined.
//
// Runs the REAL server (a scratch database, an ephemeral port, rate limits off)
// rather than the validator in isolation: the thing worth proving is that the
// route says no, not that a function returns a string.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gates } from './gatekit.mjs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { MIN_AXIS, MIN_AREA, MIN_BALL_R, WHEEL_SIZES,
  clampBackScale, clampBackAlpha, backScaleOf, backAlphaOf,
  BACK_SCALE_MIN, BACK_SCALE_MAX } = await import(u('public/js/sizes.js'));
// Loose pins (2026-08-08). Restated rather than imported from game.js, the way
// verify-editor.mjs restates every cap it gates: a test that silently follows
// the constant is not gating it. verify-editor asserts these same two numbers
// against BOTH files, so the three copies are pinned to each other.
const MAX_LEVEL_PINS = 64;
const BACK_LEVEL_PINS = 32;
// The CLIENT's badge rule, used to judge what the server handed back — the two
// implementations are asserted equal by verify-challenges, so reading the
// server's rows through util.js's copy is the honest way to ask "what will a
// listing show for this solve".
const { computeBadges: computeBadgesLocal } = await import(u('public/js/util.js'));

const { gate, section, summary } = gates();

// A minimum viable level: everything validateLevelData insists on, so each case
// below differs from a publishable level in exactly one way.
const level = (over = {}) => ({
  terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
  props: [],
  buildZones: [{ x: -300, y: -75, w: 240, h: 150 }],
  goalZones: [{ x: 300, y: -52, w: 130, h: 104 }],
  goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
  win: 'goalObj',
  ...over,
});

// ---------- gate 0: the failure this gate exists to stop ----------
//
// Built straight into the sim, no server involved. If this ever stops producing
// NaN, the shape dispatch in sim.js has changed and everything below is
// guarding a door that no longer exists.
{
  const { initEngine, Simulation } = await import(u('public/js/sim.js'));
  await initEngine(u('public/vendor/fcsim/fcsim.wasm'));
  // `type` where `shape` belongs — the exact typo, copied from a real report
  const broken = level({ props: [{ type: 'ball', x: 0, y: 100, r: 10 }] });
  const sim = new Simulation(broken, { parts: [] });
  let frames = 0;
  const gone = () => !Number.isFinite(sim._pose(sim.props[0].body).x);
  while (frames < 60 && !gone()) { sim._fixedStep(); frames++; }
  gate('0. a prop with no `shape` really does NaN out in the sim', gone(),
    `frame ${frames} (${(frames / 60).toFixed(2)} s), x ${sim._pose(sim.props[0].body).x}`);
  sim.destroy();
}

// ---------- the server ----------

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lifirik-verify-'));
const port = await freePort();
const child = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    // a scratch database, so nothing here can touch data/db.sqlite (§16)
    LIFIRIK_DB: path.join(scratch, 'db.sqlite'),
    // ~50 posts below, against a 60-per-hour budget for heavy writes
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

try {
  await ready;

  // Publishing needs an account now (§11.6), so the suite gets one. Without a
  // token every case below would fail as 401 and prove nothing about the
  // validator — which is worth stating, because "all my validation gates went
  // red" after an auth change is a confusing way to learn that.
  const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'verifier', password: 'passw0rd' }),
  }).then(r => r.json());
  if (!reg.token) throw new Error('could not register the test account: ' + JSON.stringify(reg));
  const TOKEN = reg.token;

  const post = async (name, data) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      // clipped to the route's own 60-char name limit, so a long case
      // description can never fail as "Bad level name" and read as a
      // validation result
      body: JSON.stringify({ name: name.slice(0, 60), data }),
    });
    return { status: r.status, ...(await r.json()) };
  };

  // ---------- gate 0b: the account rule itself ----------
  {
    const anon = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anonymous publish', data: level() }),
    });
    gate('0b. publishing a level without an account is refused', anon.status === 401, `status ${anon.status}`);
  }

  // A rejection has to be a 400 that NAMES the piece — "bad level data" would be
  // technically correct and useless to whoever has to fix the JSON by hand.
  const rejects = async (what, data, expect) => {
    const r = await post('verify: ' + what, data);
    const msg = r.error || '';
    gate(`rejected: ${what}`, r.status === 400 && expect.test(msg),
      r.status === 400 ? `"${msg}"` : `status ${r.status}`);
  };
  const accepts = async (what, data) => {
    const r = await post('verify: ' + what, data);
    gate(`accepted: ${what}`, r.status === 200, r.status === 200 ? undefined : `${r.status} "${r.error}"`);
  };

  // ---------- gate 1: the reported bug, through the front door ----------
  await rejects('prop keyed `type` instead of `shape` (the reported bug)',
    level({ props: [{ type: 'ball', x: 0, y: 100, r: 10 }] }),
    /prop 1: shape must be 'box' or 'ball'/);

  // ---------- gate 2: shape ----------
  await rejects('prop with no shape at all', level({ props: [{ x: 0, y: 0, w: 20, h: 20 }] }), /prop 1: shape/);
  await rejects('prop with an unknown shape', level({ props: [{ shape: 'blob', x: 0, y: 0, r: 10 }] }), /got 'blob'/);
  await rejects('terrain keyed `shape` instead of `type`',
    level({ terrain: [{ shape: 'box', x: 0, y: 30, w: 100, h: 60 }] }), /terrain piece 1: type/);
  await rejects('goal piece with no shape',
    level({ goalObjs: [{ x: 0, y: -15, r: 15 }] }), /goal piece 1: shape/);
  await rejects('a prop that is not an object', level({ props: [null] }), /prop 1 is not a piece/);
  // the value is echoed back, so it must not be a way to echo back 2 MB
  await rejects('an absurd shape value is clipped in the error',
    level({ props: [{ shape: 'x'.repeat(5000), x: 0, y: 0, r: 10 }] }), /^prop 1: shape .{0,60}$/);

  // ---------- gate 3: the fields each shape needs ----------
  await rejects('box prop with no w/h', level({ props: [{ shape: 'box', x: 0, y: 0 }] }), /a box needs numeric w and h/);
  await rejects('ball prop with no r', level({ props: [{ shape: 'ball', x: 0, y: 0 }] }), /a ball needs a numeric r/);
  await rejects('box prop with w as a string',
    level({ props: [{ shape: 'box', x: 0, y: 0, w: '20', h: 20 }] }), /a box needs numeric w and h/);
  // JSON has no NaN or Infinity — they arrive as null, which must not read as 0
  await rejects('box prop with w null (how NaN/Infinity survive JSON)',
    level({ props: [{ shape: 'box', x: 0, y: 0, w: null, h: 20 }] }), /a box needs numeric w and h/);
  await rejects('prop with a non-numeric x', level({ props: [{ shape: 'ball', x: 'left', y: 0, r: 10 }] }), /x and y must be numbers/);
  await rejects('ball terrain with no r', level({ terrain: [{ type: 'ball', x: 0, y: 30 }] }), /terrain piece 1: a ball needs a numeric r/);
  await rejects('box goal piece with no w/h', level({ goalObjs: [{ shape: 'box', x: 0, y: -15 }] }), /goal piece 1: a box needs numeric w and h/);
  // density is the optional one that reaches the solver: it goes straight to
  // shapeDef.density, and a NaN mass NaNs the poses exactly like a missing w
  await rejects('prop with a non-numeric density',
    level({ props: [{ shape: 'ball', x: 0, y: 0, r: 10, density: 'heavy' }] }), /density must be a number/);
  // the legacy single `pin` is a world hinge, same as any pin in `pins`
  await rejects('prop with a malformed legacy pin',
    level({ props: [{ shape: 'box', x: 0, y: 0, w: 20, h: 20, pin: { x: 'a', y: 0 } }] }), /bad prop pin/);

  // ---------- gate 4: the size floors (sizes.js) ----------
  await rejects(`ball prop under MIN_BALL_R (${MIN_BALL_R} px)`,
    level({ props: [{ shape: 'ball', x: 0, y: 0, r: MIN_BALL_R - 0.5 }] }), /r must be at least/);
  await rejects(`box prop under MIN_AXIS (${MIN_AXIS} px)`,
    level({ props: [{ shape: 'box', x: 0, y: 0, w: 0.5, h: 40 }] }), /at least 1 px on each side/);
  await rejects(`box prop under MIN_AREA (${MIN_AREA} px²)`,
    level({ props: [{ shape: 'box', x: 0, y: 0, w: 3, h: 3 }] }), /px² in area/);
  await rejects('sub-floor terrain', level({ terrain: [{ type: 'box', x: 0, y: 30, w: 3, h: 3 }] }), /terrain piece 1/);
  await rejects('sub-floor goal piece', level({ goalObjs: [{ shape: 'ball', x: 0, y: -15, r: 0.5 }] }), /goal piece 1/);

  // ---------- gate 4b: painted terrain (§5.3) ----------
  //
  // A painted piece carries vertices instead of w/h/r, so it takes the box/ball
  // branch's place entirely — which means its own floors are the only thing
  // between hand-written JSON and the chain builder.
  const paintPts = (ring) => {
    const [first, ...rest] = ring;
    return { type: 'paint', x: first[0], y: first[1], pts: [...rest.map(([x, y]) => ({ x, y })), { x: first[0], y: first[1] }] };
  };
  const square = [[-100, 0], [100, 0], [100, 120], [-100, 120]];
  await rejects('painted terrain with no pts',
    level({ terrain: [{ type: 'paint', x: 0, y: 0 }] }), /needs a pts array/);
  await rejects('painted terrain with too few points',
    level({ terrain: [{ type: 'paint', x: 0, y: 0, pts: [{ x: 10, y: 0 }, { x: 0, y: 0 }] }] }), /at least 3 points/);
  await rejects('painted terrain past the 24-point cap',
    level({ terrain: [{ type: 'paint', x: 0, y: 0, pts: Array.from({ length: 25 }, (_, i) => ({ x: i * 10, y: 0 })) }] }),
    /too many points/);
  await rejects('painted terrain with a non-numeric vertex',
    level({ terrain: [{ type: 'paint', x: 0, y: 0, pts: [{ x: 10, y: 0 }, { x: 'a', y: 5 }, { x: 0, y: 0 }] }] }),
    /numeric x and y/);
  await rejects('painted terrain with a null vertex (how NaN survives JSON)',
    level({ terrain: [{ type: 'paint', x: 0, y: 0, pts: [{ x: 10, y: null }, { x: 5, y: 5 }, { x: 0, y: 0 }] }] }),
    /numeric x and y/);
  await rejects('painted terrain with a malformed handle',
    level({ terrain: [{ type: 'paint', x: 0, y: 0, pts: [{ x: 10, y: 0, h1: { x: 'a', y: 0 } }, { x: 5, y: 5 }, { x: 0, y: 0 }] }] }),
    /h1 must be numeric/);
  await rejects('terrain with an unknown type still names all three',
    level({ terrain: [{ type: 'splat', x: 0, y: 0 }] }), /'box', 'ball' or 'paint'/);
  await accepts('a painted terrain piece', level({ terrain: [paintPts(square)] }));
  await accepts('a painted piece with handles, texture and a motion path', level({
    terrain: [{
      ...paintPts(square),
      texture: 'grass',
      h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 },
      path: { pts: [{ x: 0, y: -200 }], mode: 'once', speed: 40 },
    }],
  }));

  // ---------- gate 4b: terrain surface materials (surfaces.js) ----------
  //
  // verify-surfaces.mjs proves badSurface() returns the right strings. This
  // proves the ROUTE calls it — the distinction that matters, because these
  // four numbers go straight into the solver's contact material and a level
  // is 2 MB of hand-writable JSON. Both piece paths are covered: a painted
  // piece returns from badPaintPiece before the box checks are reached, so
  // "the box branch rejects it" would prove nothing about paint.
  await accepts('terrain with a full surface', level({
    terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, texture: 'ice',
      surface: { friction: 0.06, restitution: 0, rollingResistance: 0, tangentSpeed: 0 } }],
  }));
  await accepts('terrain overriding one dial only', level({
    terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, surface: { tangentSpeed: -3 } }],
  }));
  await accepts('a painted piece with a surface', level({
    terrain: [{ ...paintPts(square), texture: 'rubber', surface: { restitution: 0.8 } }],
  }));
  await rejects('terrain with friction past the top of the range',
    level({ terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, surface: { friction: 50 } }] }),
    /friction must be between/);
  await rejects('terrain with a restitution that would never settle',
    level({ terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, surface: { restitution: 1 } }] }),
    /restitution must be between/);
  await rejects('terrain with a NaN-producing dial',
    level({ terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, surface: { friction: 'grippy' } }] }),
    /friction must be a number/);
  await rejects('terrain with a dial that does not exist',
    level({ terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, surface: { bounciness: 1 } }] }),
    /no 'bounciness' setting/);
  await rejects('a PAINTED piece with a bad surface (the early-return path)',
    level({ terrain: [{ ...paintPts(square), surface: { friction: -1 } }] }),
    /friction must be between/);
  await rejects('terrain naming a texture that does not exist',
    level({ terrain: [{ type: 'box', x: 0, y: 300, w: 400, h: 60, texture: 'obsidian' }] }),
    /unknown texture/);

  // ---------- gate 4c: planets (gravity.js, §5.10) ----------
  //
  // Same class as the surface dials and a step past them: `planet` does not
  // change how one piece feels, it decides which way DOWN is for every dynamic
  // body in the level. The two that matter are the ones hand-written JSON can
  // produce and the editor cannot — a planet on something with no usable
  // centre, and a pull outside the dial's range.
  await accepts('a plain planet', level({
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, { type: 'ball', x: 0, y: -400, r: 120, planet: {} }],
  }));
  await accepts('a planet with a pull', level({
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, { type: 'ball', x: 0, y: -400, r: 120, planet: { pull: 2 } }],
  }));
  await accepts('two planets (a binary system)', level({
    terrain: [
      { type: 'ball', x: -400, y: 0, r: 120, planet: {} },
      { type: 'ball', x: 400, y: 0, r: 60, planet: { pull: 0.5 } },
    ],
  }));
  await rejects('a planet on a BOX (no centre that works all the way round)',
    level({ terrain: [{ type: 'box', x: 0, y: 30, w: 400, h: 60, planet: {} }] }),
    /only a ball can be a planet/);
  await rejects('a planet on a painted piece',
    level({ terrain: [{ ...paintPts(square), planet: {} }] }),
    /only a ball can be a planet/);
  await rejects('a planet on a PROP',
    level({ props: [{ shape: 'ball', x: 0, y: 0, r: 20, planet: {} }] }),
    /only a ball can be a planet/);
  await rejects('a pull past the top of the dial',
    level({ terrain: [{ type: 'ball', x: 0, y: -400, r: 120, planet: { pull: 50 } }] }),
    /planet.pull must be between/);
  await rejects('a pull of zero (a planet that does not pull is not a planet)',
    level({ terrain: [{ type: 'ball', x: 0, y: -400, r: 120, planet: { pull: 0 } }] }),
    /planet.pull must be between/);
  await rejects('a NaN-producing pull',
    level({ terrain: [{ type: 'ball', x: 0, y: -400, r: 120, planet: { pull: null } }] }),
    /planet.pull must be a number/);
  await rejects('a planet setting that does not exist',
    level({ terrain: [{ type: 'ball', x: 0, y: -400, r: 120, planet: { strength: 2 } }] }),
    /no 'strength' setting/);
  await rejects('a bare number instead of a planet object',
    level({ terrain: [{ type: 'ball', x: 0, y: -400, r: 120, planet: 3 }] }),
    /planet must be an object/);

  // ---------- gate 5: what must still get through ----------
  //
  // A validator that only ever says no is easy and worthless. The floors are the
  // editor's own, so everything the editor and the importer can produce has to
  // clear them — including the deliberate blades sizes.js exists to allow.
  await accepts('a plain level', level());
  await accepts('every legal edge of the floors', level({
    props: [
      { shape: 'ball', x: -100, y: 0, r: MIN_BALL_R },              // exactly the ball floor
      { shape: 'box', x: -60, y: 0, w: MIN_AXIS, h: MIN_AREA },     // the 1×10 blade
      { shape: 'box', x: -20, y: 0, w: 2, h: 5 },                   // exactly MIN_AREA, squarer
      { shape: 'box', x: 20, y: 0, w: 40, h: 10, angle: 0.3, density: 1.2, radius: 4 },
      { shape: 'box', x: 80, y: 0, w: 10, h: 108, pin: { x: 80, y: -50 } },        // legacy pin
      { shape: 'box', x: 140, y: 0, w: 220, h: 10, pins: [{ x: 140, y: 0, fixed: true }] },
    ],
    terrain: [
      { type: 'box', x: 0, y: 30, w: 1200, h: 60 },
      { type: 'ball', x: -50, y: 22, r: 30 },
    ],
    goalObjs: [
      { shape: 'ball', x: -300, y: -15, r: 15 },
      { shape: 'box', x: -235, y: -20, w: 30, h: 30, density: 0.25, angle: 0.2 },
    ],
  }));

  // ---------- gate 6: the importer clears its own floors ----------
  //
  // fcimport.js absorbs the caps and floors with a warning rather than letting
  // the server bounce a whole import (its CAP comment says so), which the new
  // area check puts real weight on: fitPieceBox lands a sub-floor rect EXACTLY
  // on the floor, and round4 from there used to shave it back under. This is
  // the measured worst case of that — 0×29 at scale 0.25 → 1.1744 × 8.5147 =
  // 9.9997 px², rejected as its own converted output.
  //
  // A 0×29 DYNAMIC rect is a massless body, and FC's engine makes a massless
  // body static (2026-08-18, fcimport `massless`) — so the piece lands in
  // TERRAIN, not props, drawn at stick thickness and colliding as the line it
  // is (`line`). The gate follows it there; the floor question is the same.
  {
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'BA,0,0,200,200;GA,300,0,100,100;GC,-100,0,50,50;DR,0,-50,0,29', scale: 0.25 }),
    });
    const body = await r.json();
    const p = body.data?.terrain?.[0];
    gate('6. a sub-floor FC piece converts to something the server accepts',
      r.status === 200 && p && p.w * p.h >= MIN_AREA,
      r.status === 200 ? `${p?.w}×${p?.h} = ${(p?.w * p?.h).toFixed(4)} px²` : `${r.status} "${body.error}"`);
    gate('6. …and a zero-width DYNAMIC rect is a static line, not a prop (FC gives a massless body the static flag)',
      r.status === 200 && p && p.line === 'w' && (body.data?.props || []).length === 0,
      r.status === 200 ? `terrain[0].line=${p?.line}, props ${(body.data?.props || []).length}` : `${r.status}`);
  }

  // ---------- gate 6d: three spellings, one statement ----------
  //
  // The same level is written three ways — short codes with commas, long names
  // with parentheses, short codes with spaces — and the whole claim of the
  // parser is that these are ONE grammar with separators that don't mean
  // anything. So the gate is equality: convert all three and require the data
  // to come out identical, not merely valid. It also pins the two omissions
  // (`BA -200 -100 210` is square, no rotation is zero) by writing the same
  // level with the fields present in one spelling and absent in another.
  //
  // **The circle is written 30 in the words and 60 in the codes on purpose**
  // (2026-08-11). It is the one thing the dialects really do disagree about: a
  // word-dialect level circle states its RADIUS and a short-code one states its
  // DIAMETER (gates 6f and 6g). So the same physical circle is stated in each
  // dialect's own units here, and the equality below still means what it says —
  // separators change nothing. Gate 6g pins the disagreement itself, by giving
  // the two dialects the same NUMBER and requiring 2:1.
  {
    const paren = [
      'Type#index (center_x, center_y), (width, height), rotation_degrees, [joint_indices...]',
      'BuildArea (-200, -100), (210, 210), 0',
      'GoalArea (200, -50), (110, 110), 0',
      'StaticRect (0, 20), (1000, 40), 0',
      'StaticCircle (0, 20), (30, 30), 0',
      'GoalRect#0 (0, -30), (30, 90), 0',
      'GoalCircle#1 (0, -30), (40, 40), 0, [0]',
    ].join('\n');
    const bare = [
      'Type#index center_x center_y width height rotation_degrees joint_indices...',
      'BA -200 -100 210',
      'GA 200 -50 110',
      'SR 0 20 1000 40',
      'SC 0 20 60',
      'GR#0 0 -30 30 90',
      'GC#1 0 -30 40 40 0 0',
    ].join('\n');
    const commas = [
      'BA,-200,-100,210,210,0', 'GA,200,-50,110,110,0', 'SR,0,20,1000,40,0',
      'SC,0,20,60,60,0', 'GR,0,-30,30,90,0', 'GC,0,-30,40,40,0',
    ].join(';');
    // **scale 1, stated** (2026-08-11): this gate is about the GRAMMAR, and
    // riding the default meant every number in it moved when the nominal scale
    // was corrected from 0.6 to 0.75. At 1 the arithmetic is the source's own.
    const conv = async (text) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, scale: 1 }),
      });
      return { status: r.status, body: await r.json() };
    };
    const [a, b, c] = [await conv(paren), await conv(bare), await conv(commas)];
    const same = a.status === 200 && b.status === 200 && c.status === 200
      && JSON.stringify(a.body.data) === JSON.stringify(b.body.data)
      && JSON.stringify(a.body.data) === JSON.stringify(c.body.data);
    gate('6d. parentheses, spaces and commas are the same statement',
      same, same ? `${a.body.data.terrain.length} terrain, ${a.body.data.goalObjs.length} goal pieces, identical JSON`
        : `${a.status}/${b.status}/${c.status} — ${a.body.error || b.body.error || c.body.error || 'differed'}`);
    // the omissions, read off the spelling that leaves them out
    const t = b.body.data?.terrain || [];
    // **The one-number shorthand is unchanged; what the number MEANS has moved
    // twice.** It read r18 (all circles diameters), then r36 (all circles
    // radii), and is r18 again for THIS spelling only: `SC 0 20 60` is a short
    // code, and a short code states a diameter (gate 6g). The shorthand itself
    // is what this line is testing and it has held throughout — one number does
    // a circle, and a missing height makes a square.
    gate('6d. …no height means square, and one number does a CIRCLE',
      b.body.data?.buildZones?.[0]?.w === b.body.data?.buildZones?.[0]?.h
      && b.body.data?.buildZones?.[0]?.w === 210
      && t[1]?.type === 'ball' && t[1]?.r === 30,
      `zone ${b.body.data?.buildZones?.[0]?.w}×${b.body.data?.buildZones?.[0]?.h}, circle r${t[1]?.r} (at scale 1, so 210 is 210 and the 60 circle is r30)`);
    // and the legend line is neither a statement nor an error
    gate('6d. …and the legend line at the top is read, not refused',
      b.body.stats?.skipped === 0 && b.body.stats?.angleDeclared === true && b.body.stats?.parsed === 6,
      `${b.body.stats?.parsed} parsed, ${b.body.stats?.skipped} skipped, angles ${b.body.stats?.angleUnit} (declared: ${b.body.stats?.angleDeclared})`);
  }

  // ---------- gate 6e: the named machine, and what a dependency is for ----------
  //
  // `PlacedRod`/`PlacedStick`/`Placed*Wheel`/`PlacedPin` carry a solution in a
  // shape the code format never had: a beam is a CENTRE, a length and an
  // angle, and a `[3, 5]` says what it is bolted to. Both halves are gated —
  // the ends must come out where the geometry puts them, and a dependency must
  // close the rounding between two ends that the source stated separately,
  // because a joint in LIFIRIK is nothing but a shared coordinate (§5.4).
  {
    const { jointKey } = await import(u('public/js/util.js'));
    const text = [
      'BuildArea (-200, -100), (210, 210)',
      'GoalArea (200, -50), (110, 110)',
      'StaticRect (0, 60), (1000, 40)',
      'GoalRect#0 (0, -30), (30, 30)',
      'PlacedPin#1 (-100, 20)',
      'PlacedCWWheel#2 (-40, 20), (50, 50)',
      // ends at (-100,20) and (-40,20) — the pin and the hub, stated apart
      'PlacedRod#3 (-70, 20), (60, 4), 0, [1, 2]',
      'PlacedStick#4 (-70, -10), (60, 8)',
      'PlacedUPWheel#5 (30, 20), (100, 100)',
    ].join('\n');
    // The scale is STATED rather than inherited (2026-08-11). It happens to be
    // the nominal, but this gate is about a beam's ends coming off its centre,
    // length and angle — not about what the default is — and when the nominal
    // moved from 0.6 to 0.75 every coordinate below moved with it for no reason
    // anybody reading the gate would have guessed.
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, recentre: false, scale: 0.75 }),
    });
    const body = await r.json();
    const fp = body.data?.fixedParts || [];
    const wheels = fp.filter(p => p.t === 'wheel'), rods = fp.filter(p => p.t === 'rod');
    gate('6e. a named machine converts, wheels and beams alike',
      r.status === 200 && wheels.length === 2 && rods.length === 2,
      r.status === 200 ? `${wheels.length} wheels, ${rods.length} beams` : `${r.status} "${body.error}"`);
    // THICKNESS is the material, not the name: rod@4 is water, stick@8 is wood
    gate('6e. …a beam\'s material comes off its thickness (4 water, 8 wood)',
      rods.filter(p => p.kind === 'water').length === 1 && rods.filter(p => p.kind === 'wood').length === 1,
      rods.map(p => p.kind).join('/'));
    // a beam is a centre + length + angle, so the ends are arithmetic
    const water = rods.find(p => p.kind === 'water');
    // centre (-70, 20), length 60 → ends at -100 and -40 in source units,
    // × 0.75 = -75 and -30, with y 20 × 0.75 = 15
    gate('6e. …and its ends come off centre, length and angle',
      water && Math.min(water.x1, water.x2) === -75 && Math.max(water.x1, water.x2) === -30
      && water.y1 === 15 && water.y2 === 15,
      water ? `(${water.x1}, ${water.y1}) → (${water.x2}, ${water.y2})` : 'no water beam');
    // the dependency's job: that end IS the hub, to the joint key
    const hub = wheels.find(w => w.kind === 'cw');
    gate('6e. …the end it names lands exactly on that hub, by jointKey',
      hub && [jointKey(water.x1, water.y1), jointKey(water.x2, water.y2)].includes(jointKey(hub.x, hub.y)),
      hub ? `hub ${jointKey(hub.x, hub.y)} vs ends ${jointKey(water.x1, water.y1)} / ${jointKey(water.x2, water.y2)}` : 'no cw wheel');
    // Wheels state their own size here, unlike the code format — and they GET
    // it (2026-08-22). A wheel block's `<width>` is a diameter, so 50 and 100
    // source units at scale 0.75 are r 18.75 and r 37.5, and neither is one of
    // LIFIRIK's three. They used to be pulled onto the nearest rung, which is
    // what this line asserted; the numbers it asserted (15 / 30) were the OLD
    // ladder's, so it had been quietly red since the 4/3 rescale moved the
    // rungs to 10/20/40 — a stale expectation hiding a rule that was itself
    // wrong. Both are stated as arithmetic on the paste instead, which is the
    // only form of this that cannot go stale behind a ladder.
    gate('6e. …and a wheel that states its size gets it, ladder or no ladder',
      wheels.some(w => w.r === 25 * 0.75) && wheels.some(w => w.r === 50 * 0.75),
      wheels.map(w => `${w.kind} r${w.r}`).join(', '));
    gate('6e. …which for these two is off the ladder, and they are not pulled onto it',
      wheels.every(w => !WHEEL_SIZES.includes(w.r))
      && (body.warnings || []).some(w => /toolbar doesn't have/.test(w)),
      `${wheels.map(w => 'r' + w.r).join(', ')} against rungs ${WHEEL_SIZES.join('/')}`);
  }

  // ---------- gate 6c: a letter names a texture ----------
  //
  // Any two-letter code the table doesn't know, ending R or C, is a static
  // rect or circle whose texture comes from the leading letter (§14). Three
  // things to hold, and the third is the one that bites: the eight known codes
  // still win (`SC` is a static circle, not a circle of something beginning
  // with S), the texture that comes out is one the SERVER will accept — it
  // validates against the same list, so a letter landing off the end of
  // TEXTURES would bounce the whole import — and the map is STABLE, because a
  // texture is baked onto the piece and a paste that converts differently
  // tomorrow is a different level.
  {
    const { textureForLetter } = await import(u('public/js/fcimport.js'));
    const { TEXTURES } = await import(u('public/js/surfaces.js'));
    const text = [
      'BA,-450,-50,300,200,0', 'GA,250,-105,160,110,0', 'GC,-450,25,50,50,0',
      'CR,0,100,1400,100,0',    // the specified one: a rectangle of grass
      'KC,-300,40,80,80,0',     // a circle of whatever K is
      'SR,0,300,400,40,0',      // still a plain static rect, following the screen
      'SC,300,300,60,60,0',     // still a static CIRCLE, not an S-textured one
    ].join(';');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, texture: 'sand' }),
    });
    const body = await r.json();
    const t = body.data?.terrain || [];
    gate('6c. CR is a rectangle of grass, KC a circle, and SR/SC are untouched',
      r.status === 200 && t.length === 4
      && t[0].type === 'box' && t[0].texture === 'grass'
      && t[1].type === 'ball' && t[1].texture === textureForLetter('K')
      && t[2].type === 'box' && t[2].texture === 'sand'      // the screen's choice
      && t[3].type === 'ball' && t[3].texture === 'sand',    // SC is still a circle
      r.status === 200 ? t.map(p => `${p.type}:${p.texture}`).join(' ') : `${r.status} "${body.error}"`);
    gate('6c. …every letter names a texture the server will accept',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').every(c => TEXTURES.includes(textureForLetter(c))),
      `26 letters over ${TEXTURES.length} textures`);
    // Pinned by value: this is a stored look, so it may not drift when a
    // texture is added at the wrong end of the list.
    gate('6c. …and the map is fixed, not a fresh guess each import',
      ['A', 'C', 'K', 'X', 'Z'].map(c => textureForLetter(c)).join(',') === 'glass,grass,mud,rubber,wood',
      ['A', 'C', 'K', 'X', 'Z'].map(c => c + '=' + textureForLetter(c)).join(' '));
  }

  // ---------- gate 6a: an imported MACHINE is a machine ----------
  //
  // J/R/W carry a source solution, and the only thing holding one together is
  // that a rod end and a wheel hub resolved to the SAME joint. LIFIRIK has no
  // joint object to carry that — sharing an exact coordinate is the whole
  // mechanism (§5.4) — so the conversion is only correct if the coordinates
  // survive the scale and the recentre bit-for-bit. Asked three ways: the
  // parts come back the right kinds, `jointKey` agrees they are bolted
  // together, and the level with them in it publishes.
  //
  // An FC car on a slab. Node references count back in ENTRIES, not in joints,
  // which is why the offsets grow down the block: each rod pushes the joints
  // one further up the paste. Written out rather than generated, so the gate
  // states the numbering independently of the code that implements it.
  {
    const { jointKey } = await import(u('public/js/util.js'));
    const text = [
      'BA,-450,-50,300,200,0', 'GA,250,-105,160,110,0', 'SR,0,100,1400,100,0', 'GC,-450,25,50,50,0',
      'J,-580,25', 'J,-500,25', 'J,-540,-45',
      'R,1,-3,-2', 'R,1,-3,-2', 'R,0,-5,-3',
      'W,1,-6', 'W,2,-6',
    ].join(';');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await r.json();
    // **Both pools, because this car straddles the build area** (gate 6h,
    // 2026-08-11). This read `data.fixedParts`, and the machine now sorts by
    // whether a part is inside the zone — which for this fixture is four parts
    // in and one out: the left wheel sits at x −580 with a 25-unit radius, so it
    // pokes 5 units through a boundary at −600 and is a LEVEL piece by the rule.
    //
    // That is the rule working, and gate 6h is where it is asserted. What THIS
    // gate is about is the conversion — kinds, materials, the joints closing,
    // the wheel ladder — and none of that cares which pool a part landed in, so
    // it asks about the machine whole.
    const fp = [...(body.design || []), ...(body.data?.fixedParts || [])];
    const wheels = fp.filter(p => p.t === 'wheel'), rods = fp.filter(p => p.t === 'rod');
    gate('6a. an FC machine converts to parts the server accepts',
      r.status === 200 && wheels.length === 2 && rods.length === 3,
      r.status === 200 ? `${wheels.length} wheels, ${rods.length} rods` : `${r.status} "${body.error}"`);
    // the motor states and the two materials, by name — an unknown kind that
    // fell through to a powered wheel or a solid stick is the failure
    // sizes.js's badMachinePart refuses to allow
    gate('6a. …with the motor states and materials the source asked for',
      wheels.every(w => ['cw', 'ccw'].includes(w.kind))
      && new Set(wheels.map(w => w.kind)).size === 2
      // 1 is WOOD and 0 is WATER — the paste above asks for two of one and one
      // of the other, so a swapped table fails here rather than in a level
      && rods.filter(p => p.kind === 'wood').length === 2
      && rods.filter(p => p.kind === 'water').length === 1,
      `${wheels.map(w => w.kind).join('/')} · ${rods.map(p => p.kind).join('/')}`);
    // Every wheel hub sits on a rod end, and the triangle closes: 3 distinct
    // joint keys for 3 rods (6 ends) means each corner really is one point.
    const keys = new Set(rods.flatMap(p => [jointKey(p.x1, p.y1), jointKey(p.x2, p.y2)]));
    gate('6a. …bolted together: hubs land on rod ends, the triangle closes',
      keys.size === 3 && wheels.every(w => keys.has(jointKey(w.x, w.y))),
      `${keys.size} distinct joints, ${wheels.filter(w => keys.has(jointKey(w.x, w.y))).length}/2 hubs on one`);
    // and the wheels are on the ladder — not because a wheel has to be
    // (2026-08-22: one that states a size off the ladder keeps it, gate 6e),
    // but because a `W` states no size at all, so it takes FC's own standard
    // and the standard IS the middle rung at the shipped scale. This is the
    // gate on that anchor holding: if it ever comes out r 20.000001, the
    // scale and the standard have drifted apart.
    gate('6a. …and its wheels are a size LIFIRIK has',
      wheels.every(w => WHEEL_SIZES.includes(w.r)), wheels.map(w => 'r' + w.r).join(', '));
  }

  // ---------- gate 6b: a machine the source got wrong ----------
  //
  // The importer's rule is that one bad entry costs one entry (its `errors`
  // comment). For the machine that has teeth, and the two unknown-value cases
  // deliberately go opposite ways (see fcimport.js's ROD_KINDS note): a wheel
  // whose motor state we do not recognise must NOT fall through to a powered
  // one, while an unknown rod material DOES fall through to water rather than
  // taking its stick — and must be reported either way. A rod pointing at
  // something that is not a joint reaches the level in neither case, and under
  // entries-back numbering the commonest way to write that is to point at the
  // rod above.
  {
    const text = [
      'BA,-450,-50,300,200,0', 'GA,250,-105,160,110,0', 'SR,0,100,1400,100,0', 'GC,-450,25,50,50,0',
      'J,-580,25', 'J,-500,25',
      'R,1,-2,-1',      // the one good part
      'R,1,-9,-1',      // nothing 9 entries back
      'R,1,-1,-1',      // the entry above is the rod, not a joint
      'W,9,-4',         // a motor state that is not in the format
      'R,4,-6,-5',      // a material that is not in the format → water
      'J,-500,25',      // a second joint at the first one's coordinate…
      'R,1,-7,-1',      // …so this rod has no length and no direction
    ].join(';');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const body = await r.json();
    const fp = body.design || [];      // inside the build area — the player's (gate 6h)
    gate('6b. a bad machine entry costs one entry, not the import',
      r.status === 200 && fp.length === 2 && fp.every(p => p.t === 'rod') && body.stats?.skipped === 4,
      r.status === 200 ? `${fp.length} parts, ${body.stats?.skipped} skipped` : `${r.status} "${body.error}"`);
    gate('6b. …a material nobody knows is WATER, not a missing stick and not wood',
      fp.length === 2 && fp.filter(p => p.kind === 'water').length === 1
      && fp.filter(p => p.kind === 'wood').length === 1,
      fp.map(p => p.kind).join('/'));
    gate('6b. …and every one of them says why, by name',
      ['no entry 9 back', 'is not a joint', 'motor state "9"', 'same point', '"4"']
        .every(s => (body.warnings || []).some(w => w.includes(s))),
      JSON.stringify((body.warnings || []).slice(0, 6)));
  }

  // ---------- gate 6c: the four rod materials (2026-08-10) ----------
  //
  // FC Gold has two rod kinds FC1 never had, and the numbering was READ out of
  // `Rod.endConstructor` in its own jar rather than guessed: 2 sets
  // `density = 20.0` (its README: "Gold rods: 20x heavier than wood") and 3
  // sets a collision filter of 8/0, which meets nothing.
  //
  // So GOLD is not a material here — it is a wood stick with the weight dial
  // turned up, and this gate exists because that is the one of the four that
  // is silently plausible if it comes across as water: a level imports, looks
  // right, and every counterweight in it weighs a twentieth of what its author
  // built. GHOST is the new kind (§5.2).
  {
    const text = [
      'BA,-450,-50,300,200,0', 'GA,250,-105,160,110,0', 'SR,0,100,1400,100,0', 'GC,-450,25,50,50,0',
      'J,-580,25', 'J,-500,25',
      'R,0,-2,-1',    // water
      'R,1,-3,-2',    // wood
      'R,2,-4,-3',    // gold  → wood at x20
      'R,3,-5,-4',    // ghost
    ].join(';');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const body = await r.json();
    const fp = (body.design || []).filter(p => p.t === 'rod');   // …the player's, likewise
    const kinds = fp.map(p => p.kind).join('/');
    gate('6c. all four materials land, and none of them is skipped',
      r.status === 200 && fp.length === 4, `${fp.length} rods: ${kinds}`);
    gate('6c. …water, wood, gold-as-wood and ghost, in that order',
      kinds === 'water/wood/wood/ghost', kinds);
    gate('6c. …with GOLD carrying the weight and nothing else carrying one',
      fp[2]?.weight === 20 && [0, 1, 3].every(i => fp[i]?.weight == null),
      fp.map(p => p.weight ?? '-').join('/'));
    gate('6c. …and no warning, because none of the four is a guess any more',
      !(body.warnings || []).some(w => /material I don't know/.test(w)),
      JSON.stringify((body.warnings || []).filter(w => /material/.test(w))));
  }

  // ---------- gate 6e: the long form WITHOUT `Placed` (2026-08-10) ----------
  //
  // A third exporter writes the machine as `Rod#3 (…) [2]` and `Stick#1 (…)`,
  // and zones as `BuildAreaCircle` / `GoalAreaCircle` beside the triangular
  // pair we already knew. Both gaps failed the same way — silently, and into
  // the wrong pool:
  //
  //  - every `Rod`/`Stick` was an unknown piece code, so a 65-entry paste
  //    imported as bare terrain with all 65 machine parts gone;
  //  - a round zone fell through to the `?C` letter rule and came in as a
  //    static circle of TERRAIN, so the level lost a build area and gained a
  //    boulder.
  //
  // The reference for this gate is a shape sheet — one of every piece the
  // format has, with a picture of what each should be — so the counts below
  // are read off that picture rather than off the parser.
  {
    const text = [
      'BuildAreaCircle (450, -37), (200, 200)',
      'BuildAreaTri (688, -57), (200, 200)',
      'GoalAreaTri (724, 154), (200, 200)',
      'GoalAreaCircle (478, 175), (200, 200)',
      'BuildArea (-186, -20), (200, 200)',
      'GoalArea (162, 19), (200, 200)',
      'StaticRect (7, 197), (697, 109), 0',
      'StaticCircle (-373, -38), (50, 50), 0',
      'DynamicCircle (-1, -124), (50, 50), 0',
      'DynamicRect (311, 42), (50, 50), 0',
      'Rod#0 (-82, -227), (446, 4), -0.0078',
      'Stick#1 (-81, -194), (445, 8), -0.0177',
      'GoalBall#3 (-18, 49), (40, 40), 0',
      'GoalRect#4 (-15, -22), (50, 50), 0',
    ].join('\n');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const b = await r.json();
    const d = b.data || {};
    const rods = (d.fixedParts || []).filter(p => p.t === 'rod');
    gate('6e. THREE build zones and three goal zones — square, triangle and circle',
      (d.buildZones || []).length === 3 && (d.goalZones || []).length === 3,
      `${(d.buildZones || []).length}B / ${(d.goalZones || []).length}G`);
    gate('6e. …so the round ones are ZONES, not terrain',
      (d.terrain || []).length === 2,
      `${(d.terrain || []).length} terrain (the sheet has exactly two: a rect and a circle)`);
    gate('6e. `Rod` and `Stick` without the `Placed` are still a machine',
      rods.length === 2, `${rods.length} rods of ${(d.fixedParts || []).length} parts`);
    gate('6e. …and the THICKNESS still picks the material — 4 water, 8 wood',
      rods.filter(p => p.kind === 'water').length === 1 && rods.filter(p => p.kind === 'wood').length === 1,
      rods.map(p => p.kind).join('/'));
    gate('6e. `GoalBall` is a goal piece, not a glass circle',
      (d.goalObjs || []).length === 2
      && (d.goalObjs || []).filter(g => g.shape === 'ball').length === 1
      && (d.goalObjs || []).filter(g => g.shape === 'box').length === 1,
      (d.goalObjs || []).map(g => g.shape).join('/'));
    gate('6e. …and the props are the two dynamic pieces, one of each shape',
      (d.props || []).length === 2 && new Set((d.props || []).map(p => p.shape)).size === 2,
      (d.props || []).map(p => p.shape).join('/'));
    gate('6e. …with no code left unrecognised',
      !(b.warnings || []).some(w => /isn't in the format/.test(w)),
      JSON.stringify((b.warnings || []).filter(w => /isn't in the format/.test(w))));
  }

  // ---------- gate 6f: a circle states its RADIUS (2026-08-10) ----------
  //
  // The source measures its two round things opposite ways, and it is not a
  // guess: zhyrek — who wrote FC Gold and is on the FC20 team — said so in as
  // many words in the community channel, complaining about it. A LEVEL CIRCLE
  // states its radius; a WHEEL states its diameter.
  //
  // This file read circles as diameters from the start, so every circle any
  // import ever produced was half size. It survived for months because a
  // half-size boulder still looks like a boulder: the level imports, nothing
  // warns, and only the source's own render beside ours can catch it.
  //
  // The gate is a RATIO rather than a pixel count, because that is what the
  // reference render can be read for: a circle and a square declared at the
  // same number must come out 2:1.
  {
    const text = [
      'BuildArea (-150, 50), (200, 200)',
      'GoalArea (150, 50), (200, 200)',
      'DynamicRect (300, 0), (50, 50), 0',
      'DynamicCircle (0, 0), (50, 50), 0',
      'StaticCircle (-300, 0), (50, 50), 0',
    ].join('\n');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, scale: 0.6 }),
    });
    const b = await r.json();
    const box = (b.data?.props || []).find(p => p.shape === 'box');
    const ball = (b.data?.props || []).find(p => p.shape === 'ball');
    const terr = (b.data?.terrain || [])[0];
    gate('6f. a circle and a square declared the same come out 2:1',
      box && ball && Math.abs((ball.r * 2) / box.w - 2) < 1e-6,
      `circle ${ball ? (ball.r * 2).toFixed(1) : '?'} px across vs square ${box ? box.w.toFixed(1) : '?'} px`);
    gate('6f. …because the stated number IS the radius',
      ball && Math.abs(ball.r - 50 * 0.6) < 1e-6, `r ${ball?.r} at scale 0.6 (50 × 0.6 = 30)`);
    gate('6f. …and terrain circles read the same way as props',
      terr && Math.abs(terr.r - (ball?.r ?? -1)) < 1e-6, `terrain r ${terr?.r} vs prop r ${ball?.r}`);
  }
  // …and the other half of the split: a GOAL piece is measured with the
  // WHEELS, not with the level circles. From a sheet carrying all three — a
  // (50,50) square, a wheel stating 40 and a goal ball stating 40 — where the
  // wheel and the ball draw IDENTICALLY and both come out smaller than the
  // square. Read as a radius the ball would be 80 across, half again wider
  // than the square, which it plainly is not.
  {
    const text = [
      'BuildArea (-150, 50), (200, 200)', 'GoalArea (150, 50), (200, 200)',
      'StaticRect (-22.31, -250.92), (50, 50), 0',
      'PlacedUPWheel#0 (37.44, -253.60), (40, 40), 0',
      'GoalBall#1 (89.74, -254.00), (40, 40), 0',
    ].join('\n');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, scale: 0.75 }),
    });
    const b = await r.json();
    const ball = (b.data?.goalObjs || [])[0];
    const wheel = (b.data?.fixedParts || []).find(p => p.t === 'wheel');
    const sq = (b.data?.terrain || [])[0];
    gate('6f. a GOAL ball states its DIAMETER, so it lands on the wheel exactly',
      ball && wheel && Math.abs(ball.r - wheel.r) < 1e-6,
      `ball r${ball?.r} vs wheel r${wheel?.r}`);
    gate('6f. …and both come out smaller than a 50 square, as the render shows',
      ball && sq && ball.r * 2 < sq.w, `${ball ? (ball.r * 2) : '?'} across vs a ${sq?.w} square`);
    // …and the number is arithmetic on the paste, not a rung: a 40-unit wheel
    // and a 40-unit ball at scale 0.75 are both r 15, and r 15 is not one of
    // LIFIRIK's three (10 / 20 / 40). It reads "both land on LIFIRIK's own
    // 30 px standards", and did, before the 4/3 rescale moved the standard to
    // r 20 — after which the BALL still came out 15 and the wheel was pulled
    // to 20, so the pair this whole block is about stopped agreeing and the
    // line above went red with it. Scaling a level scales its wheels
    // (2026-08-22): they agree again, at the size the paste states.
    gate('6f. …and the pair scales together — 40 units at 0.75 is r 15, rung or not',
      ball?.r === 15 && wheel?.r === 15 && !WHEEL_SIZES.includes(15),
      `ball r${ball?.r}, wheel r${wheel?.r} (rungs are ${WHEEL_SIZES.join('/')})`);
  }

  // ---------- gate 6g: …but a SHORT-CODE circle states its diameter ----------
  //
  // (2026-08-11.) Gate 6f above is measured entirely on pastes written in the
  // long names, and the radius rule was applied to every dialect — so the
  // comma-separated codes started importing their circles at twice size.
  //
  // The paste that showed it is 90 entries of real level, and the argument is
  // about RELATIVE size, which is what makes it independent of the scale: read
  // as diameters its circles are a fifteenth to a fifth of the level's own
  // width, which is a boulder; read as radii they are twice that, and the big
  // one is a third of the level across.
  //
  // (This used to anchor on the paste's goal ball — 47.9 units against
  // LIFIRIK's 30 px standard — and that was never sound. **FC goal pieces are
  // author-sized**: the same 32 saved designs that settled the wheel at 40
  // units carry goal pieces at 20.4, 26.3, 40 and 90. The wheel is the only
  // fixed-size piece the format has, so it is the only thing worth anchoring
  // on, and the scale here is stated rather than inferred.)
  {
    const text = [
      'BA,-342.95000000000005,-153.05,501.5,333.7,0.0',
      'GA,-362.15,-482.15,228.9,253.3,0.0',
      'SR,-418.45,54.55,356.2,107.5,0.0',
      'SC,-8.70000000000001,-265.3,306.0,-53.99999999559178',
      'DC,-1074.95,-906.9999999999999,371.0,11.000000016078555',
      'DC,298.7,-632.1000000000001,44.400000000000006,44.40000000656138',
      'GC,-541.79981004,-162.88687127999998,47.9,47.90000001688599,1',
    ].join(';');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, scale: 0.75 }),
    });
    const b = await r.json();
    const circles = [...(b.data?.terrain || []), ...(b.data?.props || [])].filter(o => o.r != null);
    const across = circles.map(c => c.r * 2).sort((x, y) => y - x);
    const width = b.stats?.extent?.w ?? 0;
    // Scale-free, which is the point: whatever the scale, a circle read as a
    // diameter is half the circle read as a radius, and these are the sizes
    // that make the paste a level rather than a pile of boulders.
    gate('6g. its biggest circle is a quarter of the level across, not a half',
      width > 0 && Math.abs(across[0] / width - 0.234) < 0.02,
      `${across[0].toFixed(0)} px across a ${width.toFixed(0)} px level = ${(100 * across[0] / width).toFixed(0)}% (read as a radius it would be ${(200 * across[0] / width).toFixed(0)}%)`);
    gate('6g. …and the smallest is a boulder, not a pebble or a hill',
      across.length === 3 && Math.abs(across[2] / 30 - 1.11) < 0.05 && Math.abs(across[0] / 30 - 9.28) < 0.05,
      across.map(px => (px / 30).toFixed(2) + ' m').join(', '));
    // A circle carries ONE size: `(d, rot)` where a rect carries `(w, h, rot)`.
    // Read as a height, that rotation set the size through `max(w, h)` the
    // moment it exceeded the diameter — and complained that the width and the
    // height disagreed about a piece that has neither.
    gate('6g. …and a circle\'s fourth number is its ROTATION, not a height',
      !(b.warnings || []).some(w => /width and height that disagreed/.test(w)),
      JSON.stringify((b.warnings || []).filter(w => /disagreed/.test(w))));
  }
  {
    // The same number in both dialects, side by side: 2:1 and nothing else.
    const conv = async (text) => (await (await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, scale: 0.6 }),
    })).json());
    const worded = await conv('BuildArea (-150, 50), (200, 200)\nStaticCircle (0, 0), (50, 50), 0');
    const coded = await conv('BA,-150,50,200,200,0;SC,0,0,50,50,0');
    const wr = (worded.data?.terrain || [])[0]?.r, cr = (coded.data?.terrain || [])[0]?.r;
    gate('6g. a 50 circle is r30 in the words and r15 in the codes',
      wr === 30 && cr === 15, `worded r${wr}, coded r${cr}`);
    // …and the fat-circle case the max() reading got wrong: a small circle
    // turned a long way round came out as the ANGLE.
    const spun = await conv('BA,-150,50,200,200,0;SC,0,0,44.4,120.5');
    gate('6g. …and a circle spun past its own diameter keeps its size',
      Math.abs(((spun.data?.terrain || [])[0]?.r ?? -1) - 13.32) < 1e-6,
      `r${(spun.data?.terrain || [])[0]?.r} (44.4 × 0.6 ÷ 2 = 13.32, not 120.5 × 0.6 ÷ 2 = 36.15)`);
  }

  // ---------- gate 6h: the build area holds the PLAYER'S machine ----------
  //
  // (2026-08-11, on request: *"Assume all pieces in the build area are solution
  // pieces. And all with any part outside are level pieces"*, then *"Don't leave
  // the pieces out of the solution. Mark them as player pieces (like in Test)"*.)
  // A paste is usually a level with somebody's machine parked in it, and taken
  // in whole that level arrives already solved and already running.
  //
  // NOTHING IS DROPPED: a part inside the build area comes back as `design`,
  // the Test tab's own machine, which is what it was in the source.
  //
  // One fixture carries every branch of the rule at once: a build area 200×200
  // about the origin, with a piece of each kind inside it and a piece of each
  // kind outside.
  {
    const lines = [
      'BA,0,0,200,200,0',           // 1  the build area: x -100..100, y -100..100
      'GA,400,0,100,100,0',         // 2
      'SR,0,300,1000,60,0',         // 3  ground, well outside
      'SR,0,0,40,40,0',             // 4  TERRAIN inside the build area — kept
      'DC,50,50,20,0',              // 5  a loose piece inside — the solution
      'DC,400,-300,20,0',           // 6  …and one outside — kept
      'GC,-50,0,30,0',              // 7  the GOAL BALL, inside — kept
      'J,-50,50',                   // 8  a joint BOTH sticks below name
      'J,50,50',                    // 9
      'R,1,-2,-1',                  // 10 both ends inside — the player's
      'J,300,50',                   // 11 …well outside
      'R,1,-4,-1',                  // 12 …so this one, from entry 8 to entry 11, is the level's
    ];
    // Stated, not inherited — which pool a part lands in has nothing to do with
    // the scale, and the two coordinates asserted below should not move when
    // the nominal does.
    const SCALE = 0.75;
    const conv = async (over = {}) => (await (await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: lines.join(';'), scale: SCALE, ...over }),
    })).json());
    const b = await conv();
    const d = b.data || {};
    gate('6h. the machine inside the build area is the PLAYER\'s, not the level\'s',
      (b.design || []).length === 1 && (d.fixedParts || []).length === 1,
      `${(b.design || []).length} on the Test tab, ${(d.fixedParts || []).length} in the level`);
    // The half the request spells out: "any part outside" is a containment test,
    // so a stick with one end in the world is the AUTHOR'S, not the player's —
    // and the two must not be the same stick.
    const lvlRod = (d.fixedParts || [])[0], plyRod = (b.design || [])[0];
    gate('6h. …and it is the right one on each side — the level keeps the one reaching out',
      Math.max(lvlRod?.x1 ?? 0, lvlRod?.x2 ?? 0) === 300 * SCALE
      && Math.max(plyRod?.x1 ?? 0, plyRod?.x2 ?? 0) === 50 * SCALE,
      `level rod reaches x${Math.max(lvlRod?.x1 ?? 0, lvlRod?.x2 ?? 0)}, player's x${Math.max(plyRod?.x1 ?? 0, plyRod?.x2 ?? 0)}`);
    // Both pools go through one scale and one translate, which is the whole of
    // what keeps a joint a joint (§5.4): the two sticks name the SAME source
    // joint at (-50, 50), so after the split they must still share a coordinate
    // to the last decimal or the player's machine arrives unbolted from the
    // level's.
    gate('6h. …and the two still meet: one translate, so a shared joint survives the split',
      lvlRod && plyRod && lvlRod.x1 === plyRod.x1 && lvlRod.y1 === plyRod.y1,
      `level rod end ${lvlRod?.x1},${lvlRod?.y1} vs player rod end ${plyRod?.x1},${plyRod?.y1}`);
    // The three exemptions, and none is a hedge: a player cannot place static
    // scenery; a goal piece STARTS in the build area in this format (the real
    // paste this rule came from has its goal ball sitting in one); and a loose
    // prop has no player form to become, so it stays and is reported.
    gate('6h. TERRAIN inside the build area stays in the level — a player cannot build that',
      (d.terrain || []).length === 2, `${(d.terrain || []).length} terrain (the ground and the block inside)`);
    gate('6h. …and so does the GOAL PIECE, which is the thing you carry out of it',
      (d.goalObjs || []).length === 1 && (d.goalObjs || [])[0]?.shape === 'ball',
      JSON.stringify(d.goalObjs));
    gate('6h. …and so does a loose PROP, since a design is sticks, wheels and pins',
      (d.props || []).length === 2 && b.stats?.propsInBuild === 1,
      `${(d.props || []).length} props kept, ${b.stats?.propsInBuild} of them reported as inside the area`);
    gate('6h. …with every entry still read and counted, solve included',
      b.stats?.parsed === 9 && b.stats?.skipped === 0 && b.stats?.joints === 3
      && b.stats?.rods === 2 && b.stats?.designParts === 1,
      `${b.stats?.parsed} parsed (7 pieces + 2 rods), ${b.stats?.joints} joints, ${b.stats?.skipped} skipped, ${b.stats?.rods} sticks of which ${b.stats?.designParts} the player's`);
    gate('6h. …and both facts are said out loud',
      (b.warnings || []).some(w => /1 machine part sat wholly inside the build area/.test(w))
      && (b.warnings || []).some(w => /1 loose piece also sat inside the build area but stayed in the LEVEL/.test(w)),
      JSON.stringify((b.warnings || []).filter(w => /build area/.test(w))));

    // The escape hatch: the whole machine in the level, as it imported before.
    const whole = await conv({ solutionInBuild: false });
    gate('6h. `solutionInBuild: false` puts the whole machine in the level',
      (whole.data?.fixedParts || []).length === 2 && (whole.design || []).length === 0
      && whole.stats?.propsInBuild === 0,
      `${(whole.data?.fixedParts || []).length} in the level, ${(whole.design || []).length} on the Test tab`);

    // A paste with no build area constrains nothing — and the importer INVENTS
    // one further down, so this also pins the ORDER: a zone we made up must not
    // claim pieces we were given.
    const noZone = await (await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: lines.filter(l => !l.startsWith('BA')).join(';') }),
    })).json();
    gate('6h. a paste with NO build area keeps the lot in the level, invented zone and all',
      (noZone.data?.fixedParts || []).length === 2 && (noZone.design || []).length === 0
      && (noZone.data?.buildZones || []).length === 1,
      `${(noZone.data?.fixedParts || []).length} parts, ${(noZone.design || []).length} player parts, ${(noZone.data?.buildZones || []).length} zone placed for it`);
  }

  // ---------- gate 6i: a RADIANS paste's joints still snap ----------
  //
  // (2026-08-11, off an imported test level that would not solve.)
  //
  // A dependency is judged by DISTANCE — two anchors within `SNAP_TOL` are one
  // joint stated twice — and a beam's ends cannot be worked out until the
  // paste's angle unit is settled, which takes reading every angle in the file.
  // The wiring used to run inline, during the parse, on ends laid with a
  // PROVISIONAL unit of degrees. On a degrees paste that is right by accident;
  // on a radians one every joint in the machine is measured on geometry that
  // was never anywhere near, refused as "too far apart", and the contraption
  // imports as a heap of unattached sticks that folds up the moment it is
  // played. Five of this level's seven sticks came in loose.
  //
  // The two lines below are that level's, unedited. They really do meet — 1.06
  // units apart, well inside the 2-unit tolerance — and the old reader made it
  // 251.7.
  {
    const text = [
      'BuildArea (-100, 400), (1400, 800)',
      'GoalArea (-833.1, 522.2), (114.2, 100)',
      'StaticRect (0, 700), (2000, 60), 0',
      'GoalBall#0 (-300, 300), (39.5, 39.5), 0',
      'Stick#1 (-226.875, 513.125), (164.862321347238, 8), 2.87991577068584',
      'Stick#2 (48.625, 278.475), (579.222137871128, 8), 2.31357612810866 [1]',
    ].join('\n');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const b = await r.json();
    gate('6i. the paste is read as RADIANS, which is what makes this hard',
      b.stats?.angleUnit === 'rad', `${b.stats?.angleUnit}`);
  }

  // ---------- gate 6j: a parenthesis is a GROUP, not a separator ----------
  //
  // (2026-08-11.) Everything else about this grammar says `(` and `)` are just
  // separators, and that is right about what they separate and wrong about what
  // they enclose: the format writes `(x, y), (w, h), rot`, and a piece with only
  // one size writes `(w)`.
  //
  // Read positionally the rotation slides into the empty slot, and for a BEAM
  // that is not cosmetic — a beam's thickness IS its material (4 water, 8 wood),
  // so `Rod#0 (…), (168.2447), 2.1719` came out 2.17 thick and unrotated, and a
  // whole triangle of water rods imported as WOOD lying flat.
  //
  // The gate is equality between the two spellings of one rig — a real one,
  // saved both ways — because that is the claim: stating the thickness and
  // leaving it out describe the same machine.
  {
    const rig = (sizes) => [
      'BuildArea (-150, 50), (200, 200)',
      'GoalArea (150, 50), (200, 200)',
      'StaticRect (-225, 208.9063), (1058.4375, 97.5), 0',
      `Rod#0 (-199.9219, 80), (168.2447${sizes ? ', 4' : ''}), 2.1719`,
      `Rod#1 (-149.2969, 149.375), (196.4063${sizes ? ', 4' : ''}), 0 [0]`,
      `Rod#2 (-101.7187, 80), (171.7647${sizes ? ', 4' : ''}), -2.2012 [1, 0]`,
      `Stick#3 (-112.0312, 10.625), (80.625${sizes ? ', 8' : ''}), 0 [2]`,
    ].join('\n');
    const conv = async (text) => (await (await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, recentre: false, scale: 0.75 }),
    })).json());
    const bare = await conv(rig(false)), full = await conv(rig(true));
    const kinds = b => (b.design || []).map(p => p.kind).join('/');
    gate('6j. a size stated as `(len)` is the same machine as `(len, thick)`',
      JSON.stringify(bare.design) === JSON.stringify(full.design) && (bare.design || []).length === 4,
      `${(bare.design || []).length} vs ${(full.design || []).length} parts, ${kinds(bare)} vs ${kinds(full)}`);
    // The two halves of what went wrong, each asserted on its own so a
    // regression says which one came back.
    gate('6j. …so the water rods are WATER, not wood — the thickness was never stated',
      kinds(bare) === 'water/water/water/wood', kinds(bare) || 'nothing');
    gate('6j. …and the number after the group is the ROTATION, not a thickness',
      bare.stats?.angleUnit === 'rad'
      && (bare.design || []).some(p => Math.abs(p.y1 - p.y2) > 1),
      `angles ${bare.stats?.angleUnit}; ${(bare.design || []).filter(p => Math.abs(p.y1 - p.y2) > 1).length} of 4 rods are not flat`);
  }

  // ---------- gate 6k: a PILE keeps its coordinates and hangs by one end ----
  //
  // (2026-08-16.) A weight in FC is a stack of identical sticks on one spot,
  // and the two readings of it are a whole machine apart. Sharing a coordinate
  // is what bolts two pieces here, so a pile that agrees at BOTH ends welds
  // itself into a rigid beam; the source pinned it at ONE end and left the
  // other swinging, which is what makes it a weight rather than a girder.
  //
  // The importer used to buy that by FANNING the free ends a tenth of a pixel
  // apart. It worked and it moved the pieces. Now the `[…]` lists are carried
  // as `att` and the geometry is left alone, so this gate asserts both halves:
  // the sticks are still exactly stacked, AND they are not welded at both ends.
  //
  // Three sticks, all on the same two points, each naming the one before it —
  // TestLevel's 31-pile in miniature, and the same shape `fanStacks` was
  // written for. Plus one stick that names nothing, which must come out free at
  // both ends however much it is touching.
  {
    const text = [
      'BuildArea (0, 0), (400, 400)',
      'GoalArea (400, 0), (100, 100)',
      'StaticRect (0, 208), (1000, 60), 0',
      'Stick#1 (0, 0), (100, 8), 0',
      'Stick#2 (0, 0), (100, 8), 0 [1]',
      'Stick#3 (0, 0), (100, 8), 0 [2]',
      'Stick#4 (0, 0), (100, 8), 0',
    ].join('\n');
    const b = await (await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, recentre: false, scale: 1 }),
    })).json();
    const rods = (b.design || []).filter(p => p.t === 'rod');
    // NOTHING MOVED: all four sticks still on exactly the two points they were
    // written at. Under the fan these spanned a fifth of a degree.
    const ends = new Set(rods.flatMap(p => [`${p.x1},${p.y1}`, `${p.x2},${p.y2}`]));
    gate('6k. a stacked pile keeps its exact coordinates — no fan',
      rods.length === 4 && ends.size === 2,
      `${rods.length} sticks over ${ends.size} distinct points (2 = unmoved, 8 = fanned)`);
    gate('6k. …and every stick carries what the source said it is bolted to',
      rods.length === 4 && rods.every(p => Array.isArray(p.att) && p.att.length === 2),
      JSON.stringify(rods.map(p => p.att)));
    // The point of the whole thing: one end named, one end DECLARED FREE — the
    // state a coordinate cannot express, and the reason the pile can swing.
    // Eight ends over four sticks; the chain names two of them (#2→#1, #3→#2)
    // and every other end is free, INCLUDING the far ends of the chained pair,
    // which are sitting exactly on top of six others.
    const declaredFree = rods.reduce((n, p) => n + (p.att || []).filter(a => a === null).length, 0);
    const named = rods.reduce((n, p) => n + (p.att || []).filter(a => typeof a === 'string').length, 0);
    gate('6k. …so the pile is bolted at ONE end and free at the other',
      named === 2 && declaredFree === 6,
      `${named} named and ${declaredFree} declared-free of 8 ends (want 2 and 6)`);
    // …and all of them chose the SAME end, or a pile is bolted alternately.
    gate('6k. …and the chained sticks all hang from the same end',
      rods.filter(p => typeof p.att?.[0] === 'string').length === 2,
      JSON.stringify(rods.map(p => p.att)));
    // …and the sim builds that, rather than the C(N,2) the coordinates imply.
    // Four sticks on two shared points is 12 revolute joints inferred; declared
    // it is the two the chain states.
    const { initEngine, Simulation } = await import(u('public/js/sim.js'));
    await initEngine(u('public/vendor/fcsim/fcsim.wasm'));
    const lvl = { ...b.data, name: 'pile', fixedParts: b.data.fixedParts || [] };
    const declared = new Simulation(lvl, { parts: b.design }, { physics: 'fc' });
    const inferred = new Simulation(lvl, { parts: b.design.map(({ att, ...r }) => r) }, { physics: 'fc' });
    gate('6k. …and the SIM builds the declared joints, not the ones it can infer',
      declared.jointRecs.length === 2 && inferred.jointRecs.length > declared.jointRecs.length,
      `${declared.jointRecs.length} declared vs ${inferred.jointRecs.length} inferred from the same geometry`);
  }

  // ---------- gate 6d: an FC Resource export imports clean ----------
  //
  // Its header is `;`-commented and `;` is this format's ENTRY SEPARATOR, so
  // every one of those lines used to arrive as an entry and be skipped as an
  // unknown piece code — eight warnings about a file's own title page. A line
  // whose first non-space character is the separator cannot be an entry, which
  // is what makes the two tellable apart.
  {
    const text = [
      '; Level: Test (#1)',
      '; Author: nobody (#2)',
      '; Exported by FC Resource (http://fc.sk89q.com)',
      '',
      '@name Borrowed Level',
      '@description ',
      '',
      '; Build and goal areas',
      'BuildArea (-100, 0), (200, 150), 0',
      'GoalArea (200, 0), (100, 100), 0',
      '; Level objects',
      'StaticRect (0, 80), (600, 40), 0',
      'GoalCircle (-80, 20), (30, 30), 0',
    ].join('\n');
    const r = await fetch(`http://127.0.0.1:${port}/api/import/fc`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const body = await r.json();
    gate('6d. a `;`-commented header costs no warnings and no entries',
      r.status === 200 && body.stats?.skipped === 0 && (body.warnings || []).length === 0,
      `${body.stats?.skipped} skipped, ${(body.warnings || []).length} warnings`);
    gate('6d. …and the geometry still arrives',
      (body.data?.terrain || []).length === 1 && (body.data?.goalObjs || []).length === 1
      && (body.data?.buildZones || []).length === 1 && (body.data?.goalZones || []).length === 1,
      JSON.stringify({ t: body.data?.terrain?.length, g: body.data?.goalObjs?.length }));
    gate('6d. …with the level taking the name the header gave it',
      body.name === 'Borrowed Level', JSON.stringify(body.name));
  }

  // ---------- text labels (§10.6), through the real POST ----------
  //
  // A label never reaches Box2D, so none of this is about NaN poses — it is
  // about what reaches a CANVAS. `font` and `colour` are handed to a 2D context,
  // `size` is multiplied into line heights and stroke widths, and `text` is
  // walked line by line. The editor caps every one of those at the one door it
  // owns; this is the door that bypasses the editor.
  {
    const lbl = (over = {}) => ({ text: 'SIGN', x: 0, y: -200, size: 30, ...over });
    const okCases = [
      ['a plain label', lbl()],
      ['one with no size (defaults)', { text: 'SIGN', x: 0, y: -200 }],
      ['a palette colour by name', lbl({ colour: 'goal' })],
      ['a picked #rrggbb colour', lbl({ colour: '#ff8800' })],
      ['every font key', lbl({ font: 'papyrus' })],
      ['bold + italic + outline', lbl({ bold: true, italic: true, outline: true })],
      ['a turned label', lbl({ angle: 0.4 })],
      ['multi-line at the cap', lbl({ text: Array.from({ length: 12 }, (_, i) => 'l' + i).join('\n') })],
    ];
    let okBad = null;
    for (const [what, t] of okCases) {
      const r = await post('verify: label ok — ' + what, level({ texts: [t] }));
      if (r.status !== 200) { okBad = `${what}: ${r.error}`; break; }
    }
    gate('a legal label publishes, every field exercised', !okBad, okBad || `${okCases.length} cases`);

    const badCases = [
      ['text must be a string', lbl({ text: 7 }), /must be a string/],
      ['no NaN coordinates', lbl({ x: 'nope' }), /must be numbers/],
      ['a size past the ceiling', lbl({ size: 1e9 }), /size must be between/],
      ['a non-numeric size', lbl({ size: 'big' }), /size must be a number/],
      ['an unknown font', lbl({ font: 'Wingdings' }), /unknown font/],
      // the one that matters most: a colour is either a name we know or six hex
      // digits, so nothing else can ever reach `fillStyle`
      ['a CSS function as a colour', lbl({ colour: 'url(http://x/y)' }), /colour must be/],
      ['a short hex colour', lbl({ colour: '#f80' }), /colour must be/],
      ['a colour with punctuation in it', lbl({ colour: 'red; background: url(x)' }), /colour must be/],
      ['an unknown alignment', lbl({ align: 'middle' }), /align must be/],
      ['too many characters', lbl({ text: 'x'.repeat(241) }), /too long/],
      ['too many lines', lbl({ text: 'a\n'.repeat(12) }), /too many lines/],
      ['a label that is not an object', 'SIGN', /is not a label/],
    ];
    let badLeak = null;
    for (const [what, t, re] of badCases) {
      const r = await post('verify: label bad — ' + what, level({ texts: [t] }));
      if (r.status === 200) { badLeak = `${what}: ACCEPTED`; break; }
      if (!re.test(r.error || '')) { badLeak = `${what}: said "${r.error}"`; break; }
    }
    gate('every illegal label is refused, with a reason that names the field',
      !badLeak, badLeak || `${badCases.length} cases`);

    // counts, front and back — the editor refuses at the cap, so this is the
    // import/hand-edit door
    const many = (n) => Array.from({ length: n }, (_, i) => lbl({ x: i * 10 }));
    const over = await post('verify: 61 labels', level({ texts: many(61) }));
    gate('the label cap is enforced (60)', over.status !== 200 && /too many texts/i.test(over.error || ''),
      JSON.stringify(over.error));
    const at = await post('verify: 60 labels', level({ texts: many(60) }));
    gate('…and 60 exactly still publishes', at.status === 200, JSON.stringify(at.error));

    const backOk = await post('verify: labels in the scenery',
      level({ backLevel: { terrain: [], props: [], fixedParts: [], texts: [lbl({ text: 'FAR' })] } }));
    gate('a label in the scenery layer publishes', backOk.status === 200, JSON.stringify(backOk.error));
    const backOver = await post('verify: 31 scenery labels',
      level({ backLevel: { terrain: [], props: [], fixedParts: [], texts: many(31) } }));
    gate('…and the layer has HALF the cap (30), spoken as the background\'s',
      backOver.status !== 200 && /background level \(max 30\)/i.test(backOver.error || ''),
      JSON.stringify(backOver.error));
    const backBad = await post('verify: bad scenery label',
      level({ backLevel: { terrain: [], props: [], fixedParts: [], texts: [lbl({ font: 'nope' })] } }));
    gate('…and a bad one back there is named as a BACKGROUND label',
      backBad.status !== 200 && /background label/i.test(backBad.error || ''),
      JSON.stringify(backBad.error));
  }

  // ---------- gate 9f: the SOURCE WORLD on the wire (2026-08-22) ----------
  //
  // An imported level carries `fcWorld` — FC's own XML and the two manifests
  // that map its blocks onto this level's piles — and it is what makes the
  // level replay bit-exactly through fcsim's C loader. The Maker's save used
  // to drop it, so until now the only sender was a local publish script and
  // the server had never read it. It ships on every save of an imported level
  // now, and the string ends up in every viewer's wasm XML parser, so it is
  // bounded here like everything else on the payload. Both directions, per the
  // house rule: a real one publishes, each malformed one is refused BY NAME.
  {
    const world = {
      dx: 0, dy: 0, print: 'w:0,0',
      xml: '<?xml version="1.0"?><retrieveLevel></retrieveLevel>',
      players: [{ t: 6, goal: false }], levels: [{ dynamic: false }],
    };
    const ok = await post('9f: a level carrying its source world', level({ fcWorld: world }));
    gate('9f. an imported level publishes WITH its source world', ok.status === 200, JSON.stringify(ok.error));
    // …and it comes back, which is the whole point — this is the field whose
    // silent loss made an FC level fall apart the first time it was saved. The
    // round trip is asserted for the same reason gate 10b asserts pins': a key
    // the validator accepts and the store drops publishes cleanly and comes
    // back a different level.
    let back = null;
    if (ok.id) {
      const rec = await fetch(`http://127.0.0.1:${port}/api/levels/${ok.id}`, {
        headers: { authorization: 'Bearer ' + TOKEN },
      }).then((r) => r.json());
      back = rec?.data?.fcWorld || null;
    }
    gate('9f. …and the store hands it back unchanged',
      !!back && back.xml === world.xml && back.players.length === 1 && back.levels.length === 1 && back.print === world.print,
      back ? `xml ${back.xml.length} chars, ${back.players.length} player / ${back.levels.length} level blocks` : 'not returned');
    const noXml = await post('9f: no xml', level({ fcWorld: { ...world, xml: '' } }));
    gate('9f. …an empty XML is refused', noXml.status === 400 && /source XML/.test(noXml.error || ''), JSON.stringify(noXml.error));
    const huge = await post('9f: 1 MB + 1 of XML', level({ fcWorld: { ...world, xml: 'x'.repeat(1024 * 1024 + 1) } }));
    gate('9f. …and one past 1 MB, by name', huge.status === 400 && /fcWorld XML too large/.test(huge.error || ''), JSON.stringify(huge.error));
    const badShift = await post('9f: absurd dx', level({ fcWorld: { ...world, dx: 1.5e6 } }));
    gate('9f. …a shift past the coordinate bound is refused', badShift.status === 400 && /fcWorld dx/.test(badShift.error || ''), JSON.stringify(badShift.error));
    // `t` is the block type the sim switches on — an unknown one is a rec on
    // no body, which is the exact failure the manifests exist to prevent.
    const badT = await post('9f: unknown block type', level({ fcWorld: { ...world, players: [{ t: 99, goal: false }] } }));
    gate('9f. …and a block type fcsim has not got', badT.status === 400 && /player block/.test(badT.error || ''), JSON.stringify(badT.error));
    const badLvl = await post('9f: level manifest of the wrong shape', level({ fcWorld: { ...world, levels: [{}] } }));
    gate('9f. …the level manifest is read the same way', badLvl.status === 400 && /level block/.test(badLvl.error || ''), JSON.stringify(badLvl.error));
    const notArr = await post('9f: manifest that is not a list', level({ fcWorld: { ...world, players: 'lots' } }));
    gate('9f. …and a manifest that is not a list at all', notArr.status === 400 && /player manifest/.test(notArr.error || ''), JSON.stringify(notArr.error));
  }

  // ---------- gate 10: wire bounds (§14, sizes.js) ----------
  //
  // Finite was the whole of what the server asked of a magnitude, and finite
  // is not sane: 1e40 px overflows float32 inside the wasm, density multiplies
  // into mass, a NaN waypoint poisons a mover, and a machine part was counted
  // but never read. Every rule here is gated in BOTH directions — a value at
  // the edge must pass, a value past it must be refused BY NAME — because a
  // one-sided gate passes for the wrong reason (the suite's own house rule).
  {
    const ok = await post('10: corpus-scale coordinates publish', level({
      terrain: [{ type: 'box', x: 999999, y: 30, w: 1200, h: 60 }],
    }));
    gate('10. a coordinate at the bound publishes', ok.status === 200, JSON.stringify(ok.error));
    const far = await post('10: absurd x', level({
      terrain: [{ type: 'box', x: 1.5e6, y: 30, w: 1200, h: 60 }],
    }));
    gate('10. …one past it is refused, naming the piece', far.status === 400 && /terrain piece 1.*±1000000/.test(far.error || ''), JSON.stringify(far.error));
    const wide = await post('10: absurd w', level({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1.5e6, h: 60 }],
    }));
    gate('10. …and an absurd size the same way', wide.status === 400 && /terrain piece 1/.test(wide.error || ''), JSON.stringify(wide.error));
  }
  {
    const top = await post('10: density at the ceiling', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, density: 1000 }],
    }));
    gate('10. density 1000 (the dial\'s own ceiling) publishes', top.status === 200, JSON.stringify(top.error));
    const over = await post('10: density past it', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, density: 1001 }],
    }));
    gate('10. …1001 is refused with the range', over.status === 400 && /density must be between 0.01 and 1000/.test(over.error || ''), JSON.stringify(over.error));
    const wisp = await post('10: density under the floor', level({
      goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15, density: 0.001 }],
    }));
    gate('10. …and 0.001 on a GOAL piece too', wisp.status === 400 && /goal piece 1.*density/.test(wisp.error || ''), JSON.stringify(wisp.error));
  }
  {
    // A prop's own gravity (§5.10) — the same three questions density gets,
    // plus one density never has to answer: it is the only dial in the schema
    // that belongs to ONE kind of piece, so "which piece is this" is part of
    // being valid. A goal piece is the run's cargo and terrain is static, so
    // `gravity` on either is a misunderstanding, and quietly ignoring it would
    // hand back a level that plays nothing like the JSON that was posted.
    const up = await post('10: a floating prop', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, gravity: -2 }],
    }));
    gate('10. a prop with gravity −2 (the dial\'s floor) publishes', up.status === 200, JSON.stringify(up.error));
    const heavy = await post('10: a heavy-falling prop', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, gravity: 2 }],
    }));
    gate('10. …and 2, its ceiling', heavy.status === 200, JSON.stringify(heavy.error));
    const rocket = await post('10: past the floor', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, gravity: -2.5 }],
    }));
    gate('10. …−2.5 is refused with the range',
      rocket.status === 400 && /gravity must be between -2 and 2/.test(rocket.error || ''), JSON.stringify(rocket.error));
    const anvil = await post('10: past the ceiling', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, gravity: 3 }],
    }));
    gate('10. …and 3 the same way',
      anvil.status === 400 && /prop 1: gravity must be between/.test(anvil.error || ''), JSON.stringify(anvil.error));
    // JSON has no NaN — it arrives as null, and "absent, use 1" is exactly the
    // silent reading this family of checks refuses
    const nulled = await post('10: gravity null', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, gravity: null }],
    }));
    gate('10. …a null gravity is refused rather than read as "absent"',
      nulled.status === 400 && /gravity must be a number/.test(nulled.error || ''), JSON.stringify(nulled.error));
    // **A GOAL PIECE may have one too, since 2026-08-14.** This gate used to
    // assert the opposite — it is the server half of the decision described in
    // gravity.js, and it is here rather than deleted because "the cargo may
    // float" is now a promise the validator has to keep.
    const cargo = await post('10: gravity on a goal piece', level({
      goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15, gravity: -1 }],
    }));
    gate('10. …and a GOAL PIECE may have one — the cargo is allowed to float',
      cargo.status === 200, JSON.stringify(cargo.error || 'published'));
    const cargoBad = await post('10: goal piece past the range', level({
      goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15, gravity: -9 }],
    }));
    gate('10. …on the same range as a prop, refused past its end',
      cargoBad.status === 400 && /goal piece 1: gravity must be between -2 and 2/.test(cargoBad.error || ''), JSON.stringify(cargoBad.error));
    const ground = await post('10: gravity on terrain', level({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60, gravity: -1 }],
    }));
    gate('10. …but not a terrain piece, which never falls at all',
      ground.status === 400 && /terrain piece 1: only a prop or goal piece can have its own 'gravity'/.test(ground.error || ''), JSON.stringify(ground.error));
  }
  {
    // **Two texture vocabularies** (2026-08-12). Props got sixteen of their own
    // and they are deliberately a different set from terrain's, so `texture` is
    // validated per KIND. Both crossings are mistakes, and both used to be one
    // wave-through from a piece that quietly draws its fallback — which reads
    // as the editor having lost the setting rather than as bad input.
    const ok = await post('10: a textured prop', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, texture: 'hazard' }],
    }));
    gate('10. a prop with one of its own sixteen textures publishes', ok.status === 200, JSON.stringify(ok.error));
    const crossed = await post('10: a terrain texture on a prop', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, texture: 'granite' }],
    }));
    gate('10. …but a TERRAIN texture on a prop is refused',
      crossed.status === 400 && /prop 1: unknown prop texture 'granite'/.test(crossed.error || ''), JSON.stringify(crossed.error));
    const other = await post('10: a prop texture on terrain', level({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60, texture: 'hazard' }],
    }));
    gate('10. …and a PROP texture on terrain is refused the same way',
      other.status === 400 && /terrain piece 1: unknown texture 'hazard'/.test(other.error || ''), JSON.stringify(other.error));
    const made = await post('10: an invented texture', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, texture: 'tartan' }],
    }));
    gate('10. …and a name from neither set is refused rather than drawn as plain',
      made.status === 400 && /unknown prop texture 'tartan'/.test(made.error || ''), JSON.stringify(made.error));
  }
  {
    // The gap this gate exists for: terrain and group paths were checked for
    // LENGTH alone, so a NaN-shaped waypoint or speed sailed through and
    // reached b2Body_SetTargetTransform as NaN.
    const moving = await post('10: a mover at corpus speed', level({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60, path: { pts: [{ x: 0, y: 30 }, { x: 200, y: 30 }], speed: 246 } }],
    }));
    gate('10. a real mover publishes', moving.status === 200, JSON.stringify(moving.error));
    const badPt = await post('10: waypoint that is not a number', level({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60, path: { pts: [{ x: 0, y: 30 }, { x: 'far', y: 30 }] } }],
    }));
    gate('10. a non-numeric TERRAIN waypoint is refused (was accepted)', badPt.status === 400 && /terrain piece 1.*waypoint/.test(badPt.error || ''), JSON.stringify(badPt.error));
    const badSpeed = await post('10: path speed that is not a number', level({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60, path: { pts: [{ x: 0, y: 30 }, { x: 200, y: 30 }], speed: 'fast' } }],
    }));
    gate('10. …and a non-numeric speed', badSpeed.status === 400 && /terrain piece 1.*speed/.test(badSpeed.error || ''), JSON.stringify(badSpeed.error));
    const badGroup = await post('10: group path waypoint', level({
      groups: { g1: { path: { pts: [{ x: 0, y: 0 }, { x: null, y: 5 }] } } },
    }));
    gate('10. …and a GROUP path gets the same read', badGroup.status === 400 && /group g1.*waypoint/.test(badGroup.error || ''), JSON.stringify(badGroup.error));
  }
  {
    const flat = await post('10: zero-width zone', level({
      buildZones: [{ x: -300, y: -75, w: 0, h: 150 }],
    }));
    gate('10. a zero-width build zone is refused (every containment test reads it as empty)', flat.status === 400 && /bad build zone/.test(flat.error || ''), JSON.stringify(flat.error));
    const negative = await post('10: negative-height goal zone', level({
      goalZones: [{ x: 300, y: -52, w: 130, h: -104 }],
    }));
    gate('10. …and a negative-height goal zone', negative.status === 400 && /bad goal zone/.test(negative.error || ''), JSON.stringify(negative.error));
  }
  {
    // Machine parts were counted (1000) and never read — {t:'wheel'} with no
    // radius is NaN/PPM into b2Circle for everyone who opens the level.
    const legal = await post('10: real fixed parts', level({
      fixedParts: [
        { t: 'wheel', kind: 'free', x: 0, y: -60, r: 15 },
        { t: 'rod', kind: 'wood', x1: 0, y1: -60, x2: 40, y2: -60, weight: 1000 },
      ],
    }));
    gate('10. a legal wheel and rod publish (weight 1000 included)', legal.status === 200, JSON.stringify(legal.error));
    const noR = await post('10: wheel with no radius', level({
      fixedParts: [{ t: 'wheel', kind: 'free', x: 0, y: -60 }],
    }));
    gate('10. a wheel with NO RADIUS is refused (was accepted — NaN for every viewer)', noR.status === 400 && /fixed part 1.*r must be/.test(noR.error || ''), JSON.stringify(noR.error));
    const oddKind = await post('10: unknown wheel kind', level({
      fixedParts: [{ t: 'wheel', kind: 'banana', x: 0, y: -60, r: 15 }],
    }));
    gate('10. …an unknown kind too (it would DRIVE — kind !== \'free\' means powered)', oddKind.status === 400 && /fixed part 1.*kind/.test(oddKind.error || ''), JSON.stringify(oddKind.error));
    const farRod = await post('10: rod endpoint past the bound', level({
      fixedParts: [{ t: 'rod', kind: 'wood', x1: 0, y1: -60, x2: 1e300, y2: -60 }],
    }));
    gate('10. …and a rod endpoint at 1e300', farRod.status === 400 && /fixed part 1.*x2/.test(farRod.error || ''), JSON.stringify(farRod.error));
    const backBad = await post('10: background fixed part', level({
      backLevel: { fixedParts: [{ t: 'wheel', kind: 'free', x: 0, y: 0 }] },
    }));
    gate('10. …and the scenery layer\'s parts, named as the background\'s', backBad.status === 400 && /background fixed part 1/.test(backBad.error || ''), JSON.stringify(backBad.error));
  }
  {
    // The replay door gets the same validator — a solve's design is the same
    // parts, stored raw and re-simulated by every viewer.
    const host = await post('10: a level to solve', level());
    gate('10. (fixture) a host level for the replay gates publishes', host.status === 200, JSON.stringify(host.error));
    const solve = (design) => fetch(`http://127.0.0.1:${port}/api/levels/${host.id}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ won: true, time: 5, pieces: 1, design }),
    }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
    const goodRun = await solve([{ t: 'rod', kind: 'wood', x1: 0, y1: -60, x2: 40, y2: -60 }]);
    gate('10. a real replay saves', goodRun.status === 200, JSON.stringify(goodRun.error));
    const nanRun = await solve([{ t: 'wheel', kind: 'free', x: 0, y: -60 }]);
    gate('10. a replay carrying a radiusless wheel is refused (was accepted)', nanRun.status === 400 && /replay part 1/.test(nanRun.error || ''), JSON.stringify(nanRun.error));
  }
  {
    const farLabel = await post('10: label past the bound', level({
      texts: [{ text: 'hello', x: 1.5e6, y: 0 }],
    }));
    gate('10. a label at 1.5e6 is refused (setTransform IGNORES non-finite — it draws at the wrong place, not offscreen)', farLabel.status === 400 && /label 1/.test(farLabel.error || ''), JSON.stringify(farLabel.error));
    const farPin = await post('10: prop pin past the bound', level({
      props: [{ shape: 'box', x: 0, y: -40, w: 30, h: 30, pins: [{ x: 2e6, y: 0 }] }],
    }));
    gate('10. …and a prop pin (it becomes a real joint)', farPin.status === 400 && /bad prop pin/.test(farPin.error || ''), JSON.stringify(farPin.error));
  }

  // ---------- gate 10b: the level's own LOOSE pins (2026-08-08) ----------
  //
  // A pin on nothing, bolted to the world. Same door, same hazards, and one of
  // its own: this list is new, so the round trip has to be asserted as well as
  // the refusals — a key the validator accepts and the store drops is a level
  // that publishes cleanly and comes back missing its hinges.
  {
    const okPins = await post('10b: loose pins', level({ pins: [{ x: 0, y: -200 }, { x: 90, y: -200 }] }));
    gate('10b. a level with loose pins publishes', okPins.status === 200, JSON.stringify(okPins.error));
    if (okPins.id) {
      const back = await fetch(`http://127.0.0.1:${port}/api/levels/${okPins.id}`, {
        headers: { authorization: 'Bearer ' + TOKEN },
      }).then(r => r.json());
      gate('10b. …and they come back with it', (back?.data?.pins || []).length === 2,
        `${(back?.data?.pins || []).length} pin(s)`);
    }
    const farLoose = await post('10b: loose pin past the bound', level({ pins: [{ x: 2e6, y: 0 }] }));
    gate('10b. a loose pin at 2e6 is refused — it becomes a real joint, like every other pin',
      farLoose.status === 400 && /bad level pin/.test(farLoose.error || ''), JSON.stringify(farLoose.error));
    const nanLoose = await post('10b: loose pin with no y', level({ pins: [{ x: 0 }] }));
    gate('10b. …and one missing a coordinate', nanLoose.status === 400 && /bad level pin/.test(nanLoose.error || ''), JSON.stringify(nanLoose.error));
    const notArray = await post('10b: pins as an object', level({ pins: { x: 0, y: 0 } }));
    gate('10b. …and a `pins` that is not a list at all', notArray.status === 400, JSON.stringify(notArray.error));
    // The cap must be the editor's, or a level the editor let you build is a
    // level the server refuses — the worst possible time to hear about it.
    const tooMany = await post('10b: 65 loose pins',
      level({ pins: Array.from({ length: MAX_LEVEL_PINS + 1 }, (_, i) => ({ x: i * 40, y: -200 })) }));
    gate(`10b. …and more than ${MAX_LEVEL_PINS} of them`,
      tooMany.status === 400 && /too many loose pins/.test(tooMany.error || ''), JSON.stringify(tooMany.error));
    const atCap = await post('10b: exactly at the cap',
      level({ pins: Array.from({ length: MAX_LEVEL_PINS }, (_, i) => ({ x: i * 40, y: -200 })) }));
    gate(`10b. …while exactly ${MAX_LEVEL_PINS} is allowed`, atCap.status === 200, JSON.stringify(atCap.error));
    // Half the foreground's, like every other list in the scenery layer — it
    // runs its own Simulation, so a pin back there is a real joint too.
    const backTooMany = await post('10b: 33 loose pins in the scenery', level({
      backLevel: { terrain: [{ type: 'box', x: 0, y: 0, w: 60, h: 60 }], pins: Array.from({ length: BACK_LEVEL_PINS + 1 }, (_, i) => ({ x: i * 40, y: -200 })) },
    }));
    gate(`10b. the scenery layer caps its own at ${BACK_LEVEL_PINS}`,
      backTooMany.status === 400 && /too many pins in the background level/.test(backTooMany.error || ''),
      JSON.stringify(backTooMany.error));
    const backFar = await post('10b: scenery loose pin past the bound', level({
      backLevel: { terrain: [{ type: 'box', x: 0, y: 0, w: 60, h: 60 }], pins: [{ x: 2e6, y: 0 }] },
    }));
    gate('10b. …and reads their coordinates, which the count alone never would',
      backFar.status === 400 && /bad background level pin/.test(backFar.error || ''), JSON.stringify(backFar.error));
  }

  // ---------- gate 10c: an escaped solve keeps NO badges (2026-08-09) ----------
  //
  // Reported as "machines outside the final build area are getting badges. They
  // should get NONE."  Badges are derived and never stored (§11.4), so every
  // listing recomputes them from the solve RECORD — and the record dropped
  // `escaped` on the way in, because the solve writer is a whitelist. The
  // client had been sending it all along.
  //
  // Gated through the real round trip rather than against `computeBadges` in
  // isolation: the bug was never in the predicate, it was in the field not
  // surviving the POST, so a test that handed the flag straight to the function
  // would have passed against the broken server.
  {
    const host = await post('10c: a level to solve', level());
    const solve = (body) => fetch(`http://127.0.0.1:${port}/api/levels/${host.id}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({
        won: true, time: 5, pieces: 1, wheels: 0, poweredWheels: 0, wood: 0, water: 0,
        untampered: true, maxPinWeight: 0, visibility: 'public',
        design: [{ t: 'rod', kind: 'wood', x1: 0, y1: -60, x2: 40, y2: -60 }],
        ...body,
      }),
    }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
    const clean = await solve({});
    const escaped = await solve({ escaped: true });
    gate('10c. (fixture) both runs save', clean.status === 200 && escaped.status === 200,
      `${clean.status} / ${escaped.status}`);
    const listed = await fetch(`http://127.0.0.1:${port}/api/levels/${host.id}`, {
      headers: { authorization: 'Bearer ' + TOKEN },
    }).then(r => r.json());
    const row = (id) => (listed.solveList || []).find(s => s.id === id);
    gate('10c. the flag survives the POST — the record keeps it',
      row(escaped.id)?.escaped === true && row(clean.id)?.escaped === false,
      `escaped ${row(escaped.id)?.escaped}, clean ${row(clean.id)?.escaped}`);
    // …which is the whole point: the listings recompute from these fields.
    const badgesOf = (s) => (s ? computeBadgesLocal(s) : null);
    gate('10c. an escaped solve recomputes to NO badges, not even `solved`',
      badgesOf(row(escaped.id))?.length === 0, JSON.stringify(badgesOf(row(escaped.id))));
    gate('10c. …while the identical clean run keeps its own',
      (badgesOf(row(clean.id)) || []).includes('solved'), JSON.stringify(badgesOf(row(clean.id))));
  }

  // ---------- gate 11: the anonymous list cache serves fresh data ----------
  //
  // The cache is only allowed to exist because a publish invalidates it the
  // same instant (listGen bumps on every level dirty mark) — a Workshop that
  // shows a stale list for even a second after "Publish" reads as a lost
  // level. Miss, then hit, then a publish, then the NEW level in the answer.
  {
    const anonList = async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/levels`);
      return { cache: r.headers.get('x-list-cache'), body: await r.json() };
    };
    const first = await anonList();
    const second = await anonList();
    gate('11. an anonymous list is a miss then a hit', first.cache === 'miss' && second.cache === 'hit',
      `${first.cache} then ${second.cache}`);
    const fresh = await post('11: cache invalidation fixture', level());
    const third = await anonList();
    gate('11. …and a publish invalidates it the same instant',
      third.cache === 'miss' && third.body.some(l => l.id === fresh.id),
      `${third.cache}, new level ${third.body.some(l => l.id === fresh.id) ? 'present' : 'MISSING'}`);
    const signed = await fetch(`http://127.0.0.1:${port}/api/levels`, { headers: { authorization: 'Bearer ' + TOKEN } });
    await signed.json();
    gate('11. …while a signed-in viewer bypasses the cache entirely', signed.headers.get('x-list-cache') == null,
      `header ${signed.headers.get('x-list-cache')}`);
  }

  // ---------- gate 12: publishing freezes the physics (§5.8) ----------
  //
  // A published piece must carry its RESOLVED surface — all four dials, as
  // numbers — so a later retune of TEXTURE_SURFACE cannot reach back into a
  // level people have recorded times on. Three directions: a texture's
  // defaults bake in, an explicit override survives the bake, and the baked
  // numbers are the table's numbers TODAY (read from surfaces.js, not
  // restated, because "frozen at whatever ice was" is the whole claim).
  {
    const { TEXTURE_SURFACE } = await import(u('public/js/surfaces.js'));
    const iced = await post('12: an icy ledge freezes', level({
      terrain: [
        { type: 'box', x: 0, y: 30, w: 1200, h: 60, texture: 'ice' },
        { type: 'box', x: 0, y: 200, w: 400, h: 40, texture: 'ice', surface: { friction: 1.5 } },
      ],
    }));
    gate('12. (fixture) the icy level publishes', iced.status === 200, JSON.stringify(iced.error));
    const back = await fetch(`http://127.0.0.1:${port}/api/levels/${iced.id}`).then(r => r.json());
    const [plain, tuned] = back.data.terrain;
    const want = TEXTURE_SURFACE.ice;
    gate('12. an untouched ice piece bakes ice\'s live dials',
      plain.surface && plain.surface.friction === want.friction
      && plain.surface.restitution === want.restitution
      && plain.surface.tangentSpeed === want.tangentSpeed,
      JSON.stringify(plain.surface));
    gate('12. …while a hand-tuned dial survives the bake, resolved over the texture',
      tuned.surface && tuned.surface.friction === 1.5 && tuned.surface.restitution === want.restitution,
      JSON.stringify(tuned.surface));
  }

  // ---------- gate 13: link unfurling and share cards (§11.10) ----------
  //
  // The whole feature exists because `#/play/<id>` is a FRAGMENT that never
  // reaches the server, so these gates are about the PATH twin: does it carry
  // the level's own tags, does it refuse the levels that must not be unfurled,
  // and is a posted card actually an image.
  const get = (p, tok) => fetch(`http://127.0.0.1:${port}${p}`,
    tok ? { headers: { authorization: 'Bearer ' + tok } } : undefined);
  {
    const pub = await post('13: a level to share', level({}, ));
    gate('13. (fixture) a shareable level publishes', pub.status === 200, JSON.stringify(pub.error));
    const html = await (await get(`/play/${pub.id}`)).text();
    gate('13. the path URL carries the level\'s own og:title',
      html.includes(`<meta property="og:title" content="13: a level to share — LIFIRIK">`), html.slice(0, 200));
    // **The app itself, not a bounce page.** This route used to serve a stub
    // that redirected to `#/play/<id>`; with the hash gone (§12) `/play/<id>`
    // IS the level's URL, so it must serve the real shell — the same HTML
    // every other screen gets — with the tags added to its head. A crawler
    // reads the tags; a person gets the app already at the right screen.
    gate('13. …and serves the REAL app shell, with no redirect in the way',
      html.includes('id="app"') && html.includes("import { boot } from '/js/main.js'")
      && !html.includes('location.replace'),
      html.includes('location.replace') ? 'still bouncing' : 'shell + tags');
    gate('13. …and every other app route is served too, so a refresh survives',
      (await get('/')).status === 200 && (await get('/browse')).status === 200
      && (await get('/user/nobody')).status === 200,
      'deep links answer');
    gate('13. …while an unknown path is still a real 404',
      (await get('/nonsense')).status === 404, 'a typo is not the home page');
  }
  {
    // The one that would silently break a feature: a sealed race withholds its
    // name and preview until it opens (§11.8), so a pasted link must not show
    // the level early — that is what the countdown is FOR.
    // PRIVATE first — the race route refuses to seal anything else, which is
    // what the first run of this gate found out (the fixture published a
    // public level, got "Save the level as Private first", and the leak test
    // below was then measuring an ordinary level that is SUPPOSED to show its
    // name). A fixture that fails to build the state under test is a gate that
    // proves nothing.
    const sealed = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ name: '13: sealed race fixture', data: level(), visibility: 'private' }),
    }).then(r => r.json());
    const raceAt = Date.now() + 3600_000;
    const made = await fetch(`http://127.0.0.1:${port}/api/levels/${sealed.id}/race`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ revealAt: raceAt, prize: 1 }),
    }).then(r => r.json());
    const html = await (await get(`/play/${sealed.id}`)).text();
    gate('13. (fixture) the race was actually sealed', !made.error && !made.openedAt, JSON.stringify(made.error || made));

    // **The rule sharpened on 2026-08-04, and it is worth saying why.** This
    // used to assert that a sealed race leaked NOTHING, name included. But a
    // sealed race is an announcement: its name is already in the Workshop list
    // payload and the search matches sealed races on their name alone, so
    // withholding it in an unfurl protected nothing and made the one card
    // people most want to paste — "there's a race on Friday" — paste as the
    // bare site. So: name, challenger, clock and stake YES; anything that
    // would let somebody see or rebuild the level early, NO.
    gate('13. a sealed race unfurls as the CHALLENGE — who, when, what is staked',
      html.includes('a timed challenge') && html.includes('13: sealed race fixture')
      && /Opens \d+ \w+, \d\d:\d\d UTC/.test(html) && html.includes('🏅1 point'),
      (html.match(/og:description[^\n]*/) || [])[0] || 'no description');
    gate('13. …with an ABSOLUTE time, because an unfurl is cached for hours',
      !/opens in|in \d+ (day|hour|minute)/i.test(html), 'no relative countdown to go stale');
    gate('13. …and still no picture of the level, which is the point of the seal',
      !html.includes('og:image'), 'no og:image tag');
    gate('13. …and not one word of the level\'s own description',
      !html.includes('A synthetic level') && !html.includes(' — LIFIRIK">'),
      'teaser only, no level blurb');
  }
  {
    // A live Beat Me bar on an OPEN level: the terms are the description, and
    // the level's own card is allowed as the image because the level is public.
    const host = await post('13: beat-me host', level());
    const run = await fetch(`http://127.0.0.1:${port}/api/levels/${host.id}/solve`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ won: true, time: 5.25, pieces: 9, kg: 3.5, visibility: 'private',
        design: [{ t: 'rod', kind: 'wood', x1: 0, y1: -60, x2: 40, y2: -60 }] }),
    }).then(r => r.json());
    // `days`/`hours`, not an absolute endsAt — the route computes the window
    // itself, and the first run of this gate posted a timestamp and got
    // "between 15 minutes and 30 days" for a perfectly ordinary 7-day bar
    const bar = await fetch(`http://127.0.0.1:${port}/api/levels/${host.id}/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ solveId: run.id, days: 7, prize: 5,
        bars: { time: 5.25, pieces: 9 }, message: 'good luck' }),
    }).then(r => r.json());
    gate('13. (fixture) a live bar was posted', !bar.error && bar.id, JSON.stringify(bar.error || bar.id));
    const html = await (await get(`/play/${host.id}`)).text();
    gate('13. a live Beat Me pastes as the CHALLENGE, not the level',
      /og:title" content="⚔ Beat /.test(html), (html.match(/og:title[^\n]*/) || [])[0]);
    gate('13. …carrying the bars, the stake, the deadline and the challenger\'s words',
      html.includes('≤ 5.3s') && html.includes('≤ 9 pcs') && html.includes('🏅5 points')
      && /ends \d+ \w+, \d\d:\d\d UTC/.test(html) && html.includes('good luck'),
      (html.match(/og:description[^\n]*/) || [])[0]);
  }
  {
    const priv = await post('13: private fixture', level());
    await fetch(`http://127.0.0.1:${port}/api/levels/${priv.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ visibility: 'private', listed: false }),
    }).then(r => r.json());
    // `private` is set through the publish route's visibility, so re-post one
    const priv2 = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ name: '13: truly private', data: level(), visibility: 'private' }),
    }).then(r => r.json());
    const html = await (await get(`/play/${priv2.id}`)).text();
    gate('13. a PRIVATE level does not leak its name either',
      !html.includes('13: truly private'), html.slice(0, 300));
  }
  {
    // A card is bytes that come back out under an image content type, so the
    // magic bytes decide, never the declared mime.
    const jpeg = 'data:image/jpeg;base64,' + Buffer.from(
      Uint8Array.from([0xFF, 0xD8, 0xFF, ...new Array(400).fill(0x20)])).toString('base64');
    const notJpeg = 'data:image/jpeg;base64,' + Buffer.from(
      Uint8Array.from([0x3C, 0x73, 0x76, 0x67, ...new Array(400).fill(0x20)])).toString('base64');
    const withCard = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ name: '13: carries a card', data: level(), card: jpeg }),
    }).then(r => r.json());
    const img = await get(`/og/L${withCard.id}.jpg`);
    gate('13. a posted JPEG comes back as image/jpeg',
      img.status === 200 && img.headers.get('content-type') === 'image/jpeg',
      `${img.status} ${img.headers.get('content-type')}`);
    gate('13. …and the level now advertises it',
      (await (await get(`/play/${withCard.id}`)).text()).includes('og:image'), 'og:image present');
    const liar = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ name: '13: card that lies', data: level(), card: notJpeg }),
    }).then(r => r.json());
    gate('13. a NON-JPEG claiming image/jpeg is refused, and the level still publishes',
      liar.id && (await get(`/og/L${liar.id}.jpg`)).status === 404, 'stored nothing');

    // A card outlives nothing. Deleting the level must take its image with it,
    // or the store grows a hundred kilobytes of orphan per deleted level and
    // the picture stays fetchable at a guessable URL after its level is gone.
    await fetch(`http://127.0.0.1:${port}/api/levels/${withCard.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ listed: false }),
    }).then(r => r.json());
    const del = await fetch(`http://127.0.0.1:${port}/api/levels/${withCard.id}`, {
      method: 'DELETE', headers: { authorization: 'Bearer ' + TOKEN },
    }).then(r => r.json());
    gate('13. …and deleting the level takes its card with it',
      del.ok === true && (await get(`/og/L${withCard.id}.jpg`)).status === 404,
      JSON.stringify(del.error || 'gone'));
  }
  {
    // A name is author-typed and lands inside markup — the one injection door
    // this feature opens.
    const nasty = await fetch(`http://127.0.0.1:${port}/api/levels`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ name: '"><script>alert(1)</script>', data: level() }),
    }).then(r => r.json());
    const html = await (await get(`/play/${nasty.id}`)).text();
    gate('13. a level name cannot break out of the meta tag',
      !html.includes('<script>alert(1)') && html.includes('&lt;script&gt;'),
      html.match(/og:title[^\n]*/)?.[0] || 'no title');
  }

  // The shipped campaign, unmodified: the new rule is not allowed to have
  // an opinion about content that is already published and playable.
  const campaign = JSON.parse(fs.readFileSync(path.join(root, 'scripts/campaign-seed.json'), 'utf8'));
  let seedBad = null;
  for (const [i, seed] of campaign.levels.entries()) {
    const r = await post(`verify: seed ${i}`, seed.data);
    if (r.status !== 200) { seedBad = `slot ${i} "${seed.name}": ${r.error}`; break; }
  }
  gate('shipped officials still validate', !seedBad, seedBad || `${campaign.levels.length} levels`);

} catch (e) {
  fail++;
  console.log('FAIL  harness: ' + e.message);
} finally {
  cleanup();
}

// ---------- gate 9: the scenery layer's two dials (§10.5) ----------
//
// The sliders that set these live in a DOM menu, which no suite can reach —
// so the DECISION lives in sizes.js and this is what gates it (the same move
// `weightAtNotch` and `initialSnapMode` made). Defaults restated, not imported.
{
  const DEF_SCALE = 0.8, DEF_ALPHA = 0.55;

  gate('9. shrink clamps into range', clampBackScale(40) === BACK_SCALE_MAX
    && clampBackScale(-3) === BACK_SCALE_MIN && clampBackScale(0.5) === 0.5);
  gate('9. fade clamps into range', clampBackAlpha(9) === 1
    && clampBackAlpha(-1) === 0 && clampBackAlpha(0.25) === 0.25);
  gate('9. …and rubbish reads as "not set", not as zero',
    clampBackScale('x') === null && clampBackScale(undefined) === null
    && clampBackAlpha(NaN) === null && clampBackAlpha(null) === null);

  // **The one that matters: 0 and absent are DIFFERENT answers.** An alpha of 0
  // is a deliberate invisible backdrop and has to survive a round trip, while a
  // level that never touched the dial must fall back to the shipped default. A
  // falsy test here would collapse the two and quietly make an invisible
  // backdrop impossible to author.
  gate('9. an unset dial falls back to the shipped default',
    backScaleOf({}, DEF_SCALE) === DEF_SCALE && backAlphaOf({}, DEF_ALPHA) === DEF_ALPHA);
  gate('9. …while a deliberate ZERO fade survives',
    backAlphaOf({ backAlpha: 0 }, DEF_ALPHA) === 0);
  gate('9. …and a set dial wins over the default',
    backScaleOf({ backScale: 0.4 }, DEF_SCALE) === 0.4);
  // scale may not exceed 1: at 1 the scenery sits in the play plane, and above
  // it the layer would reach the player MAGNIFIED — parallax the wrong way
  // round, and a fence computed as PLAY_BOUND/scale that grows instead of shrinks
  gate('9. shrink never exceeds 1, whatever is asked for',
    backScaleOf({ backScale: 5 }, DEF_SCALE) === 1 && BACK_SCALE_MAX === 1);
}

summary();
