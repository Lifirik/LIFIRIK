// verify-axles.mjs — no axle, no power (2026-08-24).
//
//   node scripts/verify-axles.mjs [--only <id|text>] [--quiet]
//
// "Wheels that have rods OR pins attached can move."
// The rule lives in util.wheelHasAxle — a rod END on the wheel's hub, or any
// other pin on that same hub (crate / ball goal piece, loose pin, prop,
// terrain), by the same jointKey coordinate rule every joint answers to —
// and sim.js consults it at every place a motor is born: the joint-graph
// path, the bucket path, and the lone drive. These gates run the REAL
// Simulation on a flat world and measure what actually turns.
//
// What is deliberately NOT gated here: an FC-imported machine. A shelled
// wheel keeps FC's own law (a lone ClockwiseWheel drives in FC and must go
// on driving here, bit-exact), and the fc replay suites already hold that.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { wheelHasAxle } = await import(u('public/js/util.js'));
const { initEngine, Simulation } = await import(u('public/js/sim.js'));
await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

const world = (over = {}) => ({
  terrain: [{ type: 'box', x: 0, y: 30, w: 2400, h: 60 }],
  props: [], buildZones: [{ x: 0, y: -150, w: 2000, h: 300 }],
  goalZones: [{ x: 900, y: -40, w: 120, h: 80 }],
  goalObjs: [{ shape: 'ball', x: -900, y: -20, r: 15 }],
  fixedParts: [], texts: [], pins: [], groups: {},
  ...over,
});

// run a machine for `secs` and report how far each wheel travelled in x
function run(parts, secs = 3, over = {}) {
  const sim = new Simulation(world(over), { parts }, { headless: true });
  const before = sim.wheels.map((w) => sim._pose(w.body).x);
  const steps = Math.round(secs * 30);
  for (let i = 0; i < steps; i++) sim._fixedStep();
  const moved = sim.wheels.map((w, i) => sim._pose(w.body).x - before[i]);
  const spin = sim.wheels.map((w) => sim.E.body_w(w.body));
  const joints = sim.jointRecs.length;
  sim.destroy();
  return { moved, spin, joints };
}

const W = (x, y, kind = 'cw', r = 20, id = 'w1') => ({ t: 'wheel', kind, x, y, r, id });
const R = (x1, y1, x2, y2, kind = 'wood', id = 'r1') => ({ t: 'rod', kind, x1, y1, x2, y2, id });
const DRIVE_PX = 30;    // an unmistakably driving wheel covers hundreds; a free-rolling one settles

section('1', () => {
  gate('1a. the rule itself: a rod END on the hub is an axle',
    wheelHasAxle(W(0, -20), [R(0, -20, 60, -20)])
    && wheelHasAxle(W(0, -20), [R(60, -80, 0, -20)])            // either end
    && !wheelHasAxle(W(0, -20), [R(20, -20, 80, -20)])          // rim slot is not the hub
    && !wheelHasAxle(W(0, -20), [R(0, -40, 60, -40)])           // near miss, 20 px off
    && !wheelHasAxle(W(0, -20), []));
  gate('1b. any rod kind is a shaft — water and rope links included',
    wheelHasAxle(W(0, -20), [R(0, -20, 60, -20, 'water')])
    && wheelHasAxle(W(0, -20), [{ ...R(0, -20, 60, -20), chain: 'c1' }]));
});

section('2', () => {
  // the bare motor wheel: dropped on the ground, nothing attached
  const lone = run([W(0, -20)]);
  gate('2a. a lone powered wheel does not drive', Math.abs(lone.moved[0]) < DRIVE_PX,
    `moved ${lone.moved[0].toFixed(1)}px in 3s`);
  // the same wheel with a shaft: a rod from its hub, far end free in the air
  const shaft = run([W(0, -20), R(0, -20, 0, -90, 'wood')]);
  gate('2b. …and DRIVES the moment a rod is on its hub', Math.abs(shaft.moved[0]) > DRIVE_PX * 3,
    `moved ${shaft.moved[0].toFixed(1)}px`);
  gate('2c. …clockwise means rightward, as ever', shaft.moved[0] > 0);
});

section('3', () => {
  // bracing on the rim is not an axle: rod tip on the rim slot
  const rim = run([W(0, -20), R(20, -20, 90, -20, 'wood')]);
  gate('3a. a rod on the RIM does not power the wheel', Math.abs(rim.moved[0]) < DRIVE_PX,
    `moved ${rim.moved[0].toFixed(1)}px`);
  // two powered wheels that only KISS at the rim: neither hub has the other
  // on it, so there is no shaft. (A wheel whose HUB sits on the other is
  // axled — 3d.)
  const cart = run([W(0, -20), W(40, -20, 'cw', 20, 'w2')]);
  gate('3b. wheels that only kiss at the rim do not lend each other power', cart.moved.every((m) => Math.abs(m) < DRIVE_PX),
    cart.moved.map((m) => m.toFixed(1)).join(', '));
  // the classic two-wheel cart WITH an axle rod between the hubs: both drive
  const axled = run([W(0, -20), W(120, -20, 'cw', 20, 'w2'), R(0, -20, 120, -20, 'wood')]);
  gate('3c. an axle between two hubs powers both', axled.moved.every((m) => m > DRIVE_PX * 3),
    axled.moved.map((m) => m.toFixed(0)).join(', '));
  // a standard wheel on a large wheel's face: the small hub sits on the
  // large inner ring — that pin is the shaft.
  const onFace = run([
    W(0, -80, 'free', 40, 'big'),
    W(20, -80, 'cw', 20, 'std'),
  ]);
  gate('3d. a wheel whose hub sits on another wheel is powered',
    Math.abs(onFace.spin[1]) > 1,
    `ω big=${onFace.spin[0].toFixed(2)} std=${onFace.spin[1].toFixed(2)}`);
});

section('4', () => {
  // a FREE wheel with a rod on its hub stays free — the rule adds no power
  const free = run([W(0, -20, 'free'), R(0, -20, 0, -90, 'wood')]);
  gate('4a. a free wheel with an axle is still free', Math.abs(free.moved[0]) < DRIVE_PX,
    `moved ${free.moved[0].toFixed(1)}px`);
  // a level's own FIXED rod is as good a shaft as the player's
  const fixedShaft = run([W(0, -20)], 3, { fixedParts: [R(0, -20, 0, -90, 'wood', 'f1')] });
  gate('4b. a fixed rod on the hub is an axle too', Math.abs(fixedShaft.moved[0]) > DRIVE_PX * 3,
    `moved ${fixedShaft.moved[0].toFixed(1)}px`);
});

section('5', () => {
  // any pin on the hub is a shaft — crate, ball, loose pin, prop, terrain
  const crate = { shape: 'box', x: 0, y: -20, w: 40, h: 40 };
  const ball = { shape: 'ball', x: 0, y: -20, r: 15 };
  gate('5a. a crate goal-piece pin on the hub is an axle',
    wheelHasAxle(W(0, -20), [], { goalObjs: [crate] })
    && wheelHasAxle(W(20, 0), [], { goalObjs: [crate] })          // a corner, not only the centre
    && !wheelHasAxle(W(0, -20), [], { goalObjs: [{ ...crate, x: 100 }] }));
  gate('5b. a ball goal-piece pin, a loose pin, a prop pin, a terrain pin — any of them',
    wheelHasAxle(W(0, -20), [], { goalObjs: [ball] })
    && wheelHasAxle(W(0, -20), [], { pins: [{ x: 0, y: -20 }] })
    && wheelHasAxle(W(0, -20), [], { props: [{ shape: 'box', x: 40, y: -20, w: 40, h: 40, pins: [{ x: 0, y: -20 }] }] })
    && wheelHasAxle(W(0, -20), [], { terrain: [{ type: 'box', x: 0, y: 30, w: 200, h: 60, pins: [{ x: 0, y: -20 }] }] })
    && !wheelHasAxle(W(0, -20), [], { pins: [{ x: 40, y: -20 }] }));
});

section('6', () => {
  // a drive wheel snapped onto a crate's side pin: the crate is the chassis.
  // Matching lattices used to weld them at every coincidence; one joint at
  // the hub is the shaft, and the wheel must actually roll.
  const crateCart = run([W(-20, -20)], 3, {
    goalObjs: [{ shape: 'box', x: 0, y: -20, w: 40, h: 40 }],
  });
  gate('6a. a wheel on a crate pin DRIVES',
    Math.abs(crateCart.moved[0]) > DRIVE_PX * 3 && crateCart.joints === 1,
    `moved ${crateCart.moved[0].toFixed(1)}px, ${crateCart.joints} joint`);
  // a loose pin is bolted to the world, so the wheel motors in place — it
  // must SPIN, even though it cannot translate
  const worldPin = run([W(0, -20)], 3, { pins: [{ x: 0, y: -20 }] });
  const bareSpin = run([W(0, -20)]).spin[0];
  gate('6b. a wheel on a loose pin is powered (spins against the world)',
    Math.abs(worldPin.spin[0]) > Math.abs(bareSpin) + 1,
    `ω=${worldPin.spin[0].toFixed(2)} vs bare ${bareSpin.toFixed(2)}`);
  gate('6c. …and a pin that MISSES the hub still leaves it free-rolling',
    Math.abs(run([W(0, -20)], 3, { pins: [{ x: 40, y: -20 }] }).moved[0]) < DRIVE_PX);
  // concentric crate + wheel used to weld at every shared lattice pin
  // (five revolutes, spin 0). One joint at the hub, and it turns.
  const crateCentre = run([W(0, -20)], 3, {
    goalObjs: [{ shape: 'box', x: 0, y: -20, w: 40, h: 40 }],
  });
  gate('6d. a wheel on a crate CENTRE pin turns (lattices no longer weld it)',
    Math.abs(crateCentre.spin[0]) > 1 && crateCentre.joints === 1,
    `ω=${crateCentre.spin[0].toFixed(2)}, ${crateCentre.joints} joint`);
});

section('7', () => {
  // A standard wheel on a large wheel's FACE shares two hubs at different
  // points: the large hub is the standard's west rim, the standard hub is
  // the large inner ring. The large hub is processed first, so the joint
  // used to land on the standard's EDGE. Attach by the smaller axle.
  const jointsOf = (parts) => {
    const sim = new Simulation(world(), { parts }, { headless: true });
    const recs = sim.jointRecs.map((j) => ({ x: j.x, y: j.y }));
    sim.destroy();
    return recs;
  };
  const nearPt = (recs, x, y) => recs.some((j) => Math.hypot(j.x - x, j.y - y) < 0.2);
  const face = jointsOf([
    W(0, -80, 'free', 40, 'big'),
    W(20, -80, 'free', 20, 'std'),
  ]);
  gate('7a. a standard wheel on a large wheel joints at the STANDARD’s hub, not its rim',
    face.length === 1 && nearPt(face, 20, -80) && !nearPt(face, 0, -80),
    face.map((j) => `${j.x},${j.y}`).join('; ') || 'no joints');
  // Equal size, each hub on the other's rim: the one ADDED later (second in
  // the list) attaches by its own axle.
  const peer = jointsOf([
    W(0, -80, 'free', 20, 'a'),
    W(20, -80, 'free', 20, 'b'),
  ]);
  gate('7b. two equal wheels: the later one attaches by its hub',
    peer.length === 1 && nearPt(peer, 20, -80) && !nearPt(peer, 0, -80),
    peer.map((j) => `${j.x},${j.y}`).join('; ') || 'no joints');
});

summary('(no axle, no power — util.wheelHasAxle, consulted at every motor in sim.js)');
