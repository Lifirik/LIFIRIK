// set-password.mjs — reset an existing account's password.
//
// The gap this fills is listed in the README as "still missing: password
// reset". There is no self-service reset and no mail is ever sent (§12), so
// the only recovery path is the owner of the box doing it here — and the only
// alternative was hand-editing a scrypt hash into the store, which is exactly
// how you end up with an account that cannot sign in and no error saying why.
//
//   node scripts/set-password.mjs ada                    # generates one
//   node scripts/set-password.mjs ada --password hunter2 # sets that one
//   node scripts/set-password.mjs ada --keep-sessions    # don't sign them out
//
// A NEW SALT EVERY TIME. Re-using the stored salt would work, but a reset is
// the one moment the salt costs nothing to rotate, and rotating it means an
// old stolen hash cannot be checked against the new password offline.
//
// SIGNING THEM OUT IS THE DEFAULT. A password reset that leaves every existing
// session token live has not reset anything — whoever you were locking out is
// still logged in on their own machine. `--keep-sessions` is there for the
// case this is only about a forgotten password on a trusted account, where
// dropping your own other tabs is a nuisance rather than the point.
//
// RUN WITH THE SERVER STOPPED. It holds the whole store in memory and would
// write its own copy back over this (§16).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';
import { hashPassword, newSalt, generatePassword, passwordMatches } from '../auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const name = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--password');

if (!name) {
  console.error('usage: node scripts/set-password.mjs <name> [--password <pw>] [--keep-sessions]');
  process.exit(1);
}

const password = valueOf('--password') || generatePassword();
// the same floor the register route enforces — a password this script sets
// must be one the sign-in form would accept
if (password.length < 4) { console.error('password must be at least 4 characters'); process.exit(1); }

const store = openStore(DB_PATH);
const db = store.readAll();

const nameLower = name.toLowerCase();
const user = Object.values(db.users || {}).find(u => u.nameLower === nameLower);
if (!user) {
  console.error(`No account called "${name}". Names are matched case-insensitively.`);
  console.error('Existing accounts: ' + Object.values(db.users || {}).map(u => u.name).join(', '));
  store.close();
  process.exit(1);
}

user.salt = newSalt();
user.hash = hashPassword(password, user.salt);

let dropped = 0;
if (!flag('--keep-sessions')) {
  for (const [token, s] of Object.entries(db.sessions || {})) {
    if (s.userId === user.id) { delete db.sessions[token]; dropped++; }
  }
}

store.importAll(db);

// Read it back and CHECK THE PASSWORD, not just that a write happened: the
// whole failure mode this script exists to avoid is a stored hash that no
// sign-in will ever match, and "no exception was thrown" does not rule it out.
const after = store.readAll().users[user.id];
store.close();
if (!after || !passwordMatches(password, after.salt, after.hash)) {
  console.error('FATAL: the new password does not verify against what was stored.');
  process.exit(1);
}

console.log('');
console.log(`  account   ${user.name}`);
console.log(`  password  ${password}`);
console.log(`  sessions  ${flag('--keep-sessions') ? 'left alone' : dropped + ' signed out'}`);
console.log('');
console.log('  Verified: the stored hash matches this password.');
console.log('  It is not recoverable from the database — note it down now.');
console.log('  Restart the server before signing in, or it will write the old hash back.');
console.log('');
