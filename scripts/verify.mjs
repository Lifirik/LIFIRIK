// verify.mjs — §15 verification protocol (acceptance gates).
// Headless harness: Simulation + scripted machines, stepping _fixedStep
// directly — no rAF. All tests run against the shipped wasm binary.
// Run: node scripts/verify.mjs (gates 1,2,4,5,6)
//
// Gate 3 (scripted solves of seed stubs) was removed: the campaign lives in
// scripts/campaign-seed.json and is installed by `npm run seed`. This file
// still uses SEED_LEVELS[0] as a plain physics fixture.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';
import fs from 'node:fs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { initEngine, Simulation, PPM, MOTOR_TORQUE, wheelMotorTorque, VOID_DROP, AFTERMATH_FRAMES, WIN_FRAMES, physicsOf } = await import(u('public/js/sim.js'));
const { nearestPlanet, PIECE_GRAVITY_MIN, PIECE_GRAVITY_MAX, floatsAway } = await import(u('public/js/gravity.js'));
const { drawPlanetHalos, drawGravityField, drawPieceGravity, GRAV_MARK_MIN_HALF, drawProp,
 PROP_TEX_LOOKS, isPropTexture, propTextureTile, terrainPath, drawBackLevel, drawTexts, BACKDROP_SCALE, BACKDROP_ALPHA,
 SKY_PARALLAX_OF, skyHazeOf, BACKGROUNDS } = await import(u('public/js/render.js'));
const { PROP_TEXTURES } = await import(u('public/js/sizes.js'));
const { TEXTURES } = await import(u('public/js/surfaces.js'));
const { Camera } = await import(u('public/js/camera.js'));
const { WHEEL_SIZES, STD_WHEEL_R, polyArea2, wheelRings } = await import(u('public/js/util.js'));
const { drawWheel, ARROW_SEAT, PIN_DOT_R, rimWidthOf } = await import(u('public/js/render.js'));
const { ROD_WEIGHT_MAX, ROD_WEIGHT_SAFE } = await import(u('public/js/sizes.js'));
const { SEED_LEVELS } = await import(u('public/js/levels.js'));
await initEngine(u('public/vendor/fcsim/fcsim.wasm')); // the engine, by its own name

const { gate, section, summary } = gates();

const flatLevel = (w = 3000) => ({
 terrain: [{ type: 'box', x: 0, y: 30, w, h: 60 }],
 props: [],
 buildZones: [{ x: 0, y: -75, w: 2400, h: 150 }], // roomy zone for stress rigs
 goalZones: [{ x: w / 2 - 100, y: -52, w: 120, h: 104 }],
 goalObjs: [{ shape: 'ball', x: -w / 2 + 100, y: -15, r: 15 }],
 win: 'goalObj',
});

// ---------- gate 1: determinism ----------
{
 const design = { parts: [
 { t: 'rod', kind: 'wood', x1: -290.625, y1: -15, x2: -330.625, y2: -15, id: 'r1' },
 { t: 'wheel', kind: 'cw', x: -330.625, y: -15, r: 15, id: 'w1' },
 ]};
 const a = new Simulation(SEED_LEVELS[0], design);
 const b = new Simulation(SEED_LEVELS[0], design);
 for (let i = 0; i < 600; i++) { a._fixedStep(); b._fixedStep(); }
 let identical = true;
 const bodiesOf = (s) => [...s.goals, ...s.wheels, ...s.rods].map(r => r.body);
 const A = bodiesOf(a), B = bodiesOf(b);
 for (let i = 0; i < A.length; i++) {
 const pa = a._pose(A[i]), pb = b._pose(B[i]);
 // Float64 equality, not epsilon
 if (pa.x !== pb.x || pa.y !== pb.y || pa.c !== pb.c || pa.s !== pb.s) identical = false;
 }
 gate('1. determinism: 600 frames bit-identical', identical);
 gate('1. determinism: winTime identical', a.winTime === b.winTime, `winTime ${a.winTime}`);
 a.destroy(); b.destroy();
 // Cross-environment note: a browser-recorded First Steps replay reproduced
 // winTime 4.016666666666658 bit-exactly under Node (checked in dev).
}

// ---------- gate 2a: motor-stressed 15-link rod chain ----------
{
 // 15 rods pin-to-pin at y=-45 (clear of the ground), a powered wheel hub at
 // every joint, alternating cw/ccw — opposing motors stress every pin.
 const parts = [];
 const y = -45, x0 = -300, link = 40;
 for (let i = 0; i < 15; i++) {
 parts.push({ t: 'rod', kind: 'wood', x1: x0 + i * link, y1: y, x2: x0 + (i + 1) * link, y2: y, id: 'r' + i });
 }
 for (let i = 1; i < 15; i++) {
 parts.push({ t: 'wheel', kind: i % 2 ? 'cw' : 'ccw', x: x0 + i * link, y, r: 15, id: 'w' + i });
 }
 const lvl = flatLevel();
 const sim = new Simulation(lvl, { parts });
 sim.captureJointLocals();
 for (let i = 0; i < 600; i++) sim._fixedStep();
 const worst = sim.worstJointGap();
 gate('2a. 15-link motor-stressed chain: worst joint gap < 0.5 px', worst < 0.5,
 `${worst.toFixed(4)} px, joints ${sim.jointCount}, subSteps ${sim.subSteps}`);
 sim.destroy();
}

// ---------- gate 2b: ~84-part / 132-joint machine, 8 sub-steps path ----------
{
 // ladder truss: two parallel rod chains + rungs + wheels along the bottom
 const parts = [];
 const x0 = -300, seg = 30, N = 20;
 for (let i = 0; i < N; i++) {
 parts.push({ t: 'rod', kind: 'wood', x1: x0 + i * seg, y1: -15, x2: x0 + (i + 1) * seg, y2: -15, id: 'b' + i });
 parts.push({ t: 'rod', kind: 'wood', x1: x0 + i * seg, y1: -45, x2: x0 + (i + 1) * seg, y2: -45, id: 't' + i });
 }
 for (let i = 0; i <= N; i++) {
 parts.push({ t: 'rod', kind: 'wood', x1: x0 + i * seg, y1: -15, x2: x0 + i * seg, y2: -45, id: 'v' + i });
 }
 for (let i = 2; i <= N - 2; i += 4) {
 parts.push({ t: 'wheel', kind: 'free', x: x0 + i * seg, y: -15, r: 15, id: 'w' + i });
 }
 const sim = new Simulation(flatLevel(), { parts });
 sim.captureJointLocals();
 const t0 = performance.now();
 for (let i = 0; i < 600; i++) sim._fixedStep();
 const stepMs = (performance.now() - t0) / 600;
 const worst = sim.worstJointGap();
 // residual at-rest jitter: max body speed at frame 600. The engine is
 // px-native, so its own reader IS px/s — the ×30 this line used to carry
 // belonged to a metres-based binding that no longer exists.
 const E = sim.E;
 let maxSpeed = 0;
 for (const rec of [...sim.wheels, ...sim.rods])
 maxSpeed = Math.max(maxSpeed, Math.hypot(E.body_vx(rec.body), E.body_vy(rec.body)));
 gate(`2b. big machine (${parts.length} parts, ${sim.jointCount} joints): gap < 1 px`, worst < 1,
 `${worst.toFixed(4)} px, subSteps ${sim.subSteps}`);
 gate('2b. big machine: at-rest jitter < 45 px/s', maxSpeed < 45, `${maxSpeed.toFixed(2)} px/s`);
 gate('2b. big machine: step time < 2 ms', stepMs < 2, `${stepMs.toFixed(3)} ms`);
 sim.destroy();
}

// ---------- gate 5: rim-pin roll ----------
{
 // rod bolted to wheel edge pins (ring r12, inset 3), wheels rolling on flat
 // ground: a locomotive coupling rod between two wheels' east pins. The rod
 // orbits with the pins; its lowest sweep clears the ground by the inset —
 // the hub's vertical bounce per revolution is the PIN_INSET test.
 //
 // **The bar is 1 px, and it was 0.05** (2026-08-12). Adopting FC's stick
 // density made this rod 2.6× heavier while FC's gravity cut the force holding
 // the wheel down to 0.58×, so the mass swinging round a 12 px crank now lifts
 // the wheel 0.61 px a turn where it used to lift it 0.004. Both changes are
 // needed to see it — reverting either one alone puts it back under 0.01 —
 // which is why testing them one at a time showed nothing.
 //
 // It is a real, sustained wobble and not a settling transient: the last third
 // of the run bounces as much as the first. It is kept because it is honest.
 // A wheel dragging a lump of wood round an off-centre crank SHOULD bob, the
 // old 0.004 px was too clean for the sticks we now have, and 0.61 px is 2% of
 // a wheel's diameter — a sub-pixel shimmer at normal zoom. A deliberate call.
 //
 // 1 px keeps ~1.6× headroom over the measured figure while still failing loudly
 // on anything structural: the FC motor tearing a pin off, two gates below,
 // opened a joint 11.3 px.
 const lvl = flatLevel();
 const design = { parts: [
 { t: 'wheel', kind: 'cw', x: -400, y: -15, r: 15, id: 'w1' },
 { t: 'wheel', kind: 'cw', x: -320, y: -15, r: 15, id: 'w2' },
 { t: 'rod', kind: 'wood', x1: -388, y1: -15, x2: -308, y2: -15, id: 'r1' }, // east ring pin → east ring pin
 ]};
 const sim = new Simulation(lvl, { parts: design.parts });
 // settle 30 frames, then measure hub height over ~3 revolutions
 for (let i = 0; i < 30; i++) sim._fixedStep();
 let minY = Infinity, maxY = -Infinity;
 // surface speed ~150 px/s, circumference ~94 px → 1 rev ≈ 38 frames; run 130
 for (let i = 0; i < 130; i++) {
 sim._fixedStep();
 const p = sim._pose(sim.wheels[0].body);
 minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
 }
 const bounce = maxY - minY;
 gate('5. rim-pin roll: vertical bounce < 1 px', bounce < 1, `${bounce.toFixed(4)} px over ~3 revs`);
 sim.destroy();
}

// ---------- gate 5: where the drive arrow sits on the face ----------
{
 // 2026-08-12, on request: the arrows should ride midway across the empty face
 // INSIDE the outermost groove — between the two races on a large wheel,
 // between the race and the axle on the others — rather than out under the pin
 // dots, which is where they were.
 //
 // This reads the arc the RENDERER actually drew rather than recomputing the
 // seat: a gate that repeats the formula agrees with a broken draw call.
 const recCtx = () => {
 const calls = [];
 const stub = { addColorStop() {} };
 return new Proxy({ canvas: { width: 64, height: 64 }, calls }, {
 get(t, k) {
 if (k in t) return t[k];
 const name = String(k);
 return (...a) => {
 calls.push({ fn: name, a, lw: t.lineWidth });
 return /Gradient|createPattern/.test(name) ? stub : undefined;
 };
 },
 set(t, k, v) { t[k] = v; return true; },
 });
 };
 // The arrows are PARTIAL arcs about the wheel's own centre — the rim, the
 // races and the hub dot are all full circles. Partial is no longer enough on
 // its own: the rim's lit bevel is two partial arcs as well, and this probe
 // read the brighter of them as the arrow (r40 seat 38.80, which is the rim,
 // not the band). The shaft's WIDTH is what tells them apart, and the gate
 // was already computing it to talk about the shaft's inner edge.
 const arrowRadii = (r) => {
 const ctx = recCtx();
 drawWheel(ctx, { r, kind: 'cw' }, { x: 0, y: 0, c: 1, s: 0 }, {});
 const shaftW = rimWidthOf(r) * 0.8;
 const rs = ctx.calls
 .filter((c) => c.fn === 'arc' && Math.abs(c.a[4] - c.a[3]) < Math.PI * 2 - 0.01
 && Math.abs((c.lw ?? 0) - shaftW) < 1e-6)
 .map((c) => c.a[2]);
 return [...new Set(rs.map((x) => +x.toFixed(3)))];
 };
 gate('5. the arrow seat is a named dial, set to the empty band',
 ARROW_SEAT.mode === 'band', `mode ${ARROW_SEAT.mode}`);
 for (const r of WHEEL_SIZES) {
 const rings = wheelRings(r).map((g) => g.rad).sort((a, b) => a - b);
 const outer = rings[rings.length - 1];
 const inner = rings.length > 1 ? rings[rings.length - 2] : 0;
 const mid = (outer + inner) / 2;
 const halfShaft = rimWidthOf(r) * 0.8 * 0.5;
 const drawn = arrowRadii(r);
 const seat = drawn.length ? Math.max(...drawn) : null;
 // the claim is about the shaft's INNER EDGE, not its centre-line
 const innerEdge = seat == null ? null : seat - halfShaft;
 // the small wheel cannot reach its own midpoint — a 15 px-wide wheel's
 // shaft would swallow the hub dot — so it is allowed to stop short, but
 // never to sit further out than the pin seat it used to use.
 const ok = innerEdge != null
 && (Math.abs(innerEdge - mid) < 0.3 || (r === Math.min(...WHEEL_SIZES) && seat <= 4.35 + 0.01));
 gate(`5. r${r} drive arrow's inner edge rides the empty face (grooves ${rings.join(' & ')})`,
 ok, `inner edge ${innerEdge == null ? 'nothing' : innerEdge.toFixed(2)}, midpoint ${mid.toFixed(2)}` +
 `, seat ${seat == null ? '—' : seat.toFixed(2)}`);
 // and whatever the seat, the barb must not crowd the hub pin dot
 gate(`5. r${r} arrow clears the hub dot`, seat != null && seat > PIN_DOT_R,
 `seat ${seat == null ? '—' : seat.toFixed(2)} vs dot r${PIN_DOT_R}`);
 }
}

// ---------- gate 5: a stalled motor must not tear a pin off ----------
{
 // A real three-part machine, 2026-08-12: one rod on the wheel's HUB, one on
 // a RIM pin. Both are motor-driven — every rod pinned to a powered wheel gets
 // its own motor joint — so the wheel drives the two into each other. They
 // collide correctly (MASK.ROD includes CAT.ROD) and the machine should simply
 // jam.
 //
 // It did, on the LIFIRIK profile. On the FC profile the motor was 1e6 N·m,
 // chosen to mean "never stalls", so instead of jamming it kept pushing until
 // the solver could no longer hold the joint: the pin opened 11.3 px and the
 // rod visibly tore off. The comment under that constant claimed "nothing in a
 // level can load it enough to matter"; three parts did.
 //
 // This gate is the claim that replaced it, and it runs on BOTH profiles,
 // because the bug was invisible on the one the suite happened to test.
 const lvl = flatLevel();
 const parts = [
 { t: 'wheel', kind: 'cw', x: -347, y: -62, r: 15, id: 'w' },
 { t: 'rod', kind: 'wood', x1: -347, y1: -62, x2: -293.5, y2: -60.9, id: 'hub' },
 { t: 'rod', kind: 'wood', x1: -338.5, y1: -70.5, x2: -290.4, y2: -70.9, id: 'rim' },
 ];
 for (const profile of ['lifirik', 'fc']) {
 const sim = new Simulation(lvl, { parts }, { physics: profile });
 // TRUE separation: the pin in each body's own local frame, compared in
 // world space. Reconstructing the pin from the wheel's pose instead would
 // measure the wheel, not the joint. That is exactly what the sim's own
 // pair does — captureJointLocals stores each pin in both bodies' frames,
 // worstJointGap re-reads them — so this gate asks the sim rather than
 // rebuilding the arithmetic against a binding that has been deleted.
 sim.captureJointLocals();
 let worst = 0;
 for (let i = 0; i < 60 * 8; i++) {
 sim._fixedStep();
 worst = Math.max(worst, sim.worstJointGap());
 }
 gate(`5. two rods jammed on one powered wheel keep their pins (${profile})`,
 worst < 1, `worst joint gap ${worst.toFixed(2)} px over 8 s`);
 sim.destroy();
 }
}

// ---------- gate 6: zero-gravity sanity of conversion (rest contact) ----------
{
 const sim = new Simulation(SEED_LEVELS[0], { parts: [] });
 for (let i = 0; i < 60; i++) sim._fixedStep();
 const pose = sim._pose(sim.goals[0].body);
 gate('6. First Steps ball rests at y = −15 (±0.05) on ground top', Math.abs(pose.y + 15) < 0.05,
 `y ${pose.y.toFixed(5)}`);
 sim.destroy();
}

// ---------- gate 7: painted terrain (chain loops, §5.3) ----------
{
 // Painted slab: top edge at y = 0, 120 px thick, straight edges (explicit
 // zero handles — an unset handle is an auto Catmull-Rom curve that bows the
 // outline outward, §8.2). Anchor 0 is the piece's own (x, y); `pts` closes
 // back onto it.
 const Z = () => ({ x: 0, y: 0 });
 const slab = (order, x0 = -900, x1 = 900) => {
 const ring = [[x0, 0], [x1, 0], [x1, 120], [x0, 120]];
 if (order === 'ccw') ring.reverse();
 const [first, ...rest] = ring;
 return {
 type: 'paint', x: first[0], y: first[1], h1: Z(), h2: Z(),
 pts: [...rest.map(([x, y]) => ({ x, y, h1: Z(), h2: Z() })),
 { x: first[0], y: first[1], h1: Z(), h2: Z() }],
 texture: 'granite',
 };
 };
 const painted = (terrain, goal) => ({
 terrain, props: [],
 buildZones: [{ x: -700, y: -200, w: 200, h: 150 }],
 goalZones: [{ x: 700, y: -60, w: 120, h: 104 }],
 goalObjs: [goal],
 win: 'goalObj',
 });

 // 7a/7b: a ball lands on the surface, whichever way round the loop was drawn
 for (const order of ['cw', 'ccw']) {
 const sim = new Simulation(painted([slab(order)], { shape: 'ball', x: 0, y: -300, r: 15 }), { parts: [] });
 for (let i = 0; i < 180; i++) sim._fixedStep();
 const p = sim._pose(sim.goals[0].body);
 gate(`7. painted slab (${order}) holds a ball at y = −15 (±0.1)`, Math.abs(p.y + 15) < 0.1, `y ${p.y.toFixed(4)}`);
 sim.destroy();
 }

 // 7d: friction parity with a box floor — the SetMaterials trap (§16). A
 // b2SurfaceMaterial instance silently reads back friction 0, so the box
 // would never stop; matching a plain box floor to the pixel is the proof
 // the material actually reached the chain.
 const slideOn = (terrain) => {
 const lvl = painted(terrain, { shape: 'ball', x: -880, y: -400, r: 15 });
 const sim = new Simulation(lvl, { parts: [] });
 const body = sim.goals[0].body;
 // put the ball on the floor at 600 px/s and let it slide: one call now,
 // in px, because the engine's own harness places a body and gives it a
 // velocity in the units the level is written in.
 sim.E.body_teleport(body, -800, -16, 0, 600, 0, 0);
 sim.E.body_set_vel(body, 600, 0, 0);
 for (let i = 0; i < 300; i++) sim._fixedStep();
 const p = sim._pose(body);
 sim.destroy();
 return p.x + 800;
 };
 const boxFloor = [{ type: 'box', x: 0, y: 60, w: 1800, h: 120, radius: 0 }];
 const dChain = slideOn([slab('cw')]);
 const dBox = slideOn(boxFloor);
 gate('7. a ball rolls the same distance on painted and box floors (±2%)',
 Math.abs(dChain - dBox) < Math.max(2, Math.abs(dBox) * 0.02),
 `painted ${dChain.toFixed(1)} px vs box ${dBox.toFixed(1)} px`);
}

// ---------- gate 8: deliveries that cross the goal at speed (§7.1) ----------
{
 // A wall sweeping at the top travel notch shoves a crate clean through the
 // goal zone. It is fully inside for ~7 frames — fewer than WIN_FRAMES — and
 // no machine can do better, so the win has to come from the run ENDING, not
 // from out-waiting it.
 const crossing = (zoneW, wallSpeed) => ({
 terrain: [
 { type: 'box', x: 0, y: 30, w: 2000, h: 60 },
 { type: 'box', x: -600, y: -100, w: 120, h: 200,
 path: { pts: [{ x: 600, y: -100 }], mode: 'once', speed: wallSpeed } },
 ],
 props: [],
 buildZones: [{ x: -400, y: -75, w: 200, h: 150 }],
 goalZones: [{ x: 0, y: -52, w: zoneW, h: 104 }],
 goalObjs: [{ shape: 'box', x: -400, y: -15, w: 30, h: 30 }],
 win: 'goalObj',
 });
 const run = (level, frames = 900) => {
 const sim = new Simulation(level, { parts: [] });
 let best = 0;
 for (let i = 0; i < frames && !sim.won; i++) { sim._fixedStep(); best = Math.max(best, sim._winStreak); }
 const out = { won: sim.won, t: sim.winTime, best };
 sim.destroy();
 return out;
 };

 // The negative that keeps the rule honest: a zone NARROWER than the crate.
 // The crate passes straight through it — overlapping the whole way — but is
 // never once fully inside, so it must not count. Without this, "delivered"
 // would quietly degrade into "touched".
 const clip = run(crossing(20, 800));
 gate('8. a crate that overlaps but never fits inside does NOT solve',
 !clip.won && clip.best === 0, `won ${clip.won}, best streak ${clip.best}`);

 // And a delivery that arrives slowly still wins the old way, on the dwell —
 // this is what keeps every recorded solve time to the frame.
 const slow = run(crossing(120, 137));
 gate('8. a slow delivery still wins on the full dwell',
 slow.won && slow.best >= WIN_FRAMES, `won ${slow.won} with ${slow.best} contained frames`);
}

// ---------- gate 15: every wheel pushes the same ----------
//
// Two wrong answers preceded this one. maxMotorTorque was flat for the life of
// the project, and force is torque/radius, so doubling the wheel HALVED its push
// while quadrupling its mass — the big wheel was the weakest piece in the game
// and players ganged up small ones because small ones were genuinely strongest.
// The fix took torque to ∝ r⁴, matching the lone drive's I · LONE_TORQUE, which
// cured the inversion but over-corrected: the big wheel became 64× the push of
// the small one AND kept its higher top speed, so nothing else had a niche.
//
// **It is now torque ∝ r** (2026-08-12, "just double for the large wheel and
// half for the small"), which divides out to a rim force that is the SAME on
// every wheel. Size buys top speed, reach and clearance; it no longer buys
// force. Gated as a shape, not a number.
{
 const rim = (px) => wheelMotorTorque(px) / (px / PPM);
 const forces = WHEEL_SIZES.map(rim);
 const [small, std, big] = [...WHEEL_SIZES].sort((a, b) => a - b);
 // ∝ r, not flat, since 2026-08-19 — see the second half of the note on
 // wheelMotorTorque: torque went to ∝ r² so the big wheel is the four-wheel
 // gang was measuring against, which divides out to a rim force that
 // doubles with the wheel and halves with it. Gated as a shape, not a number.
 gate('15. rim force scales with the wheel: big pushes twice, small half',
 Math.abs(rim(big) / rim(std) - 2) < 1e-9 && Math.abs(rim(small) / rim(std) - 0.5) < 1e-9,
 WHEEL_SIZES.map((px, i) => `${px}px ${forces[i].toFixed(1)}N`).join(' '));
 gate('15. the standard wheel is untouched', wheelMotorTorque(STD_WHEEL_R) === MOTOR_TORQUE,
 `${wheelMotorTorque(STD_WHEEL_R)} N·m`);
 // 4× and a quarter across the ladder is exactly ∝ r² — and the ladder is
 // read from WHEEL_SIZES rather than written out, because the FC-unit cut
 // moved it once already (7.5/15/30 → 10/20/40).
 gate('15. torque is 4× the standard on the big wheel and a quarter on the small',
 Math.abs(wheelMotorTorque(big) / wheelMotorTorque(std) - 4) < 1e-9
 && Math.abs(wheelMotorTorque(small) / wheelMotorTorque(std) - 0.25) < 1e-9,
 `big/std ${(wheelMotorTorque(big) / wheelMotorTorque(std)).toFixed(1)}×, ` +
 `small/std ${(wheelMotorTorque(small) / wheelMotorTorque(std)).toFixed(2)}×`);
 // **The claim the whole change rests on**: one wheel behaves the same whether
 // it is pinned into a machine or driving alone. The lone drive's clamp IS
 // wheelMotorTorque now, so this is one law rather than two that agree — which
 // is what the r⁴ version could only promise while both happened to be ∝ I.
 gate('15. the lone drive is capped by the joint motor\'s own torque',
 WHEEL_SIZES.every((px) => wheelMotorTorque(px) === MOTOR_TORQUE * (px / STD_WHEEL_R) ** 2),
 'one law for both ways of driving a wheel');
 // A degenerate or missing radius must not produce NaN torque — that is a
 // silent dead motor, not a crash.
 gate('15. a wheel with no radius falls back rather than going NaN',
 wheelMotorTorque(undefined) === MOTOR_TORQUE && isFinite(wheelMotorTorque(0)));

 // And it must actually MOVE: the big wheel could climb 12° before, the
 // standard one 38°. Measured, not asserted from the formula.
 const climb = (px, deg) => {
 const a = -deg * Math.PI / 180, H = 60;
 const cx = (H + px) * Math.sin(a), cy = 300 - (H + px) * Math.cos(a);
 const dx = Math.cos(a), dy = Math.sin(a);
 const sim = new Simulation({
 terrain: [{ type: 'box', x: 0, y: 300, w: 9000, h: 120, angle: a }], props: [],
 buildZones: [{ x: 0, y: -200, w: 4000, h: 2000 }], goalZones: [], goalObjs: [], win: 'goalObj',
 }, { parts: [
 { t: 'rod', kind: 'wood', x1: cx - 90 * dx, y1: cy - 90 * dy, x2: cx, y2: cy, id: 'r' },
 { t: 'wheel', kind: 'cw', x: cx, y: cy, r: px, id: 'w' },
 ] });
 const b = sim.wheels[0].body, y0 = sim._pose(b).y;
 for (let i = 0; i < 600; i++) sim._fixedStep();
 const gained = y0 - sim._pose(b).y;
 sim.destroy();
 return gained;
 };
 // **18°, not 25°, and the second clause is the real claim** (2026-08-14). The
 // angle moved because wheel friction became FC's 0.7 (was 2.0), which drops
 // the combined grip limit against granite from 52.5° to 37.6° and takes this
 // rig's whole scale down with it — the wheel has to drag a 90 px stick that
 // has traction of its own to overcome, so it gives out well below the bare
 // limit. Swept, height gained in 10 s:
 //
 // deg 5 10 12 15 18 20 22 25
 // r=7.5 41 1 1 0 0 -0 -0 -1
 // r=15 62 117 135 141 50 1 1 -0
 // r=30 62 120 141 169 183 164 60 -0
 //
 // What the gate is FOR is unaffected and is now asserted directly: under the
 // old r⁴ law the big wheel was the weakest piece in the game (12° against the
 // standard wheel's 38°), and it is now the strongest. Pinning "climbs 25°"
 // pinned the grip constant by accident; pinning "out-climbs the standard
 // wheel" pins the torque law, which is what this section is about.
 gate('15. a big wheel now climbs a slope it used to slide back down',
 climb(30, 18) > 20 && climb(30, 18) > climb(15, 18),
 `gained ${climb(30, 18).toFixed(0)} px on 18°, against the standard wheel's ${climb(15, 18).toFixed(0)} px (r⁴ gave the big wheel 12° against 38°)`);
}

// **Gate 16 is gone** (2026-08-20). It gated continuous collision: which
// bodies were flagged bullets, that a flagged rod swept against a wheel, that
// the flag came back when a stack settled. Every one of those mechanisms went
// with Box2D v3 on 2026-08-17 — this engine has no bullets, no sub-stepping
// and no sweep, and FC's own machines tunnel their sticks at speed. The
// reasoning is kept where it belongs, beside TORQUE_FC in sim.js
// ("Continuous collision died with the engine, and that is FC being FC"). A
// gate that asks a deleted solver what it decided cannot go red for a reason
// anyone can act on, and this one took the whole file down with it: it called
// box2d(), which throws on sight since the cut, so gates 4 through 31 had not
// run since.

// ---------- gate 14: where the editor leaves a piece, the sim leaves it alone ----------
//
// The editor's job is to hand the physics a level that is already at rest.
// A drag that stops against a surface used to leave the piece a full pixel
// INSIDE it — the last spot the validity rule still tolerated — so pressing
// Play made everything pop out as Box2D depenetrated. `REST_GAP` is the
// editor's answer; this is the half that proves it was the right number.
//
// The threshold is the solver's OWN slop and not a hair more. FC's engine
// depenetrates to `b2_linearSlop` — 0.15 px, in b2Settings.h — so a piece
// handed to it REST_GAP clear of the floor settles exactly that far in and
// stops: 0.16 px, on the frame, for a prop, a wheel, a goal piece and a ball.
// (The v3 backend soft-landed instead and measured `gap + 0.0018 px`; the
// number moved with the engine, the claim did not.) A piece left a PIXEL out
// still moves a pixel, which is what the control at the bottom proves, so
// this stays a gate on the editor agreeing with the solver rather than a
// tolerance to hide in.
{
 const REST_GAP = 0.01; // game.js's constant, restated (§16)
 const SLOP = 0.15; // b2_linearSlop, engine/include/box2d/b2Settings.h
 const SETTLE = REST_GAP + SLOP + 0.005; // what "does not move" means on this engine
 // A wood stick SIMULATES 8 px thick (physics profile `rod.woodThick`) and
 // draws thinner — so half of it is 4, not ROD_THICK / 2. At 2 it was placed
 // two pixels inside the floor and popped out 1.84, which is this gate
 // catching a stale constant in its own rig rather than a solver that moves
 // resting pieces.
 const ROD_HALF = (physicsOf().rod?.woodThick ?? 4) / 2;
 const floor = { type: 'box', x: 0, y: 30, w: 1200, h: 60 }; // walkable top at y = 0
 const base = (over = {}) => ({
 terrain: [floor], props: [], buildZones: [{ x: 0, y: -100, w: 700, h: 400 }],
 goalZones: [{ x: 500, y: -50, w: 100, h: 100 }], goalObjs: [], win: 'goalObj', ...over,
 });

 // Each piece placed exactly where a stopped drag leaves it: REST_GAP clear of
 // the floor. (verify-editor.mjs gate 12 is what proves the editor really does
 // put them here; this gate is what proves here is the right place.)
 // TWO numbers, because they are two different claims. SETTLE is where the
 // piece ends up: REST_GAP + the slop, per contact under it. CREEP is what
 // matters — that it then stays there for the rest of the run, to a
 // hundredth of a pixel.
 //
 // The first step is not counted, and that is not a let-off: a piece hovering
 // REST_GAP above the floor has no impulse to stop it, so it falls g·dt² —
 // 300/900 = ⅓ px on FC's 30 Hz clock — into contact before the solver takes
 // it back out to the slop. No placement rule avoids it and no eye can see
 // it. What the editor's REST_GAP buys is the pop it PREVENTS, which is the
 // control at the bottom: a piece left a pixel inside moves a whole pixel.
 const still = (label, level, design, pick, contacts = 1, frames = 240) => {
 const sim = new Simulation(level, design, { goalPositions: (level.goalObjs || []).map(g => ({ x: g.x, y: g.y })) });
 const rec = pick(sim);
 const p0 = sim._pose(rec.body);
 let rest = null, creep = 0;
 for (let i = 0; i < frames; i++) {
 sim._fixedStep();
 const p = sim._pose(rec.body);
 if (i === 29) rest = p; // 1 s in: settled
 else if (i > 29) creep = Math.max(creep, Math.hypot(p.x - rest.x, p.y - rest.y));
 }
 sim.destroy();
 const settled = Math.hypot(rest.x - p0.x, rest.y - p0.y);
 gate(`14. a ${label} left at REST_GAP settles into the slop and stays there`,
 settled < SETTLE * contacts && creep < 0.01,
 `${settled.toFixed(5)} px settled (slop ${SLOP} × ${contacts} contact${contacts > 1 ? 's' : ''}), ` +
 `then ${creep.toFixed(5)} px over ${((frames - 30) / 30).toFixed(0)} s`);
 return settled;
 };

 const y = (half) => -half - REST_GAP;
 still('prop', base({ props: [{ shape: 'box', x: 0, y: y(15), w: 30, h: 30 }] }), { parts: [] }, s => s.props[0]);
 still('goal piece', base({ goalObjs: [{ shape: 'box', x: 0, y: y(15), w: 30, h: 30 }] }), { parts: [] }, s => s.goals[0]);
 still('wheel', base(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: y(15), r: 15, id: 'w' }] }, s => s.wheels[0]);
 still('rod', base(), { parts: [{ t: 'rod', kind: 'wood', x1: -40, y1: y(ROD_HALF), x2: 40, y2: y(ROD_HALF), id: 'r' }] }, s => s.rods[0]);
 still('goal ball', base({ goalObjs: [{ shape: 'ball', x: 0, y: y(15), r: 15 }] }), { parts: [] }, s => s.goals[0]);

 // A stack: a prop resting on a prop resting on the floor, each at REST_GAP.
 // Contact chains are where a too-small gap would show up as creep.
 still('stacked prop', base({
 props: [{ shape: 'box', x: 0, y: y(15), w: 40, h: 30 },
 { shape: 'box', x: 0, y: -30 - 15 - REST_GAP * 2, w: 40, h: 30 }],
 }), { parts: [] }, s => s.props[1], 2); // two contacts under it: the prop below, and the floor

 // ...and the control: a piece left where the OLD sweep put it — a pixel into
 // the floor — really does move, so the gate above is measuring something.
 {
 const sim = new Simulation(base({ props: [{ shape: 'box', x: 0, y: -14, w: 30, h: 30 }] }), { parts: [] });
 const p0 = sim._pose(sim.props[0].body);
 let worst = 0;
 for (let i = 0; i < 240; i++) { sim._fixedStep(); worst = Math.max(worst, Math.abs(sim._pose(sim.props[0].body).y - p0.y)); }
 sim.destroy();
 gate('14. ...while a piece left a pixel INSIDE the floor visibly pops out',
 worst > 0.5, `${worst.toFixed(4)} px — the behaviour REST_GAP replaced`);
 }
}

// ---------- gate 17: radial gravity — mini planets (§5.10) ----------
//
// Everything here is measured against the pinned binary, because every claim
// in §5.10 is a claim about what the solver actually does: that pieces rest on
// every side, that they are allowed to SLEEP there, that a wheel drives round,
// that a sideways launch orbits, that the nearest planet wins, and — the one
// that is easy to get wrong and impossible to see — that the void stops being
// a line and becomes a circle.
{
 const R = 120; // planet radius, px (4 m)
 const planetLevel = (extra = {}) => ({
 terrain: [{ type: 'ball', x: 0, y: 0, r: R, planet: {}, ...(extra.planet || {}) }, ...(extra.terrain || [])],
 props: extra.props || [],
 buildZones: [{ x: 0, y: -300, w: 400, h: 120 }],
 goalZones: [{ x: 360, y: 0, w: 120, h: 120 }],
 goalObjs: extra.goalObjs || [{ shape: 'ball', x: 400, y: 0, r: 15 }],
 win: 'goalObj',
 });
 const rOf = (sim, rec) => { const p = sim._pose(rec.body); return Math.hypot(p.x, p.y); };

 // 17a. dropped from four sides: each rests on ITS OWN side, at the surface,
 // and is allowed to fall asleep. (With world gravity still on underneath,
 // all four would end up in a heap at the south pole instead.)
 {
 const D = 320;
 const lvl = planetLevel({ props: [
 { shape: 'ball', x: 0, y: -D, r: 12 }, { shape: 'ball', x: D, y: 0, r: 12 },
 { shape: 'ball', x: 0, y: D, r: 12 }, { shape: 'ball', x: -D, y: 0, r: 12 },
 ]});
 const sim = new Simulation(lvl, { parts: [] });
 for (let i = 0; i < 1500; i++) sim._fixedStep();
 const want = R + 12;
 const rs = sim.props.map((p, i) => rOf(sim, sim.props[i]));
 const poses = sim.props.map((p) => sim._pose(p.body));
 const asleep = sim.props.every((p) => sim.E.body_sleeping(p.body) === 1);
 gate('17. a piece dropped at N/E/S/W rests on the surface it fell toward',
 rs.every((r) => Math.abs(r - want) < 0.5), `r = ${rs.map(r => r.toFixed(2)).join(' / ')} (want ${want})`);
 // ...on its OWN side: each one kept the quadrant it started in
 const sides = [poses[0].y < -R, poses[1].x > R, poses[2].y > R, poses[3].x < -R];
 gate('17. …each on its own side, not in a heap at the bottom', sides.every(Boolean),
 poses.map(p => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' '));
 gate('17. …and a piece at rest on a planet is allowed to SLEEP', asleep,
 'wake=false on the applied force — pass true and nothing in a planet level ever sleeps');
 sim.destroy();
 }

 // 17b. determinism (§5.8): the field is a pure function of body poses, so
 // two identical planet sims must stay bit-identical, not merely close.
 {
 const lvl = () => planetLevel({ props: [{ shape: 'ball', x: 0, y: -300, r: 12 }, { shape: 'box', x: 260, y: -80, w: 30, h: 30 }] });
 const design = { parts: [{ t: 'wheel', kind: 'cw', x: 0, y: -R - 15, r: 15, id: 'w' }] };
 const a = new Simulation(lvl(), design), b = new Simulation(lvl(), design);
 for (let i = 0; i < 600; i++) { a._fixedStep(); b._fixedStep(); }
 let identical = true;
 const bodies = (s) => [...s.props, ...s.goals, ...s.wheels].map(r => r.body);
 const A = bodies(a), B = bodies(b);
 for (let i = 0; i < A.length; i++) {
 const pa = a._pose(A[i]), pb = b._pose(B[i]);
 if (pa.x !== pb.x || pa.y !== pb.y || pa.c !== pb.c || pa.s !== pb.s) identical = false;
 }
 gate('17. a planet level is deterministic — 600 frames bit-identical', identical);
 a.destroy(); b.destroy();
 }

 // 17c. a powered wheel drives AROUND the world, past the point where "down"
 // has rotated 90° from where it started.
 {
 const sim = new Simulation(planetLevel(), {
 parts: [{ t: 'wheel', kind: 'cw', x: 0, y: -R - 15, r: 15, id: 'w' }],
 });
 for (let i = 0; i < 1200; i++) sim._fixedStep();
 const end = sim._pose(sim.wheels[0].body);
 gate('17. …and is still ON the surface when it gets there',
 Math.abs(Math.hypot(end.x, end.y) - (R + 15)) < 3,
 `r = ${Math.hypot(end.x, end.y).toFixed(2)} (surface ${R + 15})`);
 sim.destroy();
 }

 // 17d. a sideways launch holds a quasi-orbit for 20 s — the showpiece. Not a
 // Kepler ellipse: constant-magnitude gravity gives a precessing rosette, so
 // the assertion is that it neither hits the ground nor leaves.
 {
 const rOrbit = 420;
 const sim = new Simulation(planetLevel({
 goalObjs: [{ shape: 'ball', x: 0, y: -rOrbit, r: 12 }],
 }), { parts: [] });
 // v = sqrt(g*r) — the circular speed for a constant field at this radius.
 // px/s straight into the engine's own setter: it is px-native, so the /30
 // that used to sit here belonged to the metres-based binding that went.
 const v = Math.sqrt(13 * 30 * rOrbit);
 sim.E.body_set_vel(sim.goals[0].body, v, 0, 0);
 let lo = Infinity, hi = 0, laps = 0, prev = Math.atan2(0, -1), turned = 0;
 for (let i = 0; i < 1200; i++) {
 sim._fixedStep();
 const p = sim._pose(sim.goals[0].body);
 const r = Math.hypot(p.x, p.y);
 lo = Math.min(lo, r); hi = Math.max(hi, r);
 const a = Math.atan2(p.y, p.x);
 let d = a - prev;
 while (d > Math.PI) d -= 2 * Math.PI;
 while (d < -Math.PI) d += 2 * Math.PI;
 turned += d; prev = a;
 }
 laps = Math.abs(turned) / (2 * Math.PI);
 gate('17. a sideways launch holds an orbit for 20 s — never lands, never leaves',
 lo > R + 20 && hi < rOrbit * 1.6 && !sim.goalLost,
 `r ${lo.toFixed(0)}..${hi.toFixed(0)} px (launched at ${rOrbit}), ${laps.toFixed(1)} laps`);
 gate('17. …and it really goes round, rather than hanging there', laps > 1.5,
 `${laps.toFixed(2)} complete circuits`);
 sim.destroy();
 }

 // 17e. THE VOID IS A CIRCLE. An orbiting piece passes a long way "below" the
 // level — under the old y line it is written off as fallen out of the world
 // while it is in a perfectly good orbit. The control matters as much as the
 // assertion: the gate first proves the old rule WOULD have fired.
 {
 const rOrbit = 900;
 const sim = new Simulation(planetLevel({
 goalObjs: [{ shape: 'ball', x: 0, y: -rOrbit, r: 12 }],
 }), { parts: [] });
 const v = Math.sqrt(13 * 30 * rOrbit);
 sim.E.body_set_vel(sim.goals[0].body, v, 0, 0);
 const oldLine = sim.levelMaxY + VOID_DROP;
 let maxY = -Infinity;
 for (let i = 0; i < 900; i++) { sim._fixedStep(); maxY = Math.max(maxY, sim._pose(sim.goals[0].body).y); }
 gate('17. (control) an orbiting piece really does pass below the old void LINE',
 maxY > oldLine, `reached y ${maxY.toFixed(0)}, old line was ${oldLine.toFixed(0)}`);
 gate('17. …and the circular void does not call it lost', !sim.goalLost,
 `void circle r ${sim.voidLine.outside.toFixed(0)} about (${sim.voidLine.x.toFixed(0)}, ${sim.voidLine.y.toFixed(0)})`);
 sim.destroy();
 }

 // 17f. …but a piece thrown hard enough IS gone, and one thrown ordinarily
 // hard is not. Both directions, or VOID_ESCAPE is just a number nobody
 // measured.
 {
 const launch = (speed) => {
 const sim = new Simulation(planetLevel({ goalObjs: [{ shape: 'ball', x: 0, y: -R - 15, r: 12 }] }), { parts: [] });
 sim.E.body_set_vel(sim.goals[0].body, 0, -speed, 0); // straight up, away from the planet
 let peak = 0;
 for (let i = 0; i < 1800; i++) { sim._fixedStep(); peak = Math.max(peak, rOf(sim, sim.goals[0])); }
 const lost = sim.goalLost;
 sim.destroy();
 return { lost, peak };
 };
 const slow = launch(1000), fast = launch(3000);
 gate('17. a piece launched at 1000 px/s comes home rather than being written off',
 !slow.lost, `peaked at r ${slow.peak.toFixed(0)} px`);
 gate('17. …and one launched at 3000 px/s has genuinely escaped', fast.lost,
 `reached r ${fast.peak.toFixed(0)} px`);
 }

 // 17g. two planets: nearest-wins keeps every surface a surface. Summing both
 // pulls (real superposition at constant magnitude) points along the bisector
 // and lifts a resting piece off the ground — this is the gate that fails.
 {
 const B = 900;
 const lvl = {
 terrain: [
 { type: 'ball', x: 0, y: 0, r: R, planet: {} },
 { type: 'ball', x: B, y: 0, r: 60, planet: { pull: 1 } },
 ],
 props: [
 { shape: 'ball', x: -R - 40, y: 0, r: 12 }, // hard against planet A, facing AWAY from B
 { shape: 'ball', x: B / 2 + 120, y: -20, r: 12 }, // past the neutral line, B's side
 ],
 buildZones: [{ x: 0, y: -320, w: 300, h: 120 }],
 goalZones: [{ x: 0, y: 320, w: 120, h: 120 }],
 goalObjs: [{ shape: 'ball', x: 0, y: -R - 15, r: 15 }],
 win: 'goalObj',
 };
 const sim = new Simulation(lvl, { parts: [] });
 for (let i = 0; i < 1800; i++) sim._fixedStep();
 const a = sim._pose(sim.props[0].body), b = sim._pose(sim.props[1].body);
 const dA = Math.hypot(a.x, a.y), dB = Math.hypot(b.x - B, b.y);
 gate('17. with two planets, a piece on the far side of one STAYS on it',
 Math.abs(dA - (R + 12)) < 0.5, `r from A ${dA.toFixed(2)} (surface ${R + 12})`);
 gate('17. …and a piece past the neutral line falls to the OTHER one',
 Math.abs(dB - (60 + 12)) < 0.5, `r from B ${dB.toFixed(2)} (surface ${72})`);
 sim.destroy();
 }

 // 17h. nearest is by SURFACE distance, not centre distance — the pure
 // function, so the rule is pinned even where no level exercises it. Hovering
 // 100 px above a big planet must never be claimed by a small one 370 px away.
 {
 const big = { x: 0, y: 0, r: 300, pull: 1 }, small = { x: 800, y: 0, r: 30, pull: 1 };
 const near = nearestPlanet(400, 0, [big, small]);
 const byCentre = Math.abs(400 - 0) < Math.abs(400 - 800);
 gate('17. nearest planet is by SURFACE distance, not centre distance',
 near === big && !byCentre, 'a point 100 px above the big planet, 370 px from the small one');
 }

 // 17i. the pull dial does something, monotonically.
 {
 const fall = (pull) => {
 const sim = new Simulation({
 terrain: [{ type: 'ball', x: 0, y: 0, r: R, planet: pull === 1 ? {} : { pull } }],
 props: [{ shape: 'ball', x: 0, y: -400, r: 12 }],
 buildZones: [{ x: 0, y: -600, w: 200, h: 100 }],
 goalZones: [{ x: 300, y: 0, w: 120, h: 120 }],
 goalObjs: [{ shape: 'ball', x: 300, y: 0, r: 15 }],
 win: 'goalObj',
 }, { parts: [] });
 let frames = 0;
 for (let i = 0; i < 1200; i++) {
 sim._fixedStep(); frames++;
 if (rOf(sim, sim.props[0]) < R + 14) break;
 }
 sim.destroy();
 return frames;
 };
 const [t025, t1, t3] = [fall(0.25), fall(1), fall(3)];
 gate('17. a stronger pull drops a piece faster (0.25× / 1× / 3×)',
 t025 > t1 && t1 > t3, `${(t025 / 60).toFixed(2)} s / ${(t1 / 60).toFixed(2)} s / ${(t3 / 60).toFixed(2)} s to fall 280 px`);
 }

 // 17j. a planet on a motion path takes its gravity with it — the field is
 // read off the LIVE body pose, not the authored one.
 {
 const sim = new Simulation({
 terrain: [{ type: 'ball', x: 0, y: 0, r: R, planet: {},
 path: { pts: [{ x: 0, y: 0 }, { x: 600, y: 0 }], mode: 'pingpong', speed: 120 } }],
 props: [{ shape: 'ball', x: 0, y: -R - 12, r: 12 }],
 buildZones: [{ x: 0, y: -400, w: 200, h: 100 }],
 goalZones: [{ x: 0, y: 400, w: 120, h: 120 }],
 goalObjs: [{ shape: 'ball', x: 0, y: 400, r: 15 }],
 win: 'goalObj',
 }, { parts: [] });
 // 4 s in: far enough along the outward leg that the planet has left the
 // passenger's authored position well behind (pingpong turns at 5 s)
 for (let i = 0; i < 240; i++) sim._fixedStep();
 const centre = sim._pose(sim.terrain[0].body);
 const p = sim._pose(sim.props[0].body);
 const gap = Math.hypot(p.x - centre.x, p.y - centre.y);
 // **The third clause asks that the passenger was CARRIED, not that it stayed
 // on top** (2026-08-14). It used to be `|p.x − centre.x| < R` — "still in the
 // upper hemisphere" — and that was never testing the field: it was testing
 // TRACTION, and it only passed because 13 m/s² happened to sit just above a
 // stick/slip cliff. Swept against the same rig, lateral offset after 4 s:
 //
 // g 13 11 10 9 8 7.5 6
 // round 2° 13° 76° 79° 80° 81° 85°
 //
 // Everything from 10 down slides to the equator and rides there. The reason
 // is not the field: a passenger needs m·a of friction to be dragged along,
 // which the path fixes, while the grip available is μ·m·g·cosθ — so halving
 // gravity halves the grip against an unchanged demand. That is the same
 // trade a crate on a moving PLATFORM has had since flat gravity became 7.5
 // on 2026-08-12, and a planet matching it is the entire point of the fix.
 // Asking for the old hemisphere back would be asking for a planet stickier
 // than the ground.
 //
 // What the gate claims is that the field travels, and the evidence for that
 // is the passenger sitting exactly on the moved planet's SURFACE (a field
 // left behind at the authored centre would drop it 391 px away) having been
 // carried far from where it was authored.
 gate('17. a planet on a motion path carries its gravity field with it',
 centre.x > 200 && Math.abs(gap - (R + 12)) < 8 && p.x > 200,
 `planet moved to x ${centre.x.toFixed(0)}; passenger carried to x ${p.x.toFixed(0)}, still ${gap.toFixed(1)} px from its centre (surface ${R + 12})`);
 sim.destroy();
 }

 // 17k. WHAT IT DRAWS. A planet is invisible as gravity — the halo and the
 // arrow field are the only things that say a ball pulls, and an arrow
 // pointing the wrong way is a lie the physics will not correct. Recorded
 // against a stub 2D context rather than eyes, because a sign error here
 // looks like a picture either way.
 {
 const calls = [];
 const rec = new Proxy({}, {
 get: (_, k) => {
 if (k === 'createRadialGradient') return (...a) => { calls.push(['gradient', ...a]); return { addColorStop() {} }; };
 if (k === 'canvas') return { width: 800, height: 600 };
 if (typeof k === 'symbol') return undefined;
 return (...a) => { calls.push([k, ...a]); };
 },
 set: () => true,
 });
 const cam = new Camera();
 cam.setViewport(800, 600);
 cam.x = 0; cam.y = 0; cam.zoom = 1;
 const planets = [{ x: 0, y: 0, r: 120, pull: 1 }];

 drawPlanetHalos(rec, planets);
 const arcs = calls.filter(c => c[0] === 'arc');
 gate('17. the halo draws one ring per planet, wider than the planet itself',
 arcs.length === 1 && arcs[0][3] > 120, `radius ${arcs[0]?.[3]?.toFixed(0)} around r120`);

 calls.length = 0;
 drawPlanetHalos(rec, []);
 gate('17. …and nothing at all in a level with no planet', calls.length === 0);

 calls.length = 0;
 drawGravityField(rec, cam, planets);
 // every tick is drawn as moveTo(tail) → lineTo(tip); the first pair is
 // enough to ask the only question that matters about it
 const moves = calls.filter(c => c[0] === 'moveTo');
 const lines = calls.filter(c => c[0] === 'lineTo');
 let pointsIn = 0, pointsOut = 0;
 for (let i = 0; i < moves.length; i += 3) { // shaft, then two barbs
 const tail = { x: moves[i][1], y: moves[i][2] };
 const tip = { x: lines[i][1], y: lines[i][2] };
 const before = Math.hypot(tail.x, tail.y), after = Math.hypot(tip.x, tip.y);
 if (after < before) pointsIn++; else pointsOut++;
 }
 gate('17. every gravity arrow points AT the planet, none away from it',
 pointsIn > 20 && pointsOut === 0, `${pointsIn} arrows, all inward`);
 // and none of them is drawn inside the planet, where "down" has no meaning
 const inside = moves.some(m => Math.hypot(m[1], m[2]) < 120);
 gate('17. …and none is drawn inside the planet', !inside);
 }

 // 17l. and the whole thing is opt-in: no planet, nothing changes.
 {
 const sim = new Simulation(flatLevel(), { parts: [] });
 gate('17. a level with no planet is untouched — y-down gravity, straight void line',
 sim.radial === false && sim.voidLine.outside === undefined && sim.planets.length === 0,
 `void below y ${sim.voidLine.below}`);
 sim.destroy();
 }
}

// ---------- gate 19: every terrain shape winds the same way (§10.2) ----------
//
// All the static same-texture pieces go into ONE Path2D and are filled once, so
// abutting slabs read as a single silhouette. That fill is canvas's default
// NONZERO rule: overlapping subpaths union when they wind the same way and
// CANCEL when they oppose. So the winding is not a detail of the drawing code —
// it is load-bearing, and getting it wrong punches a hole in the world showing
// the background through solid ground, while the physics (which normalises)
// happily keeps colliding with it.
//
// A painted loop used to be emitted in whatever direction the author traced it,
// which made the bug a coin flip on cursor direction. These gates measure the
// EMITTED path rather than the stored data, and ask the one question that
// matters: does every shape come out clockwise?
{
 // A recording stand-in for Path2D: keeps the points so their signed area can
 // be measured. Bézier control points are deliberately ignored — the winding
 // of the anchor ring is what nonzero cares about.
 const recorder = () => {
 const pts = [];
 return {
 pts,
 moveTo(x, y) { pts.push({ x, y }); },
 lineTo(x, y) { pts.push({ x, y }); },
 bezierCurveTo(_a, _b, _c, _d, x, y) { pts.push({ x, y }); },
 arc(cx, cy, r) { for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } },
 arcTo(_x1, _y1, x2, y2) { pts.push({ x: x2, y: y2 }); },
 closePath() {},
 };
 };
 const windingOf = (t) => { const r = recorder(); terrainPath(r, t, null); return polyArea2(r.pts); };

 // the same square, traced both ways round
 const ring = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
 const paintFrom = (pts) => {
 const [first, ...rest] = pts;
 return { type: 'paint', x: first[0], y: first[1],
 pts: [...rest.map(([x, y]) => ({ x, y })), { x: first[0], y: first[1] }] };
 };
 const cw = windingOf(paintFrom(ring));
 const ccw = windingOf(paintFrom([...ring].reverse()));
 gate('19. a painted loop renders CLOCKWISE however it was traced',
 cw > 0 && ccw > 0, `traced cw ${cw > 0 ? '+' : '−'}, traced ccw ${ccw > 0 ? '+' : '−'}`);

 // …and it is the same direction every other terrain shape uses, which is the
 // whole point — they share one Path2D and one nonzero fill
 const box = windingOf({ type: 'box', x: 0, y: 0, w: 200, h: 120, radius: 0 });
 const round = windingOf({ type: 'box', x: 0, y: 0, w: 200, h: 120, radius: 8 });
 const ball = windingOf({ type: 'ball', x: 0, y: 0, r: 60 });
 gate('19. …the same way a box, a rounded box and a ball do',
 box > 0 && round > 0 && ball > 0,
 `box ${box > 0 ? '+' : '−'}, rounded ${round > 0 ? '+' : '−'}, ball ${ball > 0 ? '+' : '−'}`);

 // the regression itself: an anticlockwise loop unioned with a box must not
 // cancel. Same-sign windings is exactly the condition nonzero needs.
 gate('19. …so an overlapping box can never cancel it into a hole',
 Math.sign(ccw) === Math.sign(box) && Math.sign(cw) === Math.sign(box),
 'all four subpath windings agree');

 // and the reversal must not have moved the shape — same area, same corners
 gate('19. …and reversing the traversal draws the identical shape',
 Math.abs(Math.abs(cw) - Math.abs(ccw)) < 1e-6,
 `|area| ${Math.abs(cw).toFixed(3)} vs ${Math.abs(ccw).toFixed(3)}`);
}

// ---------- gate 20: the background layer is not in the world (§10.5) ----------
//
// `level.backdrop` is scenery. The one claim that matters is that the SIM never
// sees it — everything else about the feature is cosmetic, and this is not:
// a decoration that quietly became solid would be a level that plays wrong with
// nothing on screen to explain it.
//
// It is a separate ARRAY rather than a flag on terrain precisely so this gate
// can be about identity rather than about a filter working correctly.
{
 const scenery = [
 { type: 'box', x: 0, y: -200, w: 600, h: 40, texture: 'granite' },
 { type: 'ball', x: -200, y: -260, r: 80, texture: 'moss' },
 ];
 const base = () => ({
 terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
 props: [], buildZones: [{ x: 0, y: -75, w: 600, h: 150 }],
 goalZones: [{ x: 300, y: -52, w: 120, h: 104 }],
 goalObjs: [{ shape: 'ball', x: -200, y: -15, r: 15 }],
 win: 'goalObj',
 });
 const plain = new Simulation(base(), { parts: [] });
 // the background is a WHOLE level, with a machine of its own in its
 // fixedParts — a little car, driving by in the distance
 const backLevel = {
 terrain: scenery, props: [{ shape: 'ball', x: 60, y: -240, r: 14 }],
 fixedParts: [
 { t: 'wheel', kind: 'cw', x: -260, y: -232, r: 15, id: 'bw1' },
 { t: 'wheel', kind: 'cw', x: -200, y: -232, r: 15, id: 'bw2' },
 { t: 'rod', kind: 'wood', x1: -260, y1: -232, x2: -200, y2: -232, id: 'bax' },
 ],
 groups: {},
 };
 const withBg = new Simulation({ ...base(), backLevel }, { parts: [] });

 gate('20. a background level builds no bodies here — same terrain either way',
 withBg.terrain.length === plain.terrain.length && withBg.terrain.length === 1,
 `${plain.terrain.length} vs ${withBg.terrain.length} terrain bodies`);

 // …and it does not move the void line, which is computed from the things
 // the level is MADE of. Scenery reaching further than the world must not
 // change where a piece counts as lost (§7.1).
 gate('20. …and it does not move the void line',
 withBg.levelMaxY === plain.levelMaxY,
 `levelMaxY ${plain.levelMaxY} vs ${withBg.levelMaxY}`);

 // the decisive one: identical simulation, bit for bit, with and without it
 // …and the background running ALONGSIDE must not disturb it either: its own
 // sim is stepped between the foreground's steps, exactly as the frame pump
 // does it, and the foreground must still come out bit-identical (§5.8).
 const bg = new Simulation(backLevel, { parts: [] });
 for (let i = 0; i < 240; i++) { plain._fixedStep(); withBg._fixedStep(); bg._fixedStep(); }
 const a = plain._pose(plain.goals[0].body), b = withBg._pose(withBg.goals[0].body);
 gate('20. …so 240 frames are bit-identical with scenery and without',
 a.x === b.x && a.y === b.y && a.c === b.c && a.s === b.s,
 `(${a.x}, ${a.y}) vs (${b.x}, ${b.y})`);
 plain.destroy(); withBg.destroy();
 gate('20. …while the background level really did simulate (its car moved)',
 Math.abs(bg._pose(bg.wheels[0].body).x - (-260)) > 5,
 `its wheel travelled to x ${bg._pose(bg.wheels[0].body).x.toFixed(1)} from -260`);
 bg.destroy();

 // The DRAW itself can only be gated this far here: drawTerrainAll needs
 // Path2D and a canvas for its texture tiles, neither of which exists in
 // node, and stubbing the whole 2D API would gate the stub rather than the
 // renderer. What is checkable is the contract around it — the perspective
 // numbers, and that an empty layer costs nothing (it returns before any of
 // that machinery is touched, which is also why this call is safe here).
 {
 gate('20. the layer is drawn smaller and faded',
 BACKDROP_SCALE > 0 && BACKDROP_SCALE < 1 && BACKDROP_ALPHA > 0 && BACKDROP_ALPHA < 1,
 `${Math.round(BACKDROP_SCALE * 100)}% at alpha ${BACKDROP_ALPHA}`);
 const calls = [];
 const rec = new Proxy({}, {
 get: (_, k) => (typeof k === 'symbol' ? undefined : (...a) => { calls.push([k, ...a]); }),
 set: () => true,
 });
 drawBackLevel(rec, { terrain: [], props: [], fixedParts: [] }, null, 0);
 gate('20. …and an empty layer touches the context not at all', calls.length === 0);
 }
 // **Soft, not blurry** (2026-08-23). The scenery's fade used to be
 // translucency — the layer blitted at 0.55, sky ghosting through every
 // piece, read as defocus. It is now an OPAQUE blit with the same recession
 // applied inside the layer as a sky-coloured source-atop wash: 0.55·piece +
 // 0.45·sky per pixel either way, so the tonal distance is unchanged and the
 // mush is gone. The draw cannot rasterise here (no canvas), so the wash is
 // held by the source and the derivations by the pure halves.
 {
 const src = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
 gate('20. the haze is a source-atop wash at exactly the old fade’s complement',
 src.includes("s.globalCompositeOperation = 'source-atop';")
 && src.includes('s.globalAlpha = 1 - alpha;'),
 '0.55·piece + 0.45·sky either way — same colour, no ghosting');
 gate('20. …and the blit is opaque only WITH a haze — the edit ghost keeps its translucency',
 src.includes('if (haze) {') && src.includes('} else ctx.globalAlpha = alpha;'),
 'a reference ghost MEANS see-through');
 const g = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
 gate('20. …and the game passes the level’s own sky as the haze',
 g.includes('haze: skyHazeOf(this.level.background),'));
 gate('20. skyHazeOf answers for every background and refuses junk politely',
 Object.keys(BACKGROUNDS).every((k) => skyHazeOf(k).startsWith('rgb('))
 && skyHazeOf('no-such-sky').startsWith('rgb('));
 // nearer, still behind: the sky must drift slower than the scenery layer
 // (or it reads as the nearest thing in the picture), and faster than the
 // old /2 that left the horizon near-frozen.
 gate('20. the sky drifts nearer than it did and still behind the scenery',
 [0.5, 0.8, 1].every((s2) => SKY_PARALLAX_OF(s2) < s2 && SKY_PARALLAX_OF(s2) > s2 / 2),
 'factor ' + SKY_PARALLAX_OF(1).toFixed(2) + ' of the layer’s drift');
 const m = src.match(/const RIDGE_RATIOS = \[([^\]]+)\];/);
 const ratios = m ? m[1].split(',').map(Number) : [];
 gate('20. the ridges stay ordered and none overtakes the sky’s own drift',
 ratios.length === 3 && ratios.every((r, i) => r > 0 && r < 1 && (i === 0 || r > ratios[i - 1])),
 '[' + ratios.join(', ') + ']');
 }
 // **The mountains are one soft layer** (2026-08-24, on report: "The
 // mountains still look like they are blurry as if I forgot my glasses. The
 // two layer nature makes that so. Just a soft actual blur would be better.
 // Or fade."). The crest strip — the second crisp layer whose doubled edge
 // WAS the forgot-my-glasses look — is gone, and the softness is his "or
 // fade": feather fills, because a real ctx.filter blur measured 15 ms a
 // frame at 2560×1440 against the feather's +0.6.
 {
 const src = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
 gate('20. the crest strip is gone — one layer per ridge',
 !/CREST_H/.test(src), 'two sharp edges close together is what a misfocused eye produces');
 const soft = src.match(/const RIDGE_SOFT = \[([^\]]+)\];/);
 const softs = soft ? soft[1].split(',').map(Number) : [];
 gate('20. …and the feather widens with distance, like a focused eye',
 softs.length === 3 && softs.every((s2, i) => s2 > 0 && (i === 0 || s2 < softs[i - 1])),
 '[' + softs.join(', ') + '] px, farthest first');
 const fe = src.match(/const RIDGE_FEATHER = \[(.+)\];/);
 const taps = fe ? [...fe[1].matchAll(/\[([\d.]+), ([\d.]+)\]/g)].map((m) => [+m[1], +m[2]]) : [];
 gate('20. …in steps of falling alpha, so the edge is a gradient not a stack of lines',
 taps.length >= 3 && taps.every(([, a], i) => i === 0 || a < taps[i - 1][1]),
 taps.map(([s2, a]) => s2 + '×@' + a).join(' '));
 gate('20. the feather fills the SHALLOW crest path, never the whole band',
 /ctx\.fill\(feather\);/.test(src) && /const yB = y0 \+ 3 \* soft \+ 2;/.test(src),
 'feathering the full band was measured at most of a 7.4 ms backdrop');
 gate('20. …and no ctx.filter blur crept back in',
 !/ctx\.filter = `blur/.test(src) && !/ctx\.filter = 'blur/.test(src),
 '15 ms a frame, measured — a filter pays per pixel, a fill pays per path');
 }



 // **THE SCENERY'S LABELS MOVE TOO** (§9.3). The layer runs a whole simulation
 // of its own, so `view.texts` exists here exactly as it does for the
 // foreground — and `drawBackLevel` was handing the poses to the terrain and
 // the machine and NOT to the signs, so a moving sign stood still while the
 // wall it was painted on slid out from under it. Reported as "text on the 2nd
 // layer does not move".
 //
 // Two halves, because the draw itself needs a real canvas (above): that the
 // renderer HONOURS a live pose when given one, which is functional and is
 // where the poses land; and a source scan for the wiring that feeds it, which
 // is the argument this bug was about and is invisible to any behaviour test
 // that cannot rasterise. `verify-editor` gate 21 uses the same technique for
 // the same reason — an omission rots quietly.
 {
 const drawnAt = [];
 const rec = new Proxy({}, {
 get: (_, k) => {
 if (typeof k === 'symbol') return undefined;
 if (k === 'canvas') return { width: 800, height: 600 };
 if (k === 'measureText') return () => ({ width: 40 });
 if (k === 'getTransform') return () => ({});
 return (...a) => { if (k === 'translate') drawnAt.push(a); };
 },
 set: () => true,
 });
 const lv = { texts: [{ text: 'SIGN', x: -200, y: -100, size: 30 }] };
 drawTexts(rec, lv, 'over');
 const authored = drawnAt.length ? drawnAt[0][0] : null;
 drawnAt.length = 0;
 drawTexts(rec, lv, 'over', undefined, [{ x: 175, y: -100, angle: 0 }]);
 const live = drawnAt.length ? drawnAt[0][0] : null;
 gate('21. a label is drawn at its LIVE pose when one is given',
 authored === -200 && live === 175, `authored ${authored}, live ${live}`);
 }
 {
 const src = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
 const body = src.slice(src.indexOf('export function drawBackLevel'));
 // the function's closing brace: the first `}` alone at the start of a line.
 // Matched by regex rather than indexOf('\n}\n') because that finds nothing
 // under CRLF and `slice(0, -1)` then scans the whole rest of the file —
 // which is how this first ran, reporting ten calls including drawTexts's
 // own definition and the thumbnail's.
 const m = /\r?\n\}\r?\n/.exec(body);
 const fn = body.slice(0, m ? m.index : body.length);
 // 4500, was 3000: the haze composite (2026-08-23, "soft, not blurry")
 // legitimately grew the function by a comment and nine lines. The number
 // is a runaway-scan guard, not a style cap — an unmatched brace scans the
 // whole rest of the file and reports tens of thousands.
 gate('21. …(the scan really did find just that one function)',
 !!m && fn.length < 4500, `${fn.length} chars`);
 const calls = [...fn.matchAll(/drawTexts\([^)]*\)/g)].map(c => c[0]);
 gate('21. …and the scenery layer passes its live poses to every one of them',
 calls.length === 3 && calls.every(c => /liveTexts/.test(c)),
 `${calls.length} drawTexts calls: ${calls.filter(c => !/liveTexts/.test(c)).join(', ') || 'all wired'}`);
 }
}

// A local approximate compare — this suite has no shared one, and the gate
// below is about distances travelled, not about exact floats.
const nearly = (x, y, tol = 0.01) => Math.abs(x - y) <= tol;

// ---------- gate 21: labels move, and move nothing else (§9.3/§10.6) ----------
//
// A text label was the one piece kind that could neither be grouped nor given a
// motion path. It is now a bodyless mover on exactly the terms a goal zone
// already was — the same `{def, motion}` record, the same `_moverPose` — which
// is what makes it cheap: no second physics path, and nothing new that can
// collide.
//
// That last part is the gate that matters. A label is DECORATION: it must be
// able to sweep straight through the goal ball at speed and change nothing.
{
 const base = () => ({
 terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
 props: [], fixedParts: [], groups: {},
 buildZones: [{ x: -300, y: -75, w: 200, h: 150 }],
 goalZones: [{ x: 300, y: -52, w: 130, h: 104 }],
 goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
 win: 'goalObj',
 });
 const runTexts = (level, secs = 1) => {
 const sim = new Simulation(level, { parts: [] });
 for (let i = 0; i < Math.round(secs * 60); i++) sim.step(1 / 60);
 const out = sim.view().texts.map(t => ({ x: t.x, y: t.y }));
 sim.destroy?.();
 return out;
 };

 // 1. its OWN path — speed 100 for one second is 100 px along
 {
 const lv = base();
 lv.texts = [{ text: 'MOVER', x: 0, y: -100, size: 30, path: { pts: [{ x: 200, y: -100 }], mode: 'loop', speed: 100 } }];
 const p = runTexts(lv)[0];
 // ~96.7, not 100: a DRAWN pose is interpolated between the last two fixed
 // steps (view()'s alpha), so it sits up to one step behind the last one
 // completed — 3.33 px at 100 px/s on FC's 30 Hz clock (it was 1.67 px when
 // the sim stepped at 60). Terrain movers read exactly the same way, which
 // is the point. The tolerance admits one step and nothing more.
 gate('21. a label travels its own motion path',
 nearly(p.x, 100, 3.4) && nearly(p.y, -100, 0.01), `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
 }
 // 2. RIDING a group, keeping station with the slab it is grouped to
 {
 const lv = base();
 lv.groups = { g1: { path: { pts: [{ x: 0, y: -200 }], mode: 'loop', speed: 100 } } };
 lv.terrain.push({ type: 'box', x: 0, y: -100, w: 100, h: 20, groupId: 'g1' });
 lv.texts = [{ text: 'RIDER', x: 0, y: -140, size: 24, groupId: 'g1' }];
 const sim = new Simulation(lv, { parts: [] });
 for (let i = 0; i < 60; i++) sim.step(1 / 60);
 const v = sim.view();
 const slab = v.terrain.find(t => t.def.groupId === 'g1');
 const label = v.texts[0];
 // the CLAIM is that they hold station: the label started 40 px above the
 // slab and must still be 40 px above it, not merely "somewhere else"
 gate('21. a label grouped to a moving slab holds station with it',
 nearly(slab.y - label.y, 40, 0.01) && nearly(label.y, -240, 3.4), // one 30 Hz step of lag
 `gap ${(slab.y - label.y).toFixed(2)} px, label at y ${label.y.toFixed(1)}`);
 sim.destroy?.();
 }
 // …AT EVERY FRAME TIME, which is the version that actually caught something.
 // A drawn mover is interpolated between fixed steps, so sampling only at
 // alpha≈0 (what a whole-step loop does) hides a phase error completely: the
 // first cut of this seeded the label's `prevPose` from its ALREADY-ADVANCED
 // pose, so frame one had no interpolation at all while the slab had a full
 // step of it. Measured with ragged frame times, the gap breathed 40 → 41.67
 // every step — a sign that will not sit still on its own platform.
 {
 const lv = base();
 lv.groups = { g1: { path: { pts: [{ x: 0, y: -200 }], mode: 'loop', speed: 100 } } };
 lv.terrain.push({ type: 'box', x: 0, y: -100, w: 100, h: 20, groupId: 'g1' });
 lv.texts = [{ text: 'RIDER', x: 0, y: -140, size: 24, groupId: 'g1' }];
 const sim = new Simulation(lv, { parts: [] });
 let lo = Infinity, hi = -Infinity, badAngle = false;
 for (let i = 0; i < 120; i++) {
 sim.step((1 / 60) * (0.3 + (i % 7) * 0.2)); // deliberately uneven, so alpha varies
 const v = sim.view();
 const slab = v.terrain.find(t => t.def.groupId === 'g1');
 const gap = slab.y - v.texts[0].y;
 lo = Math.min(lo, gap); hi = Math.max(hi, gap);
 if (!Number.isFinite(v.texts[0].angle)) badAngle = true;
 }
 gate('21. …and holds it at EVERY frame time, not just on the step boundary',
 nearly(hi - lo, 0, 0.01) && nearly(lo, 40, 0.01) && !badAngle,
 `gap ${lo.toFixed(3)}…${hi.toFixed(3)} px over 120 ragged frames`);
 sim.destroy?.();
 }
 // A SPINNING label. The lerp blends the direction VECTOR, not the angle, so a
 // bodyless mover has to carry c/s — a body's pose has them already. Without
 // them the blend is NaN, and a label is the first mover to hit it.
 {
 const lv = base();
 lv.texts = [{ text: 'SPIN', x: 0, y: -300, size: 24, path: { spin: 1, spinSpeed: 90 } }];
 const sim = new Simulation(lv, { parts: [] });
 const seen = [];
 for (let i = 0; i < 30; i++) { sim.step(1 / 90); seen.push(sim.view().texts[0].angle); }
 gate('21. a spinning label turns, and never to NaN',
 seen.every(Number.isFinite) && seen[seen.length - 1] > seen[0],
 `${seen[0].toFixed(3)} → ${seen[seen.length - 1].toFixed(3)} rad`);
 sim.destroy?.();
 }
 // 3. a TEXT-ONLY group. Nothing else in it to supply a pivot, which is the
 // case that is silently inert if labels are left off the pivot fallback.
 {
 const lv = base();
 lv.groups = { g2: { path: { pts: [{ x: 150, y: -300 }], mode: 'loop', speed: 100 } } };
 lv.texts = [
 { text: 'A', x: 0, y: -300, size: 24, groupId: 'g2' },
 { text: 'B', x: 60, y: -300, size: 24, groupId: 'g2' },
 ];
 const p = runTexts(lv);
 gate('21. a group of nothing but labels still moves',
 nearly(p[0].x, 100, 3.4) && nearly(p[1].x - p[0].x, 60, 0.01), // one 30 Hz step of lag
 `(${p[0].x.toFixed(1)}) and (${p[1].x.toFixed(1)}), 60 px apart`);
 }
 // 4. the control: a label with no motion does not drift
 {
 const lv = base();
 lv.texts = [{ text: 'STILL', x: -50, y: -200, size: 24 }];
 const p = runTexts(lv, 2)[0];
 gate('21. …while a label with no path does not move at all',
 p.x === -50 && p.y === -200, `(${p.x}, ${p.y})`);
 }
 // 5. **THE ONE THAT MATTERS**: a label is decoration. Sweep one straight
 // through the goal ball at speed and the physics must be bit-identical.
 {
 const plain = base();
 const withLabel = base();
 withLabel.texts = [{ text: 'X', x: -300, y: -15, size: 40,
 path: { pts: [{ x: 300, y: -15 }], mode: 'loop', speed: 200 } }];
 const ballAfter = (lv) => {
 const s = new Simulation(lv, { parts: [] });
 for (let i = 0; i < 120; i++) s.step(1 / 60);
 const g = s.view().goals[0];
 const r = { x: g.x, y: g.y };
 s.destroy?.();
 return r;
 };
 const a = ballAfter(plain), b = ballAfter(withLabel);
 gate('21. a label sweeping through the goal piece changes the physics not at all',
 a.x === b.x && a.y === b.y,
 `(${a.x.toFixed(4)}, ${a.y.toFixed(4)}) vs (${b.x.toFixed(4)}, ${b.y.toFixed(4)})`);
 }
 // …and it builds no bodies, which is the identity version of the same claim
 {
 const lv = base();
 lv.texts = [{ text: 'X', x: 0, y: -100, size: 40, path: { pts: [{ x: 200, y: -100 }] } }];
 const plain = new Simulation(base(), { parts: [] });
 const withLabel = new Simulation(lv, { parts: [] });
 gate('21. …and no label ever becomes a body',
 withLabel.terrain.length === plain.terrain.length
 && withLabel.props.length === plain.props.length,
 `${withLabel.terrain.length} terrain, ${withLabel.props.length} props — same as without`);
 plain.destroy?.(); withLabel.destroy?.();
 }
}

// ---------- gate 22: the aftermath verdict keeps every late badge (§7.1a) ----
//
// The three badges the aftermath decides — Nailed It, Boomerang, Sweep — reach
// the player as a VERDICT object, and that object used to be typed out by hand
// at four sites. One of them, the offscreen check in `_startAftermath`, built
// `{nailedIt, boomerang}` and omitted `sweep`. `_awarded()` returns a settled
// verdict verbatim, so the moment the check finished the badge went from earned
// to absent — and because Save runs the check before writing, every saved swept
// run recorded `sweep: false`. The badge was right on screen until the player
// asked to keep it.
//
// **The failure mode is a MISSING KEY, not a wrong value**, so this gate
// asserts the key SET against the badge list rather than checking three
// booleans it would have to remember to list — a fourth late badge that
// `aftermathVerdict` forgot would fail here without anyone updating the gate.
{
 const { aftermathVerdict, AFTERMATH_BADGES, BADGE_DEFS, computeBadges } =
 await import(u('public/js/util.js'));

 gate('22. the late-badge list is derived from the definitions, not retyped',
 JSON.stringify(AFTERMATH_BADGES) === JSON.stringify(BADGE_DEFS.filter(b => b.late).map(b => b.id))
 && AFTERMATH_BADGES.length === 3,
 AFTERMATH_BADGES.join(','));

 const keys = (v) => Object.keys(v).sort().join(',');
 const want = [...AFTERMATH_BADGES].sort().join(',');
 gate('22. a verdict carries EVERY late badge, always',
 keys(aftermathVerdict({ nailedIt: true, boomerang: false, sweep: true })) === want,
 keys(aftermathVerdict({ nailedIt: true })));
 gate('22. …including off a sim that decided none of them',
 keys(aftermathVerdict({})) === want && keys(aftermathVerdict(null)) === want);
 gate('22. …and every value is a real boolean, never undefined',
 Object.values(aftermathVerdict(null)).every(v => v === false)
 && aftermathVerdict({ sweep: 1 }).sweep === true);

 // …and end to end on a real machine that genuinely throws itself off the
 // world: the latch, the verdict and the badge list, in the order the game
 // uses them. A rig that cannot produce the FAILING answer proves nothing,
 // so the control is the same level with a machine that stays put.
 const ledge = (driveOff) => ({
 terrain: [
 { type: 'box', x: -300, y: 30, w: 900, h: 60 },
 { type: 'box', x: 420, y: 30, w: 260, h: 60 },
 { type: 'box', x: 300, y: -20, w: 20, h: 40 },
 ...(driveOff ? [] : [{ type: 'box', x: 170, y: -40, w: 20, h: 80 }]), // a wall that stops it
 ],
 props: [],
 buildZones: [{ x: -600, y: -75, w: 300, h: 150 }],
 goalZones: [{ x: 420, y: -52, w: 200, h: 104 }],
 goalObjs: [{ shape: 'ball', x: 420, y: -15, r: 15 }],
 win: 'goalObj',
 });
 const runIt = (driveOff) => {
 const sim = new Simulation(ledge(driveOff), { parts: [{ t: 'wheel', kind: 'cw', x: -600, y: -15, r: 15, id: 'w1' }] });
 for (let i = 0; i < 60 * 240; i++) {
 sim._fixedStep();
 if (sim.afterDone || sim.goalLost) break;
 }
 const v = aftermathVerdict(sim);
 const badges = computeBadges({
 won: sim.won, pieces: 1, wheels: 1, poweredWheels: 1, wood: 0, water: 0, untampered: true, ...v,
 });
 sim.destroy();
 return { v, badges };
 };
 const stayed = runIt(false);
 gate('22. (control) one walled in does not — the rig can report the failing answer',
 stayed.v.sweep === false && !stayed.badges.includes('sweep'), JSON.stringify(stayed.v));

 // **A lost goal answers the DELIVERY question, not the SWEEP one.** The
 // aftermath used to end outright the instant a goal piece went into the
 // void — but the machine that threw it off is still falling alongside it,
 // and on the reported case the last part crossed the line five frames after
 // the goal did, with the window already shut. So: a machine that drives
 // itself off the world earns Sweep even when the delivery goes with it, and
 // Nailed It stays false because the delivery genuinely did not hold.
 {
 const cliff = {
 terrain: [{ type: 'box', x: -300, y: 30, w: 900, h: 60 }], // floor ENDS at x=150
 props: [],
 buildZones: [{ x: -600, y: -75, w: 300, h: 150 }],
 goalZones: [{ x: 0, y: -52, w: 260, h: 104 }], // win happens on the way past
 goalObjs: [{ shape: 'ball', x: -100, y: -15, r: 15 }],
 win: 'goalObj',
 };
 // a wheel that shoves the ball along the floor and off the end with it
 const sim = new Simulation(cliff, { parts: [{ t: 'wheel', kind: 'cw', x: -250, y: -15, r: 15, id: 'w1' }] });
 for (let i = 0; i < 60 * 400; i++) { sim._fixedStep(); if (sim.afterDone) break; }
 // NOT asserted: what Nailed It does here. On this rig the ball rests in
 // the zone on its way past, so the badge latches before the fall — and
 // "whatever is latched when the piece goes stands" is the existing rule
 // (§7.1a), untouched by this fix. The first draft of this gate asserted
 // `nailedIt === false` and failed against correct behaviour.
 gate('22. …and the window still CLOSES rather than running to the cap',
 sim.afterDone && sim.afterElapsed < AFTERMATH_FRAMES,
 `afterElapsed ${sim.afterElapsed} of ${AFTERMATH_FRAMES}`);
 sim.destroy();
 }
}

// ---------- gate 23: the scrub tape replays the frame it recorded (§7.3) ----
//
// Scrubbing draws a recorded frame through the ordinary renderer, so the whole
// correctness claim is: `viewFromTape` reconstructs what `view()` said at the
// moment `writeTape` ran. Both are pure over poses, so this compares them
// body for body — a tape that quietly dropped or misordered one would show up
// as a machine that reassembles wrong when you scrub back to it.
{
 const { viewFromTape } = await import(u('public/js/sim.js'));
 const level = {
 terrain: [
 { type: 'box', x: 0, y: 30, w: 1200, h: 60 },
 // a mover, so the tape's terrain half is exercised rather than skipped
 { type: 'box', x: 260, y: -120, w: 120, h: 20, path: { pts: [{ x: 260, y: -220 }], mode: 'pingpong', speed: 90 } },
 ],
 props: [{ shape: 'box', x: -120, y: -20, w: 30, h: 30 }],
 buildZones: [{ x: -300, y: -75, w: 260, h: 150 }],
 goalZones: [{ x: 320, y: -52, w: 130, h: 104 }],
 goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
 win: 'goalObj',
 };
 const design = { parts: [
 { t: 'wheel', kind: 'cw', x: -280, y: -15, r: 15, id: 'w1' },
 { t: 'wheel', kind: 'free', x: -200, y: -15, r: 15, id: 'w2' },
 { t: 'rod', kind: 'wood', x1: -280, y1: -15, x2: -200, y2: -15, id: 'r1' },
 { t: 'rod', kind: 'water', x1: -280, y1: -15, x2: -240, y2: -60, id: 'r2' },
 ] };

 const sim = new Simulation(level, design);
 const shape = sim.tapeShape();
 const stride = sim.tapeBodies().length * 3;
 gate('23. the tape records every body that can move, and only those',
 stride / 3 === 1 + 1 + 1 + 2 + 2, `${stride / 3} bodies (1 mover + 1 prop + 1 goal + 2 wheels + 2 rods)`);

 // record 90 frames, keeping the live view of one of them to compare against
 const buf = new Float32Array(stride * 90);
 let liveAt40 = null;
 for (let i = 0; i < 90; i++) {
 sim._fixedStep();
 sim.writeTape(buf, i * stride);
 // The tape stores the STEP; view() draws BETWEEN steps, blending the last
 // two by how far the wall clock has run past the last one. Comparing them
 // means asking view() for the same instant the tape holds — alpha = 1, the
 // step just completed — and a clock that has not moved gives alpha = 0,
 // one whole step behind. This did not matter when the machine was not
 // interpolated at all (movers only, at 60 Hz); at FC's 30 the whole world
 // blends, so the tape and the drawn frame are a step apart unless said.
 if (i === 40) { sim._acc = Infinity; liveAt40 = sim.view(); sim._acc = 0; }
 }
 const back = viewFromTape(shape, buf, 40 * stride);

 const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
 const cmp = (list, live, pick) => list.length === live.length
 && list.every((r, i) => pick(r).every((v, k) => near(v, pick(live[i])[k])));

 // Angles are compared as ORIENTATIONS, whole turns apart being the same
 // way up. A drawn angle is interpolated along the SHORT arc, and at FC's
 // 30 Hz a powered wheel turns more than half a circle in one step — so the
 // blend legitimately walks a turn away from the engine's unbounded angle,
 // which the tape stores raw. Nothing is drawn differently; a gate on the
 // raw number would be gating the winding, not the pose.
 const turn = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-4;
 gate('23. …and rebuilds the machine exactly: wheels',
 back.wheels.length === liveAt40.wheels.length
 && back.wheels.every((w, i) => near(w.x, liveAt40.wheels[i].x) && near(w.y, liveAt40.wheels[i].y)
 && turn(w.angle, liveAt40.wheels[i].angle)),
 JSON.stringify(back.wheels.map(w => [Math.round(w.x), Math.round(w.y)])));
 gate('23. …rods, both endpoints (derived from one pose + the stored length)',
 cmp(back.rods, liveAt40.rods, (r) => [r.x1, r.y1, r.x2, r.y2]),
 JSON.stringify(back.rods.map(r => [Math.round(r.x1), Math.round(r.y1)])));
 gate('23. …the goal piece', cmp(back.goals, liveAt40.goals, (g) => [g.x, g.y]));
 gate('23. …the prop', cmp(back.props, liveAt40.props, (p) => [p.x, p.y]));
 gate('23. …and the moving terrain, with the static kept off the tape',
 back.terrain.length === liveAt40.terrain.length
 && back.terrain.filter(t => t.moving).every((t, i) => {
 const l = liveAt40.terrain.filter(x => x.moving)[i];
 // exact now, for the reason above: both are the same completed step,
 // and what is left is the tape's float32 rounding
 return Math.hypot(t.x - l.x, t.y - l.y) < 1e-3;
 }),
 `${back.terrain.filter(t => t.moving).length} moving of ${back.terrain.length}`);
 gate('23. every part carries its def/part through, or nothing could be drawn',
 back.wheels.every(w => !!w.part) && back.rods.every(r => !!r.part)
 && back.terrain.every(t => !!t.def) && back.goals.every(g => !!g.def));

 // The tape must outlive the run: scrubbing stops the sim, and a recording
 // that needed a live one would blank exactly when it is being looked at.
 sim.destroy();
 const afterDeath = viewFromTape(shape, buf, 40 * stride);
 gate('23. a tape still replays after its Simulation is destroyed',
 cmp(afterDeath.wheels, back.wheels, (w) => [w.x, w.y, w.angle])
 && afterDeath.rods.length === back.rods.length);
}

// ---------- gate 25: the gravity flux is a texture, not a show ----------
//
// The streaks falling into a planet's well (§5.10) are STATELESS — pure in
// (planet, time) — which is what lets a scrubbed frame rewind the weather by
// passing the tape's clock. These gates hold the properties that make it
// safe to run always: determinism, the radial band (nothing strays into the
// level), and the alpha ceiling that keeps "subtle" a number.
{
 const { fluxSeeds, FLUX_STREAKS, FLUX_ALPHA_MAX } = await import(u('public/js/render.js'));
 const p = { x: 100, y: -50, r: 40, pull: 1 };
 const a = fluxSeeds(p, 1.234), b = fluxSeeds(p, 1.234);
 gate('25. the flux is a pure function of (planet, time)',
 JSON.stringify(a) === JSON.stringify(b) && a.length === FLUX_STREAKS, `${a.length} streaks`);
 const later = fluxSeeds(p, 1.334);
 gate('25. …and it MOVES — a tenth of a second is a visibly different frame',
 JSON.stringify(a) !== JSON.stringify(later));
 let inBand = true, quiet = true;
 for (const t of [0, 0.7, 3.33, 12.5]) {
 for (const s of fluxSeeds(p, t)) {
 const rHead = Math.hypot(s.x - p.x, s.y - p.y);
 const rTail = Math.hypot(s.x2 - p.x, s.y2 - p.y);
 if (rHead < p.r * 1.0 || rTail > p.r * 3.4) inBand = false;
 if (!(s.alpha >= 0 && s.alpha <= FLUX_ALPHA_MAX + 1e-9)) quiet = false;
 }
 }
 gate('25. every streak stays in the well\'s band — outside the surface, inside ~3r', inBand);
 gate('25. …under the alpha ceiling that keeps it a texture', quiet, `cap ${FLUX_ALPHA_MAX}`);
 const slow = fluxSeeds({ ...p, pull: 0.25 }, 5), fast = fluxSeeds({ ...p, pull: 3 }, 5);
 gate('25. the pull dial sets the tempo — a 3× well drinks visibly differently from a 0.25×',
 JSON.stringify(slow) !== JSON.stringify(fast));
}

// ---------- gate 26: a terrain pin actually HOLDS ----------
//
// Pins on terrain (2026-08-07) are the editor's half of a promise the SOLVER
// has to keep. The pin map pairs bodies that share a coordinate and has never
// cared what kind of body — so terrain slotted in — but "it compiles" is not
// the claim. The claim is that a stick bolted to a wall hangs from it instead
// of falling, that the joint is a HINGE rather than a weld, and that a pin on
// a moving platform carries the stick with it.
//
// **Measured at the PINNED END, not the centre.** The first cut of this gate
// watched the rod's centre and read 62 px of travel on a platform that moved
// 181 — because the arm is a pendulum swinging through 179°, and its centre
// is dominated by the swing. The joint's promise is about the pinned end, so
// that is what the gate holds; the swing is the separate claim below it.
{
 const level = (over) => ({
 terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }, over], // distant floor
 props: [], buildZones: [{ x: 0, y: -100, w: 900, h: 500 }],
 goalZones: [{ x: 700, y: -40, w: 120, h: 80 }],
 goalObjs: [{ shape: 'ball', x: -700, y: -15, r: 15 }],
 win: 'goalObj',
 });
 // one stick, one end exactly on the terrain pin, the rest hanging in air
 const design = { parts: [{ t: 'rod', kind: 'wood', x1: 0, y1: -200, x2: 120, y2: -200, id: 'arm' }] };
 // the pinned end, recovered from the body pose (the rod is 120 long)
 const pinnedEnd = (sim, rec) => {
 const p = sim._pose(rec.body);
 return { x: p.x - 60 * p.c, y: p.y - 60 * p.s };
 };

 {
 const s = new Simulation(level({ type: 'box', x: 0, y: -200, w: 60, h: 60, pins: [{ x: 0, y: -200 }] }), design);
 const rec = s.rods.find(r => r.part.id === 'arm');
 gate('26. a stick ending on a terrain pin makes a real joint',
 s.jointRecs.length === 1, `${s.jointRecs.length} joints`);
 let maxA = 0, held = true;
 for (let i = 0; i < 300; i++) {
 s._fixedStep();
 const p = s._pose(rec.body);
 maxA = Math.max(maxA, Math.abs(Math.atan2(p.s, p.c) * 180 / Math.PI));
 const e = pinnedEnd(s, rec);
 if (Math.hypot(e.x - 0, e.y - (-200)) > 6) held = false; // the pin must not tear
 }
 gate('26. …and the pinned END stays ON the pin for five seconds of swinging',
 held, `end at (${pinnedEnd(s, rec).x.toFixed(1)}, ${pinnedEnd(s, rec).y.toFixed(1)}), pin at (0, -200)`);
 gate('26. …as a HINGE, not a weld — it swings freely under gravity',
 maxA > 60, `swung ${maxA.toFixed(0)}° from horizontal`);
 const far = s._pose(rec.body);
 gate('26. …and it never reaches the floor, which is what "held" means',
 far.y < 100, `centre y ${far.y.toFixed(0)}, floor at y=270`);
 s.destroy();
 }

 // the control: the SAME stick with no pin falls. Without this the gate above
 // would pass just as happily if nothing were jointed and gravity were off.
 {
 const s2 = new Simulation(level({ type: 'box', x: 0, y: -200, w: 60, h: 60 }), design);
 for (let i = 0; i < 300; i++) s2._fixedStep();
 const p2 = s2._pose(s2.rods[0].body);
 gate('26. …while the same stick with no pin falls to the floor',
 s2.jointRecs.length === 0 && p2.y > 200, `${s2.jointRecs.length} joints, y=${p2.y.toFixed(0)}`);
 s2.destroy();
 }

 // a pin on a MOVING platform travels, and the stick goes with it
 {
 const s3 = new Simulation(level({
 type: 'box', x: 0, y: -200, w: 60, h: 60, pins: [{ x: 0, y: -200 }],
 path: { pts: [{ x: 0, y: -200 }, { x: 400, y: -200 }], mode: 'once', speed: 120 },
 }), design);
 const rec = s3.rods.find(r => r.part.id === 'arm');
 const plat = s3.terrain[1];
 const t0 = s3._pose(plat.body).x, e0 = pinnedEnd(s3, rec).x;
 let worstLag = 0;
 for (let i = 0; i < 120; i++) {
 s3._fixedStep();
 worstLag = Math.max(worstLag, Math.abs(pinnedEnd(s3, rec).x - s3._pose(plat.body).x));
 }
 const moved = s3._pose(plat.body).x - t0;
 gate('26. (the platform really travelled)', moved > 100, `${moved.toFixed(0)} px`);
 gate('26. a pin on a MOVING platform carries the stick with it — the end tracks the platform',
 Math.abs((pinnedEnd(s3, rec).x - e0) - moved) < 8 && worstLag < 8,
 `end moved ${(pinnedEnd(s3, rec).x - e0).toFixed(0)} px against the platform's ${moved.toFixed(0)}, worst lag ${worstLag.toFixed(1)} px`);
 s3.destroy();
 }

 // ---------- 27. a pin on NOTHING (2026-08-08) ----------
 //
 // The third case util.js's `piecePins` note already described — a bolt to the
 // world — with no piece under it at all. `level.pins` names the anchor body
 // directly, so this must behave EXACTLY like the static-terrain pin above:
 // the same free hinge, held at the same coordinate, with no wall in the level
 // to hold it. Which is the whole reason it is worth gating separately: "the
 // stick hangs there" is indistinguishable from "the stick landed on the
 // terrain" until the terrain is taken away.
 {
 const bare = (pins) => ({
 terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }], // distant floor, nothing else
 props: [], pins, buildZones: [{ x: 0, y: -100, w: 900, h: 500 }],
 goalZones: [{ x: 700, y: -40, w: 120, h: 80 }],
 goalObjs: [{ shape: 'ball', x: -700, y: -15, r: 15 }],
 win: 'goalObj',
 });
 const s = new Simulation(bare([{ x: 0, y: -200 }]), design);
 const rec = s.rods.find(r => r.part.id === 'arm');
 gate('27. a stick ending on a LOOSE pin makes a real joint, with no piece under it',
 s.jointRecs.length === 1, `${s.jointRecs.length} joints`);
 let maxA = 0, held = true;
 for (let i = 0; i < 300; i++) {
 s._fixedStep();
 const p = s._pose(rec.body);
 maxA = Math.max(maxA, Math.abs(Math.atan2(p.s, p.c) * 180 / Math.PI));
 const e = pinnedEnd(s, rec);
 if (Math.hypot(e.x - 0, e.y - (-200)) > 6) held = false;
 }
 gate('27. …and the pinned END stays on it for five seconds of swinging',
 held, `end at (${pinnedEnd(s, rec).x.toFixed(1)}, ${pinnedEnd(s, rec).y.toFixed(1)}), pin at (0, -200)`);
 gate('27. …as a HINGE, not a weld — the same joint a wall gives',
 maxA > 60, `swung ${maxA.toFixed(0)}° from horizontal`);
 gate('27. …and it never reaches the floor',
 s._pose(rec.body).y < 100, `centre y ${s._pose(rec.body).y.toFixed(0)}, floor at y=270`);
 s.destroy();

 // The control, and it matters MORE here than it did above: with no piece in
 // the level at all, "the stick stayed up" has exactly one possible cause,
 // and this is the run that proves gravity was ever pulling on it.
 const s2 = new Simulation(bare([]), design);
 for (let i = 0; i < 300; i++) s2._fixedStep();
 gate('27. …while the identical level with no loose pin drops the stick to the floor',
 s2.jointRecs.length === 0 && s2._pose(s2.rods[0].body).y > 200,
 `${s2.jointRecs.length} joints, y=${s2._pose(s2.rods[0].body).y.toFixed(0)}`);
 s2.destroy();
 }
}

// ---------- 28. one physics: FC's own, whoever asks (2026-08-17) ----------
//
// This gate used to hold the two-profile world together (the FC profile had
// to change the world, the default had to be bit-identical to lifirik). The
// switch is retired ("We don't need LIFIRIK physics anymore. Just FCLike
// will do.") and the promise INVERTS: physicsOf answers `fc` to every
// caller — including the stored 'lifirik' strings old devices still send,
// and the nonsense a bug might — and no key may change the world by a bit.
{
 const { PHYSICS, PHYSICS_KEYS, physicsOf } = await import(u('public/js/sim.js'));
 gate('28. the one profile is FC, and the table says so',
 PHYSICS_KEYS.join(',') === 'fc' && PHYSICS.fc.name === 'FC', PHYSICS_KEYS.join(','));
 gate('28. every key answers fc — a stored lifirik, nonsense, nothing at all',
 physicsOf('lifirik') === PHYSICS.fc && physicsOf('nonsense') === PHYSICS.fc
 && physicsOf(undefined) === PHYSICS.fc);

 const drop = (physics) => {
 const s = new Simulation(flatLevel(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -900, r: 15, id: 'w' }] },
 physics === undefined ? {} : { physics });
 for (let i = 0; i < 60; i++) s._fixedStep();
 const y = s._pose(s.wheels[0].body).y;
 s.destroy();
 return y;
 };
 const base = drop(undefined), old = drop('lifirik'), fc = drop('fc');
 gate('28. a device that once picked lifirik gets a BIT-IDENTICAL world',
 base === old && old === fc, `${base} vs ${old} vs ${fc}`);

 const spin = () => {
 const s = new Simulation(flatLevel(), { parts: [
 { t: 'wheel', kind: 'cw', x: 0, y: -400, r: 15, id: 'h' },
 { t: 'rod', kind: 'wood', x1: 0, y1: -400, x2: 114, y2: -400, id: 'r' }] }, { physics: 'fc' });
 for (let i = 0; i < 120; i++) s._fixedStep();
 const a = s._pose(s.rods[0].body);
 s.destroy();
 return Math.abs(Math.atan2(a.s, a.c));
 };
 gate('28. …and a driven machine still simulates without NaN',
 Number.isFinite(spin()));
}


// ---------------------------------------------------------------------------
// 29. GHOST STICKS TOUCH NOTHING, AND ARE STILL PART OF THE MACHINE (§5.2)
//
// The rod kind FC Gold has and FC1 did not, added 2026-08-10 as an import-only
// piece — nothing places one yet. Its whole definition is a contradiction that
// has to hold in both directions at once, so both are gated:
//
// - it collides with NOTHING. `mask: 0`, which is enough on its own because
// Box2D wants both sides to admit each other. A water stick already passes
// through your own machine and still lands on the floor; the floor is the
// difference between the two kinds and the only way to see it is to drop
// one and watch it keep going.
// - it is JOINTED like any other stick. A joint is a shared coordinate
// (§5.4), not a contact, so filtering it out of every collision must not
// take it out of the machine — an axle that holds two wheels apart while
// passing through the world is the entire point of the piece.
{
 const level = {
 terrain: [{ type: 'box', x: 0, y: 60, w: 1400, h: 60, texture: 'granite' }],
 props: [{ shape: 'box', x: 40, y: -20, w: 40, h: 40 }],
 buildZones: [{ x: -200, y: -60, w: 400, h: 200 }],
 goalZones: [{ x: 900, y: 0, w: 90, h: 76 }],
 goalObjs: [{ shape: 'ball', x: -600, y: 16, r: 14 }],
 win: 'goalObj',
 };
 const drop = (kind) => {
 const s = new Simulation(level, { parts: [{ t: 'rod', kind, x1: -150, y1: -100, x2: -70, y2: -100, id: 'r' }] });
 for (let i = 0; i < 180; i++) s._fixedStep();
 const y = s._pose(s.rods[0].body).y;
 s.destroy();
 return y;
 };
 const wood = drop('wood'), water = drop('water'), ghost = drop('ghost');
 gate('29. a wood stick and a WATER stick both stop on the floor',
 wood < 60 && water < 60, `wood y=${wood.toFixed(0)}, water y=${water.toFixed(0)}`);
 gate('29. …and a GHOST stick falls straight through it',
 ghost > 500, `ghost y=${ghost.toFixed(0)} after 3 s, floor top at y=30`);
 // …and the half that would make it useless: still bolted to what it is
 // bolted to. A cart whose only axle is a ghost has to hold together and
 // drive exactly as far as the wood-axled one.
 const cart = (kind) => ({ parts: [
 { t: 'wheel', kind: 'cw', x: -120, y: 15, r: 15, id: 'a' },
 { t: 'wheel', kind: 'cw', x: -40, y: 15, r: 15, id: 'b' },
 { t: 'rod', kind, x1: -120, y1: 15, x2: -40, y2: 15, id: 'r' },
 ] });
 // **A CLEAR floor for this half, and the first draft's failure is the
 // reason.** Run on the level above — which has a prop sitting at x=40 — the
 // ghost-axled cart drove 269 px and the wood-axled one 128, because the wood
 // axle catches the crate and the ghost axle goes through it. That is the
 // feature working, and it makes the two carts incomparable: to ask whether a
 // ghost axle DRIVES like a wood one, nothing may be in the way of either.
 const clear = { ...level, props: [] };
 const run = (kind) => {
 const s = new Simulation(clear, cart(kind));
 const joints = s.jointRecs.length;
 for (let i = 0; i < 180; i++) s._fixedStep();
 const a = s._pose(s.wheels[0].body), b = s._pose(s.wheels[1].body);
 const out = { joints, drove: a.x + 120, gap: Math.abs(b.x - a.x) };
 s.destroy();
 return out;
 };
 const wc = run('wood'), gc = run('ghost');
 gate('29. a ghost AXLE still forms its pins and holds the cart together',
 gc.joints === 2 && Math.abs(gc.gap - 80) < 1,
 `${gc.joints} joints, wheels ${gc.gap.toFixed(1)} px apart (built at 80)`);
 // The floor is "it actually drove", not a speed: it was 300 px when a cart
 // covered ~420 px in 3 s, and `motorSpeed` halving to FC's 5 on 2026-08-14
 // put the same cart at 209. The comparison between the two axles is what this
 // gate tests and it is untouched — they match to the pixel.
 gate('29. …and the cart drives as far as the wood-axled one',
 Math.abs(gc.drove - wc.drove) < 10 && gc.drove > 150,
 `ghost ${gc.drove.toFixed(0)} px vs wood ${wc.drove.toFixed(0)} px in 3 s`);
}

// ---------- gate 30: a prop's own gravity (§5.10) ----------
//
// `props[].gravity` is a per-body gravity SCALE: 1 normal, 0 hangs, −1 falls
// up as fast as it would fall down, 2 twice as briskly. The claim worth
// measuring is the symmetry — "as fast as down" is the whole promise of the
// bottom of the dial, and it is exact rather than approximate because the
// motion is linear in the scale: v' = g·s − c·v, so DISPLACEMENT scales with
// s and nothing else does.
//
// It is also the gate on the thing that could not be built: a NEGATIVE
// DENSITY. That flips the force and the inverse mass together, the two cancel
// in free fall, and the piece falls at the normal rate while solving contacts
// backwards. 30c measures exactly that non-effect, so the reason this feature
// is a gravity scale is a number here rather than an argument in a comment.
{
 const drop = (gravity, frames = 30, extra = {}) => { // 30 frames = 1 s (FC's clock)
 const lvl = flatLevel();
 lvl.props = [{ shape: 'ball', x: 0, y: -400, r: 12, ...(gravity === undefined ? {} : { gravity }), ...extra }];
 const sim = new Simulation(lvl, { parts: [] });
 for (let i = 0; i < frames; i++) sim._fixedStep();
 const p = sim._pose(sim.props[0].body);
 sim.destroy();
 return p.y + 400; // + is down the screen, − is up
 };

 const down = drop(1);
 gate('30. an ordinary prop still falls exactly as it always did',
 Math.abs(down - drop(undefined)) < 1e-9 && down > 100,
 `${down.toFixed(3)} px in 1 s, and an absent gravity is identical`);

 // The promise on the label, and the reason −1 is the floor of the dial.
 //
 // The bar is 1e-3 px rather than 0 for one reason, and it is not the physics:
 // the solver's positions are float32 METRES, so reading a pose back as px is
 // a ×30 round trip through a 24-bit mantissa, and a piece 200 px above its
 // start does not land on the same representable number as one 200 px below.
 // Measured residual 8e-5 px, and a genuinely asymmetric scale would be
 // several px out — 0.5× misses 2× by 96 px here.
 const up = drop(-1);
 gate('30. …and at −1 it falls UP exactly as fast as it falls down',
 up < 0 && Math.abs(up + down) < 1e-3, `up ${up.toFixed(4)} px vs down ${down.toFixed(4)} px`);

 gate('30. …at 0 it hangs precisely where it was put',
 Math.abs(drop(0)) < 1e-4, `${drop(0).toExponential(1)} px — the float32 round trip, nothing moved`);

 gate('30. …and at 2 it drops twice as far, not merely further',
 Math.abs(drop(2) - 2 * down) < 1e-3, `${drop(2).toFixed(4)} px vs 2 × ${down.toFixed(4)}`);

 gate('30. …and the ladder is linear all the way down it',
 Math.abs(drop(0.5) - 0.5 * down) < 1e-3 && Math.abs(drop(-0.5) + 0.5 * down) < 1e-3,
 `0.5× ${drop(0.5).toFixed(3)}, −0.5× ${drop(-0.5).toFixed(3)}, 1× ${down.toFixed(3)}`);

 // 30b. clamped at the sim, not merely at the server: this level never met a
 // validator, and the number is a factor on a force. Asserted against the
 // FLOOR rather than a literal, and then against the physics as well — the
 // ladder moved once already (−1 → −2 on 2026-08-12) and a gate that only
 // checks "same as the floor" would pass on a floor of zero.
 gate(`30. a hand-written gravity of −50 is clamped to the dial (${PIECE_GRAVITY_MIN}), not simulated`,
 Math.abs(drop(-50) - drop(PIECE_GRAVITY_MIN)) < 1e-9
 && Math.abs(drop(-50) + Math.abs(PIECE_GRAVITY_MIN) * down) < 1e-3,
 `${drop(-50).toFixed(3)} px, the same as ${PIECE_GRAVITY_MIN}× and ${Math.abs(PIECE_GRAVITY_MIN)}× the 1× fall`);
 gate(`30. …and 1e9 is clamped to the ceiling (${PIECE_GRAVITY_MAX}) the same way`,
 Math.abs(drop(1e9) - drop(PIECE_GRAVITY_MAX)) < 1e-9,
 `${drop(1e9).toFixed(3)} px`);
 gate('30. …and a NaN one falls normally rather than vanishing',
 Math.abs(drop('float') - down) < 1e-9, `${drop('float').toFixed(3)} px`);

 // 30c. the control, and the reason for the whole design: a negative DENSITY
 // does not float. Mass cancels out of free fall, so it drops at the normal
 // rate — and it is only the density clamp standing between that and a
 // negative inverse mass in the contact solver.
 {
 const neg = drop(undefined, 30, { density: -1 });
 gate('30. (control) a negative DENSITY does not float — mass cancels in free fall',
 Math.abs(neg - down) < 1e-9, `${neg.toFixed(3)} px, indistinguishable from a normal drop`);
 }

 // 30d. a floating prop weighs its full mass in a COLLISION — the half a
 // negative mass would have got wrong. A 1× ball resting on the floor is
 // pushed measurably by a −1× ball rising into it from below? No: aim it the
 // readable way round and let the balloon carry a normal prop UP with it.
 {
 const lvl = flatLevel();
 lvl.props = [
 { shape: 'box', x: 0, y: -300, w: 120, h: 20, gravity: -1 }, // the balloon
 { shape: 'ball', x: 0, y: -324, r: 12 }, // ordinary, sat on top
 ];
 const sim = new Simulation(lvl, { parts: [] });
 for (let i = 0; i < 90; i++) sim._fixedStep();
 const lift = sim._pose(sim.props[0].body), rider = sim._pose(sim.props[1].body);
 const carried = rider.y < -324;
 const together = Math.abs((rider.y - lift.y) + 24) < 3;
 sim.destroy();
 gate('30. a floating prop CARRIES an ordinary one — it has real mass, it just falls upward',
 carried && together, `lifter ${lift.y.toFixed(1)}, rider ${rider.y.toFixed(1)} (built 24 px apart)`);
 }

 // 30e. radial levels take a different code path entirely — the world's
 // gravity is off there and every body is pushed by hand, so bd.gravityScale
 // is dead and the scale is folded into the force instead. Same promise.
 {
 const R = 120;
 const planetLevel = (props) => ({
 terrain: [{ type: 'ball', x: 0, y: 0, r: R, planet: {} }],
 props,
 buildZones: [{ x: 0, y: -300, w: 400, h: 120 }],
 goalZones: [{ x: 360, y: 0, w: 120, h: 120 }],
 goalObjs: [{ shape: 'ball', x: 400, y: 0, r: 15 }],
 win: 'goalObj',
 });
 // Measured as a change of RADIUS, not of y: three props side by side sit
 // on three different radial lines, so the one at x = 60 falls partly
 // sideways and its y alone under-reads the drop by 1.1%. "How far did it
 // fall" on a planet is a distance from the centre and nothing else.
 const D = -400;
 const sim = new Simulation(planetLevel([
 { shape: 'ball', x: 0, y: D, r: 12 },
 { shape: 'ball', x: 60, y: D, r: 12, gravity: -1 },
 { shape: 'ball', x: 120, y: D, r: 12, gravity: 0 },
 ]), { parts: [] });
 const rs = () => sim.props.map((p) => { const q = sim._pose(p.body); return Math.hypot(q.x, q.y); });
 const before = rs();
 for (let i = 0; i < 30; i++) sim._fixedStep(); // 1 s on FC's clock
 const moved = rs().map((r, i) => r - before[i]);
 sim.destroy();
 // 2× is deliberately not here: from 438 px out it lands on the planet
 // inside the second, so the number would measure the surface, not the dial.
 gate('30. on a PLANET a −1 prop flies away as fast as an ordinary one falls in',
 moved[0] < -20 && Math.abs(moved[1] + moved[0]) < 0.01,
 `in ${moved[0].toFixed(3)} px vs out ${moved[1].toFixed(3)} px`);
 gate('30. …and a 0 prop hangs in orbit, pushed by nothing',
 Math.abs(moved[2]) < 1e-6, `moved ${moved[2].toExponential(1)} px`);
 }

 // 30f. WHAT IT DRAWS (§10.1). The arrow is the only thing in Create that says
 // a prop will not fall normally, and it is measured rather than eyeballed for
 // the same reason the gravity field's ticks are: a sign error looks like a
 // picture either way, and this one would be a picture of a lie.
 //
 // Recorded in the mark's own LOCAL frame — `drawPieceGravity` translates to
 // the prop and rotates so local +y is the way down really is — so the shaft's
 // y sign is "with gravity" or "against it", whatever the level's gravity is
 // doing. The rotation itself is checked separately, against downAt.
 {
 const draw = (p, planets = []) => {
 const calls = [];
 const rec = new Proxy({}, {
 get: (_, k) => {
 if (k === 'canvas') return { width: 800, height: 600 };
 if (typeof k === 'symbol') return undefined;
 return (...a) => { calls.push([k, ...a]); };
 },
 set: () => true,
 });
 const drew = drawPieceGravity(rec, p, null, planets);
 const pts = calls.filter(c => c[0] === 'moveTo' || c[0] === 'lineTo').map(c => ({ x: c[1], y: c[2] }));
 const rot = calls.find(c => c[0] === 'rotate');
 return { drew, pts, rot: rot ? rot[1] : null, ys: pts.map(q => q.y) };
 };
 const crate = (extra) => ({ shape: 'box', x: 0, y: 0, w: 40, h: 40, ...extra });

 gate('30. an ordinary prop draws no arrow at all — the quiet case stays quiet',
 draw(crate({})).drew === false && draw(crate({ gravity: 1 })).drew === false,
 'absent and an explicit 1× both draw nothing');

 // The shaft is centred on the piece and runs PAST it the other way — an
 // arrow is a line with a head, not a line starting at a point — so the
 // question is which end reaches further, not which side of zero it is on.
 const up = draw(crate({ gravity: -1 })), down2 = draw(crate({ gravity: 2 }));
 const reachUp = (r) => -Math.min(...r.ys), reachDown = (r) => Math.max(...r.ys);
 gate('30. …a floating prop\'s arrow points AGAINST gravity, a heavy one\'s WITH it',
 up.drew && down2.drew
 && reachUp(up) > reachDown(up) && reachDown(down2) > reachUp(down2),
 `−1× reaches ${reachUp(up).toFixed(1)} up against ${reachDown(up).toFixed(1)} down; 2× reaches ${reachDown(down2).toFixed(1)} down against ${reachUp(down2).toFixed(1)} up`);

 const one = draw(crate({ gravity: -1 })), two = draw(crate({ gravity: -2 }));
 gate('30. …and the harder it pulls the longer the arrow',
 Math.abs(Math.min(...two.ys)) > Math.abs(Math.min(...one.ys)),
 `−2× reaches ${Math.min(...two.ys).toFixed(1)} against −1×'s ${Math.min(...one.ys).toFixed(1)}`);

 // 0 is the value with no direction to point, so it must not draw a
 // zero-length arrow — it gets a bar ACROSS the fall line instead
 const hang = draw(crate({ gravity: 0 }));
 gate('30. …a 0× prop draws a BAR, not an arrow with nowhere to point',
 hang.drew && hang.ys.every(y => Math.abs(y) < 1e-9) && hang.pts.some(q => Math.abs(q.x) > 1),
 `y all zero, x spans ±${Math.max(...hang.pts.map(q => Math.abs(q.x))).toFixed(1)}`);

 gate('30. …and a prop too small to carry a mark goes without one',
 draw({ shape: 'ball', x: 0, y: 0, r: 3, gravity: -2 }).drew === false
 && draw({ shape: 'ball', x: 0, y: 0, r: 20, gravity: -2 }).drew === true,
 `r3 no, r20 yes (floor ${GRAV_MARK_MIN_HALF})`);

 // On a planet "up" is a different direction for every prop, and an arrow
 // that always pointed at the top of the screen would be wrong on exactly
 // the levels where the answer is hard to work out.
 {
 const planets = [{ x: 0, y: 0, r: 120, pull: 1 }];
 const west = draw({ shape: 'box', x: -300, y: 0, w: 40, h: 40, gravity: -1 }, planets);
 const north = draw({ shape: 'box', x: 0, y: -300, w: 40, h: 40, gravity: -1 }, planets);
 // local +y must be the real down: (0,1) through rotate(a) is (−sin a, cos a)
 const localDown = (a) => ({ x: -Math.sin(a), y: Math.cos(a) });
 const w = localDown(west.rot), n = localDown(north.rot);
 gate('30. on a PLANET the arrow turns with the field rather than with the screen',
 Math.abs(w.x - 1) < 1e-9 && Math.abs(w.y) < 1e-9 && Math.abs(n.y - 1) < 1e-9 && Math.abs(n.x) < 1e-9,
 `west of the planet down is (${w.x.toFixed(2)},${w.y.toFixed(2)}), north of it (${n.x.toFixed(2)},${n.y.toFixed(2)})`);
 gate('30. …and with no planet it is plain screen-down, exactly as before',
 draw(crate({ gravity: -1 })).rot === 0, 'rotate(0)');
 }
 }
}

// ---------- gate 30g: the same dial on a GOAL PIECE, and the sky it closes ----
//
// 2026-08-14, on request ("Add gravity to goal pieces (same as Props)", then
// "pieces that float away are lost"). Two claims, and the second is the one
// with teeth:
//
// 1. the cargo obeys the dial exactly as a prop does — same clamp, same
// symmetry, same absent-is-1;
// 2. a goal piece that can never come down is LOST when it clears the level,
// and one that can is not — however high it is thrown.
//
// (2) is where a mistake would be expensive and quiet. An ordinary level's sky
// is deliberately open (sim.js VOID_DROP), so a catapult mid-arc must go on
// counting; get the rule wrong in the general direction and every thrown-cargo
// level in the game starts declaring a loss halfway through a winning run. The
// last gate here is that control, and it is the reason `floatsAway` keys off
// the authored dial rather than off which way the piece happens to be moving.
{
 const goalDrop = (gravity, frames = 30) => { // 30 frames = 1 s (FC's clock)
 const lvl = flatLevel();
 lvl.goalObjs = [{ shape: 'ball', x: 0, y: -400, r: 15, ...(gravity === undefined ? {} : { gravity }) }];
 const sim = new Simulation(lvl, { parts: [] });
 for (let i = 0; i < frames; i++) sim._fixedStep();
 const p = sim._pose(sim.goals[0].body);
 sim.destroy();
 return p.y + 400; // + is down the screen, − is up
 };

 const gDown = goalDrop(1);
 gate('30g. an ordinary goal piece falls exactly as it always did',
 Math.abs(gDown - goalDrop(undefined)) < 1e-9 && gDown > 100,
 `${gDown.toFixed(3)} px in 1 s, and an absent gravity is identical`);
 const gUp = goalDrop(-1);
 gate('30g. …and at −1 the cargo falls UP as fast as it falls down',
 gUp < 0 && Math.abs(gUp + gDown) < 1e-3, `up ${gUp.toFixed(4)} px vs down ${gDown.toFixed(4)} px`);
 gate('30g. …at 0 it hangs where the author put it',
 Math.abs(goalDrop(0)) < 1e-4, `${goalDrop(0).toExponential(1)} px`);
 gate('30g. …and a hand-written −50 is clamped to the dial, not simulated',
 Math.abs(goalDrop(-50) - goalDrop(PIECE_GRAVITY_MIN)) < 1e-9,
 `${goalDrop(-50).toFixed(3)} px, the same as ${PIECE_GRAVITY_MIN}×`);

 // Who gets a ceiling — the pure rule, before any of it is simulated.
 gate('30g. only a piece that cannot come down is given a ceiling',
 floatsAway({ gravity: -1 }) && floatsAway({ gravity: 0 })
 && !floatsAway({ gravity: 0.5 }) && !floatsAway({}) && !floatsAway({ gravity: 1 }),
 '−1 and 0 float; 0.5, 1 and absent come home');

 // …and the ceiling itself, run.
 const runFor = (goal, seconds, design = { parts: [] }) => {
 const lvl = flatLevel();
 lvl.goalObjs = [goal];
 const sim = new Simulation(lvl, design);
 const steps = Math.round(seconds * 60);
 for (let i = 0; i < steps && !sim.goalLost; i++) sim._fixedStep();
 const out = { lost: sim.goalLost, up: sim.goalLostUp, y: sim._pose(sim.goals[0].body).y, above: sim.voidLine.above };
 sim.destroy();
 return out;
 };
 const floated = runFor({ shape: 'ball', x: 0, y: -15, r: 15, gravity: -1 }, 12);
 gate('30g. a goal piece that floats away is LOST once it clears the level',
 floated.lost === true, `left through the ceiling (level top ${floated.above})`);
 // …and the client is told WHICH WAY, because it says a different sentence:
 // "floated away for good" against "fell into the void" (game.js).
 gate('30g. …and the sim reports that it went UP, not that it fell',
 floated.up === true, `goalLostUp ${floated.up}`);
 const hung = runFor({ shape: 'ball', x: 0, y: -15, r: 15, gravity: 0 }, 12);
 gate('30g. …while one that merely HANGS is not — it never went anywhere',
 hung.lost === false, `still at y ${hung.y.toFixed(1)}`);

 // **The control, and the whole reason the ceiling is opt-in.** An ordinary
 // goal piece fired straight up at 2000 px/s rises far past anything the level
 // authored — and must still be in play the entire way, because it is coming
 // back. Velocity is set directly rather than built into a catapult: the claim
 // is about the RULE, and a rig that has to be aimed would be measuring the
 // rig.
 {
 const lvl = flatLevel();
 lvl.goalObjs = [{ shape: 'ball', x: 0, y: -15, r: 15 }];
 const sim = new Simulation(lvl, { parts: [] });
 const body = sim.goals[0].body;
 sim.E.body_set_vel(body, 0, -2000, 0);
 let peak = 0, lost = false;
 for (let i = 0; i < 60 * 12 && !lost; i++) {
 sim._fixedStep();
 peak = Math.min(peak, sim._pose(body).y);
 lost = sim.goalLost;
 }
 sim.destroy();
 gate('30g. …and an ORDINARY goal piece thrown that high is never lost — the sky stays open',
 lost === false && peak < -1000,
 `rose to y ${peak.toFixed(0)} and stayed in play`);
 }
}

// ---------- gate 31: a prop's texture (§10.1) ----------
//
// Sixteen of them, and the one that matters most is the one nobody asks for:
// **that they are all still there**. The vocabulary lives in sizes.js so the
// server can validate without importing a renderer, and the looks live in
// render.js — split ownership, and the failure split ownership produces is a
// texture that draws but cannot be saved, or saves but cannot draw. Neither is
// visible by looking at either file.
{
 // A canvas stub, because a tile is built on one. Node has no `document`, and
 // this is the cheapest honest shim: every 2D call is recorded and every
 // gradient hands back something with `addColorStop`. It also means the tile
 // BUILDER runs for all sixteen below — if one of them threw, or reached for a
 // context method that does not exist, it would surface here rather than in
 // front of whoever first picked that swatch.
 const drawn = [];
 // …and a DOMMatrix, which is what the three animated ones move their pattern
 // with. render.js guards its absence (a browser without it gets a still
 // texture rather than a throw), so without this shim the animation gates
 // below would pass vacuously by measuring the fallback.
 globalThis.DOMMatrix = globalThis.DOMMatrix || class { constructor(m) { this.m = m; } };
 globalThis.document = globalThis.document || {
 createElement: () => ({
 width: 0, height: 0,
 toDataURL: () => 'data:,',
 getContext: () => new Proxy({}, {
 get: (_, k) => {
 if (k === 'createLinearGradient' || k === 'createRadialGradient') {
 return () => ({ addColorStop() {} });
 }
 if (k === 'createPattern') return () => ({ setTransform() {} });
 if (k === 'canvas') return { width: 64, height: 64 };
 if (typeof k === 'symbol') return undefined;
 return (...a) => { drawn.push([k, ...a]); };
 },
 set: () => true,
 }),
 }),
 };

 gate('31. there are sixteen prop textures', PROP_TEXTURES.length === 16, PROP_TEXTURES.join(' '));
 {
 let broke = null;
 for (const tx of PROP_TEXTURES) {
 drawn.length = 0;
 try { propTextureTile(tx); } catch (e) { broke = `${tx}: ${e.message}`; break; }
 if (!drawn.length) { broke = `${tx} drew nothing at all`; break; }
 }
 gate('31. every one of them actually builds a tile', !broke, broke || 'all sixteen drew');
 }
 gate('31. …and the schema\'s list and the renderer\'s are the SAME list',
 PROP_TEXTURES.join(',') === PROP_TEX_LOOKS.join(','),
 `sizes.js ${PROP_TEXTURES.length}, render.js ${PROP_TEX_LOOKS.length}`);
 gate('31. …with no duplicates and none shared with a terrain texture',
 new Set(PROP_TEXTURES).size === 16 && !PROP_TEXTURES.some(t => TEXTURES.includes(t)),
 `terrain has ${TEXTURES.length}, and the two sets are disjoint`);
 gate('31. an unknown name is not a texture, so nothing falls back silently',
 !isPropTexture('granite') && !isPropTexture('') && !isPropTexture(undefined)
 && PROP_TEXTURES.every(isPropTexture),
 'granite is terrain\'s, and absent is plain');

 // The DRAWING, against a recording context. A textured prop must fill with a
 // pattern and an untextured one with a colour — the plain prop is every prop
 // in every level that already exists, and it has to come out byte-identical.
 {
 const drawWith = (p) => {
 const calls = [];
 const rec = new Proxy({}, {
 get: (_, k) => {
 if (k === 'canvas') return { width: 8, height: 8 };
 if (k === 'createPattern') return () => ({ setTransform(m) { calls.push(['setTransform', m]); } });
 if (typeof k === 'symbol') return undefined;
 return (...a) => { calls.push([k, ...a]); };
 },
 set: (_, k, v) => { calls.push(['=' + String(k), v]); return true; },
 });
 drawProp(rec, p, null, { t: 1 });
 return calls;
 };
 // **The LAST fillStyle is no longer the body's** (amended 2026-08-23). A
 // prop is now seated and lit — a shape-following shadow before the body
 // and two clipped crescents after it — so the last colour set belongs to
 // the light, not to the material, and `pop()` was reading it. That is the
 // proxy going stale, not the claim: what this gate means is that a
 // TEXTURED prop's body fills with a pattern and a PLAIN one's never does,
 // and asking whether a pattern was used at all says exactly that however
 // many passes are laid over the top.
 const styles = (calls) => calls.filter(c => c[0] === '=fillStyle').map(c => c[1]);
 const usedPattern = (calls) => styles(calls).some((v) => v && typeof v === 'object');
 const plainCalls = drawWith({ shape: 'box', x: 0, y: 0, w: 40, h: 40 });
 const candyCalls = drawWith({ shape: 'box', x: 0, y: 0, w: 40, h: 40, texture: 'candy' });
 // `rgb(` specifically, not `#`: densityShade returns rgb() and the light's
 // own ink and key are hex, so this picks the BODY's colour and cannot be
 // satisfied by the seat that is now drawn under it. The first version of
 // this amendment matched either and reported #0a1220 — the shadow —
 // which is a gate passing for the wrong reason.
 const plain = styles(plainCalls).find((v) => typeof v === 'string' && /^rgb\(/.test(v));
 const candy = usedPattern(candyCalls) ? 'pattern' : styles(candyCalls).pop();
 gate('31. a plain prop still fills with a COLOUR, exactly as it always did',
 typeof plain === 'string' && /^rgb\(/.test(plain) && !usedPattern(plainCalls),
 String(plain));
 gate('31. …and a textured one fills with a pattern instead',
 usedPattern(candyCalls), String(candy));
 // an unknown texture must not become a pattern — it falls back to plain,
 // which is what the server refusing it upstream is protecting
 const bogusCalls = drawWith({ shape: 'ball', x: 0, y: 0, r: 20, texture: 'granite' });
 const bogus = styles(bogusCalls).find((v) => typeof v === 'string' && /^rgb\(/.test(v));
 gate('31. …and a TERRAIN texture on a prop draws plain rather than half-working',
 !usedPattern(bogusCalls) && bogus === plain, String(bogus));

 // Exactly three move, and they move by transforming the PATTERN — not by
 // rebuilding a tile per frame, which is what would put them on the frame
 // budget probe-cost.mjs says the renderer already owns.
 const moves = PROP_TEXTURES.filter(tx =>
 drawWith({ shape: 'box', x: 0, y: 0, w: 40, h: 40, texture: tx }).some(c => c[0] === 'setTransform'));
 gate('31. three textures are animated, and animate by moving the pattern',
 moves.length === 3, moves.join(', ') || 'none');
 gate('31. …and the other thirteen are perfectly still',
 moves.length === 3 && PROP_TEXTURES.filter(t => !moves.includes(t)).length === 13,
 `${16 - moves.length} static`);
 }
}

// ---------- gate 32: the playback speed ladder, and what MAX may spend ----
//
// The loop that spends this is a DOM frame handler and cannot be reached from
// here, which is exactly why the LADDER and the BUDGET RULE live in util.js:
// what a gate can hold is that the rungs are the ones intended, that MAX is a
// sentinel rather than a number anyone can multiply by, and that its budget
// leaves the renderer its measured cost while never taking a whole frame.
{
 const { SPEED_NOTCHES, SPEED_DEFAULT_NOTCH, PLAY_MAX, PLAY_MAX_STEPS, speedBudgetMs, speedLabel,
 SPEED_BUDGET_FLOOR_MS, SPEED_BUDGET_SHARE, stepsForNotch } = await import(u('public/js/util.js'));
 const STEP_S = 1 / 30;
 gate('32. the ladder is the notches, in order, with 1× on it exactly',
 SPEED_NOTCHES.filter((n) => n === 1).length === 1
 && SPEED_NOTCHES.every((n, i) => i === 0 || n > SPEED_NOTCHES[i - 1])
 && SPEED_DEFAULT_NOTCH === SPEED_NOTCHES.indexOf(1),
 SPEED_NOTCHES.map((n) => speedLabel(n)).join(' '));
 gate('32. ...topped by ×32 and then MAX, which is a sentinel and not a rate',
 SPEED_NOTCHES[SPEED_NOTCHES.length - 2] === 32
 && SPEED_NOTCHES[SPEED_NOTCHES.length - 1] === PLAY_MAX
 && !Number.isFinite(PLAY_MAX),
 speedLabel(PLAY_MAX) + ' / ' + speedLabel(PLAY_MAX, 183.4));
 // The whole point of MAX: the number it spends is the one that VARIES. A
 // level whose draw eats the frame keeps its frame rate and fast-forwards
 // less; a cheap one takes the rest. Never the whole frame.
 gate('32. MAX takes what the renderer leaves of the REAL frame',
 speedBudgetMs(0, 1000 / 60) === (1000 / 60) * SPEED_BUDGET_SHARE
 && speedBudgetMs(14, 1000 / 60) === SPEED_BUDGET_FLOOR_MS
 && speedBudgetMs(6, 1000 / 60) > SPEED_BUDGET_FLOOR_MS,
 `at 60 fps: draw 0 → ${speedBudgetMs(0, 1000 / 60).toFixed(1)} ms, draw 6 → ${speedBudgetMs(6, 1000 / 60).toFixed(1)} ms, draw 14 → ${speedBudgetMs(14, 1000 / 60)} ms`);
 // **The bug this gate exists for.** A budget carved out of an ASSUMED 16.7 ms
 // frame shrinks, per second, exactly when the frame rate drops — which is
 // when a level is heavy, which is when fast-forward matters most. The budget
 // must GROW with the frame, not stay put.
 gate('32. ...and a slower frame gets a bigger budget, not a smaller share',
 [30, 20, 10].every((fps) => speedBudgetMs(1000 / fps * 0.65, 1000 / fps) > speedBudgetMs(1000 / 60 * 0.65, 1000 / 60)),
 [60, 30, 20, 10].map((f) => `${f}fps ${speedBudgetMs(1000 / f * 0.65, 1000 / f).toFixed(1)}ms`).join(' '));
 gate('32. ...and a junk frame or draw time cannot unbound it',
 [NaN, -50, Infinity, undefined, null, 0].every((v) =>
 [NaN, -1, Infinity, undefined, null, 0, 5000].every((f) => {
 const b = speedBudgetMs(v, f);
 return b >= SPEED_BUDGET_FLOOR_MS && b <= 200 * SPEED_BUDGET_SHARE;
 })));
 // **MAX is never slower than the notch below it.** That is a promise the
 // name makes, and it is the floor the loop runs to: whatever ×32 asks for in
 // THIS frame, MAX does at least that before it consults any clock.
 {
 const top = SPEED_NOTCHES[SPEED_NOTCHES.length - 2];
 const at = (fps) => stepsForNotch(top, 1 / fps, STEP_S);
 gate('32. the floor under MAX is what ×32 asks for in the same frame',
 at(60) === 16 && at(30) === 32 && at(10) === 96
 && [60, 30, 20, 10].every((fps) => Math.abs(at(fps) * STEP_S * fps - top) < 1),
 [60, 30, 20, 10].map((f) => `${f}fps ${at(f)} steps`).join(' '));
 // …and the heaviest machine in the corpus fits inside that floor's budget,
 // so the floor is a floor and not a cliff: 0.17 ms a step, measured today.
 gate('32. ...and even the heaviest machine fits its floor inside the frame',
 [60, 30, 20, 10].every((fps) => at(fps) * 0.17 < speedBudgetMs(1000 / fps * 0.65, 1000 / fps) + 1),
 [60, 30, 20, 10].map((f) => `${f}fps: ${(at(f) * 0.17).toFixed(1)}ms of steps in a ${speedBudgetMs(1000 / f * 0.65, 1000 / f).toFixed(1)}ms budget`).join(' · '));
 gate('32. ...and the step cap never undercuts that floor',
 [60, 30, 20, 10].every((fps) => Math.max(PLAY_MAX_STEPS, at(fps)) >= at(fps)));
 }
 // The count cap is the backstop the clock cannot be: ten seconds of
 // simulated time in one frame, and never more than the sound buffer can
 // report on.
 gate('32. the step cap is a backstop in SIMULATED seconds, not a guess',
 PLAY_MAX_STEPS === 300 && PLAY_MAX_STEPS / 30 === 10, `${PLAY_MAX_STEPS} steps = ${PLAY_MAX_STEPS / 30} s of simulated time`);
 // What ×32 costs, measured rather than asserted — 16 steps in a frame, on
 // the heaviest machine the corpus has (a 103-piece Sticks solve is ~165 µs
 // a step; this rig is a stand-in with a step cost in the same country).
 {
 const parts = [];
 for (let i = 0; i < 24; i++) {
 parts.push({ t: 'rod', kind: 'wood', x1: -300 + i * 25, y1: -15, x2: -275 + i * 25, y2: -15, id: 'r' + i });
 parts.push({ t: 'rod', kind: 'wood', x1: -300 + i * 25, y1: -15, x2: -300 + i * 25, y2: -45, id: 'v' + i });
 }
 const sim = new Simulation(flatLevel(), { parts });
 for (let i = 0; i < 60; i++) sim._fixedStep(); // settle, then time it
 const t0 = performance.now();
 for (let i = 0; i < 16; i++) sim._fixedStep();
 const ms = performance.now() - t0;
 sim.destroy();
 gate('32. ×32 is 16 steps a frame, and 16 steps of a 48-part machine fit in one',
 ms < 1000 / 60, `${ms.toFixed(2)} ms for the 16 steps ×32 asks for`);
 }
}

summary();
