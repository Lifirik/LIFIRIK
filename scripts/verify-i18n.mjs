// verify-i18n.mjs — the nine languages, held against the code that speaks them.
//
// The dictionaries are keyed by the exact English the interface says, which is
// what makes them CHECKABLE: a key that no longer appears in the source is a
// translation of a sentence the game stopped saying, and this suite is where
// that rots loudly instead of silently. The other half is shape — a translated
// sentence that loses a {slot}, breaks a [label](/route) link or unbalances a
// bold run would ship a bug only speakers of that one language ever see, which
// is exactly the bug nobody here would catch by playing.
//
// What is NOT gated: coverage. A source string missing from a dictionary
// degrades to English by design (t() passes it through), so "every sentence is
// translated" is a goal, not an invariant. The one exception is the learn
// hub's part and chapter data in content.js — those eighteen strings fell
// through the first catalogue precisely because they live in data no scan
// visited, so their presence in every dictionary is pinned by gate 6.
//
// Run: node scripts/verify-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gates } from './gatekit.mjs';
import { scanStrings } from './i18n-scan.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const i18n = await import(u('public/js/i18n.js'));
const util = await import(u('public/js/util.js'));
const { CONTENT, TOUR_PARTS, TOUR_PLAN } = await import(u('public/js/content.js'));
const { TEXTURES } = await import(u('public/js/surfaces.js'));
const { PROP_TEXTURES } = await import(u('public/js/sizes.js'));
const { BACKGROUNDS } = await import(u('public/js/render.js'));
const { LANGS, t, tf, langOf, detectLang, flagSVG } = i18n;

const { gate, section, summary } = gates();

const DIR = path.join(root, 'public', 'i18n');
const codes = LANGS.map((l) => l.code).filter((c) => c !== 'en');
const files = Object.fromEntries(codes.map((c) => {
  try { return [c, JSON.parse(fs.readFileSync(path.join(DIR, c + '.json'), 'utf8'))]; }
  catch { return [c, null]; }
}));

// {slot} names as a sorted set — the shape a translation must preserve.
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join('|');
// Collapse every {…} to {} for comparison, innermost first so nested template
// holes from the scan collapse too.
const flat = (s) => {
  let x = String(s);
  for (let prev = ''; prev !== x;) { prev = x; x = x.replace(/\{[^{}]*\}/g, '{}'); }
  return x;
};

// ---------- gate 1: the module itself, under node ----------
section('1', () => {
  gate('1. i18n.js imports headless and speaks English by default', langOf() === 'en');
  gate('1. …t() is identity with no dictionary loaded', t('Terrain') === 'Terrain');
  gate('1. …and passes non-strings through untouched', t(42) === 42 && t(null) === null);
  gate('1. tf() fills {slots} in English exactly as it would in translation',
    tf('Cut {n} pieces', { n: 3 }) === 'Cut 3 pieces');
  gate("1. …and a slot the caller didn't fill stays visible rather than vanishing",
    tf('Cut {n} pieces', {}) === 'Cut {n} pieces');
  gate('1. detectLang() with no navigator is English, not a guess', detectLang() === 'en');
  gate('1. setLang() refuses a code the picker does not offer', i18n.setLang('xx') === false);
  gate('1. util.js re-exports the same t and tf the funnels use',
    util.t === t && util.tf === tf);
  gate('1. LANGS is the nine agreed languages, endonym picker first',
    LANGS.length === 9 && LANGS[0].code === 'en' &&
    ['zh-CN', 'de', 'ru', 'es', 'fr', 'ko', 'ja', 'hi'].every((c) => codes.includes(c)),
    LANGS.map((l) => l.code).join(' '));
  gate('1. every language has a drawn flag, not an emoji',
    LANGS.every((l) => {
      const s = flagSVG(l.code);
      return s.includes('<svg') && s.includes('viewBox="0 0 60 40"') && !/\p{Regional_Indicator}/u.test(s);
    }));
});

// ---------- gate 2: the files on disk ----------
section('2', () => {
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  gate('2. every non-English language has its /i18n/<code>.json', codes.every((c) => onDisk.includes(c)),
    onDisk.join(' '));
  gate('2. …and no file exists for a language the picker does not offer',
    onDisk.every((c) => codes.includes(c)));
  for (const c of codes) {
    const d = files[c];
    gate(`2. ${c}.json parses to { ui, content } objects`,
      !!d && typeof d.ui === 'object' && !!d.ui && typeof d.content === 'object' && !!d.content);
    if (!d) continue;
    const raw = fs.readFileSync(path.join(DIR, c + '.json'));
    gate(`2. …${c} carries no CR bytes (LF-only, like the rest of public/)`, !raw.includes(13));
  }
  gate('2. build.mjs ships the i18n directory into dist',
    fs.readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8').includes(`'i18n'`));
  gate('2. main.js awaits initI18n before first paint',
    /await initI18n\(\)/.test(fs.readFileSync(path.join(root, 'public', 'js', 'main.js'), 'utf8')));
});

// ---------- gate 3: ui entries are well-formed ----------
section('3', () => {
  for (const c of codes) {
    const d = files[c]; if (!d) continue;
    const entries = Object.entries(d.ui);
    const empty = entries.filter(([k, v]) => !k || typeof v !== 'string' || !v.trim());
    gate(`3. ${c}: every ui entry is a non-empty string`, empty.length === 0,
      empty.length ? JSON.stringify(empty[0]) : entries.length + ' entries');
    const identity = entries.filter(([k, v]) => k === v);
    gate(`3. …${c} carries no identity entries — t() already says the English`,
      identity.length === 0, identity.length ? JSON.stringify(identity[0][0]) : '');
    const slotBroken = entries.filter(([k, v]) => holes(k) !== holes(v));
    gate(`3. …${c} preserves every {slot} set exactly`, slotBroken.length === 0,
      slotBroken.length ? slotBroken.slice(0, 3).map(([k]) => JSON.stringify(k)).join(', ') : '');
  }
});

// ---------- gate 5: content prose keeps its shape ----------
section('5', () => {
  const defs = new Map(CONTENT.map((e) => [e.key, e.def]));
  const hrefs = (s) => [...String(s).matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).sort().join('|');
  const tildes = (s) => (String(s).match(/(^|\n)~/g) || []).length;
  for (const c of codes) {
    const d = files[c]; if (!d) continue;
    const keys = Object.keys(d.content);
    const unknown = keys.filter((k) => !defs.has(k));
    gate(`5. ${c}: every content key is in the registry`, unknown.length === 0,
      unknown.length ? unknown.slice(0, 4).join(' ') : `${keys.length} of ${defs.size} translated`);
    const probs = [];
    for (const k of keys) {
      const def = defs.get(k), v = d.content[k];
      if (def === undefined) continue;
      if (typeof v !== 'string' || !v.trim()) { probs.push(k + ': empty'); continue; }
      if (hrefs(def) !== hrefs(v)) probs.push(k + ': links');
      if (((v.match(/\*\*/g) || []).length) % 2) probs.push(k + ': bold');
      if (tildes(def) !== tildes(v)) probs.push(k + ': ~ asides');
      if (((v.match(/\[\[/g) || []).length) !== ((v.match(/\]\]/g) || []).length)) probs.push(k + ': keycaps');
      if (holes(def) !== holes(v)) probs.push(k + ': slots');
    }
    gate(`5. …${c} keeps links, bold, keycaps, asides and slots intact`, probs.length === 0,
      probs.slice(0, 6).join('  '));
  }
});

// ---------- gate 6: the learn hub's data-borne strings stay translated ----------
section('6', () => {
  // TOUR_PARTS / TOUR_PLAN names and taglines render through t() but live in
  // content.js DATA, where no string sweep looks — the one class of string
  // that has already slipped through once. 'FC' is a name, not a sentence.
  const need = [];
  for (const p of TOUR_PARTS) { if (p.name !== 'FC') need.push(p.name); need.push(p.tagline); }
  for (const ch of TOUR_PLAN) { need.push(ch.name, ch.tagline); }
  for (const c of codes) {
    const d = files[c]; if (!d) continue;
    const missing = need.filter((s) => !(s in d.ui));
    gate(`6. ${c} translates every learn-hub part and chapter`, missing.length === 0,
      missing.length ? missing.slice(0, 3).map((s) => JSON.stringify(s)).join(', ') : need.length + ' strings');
  }
});

summary();
