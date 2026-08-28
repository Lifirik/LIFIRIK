// fcml.js — the FC20 / word-dialect dump (FCML) as a save format.
//
// Same sentences the importer already reads (`convertFcLevel` / parseFcText)
// and the one `fcXmlToPaste` writes from retrieveLevel XML: one piece per
// line, centre + size, optional `#id` and `[jointed-to…]`. FC20 loads this
// dump; LIFIRIK's Files dialog writes and AUTO-loads it next to JSON and XML.
//
// Pure: no DOM, no node built-ins. game.js is the only caller today.

import { convertFcLevel } from './fcimport.js';

const WOOD_THICK = 8, WATER_THICK = 4;

const N = (v) => {
  const n = +v;
  if (!Number.isFinite(n)) return '0';
  return String(n);
};

export function looksLikeFcml(text) {
  const t = String(text || '');
  if (/^\s*[<{]/.test(t)) return false;
  return /^\s*(?:@name|@description|;|Type#index|BuildArea|GoalArea|StaticRect|StaticCircle|DynamicRect|DynamicCircle|GoalRect|GoalCircle|Stick|Rod|CWWheel|CCWWheel|UpWheel|UnpoweredWheel|Placed)/im.test(t);
}

export function parseFcml(text) {
  try {
    const conv = convertFcLevel(text, { recentre: false });
    return { ok: true, level: conv.level, design: conv.design || [], warnings: conv.warnings || [] };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Not valid FCML.' };
  }
}

const key = (x, y) => `${(+x).toFixed(1)},${(+y).toFixed(1)}`;

function nodesOf(p) {
  if (!p) return [];
  if (p.t === 'wheel' || p.t === 'pin') return [[p.x, p.y]];
  if (p.t === 'rod') return [[p.x1, p.y1], [p.x2, p.y2]];
  if (p.shape === 'ball' || p.type === 'ball') return [[p.x, p.y]];
  return [[p.x, p.y]];
}

function line(kind, id, x, y, w, h, rot, joints) {
  const head = id != null ? `${kind}#${id}` : kind;
  let s = `${head} (${N(x)}, ${N(y)}), (${N(w)}, ${N(h)})`;
  if (rot != null && rot !== '') s += `, ${N(rot)}`;
  if (joints && joints.length) s += ` [${joints.join(', ')}]`;
  return s;
}

function pinLine(id, x, y) {
  return `PlacedPin#${id} (${N(x)}, ${N(y)})`;
}

const WHEEL_KIND = { cw: 'CWWheel', ccw: 'CCWWheel', free: 'UpWheel' };

function partLine(p, id, joints) {
  if (p.t === 'wheel') {
    const d = (p.r || 0) * 2;
    return line(WHEEL_KIND[p.kind] || 'UpWheel', id, p.x, p.y, d, d, p.angle || 0, joints);
  }
  const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
  const rot = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
  const thick = p.kind === 'wood' ? WOOD_THICK : WATER_THICK;
  const kind = p.kind === 'wood' ? 'Stick' : 'Rod';
  return line(kind, id, (p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, len, thick, rot, joints);
}

function jointsFor(p, id, earlier) {
  const out = [];
  for (const [x, y] of nodesOf(p)) {
    const k = key(x, y);
    for (const e of earlier) {
      if (e.id === id) continue;
      if (e.keys.has(k)) { out.push(e.id); break; }
    }
  }
  return [...new Set(out)];
}

// which: 'level' | 'solve' | 'both'
// → { text, omitted }
export function toFcml({ level, parts = [], goals = null, name = '', which = 'both' } = {}) {
  const L = [];
  let omitted = 0;
  const wantLevel = which === 'level' || which === 'both';
  const wantSolve = which === 'solve' || which === 'both';
  const lvl = level || {};
  const title = name || lvl.name;
  if (title && wantLevel) L.push('@name ' + String(title).replace(/\s+/g, ' ').slice(0, 60));
  if (lvl.desc && wantLevel) L.push('@description ' + String(lvl.desc).replace(/\s+/g, ' ').slice(0, 300));

  if (wantLevel) {
    for (const z of lvl.buildZones || []) L.push(line('BuildArea', null, z.x, z.y, z.w, z.h, z.angle || 0));
    for (const z of lvl.goalZones || []) L.push(line('GoalArea', null, z.x, z.y, z.w, z.h, z.angle || 0));
    for (const t of lvl.terrain || []) {
      if (t.type === 'paint' || t.line) { omitted++; continue; }
      if (t.path) omitted++;
      if (t.type === 'ball') L.push(line('StaticCircle', null, t.x, t.y, t.r * 2, t.r * 2, t.angle || 0));
      else L.push(line('StaticRect', null, t.x, t.y, t.w, t.h, t.angle || 0));
    }
    for (const p of lvl.props || []) {
      if (p.path) omitted++;
      if (p.shape === 'ball') L.push(line('DynamicCircle', null, p.x, p.y, p.r * 2, p.r * 2, p.angle || 0));
      else L.push(line('DynamicRect', null, p.x, p.y, p.w, p.h, p.angle || 0));
    }
  }

  const numbered = [];
  let nextId = 0;
  const pushNum = (obj, kind) => {
    const id = nextId++;
    numbered.push({ id, obj, kind, keys: new Set(nodesOf(obj).map(([x, y]) => key(x, y))) });
    return id;
  };

  const goalSrc = wantSolve && Array.isArray(goals) && goals.length === (lvl.goalObjs || []).length
    ? (lvl.goalObjs || []).map((g, i) => ({ ...g, x: goals[i].x, y: goals[i].y }))
    : (wantLevel ? (lvl.goalObjs || []) : []);
  for (const g of goalSrc) {
    const id = pushNum(g, 'goal');
    if (g.shape === 'ball') L.push(line('GoalCircle', id, g.x, g.y, g.r * 2, g.r * 2, 0));
    else L.push(line('GoalRect', id, g.x, g.y, g.w, g.h, g.angle || 0));
  }

  if (wantLevel) {
    for (const p of lvl.pins || []) {
      const id = pushNum(p, 'pin');
      L.push(pinLine(id, p.x, p.y));
    }
  }

  const machine = [];
  if (wantLevel) for (const p of lvl.fixedParts || []) machine.push(p);
  if (wantSolve) for (const p of parts) machine.push(p);
  for (const p of machine) {
    if (p.t !== 'wheel' && p.t !== 'rod') { omitted++; continue; }
    if (p.t === 'rod' && p.chain) omitted++;
    const id = pushNum(p, 'part');
    const js = jointsFor(p, id, numbered);
    L.push(partLine(p, id, js));
  }

  omitted += (lvl.texts || []).length;
  if (lvl.groups && Object.keys(lvl.groups).length) omitted++;
  if (lvl.backLevel) omitted++;

  return { text: L.join('\n') + (L.length ? '\n' : ''), omitted };
}
