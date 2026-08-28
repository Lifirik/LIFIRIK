// verify-tutorial.mjs — the #/learn page's live demos must WIN (§18).
//
// The tutorial embeds real Simulations of tutorial-demos.js and says "watch
// it work". A physics retune that breaks these machines would quietly turn
// that into "watch it fail" — the one page a brand-new player is guaranteed
// to be looking at. So the demos are gated like officials: they must solve,
// and solve QUICKLY, because a demo that wins at t=40 is a demo nobody
// watches to the end.
//
// Two dead ends from designing the catapult, recorded because they are engine
// truths, not coordinate accidents:
//  - a windmill on a stand collapses: every rod pinned at a powered hub gets
//    a motor joint, so the "stand" eats the wheel's full reaction torque;
//  - a rigid arm on a powered wheel STALLS: the motor drives the wheel
//    RELATIVE TO the arm — bolt them together and the motor fights the bolt.
//    A powered wheel can drive a hinge or nothing.
//
// Run: node scripts/verify-tutorial.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { initEngine, Simulation } = await import(u('public/js/sim.js'));
const {
  CART_LEVEL, CART_DESIGN, CATAPULT_LEVEL, CATAPULT_DESIGN, DEMO_LOOP_S,
  STAND_LEVEL, STAND_JOINED, STAND_LOOSE, LANE_LEVEL, laneCart, DEMO_CLAIMS,
  SOLO_LEVEL, SOLO_DESIGN, SOLO_BARE, BEAM_LEVEL, BEAM_LIGHT, BEAM_HEAVY,
  GRIP_LEVEL, GRIP_SHOWN, BELT_LEVEL, MOVER_LEVEL, MOVER_DESIGN,
  PIN_LEVEL, SPIN_LEVEL, LIFT_LEVEL, STILL_PICTURES,
} = await import(u('public/js/tutorial-demos.js'));
await initEngine(u('public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

function run(level, design, seconds = 15) {
  const sim = new Simulation(level, design);
  for (let i = 0; i < seconds * 60 && !sim.won; i++) sim._fixedStep();
  return sim;
}

// ---------- the cart ----------
{
  const sim = run(CART_LEVEL, CART_DESIGN);
  gate('1. the cart demo wins', sim.won, sim.won ? `t=${sim.winTime.toFixed(2)}s` : 'never won');
  gate('1. …inside its loop window, with time to enjoy it',
    sim.won && sim.winTime < DEMO_LOOP_S.cart - 2,
    `win ${sim.winTime?.toFixed(2)}s, loop ${DEMO_LOOP_S.cart}s`);
  gate('1. …and both hub pins actually formed', sim.jointRecs.length === 2,
    `${sim.jointRecs.length} joints`);
}

// ---------- the catapult ----------
{
  // apex tracked because the payload must FLY: an earlier ball payload "won"
  // by being shoved along the ground into the zone — a delivery, not a
  // catapult. The crate cannot roll, and this gate pins the airborne arc.
  const sim = new Simulation(CATAPULT_LEVEL, CATAPULT_DESIGN);
  let apex = 1e9;
  for (let i = 0; i < 900 && !sim.won; i++) {
    sim._fixedStep();
    apex = Math.min(apex, sim._pose(sim.goals[0].body).y);
  }
  gate('2. the catapult demo wins', sim.won, sim.won ? `t=${sim.winTime.toFixed(2)}s` : 'never won');
  gate('2. …and the crate actually FLIES — 40+ px of air under it',
    apex < CATAPULT_LEVEL.goalObjs[0].y - 40,
    `apex y=${apex.toFixed(0)}, started ${CATAPULT_LEVEL.goalObjs[0].y}`);
  gate('2. …inside its loop window',
    sim.won && sim.winTime < DEMO_LOOP_S.catapult - 2,
    `win ${sim.winTime?.toFixed(2)}s, loop ${DEMO_LOOP_S.catapult}s`);
  // it must THROW, not shove: the crate has to travel a long way downrange,
  // which is the difference between a catapult and a very slow bulldozer
  const g = sim._pose(sim.goals[0].body);
  const start = CATAPULT_LEVEL.goalObjs[0].x;
  gate('2. …and is thrown a long way downrange, not shoved',
    g.x - start > 250, `travelled ${(g.x - start).toFixed(0)} px from x=${start}`);
  // the stand must survive its own throw — a collapsed A-frame reads as a bug
  // to a newcomer even when the crate lands
  const legs = sim.rods.filter(r => /leg|base/.test(r.part.id));
  const standing = legs.every(r => sim._pose(r.body).y < 40);
  gate('2. …with the A-frame stand still standing', standing,
    legs.map(r => `${r.part.id}:y=${sim._pose(r.body).y.toFixed(0)}`).join(' '));
  // …and the crate STAYS delivered. Without the backstop it clipped the zone
  // in passing, won on the way through, and sailed off the world — a solve
  // that looks exactly like a miss on the page that teaches what a solve is.
  {
    const s2 = new Simulation(CATAPULT_LEVEL, CATAPULT_DESIGN);
    for (let i = 0; i < 420; i++) s2._fixedStep();
    const g2 = s2._pose(s2.goals[0].body);
    const z = CATAPULT_LEVEL.goalZones[0];
    gate('2. …and the crate comes to REST inside the goal zone',
      Math.abs(g2.x - z.x) < z.w / 2 && g2.y < 20,
      `resting at (${g2.x.toFixed(0)}, ${g2.y.toFixed(0)}), zone x=${z.x}±${z.w / 2}`);
  }
}

// ---------- the contrast pair: ends that meet, join ----------
//
// **A counter-example that quietly starts working is exactly as broken as an
// example that stops.** The page puts these two side by side and says the only
// difference is whether the ends touch, so both halves are gated: the joined
// frame must hold its plank up, and the loose one must drop it.
//
// Two earlier contrasts died here, and they are why this one is a loaded
// A-frame rather than something with a goal in it:
//  - an unjoined CART still WINS (measured: 3.42 s, 0 joints). The stick falls
//    off and a lone powered wheel shoves the ball in on its own;
//  - an unjoined CATAPULT wins at a 3 px gap and loses at 2 and 4 — the
//    collapsing stand flings the crate in by luck. A lesson that rests on
//    chaos will one day teach the opposite of what it says.
{
  const loadY = (design) => {
    const sim = new Simulation(STAND_LEVEL, design);
    for (let i = 0; i < 300; i++) sim._fixedStep();       // 5 s
    const rec = sim.rods.find((r) => r.part.id === 'load');
    const y = sim._pose(rec.body).y;
    sim.destroy();
    return y;
  };
  const joined = loadY(STAND_JOINED), loose = loadY(STAND_LOOSE);
  // y is DOWN: held high is a big negative number, on the floor is near zero
  gate('3. the joined A-frame holds its plank up', joined < -60, `plank at y=${joined.toFixed(0)}`);
  gate('3. …and the loose one drops it on the floor', loose > -20, `plank at y=${loose.toFixed(0)}`);
  gate('3. …with a gap between them nobody could miss', joined - loose < -50,
    `${(loose - joined).toFixed(0)} px apart`);
  const nj = new Simulation(STAND_LEVEL, STAND_JOINED), nl = new Simulation(STAND_LEVEL, STAND_LOOSE);
  gate('3. …and it really is the JOINTS that differ, nothing else',
    nj.jointRecs.length === 3 && nl.jointRecs.length === 0
      && STAND_JOINED.parts.length === STAND_LOOSE.parts.length,
    `${nj.jointRecs.length} joints vs ${nl.jointRecs.length}, ${STAND_JOINED.parts.length} sticks each`);
  nj.destroy(); nl.destroy();
}

// ---------- the three wheels ----------
{
  const travel = (kind) => {
    const sim = new Simulation(LANE_LEVEL, laneCart(kind));
    const x0 = sim._pose(sim.wheels[0].body).x;
    for (let i = 0; i < 180; i++) sim._fixedStep();       // 3 s
    const dx = sim._pose(sim.wheels[0].body).x - x0;
    sim.destroy();
    return dx;
  };
  const l = travel('ccw'), f = travel('free'), r = travel('cw');
  gate('4. L drives left, R drives right, F does neither',
    l < -200 && r > 200 && Math.abs(f) < 5,
    `L ${l.toFixed(0)} px, F ${f.toFixed(0)} px, R ${r.toFixed(0)} px in 3 s`);
  // the picture only works if the two powered lanes are mirror images
  gate('4. …and the two powered lanes are mirrors of each other',
    Math.abs(l + r) < 1, `${l.toFixed(1)} vs ${r.toFixed(1)}`);
}

// ---------- every claim the page makes, checked against the sim ----------
//
// DEMO_CLAIMS is what the tutorial asserts, as data. Walking it here means a
// demo added to the page without a gate fails THIS gate rather than shipping
// unproven — the list and the page read the same array.
{
  let checked = 0, wrong = [];
  for (const c of DEMO_CLAIMS) {
    const sim = new Simulation(c.level, c.design);
    if (c.wins != null) {
      for (let i = 0; i < 15 * 60 && !sim.won; i++) sim._fixedStep();
      if (sim.won !== c.wins) wrong.push(`${c.id} won=${sim.won}`);
      else if (c.within != null && sim.winTime > c.within) wrong.push(`${c.id} slow (${sim.winTime.toFixed(1)}s)`);
    } else if (c.holdsUp != null) {
      for (let i = 0; i < 300; i++) sim._fixedStep();
      const y = sim._pose(sim.rods.find((r) => r.part.id === 'load').body).y;
      if ((y < -60) !== c.holdsUp) wrong.push(`${c.id} plank y=${y.toFixed(0)}`);
    } else if (c.quiet) {
      for (let i = 0; i < 10 * 60 && !sim.won; i++) sim._fixedStep();
      if (sim.won) wrong.push(`${c.id} won at ${sim.winTime.toFixed(1)}s`);
    } else if (c.travels != null) {
      const x0 = sim._pose(sim.wheels[0].body).x;
      for (let i = 0; i < 180; i++) sim._fixedStep();
      const dx = sim._pose(sim.wheels[0].body).x - x0;
      const dir = Math.abs(dx) < 5 ? 0 : Math.sign(dx);
      if (dir !== c.travels) wrong.push(`${c.id} went ${dx.toFixed(0)}`);
    } else wrong.push(`${c.id} claims nothing`);
    sim.destroy();
    checked++;
  }
  gate('5. every demo on the page does what the page says it does',
    checked === DEMO_CLAIMS.length && !wrong.length,
    wrong.length ? wrong.join('; ') : `${checked} demos checked`);
}

// ---------- no demo may start already solved ----------
//
// A level needs a goal piece and a goal zone to be a legal level, so the demos
// that are not ABOUT winning (the contrast pair, the three lanes) still carry
// both — and the first cut of them parked the ball inside the zone. The sim
// won on frame one and the page drew "★ Solved!" in gold across a heap of
// collapsed sticks, on the step whose entire job is to show that heap failing.
// Caught by looking at the page, which is the only thing that would have.
{
  const preSolved = [];
  for (const c of DEMO_CLAIMS) {
    const sim = new Simulation(c.level, c.design);
    sim._fixedStep();
    if (sim.won) preSolved.push(c.id);
    sim.destroy();
  }
  gate('6. no demo begins already won', !preSolved.length,
    preSolved.length ? `pre-solved: ${preSolved.join(', ')}` : `${DEMO_CLAIMS.length} demos start unsolved`);
}
// …and the ones that never win must never win, or the banner turns up late
{
  const quiet = ['stand-joined', 'stand-loose', 'lane-ccw', 'lane-free', 'lane-cw'];
  const noisy = [];
  for (const c of DEMO_CLAIMS.filter((d) => quiet.includes(d.id))) {
    const sim = new Simulation(c.level, c.design);
    for (let i = 0; i < 10 * 60 && !sim.won; i++) sim._fixedStep();
    if (sim.won) noisy.push(`${c.id} at ${sim.winTime.toFixed(1)}s`);
    sim.destroy();
  }
  gate('6. …and the demos that are not about winning never do',
    !noisy.length, noisy.length ? noisy.join('; ') : `${quiet.length} demos stay quiet for 10 s`);
}

// ---------- the FC retraining demos (§18) ----------
//
// Each shows a difference an FC player would otherwise have to be TOLD, so each
// is a claim about THIS engine that has to keep being true.
{
  // **No axle, no power** (e08cb4a, 2026-08-24): a powered wheel is a motor
  // only if something sits on its hub (a rod end, or any pin). Both halves of the page's
  // contrast are gated — the bare wheel must go NOWHERE (a counter-example
  // that quietly starts working is exactly as broken as an example that
  // stops), and the axled one must deliver, with exactly the one hub joint
  // doing the work.
  const bare = new Simulation(SOLO_LEVEL, SOLO_BARE);
  for (let i = 0; i < 480; i++) bare._fixedStep();
  const drift = Math.abs(bare._pose(bare.wheels[0].body).x - (-200));
  gate('7. a bare powered wheel free-rolls and goes nowhere',
    !bare.won && drift < 5 && bare.jointRecs.length === 0,
    `drifted ${drift.toFixed(1)} px in 8 s, ${bare.jointRecs.length} joints, won=${bare.won}`);
  bare.destroy();
  const sim = run(SOLO_LEVEL, SOLO_DESIGN);
  gate('7. …and one stick on its hub makes it a motor that delivers',
    sim.won && sim.jointRecs.length === 1,
    sim.won ? 't=' + sim.winTime.toFixed(2) + 's, ' + sim.jointRecs.length + ' joint' : 'never won');
  sim.destroy();
}
{
  // The weight dial, against a balance beam: same stick each side, only the
  // right one's weight changed.
  const tilt = (design) => {
    const s = new Simulation(BEAM_LEVEL, design);
    let worst = 0;
    for (let i = 0; i < 168; i++) {                       // 2.8 s, the demo's loop
      s._fixedStep();
      const p = s._pose(s.rods.find((r) => r.part.id === 'beam').body);
      worst = Math.max(worst, Math.abs(Math.atan2(p.s, p.c) * 180 / Math.PI));
    }
    s.destroy();
    return worst;
  };
  const light = tilt(BEAM_LIGHT), heavy = tilt(BEAM_HEAVY);
  gate('7. a x1 stick leaves the beam dead level', light < 1, light.toFixed(1) + '°');
  // **The bar is 45°, not 90°** (2026-08-12). 90 was reading an OVERSHOOT, not
  // the tilt: with rods barely damped the loaded end used to swing past vertical
  // before coming back. Under FC damping the beam goes over and STAYS at 68.8°,
  // and it is 68.8° at 2.8 s, at 6 s and at 10 s alike — a resting angle, not a
  // demo that ran out of time. Against a x1 stick's 0.0° that is the lesson the
  // page claims, so the gate now asks for a decisive tilt rather than for the
  // wobble that used to accompany it.
  gate('7. ...and the SAME stick at x400 slams it down',
    heavy > 45 && heavy > light + 40, heavy.toFixed(1) + '° against ' + light.toFixed(1) + '°');
}
{
  // Ground is a material — the STATIC GRIP contrast (re-authored 2026-08-24;
  // the old rolling-ball rig measured rolling resistance, which is dead on
  // fcsim — verify-surfaces gate 6). The same crate on the same tilted floor:
  // mud must hold it essentially where it was put, ice must let it slide
  // clean away.
  const slid = (texture) => {
    const s = new Simulation(GRIP_LEVEL(texture), { parts: [] });
    const x0 = s._pose(s.goals[0].body).x;
    for (let i = 0; i < 480; i++) s._fixedStep();   // 8 s, inside the 7 s loop + settle
    const dx = s._pose(s.goals[0].body).x - x0;
    s.destroy();
    return dx;
  };
  const mud = slid(GRIP_SHOWN[0]), ice = slid(GRIP_SHOWN[1]);
  gate('7. mud holds a crate that ice lets slide away',
    Math.abs(mud) < 3 && ice > 400,
    `mud moved ${mud.toFixed(1)} px, ice ${ice.toFixed(0)} px in 8 s`);
}
{
  // A conveyor carries what touches it, with no machine in the level at all.
  const s = new Simulation(BELT_LEVEL, { parts: [] });
  const x0 = s._pose(s.goals[0].body).x;
  for (let i = 0; i < 300; i++) s._fixedStep();
  const x1 = s._pose(s.goals[0].body).x;
  gate('7. a belt carries a crate that nothing is pushing',
    x1 - x0 > 300, x0.toFixed(0) + ' -> ' + x1.toFixed(0) + ' px in 5 s, 0 machine parts');
  s.destroy();
}
{
  // Even the goal can move (§9.3) - and the level is still solvable with it
  // moving, which is what makes it a feature rather than a stunt.
  const s = new Simulation(MOVER_LEVEL, MOVER_DESIGN);
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < 300; i++) { s._fixedStep(); const z = s.view().goalZones[0]; lo = Math.min(lo, z.x); hi = Math.max(hi, z.x); }
  gate('7. the goal ZONE itself moves', hi - lo > 120, 'x ' + lo.toFixed(0) + ' -> ' + hi.toFixed(0));
  s.destroy();
  const w = run(MOVER_LEVEL, MOVER_DESIGN);
  gate('7. ...and the level is still winnable with it moving',
    w.won, w.won ? 't=' + w.winTime.toFixed(2) + 's' : 'never won');
  w.destroy();
}

// ---------- gate 7b: the Level Maker guide's three moving examples ----------
//
// Every claim the authoring chapter makes about a piece of the LEVEL rather
// than a piece of a machine. Same rule as gate 7: the page says "watch this",
// so a retune that stops it happening fails here rather than showing a reader
// a still picture of a thing described as moving.
{
  // A prop pinned through its middle is a HINGE (§5.6): the plank must really
  // turn, and the crate on its far end must really be thrown. Both halves
  // matter — a plank that tips 3° is a picture of a stuck see-saw.
  const s = new Simulation(PIN_LEVEL, { parts: [] });
  let tilt = 0, lift = 0;
  const crate0 = PIN_LEVEL.props[1].y;
  for (let i = 0; i < 300; i++) {
    s._fixedStep();
    const pl = s._pose(s.props[0].body);
    tilt = Math.max(tilt, Math.abs(Math.atan2(pl.s, pl.c) * 180 / Math.PI));
    lift = Math.max(lift, crate0 - s._pose(s.props[1].body).y);
  }
  gate('7b. a fixed pin makes a see-saw the level runs on its own',
    tilt > 20, `plank reached ${tilt.toFixed(1)}°`);
  gate('7b. …and the crate on the far end is really thrown',
    lift > 60, `${lift.toFixed(0)} px of air`);
  // …and the plank stays where it was pinned. A hinge that drifts is a joint
  // that never formed, which would look identical for the first half-second.
  const at = s._pose(s.props[0].body);
  gate('7b. …with the plank still hanging on its pin',
    Math.hypot(at.x - PIN_LEVEL.props[0].x, at.y - PIN_LEVEL.props[0].y) < 2,
    `centre at (${at.x.toFixed(1)}, ${at.y.toFixed(1)})`);
  s.destroy();
}
{
  // Spin on the spot, with NO waypoints — the state the editor's "↻ spin"
  // button seeds (§9.1) — and it has to do real work on a real body.
  const s = new Simulation(SPIN_LEVEL, { parts: [] });
  const x0 = s._pose(s.props[0].body).x;
  for (let i = 0; i < 300; i++) s._fixedStep();
  const dx = s._pose(s.props[0].body).x - x0;
  gate('7b. a spinning terrain piece sweeps a crate along the floor',
    dx > 150, `crate moved ${dx.toFixed(0)} px in 5 s, 0 machine parts`);
  gate('7b. …and it is spinning with an EMPTY path, not travelling',
    SPIN_LEVEL.terrain[1].path.pts.length === 0 && !!SPIN_LEVEL.terrain[1].path.spin,
    `${SPIN_LEVEL.terrain[1].path.pts.length} waypoints`);
  s.destroy();
}
{
  // Group motion (§9.3): two terrain pieces sharing a groupId, one path on the
  // group, and a crate that is attached to nothing riding it up.
  const s = new Simulation(LIFT_LEVEL, { parts: [] });
  let apart = 0;
  const gap0 = LIFT_LEVEL.terrain[3].x - LIFT_LEVEL.terrain[2].x;
  // Six seconds, NOT "until it wins": the trip is 160 px at 42 px/s, so the
  // crate is inside the zone well before the lift has finished rising, and a
  // loop that stopped on the win would be measuring the platform mid-flight
  // and calling that its resting place.
  for (let i = 0; i < 60 * 6; i++) {
    s._fixedStep();
    const v = s.view();
    apart = Math.max(apart, Math.abs((v.terrain[3].x - v.terrain[2].x) - gap0));
  }
  gate('7b. the grouped lift carries an unattached crate into the goal',
    s.won, s.won ? `t=${s.winTime.toFixed(2)}s` : 'never won');
  gate('7b. …inside its loop window', s.won && s.winTime < DEMO_LOOP_S.lift - 2,
    `win ${s.winTime?.toFixed(2)}s, loop ${DEMO_LOOP_S.lift}s`);
  gate('7b. …with both members travelling as ONE thing',
    apart < 0.5, `members drifted ${apart.toFixed(2)} px apart`);
  const top = s.view().terrain[2].y;
  gate('7b. …and the platform stops where the level says it stops',
    Math.abs(top - (LIFT_LEVEL.terrain[2].y - 160)) < 1,
    `platform rests at y=${top.toFixed(1)}`);
  s.destroy();
}

// ---------- gate 7c: a still picture must be a level AT REST (§18) ----------
//
// The failure this exists for is invisible by inspection and invisible on the
// page: a still picture is drawn at the AUTHORED poses, so a crate floating
// 20 px above the floor, or sunk halfway into it, draws exactly as well as one
// standing on it. Pressing Play is the only thing that can tell, so the gate
// presses Play. Two seconds, and nothing may have gone anywhere.
{
  // Contact resolution and joint compliance, not a fall: a rod capsule rests
  // ~2 px proud, and the PARTS footbridge (span + two braces + roller, all
  // hanging on fc's soft pins) settles 3.8 px as one assembly. A genuinely
  // floating piece falls 16+ px in these two seconds, so 5 still catches
  // every case the gate exists for (raised from 3, 2026-08-24).
  const SETTLE_PX = 5;
  const bad = [];
  for (const pic of STILL_PICTURES) {
    const s = new Simulation(pic.level, { parts: [] });
    const poses = () => [
      ...s.props.map((p) => s._pose(p.body)),
      ...s.goals.map((g) => s._pose(g.body)),
      ...s.rods.map((r) => s._pose(r.body)),
      ...s.wheels.map((w) => s._pose(w.body)),
    ];
    const before = poses();
    for (let i = 0; i < 120; i++) s._fixedStep();
    const after = poses();
    // Count the bodies that MOVED, so a level with one deliberately staged
    // piece is judged on all its others rather than waved through entirely.
    const moved = before
      .map((a, i) => ({ i, d: Math.hypot(after[i].x - a.x, after[i].y - a.y) }))
      .filter((m) => m.d > SETTLE_PX);
    if (moved.length > (pic.staged || 0)) {
      bad.push(`${pic.id}: ${moved.map((m) => `body${m.i} moved ${m.d.toFixed(0)}px`).join(', ')}`);
    }
    s.destroy();
  }
  gate('7c. every still picture is a level that is really at rest',
    bad.length === 0,
    bad.length ? bad.join(' | ') : `${STILL_PICTURES.length} levels settle within ${SETTLE_PX}px`);
}

// ---------- gate 8: the tour's plan and its words agree (§18) ----------
//
// TOUR_PLAN (content.js) is the tutorial's structure as data; the registry
// holds every step's words; main.js holds every step's picture. main.js
// cannot be imported headlessly, but the OTHER two can — and nearly every way
// the tour can rot is a disagreement between them: a step listed with no
// words, words keyed to a step that no longer exists, a chapter that lost its
// steps in an edit. A typo in a step id fails here rather than rendering an
// empty screen at whichever step a newcomer happened to reach.
{
  const { TOUR_PLAN, TOUR_PARTS, CONTENT } = await import(u('public/js/content.js'));
  const stepIds = TOUR_PLAN.flatMap((ch) => ch.steps);
  const tourKeys = CONTENT.filter((c) => c.key.startsWith('tour.')).map((c) => c.key);
  const byKey = new Map(CONTENT.map((c) => [c.key, c]));

  gate('8. no chapter is empty, and every one is named',
    TOUR_PLAN.length > 0 && TOUR_PLAN.every((ch) => ch.steps.length > 0 && ch.id && ch.name && ch.tagline),
    TOUR_PLAN.map((ch) => `${ch.id}:${ch.steps.length}`).join(' '));
  // **The three PARTS are the page's top level**, and each has to be reachable
  // and non-empty. `fc` is deliberately chapter-less — it is a written page,
  // not a tour — so it is the one part allowed no steps, and stating that here
  // is what stops "the FC part has no chapters" from looking like a bug the
  // day somebody counts them.
  const partIds = TOUR_PARTS.map((p) => p.id);
  gate('8. three parts, each named and each a real URL',
    TOUR_PARTS.length === 3 && TOUR_PARTS.every((p) => p.id && p.name && p.tagline && /^\/[a-z/]*$/.test(p.href)),
    TOUR_PARTS.map((p) => `${p.id}→${p.href}`).join(' '));
  const orphanChapters = TOUR_PLAN.filter((ch) => !partIds.includes(ch.part));
  gate('8. …and every chapter belongs to one of them',
    orphanChapters.length === 0,
    orphanChapters.length ? orphanChapters.map((c) => `${c.id}:${c.part}`).join(' ') : `${TOUR_PLAN.length} chapters placed`);
  const stepped = partIds.filter((id) => TOUR_PLAN.some((ch) => ch.part === id));
  gate('8. …and only FC is a part with no chapters in it',
    stepped.length === 2 && !stepped.includes('fc'),
    `stepped parts: ${stepped.join(', ') || 'none'}`);
  gate('8. step ids are unique across the whole tour',
    new Set(stepIds).size === stepIds.length, `${stepIds.length} steps`);
  const missing = stepIds.flatMap((id) =>
    ['title', 'body'].filter((suffix) => !byKey.get(`tour.${id}.${suffix}`)?.def?.trim())
      .map((suffix) => `${id}.${suffix}`));
  gate('8. every planned step has a title and a body in the registry',
    missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${stepIds.length} steps, all worded`);
  const orphans = tourKeys.filter((k) => {
    const m = k.match(/^tour\.(.+)\.(title|body|more)$/);
    return !m || !stepIds.includes(m[1]);
  });
  gate('8. …and no tour words are keyed to a step that does not exist',
    orphans.length === 0, orphans.length ? `orphaned: ${orphans.join(', ')}` : `${tourKeys.length} keys, all owned`);
  // The folds are the layering's second half: a chapter should offer DEPTH
  // without demanding it, and a fold that is empty renders as a dead toggle.
  const emptyMore = tourKeys.filter((k) => k.endsWith('.more') && !byKey.get(k).def.trim());
  gate('8. every fold that exists has words in it',
    emptyMore.length === 0, emptyMore.length ? emptyMore.join(', ') : `${tourKeys.filter((k) => k.endsWith('.more')).length} folds`);
  // **Every link the registry writes must actually go somewhere.**
  //
  // `parseRich` refuses an unrecognised scheme and hands back `#`, which is
  // right for `javascript:` and was silently wrong for `/maker` for as long as
  // routes have been paths rather than hashes (§12): the copy said "open the
  // Maker", the anchor pointed at nothing, and no gate could tell because a
  // dead link renders perfectly. So the two halves are held together — the
  // links we ship must survive the filter, and the things it exists to stop
  // must not.
  {
    const { parseRich } = await import(u('public/js/content.js'));
    // A DOM-less `el`: parseRich only ever asks for a tag, its attrs and its
    // children, so a plain record is a faithful stand-in and this gate needs
    // no browser.
    const el = (tag, attrs = {}, ...kids) => ({ tag, attrs, kids });
    const keys = (...ks) => ({ tag: 'keys', ks });
    const hrefsIn = (node, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (node.tag === 'a') out.push(node.attrs.href);
      for (const k of node.kids || []) hrefsIn(k, out);
      return out;
    };
    const dead = [];
    for (const c of CONTENT) {
      if (typeof c.def !== 'string' || !c.def.includes('](')) continue;
      for (const node of parseRich(c.def, { el, keys })) {
        for (const href of hrefsIn(node)) if (href === '#') dead.push(c.key);
      }
    }
    gate('8. every link in the shipped copy survives the safety filter',
      dead.length === 0, dead.length ? `dead: ${[...new Set(dead)].join(', ')}` : 'all links live');
    const refused = ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'vbscript:x'];
    const leaked = refused.filter((h) => hrefsIn(parseRich(`[x](${h})`, { el, keys })[0])[0] !== '#');
    gate('8. …and the shapes it exists to stop are still stopped',
      leaked.length === 0, leaked.length ? `let through: ${leaked.join(', ')}` : `${refused.length} refused`);
  }
  // The hands-on step banks on this exact promise: CART_LEVEL plus the cart
  // the prose asks for ("two R wheels, one stick between the hubs") wins.
  // Gate 1 proves the design as shipped; this holds the sandbox's version —
  // built the way a reader will build it, snapped ends, nothing fancy.
  const handmade = { parts: [
    { t: 'wheel', kind: 'cw', x: -260, y: -15, r: 15, id: 'h1' },
    { t: 'wheel', kind: 'cw', x: -180, y: -15, r: 15, id: 'h2' },
    { t: 'rod', kind: 'wood', x1: -260, y1: -15, x2: -180, y2: -15, id: 'h3' },
  ] };
  const hm = run(CART_LEVEL, handmade);
  gate('8. the sandbox\'s promised cart really wins on the sandbox\'s level',
    hm.won && hm.jointRecs.length === 2,
    hm.won ? `t=${hm.winTime.toFixed(2)}s, ${hm.jointRecs.length} joints` : 'never won');
  hm.destroy();
}

summary();
