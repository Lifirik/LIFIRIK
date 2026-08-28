@echo off
cd /d "%~dp0"
set PORT=3232
rem Caddy holds the certificate and is the only thing facing the internet, so
rem the app listens on loopback only - without this it is also reachable in
rem plain HTTP across the LAN and from the router, bypassing the TLS entirely.
set HOST=127.0.0.1
rem Caddy sets X-Forwarded-For (and OVERWRITES it - see Caddyfile). Without
rem this every visitor shares one rate-limit bucket and the first burst locks
rem the site out. Only correct while something really is in front.
set FC_TEXT_MAX=50000
set TRUST_PROXY=1
start "caddy" caddy run
node server.js
