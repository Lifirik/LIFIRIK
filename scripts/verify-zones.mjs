// verify-zones.mjs — §7.2a: zones that touch or overlap are ONE region.
// Run: node scripts/verify-zones.mjs
//
// Two build (or goal) areas drawn edge to edge read as one bigger area, so a
// piece is allowed to span them. Two areas with real space between them do
// not, and nothing may bridge the gap — that separation is the whole reason
// the old rule insisted a piece fit inside ONE rectangle.
//
// The thing that has to be got right is the middle case: a cluster is not a
// bounding box. An L-shaped pair has an inside corner, and a crate parked in
// that notch has all four corners over one arm or the other while its middle
// hangs out in open air. Sampling points would pass it. So the containment
// test is exact (polyInRectUnion subtracts the rects from the piece; anything
// left over is uncovered), and these gates are mostly that notch, from both
// sides — the piece that must fit and the piece that must not.
//
// The geometry gates run on util.js alone. The win gates run the real
// Simulation against the shipped wasm binary, because "the crate is in the
// zone" is only interesting if the win actually fires.
//
// Gate 8 is a different rule that shares the same geometry drawer: props and
// goal pieces are solid to a drag (§8.2), and the tolerance that decides
// "resting against" from "jammed into" is the same 1 px the terrain rules use.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const {
  zoneClusters, joinedZoneClusters, clusterRect,
  polyInRectUnion, segInRectUnion, boundsCorners, piecesOverlap,
  coreGap, coreBox, corePoint, coreSegment, corePoly, pieceGap, boxBoxDist,
  pointSegDist, pointInPoly,
} = await import(u('public/js/util.js'));
const { initEngine, Simulation, GOAL_SLACK, STEP } = await import(u('public/js/sim.js'));
await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

const SLACK = 0.5;                                   // game.js's ZONE_SLACK
const box = (x, y, w, h, angle = 0) => ({ x, y, w, h, angle });
const bounds = (x, y, w, h) => boundsCorners({ minX: x - w / 2, minY: y - h / 2, maxX: x + w / 2, maxY: y + h / 2 });
const sizes = (zs, slack = SLACK) => zoneClusters(zs, slack).map(c => c.length).sort((a, b) => b - a);

// ---------- gate 1: what joins, and what deliberately doesn't ----------
{
  const touching = [box(-50, 0, 100, 100), box(50, 0, 100, 100)];     // share the edge x = 0 exactly
  const overlapping = [box(-40, 0, 100, 100), box(40, 0, 100, 100)];
  const gapped = [box(-55, 0, 100, 100), box(55, 0, 100, 100)];       // 10 px apart
  // 0.8 px apart: under 2×slack, which is exactly the hairline the
  // containment test already papers over. Joining at the same tolerance it
  // tests at is what keeps those two from disagreeing.
  const hairline = [box(-50.4, 0, 100, 100), box(50.4, 0, 100, 100)];

  gate('1. zones sharing an edge exactly are one region', String(sizes(touching)) === '2');
  gate('1. overlapping zones are one region', String(sizes(overlapping)) === '2');
  gate('1. zones 10 px apart stay two regions', String(sizes(gapped)) === '1,1');
  gate('1. a hairline gap (< 2×slack) joins', String(sizes(hairline)) === '2');
  gate('1. a lone zone is never offered as a cluster', joinedZoneClusters([box(0, 0, 100, 100)], SLACK).length === 0);
  gate('1. clusterRect returns a lone zone unchanged, not its bounding box',
    clusterRect(touching.slice(0, 1)) === touching[0]);

  // A chain joins transitively — A touches B touches C — even though A and C
  // never meet. Three tiled zones are one long area, which is how anyone
  // building a wide build area out of repeated blocks would expect it to read.
  const chain = [box(-100, 0, 100, 100), box(0, 0, 100, 100), box(100, 0, 100, 100)];
  gate('1. a chain of three tiled zones is one region', String(sizes(chain)) === '3');
}

// ---------- gate 2: a piece may span a seam, and only a seam ----------
{
  const touching = [box(-50, 0, 100, 100), box(50, 0, 100, 100)];
  const gapped = [box(-55, 0, 100, 100), box(55, 0, 100, 100)];
  const spanner = bounds(0, 0, 60, 40);       // straddles x = 0, fits in neither zone alone

  gate('2. a crate spanning the seam is inside', polyInRectUnion(spanner, touching, SLACK));
  gate('2. the same crate cannot bridge a 10 px gap', !polyInRectUnion(spanner, gapped, SLACK));
  gate('2. a crate off the outer edge is still outside',
    !polyInRectUnion(bounds(120, 0, 60, 40), touching, SLACK));
  // Exact abutment leaves a zero-width strip along the shared edge. If that
  // sliver survived as "uncovered" the seam would be a permanent wall, which
  // is the failure this rule exists to remove.
  gate('2. exact abutment leaves no phantom gap at the seam',
    polyInRectUnion(bounds(0, 0, 2, 100), touching, SLACK));
}

// ---------- gate 3: the notch — a cluster is not its bounding box ----------
{
  // An L: a wide flat arm and a tall one rising off its right end. Their
  // bounding box includes a large empty quadrant that belongs to neither.
  const L = [box(0, 0, 200, 40), box(80, -40, 40, 120)];
  gate('3. a piece in the L\'s empty notch is NOT inside', !polyInRectUnion(bounds(10, -20, 40, 40), L, SLACK));
  gate('3. a piece along the flat arm is inside', polyInRectUnion(bounds(-65, 0, 50, 30), L, SLACK));
  gate('3. a piece up the tall arm is inside', polyInRectUnion(bounds(80, -60, 30, 60), L, SLACK));
  // Straddling the junction is the legal span the whole feature is for.
  gate('3. a piece across the L\'s junction is inside', polyInRectUnion(bounds(80, -10, 34, 50), L, SLACK));
  // Every corner of this one is covered and its middle is not — the exact
  // shape a sampled-points test would wave through.
  const cornersCovered = [box(-60, -60, 80, 80), box(60, -60, 80, 80), box(-60, 60, 80, 80), box(60, 60, 80, 80)];
  gate('3. four zones round a hole: every corner covered, middle not — rejected',
    !polyInRectUnion(bounds(0, 0, 160, 160), cornersCovered, SLACK));
}

// ---------- gate 4: sticks are segments, not boxes ----------
{
  const touching = [box(-50, 0, 100, 100), box(50, 0, 100, 100)];
  const L = [box(0, 0, 200, 40), box(80, -40, 40, 120)];
  gate('4. a stick across the seam is inside', segInRectUnion({ x: -90, y: 0 }, { x: 90, y: 0 }, touching, SLACK));
  gate('4. a stick running off the far edge is not',
    !segInRectUnion({ x: -90, y: 0 }, { x: 140, y: 0 }, touching, SLACK));
  // The diagonal that cuts the L's inside corner: both ENDS are covered, the
  // middle isn't. Endpoint tests — which is what the one-zone rule reduces to
  // for a stick — would pass this if the two zones were treated as one blob.
  gate('4. a stick cutting the L\'s corner is not inside',
    !segInRectUnion({ x: -90, y: 15 }, { x: 80, y: -90 }, L, SLACK));
  gate('4. a stick following the L round its corner is inside',
    segInRectUnion({ x: -90, y: 10 }, { x: 85, y: 10 }, L, SLACK));
}

// ---------- gate 5: rotated zones ----------
{
  // Group rotation can leave zones at an angle, so the union test has to work
  // in each zone's own frame rather than on axis-aligned extents.
  const a = 30 * Math.PI / 180;
  const rot = [box(0, 0, 160, 80, a), box(160 * Math.cos(a), 160 * Math.sin(a), 160, 80, a)];
  gate('5. rotated zones laid end to end join', String(sizes(rot)) === '2');
  const seam = { x: 80 * Math.cos(a), y: 80 * Math.sin(a) };
  gate('5. a small piece on the rotated seam is inside',
    polyInRectUnion(bounds(seam.x, seam.y, 20, 20), rot, SLACK));
  gate('5. a piece off the rotated pair\'s long side is outside',
    polyInRectUnion(bounds(seam.x + 60 * Math.sin(a), seam.y - 60 * Math.cos(a), 20, 20), rot, SLACK) === false);
}

// ---------- gate 6: the win condition actually fires (§7.1) ----------
{
  // Two goal zones side by side, each 60 px wide; the crate is 90 px. It fits
  // in NEITHER on its own, so this level is unwinnable under the one-zone
  // rule and must be winnable now. Dropped from just above the seam so no
  // machine is involved — the question is containment, not physics.
  const pair = (gap) => ({
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
    props: [],
    buildZones: [{ x: -400, y: -75, w: 200, h: 150 }],
    goalZones: [
      { x: -30 - gap / 2, y: -50, w: 60, h: 100 },
      { x: 30 + gap / 2, y: -50, w: 60, h: 100 },
    ],
    goalObjs: [{ shape: 'box', x: 0, y: -46, w: 90, h: 30 }],
    win: 'goalObj',
  });
  const run = (level, frames = 600) => {
    const sim = new Simulation(level, { parts: [] });
    let best = 0;
    for (let i = 0; i < frames && !sim.won; i++) { sim._fixedStep(); best = Math.max(best, sim._winStreak); }
    const out = { won: sim.won, best, y: sim.goals[0] ? sim._pose(sim.goals[0].body).y : null };
    sim.destroy();
    return out;
  };

  const joined = run(pair(0));
  gate('6. a crate too wide for either zone wins across two touching zones',
    joined.won, `won ${joined.won}, best streak ${joined.best}, rests at y ${joined.y?.toFixed(2)}`);

  // Move them 40 px apart and the same crate must NOT win: it now bridges a
  // gap, which is precisely what the one-zone rule was protecting.
  const apart = run(pair(40));
  gate('6. the same crate does NOT win once the zones are 40 px apart',
    !apart.won && apart.best === 0, `won ${apart.won}, best streak ${apart.best}`);

  // And the ordinary case is untouched: one zone, one crate that fits.
  const single = run({
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
    props: [],
    buildZones: [{ x: -400, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 0, y: -50, w: 140, h: 100 }],
    goalObjs: [{ shape: 'box', x: 0, y: -46, w: 90, h: 30 }],
    win: 'goalObj',
  });
  gate('6. a single zone still wins the way it always did', single.won, `best streak ${single.best}`);
}

// ---------- gate 7: Boomerang reads the same regions ----------
{
  // Boomerang asks whether the delivery came all the way home, and it asks it
  // with the same containment test — so a build area made of two touching
  // zones has to award it for a crate spanning the seam back at base.
  const level = {
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
    props: [],
    buildZones: [
      { x: -30, y: -50, w: 60, h: 100 },
      { x: 30, y: -50, w: 60, h: 100 },
    ],
    goalZones: [{ x: 400, y: -50, w: 140, h: 100 }],
    goalObjs: [{ shape: 'box', x: 0, y: -46, w: 90, h: 30 }],
    win: 'goalObj',
  };
  const sim = new Simulation(level, { parts: [] });
  for (let i = 0; i < 90; i++) sim._fixedStep();          // let it settle on the floor
  const home = sim._allGoalsInBuild();
  sim.destroy();
  gate('7. a crate spanning two touching BUILD zones reads as home', home);
}

// ---------- gate 8: props and goal pieces as drag obstacles (§8.2) ----------
{
  // The geometry behind "a dragged prop stops when it touches something".
  // TERRAIN_TOUCH_PAD (1 px) is the flush tolerance: pieces set down against
  // each other by hand never land pixel-perfect, so touching must not read as
  // jammed — while one more pixel of travel must.
  const PAD = 1;
  const at = (x, y) => ({ x, y });
  const crate = { shape: 'box', w: 40, h: 40 };
  const ball = { shape: 'ball', r: 20 };

  gate('8. two crates set flush against each other read as clear',
    !piecesOverlap(crate, at(0, 0), crate, at(40, 0), PAD));
  gate('8. one more pixel of travel is a real overlap',
    piecesOverlap(crate, at(0, 0), crate, at(38.5, 0), PAD));
  gate('8. ball vs ball uses the same tolerance',
    !piecesOverlap(ball, at(0, 0), ball, at(40, 0), PAD) &&
    piecesOverlap(ball, at(0, 0), ball, at(38.5, 0), PAD));
  gate('8. ball vs crate and crate vs ball agree',
    piecesOverlap(ball, at(0, 0), crate, at(35, 0), PAD) ===
    piecesOverlap(crate, at(35, 0), ball, at(0, 0), PAD));
  // A rotated crate is tested in its own frame — its corner reaches further
  // than its flat side, and a drag has to stop on whichever it meets.
  //
  // **The reach is the ROUNDED one**, restated here rather than imported. A
  // 40×40 crate takes `cornerRadiusOf`'s default 8, so its core is 24×24 and
  // it reaches 12 + 8 = 20 across a flat side, but 12√2 + 8 = 24.97 through a
  // corner — not the sharp square's 28.28. This fixture used to sit at 46,
  // which only overlaps if the corner reaches 28.28, so it was asserting a
  // shape that is neither drawn nor simulated. 42 is inside the rounded
  // corner's reach (20 + 24.97 − PAD = 43.97) and outside two flat sides
  // (20 + 20 − PAD = 39), so it still separates the two cases — by the real
  // shape.
  const tilted = { shape: 'box', w: 40, h: 40, angle: Math.PI / 4 };
  const FACE_REACH = 12 + 8, CORNER_REACH = 12 * Math.SQRT2 + 8;
  gate('8. a tilted crate\'s corner reaches further than its side',
    piecesOverlap(crate, at(0, 0), tilted, at(42, 0), PAD) &&
    !piecesOverlap(crate, at(0, 0), crate, at(42, 0), PAD),
    `corner reach ${CORNER_REACH.toFixed(2)} vs face ${FACE_REACH.toFixed(2)}`);
  // …and the corner is an ARC, not a point: a sharp 40×40 would reach 28.28,
  // so a neighbour at 45 must read as CLEAR. Reverting the rounding turns this
  // red on its own.
  gate('8. …and that corner is rounded, not sharp',
    !piecesOverlap(crate, at(0, 0), tilted, at(45, 0), PAD),
    `sharp would reach ${(20 * Math.SQRT2).toFixed(2)}, rounded reaches ${CORNER_REACH.toFixed(2)}`);
  gate('8. pieces well apart never overlap',
    !piecesOverlap(crate, at(0, 0), ball, at(300, 300), PAD));
}

// ---------- gate 9: coreGap IS the drawn shape (§7.2) ----------
//
// Every piece is a convex core inflated by a radius — wheel a point, stick a
// segment, crate a rectangle, painted terrain a polygon — and `coreGap` is the
// one distance every editor rule now asks. So the thing to gate is not any
// rule's tolerance but the CLAIM UNDERNEATH all of them: that this returns the
// distance to the round-rect the renderer strokes.
//
// The reference is that round-rect, rasterised here from the drawn dimensions.
// Nothing is imported from the code under test, and the corner radius is
// restated — a test that silently follows a constant is not gating it.
//
// Three disciplines this file has learned the hard way:
//   - the error is checked SIGNED and two-sided. A one-sided bar cannot tell
//     "right" from "righter than my reference", and gate 49 in verify-editor
//     stayed green for a whole round on exactly that.
//   - the sweep covers ANGLES, not just the axes. 0° and 90° were exact the
//     entire time this bug existed; all of it lived on the diagonal.
//   - and the rig is proved able to FAIL, at the bottom, by asking the same
//     question of a sharp box and requiring a different answer.
{
  const CR_DEFAULT = 8;                       // cornerRadiusOf's default
  const D2R = Math.PI / 180;

  // the shape as DRAWN: flat sides and sampled corner arcs
  const drawn = (o, perCorner = 128) => {
    const hw = o.w / 2, hh = o.h / 2, cr = Math.min(o.radius ?? CR_DEFAULT, hw, hh);
    const a = o.angle || 0, c = Math.cos(a), s = Math.sin(a), pts = [];
    for (const k of [
      { cx: hw - cr, cy: -(hh - cr), a0: -Math.PI / 2 }, { cx: hw - cr, cy: hh - cr, a0: 0 },
      { cx: -(hw - cr), cy: hh - cr, a0: Math.PI / 2 }, { cx: -(hw - cr), cy: -(hh - cr), a0: Math.PI },
    ]) {
      for (let i = 0; i <= perCorner; i++) {
        const t = k.a0 + (Math.PI / 2) * (i / perCorner);
        const lx = k.cx + cr * Math.cos(t), ly = k.cy + cr * Math.sin(t);
        pts.push({ x: (o.x || 0) + lx * c - ly * s, y: (o.y || 0) + lx * s + ly * c });
      }
    }
    return pts;
  };
  const gapToDrawn = (px, py, P) => {
    let best = Infinity;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      best = Math.min(best, pointSegDist(px, py, a.x, a.y, b.x, b.y));
    }
    return pointInPoly(px, py, P) ? -best : best;
  };

  const ANG = [0, 15, 30, 45, 60, 75, 90, 135, 180, 225, 270, 315];
  const ROT = [0, 17, 45, 73, 90];
  const SHAPES = [[30, 30, 8], [30, 30, 15], [30, 30, 0], [60, 30, 8], [60, 60, 16]];

  // ---- a POINT (a wheel hub, a ball's centre) against every box ----
  //
  // OUTSIDE only, which is the documented contract: the core distance clamps
  // to 0 once the cores interpenetrate, so the gap saturates at −(rA + rB)
  // rather than continuing negative. Every rule asks "is the gap below my
  // tolerance", which stays right at any depth — and the sign is gated
  // separately below so the saturation is pinned rather than merely avoided.
  let worst = 0, at = null, insideBad = 0, n = 0;
  for (const [w, h, cr] of SHAPES) {
    for (const rot of ROT) {
      const box = { x: 0, y: 0, w, h, radius: cr, angle: rot * D2R };
      const P = drawn(box);
      for (const deg of ANG) {
        for (const d of [10, 14, 18, 22, 26, 34, 50]) {
          const px = Math.cos(deg * D2R) * d, py = Math.sin(deg * D2R) * d;
          const ref = gapToDrawn(px, py, P);
          const got = coreGap(corePoint(px, py, 0), coreBox(box));
          if (ref <= 0) { if (got > 0) insideBad++; continue; }
          n++;
          const err = got - ref;
          if (Math.abs(err) > Math.abs(worst)) { worst = err; at = `${w}x${h} cr${cr} rot${rot} ${deg}° d${d}`; }
        }
      }
    }
  }
  gate('9. coreGap measures the round-rect the renderer strokes',
    Math.abs(worst) <= 0.01, `worst ${worst.toExponential(2)} px over ${n} poses${at ? ', at ' + at : ''}`);
  gate('9. …and a point INSIDE the shape never reads as clear',
    insideBad === 0, `${insideBad} sign errors — it saturates, but the sign is load-bearing`);

  // ---- a CIRCLE and a CAPSULE, the other two cores ----
  {
    const box = { x: 0, y: 0, w: 60, h: 30, radius: 8, angle: 33 * D2R };
    const P = drawn(box);
    let wc = 0, wr = 0;
    for (const deg of ANG) {
      for (const d of [34, 40, 48, 60]) {    // clear of the box, per the contract above
        const px = Math.cos(deg * D2R) * d, py = Math.sin(deg * D2R) * d;
        const base = gapToDrawn(px, py, P);
        if (base <= 0) continue;
        // a circle of r is its centre's gap less r
        const ec = coreGap(corePoint(px, py, 12), coreBox(box)) - (base - 12);
        if (Math.abs(ec) > Math.abs(wc)) wc = ec;
        // a capsule laid AWAY from the box, so its near cap decides: the gap is
        // the nearer endpoint's less the radius
        const ux = px / d, uy = py / d;
        const far = { x: px + ux * 40, y: py + uy * 40 };
        const farGap = gapToDrawn(far.x, far.y, P);
        if (farGap <= 0) continue;
        const er = coreGap(coreSegment(px, py, far.x, far.y, 2), coreBox(box))
          - (Math.min(base, farGap) - 2);
        if (Math.abs(er) > Math.abs(wr)) wr = er;
      }
    }
    gate('9. …a wheel is a point + r', Math.abs(wc) <= 0.01, `worst ${wc.toExponential(2)} px`);
    gate('9. …and a stick is a segment + ROD_THICK/2',
      Math.abs(wr) <= 0.01, `worst ${wr.toExponential(2)} px`);
  }

  // ---- box vs box, the pairing `boxesOverlap` could never answer ----
  {
    // touching exactly: two 30×30 crates at the default radius, side by side
    const A = { x: 0, y: 0, w: 30, h: 30 }, B = { x: 30, y: 0, w: 30, h: 30 };
    gate('9. two crates set flush have a gap of zero',
      Math.abs(boxBoxDist(A, B)) < 1e-9, `${boxBoxDist(A, B).toExponential(2)} px`);
    // and corner to corner at 45°, where the rounding actually shows
    const C = { x: 0, y: 0, w: 30, h: 30 }, D = { x: 30, y: 30, w: 30, h: 30 };
    const roundReach = (15 - CR_DEFAULT) * Math.SQRT2 + CR_DEFAULT;
    const expect = Math.hypot(30, 30) - 2 * roundReach;
    gate('9. …and corner to corner they meet at the ARC, not the square corner',
      Math.abs(boxBoxDist(C, D) - expect) < 0.01,
      `${boxBoxDist(C, D).toFixed(3)} px, want ${expect.toFixed(3)} (sharp would be ${(Math.hypot(30, 30) - 2 * Math.hypot(15, 15)).toFixed(3)})`);
  }

  // ---- a painted loop is a polygon with radius 0 ----
  {
    const loop = [{ x: -50, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: -50, y: 100 }];
    gate('9. a painted outline takes the same distance',
      Math.abs(coreGap(corePoint(0, -20, 0), corePoly(loop)) - 20) < 1e-9 &&
      coreGap(corePoint(0, 50, 0), corePoly(loop)) === 0,
      'point 20 px above reads 20; a point inside reads 0');
  }

  // ---- pieceGap dispatches ball and box the same way round ----
  {
    const ball = { shape: 'ball', r: 20 }, crate = { shape: 'box', w: 40, h: 40, radius: 8 };
    const p1 = { x: 0, y: 0 }, p2 = { x: 55, y: 21 };
    gate('9. pieceGap is symmetric in its arguments',
      Math.abs(pieceGap(ball, p1, crate, p2) - pieceGap(crate, p2, ball, p1)) < 1e-12);
  }

  // ---- CAN THIS RIG FAIL? a sharp box must give a different answer ----
  {
    const round = coreGap(corePoint(30, 30, 0), coreBox({ x: 0, y: 0, w: 30, h: 30, radius: 15 }));
    const sharp = coreGap(corePoint(30, 30, 0), coreBox({ x: 0, y: 0, w: 30, h: 30, radius: 0 }));
    gate('9. a SHARP box still behaves as a square (the rig can fail)',
      Math.abs(sharp - Math.hypot(15, 15)) < 0.01,
      `sharp ${sharp.toFixed(4)}, want ${Math.hypot(15, 15).toFixed(4)}`);
    gate('9. …and rounding it to a circle moves the border by r × (√2 − 1)',
      Math.abs((round - sharp) - 15 * (Math.SQRT2 - 1)) < 0.01,
      `${(round - sharp).toFixed(3)} px, formula gives ${(15 * (Math.SQRT2 - 1)).toFixed(3)}`);
  }
}

// ---------- gate 10: the spin centre (§9.1) ----------
//
// A spin motion turns about its piece's own middle unless the author moved the
// centre (`path.pivot`), in which case the piece ORBITS it — position as well
// as angle. The default must be arithmetic-free (no pivot, no new float ops:
// levels authored before pivots existed simulate bit-identically), and the
// custom case is pure geometry a headless sim can be held to.
{
  const STEP_HZ = 60;
  const lvl = (terrain) => ({
    terrain: [{ type: 'box', x: 0, y: 2000, w: 8000, h: 60 }, ...terrain],
    props: [],
    buildZones: [{ x: -400, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 600, y: 1940, w: 120, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -600, y: 1930, r: 15 }],
    win: 'goalObj',
  });
  const poseAfter = (terrain, frames) => {
    const sim = new Simulation(lvl(terrain), { parts: [] });
    for (let i = 0; i < frames; i++) sim._fixedStep();
    const t = sim.terrain.find((x) => x.moving);
    const p = sim._pose(t.body);
    sim.destroy();
    return p;
  };
  // spinSpeed 60 → rate 60/37.5 = 1.6 rad/s; a quarter-ish turn in 60 frames
  const spin = { spin: 1, spinSpeed: 60 };

  // **Tolerances are the ENGINE's, not arithmetic's** — the first draft asked
  // for 1e-9 and failed against correct behaviour. A kinematic pose
  // round-trips through the wasm as float32: position reads back ~5e-6 off,
  // the angle (stored as a cos/sin pair) ~5e-4 — and predicting a position
  // from that read-back angle compounds to r × 5e-4 ≈ 0.04 px at r = 80. So:
  // 0.15 px where a read-back angle is in the expectation, 0.01 px where only
  // positions meet, 2e-3 rad on angles.
  const POS = 0.01, POSA = 0.15, ANG = 2e-3;

  // ONE SECOND of simulated spin, whatever the step rate — this said "60
  // frames" when a frame was 1/60 s, and the day the sim moved to FC's 30 Hz
  // it quietly became a two-second expectation wearing a one-second number.
  const home = poseAfter([{ type: 'box', x: 100, y: -200, w: 120, h: 20, path: { ...spin } }], Math.round(1 / STEP));
  gate('10. a default spin turns in place — the centre is the piece\'s own',
    Math.abs(home.x - 100) < POS && Math.abs(home.y - (-200)) < POS && Math.abs(home.angle - 1.6) < ANG,
    `at (${home.x.toFixed(6)}, ${home.y.toFixed(6)}) ∠${home.angle.toFixed(4)}`);

  // Centre moved 80 px left of the piece: the piece must ORBIT it on the
  // radius that offset implies, through exactly the spin angle.
  const pv = { x: 20, y: -200 };
  const orbit = poseAfter([{ type: 'box', x: 100, y: -200, w: 120, h: 20, path: { ...spin, pivot: pv } }], 60);
  const dA = orbit.angle;
  const want = { x: pv.x + 80 * Math.cos(dA), y: pv.y + 80 * Math.sin(dA) };
  gate('10. a moved centre makes the piece orbit it — position follows the angle',
    Math.abs(orbit.x - want.x) < POSA && Math.abs(orbit.y - want.y) < POSA,
    `at (${orbit.x.toFixed(3)}, ${orbit.y.toFixed(3)}), expected (${want.x.toFixed(3)}, ${want.y.toFixed(3)})`);
  gate('10. …on the radius the offset implies',
    Math.abs(Math.hypot(orbit.x - pv.x, orbit.y - pv.y) - 80) < POS,
    `r ${Math.hypot(orbit.x - pv.x, orbit.y - pv.y).toFixed(6)}`);

  // A pivot placed exactly ON the piece's centre is the default, said longhand.
  const same = poseAfter([{ type: 'box', x: 100, y: -200, w: 120, h: 20, path: { ...spin, pivot: { x: 100, y: -200 } } }], 60);
  gate('10. a pivot on the piece\'s own centre is the default, said longhand',
    Math.abs(same.x - home.x) < POS && Math.abs(same.y - home.y) < POS);

  // A group override turns the WHOLE group about the authored point rather
  // than the members' average, and the two members stay rigid to each other.
  const twoAbout = (pivot) => {
    const terrain = [
      { type: 'box', x: -60, y: -300, w: 80, h: 20, groupId: 'g1' },
      { type: 'box', x: 60, y: -300, w: 80, h: 20, groupId: 'g1' },
    ];
    const level = lvl(terrain);
    level.groups = { g1: { path: pivot ? { ...spin, pivot } : { ...spin } } };
    const sim = new Simulation(level, { parts: [] });
    for (let i = 0; i < 60; i++) sim._fixedStep();
    const ps = sim.terrain.filter((x) => x.moving).map((t) => sim._pose(t.body));
    sim.destroy();
    return ps;
  };
  const avg = twoAbout(null);
  gate('10. a group\'s default centre is still the members\' average',
    Math.abs(Math.hypot(avg[0].x - 0, avg[0].y - (-300)) - 60) < POS
    && Math.abs(Math.hypot(avg[1].x - 0, avg[1].y - (-300)) - 60) < POS,
    `radii ${Math.hypot(avg[0].x, avg[0].y + 300).toFixed(4)}, ${Math.hypot(avg[1].x, avg[1].y + 300).toFixed(4)}`);
  const off = twoAbout({ x: -60, y: -300 });   // on the LEFT member
  gate('10. a group pivot override turns the group about the authored point',
    Math.abs(off[0].x - (-60)) < POS && Math.abs(off[0].y - (-300)) < POS
    && Math.abs(Math.hypot(off[1].x - (-60), off[1].y - (-300)) - 120) < POS,
    `left member at (${off[0].x.toFixed(3)}, ${off[0].y.toFixed(3)}), right at r ${Math.hypot(off[1].x + 60, off[1].y + 300).toFixed(3)}`);
  gate('10. …and the members stay rigid to each other while it turns',
    Math.abs(Math.hypot(off[1].x - off[0].x, off[1].y - off[0].y) - 120) < POS);

  // Validation: the same finite-and-bounded read a waypoint gets.
  const { badPath } = await import(u('public/js/sizes.js'));
  gate('10. a well-formed pivot validates',
    badPath({ spin: 1, spinSpeed: 60, pivot: { x: 5, y: -5 } }, 'p') === null);
  gate('10. junk pivots are refused',
    !!badPath({ spin: 1, pivot: { x: NaN, y: 0 } }, 'p')
    && !!badPath({ spin: 1, pivot: [5, 5] }, 'p')
    && !!badPath({ spin: 1, pivot: { x: 1e9, y: 0 } }, 'p'),
    badPath({ spin: 1, pivot: { x: NaN, y: 0 } }, 'p'));

  // The resolver every surface shares (util.js) — the editor's handle, the
  // ghosts and the sim must all answer "about which point?" the same way.
  const { spinPivotOf } = await import(u('public/js/util.js'));
  gate('10. spinPivotOf falls back to the origin, and says which it did',
    (() => { const d = spinPivotOf({ spin: 1 }, 7, 8); return d.x === 7 && d.y === 8 && d.custom === false; })()
    && (() => { const c = spinPivotOf({ spin: 1, pivot: { x: 1, y: 2 } }, 7, 8); return c.x === 1 && c.y === 2 && c.custom === true; })());
  gate('10. …and treats a malformed pivot as absent rather than as a crash',
    spinPivotOf({ spin: 1, pivot: { x: NaN, y: 2 } }, 7, 8).custom === false
    && spinPivotOf(null, 7, 8).custom === false);
}

summary(`(containment slack: ZONE_SLACK ${SLACK} px in the editor, GOAL_SLACK ${GOAL_SLACK} px in the sim)`);
