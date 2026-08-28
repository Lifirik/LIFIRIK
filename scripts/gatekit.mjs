// gatekit.mjs — the harness every verify suite shares (2026-08-12).
//
// WHY THIS EXISTS. The same five-line `gate()` was copied into thirteen suites,
// byte for byte, along with the same `pass/fail` counters and the same
// `process.exit(fail ? 1 : 0)`. That is fine until you want one thing from all
// of them at once, and the thing wanted was a filter:
//
//   "I ran the full 1,066-gate editor suite five times today to check one gate.
//    --only 76b would have paid for itself before lunch."
//
// Measured before building it: verify-editor is 9.7 s and 1,173 lines of output
// per run. Five runs is fifty seconds of waiting and about 5,900 lines to read
// for one answer. So the filter has to cut BOTH, and they are separate problems
// — `gate()` filtering silences the output, and `section()` skips the work.
//
// USAGE
//
//   import { gates } from './gatekit.mjs';
//   const { gate, section, summary } = gates();
//
//   section('16', () => {           // skipped entirely unless 16 is wanted
//     gate('16. a rod fired at a wheel bounces', ok, detail);
//   });
//   summary();                      // prints the count, sets process.exitCode
//
// FLAGS
//
//   --only <id|text>   run just the gates whose id is <id>, or whose name
//                      contains <text>. Repeatable. `--only 76b --only 9a`
//   --list             print every gate's id and name, run nothing else
//   --times            print the slowest sections, to find what to convert
//   --quiet            print failures only (the summary still prints)
//
// **`process.exitCode`, never `process.exit()`.** A suite that has built a
// Simulation and calls `process.exit()` can trip a libuv assertion and die with
// code 127 while every gate passed — an hour was lost to that once, hunting a
// gate that was never broken. Setting the code and letting node fall off the
// end is the same contract without the trap.

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const values = (name) => argv.reduce((out, a, i) => (a === name && argv[i + 1] ? [...out, argv[i + 1]] : out), []);

// A gate name's id is the token before its first ". " — "76b. the drag holds"
// has id "76b". Ids are how the suites already talk about themselves, in their
// section banners and in bug reports, so they are what --only takes.
export const idOf = (name) => String(name).split('. ')[0].trim();

export function gates() {
  const wanted = values('--only');
  const listing = flag('--list');
  const timing = flag('--times');
  const quiet = flag('--quiet');
  const filtering = wanted.length > 0;

  // an id match is exact; anything else is a case-insensitive substring of the
  // whole name, so `--only 76b` is precise and `--only "rim force"` still works
  const matches = (name) => !filtering || wanted.some((w) =>
    idOf(name) === w || String(name).toLowerCase().includes(w.toLowerCase()));
  // a SECTION is wanted if its id is asked for, or if any pattern could match a
  // gate inside it. The id is all a section knows about itself, so the second
  // half has to be generous: a text pattern cannot be judged before the gates
  // exist, and skipping the work would make it match nothing at all.
  const sectionWanted = (id) => !filtering || wanted.some((w) =>
    String(id) === w || String(id).toLowerCase().startsWith(w.toLowerCase())
    || !/^[\w.]+$/.test(w));

  let pass = 0, fail = 0, skipped = 0;
  const listed = [];
  const sectionTimes = [];
  // Cost per id WITHOUT needing sections: charge the time since the previous
  // gate to the id of the gate that just finished. A suite that has not been
  // converted still gets a profile, which is how you find the sections worth
  // converting rather than guessing at them.
  const byId = new Map();
  let lastMark = timing ? performance.now() : 0;

  const gate = (name, ok, detail) => {
    if (timing) {
      const now = performance.now();
      const id = idOf(name);
      byId.set(id, (byId.get(id) || 0) + (now - lastMark));
      lastMark = now;
    }
    if (listing) { listed.push(`${idOf(name).padEnd(6)} ${name}`); return; }
    if (!matches(name)) { skipped++; return; }
    const line = `${name}${detail ? '  (' + detail + ')' : ''}`;
    if (ok) { pass++; if (!quiet) console.log(`PASS  ${line}`); }
    else { fail++; console.log(`FAIL  ${line}`); }
  };

  const section = (id, fn) => {
    if (!listing && !sectionWanted(id)) return;
    const t0 = timing ? performance.now() : 0;
    const r = fn();
    // AN ASYNC SECTION REGISTERS NOTHING, and used to do it in silence: `fn()`
    // returns a promise nobody awaits, `summary()` runs first, and the section's
    // gates land after the totals have already been printed. The suite stays
    // green and the count goes UP by zero, which is the one symptom nobody
    // looks at. Caught 2026-08-23 by an `async () =>` written out of habit for a
    // dynamic import — it cost a full run to notice the total had not moved.
    //
    // Awaiting instead would make every caller async and change the shape of
    // every suite. Refusing is the smaller and louder fix: hoist the import.
    if (r && typeof r.then === 'function') {
      throw new Error(`section('${id}') returned a promise — section() does not await, `
        + 'so none of its gates would register. Hoist the await out of the callback.');
    }
    if (timing) sectionTimes.push({ id, ms: performance.now() - t0 });
  };

  const summary = (extra) => {
    if (listing) {
      console.log(listed.join('\n'));
      console.log(`\n${listed.length} gates`);
      return;
    }
    if (timing) {
      const rows = sectionTimes.length
        ? sectionTimes.map((s) => [s.id, s.ms])
        : [...byId.entries()];
      const total = rows.reduce((s, [, ms]) => s + ms, 0);
      const slow = [...rows].sort((a, b) => b[1] - a[1]).slice(0, 14);
      let run = 0;
      console.log(`\nslowest ${sectionTimes.length ? 'sections' : 'gate ids'}:`);
      for (const [id, ms] of slow) {
        run += ms;
        console.log(`  ${String(id).padEnd(6)} ${ms.toFixed(0).padStart(6)} ms  ${(100 * ms / total).toFixed(1).padStart(5)}%  running ${(100 * run / total).toFixed(1)}%`);
      }
      console.log(`  (${rows.length} ids, ${total.toFixed(0)} ms measured)`);
    }
    console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} filtered out` : ''}`);
    if (extra) console.log(extra);
    if (filtering && pass + fail === 0) {
      console.log(`no gate matched ${wanted.map((w) => JSON.stringify(w)).join(' or ')} — try --list`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = fail ? 1 : 0;
  };

  return { gate, section, summary, filtering, listing };
}
