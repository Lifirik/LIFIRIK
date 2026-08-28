// i18n-scan.mjs — every string literal in the client source, with enough
// context to say which ones a person will read.
//
// Two customers. `verify-i18n.mjs` imports `scanStrings` to hold the
// dictionaries against the code: a dictionary key that no longer appears
// verbatim anywhere is a translation of a sentence the game stopped saying,
// and the scan is how the gate knows what the game says. And run as a CLI it
// lists candidate strings by file — how the catalog was assembled in the
// first place, and how a new screen's strings get found later:
//
//   node scripts/i18n-scan.mjs public/js/main.js
//
// It is a TOKENIZER, not a parser: single quotes, double quotes, template
// literals, both comment kinds, and the one genuinely awkward customer —
// regex literals, which may contain quotes (`/[&<>"']/g` in util.js is real).
// Whether a `/` opens a regex or divides is decided the way engines do it:
// by what came before. After a value (identifier, `)`, `]`, number) it
// divides; after anything else it opens a regex. That heuristic is exact for
// this codebase and checked by the gate that uses it.
//
// Template literals are recorded with their `${…}` holes replaced by `{…}`,
// which makes a literal that was converted to tf() line up with its
// dictionary key by inspection.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const VALUE_END = /[A-Za-z0-9_$)\]]/;

export function scanStrings(src) {
  const out = [];
  let i = 0, line = 1;
  let lastMeaning = '';   // last non-space, non-comment character seen
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '/' && !VALUE_END.test(lastMeaning)) {
      // regex literal: skip to its end, honouring escapes and char classes
      i++;
      let inClass = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '\n') { line++; }         // a broken regex; keep walking
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) i++;   // flags
      lastMeaning = ')';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const startLine = line;
      let text = '';
      let hole = false;
      i++;
      while (i < n) {
        const s = src[i];
        if (s === '\\') {
          // Keep the CHARACTER a reader sees: \' is ', \n is a newline. An
          // unknown escape keeps its letter.
          const e = src[i + 1];
          text += e === 'n' ? '\n' : e === 't' ? '\t' : (e ?? '');
          i += 2;
          continue;
        }
        if (s === '\n') { line++; if (quote !== '`') break; text += '\n'; i++; continue; }
        if (s === quote) { i++; break; }
        if (quote === '`' && s === '$' && src[i + 1] === '{') {
          // swallow the hole to its matching brace; record it as {…}
          hole = true;
          let depth = 1;
          let expr = '';
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (!depth) break; }
            if (src[i] === '\n') line++;
            expr += src[i];
            i++;
          }
          i++;   // the closing brace
          // The hole's expression is source too, and often carries literals a
          // reader meets — `${x.levelName || t('a level')}` says 'a level'.
          // Without this recursion those strings are invisible to the scan and
          // the staleness gate calls their dictionary entries dead.
          for (const inner of scanStrings(expr)) out.push({ ...inner, line });
          text += '{' + expr.trim() + '}';
          continue;
        }
        text += s;
        i++;
      }
      out.push({ text, line: startLine, quote, hole });
      lastMeaning = ')';   // a string is a value
      continue;
    }
    if (!/\s/.test(c)) lastMeaning = c;
    i++;
  }
  return out;
}

// The reader's-eye filter for the CLI: worth a human look, not proof of
// anything. Code-shaped strings (selectors, keys, routes, colours, single
// words in lowercase) are dropped; anything with a space and a letter, or a
// capitalized word, survives.
export function looksReadable(s) {
  if (!/[A-Za-zÀ-ɏ]/.test(s)) return false;
  if (/^[a-z0-9_.\-/#:[\]()+%,?=&*@]+$/.test(s)) return false;   // code-shaped
  if (/^(rgba?|hsla?)\(/.test(s) || /^#[0-9a-fA-F]{3,8}$/.test(s)) return false;
  if (!s.includes(' ') && !/^[A-Z]/.test(s)) return false;
  return s.length >= 2;
}

// pathToFileURL, not string-glue: on Windows `file://` + argv[1] makes a
// two-slash URL that never equals import.meta.url's three, and the CLI half
// of this file silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const f of process.argv.slice(2)) {
    const src = fs.readFileSync(f, 'utf8');
    console.log(`\n===== ${f}`);
    for (const s of scanStrings(src)) {
      if (!looksReadable(s.text)) continue;
      const tag = s.hole ? ' [tpl]' : '';
      console.log(String(s.line).padStart(5) + tag + '  ' + JSON.stringify(s.text));
    }
  }
}
