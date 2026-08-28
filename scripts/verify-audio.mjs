// verify-audio.mjs — the sound layer (§17).
//
// Sound is the first feature in the project that reads the solver every frame,
// so the gates that matter most are the ones proving it cannot WRITE to it: a
// replay must land identically whether the player has audio on, off, muted, or
// no audio device at all. Everything else here is about the two ways this could
// break quietly — a hit event stream that says nothing (or says far too much),
// and a module that takes the headless suites down by touching `window` at
// import time.
//
// Run: node scripts/verify-audio.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { initEngine, Simulation, PPM, HIT_THRESHOLD } = await import(u('public/js/sim.js'));
const { SEED_LEVELS } = await import(u('public/js/levels.js'));
const { MAT, materialForTexture, TEXTURES } = await import(u('public/js/surfaces.js'));
await initEngine(u('public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

// ---------- gate 1: audio.js is safe to import with no browser ----------
{
  // This is the gate that protects the other eight suites. game.js imports
  // audio.js unconditionally; a module-scope `new AudioContext()` would throw
  // at import and take every headless suite down with it.
  let mod = null, err = null;
  try { mod = await import(u('public/js/audio.js')); } catch (e) { err = e; }
  gate('1. audio.js imports under node with no WebAudio', !err, err ? err.message : '');
  if (mod) {
    gate('1. …and reports itself as not ready', mod.audioReady() === false);
    gate('1. …and initAudio() declines rather than throwing', mod.initAudio() === false);
    // Every play entry point must be a silent no-op, not an exception: game.js
    // calls these every frame and cannot be littered with guards.
    const calls = [
      ['playImpact', () => mod.playImpact({ speed: 9, matA: MAT.STONE, matB: MAT.WOOD, pan: 0 })],
      ['playMotion', () => mod.playMotion({ roll: 1, motor: 1, pitch: 1 })],
      ['stopMotion', () => mod.stopMotion()],
      ['playStinger', () => mod.playStinger('win')],
      ['playUi', () => mod.playUi('place')],
      ['setAudioSuspended', () => mod.setAudioSuspended(true)],
    ];
    let bad = null;
    for (const [n, f] of calls) { try { f(); } catch (e) { bad = `${n}: ${e.message}`; } }
    gate('1. every play function is a silent no-op headless', !bad, bad || `${calls.length} entry points`);
  }
}

// ---------- gate 2: settings repair themselves ----------
{
  const mod = await import(u('public/js/audio.js'));
  const { soundSettings, SOUND_DEFAULTS, SECTION_KEYS, THEME_KEYS, DEFAULT_THEME } = mod;
  // localStorage does not exist here, so `store` returns the default and this
  // exercises the absent-settings path — the one a new player hits.
  const s = soundSettings();
  gate('2. a player with no saved settings gets sound ON', s.on === true);
  gate('2. …at the default theme', s.theme === DEFAULT_THEME && s.theme === 'physical', s.theme);
  gate('2. …with every section enabled',
    SECTION_KEYS.every(k => s.sections[k] === true), SECTION_KEYS.join(','));
  gate('2. volume is within range', s.volume >= 0 && s.volume <= 1, String(s.volume));
  gate('2. there are five themes and four sections',
    THEME_KEYS.length === 5 && SECTION_KEYS.length === 4,
    `${THEME_KEYS.join('/')} | ${SECTION_KEYS.join('/')}`);
  // The reason the themes were reworked at all: "too similar". Each must now
  // carry its OWN synthesis style — five themes sharing a style would be the
  // old bug wearing new names.
  {
    const styles = THEME_KEYS.map(k => mod.SOUND_THEMES[k].style);
    gate('2. every theme has a distinct synthesis style',
      new Set(styles).size === THEME_KEYS.length, styles.join('/'));
    gate('2. every theme names itself and explains itself',
      THEME_KEYS.every(k => mod.SOUND_THEMES[k].name && mod.SOUND_THEMES[k].hint.length > 20));
  }
  gate('2. defaults name exactly the real sections',
    Object.keys(SOUND_DEFAULTS.sections).sort().join() === SECTION_KEYS.slice().sort().join());
}

// ---------- gate 3: every texture has a material, every material a voice ----------
{
  const { impactMaterial } = await import(u('public/js/audio.js'));
  const ids = new Set(Object.values(MAT));
  let bad = null;
  for (const t of TEXTURES) {
    const m = materialForTexture(t);
    if (!ids.has(m)) bad = `${t} -> ${m}`;
  }
  gate('3. all 16 textures map to a real material', !bad, bad || `${TEXTURES.length} textures`);
  gate('3. an unknown texture falls back rather than returning undefined',
    materialForTexture('no-such-texture') === MAT.STONE);
  // The surface a piece lands ON should name the sound, whatever landed on it.
  gate('3. terrain wins over a loose piece in a collision',
    impactMaterial(MAT.ICE, MAT.GOAL) === MAT.ICE
    && impactMaterial(MAT.GOAL, MAT.ICE) === MAT.ICE, 'ice + goal piece -> ice');
  gate('3. the pairing is order-independent', (() => {
    const all = Object.values(MAT);
    for (const a of all) for (const b of all) {
      if (impactMaterial(a, b) !== impactMaterial(b, a)) return false;
    }
    return true;
  })(), `${Object.keys(MAT).length}² pairs`);
  gate('3. an untagged shape (0) still yields a usable material',
    Object.values(MAT).includes(impactMaterial(0, 0)));
}

// ---------- rigs ----------
const TOP = 270;
const drop = (fromY, texture = 'granite', frames = 240) => ({
  terrain: [{ type: 'box', x: 0, y: TOP + 60, w: 4000, h: 120, texture }],
  props: [{ shape: 'box', x: 0, y: fromY, w: 40, h: 40 }],
  buildZones: [{ x: 0, y: 0, w: 600, h: 200 }], goalZones: [], goalObjs: [],
  win: 'goalObj', _frames: frames,
});
function runHits(level) {
  const sim = new Simulation(level, { parts: [] });
  const all = [];
  for (let i = 0; i < (level._frames || 240); i++) {
    sim._fixedStep();
    for (const h of sim.drainHits()) all.push(h);
  }
  return all;
}

// ---------- gate 4: hits are reported, once, with a usable speed ----------
{
  const hits = runHits(drop(-300));
  gate('4. a crate dropped onto terrain reports a hit', hits.length >= 1, `${hits.length} hits`);
  // A crate carries FC's own 0.2 restitution (sim.js PHYSICS.fc.prop,
  // 2026-08-18), so a 550 px drop lands, hops and lands again — two or three
  // thuds above the threshold, each a real impact. What this guards against
  // is the STREAM a settling contact used to report; a handful is the sound
  // of a crate bouncing, not a bug.
  gate('4. …a few thuds as it bounces and settles, not a stream', hits.length <= 4,
    `${hits.length} over 4 s`);
  const h = hits[0] || {};
  gate('4. the hit carries an approach speed above the threshold',
    h.speed > HIT_THRESHOLD, `${(h.speed || 0).toFixed(2)} m/s vs threshold ${HIT_THRESHOLD}`);
  gate('4. …a contact point in PIXELS, near the impact',
    Math.abs(h.x) < 60 && Math.abs(h.y - TOP) < 40,
    `(${(h.x || 0).toFixed(0)}, ${(h.y || 0).toFixed(0)}) px; floor top y=${TOP}`);
  gate('4. …and both materials, correctly identified',
    h.matA === MAT.PROP || h.matB === MAT.PROP,
    `matA ${h.matA} matB ${h.matB} (PROP=${MAT.PROP}, STONE=${MAT.STONE})`);
  gate('4. the crate and the granite floor are BOTH named',
    [h.matA, h.matB].includes(MAT.PROP) && [h.matA, h.matB].includes(MAT.STONE));
}

// ---------- gate 5: a resting stack is silent ----------
{
  // The reason the threshold exists. A piece already at rest generates contact
  // every single step; if those were reported, a settled level would roar.
  const lvl = drop(TOP - 20 - 0.01, 'granite', 300);
  const hits = runHits(lvl);
  gate('5. a crate placed at rest never reports a hit', hits.length === 0, `${hits.length} hits over 5 s`);
}

// ---------- gate 6: harder landings report faster, and materials come through ----------
{
  const speeds = [-100, -300, -700].map(y => {
    const h = runHits(drop(y));
    return h.length ? h[0].speed : 0;
  });
  gate('6. a longer drop reports a higher approach speed',
    speeds[0] < speeds[1] && speeds[1] < speeds[2],
    speeds.map(s => s.toFixed(1) + ' m/s').join(' → '));
  // The tie-in with surfaces: the same crate on different terrain must report
  // different materials, or every impact would sound the same.
  const seen = new Map();
  for (const tex of ['granite', 'ice', 'steel', 'mud', 'wood', 'rubber']) {
    const h = runHits(drop(-300, tex));
    if (h.length) seen.set(tex, h[0].matA === MAT.PROP ? h[0].matB : h[0].matA);
  }
  gate('6. the terrain material reaches the hit event',
    seen.get('ice') === MAT.ICE && seen.get('steel') === MAT.METAL
    && seen.get('mud') === MAT.SOFT && seen.get('wood') === MAT.WOOD
    && seen.get('rubber') === MAT.RUBBER && seen.get('granite') === MAT.STONE,
    [...seen].map(([k, v]) => `${k}=${v}`).join(' '));
}

// ---------- gate 7: painted terrain is heard too ----------
{
  // Chain loops cannot carry enableHitEvents (b2ChainDef has no such field), so
  // painted terrain is audible ONLY because the dynamic piece hitting it has
  // them on. If that ever stops being true, every painted level goes silent
  // with nothing else breaking — which is exactly the kind of thing that is
  // never noticed. Explicit zero handles, or the outline bows (§8.2).
  const Z = () => ({ x: 0, y: 0 });
  const ring = [[-2000, TOP], [2000, TOP], [2000, TOP + 120], [-2000, TOP + 120]];
  const [first, ...rest] = ring;
  const lvl = {
    terrain: [{
      type: 'paint', x: first[0], y: first[1], h1: Z(), h2: Z(), texture: 'ice',
      pts: [...rest.map(([x, y]) => ({ x, y, h1: Z(), h2: Z() })),
        { x: first[0], y: first[1], h1: Z(), h2: Z() }],
    }],
    props: [{ shape: 'box', x: 0, y: -300, w: 40, h: 40 }],
    buildZones: [{ x: 0, y: 0, w: 600, h: 200 }], goalZones: [], goalObjs: [], win: 'goalObj',
  };
  const hits = runHits(lvl);
  gate('7. a crate landing on PAINTED terrain reports a hit', hits.length >= 1, `${hits.length}`);
  const m = hits.length ? (hits[0].matA === MAT.PROP ? hits[0].matB : hits[0].matA) : null;
  gate('7. …and the painted piece\'s material survives SetMaterials', m === MAT.ICE,
    `got ${m}, want ICE=${MAT.ICE}`);
}

// ---------- gate 8: listening changes nothing ----------
{
  // The determinism claim (§5.8). Sound reads the world every frame; if it
  // could perturb it, every recorded solve would depend on whether the player
  // had speakers. Draining is what a sounding client does and not draining is
  // what a headless one does, so the two must agree exactly.
  // A level that actually CRASHES. The canonical level-1 machine was the
  // obvious choice and the wrong one: it is a gentle roll that never crosses
  // the hit threshold, so it compared two silent runs and would have passed
  // just as happily with the whole feature deleted. The last gate in this block
  // is what caught that, and it stays.
  const lvl = {
    terrain: [{ type: 'box', x: 0, y: TOP + 60, w: 4000, h: 120, texture: 'granite' }],
    props: [
      { shape: 'box', x: -200, y: -400, w: 40, h: 40 },
      { shape: 'ball', x: 100, y: -700, r: 20 },
      { shape: 'box', x: 300, y: -250, w: 40, h: 40 },
    ],
    buildZones: [{ x: 0, y: 0, w: 900, h: 500 }], goalZones: [], goalObjs: [], win: 'goalObj',
  };
  const design = { parts: [{ t: 'wheel', kind: 'cw', x: -50, y: TOP - 15, r: 15, id: 'w1' }] };
  const run = (drain) => {
    const sim = new Simulation(lvl, design);
    let heard = 0;
    for (let i = 0; i < 900; i++) {
      sim._fixedStep();
      if (drain) {
        heard += sim.drainHits().length;
        // everything the sound tick reads off the world, read the same way
        sim.wheelMotion();
      }
    }
    const poses = [];
    for (const rec of [...sim.props, ...sim.goals, ...sim.wheels, ...sim.rods]) {
      const p = sim._pose(rec.body);
      poses.push(p.x, p.y, p.angle);
    }
    return { poses, heard, won: sim.won, winTime: sim.winTime };
  };
  const quiet = run(false), loud = run(true);
  gate('8. poses are bit-for-bit identical whether or not hits are drained',
    quiet.poses.length === loud.poses.length && quiet.poses.every((v, i) => v === loud.poses[i]),
    `${quiet.poses.length} values`);
  gate('8. the run being compared actually made noise', loud.heard > 0, `${loud.heard} hits heard`);

  // …and the same claim against a level that WINS, because the number that
  // must never move is a recorded solve's winTime (§5.8).
  const solve = { parts: [
    { t: 'rod', kind: 'wood', x1: -290.625, y1: -15, x2: -330.625, y2: -15, id: 'r1' },
    { t: 'wheel', kind: 'cw', x: -330.625, y: -15, r: 15, id: 'w1' },
  ] };
  const official = (drain) => {
    const sim = new Simulation(SEED_LEVELS[0], solve);
    for (let i = 0; i < 600; i++) {
      sim._fixedStep();
      if (drain) {
        sim.drainHits();
        sim.wheelMotion();
      }
    }
    return { won: sim.won, winTime: sim.winTime };
  };
  const a = official(false), b = official(true);
  gate('8. an official level\'s recorded win time is unchanged by listening',
    a.won === b.won && a.winTime === b.winTime && a.won === true,
    `${a.winTime} vs ${b.winTime}`);
}

// ---------- gate 8b: a machine lost to the void goes quiet ----------
{
  // A powered wheel spins forever whether or not it is still in the world, so
  // before this a machine that threw itself off the level went on whirring from
  // the abyss for the rest of the run. Same void line as `goalLost` and `sweep`
  // (VOID_DROP), so a piece stops making noise at exactly the moment the rest
  // of the game agrees it is gone.
  // The floor is deliberately enormous. A lone powered wheel drives itself at
  // ~150 px/s, so on the 600 px floor this rig first used it simply rolled off
  // the end and fell into the void as well — and the gate then "passed" the
  // wrong way, reporting both wheels gone.
  const lvl = {
    terrain: [{ type: 'box', x: 0, y: TOP + 60, w: 20000, h: 120, texture: 'granite' }],
    props: [], buildZones: [{ x: 0, y: 0, w: 900, h: 500 }], goalZones: [], goalObjs: [],
    win: 'goalObj',
  };
  // one wheel on the floor, one out past the end of it in open air
  const design = { parts: [
    { t: 'wheel', kind: 'cw', x: 0, y: TOP - 15, r: 15, id: 'w1' },
    { t: 'wheel', kind: 'cw', x: 15000, y: 0, r: 15, id: 'w2' },
  ] };
  const sim = new Simulation(lvl, design);
  const start = sim.wheelMotion();
  gate('8b. both wheels are counted while they are in the world', start.count === 2, `${start.count}`);
  // let the loose one fall well past the void line
  for (let i = 0; i < 600; i++) sim._fixedStep();
  const after = sim.wheelMotion();
  gate('8b. a wheel past the void line stops being counted', after.count === 1,
    `${after.count} of 2 still counted`);

  // now lose everything
  const sim2 = new Simulation(lvl, { parts: [
    { t: 'wheel', kind: 'cw', x: 15000, y: 0, r: 15, id: 'w1' },
  ] });
  gate('8b. a lone wheel makes noise to begin with', sim2.wheelMotion().count === 1);
  for (let i = 0; i < 900; i++) sim2._fixedStep();
  const gone = sim2.wheelMotion();
  gate('8b. a machine wholly lost to the void falls SILENT',
    gone.count === 0 && gone.rim === 0 && gone.spin === 0,
    `count ${gone.count}, rim ${gone.rim}, spin ${gone.spin}`);
  gate('8b. …which is the same moment the run counts as swept', sim2.sweep === true);
}

// ---------- gate 9: never drained is never leaked ----------
{
  // A level played with audio off never calls drainHits. The buffer must not
  // grow without bound across a long run — this is the shape of leak that only
  // shows up in someone's twenty-minute session.
  const sim = new Simulation(drop(-300), { parts: [] });
  for (let i = 0; i < 2000; i++) sim._fixedStep();
  gate('9. an undrained buffer stays capped', sim._hits.length <= 24,
    `${sim._hits.length} entries after 2000 steps with no drain`);
  gate('9. drainHits empties it', (() => {
    sim.drainHits();
    return sim._hits.length === 0;
  })());
  gate('9. …and a second drain returns nothing rather than repeating',
    sim.drainHits().length === 0);
}

summary();
