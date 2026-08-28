// verify-gfx.mjs — the graphics styles (gfx.js).
// Run: node scripts/verify-gfx.mjs
//
// What is gate-reachable here is the data and the settings rules: the style
// table's shape, the read-and-repair, and the invariants the draw loop leans
// on (Normal costs nothing; every other style declares something visible).
// The composite itself needs a canvas and is verified in the browser — the
// settings screen's preview cards run the identical applyGfx path, which is
// what caught the feDisplacementMap `in` default bug before anything shipped.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { GFX_STYLES, GFX_KEYS, GFX_DEFAULT, gfxIsPost, repairGfx, gfxSettings } =
  await import(u('public/js/gfx.js'));

const { gate, section, summary } = gates();

// ---------- 1. the table ----------
// Four looks (2026-08-08): seven were tried across the day —
// Crayon/Photorealistic/Cartoon cut in the first audition, Felt in the second;
// Neon and X-Ray arrived by request.
gate('1. four styles, Normal first',
  GFX_KEYS.length === 4 && GFX_KEYS[0] === 'normal', GFX_KEYS.join(', '));
gate('1. every key resolves to a style whose id matches it',
  GFX_KEYS.every((k) => GFX_STYLES[k]?.id === k));
gate('1. every style has a name and a hint for the settings card',
  GFX_KEYS.every((k) => GFX_STYLES[k].name && GFX_STYLES[k].hint));
gate('1. no style in the table is missing from the key list',
  Object.keys(GFX_STYLES).every((k) => GFX_KEYS.includes(k)));

// ---------- 2. Normal is inert ----------
// The draw loop asks gfxIsPost every frame to skip the offscreen hop — Normal
// must answer no, or every player pays for a feature they never turned on.
gate('2. Normal is not a post style — it costs literally nothing',
  gfxIsPost(GFX_STYLES.normal) === false);
// A style earns its card by doing SOMETHING — a composite pass, or X-Ray's
// worldAlpha, which the draw loop consumes at paint time because a composite
// cannot un-occlude a stick a wheel has already painted over.
gate('2. every OTHER style does something — a style that does nothing is a lie in a menu',
  GFX_KEYS.slice(1).every((k) => gfxIsPost(GFX_STYLES[k]) || GFX_STYLES[k].worldAlpha),
  GFX_KEYS.slice(1).join(', '));
// …and X-Ray is deliberately NOT post: no offscreen hop, no filter — it rides
// the Normal path with one option added to the piece painters, so it is the
// cheapest look in the table at exactly Normal's cost.
gate('2. X-Ray skips the offscreen hop on purpose',
  gfxIsPost(GFX_STYLES.xray) === false && GFX_STYLES.xray.worldAlpha > 0);

// ---------- 3. the knobs stay sane ----------
// Bounds that keep a style a STYLE: a grain that fully hides the game or a
// displacement that tears it apart is a bug wearing a parameter's clothes.
for (const k of GFX_KEYS) {
  const s = GFX_STYLES[k];
  if (s.grain) {
    gate(`3. ${k}'s grain is translucent (≤0.6) with a real composite op`,
      s.grain.alpha > 0 && s.grain.alpha <= 0.6 && typeof s.grain.op === 'string',
      `${s.grain.kind} @ ${s.grain.alpha}`);
  }
  if (s.svg) {
    const chain = s.svg.join('');
    const scale = chain.match(/feDisplacementMap[^>]*scale="([\d.]+)"/);
    if (scale) {
      gate(`3. ${k}'s displacement stays legible (scale ≤ 12)`,
        parseFloat(scale[1]) <= 12, scale[1]);
    }
    // The bug the previews caught, pinned so it cannot come back: a filter
    // primitive's default `in` is the PREVIOUS primitive's output, so a
    // displacement map that follows its own turbulence displaces noise by
    // noise and the world never reaches the screen.
    if (chain.includes('feDisplacementMap')) {
      gate(`3. ${k}'s displacement names its \`in\` explicitly`,
        /feDisplacementMap[^>]*\bin="/.test(chain));
    }
  }
  if (s.worldAlpha) {
    // translucent enough to see through, opaque enough that the machine is
    // still the thing you are looking at
    gate(`3. ${k}'s translucency stays legible (0.4 ≤ alpha ≤ 0.85)`,
      s.worldAlpha >= 0.4 && s.worldAlpha <= 0.85, String(s.worldAlpha));
  }
  if (s.dim) {
    gate(`3. ${k}'s dim leaves the sky visible (0 < dim < 1)`,
      s.dim > 0 && s.dim < 1, String(s.dim));
  }
  if (s.glow) {
    // The pulse is a sine on `base` with swing `amp`: it must stay a real
    // alpha at BOTH extremes — a glow that clips at 1 flashes flat, and one
    // that touches 0 reads as the sign shorting out.
    gate(`3. ${k}'s glow breathes inside (0, 1] and never goes out`,
      s.glow.base - (s.glow.amp || 0) > 0 && s.glow.base + (s.glow.amp || 0) <= 1,
      `${s.glow.base}±${s.glow.amp}`);
    gate(`3. ${k}'s pulse hums rather than strobes (≤ 2 Hz)`,
      (s.glow.hz || 0) <= 2, `${s.glow.hz} Hz`);
    gate(`3. ${k}'s halo is a real blur`,
      s.glow.blur > 0, `${s.glow.blur}px`);
  }
}
// Poster took the slot with a colour LUT, not a wobble — turbulence was
// the 29 fps 4K bill; a discrete transfer is a table lookup.
gate('3. Poster posterizes with a LUT, not a wobble, and has no half-res buffer',
  /feComponentTransfer/.test(GFX_STYLES.poster.svg.join(''))
  && !/feTurbulence/.test(GFX_STYLES.poster.svg.join(''))
  && !GFX_STYLES.poster.res);

// ---------- 4. settings read-and-repair ----------
gate('4. the default style is Normal', GFX_DEFAULT === 'normal');
gate('4. a fresh device reads Normal (no stored value → default)',
  gfxSettings().style === 'normal', gfxSettings().style);
gate('4. a stored style survives the round trip',
  repairGfx({ style: 'neon' }).style === 'neon' && repairGfx({ style: 'poster' }).style === 'poster');
gate('4. stored Painted and Print picks migrate to Poster',
  repairGfx({ style: 'painted' }).style === 'poster'
  && repairGfx({ style: 'print' }).style === 'poster');
gate('4. junk out of localStorage falls back rather than reaching the renderer',
  repairGfx({ style: 'vaporwave' }).style === 'normal'
  && repairGfx({}).style === 'normal'
  && repairGfx(null).style === 'normal'
  && repairGfx({ style: 42 }).style === 'normal');
// A device that stored a CUT style is a certainty, not a hypothetical: all
// four shipped for at least part of a day. They repair to Normal like any
// other unknown — quietly, with no error and no dead screen.
gate('4. the cut styles (crayon, photo, cartoon, felt) repair to Normal',
  ['crayon', 'photo', 'cartoon', 'felt'].every((k) => repairGfx({ style: k }).style === 'normal'));

// ---------- 5. the badge draws the GAME'S wheel ----------
//
// The No Wheels badge used to carry a hand copy of the wheel, and a hand copy
// goes stale silently: the piece grew a race, detents, drive arrows and FC's
// pin lattice while the badge still showed the flat July disc. render.js now
// publishes its own drawing into util.js (`setBadgeArt`) and the badge asks
// for it — so what is gated here is that the wiring is live and that the two
// drawings are the SAME STRING, which is the only version of this claim that
// cannot drift.
{
  const util = await import(u('public/js/util.js'));
  const render = await import(u('public/js/render.js'));   // registers as it loads
  const svg = util.badgeDef('rods').svg;
  gate("5. the No Wheels badge is the renderer's own wheel, not a copy of it",
    svg === render.wheelBadgeSVG('free', 15) && svg === util.badgeArt('freeWheel'),
    `${svg.length} chars, registered ${!!util.badgeArt('freeWheel')}`);
  // What a 15 px wheel actually gets: the race and the letter knocked out of
  // it, and NOT the detents or the drive arrows — both fall under MARK_MIN_PX
  // at this size and are dropped, exactly as they are on a small wheel on the
  // canvas. That is the culling ladder doing its job, not a missing feature,
  // so it is gated from both ends.
  gate('5. ...and at badge size it is the race and the letter, no mush',
    /<mask id=/.test(svg) && /stroke-width="2.4"/.test(svg)
    && !/ A /.test(svg) && !/<line /.test(svg),
    'race + letter at 15 px; detents and arrows culled');
  {
    const big = render.wheelBadgeSVG('free', 48);
    gate('5. ...while the same drawing asked for larger grows its detents and arrows back',
      (big.match(/ A /g) || []).length === 2 && (big.match(/<line /g) || []).length === 8,
      `48 px: ${(big.match(/<line /g) || []).length} detents, ${(big.match(/ A /g) || []).length} arcs`);
  }
  // …and it is a WHEEL, not the tyre emoji, on the one badge where the drawing
  // IS the meaning (the emoji stays as the no-renderer fallback).
  gate('5. the drawn subject is a wheel, and the emoji is only the fallback',
    svg.startsWith('<svg') && util.badgeDef('rods').emoji === '\u{1F6DE}',
    'svg drawn, emoji held in reserve');
  gate('5. it is drawn at the size the badge is (15 px), and scales by CSS from there',
    /width="15" height="15"/.test(svg));
}

summary();
