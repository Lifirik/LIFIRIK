// verify-ghostprops.mjs — a ghost prop is background the sticks forgot
// (2026-08-24).
//
//   node scripts/verify-ghostprops.mjs [--only <id|text>] [--quiet]
//
// "Turn a prop into a ghost… stuck to the background and sticks pass,
// balls/wheels do not." The flag is `ghost: true` on a prop; sim.js builds it
// STATIC on the GHOSTPROP filter (wheels, goal pieces and ordinary props land
// on it, no rod kind feels it), the Maker's prop menu toggles it, and the
// editor lets sticks be DRAWN through it because the physics lets them pass —
// the same bargain every placement rule strikes.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { initEngine, Simulation } = await import(u('public/js/sim.js'));
const { unbuildable } = await import(u('scripts/solver/buildable.mjs'));
await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

// a ghost shelf at y=-60 over a floor at y=0 (walkable top), goal parked away
const world = (props) => ({
  terrain: [{ type: 'box', x: 0, y: 30, w: 2000, h: 60 }],
  props,
  buildZones: [{ x: 0, y: -200, w: 1600, h: 400 }],
  goalZones: [{ x: 700, y: -40, w: 100, h: 80 }],
  goalObjs: [{ shape: 'ball', x: -700, y: -20, r: 15 }],
  fixedParts: [], texts: [], pins: [], groups: {},
});
const SHELF = { shape: 'box', x: 0, y: -60, w: 300, h: 16, ghost: true };

function settle(level, parts, secs = 2.5, opts = {}) {
  const sim = new Simulation(level, { parts }, { headless: true, ...opts });
  for (let i = 0; i < Math.round(secs * 30); i++) sim._fixedStep();
  const out = {
    wheels: sim.wheels.map((w) => sim._pose(w.body)),
    rods: sim.rods.map((r) => sim._pose(r.body)),
    props: sim.props.map((p) => sim._pose(p.body)),
    goals: sim.goals.map((g) => sim._pose(g.body)),
  };
  sim.destroy();
  return out;
}

const SHELF_TOP = -68;    // the shelf's top face
const FLOOR = 0;          // the ground's walkable top

section('1', () => {
  // the shelf itself: static, hangs in the air with nothing under it
  const alone = settle(world([SHELF]), []);
  gate('1a. a ghost prop is stuck to the background', Math.abs(alone.props[0].y - -60) < 0.5,
    `y ${alone.props[0].y.toFixed(1)} (authored -60)`);
  // a WHEEL dropped over it lands ON it
  const wheel = settle(world([SHELF]), [{ t: 'wheel', kind: 'free', x: 0, y: -120, r: 20, id: 'w1' }]);
  gate('1b. a wheel lands on the ghost', Math.abs(wheel.wheels[0].y - (SHELF_TOP - 20)) < 3,
    `wheel y ${wheel.wheels[0].y.toFixed(1)} vs shelf top ${SHELF_TOP}`);
  // a ROD dropped over it falls THROUGH to the floor
  const rod = settle(world([SHELF]), [{ t: 'rod', kind: 'wood', x1: -30, y1: -120, x2: 30, y2: -120, id: 'r1' }]);
  gate('1c. a wood stick falls straight through', rod.rods[0].y > SHELF_TOP + 20,
    `rod y ${rod.rods[0].y.toFixed(1)} — past the shelf, headed for the floor`);
  const water = settle(world([SHELF]), [{ t: 'rod', kind: 'water', x1: -30, y1: -120, x2: 30, y2: -120, id: 'r1' }]);
  gate('1d. a water stick too', water.rods[0].y > SHELF_TOP + 20, `y ${water.rods[0].y.toFixed(1)}`);
});

section('2', () => {
  // the cargo lands on it (balls do not pass) — dropped from ABOVE the
  // shelf (y grows downward; the stock goal at −20 would start under it)
  const lv = world([{ ...SHELF, x: -700 }]);
  lv.goalObjs = [{ shape: 'ball', x: -700, y: -140, r: 15 }];
  const goal = settle(lv, []);
  gate('2a. a goal ball lands on the ghost', Math.abs(goal.goals[0].y - (SHELF_TOP - 15)) < 3,
    `ball y ${goal.goals[0].y.toFixed(1)}`);
  // an ordinary prop lands on it
  const both = settle(world([SHELF, { shape: 'ball', x: 0, y: -140, r: 15 }]), []);
  gate('2b. an ordinary prop lands on the ghost', Math.abs(both.props[1].y - (SHELF_TOP - 15)) < 3,
    `prop y ${both.props[1].y.toFixed(1)}`);
});

section('3', () => {
  // the editor's side of the bargain: sticks may be DRAWN through a ghost,
  // wheels still may not sit inside one
  const lv = world([SHELF]);
  const rodThrough = unbuildable(lv, [{ t: 'rod', kind: 'wood', x1: -80, y1: -60, x2: 80, y2: -60, id: 'r1' }]);
  gate('3a. the editor lets a stick be drawn through a ghost', rodThrough == null, rodThrough || '');
  const wheelIn = unbuildable(lv, [{ t: 'wheel', kind: 'free', x: 0, y: -60, r: 20, id: 'w1' }]);
  gate('3b. …and still refuses a wheel inside one', wheelIn != null, wheelIn || 'ALLOWED');
  // a normal prop keeps refusing sticks — the exemption is the ghost's alone
  const solid = world([{ shape: 'box', x: 0, y: -60, w: 300, h: 16 }]);
  gate('3c. a solid prop still refuses the stick',
    unbuildable(solid, [{ t: 'rod', kind: 'wood', x1: -80, y1: -60, x2: 80, y2: -60, id: 'r1' }]) != null);
});

summary('(ghost props: static, GHOSTPROP filter — sim.js; menu toggle — game.js)');
