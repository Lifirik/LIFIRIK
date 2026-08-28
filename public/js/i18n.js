// i18n.js — which language the interface speaks, and the two functions that
// speak it. Standalone like sizes.js (it imports nothing), because util.js has
// to reach it and util.js is imported by everything else — an import here
// would be a cycle somewhere.
//
// THE KEY IS THE ENGLISH. There is no invented id layer: a dictionary maps the
// exact English string to its translation, and a string with no entry is shown
// as written. That buys three things. Call sites stay readable — the sentence
// is right there, not `msg.play.limit.4`. A missing translation degrades to
// English instead of to a bare key. And the gate can hold every dictionary
// entry against the source: a key that no longer appears verbatim in the code
// is a translation of a sentence the game stopped saying.
//
// WHERE TRANSLATION HAPPENS. Not at every call site — in the funnels. el() and
// appendAll() in util.js translate string children and the title/placeholder/
// aria-label attributes, and the game's toast does the same, so the whole DOM
// goes through t() without the code saying so anywhere. The cost of that trick
// is honesty about its edge: a string assembled with `${}` before it reaches
// the funnel arrives pre-baked and matches nothing, so composed sentences use
// tf() with {name} slots at the site instead. Strings that never pass a funnel
// (canvas text, document.title, textContent writes) call t() themselves.
//
// User content is deliberately NOT translated, and needs no flag to say so:
// level titles, comments and author names are nobody's English, so they miss
// the dictionary and pass through untouched. A player title that happens to
// equal a UI phrase would be translated; that is the price of source-string
// keys, it is cosmetic, and it is rarer than the bugs an id layer breeds.
//
// PLURALS are the other honest edge. English picks its own s at the call site,
// so a counted phrase has one entry per grammatical shape ("{n} point…" /
// "{n} points…") and a language with three plurals words the phrase so a colon
// or a counter carries any n. Game chrome earns that trade; prose is in
// content.js where a translator has the whole paragraph to work with.

export const LANGS = [
  // Endonyms first, because the picker is read by the person who does not yet
  // have the language it is written in; `eng` is the English exonym the
  // Settings card shows as its hint. Codes are BCP 47 and double as file
  // names: /i18n/<code>.json.
  { code: 'en', name: 'English', eng: 'English' },
  { code: 'zh-CN', name: '简体中文', eng: 'Simplified Chinese' },
  { code: 'de', name: 'Deutsch', eng: 'German' },
  { code: 'ru', name: 'Русский', eng: 'Russian' },
  { code: 'es', name: 'Español', eng: 'Spanish' },
  { code: 'fr', name: 'Français', eng: 'French' },
  { code: 'ko', name: '한국어', eng: 'Korean' },
  { code: 'ja', name: '日本語', eng: 'Japanese' },
  { code: 'hi', name: 'हिन्दी', eng: 'Hindi' },
];
const CODES = new Set(LANGS.map(l => l.code));

// Drawn flags, not emoji — Windows still shows "GB"/"CN" letter pairs for
// regional-indicator emoji, and a language picker that is two letters is
// not a picker. 3:2, simple geometry, one SVG per code.
const FLAG_SVG = {
  en: '<rect width="60" height="40" fill="#012169"/><path d="M0 0 L60 40 M60 0 L0 40" stroke="#fff" stroke-width="10"/><path d="M0 0 L60 40 M60 0 L0 40" stroke="#C8102E" stroke-width="4"/><path d="M30 0 V40 M0 20 H60" stroke="#fff" stroke-width="16"/><path d="M30 0 V40 M0 20 H60" stroke="#C8102E" stroke-width="10"/>',
  'zh-CN': '<rect width="60" height="40" fill="#DE2910"/><g fill="#FFDE00"><polygon points="12,6 13.8,11.4 19.6,11.4 14.9,14.8 16.7,20.2 12,16.8 7.3,20.2 9.1,14.8 4.4,11.4 10.2,11.4"/><polygon transform="translate(24,7) rotate(18)" points="0,-3.1 0.9,-0.9 3.3,-0.9 1.4,0.4 2.2,2.7 0,1.3 -2.2,2.7 -1.4,0.4 -3.3,-0.9 -0.9,-0.9"/><polygon transform="translate(29,12) rotate(36)" points="0,-3.1 0.9,-0.9 3.3,-0.9 1.4,0.4 2.2,2.7 0,1.3 -2.2,2.7 -1.4,0.4 -3.3,-0.9 -0.9,-0.9"/><polygon transform="translate(29,18.5) rotate(54)" points="0,-3.1 0.9,-0.9 3.3,-0.9 1.4,0.4 2.2,2.7 0,1.3 -2.2,2.7 -1.4,0.4 -3.3,-0.9 -0.9,-0.9"/><polygon transform="translate(24,23) rotate(72)" points="0,-3.1 0.9,-0.9 3.3,-0.9 1.4,0.4 2.2,2.7 0,1.3 -2.2,2.7 -1.4,0.4 -3.3,-0.9 -0.9,-0.9"/></g>',
  de: '<rect width="60" height="40" fill="#000"/><rect y="13.33" width="60" height="13.34" fill="#D00"/><rect y="26.67" width="60" height="13.33" fill="#FFCE00"/>',
  ru: '<rect width="60" height="40" fill="#fff"/><rect y="13.33" width="60" height="13.34" fill="#0039A6"/><rect y="26.67" width="60" height="13.33" fill="#D52B1E"/>',
  es: '<rect width="60" height="40" fill="#AA151B"/><rect y="10" width="60" height="20" fill="#F1BF00"/>',
  fr: '<rect width="60" height="40" fill="#fff"/><rect width="20" height="40" fill="#002395"/><rect x="40" width="20" height="40" fill="#ED2939"/>',
  ko: '<rect width="60" height="40" fill="#fff"/><circle cx="30" cy="20" r="9" fill="#CD2E3A"/><path d="M21 20 a9 9 0 0 0 18 0" fill="#0047A0"/><circle cx="30" cy="15.5" r="4.5" fill="#CD2E3A"/><circle cx="30" cy="24.5" r="4.5" fill="#0047A0"/>',
  ja: '<rect width="60" height="40" fill="#fff"/><circle cx="30" cy="20" r="12" fill="#BC002D"/>',
  hi: '<rect width="60" height="13.33" fill="#FF9933"/><rect y="13.33" width="60" height="13.34" fill="#fff"/><rect y="26.67" width="60" height="13.33" fill="#138808"/><circle cx="30" cy="20" r="5.2" fill="none" stroke="#000080" stroke-width="1.1"/><circle cx="30" cy="20" r="1.1" fill="#000080"/>',
};

export function flagSVG(code) {
  const inner = FLAG_SVG[code] || FLAG_SVG.en;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40" aria-hidden="true">${inner}</svg>`;
}

let lang = 'en';
let ui = {};        // English string -> translation
let content = {};   // content.js key -> translated default

// localStorage, in store's own JSON encoding but not through store — util.js
// imports this file, so this file cannot import util.js. The 'eng.' prefix and
// the JSON round-trip match store exactly; if either ever changes shape, the
// worst case is a first visit that re-detects the language.
const LS_KEY = 'eng.lang';
function readSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}
function writeSaved(code) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(code)); } catch { /* full */ }
}

// First visit: the browser's own list, best first. An exact tag wins ('zh-CN'),
// then the base language claims its one variant here ('de-AT' → 'de', bare
// 'zh' → 'zh-CN'). Nothing matched is English, not a guess.
export function detectLang() {
  const wanted = (typeof navigator !== 'undefined' && navigator.languages) || [];
  for (const w of wanted) {
    if (CODES.has(w)) return w;
    const base = String(w).split('-')[0];
    if (CODES.has(base)) return base;
    for (const c of CODES) if (c.split('-')[0] === base) return c;
  }
  return 'en';
}

export function langOf() { return lang; }

// Chosen in Settings (or the nav's 🌐). Persist and report whether it took —
// the caller reloads, because half the visible page was built with the old
// words and a reload is the one honest re-render.
export function setLang(code) {
  if (!CODES.has(code)) return false;
  writeSaved(code);
  return true;
}

// One fetch before the first paint, same contract as the content overrides: a
// missing file, a bad parse or an unreachable server all mean English, so the
// worst case for the whole feature is the site as written.
export async function initI18n() {
  lang = CODES.has(readSaved()) ? readSaved() : detectLang();
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  ui = {}; content = {};
  if (lang === 'en') return lang;
  try {
    const res = await fetch(`/i18n/${lang}.json`);
    if (res.ok) {
      const d = await res.json();
      if (d && typeof d === 'object') {
        ui = (d.ui && typeof d.ui === 'object') ? d.ui : {};
        content = (d.content && typeof d.content === 'object') ? d.content : {};
      }
    }
  } catch { /* English it is */ }
  return lang;
}

// The funnel translation. Only strings, only hits; everything else — numbers,
// nodes, user content, sentences the dictionary has never met — passes through
// unchanged.
export function t(s) {
  if (typeof s !== 'string') return s;
  const hit = ui[s];
  return typeof hit === 'string' && hit ? hit : s;
}

// Composed sentences: translate the template, then fill the {name} slots — in
// that order, so the dictionary key is the template as written at the call
// site. English goes through the same substitution, which is what keeps one
// spelling of the sentence in the code instead of a bare one and a slotted
// one. An unknown slot stays visible rather than vanishing: a translator's
// typo should look like one.
export function tf(s, params = {}) {
  return t(s).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

// content.js asks here before its own defaults: the translated def, or null
// when this language has none (English always has none — its defs ARE the
// English). The admin's DB overrides stay an English-only affair: an override
// beats the def only when the page is in the language the admin actually
// edited, because "newer than the translation" is not "truer than it".
export function contentTranslation(key) {
  const hit = content[key];
  return typeof hit === 'string' && hit.trim() ? hit : null;
}
