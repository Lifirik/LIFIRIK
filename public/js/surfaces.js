// surfaces.js — what a terrain piece is made of, physically.
//
// Pure: no DOM, no node built-ins. The editor (game.js), the solver (sim.js)
// and the level validator (server.js) must agree on exactly one schema, so it
// lives on its own rather than in any of them — the same reasoning that put
// the size floors in sizes.js.
//
// ---------------------------------------------------------------------------
// Texture is a LOOK; surface is a BEHAVIOUR; a piece may set them separately
// ---------------------------------------------------------------------------
// Each texture names a default surface (TEXTURE_SURFACE), and a piece that
// says nothing gets it — so ice is slippery and rubber bounces without the
// author touching a slider. A piece MAY also carry an explicit `surface`,
// which wins key by key.
//
// The two are kept separable rather than welded because the moment they are
// one thing you can never have an icy-looking stone ramp, a grippy glass
// bridge, or a belt that has been switched off — and every level using a
// texture is frozen against ever retuning how that texture feels.
//
// One consequence worth stating plainly, since it is the opposite of the usual
// advice: because an untouched piece RESOLVES its numbers at simulation time
// rather than having them baked in when it was drawn, retuning a value in this
// table changes every DRAFT that uses that texture. During authoring that is
// the point — one edit here retunes everything still on the bench.
//
// **Published levels are frozen, though, and have been since 2026-08-03**: the
// server bakes surfaceOf() onto every terrain piece at the publish boundary
// (bakeSurfaces in server.js, §5.8), and a boot backfill baked everything
// stored before then at the numbers it played with that day. So a retune here
// reaches drafts and nothing else; recorded times keep re-simulating true.
// The fallback below deliberately STAYS texture-resolved rather than dropping
// to SURFACE_LEGACY — local drafts never pass through the server, and an icy
// draft that suddenly gripped like granite in Test would be a lie of its own.
export const TEXTURE_SURFACE = {
  // The six that predate this module. granite/neon/classic deliberately still
  // equal the solver's old constants, which is what keeps all 32 officials
  // bit-identical: not one of them sets a texture, and the fallback texture is
  // granite. The other three now mean what they say — ice was never meant to
  // grip at 0.85.
  granite: { friction: 0.85, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  grass: { friction: 0.90, restitution: 0, rollingResistance: 0.02, tangentSpeed: 0 },
  sand: { friction: 0.95, restitution: 0, rollingResistance: 0.08, tangentSpeed: 0 },
  ice: { friction: 0.06, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  neon: { friction: 0.85, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  classic: { friction: 0.85, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  // New with this module, so they are free to mean what they look like.
  rubber: { friction: 1.10, restitution: 0.72, rollingResistance: 0, tangentSpeed: 0 },
  steel: { friction: 0.25, restitution: 0.05, rollingResistance: 0, tangentSpeed: 0 },
  wood: { friction: 0.65, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  mud: { friction: 1.20, restitution: 0, rollingResistance: 0.22, tangentSpeed: 0 },
  snow: { friction: 0.35, restitution: 0, rollingResistance: 0.10, tangentSpeed: 0 },
  brick: { friction: 0.95, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  lava: { friction: 0.80, restitution: 0, rollingResistance: 0, tangentSpeed: 0 },
  moss: { friction: 0.50, restitution: 0, rollingResistance: 0.03, tangentSpeed: 0 },
  belt: { friction: 0.90, restitution: 0, rollingResistance: 0, tangentSpeed: 3 },
  glass: { friction: 0.12, restitution: 0.10, rollingResistance: 0, tangentSpeed: 0 },
};

// Canonical order — the editor's picker, the maker's dropdown and the texture
// swatch grid all read this, so there is one list rather than the three that
// had already drifted out of order between game.js and main.js.
export const TEXTURES = Object.keys(TEXTURE_SURFACE);

// ---------------------------------------------------------------------------
// Material classes — what a thing is made of, for anything that needs to know
// ---------------------------------------------------------------------------
// Every shape is tagged with one of these at construction, in Box2D's
// `userMaterialId` (the field exists for exactly this). A collision hands back
// two shape ids and nothing else, so the tag is the only way to answer "what
// just hit what" — see sim.js `drainHits` and audio.js.
//
// This lives here rather than in audio.js because it is a fact about the piece,
// not about sound: audio.js maps these to a TIMBRE, and the split is "what it
// IS" here, "what that sounds like" there. sim.js must not have to import an
// audio module to build a world.
//
// 0 is reserved — it is what an untagged shape reports, and consumers map it to
// STONE so a missing tag is merely wrong rather than silent.
export const MAT = {
  STONE: 1, ICE: 2, METAL: 3, WOOD: 4, SOFT: 5, RUBBER: 6, GLASS: 7,
  PROP: 8, GOAL: 9, WHEEL: 10, ROD: 11, WATER: 12,
};

const TEXTURE_MAT = {
  granite: MAT.STONE, brick: MAT.STONE, moss: MAT.STONE, lava: MAT.STONE,
  neon: MAT.STONE, classic: MAT.STONE,
  ice: MAT.ICE, glass: MAT.GLASS,
  steel: MAT.METAL, belt: MAT.METAL,
  wood: MAT.WOOD,
  sand: MAT.SOFT, snow: MAT.SOFT, mud: MAT.SOFT, grass: MAT.SOFT,
  rubber: MAT.RUBBER,
};

// Terrain is made of what its texture says it is.
export const materialForTexture = (tex) => TEXTURE_MAT[tex] || MAT.STONE;

// What the solver hardcoded for every terrain piece before surfaces existed.
// Kept as a named constant because it is the thing granite/neon/classic are
// pinned to, the value an unknown texture falls back to, and the target if
// these ever need freezing per-level (see the header).
export const SURFACE_LEGACY = Object.freeze({
  friction: 0.85, restitution: 0, rollingResistance: 0, tangentSpeed: 0,
});

// The three that ARE those constants, i.e. the "unset look" — plain ground with
// no material claim of its own. A physics profile may substitute its own
// numbers for these and must leave every other texture alone: ice is slippery
// whichever engine is being matched, but plain ground is only plain ground
// because nobody said otherwise. See `_terrainSurface` in sim.js.
export const LEGACY_TEXTURES = new Set(['granite', 'neon', 'classic']);

// The live dials. rollingResistance is still stored on textures and old
// levels (and accepted on publish so those files keep loading) but this
// engine has no such field — Drag is not a slider. Grip, Bounce and Belt
// are the ones that actually move something.
//
// `max` is a playability limit, not an engine one. Restitution stops short of
// 1 because 1 is a ball that never loses height and a level that never settles.
// tangentSpeed is metres per second, and SIGNED: positive carries things the
// way the piece's local +x points, which for an unrotated floor is rightward.
export const SURFACE_RANGE = {
  friction: { min: 0, max: 2, step: 0.01, label: 'Grip', hint: 'how hard it is to slide along' },
  restitution: { min: 0, max: 0.95, step: 0.01, label: 'Bounce', hint: 'how much speed a landing keeps' },
  tangentSpeed: { min: -8, max: 8, step: 0.1, label: 'Belt', hint: 'conveyor — carries whatever touches it' },
};

export const SURFACE_KEYS = Object.keys(SURFACE_RANGE);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && isFinite(v);

// The surface a texture hands a piece the moment it is authored.
export function textureSurface(tex) {
  return { ...(TEXTURE_SURFACE[tex] || SURFACE_LEGACY) };
}

// Resolve a terrain piece to the four numbers the solver needs: the piece's
// own `surface` key by key, then its texture's default for anything it does
// not mention. A per-key fallback rather than all-or-nothing, so a piece can
// say "ice, but switch the bounce on" without restating the other three.
//
// Values are clamped rather than trusted: this runs on level data that
// arrived over the wire, and a friction of 1e9 is a NaN pose one contact
// later. The server rejects out-of-range separately (badSurface) — this is
// the belt to that pair of braces, because sim.js must be safe on its own.
export function surfaceOf(t) {
  const s = t && t.surface;
  const def = textureSurface(t && t.texture);
  const out = {};
  for (const k of SURFACE_KEYS) {
    const r = SURFACE_RANGE[k];
    out[k] = s && isNum(s[k]) ? clamp(s[k], r.min, r.max) : def[k];
  }
  return out;
}

// True when the piece is running exactly what its texture would give it, so
// the editor can tell "author has tuned this" from "author has not touched it"
// and avoid trampling hand-set values when the texture changes.
export function surfaceIsTextureDefault(t) {
  const want = textureSurface(t && t.texture || 'granite');
  const have = surfaceOf(t);
  return SURFACE_KEYS.every(k => Math.abs(have[k] - want[k]) < 1e-9);
}

// Validation for the server. Returns an error string or null, matching the
// badPiece/badPaintPiece convention. Out-of-range is REJECTED rather than
// silently clamped: a level that plays differently from how it was authored is
// worse than a level that fails to save with a reason.
export function badSurface(o, at) {
  const s = o && o.surface;
  if (s == null) return null;
  if (typeof s !== 'object' || Array.isArray(s)) return `${at}: surface must be an object`;
  for (const k of Object.keys(s)) {
    if (k === 'rollingResistance') continue;   // leftover Drag — engine has none
    if (!SURFACE_KEYS.includes(k)) return `${at}: surface has no '${String(k).slice(0, 20)}' setting`;
    const r = SURFACE_RANGE[k];
    if (!isNum(s[k])) return `${at}: surface.${k} must be a number`;
    if (s[k] < r.min || s[k] > r.max) {
      return `${at}: surface.${k} must be between ${r.min} and ${r.max} (got ${s[k]})`;
    }
  }
  return null;
}
