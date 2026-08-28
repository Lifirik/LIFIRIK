// ratelimit.mjs — small in-memory request limiter for the REST API.
//
// No dependency: at one process and a few thousand users, a Map of fixed
// windows is the whole job, and it costs nothing to audit. If this ever runs on
// more than one box the counters stop being shared and the limits become
// per-instance — that's the point at which this wants Redis, not before.
//
// What it is actually defending:
//   * login — `crypto.scryptSync` burns ~100 ms of CPU *and blocks the event
//     loop*, so an unlimited login endpoint is both a password oracle and a
//     one-client denial of service against every other player.
//   * register — an open account factory writes straight into the datastore.
//   * writes — levels are up to 2 MB each and the datastore is one JSON file.
//     Unlimited POSTs are a disk-filling primitive.
//
// Responses are 429 with `{ error }`, which is the same shape every other
// failure uses, so the client's existing error handling already surfaces them.

// Behind a reverse proxy every request arrives from the proxy's address. Taking
// X-Forwarded-For unconditionally would let anyone spoof a fresh identity per
// request; ignoring it behind a proxy puts EVERY visitor in one bucket, so the
// first burst locks out the whole site. Neither is safe to guess, so it's the
// operator's call: set TRUST_PROXY=1 when, and only when, something in front is
// setting the header.
export const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DISABLED = process.env.RATE_LIMIT_DISABLED === '1';

export function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    // left-most entry is the original client; the rest are proxies
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Loopback is the box talking to itself (dev, FC user-download, the test
// harness). The caps exist to stop a flood from the network, not to pace a
// script on this machine. IPv4, IPv6, and the v4-mapped form Node reports
// for dual-stack listeners (:ffff:127.0.0.1).
export function isLoopback(ip) {
  const s = String(ip || '');
  return s === '127.0.0.1' || s === '::1' || s === ':1' || /(?:^|:)127\.0\.0\.1$/.test(s);
}

const buckets = new Map();   // "name|key" -> { n, resetAt }
const MAX_KEYS = 50_000;     // a flood of unique keys must not become a leak

function sweep(now) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  if (buckets.size > MAX_KEYS) {
    // still oversized after dropping the expired: shed the longest-lived first
    const live = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < live.length - MAX_KEYS; i++) buckets.delete(live[i][0]);
  }
}
// unref'd: a timer must never be the reason the process won't exit (the
// shutdown flush in server.js depends on that)
setInterval(() => sweep(Date.now()), 60_000).unref();

// Take one unit from a bucket. The primitive, so a route can spend budget on
// its own terms — the login route only charges for FAILED attempts, which a
// middleware (charging on arrival, before anything is known) cannot express.
// Returns { ok, remaining, resetSec }.
export function consume(name, key, { windowMs, max }) {
  if (DISABLED) return { ok: true, remaining: max, resetSec: 0 };
  const k = `${name}|${key}`;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || b.resetAt <= now) { b = { n: 0, resetAt: now + windowMs }; buckets.set(k, b); }
  b.n++;
  return {
    ok: b.n <= max,
    remaining: Math.max(0, max - b.n),
    resetSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

// Clear a bucket — a successful sign-in forgives the failures before it.
export function resetKey(name, key) { buckets.delete(`${name}|${key}`); }

// opts:
//   name     bucket namespace, so two limiters never share a counter
//   windowMs fixed window length
//   max      requests allowed per window
//   by       req -> key (default: client IP); returning null skips the limit
//   message  the 429 body's `error`
// `max` may be a NUMBER or a FUNCTION of the request (2026-08-18, "raise the
// limits for everyone a bit and admin accounts x10") — the budget is decided
// per request, so a route can hand admins a bigger bucket without a second
// limiter. The bucket key is unchanged; only the ceiling moves.
export function rateLimit({ name, windowMs, max, by = clientIp, message }) {
  return function limiter(req, res, next) {
    if (DISABLED) return next();
    // Always the socket, not the bucket key: heavy/write limits key on the
    // signed-in user, and those are the ones a local import actually hits.
    if (isLoopback(clientIp(req))) return next();
    const id = by(req);
    if (id == null) return next();
    const cap = typeof max === 'function' ? max(req) : max;
    const hit = consume(name, id, { windowMs, max: cap });
    res.setHeader('RateLimit-Limit', String(cap));
    res.setHeader('RateLimit-Remaining', String(hit.remaining));
    res.setHeader('RateLimit-Reset', String(hit.resetSec));
    if (!hit.ok) {
      res.setHeader('Retry-After', String(hit.resetSec));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

// test seam — the fixed windows are minutes long, which no test should wait out
export function _resetBuckets() { buckets.clear(); }
export function _bucketCount() { return buckets.size; }
