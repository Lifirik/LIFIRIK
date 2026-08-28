# deploy.ps1 - ship LIFIRIK to the live site, and bring the live data back.
# Run it from DEPLOY.bat in the project root, not directly.
#
#   LIVE GETS CODE, DEV GETS DATA.
#
# The live site is a desktop box: a router forwards public :80/:443 to Caddy,
# which terminates TLS and reverse-proxies 127.0.0.1:3232, where node serves
# the deployed copy. Default live dir is <this tree>\Production. Edit the
# Caddyfile host name first.
#
# **THIS FILE IS DELIBERATELY PURE ASCII.** Windows PowerShell 5.1 reads a
# script with no byte-order mark as ANSI, so a UTF-8 em-dash arrives as three
# CP1252 characters - one of which is a curly double quote, which PowerShell
# accepts as a string delimiter. The first version of this file was written in
# the project's usual prose style and would not parse at all: four errors, none
# of them on a line that had anything wrong with it. A BOM would also fix it,
# but a BOM is one silent edit away from being gone again.
#
# **What is deployed is dist/, not the source tree** - built by scripts/build.mjs,
# which exists to make the deploy contain no readable source: one minified bundle
# instead of 1.2 MB of ES modules, no docs, no scripts, no data. Before
# this script existed the live site served /js/main.js as 225 KB of readable
# source, because LP had been paste-copied from the source tree.
#
# ORDER MATTERS, and the order is chosen so a failure is survivable:
#
#   1. gates      - all ten suites. Nothing ships that isn't green.
#   2. build      - dist/ is built and its own leak check must pass.
#   3. stop dev   - before its database is overwritten underneath it.
#   4. stop live  - the outage starts here and is measured in seconds.
#   5. pull data  - live database -> dev, by VACUUM INTO (see pull-live-db.mjs).
#   6. push code  - dist/ -> LP, plus Caddyfile and GOLIVE.bat, which are not
#                   in dist because they are host configuration, not app code.
#   7. start live - and Caddy, if it isn't already up.
#   8. verify     - poll the real URL, and confirm the source leak is closed.
#
# Everything expensive happens BEFORE anything is stopped. If the gates fail or
# the build fails, the live site never went down and nothing was touched.
#
# Production\data and Production\node_modules are never touched. Everything
# else in that dir is replaceable from this tree, which makes the sweep safe.
[CmdletBinding()]
param(
  [switch]$SkipTests,      # emergencies only, and it will say so in the log
  [switch]$NoPull,         # ship code without taking the live data
  [string]$LP = 'Production'  # relative to this tree unless rooted
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($LP)) { $LP = Join-Path $root $LP }
$startedAt = Get-Date

function Say($msg)  { Write-Host $msg }
function Step($n, $msg) { Write-Host "" ; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "" ; Write-Host "STOPPED: $msg" -ForegroundColor Red ; exit 1 }

# Which process is listening on a port, if any.
function Get-PortPid($port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($c) { return @($c.OwningProcess)[0] } else { return $null }
}

# Stop a process politely, then insistently. The database survives either way -
# SQLite is in WAL mode, so a hard kill replays on the next open (proven: a
# force-kill of the dev server on 2026-08-03 came back with all 54 levels) -
# but a clean exit runs server.js's flushDb() + store.close(), which
# checkpoints, and that is worth two seconds of patience.
function Stop-Node($procId, $what) {
  if (-not $procId) { Warn "$what was not running"; return }
  Say "    stopping $what (pid $procId)"
  # **The redirection belongs to CMD, not to PowerShell**, and that is the whole
  # reason this goes through `cmd /c`. Redirecting a native command's stderr in
  # Windows PowerShell wraps each line in an ErrorRecord, and with
  # ErrorActionPreference 'Stop' that THROWS - which is exactly how the first
  # real deploy died, on a taskkill doing precisely what it was asked.
  # "ERROR: The process ... could not be terminated" is simply what a console
  # process with no message pump says to a polite request; the force pass below
  # is the answer to it, and the answer was never reached.
  cmd /c "taskkill /PID $procId >nul 2>nul"
  # Two seconds of patience, not five: a clean exit runs server.js's flushDb()
  # and store.close() (which checkpoints the WAL), and is worth waiting for -
  # but when there is no window to close, the polite pass can never succeed and
  # every second after the first is spent proving that again.
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { Ok "$what stopped cleanly"; return }
  }
  cmd /c "taskkill /PID $procId /F >nul 2>nul"
  Start-Sleep -Milliseconds 600
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { Die "could not stop $what (pid $procId)" }
  # Safe even so: SQLite is in WAL mode, so an unflushed commit is replayed on
  # the next open rather than lost (proven 2026-08-03 - a force-killed dev
  # server came back with all 54 levels).
  Ok "$what stopped (forced)"
}

Say ""
Say "LIFIRIK deploy - live gets code, dev gets data"
Say "  from  $root"
Say "  to    $LP"

# ---------------------------------------------------------------- preflight
Step 0 "Preflight"
if (-not (Test-Path (Join-Path $root 'server.js'))) { Die "$root doesn't look like the project (no server.js)" }
if (-not (Test-Path $LP)) { Die "no deploy directory at $LP" }
if (-not (Test-Path (Join-Path $LP 'data\db.sqlite'))) { Die "no live database at $LP\data\db.sqlite - is that really the live copy?" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "node is not on PATH" }
Ok "project, deploy directory and live database all present"

$livePid = Get-PortPid 3232
$devPid  = Get-PortPid 3000
if ($livePid) { Ok "live server on :3232 is pid $livePid" } else { Warn "nothing listening on :3232 - the site is already down" }
if ($devPid)  { Ok "dev server on :3000 is pid $devPid" }

# ...and anything ELSE running server.js, which is the case this script used to
# be blind to. These two ports are not the whole population: a preview tool or
# a second terminal can start a server on an ephemeral port, and it will hold
# data\db.sqlite just as firmly as the dev server does. Reported here as a
# warning rather than a refusal - it is not always wrong to have one, and step
# 3b is the check that actually decides - but named early, because the fix is
# usually "close that window" and it is better to know now.
$others = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'server\.js' -and
    $_.ProcessId -ne $livePid -and $_.ProcessId -ne $devPid
  })
if ($others.Count) {
  Warn "$($others.Count) other node server.js process(es) running: $(($others | ForEach-Object { "pid $($_.ProcessId)" }) -join ', ')"
  Warn "  if one of these was started from this folder it will hold the dev database - step 3b will say so"
}

# ------------------------------------------------------------------- gates
Step 1 "Gates"
if ($SkipTests) {
  Warn "SKIPPED (-SkipTests) - you are shipping untested code"
} else {
  # **Known baselines** (2026-08-18, revised 2026-08-21). The engine became
  # fcsim on 2026-08-17 and a handful of gates that assert the OLD solver's
  # tuning are known casualties awaiting re-authoring - a couple of editor
  # pixel gates, the FC-dialect size gates in validation, the tutorial demos
  # built under the retired profile. Demanding zero of every suite meant
  # nothing could ship at all; skipping the gates means shipping blind. This is
  # the honest middle: every suite runs, and a suite may carry exactly the
  # failures recorded here - one MORE than its baseline blocks the deploy, and
  # a suite that crashes blocks it. Move a number here only with the commit
  # that changed the gate, and say why in it.
  #
  # **verify.mjs / verify-editor / verify-validation / verify-tutorial**
  # (2026-08-27). Pre-rescale physics, editor-pixel, FC-size and tutorial-demo
  # casualties were cut rather than kept as allowed failures. Remaining
  # failures are not allowed.
  $baseline = @{}
  $dead = @()
  $suites = @('verify','verify-editor','verify-surfaces','verify-zones',
              'verify-audio','verify-validation','verify-tutorial','verify-challenges','verify-ownership',
              'verify-admin','verify-i18n','verify-fcworld','verify-ghostrun')
  $total = 0; $known = 0
  foreach ($s in $suites) {
    if ($dead -contains $s) { Warn ("    {0,-20} SKIPPED - known dead since the engine cut" -f $s); continue }
    $out = & node (Join-Path $root "scripts\$s.mjs") | Out-String
    $line = ($out -split "`n" | Where-Object { $_ -match '^\d+ passed' } | Select-Object -Last 1)
    if (-not $line) { Say $out; Die "$s produced no result line - it probably crashed" }
    if ($line -match '^(\d+) passed, (\d+) failed') {
      $passed = [int]$Matches[1]; $failed = [int]$Matches[2]
      $allowed = 0; if ($baseline.ContainsKey($s)) { $allowed = $baseline[$s] }
      if ($failed -le $allowed) {
        $total += $passed; $known += $failed
        $note = ''; if ($failed -gt 0) { $note = "  (baseline $allowed)" }
        Say ("    {0,-20} {1}{2}" -f $s, $line.Trim(), $note)
      } else {
        Say $out
        Die "$s is worse than its baseline ($failed failed, $allowed allowed): $($line.Trim())"
      }
    } else {
      Say $out
      Die "$s printed an unreadable result line: $($line.Trim())"
    }
  }
  Ok "$total gates green, $known known failures at baseline - nothing ships that got worse"
}

# ------------------------------------------------------------------- build
Step 2 "Build dist/"
Push-Location $root
try {
  $build = & node (Join-Path $root 'scripts\build.mjs') | Out-String
} finally { Pop-Location }
Say $build.TrimEnd()
if ($LASTEXITCODE -ne 0) { Die "the build failed (its own leak check is part of that)" }
$dist = Join-Path $root 'dist'
foreach ($need in @('server.js','package.json','public\index.html','public\app.js','public\style.css','public\vendor\fcsim\fcsim.wasm')) {
  if (-not (Test-Path (Join-Path $dist $need))) { Die "dist/$need is missing - refusing to deploy a partial build" }
}
if (Test-Path (Join-Path $dist 'public\js')) { Die "dist/public/js exists - the build leaked client source" }
Ok "dist/ built and complete"

# ------------------------------------------------- stop dev, then stop live
Step 3 "Stop the dev server"
# Before the dev database is overwritten underneath it: a running server holds
# the file open with its own WAL, and replacing it under a live handle is how
# you get a corrupt database rather than a fresh one.
Stop-Node $devPid "dev server"

# ------------------------------------------------- is the dev database free?
Step "3b" "Check the dev database is free"
# THE PRECONDITION FOR STEP 5, ASKED BEFORE THE LIVE SITE GOES DOWN.
#
# This step exists because of what it costs not to have it. On 2026-08-08 a
# THIRD node server.js - started from this project by a preview tool, on an
# ephemeral port - held data\db.sqlite open. Preflight only ever knew about
# :3000 and :3232, so it saw nothing; the deploy stopped dev, stopped LIVE,
# and then died at step 5 on an EPERM, leaving the site down and half deployed.
#
# The test is an exclusive open, which is the same question step 5 asks rather
# than a proxy for it: if nobody else holds the file, the replace will work.
# It runs here, after dev has released its own handle and before the live
# server is touched, so a lock now costs a re-run instead of an outage.
#
# The process list is only there to NAME the culprit. "The file is locked" on
# its own is not something anyone can act on; "pid 13100 is running server.js"
# is. It cannot prove which process holds the handle - Windows will not say
# without a handle enumerator - so it reports candidates and does not guess.
if (-not $NoPull) {
  $devDb = Join-Path $root 'data\db.sqlite'
  try {
    $probe = [System.IO.File]::Open($devDb, 'Open', 'ReadWrite', 'None')
    $probe.Close()
    Ok "dev database is free to replace"
  } catch {
    $holders = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match 'server\.js' } |
      ForEach-Object { "pid $($_.ProcessId)" })
    $who = if ($holders.Count) { $holders -join ', ' } else { 'none found' }
    Die ("the dev database is locked, so the pull at step 5 would fail. " +
         "Close whatever is holding it and run again - a preview or a second " +
         "dev server started from this folder is the usual culprit. " +
         "node server.js processes running now: $who. " +
         "THE LIVE SITE HAS NOT BEEN TOUCHED and is still up.")
  }
}

Step 4 "Stop the live server"
$outageStart = Get-Date
Stop-Node $livePid "live server"

# --------------------------------------------------------------- pull data
Step 5 "Pull the live database into dev"
if ($NoPull) {
  Warn "SKIPPED (-NoPull)"
} else {
  & node (Join-Path $root 'scripts\pull-live-db.mjs') --from (Join-Path $LP 'data\db.sqlite') --to (Join-Path $root 'data\db.sqlite')
  if ($LASTEXITCODE -ne 0) { Die "pulling the live database failed - the live site is still stopped, start it with GOLIVE.bat" }
  Ok "dev now has the live data"
}

# --------------------------------------------------------------- push code
Step 6 "Push dist/ to the live copy"
# A CLEAN sweep, not a paste-over. Paste-over is how LP ended up serving
# readable source: dist has no public/js, so copying dist on top of a tree that
# already had one would leave the old source sitting there, still served.
$keep = @('data', 'node_modules')
Get-ChildItem $LP -Force | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
  Remove-Item $_.FullName -Recurse -Force
}
Copy-Item (Join-Path $dist '*') $LP -Recurse -Force
# Host configuration, deliberately not in dist: dist is the APP, and these two
# describe the machine it runs on.
Copy-Item (Join-Path $root 'Caddyfile') $LP -Force
Copy-Item (Join-Path $root 'GOLIVE.bat') $LP -Force
if (Test-Path (Join-Path $LP 'public\js')) { Die "LP\public\js survived the sweep - stop, that is the source leak" }
Ok "code replaced; data and node_modules untouched"

# express is the only runtime dependency; anything else means node_modules is stale
$distPkg = (Get-Content (Join-Path $dist 'package.json') -Raw | ConvertFrom-Json)
foreach ($dep in $distPkg.dependencies.PSObject.Properties.Name) {
  if (-not (Test-Path (Join-Path $LP "node_modules\$dep"))) {
    Warn "$dep is missing from LP\node_modules - run: cd `"$LP`" ; npm ci --omit=dev"
  }
}

# ------------------------------------------------------------------- start
Step 7 "Start the live site"
if (Get-Process caddy -ErrorAction SilentlyContinue) {
  Ok "Caddy already running - left alone (it holds the certificates)"
} else {
  Start-Process -FilePath 'caddy' -ArgumentList 'run' -WorkingDirectory $LP -WindowStyle Minimized
  Ok "Caddy started"
}
# The three environment variables are load-bearing and are the reason this is
# not just 'start GOLIVE.bat': HOST keeps the app on loopback so the only way in
# is through Caddy's TLS (without it node binds 0.0.0.0 and the LAN and the
# router reach it in plain HTTP), and TRUST_PROXY makes rate limiting per
# visitor instead of one shared bucket that the first burst locks for everyone.
$env:PORT = '3232'
$env:HOST = '127.0.0.1'
$env:TRUST_PROXY = '1'
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $LP -WindowStyle Minimized
Ok "node started in $LP (PORT 3232, HOST 127.0.0.1, TRUST_PROXY 1)"

# ------------------------------------------------------------------ verify
Step 8 "Verify"
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3232/api/config' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
}
if (-not $up) { Die "the live site did not answer on :3232 within 20 s - check the node window" }
$outage = [math]::Round(((Get-Date) - $outageStart).TotalSeconds, 1)
$cfg = ($r.Content | ConvertFrom-Json)
Ok "live answering - build $($cfg.build), down for $outage s"

# The leak this deploy shape exists to close. A 404 here is the proof.
try {
  $src = Invoke-WebRequest -Uri 'http://127.0.0.1:3232/js/main.js' -UseBasicParsing -TimeoutSec 3
  Warn "/js/main.js still answers $($src.StatusCode) - readable source is being served"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -eq 404) { Ok "/js/main.js is 404 - no readable client source on the live site" }
  else { Warn "/js/main.js -> $($_.Exception.Response.StatusCode.value__)" }
}
# --------------------------------------------------------------- dev again
Step 9 "Restart the dev server"
if ($devPid) {
  # A child inherits this shell's environment, so the live server's settings
  # have to come back OUT before dev is started with them still attached:
  # HOST would quietly put dev on loopback, and TRUST_PROXY tells a server with
  # nothing in front of it to believe a header anyone can forge.
  $env:PORT = '3000'
  Remove-Item Env:HOST -ErrorAction SilentlyContinue
  Remove-Item Env:TRUST_PROXY -ErrorAction SilentlyContinue
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Minimized
  Start-Sleep -Milliseconds 1200
  if (Get-PortPid 3000) { Ok "dev server back on :3000, with today's live data" }
  else { Warn "dev did not come back - start it yourself when you want it" }
} else {
  Say "    dev wasn't running before, so it hasn't been started"
}

Say ""
Say ("Done in {0:n0}s." -f ((Get-Date) - $startedAt).TotalSeconds)
Say ""
