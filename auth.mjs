// auth.mjs — password hashing, in one place.
//
// Extracted so the server and the invite script cannot drift. If these
// parameters ever differ between whatever creates an account and whatever
// checks the password, the account simply stops working — with no error to
// explain it, because both sides are behaving exactly as written.
//
// scrypt with node's defaults (N=16384, r=8, p=1) and a 64-byte key, over a
// 16-byte per-user salt. Do not change any of it without a migration: every
// stored hash was produced by these numbers, and changing them invalidates
// every password at once.
import crypto from 'node:crypto';

export const KEY_LEN = 64;
export const SALT_BYTES = 16;

export function newSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

export function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
}

// Constant-time compare, so a wrong password can't be narrowed down by timing.
// Length is checked first because timingSafeEqual throws on a mismatch.
export function passwordMatches(password, salt, expectedHex) {
  const attempt = Buffer.from(hashPassword(password, salt), 'hex');
  const actual = Buffer.from(expectedHex, 'hex');
  return attempt.length === actual.length && crypto.timingSafeEqual(attempt, actual);
}

// Readable on a phone, unambiguous out loud, and still ~62 bits: no l/1/I,
// no O/0. Grouped because a password someone has to retype by hand from a
// message is a password that gets retyped wrong.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function generatePassword(groups = 3, size = 4) {
  const out = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < size; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    out.push(s);
  }
  return out.join('-');
}

// ---------- reserved names (§13) ----------
//
// **Names nobody may register, because holding one is a claim about who you
// are.** A player called "Moderator" needs no exploit to do damage — every
// comment they leave reads as the site talking, and the only defence is not
// letting the name exist. The game's own name is here for the same reason
// and one more: it is the brand.
//
// Here in auth.mjs for the reason the file exists — "extracted so the server
// and the invite script cannot drift". `invite.mjs` mints accounts entirely
// outside the HTTP routes, so a list living in server.js would be a rule the
// other door has never heard of.
//
// **This is a REGISTRATION rule, not a purge.** Accounts that already hold
// one of these names keep working untouched (LIFIRIK is already claimed) —
// the check runs where a name is CHOSEN. And `invite.mjs` may override it
// with `--force`, because minting a staff account deliberately is exactly
// what that script is for.
const RESERVED_EXACT = [
  // the brand, and the shapes people type when they mean it
  'lifirik', 'lifrik', 'lifirick', 'lifirikgame', 'lifirikofficial', 'lifirikteam',
  // authority
  'admin', 'administrator', 'sysadmin', 'superuser', 'superadmin', 'root', 'owner',
  'moderator', 'mod', 'staff', 'official', 'support', 'helpdesk', 'security',
  'system', 'server', 'daemon', 'operator', 'sysop',
  // the site speaking
  'lifiriksupport', 'lifirikadmin', 'lifirikstaff', 'lifirikmod', 'lifirikbot',
  'announcement', 'announcements', 'noreply', 'nobody', 'anonymous', 'deleted',
  'null', 'undefined', 'none', 'everyone', 'here',
  // the bot/automation family
  'bot', 'webmaster', 'postmaster', 'hostmaster', 'abuse',
];
// A name that CONTAINS one of these is refused too — "the_admin", "admin2",
// "xX_Moderator_Xx" all make the same claim. Kept much shorter than the exact
// list on purpose: a substring rule is a blunt instrument, and "modern" or
// "rooted" must stay registerable (which is why 'mod' and 'root' are exact-
// match only, and the four below are words no innocent name contains).
const RESERVED_SUBSTRING = ['administrator', 'moderator', 'lifirik', 'superuser'];

// **Fold the tricks before matching.** Case, spacing, punctuation and the
// obvious digit-for-letter swaps are all ways of writing the same claim:
// "L1F1R1K", "A-D-M-I-N", "M0derator". This is deliberately not a full
// homoglyph defence (that is a different, unwinnable arms race); it is the
// cheap fold that catches everything anybody actually types.
export function foldName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
}

// The reserved name this one is claiming, or null. Returned rather than a
// boolean so the refusal can SAY which word it objected to — "that name is
// reserved" over a name with no obvious authority word in it reads as a bug.
export function reservedName(name) {
  const f = foldName(name);
  if (!f) return null;
  if (RESERVED_EXACT.includes(f)) return f;
  return RESERVED_SUBSTRING.find(w => f.includes(w)) || null;
}
