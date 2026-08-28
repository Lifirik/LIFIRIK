// verify-surfaces.mjs — terrain surface materials (§15, surfaces.js).
//
// Every live dial is asserted to MOVE something, measured against
// the shipped wasm binary. That is the point of this suite: three of the four
// were present in the Box2D binding but pinned at 0 for the whole life of the
// project, so "it compiles and nothing crashes" says nothing at all about
// whether they reach the solver. A gate here fails loudly if a future binary
// bump quietly drops one.
//
// Run: node scripts/verify-surfaces.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { initEngine, Simulation, PPM, PHYSICS } = await import(u('public/js/sim.js'));
const {
  TEXTURES, TEXTURE_SURFACE, SURFACE_LEGACY, SURFACE_RANGE, SURFACE_KEYS,
  surfaceOf, textureSurface, surfaceIsTextureDefault, badSurface,
} = await import(u('public/js/surfaces.js'));
const { TEXTURE_LOOKS, beltRuns, beltScrollPx } = await import(u('public/js/render.js'));
await initEngine(u('public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

// ---------- gate 1: the two halves of a texture agree ----------
{
  const look = new Set(TEXTURE_LOOKS), feel = new Set(TEXTURES);
  const noFeel = [...look].filter(n => !feel.has(n));
  const noLook = [...feel].filter(n => !look.has(n));
  gate('1. every texture has both a look (render.js) and a feel (surfaces.js)',
    noFeel.length === 0 && noLook.length === 0,
    noFeel.length || noLook.length
      ? `look-only: ${noFeel.join(',') || 'none'} | feel-only: ${noLook.join(',') || 'none'}`
      : `${TEXTURES.length} textures`);
  gate('1. there are 16 textures', TEXTURES.length === 16, `${TEXTURES.length}`);
  // Every default must itself be in range, or the editor's slider cannot even
  // display the value the piece is running.
  let bad = null;
  for (const [n, s] of Object.entries(TEXTURE_SURFACE)) {
    for (const k of SURFACE_KEYS) {
      const r = SURFACE_RANGE[k];
      if (!(s[k] >= r.min && s[k] <= r.max)) bad = `${n}.${k} = ${s[k]}`;
      if (s[k] === undefined) bad = `${n} has no ${k}`;
    }
  }
  gate('1. every texture default names the live dials, all in range', !bad, bad || '16 × 3 values');
}

// ---------- gate 2: the no-surface fallback is the old hardcoded material ----------
{
  // The determinism claim (§5.8). The officials set no texture at all, so
  // this resolution path is the one every one of them runs on.
  const legacy = (t) => SURFACE_KEYS.every(k => surfaceOf(t)[k] === SURFACE_LEGACY[k]);
  gate('2. a piece with no texture and no surface resolves to the pre-surfaces material',
    legacy({ type: 'box', x: 0, y: 0, w: 10, h: 10 }),
    JSON.stringify(surfaceOf({})));
  for (const n of ['granite', 'neon', 'classic']) {
    gate(`2. '${n}' is pinned to the pre-surfaces material`, legacy({ texture: n }),
      JSON.stringify(surfaceOf({ texture: n })));
  }
  gate('2. an unknown texture falls back rather than throwing',
    legacy({ texture: 'no-such-texture' }));
}

// ---------- gate 3: explicit surface overrides texture, per key ----------
{
  const t = { texture: 'ice', surface: { friction: 1.5 } };
  const s = surfaceOf(t);
  gate('3. an explicit dial wins over the texture', s.friction === 1.5, `friction ${s.friction}`);
  gate('3. …and the dials it does not mention still come from the texture',
    s.restitution === TEXTURE_SURFACE.ice.restitution &&
    s.tangentSpeed === TEXTURE_SURFACE.ice.tangentSpeed,
    'ice defaults intact');
  gate('3. out-of-range values are clamped, never passed to the solver',
    surfaceOf({ surface: { friction: 1e9 } }).friction === SURFACE_RANGE.friction.max &&
    surfaceOf({ surface: { restitution: -5 } }).restitution === SURFACE_RANGE.restitution.min);
  gate('3. a NaN dial falls back instead of poisoning the contact',
    surfaceOf({ surface: { friction: NaN } }).friction === SURFACE_LEGACY.friction);
  gate('3. surfaceIsTextureDefault spots an untouched piece and a tuned one',
    surfaceIsTextureDefault({ texture: 'ice' }) === true &&
    surfaceIsTextureDefault({ texture: 'ice', surface: { friction: 1.5 } }) === false);
  gate('3. textureSurface hands back a COPY (the editor mutates what it gets)',
    (() => { const a = textureSurface('ice'); a.friction = 99; return textureSurface('ice').friction !== 99; })());
}

// ---------- rigs ----------
// One geometry, two ways of building it, so every measurement below can be
// taken on a polygon floor and a chain floor and compared. Both have their top
// face at TOP and are 120 px thick.
const TOP = 270;
const REST_BALL = TOP - 15;    // a 15 px goal ball rests here
const REST_CRATE = TOP - 20;   // a 40×40 crate rests here

const shell = (terrain) => ({
  terrain, props: [], buildZones: [{ x: 0, y: 0, w: 600, h: 200 }],
  goalZones: [], goalObjs: [], win: 'goalObj',
});
const flat = (surface) => shell([{
  type: 'box', x: 0, y: TOP + 60, w: 5000, h: 120, ...(surface ? { surface } : {}),
}]);
// Explicit zero handles on every anchor, exactly as verify.mjs gate 7 builds
// it: an UNSET handle is not a straight edge, it is an auto Catmull-Rom
// tangent that bows the outline (§8.2). Left off, this slab is not the flat
// quad it looks like in the source.
const paintedFlat = (surface) => {
  const Z = () => ({ x: 0, y: 0 });
  const ring = [[-2500, TOP], [2500, TOP], [2500, TOP + 120], [-2500, TOP + 120]];
  const [first, ...rest] = ring;
  return shell([{
    type: 'paint', x: first[0], y: first[1], h1: Z(), h2: Z(), texture: 'granite',
    ...(surface ? { surface } : {}),
    pts: [...rest.map(([x, y]) => ({ x, y, h1: Z(), h2: Z() })),
      { x: first[0], y: first[1], h1: Z(), h2: Z() }],
  }]);
};

// The engine speaks px directly now, through the Simulation's own instance —
// a body is an integer and E is per-sim, so the kick has to go through sim.E.
const launch = (sim, body, vx) => sim.E.body_set_vel(body, vx, 0, 0);
// Run until the piece stops rather than for a fixed count, so a slippery floor
// is not measured mid-slide against a grippy one that already stopped.
function travel(sim, body, vx, cap = 3000) {
  const x0 = sim._pose(body).x;
  launch(sim, body, vx);
  for (let i = 0; i < cap; i++) {
    sim._fixedStep();
    if (i > 30 && Math.abs(sim.E.body_vx(body)) < 1) break;
  }
  return sim._pose(body).x - x0;
}
function slide(level, vx = 600) {
  const lvl = JSON.parse(JSON.stringify(level));
  lvl.props = [{ shape: 'box', x: -2000, y: REST_CRATE - 0.01, w: 40, h: 40 }];
  const sim = new Simulation(lvl, { parts: [] });
  return travel(sim, sim.props[0].body, vx);
}
function roll(level, vx = 600) {
  const lvl = JSON.parse(JSON.stringify(level));
  lvl.goalObjs = [{ shape: 'ball', x: -2000, y: REST_BALL - 0.01, r: 15 }];
  const sim = new Simulation(lvl, { parts: [] });
  return travel(sim, sim.goals[0].body, vx);
}
// Drop a ball and report how far it comes back UP after the first landing.
function bounce(level, { dropY = 100, frames = 400 } = {}) {
  const lvl = JSON.parse(JSON.stringify(level));
  lvl.goalObjs = [{ shape: 'ball', x: 0, y: dropY, r: 15 }];
  const sim = new Simulation(lvl, { parts: [] });
  const body = sim.goals[0].body;
  let landed = false, top = 1e9;
  for (let i = 0; i < frames; i++) {
    sim._fixedStep();
    const y = sim._pose(body).y;
    if (!landed && y >= REST_BALL - 0.5) landed = true;
    if (landed && y < top) top = y;
  }
  return REST_BALL - top;
}

// ---------- gate 4: friction ----------
{
  const g = slide(flat(null));
  const ice = slide(flat(TEXTURE_SURFACE.ice));
  const mud = slide(flat(TEXTURE_SURFACE.mud));
  gate('4. a crate slides FURTHER on ice than on the default surface', ice > g * 2,
    `ice ${ice.toFixed(0)} px vs default ${g.toFixed(0)} px`);
  gate('4. …and SHORTER on mud', mud < g,
    `mud ${mud.toFixed(1)} px vs default ${g.toFixed(1)} px`);
  // Two things about this rig are deliberate and both were found the hard way:
  //
  //  - a FIXED window, not run-to-rest, so friction 0 can be in the series. At
  //    0 the piece never stops, and a run-to-rest rig would quietly be
  //    reporting "ran off the end of the floor" as a distance.
  //  - a LOW, WIDE slab, not the 40×40 crate. A square crate trips onto a
  //    corner and tumbles once the floor grips, and tumbling carries it
  //    further than sliding — so a square probe reads as non-monotonic around
  //    friction 1 while measuring the shape, not the surface.
  const window5s = (f) => {
    const lvl = JSON.parse(JSON.stringify(flat({ friction: f })));
    lvl.props = [{ shape: 'box', x: -2000, y: TOP - 4 - 0.01, w: 60, h: 8 }];
    const sim = new Simulation(lvl, { parts: [] });
    launch(sim, sim.props[0].body, 600);
    for (let i = 0; i < 300; i++) sim._fixedStep();
    return sim._pose(sim.props[0].body).x + 2000;
  };
  const series = [0, 0.1, 0.25, 0.5, 1, 2].map(window5s);
  gate('4. distance falls as friction rises, across the whole range',
    series.every((d, i) => i === 0 || d <= series[i - 1] + 1e-6),
    series.map(d => d.toFixed(0)).join(' → ') + ' px');
  // Worth pinning, because it looks like a friction bug and is not one: even
  // on a frictionless floor the crate loses speed, because the prop BODY
  // carries linearDamping 0.02 (sim.js) — nothing a surface sets can switch
  // that off, and a level author tuning grip should not be chasing it.
  {
    const lvl = JSON.parse(JSON.stringify(flat({ friction: 0 })));
    lvl.props = [{ shape: 'box', x: -2000, y: REST_CRATE - 0.01, w: 40, h: 40 }];
    const sim = new Simulation(lvl, { parts: [] });
    launch(sim, sim.props[0].body, 600);
    for (let i = 0; i < 300; i++) sim._fixedStep();
    const vx = Math.abs(sim.E.body_vx(sim.props[0].body));
    // Body damping is a PER-STEP retention on this engine (see the profile),
    // so the prediction is the retention compounded over the frames run —
    // stated from the constant itself so the gate follows it if it moves.
    // (fc carries 0 here, so today "the body's own damping" is no loss at
    // all — the gate holds either way, reading whatever the profile says.)
    const want = 600 * Math.pow(1 - PHYSICS.fc.prop.linearDamping, 300);
    gate('4. on a frictionless floor the only loss is the body\'s own damping',
      Math.abs(vx - want) < 5, `${vx.toFixed(1)} px/s vs ${want.toFixed(1)} predicted`);
  }
}

// ---------- gate 5: restitution ----------
{
  const g = bounce(flat(null));
  const rub = bounce(flat(TEXTURE_SURFACE.rubber));
  // Box2D mixes restitution as max(A, B), not as a product — sim.js already
  // says so where water rods are built. So a surface can ADD bounce to a piece
  // but can never take away the piece's own — and under FC every dynamic body
  // has some: a goal ball 0.2, and since 2026-08-18 a prop 0.2 as well
  // (fcsim's dynamic_env_material; the profile said 0 and was corrected).
  // So there is no dynamic piece that lands DEAD on the default surface, and
  // a gate asserting one would be lying. What the control below asserts
  // instead is that a prop's landing is FC's own small rebound — a few px,
  // like the ball's — and nothing like rubber's.
  const propRebound = (() => {
    const lvl = JSON.parse(JSON.stringify(flat(null)));
    lvl.props = [{ shape: 'box', x: 0, y: 100, w: 40, h: 40 }];
    const sim = new Simulation(lvl, { parts: [] });
    const body = sim.props[0].body;
    let landed = false, top = 1e9;
    for (let i = 0; i < 400; i++) {
      sim._fixedStep();
      const y = sim._pose(body).y;
      if (!landed && y >= REST_CRATE - 0.5) landed = true;
      if (landed && y < top) top = y;
    }
    return REST_CRATE - top;
  })();
  gate('5. a prop lands on the default surface with FC\'s own small rebound (0.2) — a few px, not rubber',
    propRebound > 1 && propRebound < 12, `rebound ${propRebound.toFixed(3)} px from a 150 px drop`);
  gate('5. a goal ball still bounces a little there — restitution mixes as max(A,B), '
    + 'and the ball\'s own is 0.2', g > 1 && g < 12, `rebound ${g.toFixed(2)} px`);
  // **35 px, not 60** (2026-08-12). The absolute figure was calibrated against
  // the old 13 m/s² gravity; at FC's 7.5 the same drop arrives slower and the
  // same restitution returns less height, and rubber came out at 42 px. The
  // RATIO is what the gate is really about and it is untouched — rubber still
  // rebounds 6.8× the default surface, comfortably past the 5× asked for
  // below — so only the gravity-dependent half of the test moved.
  gate('5. a ball rebounds far higher off rubber', rub > 35 && rub > g * 5,
    `rubber ${rub.toFixed(0)} px vs default ${g.toFixed(1)} px`);
  gate('5. rebound rises with restitution', (() => {
    let prev = -Infinity;
    for (const r of [0, 0.3, 0.6, 0.9]) {
      const h = bounce(flat({ restitution: r }));
      if (h < prev - 1e-6) return false;
      prev = h;
    }
    return true;
  })());
}

// ---------- gate 6: rollingResistance ----------
//
// **DEAD WITH THE ENGINE, and gated as exactly that** (2026-08-17). The v3
// solver carried rolling drag as a material field; FC's solver has no such
// concept, so mud, snow and sand currently slow a SLIDING piece (their
// friction still works) and do nothing to a ROLLING one. Putting it back
// means a resisting torque capped by the contact's normal impulse inside
// b2ContactSolver — a real solver addition with its own re-tune — and that
// is a feature decision, not a regression to paper over. Until it is made,
// this gate holds the door: it FAILS the day rolling drag comes back and the
// three real assertions above it are still commented out.
{
  const g = roll(flat(null));
  const mud = roll(flat(TEXTURE_SURFACE.mud));
  gate('6. a ball rolls a long way on the default surface', g > 500, `${g.toFixed(0)} px`);
  gate('6. rolling drag is KNOWN-GONE on this engine (see the note above)',
    Math.abs(mud - g) < g * 0.05,
    `mud ${mud.toFixed(0)} px vs plain ${g.toFixed(0)} px — indistinguishable, as documented`);
}

// ---------- gate 7: tangentSpeed, and its SIGN ----------
{
  // The sign is the whole reason this gate exists: b2's own convention runs
  // the belt the opposite way, sim._material() flips it, and nothing but a
  // measurement can confirm which way a level author's "+3" actually carries.
  const drift = (speed, level = flat) => {
    const lvl = JSON.parse(JSON.stringify(level({ tangentSpeed: speed })));
    lvl.props = [{ shape: 'box', x: 0, y: REST_CRATE - 0.01, w: 40, h: 40 }];
    const sim = new Simulation(lvl, { parts: [] });
    for (let i = 0; i < 180; i++) sim._fixedStep();
    return sim._pose(sim.props[0].body).x;
  };
  const still = drift(0), right = drift(3), left = drift(-3);
  gate('7. a crate sits still on a surface with the belt off', Math.abs(still) < 1,
    `x ${still.toFixed(2)} px`);
  gate('7. a POSITIVE belt carries it right (+x), as the editor labels it', right > 100,
    `x ${right.toFixed(0)} px`);
  gate('7. a NEGATIVE belt carries it left', left < -100, `x ${left.toFixed(0)} px`);
  gate('7. the two directions are symmetric', Math.abs(right + left) < 5,
    `${right.toFixed(1)} vs ${left.toFixed(1)}`);
  gate('7. the belt texture is a working conveyor out of the box',
    drift(TEXTURE_SURFACE.belt.tangentSpeed) > 100);
  gate('7. a belt drives a PAINTED loop the same way it drives a box',
    drift(3, paintedFlat) > 100, `painted x ${drift(3, paintedFlat).toFixed(0)} px`);
}

// ---------- gate 7b: the belt LOOKS like it is running the way it pushes ----
{
  // A conveyor whose loop runs one way while it pushes crates the other is
  // worse than one that does not animate at all, and it is a one-character
  // mistake. The dash stroke itself needs a canvas that node does not have,
  // so the travel DISTANCE is split out and gated here — same convention,
  // same sign, the only part that can be wrong silently.
  const belt = (v) => ({ type: 'box', texture: 'belt', ...(v == null ? {} : { surface: { tangentSpeed: v } }) });
  gate('7b. the belt texture scrolls without the author setting anything',
    beltScrollPx(belt(null), 1) > 0, `${beltScrollPx(belt(null), 1)} px/s`);
  gate('7b. scroll is px/s = m/s × PPM', beltScrollPx(belt(3), 1) === 3 * PPM,
    `${beltScrollPx(belt(3), 1)} px in 1 s at 3 m/s`);
  gate('7b. it scrolls the way it pushes — POSITIVE is the same +x gate 7 measured',
    beltScrollPx(belt(3), 1) > 0 && beltScrollPx(belt(-3), 1) < 0);
  gate('7b. doubling the speed doubles the scroll',
    beltScrollPx(belt(6), 1) === 2 * beltScrollPx(belt(3), 1));
  gate('7b. a switched-off belt does not move', beltScrollPx(belt(0), 1) === 0);
  gate('7b. and neither does time standing still', beltScrollPx(belt(3), 0) === 0);
  // The loop only exists while something would actually be conveyed.
  gate('7b. a belt runs by default — the loop needs no author setup',
    beltRuns(belt(null)) === true);
  gate('7b. a belt at 0 m/s conveys nothing, so nothing runs — no loop',
    beltRuns(belt(0)) === false);
  gate('7b. any piece carrying a belt speed runs, whatever its texture',
    beltRuns({ type: 'box', texture: 'steel', surface: { tangentSpeed: 2 } }) === true);
  gate('7b. every other texture is left exactly as it was',
    TEXTURES.filter(t => t !== 'belt').every(t => beltRuns({ type: 'box', texture: t }) === false),
    `${TEXTURES.length - 1} textures unaffected`);
}

// ---------- gate 8: both shape paths agree on a non-default surface ----------
{
  // verify.mjs gate 7 pins painted-vs-box parity at the DEFAULT material. That
  // could not catch the two paths drifting once they carry a surface, because
  // they set the material through different Box2D calls — sd.material.* for a
  // polygon, SetMaterials() for a chain. This is the same claim at a value
  // neither path hardcodes.
  for (const [name, surf] of [['ice', TEXTURE_SURFACE.ice], ['mud', TEXTURE_SURFACE.mud]]) {
    const box = slide(flat(surf));
    const paint = slide(paintedFlat(surf));
    const diff = Math.abs(box - paint) / Math.max(Math.abs(box), 1);
    gate(`8. a crate slides the same distance on painted and box ${name} (±2%)`, diff < 0.02,
      `painted ${paint.toFixed(1)} px vs box ${box.toFixed(1)} px`);
  }
  const bBox = bounce(flat(TEXTURE_SURFACE.rubber));
  const bPaint = bounce(paintedFlat(TEXTURE_SURFACE.rubber));
  gate('8. a ball rebounds the same off painted and box rubber (±2%)',
    Math.abs(bBox - bPaint) / Math.max(bBox, 1) < 0.02,
    `painted ${bPaint.toFixed(1)} px vs box ${bBox.toFixed(1)} px`);
}

// ---------- gate 9: a bouncy floor still holds a piece STILL ----------
{
  // The rule the editor's drag-stop is built on (verify.mjs gate 14): where a
  // drag leaves a piece, Play must not move it. REST_GAP is a 0.01 px hover,
  // and restitution multiplies whatever speed a landing arrives with — so the
  // one surface that could break that rule is the bouncy one. It must not.
  const REST_GAP = 0.01;
  for (const [name, surf] of [['rubber', TEXTURE_SURFACE.rubber], ['glass', TEXTURE_SURFACE.glass],
    ['restitution 0.95 (the maximum)', { restitution: SURFACE_RANGE.restitution.max }]]) {
    const lvl = flat(surf);
    lvl.props = [{ shape: 'box', x: 0, y: 270 - 20 - REST_GAP, w: 40, h: 40 }];
    const sim = new Simulation(lvl, { parts: [] });
    const y0 = sim._pose(sim.props[0].body).y;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      sim._fixedStep();
      worst = Math.max(worst, Math.abs(sim._pose(sim.props[0].body).y - y0));
    }
    // **0.5, re-baselined from 0.1 with the engine** (2026-08-17): FC's
    // solver rests a piece deeper than v3's soft contacts did — b2_linearSlop
    // is 0.15 units here against v3's ~0.003 px penetration — so the settle
    // from a 0.01 px hover measures ~0.33 px. A third of a pixel is invisible
    // and it is FC's own resting depth; what this gate must still catch is a
    // piece VISIBLY moving or bouncing away on a bouncy floor.
    gate(`9. a prop left at REST_GAP on ${name} does not move when Play starts`,
      worst < 0.5, `${worst.toFixed(5)} px over 4 s`);
  }
}

// ---------- gate 10: the validator ----------
{
  const ok = (o, why) => gate(`10. accepts ${why}`, badSurface(o, 'piece 1') === null, badSurface(o, 'piece 1') || '');
  const no = (o, why) => gate(`10. rejects ${why}`, badSurface(o, 'piece 1') !== null, badSurface(o, 'piece 1') || 'ACCEPTED');
  ok({}, 'a piece with no surface at all');
  ok({ surface: { friction: 0.5 } }, 'a single dial');
  ok({ surface: { friction: 0, restitution: 0.95, rollingResistance: 0.4, tangentSpeed: -8 } }, 'live dials at their limits (leftover Drag is ignored)');
  no({ surface: { friction: 2.01 } }, 'friction above its maximum');
  no({ surface: { friction: -0.01 } }, 'a negative friction');
  no({ surface: { restitution: 1 } }, 'restitution of 1 (never settles)');
  no({ surface: { tangentSpeed: 99 } }, 'a belt faster than the range allows');
  no({ surface: { friction: 'fast' } }, 'a non-numeric dial');
  no({ surface: { friction: NaN } }, 'a NaN dial');
  no({ surface: { grippiness: 1 } }, 'a dial that does not exist');
  no({ surface: [] }, 'an array instead of an object');
  no({ surface: 0.85 }, 'a bare number instead of an object');
}

summary();
