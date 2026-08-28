// solvexml.js — solutions and levels as XML documents, spoken once.
//
// Three parties want the same sentences: the game's Save/Load dialog ("should
// also create and accept XML", 2026-08-24), anything writing a Solution.xml,
// and anything that drags an FC document in from outside. So the grammar lives
// here, importable by all of them, and none of them can drift.
//
// Two dialects, chosen by what the level is:
//   FC        an imported level speaks FC's own retrieveLevel document —
//             fcworld.js's transpiler for a solution (bit-exact on FC's C
//             loader), the source document verbatim for the level itself.
//   lifirik   a native level cannot be said in FC's grammar (surfaces, pins
//             on pieces, weighted rods…), so it gets the native <lifirikSolve> /
//             <lifirikLevel> documents: the physical level and the machine,
//             attribute for attribute.
//
// **What the lifirik LEVEL dialect does not carry** — painted outlines,
// motion paths, groups, labels, the scenery layer — is counted and returned
// as `omitted`, so a caller can say "use JSON for a perfect copy" instead of
// silently shedding features. A SOLUTION document's embedded level is context
// for a human reading the file; loading a solution reads only the machine and
// the cargo's start positions.

import { fcMachineXml } from './fcworld.js';
import { convertFcLevel } from './fcimport.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const N = (v) => String(v);
const A = (name, v) => (v == null || v === '' ? '' : ` ${name}="${esc(v)}"`);

// ---------------------------------------------------------------------------
// writers

// the machine parts, as the lifirik dialect says them (shared by both docs)
function partsXml(parts, indent) {
  const out = [];
  for (const p of parts || []) {
    if (p.t === 'wheel') {
      out.push(`${indent}<wheel kind="${esc(p.kind)}" x="${N(p.x)}" y="${N(p.y)}" r="${N(p.r)}"/>`);
    } else if (p.t === 'rod') {
      out.push(`${indent}<rod kind="${esc(p.kind)}"${p.weight ? ` weight="${N(p.weight)}"` : ''}${p.chain ? A('chain', p.chain) : ''}` +
        ` x1="${N(p.x1)}" y1="${N(p.y1)}" x2="${N(p.x2)}" y2="${N(p.y2)}"/>`);
    }
  }
  return out;
}

const surfaceAttrs = (s) => !s ? '' :
  A('f', s.friction) + A('rest', s.restitution) + A('rr', s.rollingResistance) + A('ts', s.tangentSpeed);

function shapeXml(tag, o, extra = '') {
  const ball = (o.type || o.shape) === 'ball';
  const core = ball
    ? `x="${N(o.x)}" y="${N(o.y)}" r="${N(o.r)}"`
    : `x="${N(o.x)}" y="${N(o.y)}" w="${N(o.w)}" h="${N(o.h)}"${A('angle', o.angle)}${A('radius', o.radius)}`;
  return `<${tag} shape="${ball ? 'ball' : 'box'}" ${core}${A('texture', o.texture)}${surfaceAttrs(o.surface)}${extra}>` +
    (o.pins && o.pins.length ? o.pins.map((p) => `<pin x="${N(p.x)}" y="${N(p.y)}"/>`).join('') : '') +
    `</${tag}>`;
}

// the physical level, in the lifirik dialect. Counts what it cannot say.
function levelBody(level, indent) {
  const out = [];
  let omitted = 0;
  const say = (line) => out.push(indent + line);
  for (const t of level.terrain || []) {
    if (t.type === 'paint') { omitted++; continue; }          // painted outlines are JSON's
    if (t.path) omitted++;                                    // motion paths too
    say(shapeXml('terrain', t));
  }
  for (const p of level.props || []) {
    if (p.path) omitted++;
    say(shapeXml('prop', p));
  }
  for (const z of level.buildZones || []) say(`<buildZone x="${N(z.x)}" y="${N(z.y)}" w="${N(z.w)}" h="${N(z.h)}"${A('angle', z.angle)}/>`);
  for (const z of level.goalZones || []) say(`<goalZone x="${N(z.x)}" y="${N(z.y)}" w="${N(z.w)}" h="${N(z.h)}"${A('angle', z.angle)}/>`);
  for (const g of level.goalObjs || []) {
    if (g.path) omitted++;
    say(g.shape === 'ball'
      ? `<goal shape="ball" x="${N(g.x)}" y="${N(g.y)}" r="${N(g.r)}"${A('texture', g.texture)}/>`
      : `<goal shape="box" x="${N(g.x)}" y="${N(g.y)}" w="${N(g.w)}" h="${N(g.h)}"${A('angle', g.angle)}${A('radius', g.radius)}${A('texture', g.texture)}/>`);
  }
  for (const p of level.pins || []) say(`<pin x="${N(p.x)}" y="${N(p.y)}"${A('r', p.r)}/>`);
  out.push(...partsXml(level.fixedParts, indent));            // the level's own machine parts
  omitted += (level.texts || []).length;
  omitted += Object.keys(level.groups || {}).length ? 1 : 0;
  if (level.backLevel && ((level.backLevel.terrain || []).length + (level.backLevel.props || []).length)) omitted++;
  return { out, omitted };
}

// **The credit rides every save** (2026-08-24, "Can we include credit when
// saving XML/JSON?"). The level's desc — which on an FC import IS the credit
// line (fcCredit) — goes into the document: a <credit> element in the
// lifirik dialect, and an XML comment after the declaration in the FC one,
// where the grammar is FC's and not ours to add elements to. A comment may
// not contain "--", so the sanitiser folds runs of dashes and whitespace.
const creditOf = (level, meta) => {
  const c = meta.credit ?? level.desc;
  return c ? String(c).replace(/-{2,}/g, '-').replace(/\s+/g, ' ').trim().slice(0, 300) : null;
};
const withCreditComment = (xml, credit) =>
  (credit ? xml.replace(/^(\s*<\?xml[^>]*\?>)?/, (m) => `${m || ''}<!-- ${credit} -->\n`) : xml);

// → { xml, kind: 'fc'|'lifirik', refusal?, omitted }
export function solutionToXml(level, parts, positions, meta = {}) {
  if (level.fcWorld) {
    const r = fcMachineXml(level, parts, { goalPositions: positions });
    if (r.xml) return { xml: withCreditComment(r.xml, creditOf(level, meta)), kind: 'fc', omitted: 0 };
    // an FC level whose machine FC cannot say falls through to the dialect
    // that can — with the refusal carried so the caller can surface it
    const lif = solutionToXml({ ...level, fcWorld: null }, parts, positions, meta);
    return { ...lif, refusal: r.refusal };
  }
  const out = ['<?xml version="1.0"?>', '<lifirikSolve formatVersion="1">'];
  if (meta.levelKey != null) out.push(`  <levelId>${esc(meta.levelKey)}</levelId>`);
  out.push(`  <name>${esc(meta.name || level.name || '')}</name>`);
  {
    const c = creditOf(level, meta);
    if (c) out.push(`  <credit>${esc(c)}</credit>`);
  }
  if (meta.solvedBy) out.push(`  <solvedBy>${esc(meta.solvedBy)}</solvedBy>`);
  if (meta.winTime != null) out.push(`  <winTime>${N(meta.winTime)}</winTime>`);
  out.push('  <level>');
  const body = levelBody(level, '    ');
  out.push(...body.out);
  out.push('  </level>');
  out.push('  <solution>');
  (positions || []).forEach((q, i) => {
    const g = (level.goalObjs || [])[i];
    if (q && g && (q.x !== g.x || q.y !== g.y)) out.push(`    <goalStart index="${i}" x="${N(q.x)}" y="${N(q.y)}"/>`);
  });
  out.push(...partsXml(parts, '    '));
  out.push('  </solution>');
  out.push('</lifirikSolve>');
  return { xml: out.join('\n') + '\n', kind: 'lifirik', omitted: body.omitted };
}

// → { xml, kind, omitted }. An imported level IS its source document — plus
// the credit as a comment; the lifirik dialect already carries <desc>.
export function levelToXml(level, meta = {}) {
  if (level.fcWorld && level.fcWorld.xml) {
    return { xml: withCreditComment(level.fcWorld.xml, creditOf(level, meta)), kind: 'fc', omitted: 0 };
  }
  const out = ['<?xml version="1.0"?>', '<lifirikLevel formatVersion="1">'];
  out.push(`  <name>${esc(meta.name || level.name || '')}</name>`);
  if (level.desc) out.push(`  <desc>${esc(level.desc)}</desc>`);
  if (level.hint) out.push(`  <hint>${esc(level.hint)}</hint>`);
  out.push('  <level>');
  const body = levelBody(level, '    ');
  out.push(...body.out);
  out.push('  </level>');
  out.push('</lifirikLevel>');
  return { xml: out.join('\n') + '\n', kind: 'lifirik', omitted: body.omitted };
}

// ---------------------------------------------------------------------------
// readers

export const looksLikeXml = (text) => /^\s*(<\?xml|<retrieveLevel|<lifirik)/i.test(String(text || ''));

const attrsOf = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};
const num = (v) => (v == null || v === '' ? undefined : +v);
const un = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function elementsOf(xml, names) {
  const out = [];
  const re = new RegExp(`<(${names.join('|')})\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1>)`, 'g');
  for (const m of xml.matchAll(re)) out.push({ tag: m[1], attrs: attrsOf(m[2] || ''), inner: m[3] || '' });
  return out;
}

function partsOf(xml) {
  const parts = [];
  let id = 0;
  for (const e of elementsOf(xml, ['rod', 'wheel'])) {
    const a = e.attrs;
    if (e.tag === 'wheel') {
      parts.push({ t: 'wheel', kind: a.kind || 'free', x: +a.x, y: +a.y, r: +a.r, id: 'w' + (id++) });
    } else {
      parts.push({ t: 'rod', kind: a.kind || 'wood',
        ...(a.weight ? { weight: +a.weight } : {}), ...(a.chain ? { chain: un(a.chain) } : {}),
        x1: +a.x1, y1: +a.y1, x2: +a.x2, y2: +a.y2, id: 'r' + (id++) });
    }
  }
  return parts.filter((p) => (p.t === 'wheel' ? [p.x, p.y, p.r] : [p.x1, p.y1, p.x2, p.y2]).every(Number.isFinite));
}

const tagText = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? un(m[1].trim()) : null;
};

// a solution document → the shape _loadSolveFromFile already accepts
// ({ parts, goals?, levelId?, levelName? }), or null if it is not one.
export function parseSolveXml(text) {
  if (/<lifirikSolve\b/i.test(text)) {
    const solM = text.match(/<solution>([\s\S]*?)<\/solution>/);
    if (!solM) return null;
    const parts = partsOf(solM[1]);
    // the cargo's start positions: the level's own goals, overridden by drags
    const goals = elementsOf(text.match(/<level>([\s\S]*?)<\/level>/)?.[1] || '', ['goal'])
      .map((e) => ({ x: +e.attrs.x, y: +e.attrs.y }));
    for (const e of elementsOf(solM[1], ['goalStart'])) {
      const i = +e.attrs.index;
      if (goals[i]) goals[i] = { x: +e.attrs.x, y: +e.attrs.y };
    }
    return { parts, ...(goals.length ? { goals } : {}),
      levelId: tagText(text, 'levelId'), levelName: tagText(text, 'name') };
  }
  if (/<retrieveLevel\b/i.test(text)) {
    // FC's own document: the same converter the importer uses reads it, and
    // the machine in the build area is the solution
    const conv = convertFcLevel(text, { recentre: false });
    if (!conv || !conv.design) return null;
    return { parts: conv.design,
      goals: (conv.level.goalObjs || []).map((g) => ({ x: g.x, y: g.y })),
      levelId: tagText(text, 'levelId'), levelName: tagText(text, 'name') };
  }
  return null;
}

// a level document → the shape _loadLevelFromFile accepts, or null.
export function parseLevelXml(text) {
  if (/<retrieveLevel\b/i.test(text)) {
    const conv = convertFcLevel(text, { recentre: false });
    if (!conv || !conv.level) return null;
    const name = tagText(text, 'name');
    if (name) conv.level.name = name;
    return conv.level;
  }
  if (!/<lifirikLevel\b|<lifirikSolve\b/i.test(text)) return null;
  const lvlM = text.match(/<level>([\s\S]*?)<\/level>/);
  if (!lvlM) return null;
  const body = lvlM[1];
  const shape = (e) => {
    const a = e.attrs;
    const base = a.shape === 'ball'
      ? { type: 'ball', x: +a.x, y: +a.y, r: +a.r }
      : { type: 'box', x: +a.x, y: +a.y, w: +a.w, h: +a.h,
          ...(num(a.angle) ? { angle: +a.angle } : {}), ...(a.radius != null ? { radius: +a.radius } : {}) };
    if (a.texture) base.texture = a.texture;
    if (a.f != null || a.rest != null || a.rr != null || a.ts != null) {
      base.surface = { friction: num(a.f) ?? 0.85, restitution: num(a.rest) ?? 0,
        rollingResistance: num(a.rr) ?? 0, tangentSpeed: num(a.ts) ?? 0 };
    }
    const pins = elementsOf(e.inner, ['pin']).map((p) => ({ x: +p.attrs.x, y: +p.attrs.y }));
    if (pins.length) base.pins = pins;
    return base;
  };
  const level = {
    name: tagText(text, 'name') || undefined,
    desc: tagText(text, 'desc') || undefined,
    hint: tagText(text, 'hint') || undefined,
    terrain: elementsOf(body, ['terrain']).map(shape),
    props: elementsOf(body, ['prop']).map(shape),
    buildZones: elementsOf(body, ['buildZone']).map((e) => ({ x: +e.attrs.x, y: +e.attrs.y, w: +e.attrs.w, h: +e.attrs.h, ...(num(e.attrs.angle) ? { angle: +e.attrs.angle } : {}) })),
    goalZones: elementsOf(body, ['goalZone']).map((e) => ({ x: +e.attrs.x, y: +e.attrs.y, w: +e.attrs.w, h: +e.attrs.h, ...(num(e.attrs.angle) ? { angle: +e.attrs.angle } : {}) })),
    goalObjs: elementsOf(body, ['goal']).map((e) => {
      const a = e.attrs;
      return a.shape === 'ball'
        ? { shape: 'ball', x: +a.x, y: +a.y, r: +a.r, ...(a.texture ? { texture: a.texture } : {}) }
        : { shape: 'box', x: +a.x, y: +a.y, w: +a.w, h: +a.h,
            ...(num(a.angle) ? { angle: +a.angle } : {}), ...(a.radius != null ? { radius: +a.radius } : {}),
            ...(a.texture ? { texture: a.texture } : {}) };
    }),
    // top-level pins only: a <pin> inside a piece already landed on it above.
    // `r` is a boss pin's flange (2026-08-24)
    pins: elementsOf(body.replace(/<(terrain|prop)\b[^>]*>[\s\S]*?<\/\1>/g, ''), ['pin'])
      .map((p) => ({ x: +p.attrs.x, y: +p.attrs.y, ...(num(p.attrs.r) != null && +p.attrs.r ? { r: +p.attrs.r } : {}) })),
    fixedParts: partsOf(body),
    texts: [], groups: {},
  };
  return level;
}
