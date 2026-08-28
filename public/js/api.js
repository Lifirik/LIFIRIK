// api.js — fetch wrapper for the REST API + localStorage auth (§12).

import { store, uid } from './util.js';

function clientId() {
  let id = store.get('clientId');
  if (!id) { id = uid(); store.set('clientId', id); }
  return id;
}

let _auth = store.get('auth');   // { token, user }

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (_auth?.token) headers.Authorization = 'Bearer ' + _auth.token;
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  clientId,
  // Server switches the UI must respect (invite-only, for one). Never throws:
  // a failed call falls back to the permissive default and lets the server be
  // the one to refuse.
  async config() {
    try { return await req('GET', '/config'); }
    // freeSlots 32 = draw no locks when the config can't be read — the server
    // still refuses, and a wrongly-drawn lock is worse than a late 401
    catch { return { registrationOpen: true, freeSlots: 32, campaigns: [] }; }
  },
  user() { return _auth?.user || null; },
  token() { return _auth?.token || null; },

  async register(name, password, email) {
    const r = await req('POST', '/auth/register', { name, password, email: email || undefined });
    _auth = r; store.set('auth', r);
    return r.user;
  },
  async login(name, password) {
    const r = await req('POST', '/auth/login', { name, password });
    _auth = r; store.set('auth', r);
    return r.user;
  },
  async logout() {
    try { await req('POST', '/auth/logout'); } catch { /* already dead */ }
    _auth = null; store.del('auth');
  },
  // refreshes the cached user — self-heals stale localStorage (§12)
  async me() {
    if (!_auth?.token) return null;
    try {
      const r = await req('GET', '/auth/me');
      _auth = { token: _auth.token, user: r.user };
      store.set('auth', _auth);
      return r.user;
    } catch (e) {
      if (e.status === 401) { _auth = null; store.del('auth'); }
      return null;
    }
  },

  // The admin's text overrides (§13.1). Never throws: an unreachable server
  // means the shipped defaults, which is the site as written rather than a
  // blank one.
  async content() {
    try { return await req('GET', '/content'); } catch { return {}; }
  },
  setContent(key, text) { return req('POST', '/admin/content', { key, text }); },

  levels(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
    q.set('client', clientId());
    return req('GET', '/levels?' + q.toString());
  },
  level(id) { return req('GET', `/levels/${encodeURIComponent(id)}?client=${clientId()}`); },
  publishLevel(payload) { return req('POST', '/levels', payload); },
  updateLevel(id, payload) { return req('PUT', `/levels/${encodeURIComponent(id)}`, payload); },
  // Private things only, server-side — see the routes. Public work has an
  // audience whose solves and ratings aren't the author's to erase.
  deleteLevel(id) { return req('DELETE', `/levels/${encodeURIComponent(id)}`); },
  deleteSolve(levelId, solveId) {
    return req('DELETE', `/levels/${encodeURIComponent(levelId)}/solves/${encodeURIComponent(solveId)}`);
  },
  rate(id, stars) { return req('POST', `/levels/${encodeURIComponent(id)}/rate`, { stars, clientId: clientId() }); },
  rateDifficulty(id, difficulty) {
    return req('POST', `/levels/${encodeURIComponent(id)}/difficulty`, { difficulty, clientId: clientId() });
  },
  comment(id, text, author) { return req('POST', `/levels/${encodeURIComponent(id)}/comments`, { text, author }); },
  deleteComment(levelId, commentId) {
    return req('DELETE', `/levels/${encodeURIComponent(levelId)}/comments/${encodeURIComponent(commentId)}`);
  },
  replaceComment(levelId, commentId, text) {
    return req('PUT', `/levels/${encodeURIComponent(levelId)}/comments/${encodeURIComponent(commentId)}`, { text });
  },
  play(id) { return req('POST', `/levels/${encodeURIComponent(id)}/play`); },
  solve(id, payload) {
    return req('POST', `/levels/${encodeURIComponent(id)}/solve`, {
      ...payload,
      by: payload.by ?? store.get('playerName', '') ?? '',
      client: clientId(),
    });
  },
  // visibility: 'public' | 'unlisted' | 'private'
  setSolveVisibility(levelId, solveId, visibility) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/solve/${encodeURIComponent(solveId)}/visibility`, { visibility });
  },
  fetchSolve(levelId, solveId) {
    return req('GET', `/levels/${encodeURIComponent(levelId)}/solve/${encodeURIComponent(solveId)}`);
  },
  rateSolve(levelId, solveId, rating) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/solve/${encodeURIComponent(solveId)}/rate`, { rating });
  },
  voteComment(levelId, commentId, vote) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/comments/${encodeURIComponent(commentId)}/vote`, { vote });
  },
  voteSolveComment(levelId, solveId, vote) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/solve/${encodeURIComponent(solveId)}/comment/vote`, { vote });
  },
  solveComment(levelId, solveId, comment) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/solve/${encodeURIComponent(solveId)}/comment`, { comment, client: clientId() });
  },
  challenges() { return req('GET', '/challenges'); },
  makeRace(levelId, payload) { return req('POST', `/levels/${encodeURIComponent(levelId)}/race`, payload); },
  cancelRace(levelId) { return req('DELETE', `/levels/${encodeURIComponent(levelId)}/race`); },
  postChallenge(levelId, payload) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/challenges`, payload);
  },
  withdrawChallenge(levelId, challengeId) {
    return req('DELETE', `/levels/${encodeURIComponent(levelId)}/challenges/${encodeURIComponent(challengeId)}`);
  },
  // The message can be rewritten while the challenge is live; the terms cannot
  // (§11.8). `''` clears it.
  setRaceMessage(levelId, message) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/race/message`, { message });
  },
  setChallengeMessage(levelId, challengeId, message) {
    return req('POST', `/levels/${encodeURIComponent(levelId)}/challenges/${encodeURIComponent(challengeId)}/message`, { message });
  },
  profile(name) { return req('GET', `/users/${encodeURIComponent(name)}`); },
  giftPoints(name, amount) { return req('POST', `/users/${encodeURIComponent(name)}/gift-points`, { amount }); },
  adjustPoints(name, delta, reason) { return req('POST', `/users/${encodeURIComponent(name)}/adjust-points`, { delta, reason }); },
  adminOverview() { return req('GET', '/admin/overview'); },
  adminTuning() { return req('GET', '/admin/tuning'); },
  // change your OWN password; the admin reset is adminResetPassword (§12)
  changePassword(current, next) { return req('POST', '/auth/password', { current, next }); },
  adminActive() { return req('GET', '/admin/active'); },
  adminUsers() { return req('GET', '/admin/users'); },
  adminSetRole(name, role) { return req('POST', `/admin/users/${encodeURIComponent(name)}/role`, role); },
  adminSetLimits(name, limits) { return req('POST', `/admin/users/${encodeURIComponent(name)}/limits`, limits); },
  adminSetStatus(name, status) { return req('POST', `/admin/users/${encodeURIComponent(name)}/status`, { status }); },
  // the no-undo one: `confirm` must be the account's exact name, and the
  // server is the one that checks it (§13)
  adminDeleteUser(name, confirm) { return req('DELETE', `/admin/users/${encodeURIComponent(name)}`, { confirm }); },
  // `password` omitted → the server generates one. Either way the answer
  // carries it back exactly once; it is a hash from that moment on.
  adminResetPassword(name, password) { return req('POST', `/admin/users/${encodeURIComponent(name)}/reset-password`, password ? { password } : {}); },
  adminSolves() { return req('GET', '/admin/solves'); },
  // share cards (§11.10) — the backfill pair, admin-only server-side
  adminOgMissing(all) { return req('GET', '/admin/og/missing' + (all ? '?all=1' : '')); },
  adminOgPut(levelId, card) { return req('POST', `/admin/og/${encodeURIComponent(levelId)}`, { card }); },
  featureLevel(id, featured) { return req('POST', `/admin/levels/${encodeURIComponent(id)}/feature`, { featured }); },
  // The campaign's running order (§13). `number` is 1-based — the number on the
  // card — and whatever is already there moves down rather than being replaced.
  setCampaignNumber(id, number) { return req('PUT', `/admin/levels/${encodeURIComponent(id)}/slot`, { number }); },
  removeFromCampaign(id) { return req('DELETE', `/admin/levels/${encodeURIComponent(id)}/slot`); },
  campaigns() { return req('GET', '/campaigns'); },
  setCampaigns(campaigns) { return req('PUT', '/admin/campaigns', { campaigns }); },
  flaggedComments() { return req('GET', '/moderation/flagged'); },
  testBuy() { return req('POST', '/points/test-buy'); },
  testSubscribe() { return req('POST', '/points/test-subscribe'); },
};
