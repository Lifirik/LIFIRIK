// textmodel.js — what a text label IS (§10.6).
//
// Pure: no DOM, no node built-ins, no canvas. The editor (game.js), the renderer
// (render.js) and the level validator (server.js) must agree on exactly one
// schema, so it lives on its own rather than in any of them — the same reasoning
// that put the texture list in surfaces.js and the size floors in sizes.js. The
// validator itself is here too, so "is this label legal" has ONE answer that the
// server and the editor's own publish check both read.
//
// A label is decoration with no body: the sim is never told about `level.texts`
// at all. That is why it is a separate list rather than a flag on a piece — the
// same argument §10.5 makes for the scenery layer, and the same one that keeps a
// filter one bug away from a decoration that collides.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
// **Every stack is one a reader ALREADY HAS.** Nothing is fetched: a webfont is
// a request that can fail, and a sign that reflows on somebody else's machine is
// a composition the author never saw. So each entry names faces that ship with
// Windows and macOS, in that order, and ends in a generic family — worst case a
// label falls back one step within its own genre rather than to something
// unrecognisable.
//
// Keys, not stacks, are what a level stores: the table can be retuned for every
// existing level at once, and `validateLevelData` can refuse a key it doesn't
// know instead of accepting a CSS value out of a request body.
import { COORD_MAX } from './sizes.js';   // the wire bound every position shares (§14)

export const TEXT_FONTS = {
  ui:        { label: 'Sans',        stack: `system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` },
  helvetica: { label: 'Helvetica',   stack: `Helvetica, Arial, 'Liberation Sans', sans-serif` },
  verdana:   { label: 'Verdana',     stack: `Verdana, Geneva, 'DejaVu Sans', sans-serif` },
  tahoma:    { label: 'Tahoma',      stack: `Tahoma, 'Segoe UI', Geneva, sans-serif` },
  round:     { label: 'Trebuchet',   stack: `'Trebuchet MS', 'Segoe UI', Verdana, sans-serif` },
  narrow:    { label: 'Narrow',      stack: `'Arial Narrow', 'Helvetica Neue Condensed', 'Liberation Sans Narrow', sans-serif` },
  black:     { label: 'Heavy',       stack: `'Arial Black', 'Helvetica Neue', Impact, sans-serif` },
  display:   { label: 'Impact',      stack: `Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Black', sans-serif` },
  serif:     { label: 'Georgia',     stack: `Georgia, 'Times New Roman', Times, serif` },
  times:     { label: 'Times',       stack: `'Times New Roman', Times, 'Liberation Serif', serif` },
  palatino:  { label: 'Palatino',    stack: `'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif` },
  garamond:  { label: 'Garamond',    stack: `Garamond, 'Apple Garamond', 'Times New Roman', serif` },
  mono:      { label: 'Mono',        stack: `ui-monospace, Consolas, 'SF Mono', Menlo, monospace` },
  courier:   { label: 'Typewriter',  stack: `'Courier New', Courier, 'Liberation Mono', monospace` },
  comic:     { label: 'Comic',       stack: `'Comic Sans MS', 'Comic Neue', 'Segoe Print', cursive` },
  script:    { label: 'Script',      stack: `'Brush Script MT', 'Segoe Script', 'Bradley Hand', cursive` },
  papyrus:   { label: 'Papyrus',     stack: `Papyrus, 'Segoe Print', fantasy` },
};
export const TEXT_FONT_KEYS = Object.keys(TEXT_FONTS);
export const TEXT_FONT_DEFAULT = 'ui';

// ---------------------------------------------------------------------------
// Colour: a standard list, or any hex the picker produces
// ---------------------------------------------------------------------------
// The list is the game's own ink and accents plus enough neutrals to sit on any
// backdrop, and it is what a swatch click stores — a KEY, so the palette stays
// retunable. The picker stores a plain `#rrggbb` instead, which is the price of
// letting an author match a colour exactly; the pattern is checked strictly so
// what reaches a canvas `fillStyle` is six hex digits and nothing else.
export const TEXT_COLOURS = {
  ink:    '#232a35',
  white:  '#ffffff',
  accent: '#6558e6',
  goal:   '#1ae680',
  gold:   '#d4a017',
  red:    '#e05555',
  orange: '#ffa62b',
  green:  '#4b9e4b',
  blue:   '#2f7fd6',
  cyan:   '#48c6ef',
  brown:  '#7d5a38',
  slate:  '#66738a',
  black:  '#000000',
};
export const TEXT_COLOUR_KEYS = Object.keys(TEXT_COLOURS);
export const TEXT_COLOUR_DEFAULT = 'ink';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHexColour = (v) => typeof v === 'string' && HEX_RE.test(v);
export const isColourValue = (v) => isHexColour(v) || Object.hasOwn(TEXT_COLOURS, v);

// What actually goes into `fillStyle`. Unknown values fall back rather than
// throwing: a level with a colour this build doesn't know still draws.
export function textColourHex(t) {
  const v = t?.colour;
  if (isHexColour(v)) return v.toLowerCase();
  return TEXT_COLOURS[v] || TEXT_COLOURS[TEXT_COLOUR_DEFAULT];
}

// ---------------------------------------------------------------------------
// Size, and the rest
// ---------------------------------------------------------------------------
// Sizes come off the 30 px ladder (§4) so a label lines up with the world it
// labels: 15 is half a standard wheel, 30 is one, 120 is four. The ladder is
// what the scroll wheel steps through; the corner handles are free-size between
// the floor and the ceiling, because a heading is whatever size looks right.
export const TEXT_SIZES = [10, 15, 20, 30, 45, 60, 90, 120, 180];
export const TEXT_SIZE_DEFAULT = 30;
export const TEXT_SIZE_MIN = 6, TEXT_SIZE_MAX = 400;
export const TEXT_MAX_CHARS = 240;      // per label, newlines included
export const TEXT_MAX_LINES = 12;
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const TEXT_LINE_H = 1.2;         // × size, the gap between baselines

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------
// A label has a Z like everything else does — but a level's stack is not one
// list, it is a fixed sequence of passes (scenery, zones, terrain, props,
// machine, goal pieces). So a label's depth is WHICH PASS it draws with, and
// there are exactly three places it can usefully be:
//
//   behind  under the terrain — a sign painted on the back wall of a cave,
//           something the world itself covers up
//   over    THE DEFAULT: on top of the terrain it labels, under everything that
//           moves. Nothing an author writes can hide the machine or the green
//           thing, which is the property worth keeping by default
//   front   over the whole world — a title card, a watermark, a warning that
//           must not be occluded by the machine driving past it
//
// Stored absent at 'over', the same trick `surface` and `density` use, so the
// common case costs nothing in the payload.
export const TEXT_ZS = ['behind', 'over', 'front'];
export const TEXT_Z_DEFAULT = 'over';
export const textZOf = (t) => (TEXT_ZS.includes(t?.z) ? t.z : TEXT_Z_DEFAULT);
export const TEXT_Z_LABEL = {
  behind: 'behind the terrain',
  over: 'over the terrain (default)',
  front: 'in front of everything',
};

export const textFontKey = (t) => (TEXT_FONTS[t?.font] ? t.font : TEXT_FONT_DEFAULT);
export const textFontStack = (t) => TEXT_FONTS[textFontKey(t)].stack;
export const textSizeOf = (t) => clamp(Number(t?.size) || TEXT_SIZE_DEFAULT, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
export const textAlignOf = (t) => (TEXT_ALIGNS.includes(t?.align) ? t.align : 'center');

// The lines, capped. Sliced here rather than at every caller so the measurer,
// the drawer and the editor's hit box can never disagree about how many there
// are — and so the cap the editor applies while typing is the same number the
// renderer would have enforced silently.
export function textLines(t) {
  return String(t?.text ?? '').split('\n').slice(0, TEXT_MAX_LINES);
}

// The CSS font shorthand a label resolves to. `size` is in WORLD px and the
// canvas is already under the camera transform when text is drawn, so no zoom
// arithmetic appears anywhere: a 30 px label is 30 px of world, always.
export function textFontSpec(t, size = textSizeOf(t)) {
  const weight = t?.bold ? '700' : '400';
  const style = t?.italic ? 'italic ' : '';
  return `${style}${weight} ${size}px ${textFontStack(t)}`;
}

// ---------------------------------------------------------------------------
// Colour conversions for the picker
// ---------------------------------------------------------------------------
// Here rather than in the editor because they are pure arithmetic with exact
// round-trip properties worth gating, and because the picker, the hex field and
// the RGB boxes are three views of ONE value — three conversions written in
// three places is how they start disagreeing at the edges (0, 255, grey, and
// the hue seam at 360°).
export function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// h 0..360, s/v 0..1
export function rgbToHsv(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  const H = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = v - c;
  const i = Math.floor(H / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][i];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// Perceived brightness, 0..1 — used to pick a halo that contrasts with the ink
// rather than a fixed one. An "outline" that vanished into its own fill would be
// a control that does nothing on half the palette, and with a colour PICKER
// there is no palette to special-case.
export function colourLuma(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
export const haloFor = (hex) => (colourLuma(hex) > 0.62 ? '#232a35' : '#ffffff');

// ---------------------------------------------------------------------------
// Validation — one function, three callers
// ---------------------------------------------------------------------------
// Nothing here can NaN a Box2D shape, because no label ever reaches the solver.
// Every field does reach the RENDERER though, and the reasons are the
// renderer's own: `size` is multiplied into line heights and stroke widths (NaN
// is a label that vanishes, 1e9 is a level nobody can open); `font` and
// `colour` are handed to a canvas; and `text` is walked line by line, so both
// its length and its line count are what the drawer actually iterates.
//
// The editor clamps all of this at the one door text comes in through. This is
// for the doors that bypass the editor — POST/PUT /api/levels, Files → load
// from file, the importer — where a level that renders differently from how it
// was authored is worse than one that says why it won't save.
export function badTextPiece(o, i, where = 'label') {
  const at = `${where} ${i + 1}`;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!o || typeof o !== 'object' || Array.isArray(o)) return `${at} is not a label`;
  if (typeof o.text !== 'string') return `${at}: text must be a string`;
  if (o.text.length > TEXT_MAX_CHARS) return `${at}: too long (max ${TEXT_MAX_CHARS} characters)`;
  if (o.text.split('\n').length > TEXT_MAX_LINES) return `${at}: too many lines (max ${TEXT_MAX_LINES})`;
  if (!num(o.x) || !num(o.y)) return `${at}: x and y must be numbers`;
  // Finite is not the same as sane (sizes.js §14): a label at 1e300 turns the
  // canvas transform non-finite, which setTransform IGNORES — so the label
  // draws wherever the PREVIOUS transform pointed, not offscreen.
  if (Math.abs(o.x) > COORD_MAX || Math.abs(o.y) > COORD_MAX) {
    return `${at}: x and y must be within ±${COORD_MAX}`;
  }
  if (o.size != null) {
    if (!num(o.size)) return `${at}: size must be a number`;
    if (o.size < TEXT_SIZE_MIN || o.size > TEXT_SIZE_MAX) {
      return `${at}: size must be between ${TEXT_SIZE_MIN} and ${TEXT_SIZE_MAX} px (got ${o.size})`;
    }
  }
  if (o.angle != null && !num(o.angle)) return `${at}: angle must be a number`;
  if (o.font != null && !Object.hasOwn(TEXT_FONTS, o.font)) {
    return `${at}: unknown font '${String(o.font).slice(0, 20)}'`;
  }
  // a name from the list, or six hex digits — and nothing else reaches a canvas
  if (o.colour != null && !isColourValue(o.colour)) {
    return `${at}: colour must be a name from the palette or a #rrggbb value (got '${String(o.colour).slice(0, 20)}')`;
  }
  if (o.align != null && !TEXT_ALIGNS.includes(o.align)) {
    return `${at}: align must be left, center or right`;
  }
  if (o.z != null && !TEXT_ZS.includes(o.z)) {
    return `${at}: z must be ${TEXT_ZS.join(', ')}`;
  }
  return null;
}
