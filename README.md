# LIFIRIK

Build a machine from wheels and rods, press Play, deliver the green pieces.
Campaign, level maker, workshop, accounts, replays.

How to play: [Instructions.md](Instructions.md), or **?** in the app
(`/learn`, `/learn/maker`, `/learn/advanced`, `/learn/fc`, `/keys`).

## Run

Need [Node.js](https://nodejs.org/) 22+.

**This PC:** `SetupForLocalPlayServer.bat` → http://localhost:3000

Sign in **LIFIRIK** / **changeme!** and change that password.

**Public site (Windows):** put your domain in `Caddyfile`, point DNS here,
forward 80 and 443, then `SetupForInternetServer.bat`. Later: `DEPLOY.bat`.
Restart: `Production\GOLIVE.bat`.

```bash
npm install
npm run seed     # official campaign; server STOPPED
npm start        # http://localhost:3000
```

Dev serves `public/` off disk. `npm run build` is for deploy only.

Physics is `public/vendor/fcsim/fcsim.wasm` — upgrading it breaks recorded
times. Data is `data/db.sqlite`; edit it only with the server stopped.
Password reset: `node scripts/set-password.mjs <name>`.

## Tests

`DEPLOY.bat` runs the suites in `scripts/verify*.mjs` before it touches
live. Flags: `--only`, `--list`, `--times`, `--quiet`. None of them touch
`data/`.

## Deploy

| | |
|---|---|
| `SetupForInternetServer.bat` | first public site (HTTPS, Node on `127.0.0.1:3232`) |
| `DEPLOY.bat` | later updates |
| `DEPLOY.bat -SkipTests` | ship without gates |
| `DEPLOY.bat -NoPull` | don't pull live data back |
| `Production\GOLIVE.bat` | start live, deploy nothing |

Gates and build run **before** live is stopped. Copy is a clean sweep of
`dist/` into `Production/` (keeps `data` and `node_modules`). Database comes
back by `VACUUM INTO`, never a file copy.

Linux:

```bash
npm run build
rsync -a --delete dist/ you@box:/srv/lifirik/
ssh you@box 'cd /srv/lifirik && npm ci --omit=dev && node scripts/seed-official-levels.js'
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
sudo cp deploy/lifirik.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lifirik caddy
```

Bind the app to loopback, terminate HTTPS in front, `TRUST_PROXY=1` only
behind a real proxy, one process, one disk. Back up `data/`.

## Accounts

```bash
node scripts/invite.mjs ada --admin     # server STOPPED
node scripts/set-password.mjs LIFIRIK
node scripts/set-role.mjs ada --admin
REGISTRATION=closed npm start           # sign-up 403; anonymous play still works
```

Closed registration is not a privacy gate — put `basic_auth` on Caddy if
the URL must stay private. MIT — see [LICENSE](LICENSE). Never commit
`data/db.sqlite`. Reset: stop the server, delete `data/db.sqlite*`,
`npm run seed`.
