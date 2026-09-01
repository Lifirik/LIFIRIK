# Contributing

How to change LIFIRIK without breaking Play, recorded times, or the words
on screen.

Run and deploy: [README.md](README.md). How to play:
[Instructions.md](Instructions.md). MIT — see [LICENSE](LICENSE).

## Setup

Need [Node.js](https://nodejs.org/) 22+.

```bash
npm install
npm run seed     # official campaign; server STOPPED
npm start        # http://localhost:3000
```

On Windows, `SetupForLocalPlayServer.bat` does the same. Sign in **LIFIRIK**
/ **changeme!** and change that password.

Dev serves `public/` off disk. `npm run build` is for deploy only — you do
not need `dist/` to work on the game.

Never commit `data/db.sqlite` (or `-wal` / `-shm`). It holds password
hashes, sessions, and addresses. A fresh checkout builds its own with
`npm run seed`.

## Layout

| | |
|---|---|
| `public/js/` | client: editor, sim, render, import (vanilla ES modules) |
| `public/i18n/` | translations (English is the key, not an id) |
| `public/js/content.js` | long-form help; in-app **?** reads this |
| `public/vendor/fcsim/fcsim.wasm` | physics. Do not swap it casually |
| `engine/` | source for that wasm (`engine/build.sh`) |
| `server.js` | Express app, accounts, workshop, replays |
| `scripts/verify*.mjs` | acceptance gates |
| `scripts/campaign-seed.json` | official campaign |

`game.js` is the editor. `sim.js` is Play. `util.js` is the shared pin and
geometry rules both of those must go through, so a joint in the editor is
the same joint the solver builds.

## One rule, one place

A rule that lives in a drag handler and not in paste, or in the editor and
not in the sim, will ship a bug. Placement, paste, duplicate, nudge, and
drag have to refuse (or accept) the same pose. The editor must not refuse a
placement the solver will run, and must not allow one the solver will not.

If you change what a pin is, change it in `util.js` (`jointKey`,
`wheelPins`, `rodPins`, …) and let the editor and the sim ask those. Two
copies of a number that must agree will eventually disagree.

Comments say **why** a constraint is there, not what the next line does.
The `§n` markers in comments are notes in this tree, not a separate spec.

## Physics

Joints are shared coordinates. `jointKey` rounds to 0.1 px. Hand-built
machines joint by that. An imported Fantastic Contraption machine also
carries `att` (which part ids share a pin) and `shell` (the source
centre/length/rotation Play rebuilds from). A move or paste that shifts
`x/y` and leaves `att` / `shell` behind comes apart on Run.

The wasm is a determinism contract. Recorded times, GhostRun, and the
campaign solves are bit-exact against this file. Replacing
`public/vendor/fcsim/fcsim.wasm` without re-proving those is a break.

Rebuild only if you meant to change the engine:

```bash
bash engine/build.sh
```

Needs clang and `wasm-ld` (LLVM), targeting wasm32, no stdlib. Do not add
`-ffast-math` or `--allow-undefined`. The script says why.

## Tests

`DEPLOY.bat` runs these before it touches live. None of them write `data/`.

```bash
node scripts/verify.mjs
node scripts/verify-editor.mjs
node scripts/verify-validation.mjs
node scripts/verify-i18n.mjs
node scripts/verify-fcworld.mjs
# also: verify-surfaces, verify-zones, verify-audio, verify-tutorial,
# verify-challenges, verify-ownership, verify-admin, verify-ghostrun
```

Extra suites for a narrower change: `verify-axles`, `verify-pins`,
`verify-gfx`, `verify-ghostprops`.

Flags (see `scripts/gatekit.mjs`):

```bash
node scripts/verify-editor.mjs --only 104
node scripts/verify-editor.mjs --list
node scripts/verify-editor.mjs --times
node scripts/verify-editor.mjs --quiet
```

`--only` takes a gate id (`104`) or a substring of the name. `section()`
skips the work when that section is not wanted; a gate outside a section
still runs its setup.

A gate that imported the constant it is supposed to police would follow a
silent change. Restate numbers in the suite (the way `verify-editor.mjs`
does) so a change **fails** and gets looked at.

Suites must set `process.exitCode`, not call `process.exit()`. Exiting
after a Simulation has been built can trip libuv and die with 127 while
every gate passed.

When you fix a rule, add a gate that would have caught it. Name it in the
suite's voice: `104. paste lands the shell at the new spot, not the old one`.

A new verify script should resolve its tree with `fileURLToPath(import.meta.url)`,
not `new URL(import.meta.url).pathname`. The pathname is percent-encoded;
on a path with spaces the imports 404.

## Words

Player-facing chrome (buttons, toasts, tooltips) is an English string at
the call site. `el()` / `appendAll()` / toasts run it through `t()` for
you. A sentence with a number or a name uses `tf('Cut {n} pieces.', { n })`
— do not assemble it with `` `${}` `` before it reaches a funnel, or the
dictionary will never see it. Canvas text and `document.title` call `t()`
themselves.

`public/i18n/<code>.json` maps that exact English to a translation (`ui`)
and maps `content.js` keys to translated prose (`content`). Languages:
zh-CN, de, ru, es, fr, ko, ja, hi.

- A dictionary key that no longer appears in the source is a translation of
  a sentence the game stopped saying. `verify-i18n.mjs` fails it.
- `k === v` is forbidden. `t()` already shows the English.
- Keep every `{slot}`, and in content keep `[links](/routes)` and `**bold**`
  balanced.
- A missing `ui` entry degrades to English. Translate new chrome in all
  eight files anyway, or only English speakers see the change as finished.
- Level titles, comments, and author names are not translated.

Long-form help is `public/js/content.js` (in-app **?**) and
`Instructions.md` (the same material, standalone). Change both when the
player-facing fact changes. Button labels do not belong in `content.js`.

Find candidate strings:

```bash
node scripts/i18n-scan.mjs public/js/game.js
```

## Sending a change

1. Keep the diff to the thing you are changing.
2. Run the suites that cover it (`--only` is for that). Deploy runs the
   full set in the list above.
3. Commit in the existing voice: one imperative sentence, what the change
   *does* (`Keep imported machines jointed after move and paste.`).

Pull requests against `master` are fine. Do not include `data/`, `dist/`,
`Production/`, or a new wasm unless the commit is the engine change and the
gates that prove it.