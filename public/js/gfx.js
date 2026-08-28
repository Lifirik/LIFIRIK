// gfx.js — the graphics styles (§10.9). FOUR LOOKS, ONE PIPELINE.
//
// A "style" here is not a second renderer. The scene is drawn exactly once, by
// the same painters it always was, onto an offscreen canvas — and the style is
// what happens on the way to the screen: a filter chain (edge wobble,
// softness, colour), a grain overlay in the material of the medium (canvas
// weave), and for Neon a dark wash under the world and a glow pass over it.
// X-Ray is the exception that proves the shape — its translucency happens at
// paint time (see the style), because a composite cannot un-occlude a stick a
// wheel has already painted over. Looks priced as parameter sets over one
// pipeline, instead of one rewrite of every painter in render.js per look.
//
// The shipped set survived an audition (2026-08-08): seven were tried across
// the day and four were cut — Crayon, Photorealistic, Cartoon, then Felt.
// Grep this file's history for the cut ones' parameter sets; the KNOBS they
// used (silhouette shadow, vignette, banding, paper/noise/felt grain) went
// with them, deleted rather than guarded, so what remains is exactly what the
// remaining looks pay for.
//
// **Presentation only, by construction.** Nothing in here can reach the sim —
// the pipeline's input is finished pixels — so determinism (§5.8) is untouched
// and a recorded solve replays identically in every style. Thumbnails, share
// cards and tutorial demos deliberately stay Normal: they are the game's shared
// artifacts, drawn once for everybody, and a crayon share card would be YOUR
// look stamped onto THEIR feed. Clips are the exception, on purpose: the
// recorder captures the visible canvas, so a clip shows the game as you saw it.
//
// Like sound (§12), the style is a property of the device, not the account:
// localStorage, works signed out, read-and-repair on the way in.
import { store } from './util.js';

// ---------------------------------------------------------------------------
// The styles
// ---------------------------------------------------------------------------
// Knobs, and what they cost:
//   filter    — ctx.filter chain for the world blit. `svg` styles reference a
//               filter def injected by ensureGfxDefs(); plain CSS functions
//               otherwise. Applied to the WORLD only — the sky is drawn
//               straight to the screen, so a wobble never bends the horizon.
//   grain     — full-screen overlay tile: which material, how it composites,
//               how strongly. Covers sky and world alike, which is what ties
//               a filtered world back onto its unfiltered sky.
//   dim       — a dark wash over what is already on the screen (the sky),
//               drawn before the world goes on. Neon needs a dark room, and
//               this is the room: the level's own backdrop, dimmed, rather
//               than a different backdrop nobody authored.
//   glow      — one extra blit: the world through blur+saturate, composited
//               `lighter` over the dim and under the crisp world, so every
//               bright edge wears a halo. `base`/`amp`/`hz` make the halo
//               BREATHE on the clock applyGfx already gets — the pulse is a
//               globalAlpha, so it costs nothing per frame beyond the blit
//               the glow already was.
//   res       — the offscreen WORLD buffer's scale, in device px, 0 < res ≤ 1
//               (2026-08-18, "Painted, X-Ray and Neon are now really slow").
//               MEASURED, not guessed: on an 8.3 Mpx canvas (a full-screen
//               4K-class window at DPR 2) the old Painted SVG chain — blur,
//               turbulence, displacement, largely software-rasterized in
//               Chrome — fell to 29 fps with 90 ms hitches while Normal held
//               60; at 1.8 Mpx every style held 60. Filter cost is per
//               PIXEL. Painted was a 9 px wobble that ate the frame; Print
//               was a mild grade nobody could see. Poster took the slot:
//               a 4-band colour LUT (feComponentTransfer, not turbulence)
//               so the machine reads as silkscreen flats. No half-res
//               buffer — a LUT is cheap at full size. Neon's glow blur is
//               the remaining soft pass and still takes 0.5. Everything
//               else stays at 1 — Normal has no buffer at all, and X-Ray
//               is Normal with alpha.
//
// Displacement scales and turbulence frequencies below are in DEVICE px, so a
// hi-dpi screen wobbles half as far in CSS px — acceptable, where doubling the
// cost to normalise it is not.
export const GFX_STYLES = {
  normal: {
    id: 'normal', name: 'Normal', hint: 'the game as drawn — no processing at all',
  },
  poster: {
    id: 'poster', name: 'Poster', hint: 'silkscreen — four inks, hard flats, the machine as a print',
    // Four discrete bands per channel, then a saturate. That is a LUT, not
    // a blur: every pixel snaps to a flat, edges stay sharp, wood/water/LFR
    // keep their hues. feComponentTransfer is cheap next to the turbulence
    // Painted used; no half-res buffer, one blit.
    //
    // **Every `in` is explicit.** A primitive's default input is the previous
    // primitive's output, which is what we want here — but the first draft
    // of these chains shipped a displacement that forgot `in` and showed
    // rainbow noise. Named anyway, so a later primitive cannot make that
    // mistake by sitting next to this one.
    svg: [
      '<feComponentTransfer in="SourceGraphic" result="bands">'
        + '<feFuncR type="discrete" tableValues="0 0.32 0.68 1"/>'
        + '<feFuncG type="discrete" tableValues="0 0.32 0.68 1"/>'
        + '<feFuncB type="discrete" tableValues="0 0.32 0.68 1"/>'
        + '</feComponentTransfer>',
      '<feColorMatrix in="bands" type="saturate" values="1.65"/>',
    ],
  },
  xray: {
    id: 'xray', name: 'X-Ray', hint: 'every piece a little translucent — see the sticks behind the wheels',
    // **The one look the composite CANNOT do.** By the time applyGfx sees
    // pixels, the wheel has already painted over the stick — occlusion is
    // baked. So this style has no post knobs at all: `worldAlpha` is consumed
    // by the draw loop itself, passed as `opts.alpha` into the piece painters
    // (drawProp/drawRods/drawWheel/drawGoalPiece), which have carried that
    // option since the ghost drags — each piece blends with whatever is
    // already under it, which is precisely "see the sticks behind wheels".
    // Terrain, texts and zones stay opaque: they are the room, not the
    // machine, and a see-through floor answers a question nobody asked.
    //
    // gfxIsPost is FALSE for this style, deliberately: no offscreen hop, no
    // composite, no filter — the cheapest look in the table, at exactly the
    // cost of Normal.
    worldAlpha: 0.62,
  },
  neon: {
    id: 'neon', name: 'Neon', hint: 'glowing tubes in a dark room — the glow breathes',
    // The world itself, brighter and hotter — the glow pass supplies the
    // halo, this keeps the tube's own core crisp.
    filter: 'saturate(1.6) brightness(1.1) contrast(1.08)',
    // the dark room: the level's OWN sky, dimmed — not a different backdrop
    dim: 0.78,
    // The halo: blur wide enough to read as light rather than as fuzz, hue
    // driven hot by the saturate. `hz` is a slow breath (~1.8 s a cycle) —
    // neon hums, it does not strobe — and `amp` swings the halo between
    // "lit" and "blazing" without ever turning it off. At t=0 (the settings
    // preview) the pulse sits at `base`: the card shows the resting look.
    glow: { blur: 7, filter: 'saturate(2.4) brightness(1.5)', base: 0.6, amp: 0.25, hz: 0.55 },
    // 0.5: at 0.75 the glow's two blits still hitched 50 ms on an 8 Mpx
    // canvas, and a 7 px halo hides a 2× upscale
    res: 0.5,
  },
};
// The world buffer's scale for a style — 1 for anything that does not say.
export const gfxRes = (s) => (s.res > 0 && s.res <= 1 ? s.res : 1);

// Normal first — it is the default and the door back.
export const GFX_KEYS = ['normal', 'poster', 'xray', 'neon'];
export const GFX_DEFAULT = 'normal';

// Does this style do anything on the way to the screen? Asked every frame by
// the draw loop to decide whether the offscreen hop happens at all — Normal
// must cost literally nothing.
export const gfxIsPost = (s) => !!(s.svg || s.filter || s.grain || s.dim || s.glow);

// ---------------------------------------------------------------------------
// Settings — read-and-repair, exactly like sound's (audio.js)
// ---------------------------------------------------------------------------
export function repairGfx(raw) {
  let style = raw?.style;
  // Painted was the watercolour wobble; Print was a mild grade that did not
  // earn a card. Poster took the slot. A stored pick still lands on a look.
  if (style === 'painted' || style === 'print') style = 'poster';
  return { style: GFX_STYLES[style] ? style : GFX_DEFAULT };
}

export function gfxSettings() {
  return repairGfx(store.get('gfx', null) || {});
}

export function setGfxSettings(patch) {
  const next = repairGfx({ ...gfxSettings(), ...patch });
  store.set('gfx', next);
  return next;
}

// The style object the draw loop reads, every frame — one property read off a
// module-level cache, not a localStorage parse per frame.
let cur = null;
export function currentGfx() {
  if (!cur) cur = GFX_STYLES[gfxSettings().style];
  return cur;
}
// setGfxSettings is the only writer, so it is the only invalidator.
const _set = setGfxSettings;
export { _set as _setGfxRaw };
export function setGfxStyle(id) {
  const next = _set({ style: id });
  cur = GFX_STYLES[next.style];
  return next;
}

// ---------------------------------------------------------------------------
// DOM half — nothing below runs under node
// ---------------------------------------------------------------------------

// ctx.filter exists everywhere the game runs except Safari, which simply has
// no canvas filters. Detected once; without it the wobble/banding chains are
// skipped and a style degrades to its grain + vignette — still a look, never
// an error.
let filterOK = null;
export function canvasFilterSupported() {
  if (filterOK != null) return filterOK;
  try {
    filterOK = typeof document.createElement('canvas').getContext('2d').filter === 'string';
  } catch { filterOK = false; }
  return filterOK;
}

// The SVG filter defs, injected once. A zero-size <svg> parked on <body>;
// ctx.filter = 'url(#gfx-f-crayon)' reads it from there.
let defsDone = false;
export function ensureGfxDefs() {
  if (defsDone || typeof document === 'undefined') return;
  defsDone = true;
  const filters = GFX_KEYS
    .map((k) => GFX_STYLES[k])
    .filter((s) => s.svg)
    // the region pads 5% each side so a displaced edge is not clipped at the
    // canvas border
    .map((s) => `<filter id="gfx-f-${s.id}" x="-5%" y="-5%" width="110%" height="110%">${s.svg.join('')}</filter>`)
    .join('');
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${filters}</svg>`;
  document.body.append(holder);
}

// ---------------------------------------------------------------------------
// Grain tiles — the material of the medium, generated once each
// ---------------------------------------------------------------------------
// 128 px tiles, procedural, seeded by nothing: grain is texture, not content,
// so two devices drawing different specks is invisible and free.
const TILE = 128;
const tiles = new Map();

function grainTile(kind) {
  if (tiles.has(kind)) return tiles.get(kind);
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const g = c.getContext('2d');
  // multiply/soft-light overlays read 50% grey as "no change" — every tile
  // starts neutral and writes its deviations
  g.fillStyle = '#8c8c8c';
  g.fillRect(0, 0, TILE, TILE);
  const px = (x, y, w, h, col, a) => {
    g.globalAlpha = a; g.fillStyle = col; g.fillRect(x, y, w, h);
  };
  if (kind === 'weave') {
    // canvas: two thread directions, a faint bump where they cross
    g.globalAlpha = 1;
    for (let y = 0; y < TILE; y += 4) {
      g.fillStyle = y % 8 ? '#969696' : '#828282';
      g.fillRect(0, y, TILE, 2);
    }
    for (let x = 0; x < TILE; x += 4) {
      g.globalAlpha = 0.35;
      g.fillStyle = x % 8 ? '#9c9c9c' : '#7e7e7e';
      g.fillRect(x, 0, 2, TILE);
    }
    for (let i = 0; i < 900; i++) {
      px(Math.random() * TILE, Math.random() * TILE, 1, 1,
        Math.random() < 0.5 ? '#787878' : '#a2a2a2', 0.35);
    }
  } else if (kind === 'paper') {
    // letterpress stock: dense fibre speckle, no thread grid. Neutral grey
    // is "no change" under multiply, so the tooth is only the deviations.
    for (let i = 0; i < 1600; i++) {
      const v = 108 + (Math.random() * 44 | 0);
      px(Math.random() * TILE, Math.random() * TILE,
        Math.random() < 0.2 ? 2 : 1, 1,
        `rgb(${v + 6},${v},${v - 4})`, 0.42);
    }
  }
  g.globalAlpha = 1;
  tiles.set(kind, c);
  return c;
}

// The scratch canvas filtered passes render into at buffer resolution — one,
// reused, resized only when the buffer's size changes.
let scratchC = null;
function scratch(w, h) {
  if (!scratchC) scratchC = document.createElement('canvas');
  if (scratchC.width !== w || scratchC.height !== h) { scratchC.width = w; scratchC.height = h; }
  return scratchC.getContext('2d');
}

// ---------------------------------------------------------------------------
// The composite — world pixels in, styled frame out
// ---------------------------------------------------------------------------
// `dst` is the visible context (sky already on it), `world` the finished
// offscreen scene on transparency. Everything here is in DEVICE px.
export function applyGfx(dst, world, style, { t = 0 } = {}) {
  // The screen's own size, not the world buffer's: a style with `res` < 1
  // hands over a SMALLER world, and every blit below stretches it back to the
  // screen — bilinear, which under a wash or a glow is invisible by design.
  const w = dst.canvas.width, h = dst.canvas.height;
  const ok = canvasFilterSupported();
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.imageSmoothingEnabled = true;
  dst.imageSmoothingQuality = 'medium';
  if (style.dim) {
    // the dark room: the level's own sky is already on `dst`, and this pulls
    // it down without replacing it — a night nobody had to author. Before the
    // glow and the world, which then read as the light sources in it.
    dst.fillStyle = `rgba(8, 6, 24, ${style.dim})`;
    dst.fillRect(0, 0, w, h);
  }
  // **Filters run at the BUFFER's resolution, never the screen's.** A
  // ctx.filter set on `dst` would rasterize the chain over every screen pixel
  // — the exact cost `res` exists to avoid — so any filtered pass renders
  // into a scratch canvas the size of the world buffer and only the finished
  // pixels are stretched to the screen. Unfiltered (or when `res` is 1 and
  // the scratch would be a copy) the world blits straight through.
  const small = world.width !== w || world.height !== h;
  const filtered = (filter) => {
    if (!small) return { img: world, filter };
    const s = scratch(world.width, world.height);
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, world.width, world.height);
    s.filter = filter;
    s.drawImage(world, 0, 0);
    s.filter = 'none';
    return { img: s.canvas, filter: 'none' };
  };
  if (style.glow && ok) {
    // the halo: the world again, blurred hot and added (`lighter`), under the
    // crisp copy that follows. The breath is a sine on the frame clock —
    // resting at `base` when t is 0, which is what the settings preview shows.
    const gl = style.glow;
    dst.save();
    dst.globalAlpha = gl.base + (gl.amp || 0) * Math.sin(2 * Math.PI * (gl.hz || 0) * t);
    dst.globalCompositeOperation = 'lighter';
    // the blur is specified in the buffer's own pixels: a 7 px halo on a
    // 0.75 buffer would read as 9 on screen, so it is scaled back
    const f = filtered(`blur(${gl.blur * (world.width / w)}px) ${gl.filter || ''}`);
    dst.filter = f.filter;
    dst.drawImage(f.img, 0, 0, w, h);
    dst.restore();
  }
  {
    const chain = ok && (style.svg || style.filter)
      ? (style.svg ? `url(#gfx-f-${style.id}) ` : '') + (style.filter || '')
      : 'none';
    const f = chain === 'none' ? { img: world, filter: 'none' } : filtered(chain);
    dst.filter = f.filter;
    dst.drawImage(f.img, 0, 0, w, h);
    dst.filter = 'none';
  }
  // **The grain is NOT painted here any more** (2026-08-18). A full-screen
  // pattern fill was one whole extra pass over every screen pixel, every
  // frame, for an overlay that never changes — and on a big canvas each pass
  // is the budget. It is a DOM layer over the canvas now (gfxGrainLayer),
  // blended by the compositor for nothing. Only the offscreen paths still
  // paint it in: the settings preview and a recorded clip capture the canvas
  // alone, and a preview without its weave would misrepresent the style.
  if (style.grain && dst.canvas.__gfxInline) paintGrain(dst, style, w, h);
  dst.restore();
}

// The grain, painted onto a canvas — the offscreen consumers' path.
export function paintGrain(dst, style, w, h) {
  const pat = dst.createPattern(grainTile(style.grain.kind), 'repeat');
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.globalAlpha = style.grain.alpha;
  dst.globalCompositeOperation = style.grain.op;
  dst.fillStyle = pat;
  dst.fillRect(0, 0, w, h);
  dst.restore();
}

// The grain as a DOM layer: a div over the game canvas, the weave tile as its
// repeating background, blended with mix-blend-mode. The tile is generated
// once (the same canvas the paint path uses) and handed over as a data URL;
// after that the compositor does all the work, whatever the canvas is doing.
// `mount(parent)` places it, `sync(style)` shows the right tile or hides it.
export function gfxGrainLayer() {
  let div = null;
  const urls = new Map();
  return {
    mount(parent) {
      if (div) return div;
      div = document.createElement('div');
      div.className = 'gfx-grain';
      div.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;background-repeat:repeat';
      parent.append(div);
      return div;
    },
    sync(style) {
      if (!div) return;
      const g = style && style.grain;
      if (!g) { div.style.display = 'none'; return; }
      if (!urls.has(g.kind)) urls.set(g.kind, grainTile(g.kind).toDataURL());
      div.style.display = '';
      div.style.backgroundImage = `url(${urls.get(g.kind)})`;
      // the tile is TILE device px; as a CSS background it must tile at the
      // same visual density the canvas fill had, i.e. TILE / dpr CSS px
      div.style.backgroundSize = `${TILE / (window.devicePixelRatio || 1)}px`;
      div.style.opacity = String(g.alpha);
      div.style.mixBlendMode = g.op === 'multiply' ? 'multiply' : g.op === 'soft-light' ? 'soft-light' : 'normal';
    },
  };
}
