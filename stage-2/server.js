'use strict';
/*
 * Tablekeeper stage 1 — reservations API. Zero dependencies (Node built-ins only).
 *
 * Correctness design
 * - All state lives in one in-memory object (`S`). Node runs handlers on one thread and every
 *   state-reading/-writing section below is fully synchronous (no await between "check" and
 *   "commit"), so check-then-write sequences (table overlap, idempotency lookup + store,
 *   email uniqueness, reference uniqueness) are atomic: concurrent requests are serialised.
 *   The only awaits are request-body reads and scrypt hashing; after the hash completes the
 *   uniqueness check is repeated synchronously before inserting.
 * - Multi-step changes (PATCH, reservation-moves) compute the complete result first, then
 *   commit with plain assignments that cannot fail, so a rejected request changes nothing.
 * - Idempotency records are stored only for 2xx results, keyed by (user, path, key); a stored
 *   record holds the canonical request body and the original response. 4xx never stores.
 * - Reset/import build the complete new state first, then swap the reference in one step.
 * - Time: local wall time -> instant by trying the zone offsets around the date and keeping
 *   those that round-trip; earliest wins (fall-back: first occurrence; spring-forward gap:
 *   none -> invalid_local_time). Durations are absolute milliseconds.
 */
const http = require('http');
const fs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ---------- errors ----------
class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const E = (s, c, m) => new ApiError(s, c, m);
const malformed = (m) => E(400, 'malformed_request', m || 'malformed request');
const invalid = (m) => E(422, 'validation_failed', m || 'validation failed');
const notFound = (m) => E(404, 'not_found', m || 'not found');

// ---------- state ----------
function emptyState() {
  return {
    users: [], // {id,email,display_name,pw:{salt,hash}}
    tokens: {}, // token -> user id
    restaurants: [],
    reservations: [],
    idem: [], // {user,path,key,fp,status,body}
    counters: { user: 0, res: 0 },
  };
}
let S = emptyState();
let IX = buildIndex(S);

function buildIndex(st) {
  const ix = { userById: new Map(), userByEmail: new Map(), rest: new Map(), resById: new Map(), resByRef: new Map(), idem: new Map() };
  for (const u of st.users) { ix.userById.set(u.id, u); ix.userByEmail.set(u.email, u); }
  for (const r of st.restaurants) ix.rest.set(r.id, r);
  for (const r of st.reservations) { ix.resById.set(r.id, r); ix.resByRef.set(r.reference, r); }
  for (const i of st.idem) ix.idem.set(i.user + '\u0000' + i.path + '\u0000' + i.key, i);
  return ix;
}
function install(st) { S = st; IX = buildIndex(st); }

// ---------- time ----------
const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    dtfCache.set(tz, f);
  }
  return f;
}
function validZone(tz) { try { dtf(tz); return true; } catch (e) { return false; } }
// offset in ms (local - utc) at instant ms
function offsetAt(tz, ms) {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return local - Math.floor(ms / 1000) * 1000;
}
// local wall fields -> earliest instant (ms) or null when the time does not exist
function localToInstant(tz, y, mo, d, h, mi) {
  const L = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offs = new Set([offsetAt(tz, L - 86400000), offsetAt(tz, L), offsetAt(tz, L + 86400000)]);
  let best = null;
  for (const o of offs) {
    const t = L - o;
    if (offsetAt(tz, t) === o && (best === null || t < best)) best = t;
  }
  return best;
}
const p2 = (n) => String(n).padStart(2, '0');
function fmtOffset(o) {
  const m = Math.round(o / 60000);
  const s = m < 0 ? '-' : '+';
  const a = Math.abs(m);
  return s + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
}
function isoLocal(tz, ms) {
  const o = offsetAt(tz, ms);
  return new Date(ms + o).toISOString().slice(0, 19) + fmtOffset(o);
}
function isoUtc(ms) { return new Date(ms).toISOString().slice(0, 19) + '+00:00'; }

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(y, mo, d) {
  if (y < 1000 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function parseLocal(s) {
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (!validDate(y, mo, d) || h > 23 || mi > 59) return null;
  return { y, mo, d, h, mi };
}
const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? +m[1] * 60 + +m[2] : NaN; };

// ---------- helpers ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function genRef() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    const b = crypto.randomBytes(8);
    let r = '';
    for (let i = 0; i < 8; i++) r += A[b[i] % 36];
    if (!IX.resByRef.has(r)) return r;
  }
}
function nextId(kind, prefix, map) {
  for (;;) {
    const id = prefix + (++S.counters[kind]);
    if (!map.has(id)) return id;
  }
}

function hashPw(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 32, { N: 8192, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
}
async function makePw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await hashPw(pw, salt);
  return { salt: salt.toString('base64'), hash: h.toString('base64') };
}
async function checkPw(pw, rec) {
  const h = await hashPw(pw, Buffer.from(rec.salt, 'base64'));
  const want = Buffer.from(rec.hash, 'base64');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

function resView(r) {
  return {
    reservation_id: r.id, reference: r.reference, restaurant_id: r.restaurant_id,
    ...(r.table_ids.length === 1 ? { table_id: r.table_ids[0] } : {}), table_ids: r.table_ids.slice(),
    party_size: r.party_size, status: r.status, starts_at_local: r.starts_at_local,
    starts_at: r.starts_at, ends_at: r.ends_at, created_at: r.created_at,
  };
}

function setTimes(r, rest) {
  r.starts_at = isoLocal(rest.timezone, r.starts_ms);
  r.ends_ms = r.starts_ms + rest.reservation_duration_minutes * 60000;
  r.ends_at = isoLocal(rest.timezone, r.ends_ms);
}

// ---------- fixture / state ----------
async function buildFromFixture(fx) {
  if (!isObj(fx)) throw malformed('fixture must be an object');
  const arr = (k) => {
    if (fx[k] === undefined || fx[k] === null) return [];
    if (!Array.isArray(fx[k])) throw invalid(k + ' must be an array');
    return fx[k];
  };
  const st = emptyState();
  for (const u of arr('users')) {
    if (!isObj(u) || typeof u.id !== 'string' || typeof u.email !== 'string' || typeof u.password !== 'string') throw invalid('bad user');
    st.users.push({ id: u.id, email: u.email.toLowerCase(), display_name: typeof u.display_name === 'string' ? u.display_name : u.email.split('@')[0], _pw: u.password });
  }
  await Promise.all(st.users.map(async (u) => { u.pw = await makePw(u._pw); delete u._pw; }));
  for (const r of arr('restaurants')) {
    if (!isObj(r) || typeof r.id !== 'string' || typeof r.timezone !== 'string' || !validZone(r.timezone)) throw invalid('bad restaurant');
    const num = (k, d, min) => {
      const v = r[k] === undefined ? d : r[k];
      if (!isInt(v) || v < min) throw invalid('bad ' + k);
      return v;
    };
    const oh = r.opening_hours === undefined ? [] : r.opening_hours;
    if (!Array.isArray(oh)) throw invalid('bad opening_hours');
    for (const h of oh) {
      if (!isObj(h) || !DAYS.includes(h.weekday) || isNaN(hhmm(h.opens)) || isNaN(hhmm(h.closes))) throw invalid('bad opening_hours entry');
    }
    const tables = r.tables === undefined ? [] : r.tables;
    if (!Array.isArray(tables)) throw invalid('bad tables');
    for (const t of tables) if (!isObj(t) || typeof t.id !== 'string' || !isInt(t.capacity)) throw invalid('bad table');
    const combinable = [];
    if (r.combinable !== undefined) {
      if (!Array.isArray(r.combinable)) throw invalid('bad combinable');
      for (const pr of r.combinable) {
        if (!Array.isArray(pr) || pr.length !== 2 || pr[0] === pr[1] || !pr.every((id) => tables.some((t) => t.id === id))) throw invalid('combinable entries must be pairs of distinct tables of the restaurant');
        if (!combinable.some((c) => (c[0] === pr[0] && c[1] === pr[1]) || (c[0] === pr[1] && c[1] === pr[0]))) combinable.push([pr[0], pr[1]]);
      }
    }
    st.restaurants.push({
      combinable,
      id: r.id, name: typeof r.name === 'string' ? r.name : r.id, timezone: r.timezone,
      slot_minutes: num('slot_minutes', 30, 1), reservation_duration_minutes: num('reservation_duration_minutes', 90, 1),
      cancellation_cutoff_minutes: num('cancellation_cutoff_minutes', 0, 0),
      opening_hours: oh.map((h) => ({ weekday: h.weekday, opens: h.opens, closes: h.closes })),
      tables: tables.map((t) => ({ id: t.id, label: t.label === undefined ? t.id : t.label, capacity: t.capacity })),
    });
  }
  const okId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 64;
  const dup = (a) => new Set(a).size !== a.length;
  if (!st.users.every((u) => okId(u.id)) || !st.restaurants.every((r) => okId(r.id) && r.tables.every((t) => okId(t.id)))) throw invalid('id must be 1..64 characters');
  if (dup(st.users.map((u) => u.id)) || dup(st.users.map((u) => u.email)) || dup(st.restaurants.map((r) => r.id)) || st.restaurants.some((r) => dup(r.tables.map((t) => t.id)))) throw invalid('duplicate id');
  const ix = buildIndex(st);
  for (const x of arr('reservations')) {
    if (!okId(x && x.id) || (x.reference !== undefined && !/^[A-Z0-9]{6,12}$/.test(x.reference))) throw invalid('bad reservation id or reference');
    if (!isObj(x) || typeof x.id !== 'string' || typeof x.restaurant_id !== 'string' || typeof x.starts_at_local !== 'string') throw invalid('bad reservation');
    const rest = ix.rest.get(x.restaurant_id);
    const pl = parseLocal(x.starts_at_local);
    if (!rest || !pl) throw invalid('bad reservation');
    const tids = Array.isArray(x.table_ids) ? x.table_ids : typeof x.table_id === 'string' ? [x.table_id] : null;
    if (!tids || tids.length < 1 || tids.length > 2 || !tids.every((t) => typeof t === 'string' && okId(t))) throw invalid('bad reservation tables');
    let ms = localToInstant(rest.timezone, pl.y, pl.mo, pl.d, pl.h, pl.mi);
    if (ms === null) ms = localToInstant(rest.timezone, pl.y, pl.mo, pl.d, pl.h + 1, pl.mi);
    if (ms === null) throw invalid('bad reservation time');
    const ref = typeof x.reference === 'string' && x.reference ? x.reference : null;
    if (ix.resById.has(x.id) || (ref && ix.resByRef.has(ref))) throw invalid('duplicate reservation');
    const r = {
      id: x.id, reference: ref || '', restaurant_id: x.restaurant_id, table_ids: tids.slice(), user_id: typeof x.user_id === 'string' ? x.user_id : '',
      party_size: isInt(x.party_size) ? x.party_size : 1, status: x.status === 'cancelled' ? 'cancelled' : 'confirmed',
      starts_at_local: x.starts_at_local, starts_ms: ms,
      created_at: typeof x.created_at === 'string' && !isNaN(Date.parse(x.created_at)) ? x.created_at : isoUtc(Date.now()),
    };
    setTimes(r, rest);
    st.reservations.push(r);
    ix.resById.set(r.id, r);
    if (ref) ix.resByRef.set(ref, r);
  }
  for (const r of st.reservations) {
    if (!r.reference) {
      let ref;
      do { ref = genRef2(ix); } while (ix.resByRef.has(ref));
      r.reference = ref; ix.resByRef.set(ref, r);
    }
  }
  return st;
}
function genRef2(ix) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const b = crypto.randomBytes(8);
  let r = '';
  for (let i = 0; i < 8; i++) r += A[b[i] % 36];
  return r;
}

function validateImport(o) {
  if (!isObj(o) || o.track !== 'tablekeeper' || o.format_version !== 1 || !isObj(o.state)) throw invalid('bad export envelope');
  const s = o.state;
  for (const k of ['users', 'restaurants', 'reservations', 'idem']) if (!Array.isArray(s[k])) throw invalid('bad state.' + k);
  if (!isObj(s.tokens) || !isObj(s.counters) || !isInt(s.counters.user) || !isInt(s.counters.res)) throw invalid('bad state');
  const ok = s.users.every((u) => isObj(u) && typeof u.id === 'string' && typeof u.email === 'string' && typeof u.display_name === 'string' && isObj(u.pw) && typeof u.pw.salt === 'string' && typeof u.pw.hash === 'string') &&
    s.restaurants.every((r) => isObj(r) && typeof r.id === 'string' && typeof r.timezone === 'string' && validZone(r.timezone) && Array.isArray(r.tables) && Array.isArray(r.opening_hours) &&
      isInt(r.slot_minutes) && r.slot_minutes > 0 && isInt(r.reservation_duration_minutes) && isInt(r.cancellation_cutoff_minutes)) &&
    s.reservations.every((r) => isObj(r) && typeof r.id === 'string' && typeof r.reference === 'string' && typeof r.restaurant_id === 'string' && (typeof r.table_id === 'string' || (Array.isArray(r.table_ids) && r.table_ids.every((t) => typeof t === 'string'))) &&
      isInt(r.starts_ms) && isInt(r.ends_ms) && (r.status === 'confirmed' || r.status === 'cancelled')) &&
    s.idem.every((i) => isObj(i) && typeof i.user === 'string' && typeof i.path === 'string' && typeof i.key === 'string' && typeof i.fp === 'string' && isInt(i.status)) &&
    Object.values(s.tokens).every((v) => typeof v === 'string');
  if (!ok) throw invalid('bad state content');
  const out = JSON.parse(JSON.stringify(s));
  // Upgrade path: state exported by the stage-1 service has single table_id reservations and no combinations.
  for (const r of out.reservations) {
    if (!Array.isArray(r.table_ids)) r.table_ids = [r.table_id];
    delete r.table_id;
  }
  for (const r of out.restaurants) {
    if (!Array.isArray(r.combinable)) r.combinable = [];
  }
  return out;
}

// ---------- reservation logic ----------
function windowFor(rest, y, mo, d) {
  const wd = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return rest.opening_hours.filter((h) => h.weekday === wd).map((h) => ({ o: hhmm(h.opens), c: hhmm(h.closes) })).sort((a, b) => a.o - b.o);
}

// Resolves a requested table set against the restaurant. Returns {ids (canonical order), capacity}.
// Order: 404 unknown table, combination_not_allowed (size/pair), nothing else.
function resolveTables(rest, ids) {
  let cap = 0;
  for (const id of ids) {
    const t = rest.tables.find((x) => x.id === id);
    if (!t) throw notFound('unknown table');
    cap += t.capacity;
  }
  if (ids.length === 1) return { ids: ids.slice(), capacity: cap };
  if (ids.length > 2) throw E(422, 'combination_not_allowed', 'at most two tables can be combined');
  const pair = rest.combinable.find((c) => (c[0] === ids[0] && c[1] === ids[1]) || (c[0] === ids[1] && c[1] === ids[0]));
  if (!pair) throw E(422, 'combination_not_allowed', 'these tables cannot be combined');
  return { ids: pair.slice(), capacity: cap };
}

// Validates a (table set, local start, party) triple for a restaurant. Returns {ids, ms}.
// Order: 404 table, combination_not_allowed, invalid_local_time, opening hours, grid, capacity.
function checkBooking(rest, tableIds, local, party) {
  const set = resolveTables(rest, tableIds);
  const pl = parseLocal(local);
  const ms = localToInstant(rest.timezone, pl.y, pl.mo, pl.d, pl.h, pl.mi);
  if (ms === null) throw E(422, 'invalid_local_time', 'local time does not exist');
  const m = pl.h * 60 + pl.mi;
  const w = windowFor(rest, pl.y, pl.mo, pl.d).find((x) => m >= x.o && m < x.c);
  if (!w) throw E(422, 'outside_opening_hours', 'outside opening hours');
  if ((m - w.o) % rest.slot_minutes !== 0) throw E(422, 'not_on_slot_grid', 'not on slot grid');
  if (m + rest.reservation_duration_minutes > w.c) throw E(422, 'outside_opening_hours', 'reservation would end after closing');
  if (party > set.capacity) throw E(422, 'party_exceeds_capacity', 'party exceeds table capacity');
  return { ids: set.ids, ms };
}

function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }
const shares = (a, b) => a.some((x) => b.includes(x));
function tableTaken(restId, tableIds, s, e, ignore) {
  for (const r of S.reservations) {
    if (r.status === 'confirmed' && r.restaurant_id === restId && !ignore.has(r) && shares(r.table_ids, tableIds) && overlaps(s, e, r.starts_ms, r.ends_ms)) return true;
  }
  return false;
}

function typeCheckFields(b, needAll) {
  // wrong JSON types -> 400; party_size / starts_at_local format -> 422; missing (create) -> 422
  const out = {};
  if (b.restaurant_id === undefined) { if (needAll) throw invalid('restaurant_id required'); }
  else { if (typeof b.restaurant_id !== 'string') throw malformed('restaurant_id must be a string'); out.restaurant_id = b.restaurant_id; }
  if (b.table_id !== undefined && typeof b.table_id !== 'string') throw malformed('table_id must be a string');
  if (b.table_ids !== undefined && (!Array.isArray(b.table_ids) || !b.table_ids.every((t) => typeof t === 'string'))) throw malformed('table_ids must be an array of strings');
  if (b.table_id !== undefined && b.table_ids !== undefined) throw invalid('send table_id or table_ids, not both');
  if (b.table_ids !== undefined) {
    if (b.table_ids.length === 0) throw invalid('table_ids must not be empty');
    if (new Set(b.table_ids).size !== b.table_ids.length) throw invalid('duplicate table id');
    out.table_ids = b.table_ids.slice();
  } else if (b.table_id !== undefined) out.table_ids = [b.table_id];
  else if (needAll) throw invalid('table_id or table_ids required');
  if (b.starts_at_local === undefined) { if (needAll) throw invalid('starts_at_local required'); }
  else {
    if (typeof b.starts_at_local !== 'string') throw malformed('starts_at_local must be a string');
    if (!parseLocal(b.starts_at_local)) throw invalid('starts_at_local must be YYYY-MM-DDTHH:MM');
    out.starts_at_local = b.starts_at_local;
  }
  if (b.party_size === undefined) { if (needAll) throw invalid('party_size required'); }
  else {
    if (!isInt(b.party_size) || b.party_size < 1) throw invalid('party_size must be an integer >= 1');
    out.party_size = b.party_size;
  }
  return out;
}

function createReservation(user, body) {
  const f = typeCheckFields(body, true);
  const rest = IX.rest.get(f.restaurant_id);
  if (!rest) throw notFound('unknown restaurant');
  const { ids, ms } = checkBooking(rest, f.table_ids, f.starts_at_local, f.party_size);
  const end = ms + rest.reservation_duration_minutes * 60000;
  if (tableTaken(rest.id, ids, ms, end, new Set())) throw E(409, 'table_unavailable', 'table is taken');
  const r = {
    id: nextId('res', 'res_', IX.resById), reference: genRef(), restaurant_id: rest.id, table_ids: ids, user_id: user.id,
    party_size: f.party_size, status: 'confirmed', starts_at_local: f.starts_at_local, starts_ms: ms, created_at: isoUtc(Date.now()),
  };
  setTimes(r, rest);
  S.reservations.push(r); IX.resById.set(r.id, r); IX.resByRef.set(r.reference, r);
  return resView(r);
}

// Resolve the new state of an existing reservation given amendment fields. Throws on any non-occupancy error.
// Cancelled / cutoff checks come first (spec §11: cutoff errors precede other changes for that booking), but
// the body must still be an object (checked by callers).
function planAmend(r, rest, body, now) {
  if (r.status === 'cancelled') throw E(409, 'reservation_cancelled', 'reservation is cancelled');
  if (now >= r.starts_ms - rest.cancellation_cutoff_minutes * 60000) throw E(409, 'cutoff_passed', 'cutoff has passed');
  const f = typeCheckFields(body, false);
  const tableIds = f.table_ids !== undefined ? f.table_ids : r.table_ids;
  const local = f.starts_at_local !== undefined ? f.starts_at_local : r.starts_at_local;
  const party = f.party_size !== undefined ? f.party_size : r.party_size;
  const sameTables = tableIds.length === r.table_ids.length && tableIds.every((t) => r.table_ids.includes(t));
  if (sameTables && local === r.starts_at_local && party === r.party_size) return { r, rest, table_ids: r.table_ids, local, party, ms: r.starts_ms, same: true };
  const { ids, ms } = checkBooking(rest, tableIds, local, party);
  return { r, rest, table_ids: ids, local, party, ms, same: false };
}
function applyPlan(p) {
  const r = p.r;
  r.table_ids = p.table_ids; r.starts_at_local = p.local; r.party_size = p.party; r.starts_ms = p.ms;
  setTimes(r, p.rest);
}

function amend(user, ref, body) {
  const r = IX.resByRef.get(ref);
  if (!r || r.user_id !== user.id) throw notFound();
  const rest = IX.rest.get(r.restaurant_id);
  const p = planAmend(r, rest, body, Date.now());
  if (!p.same && tableTaken(rest.id, p.table_ids, p.ms, p.ms + rest.reservation_duration_minutes * 60000, new Set([r]))) throw E(409, 'table_unavailable', 'table is taken');
  applyPlan(p);
  return resView(r);
}

function moves(user, body) {
  const mv = body.moves;
  if (!Array.isArray(mv) || mv.length < 1 || mv.length > 8) throw invalid('moves must contain 1..8 items');
  const seen = new Set();
  for (const m of mv) {
    if (!isObj(m) || typeof m.reference !== 'string' || !m.reference) throw invalid('bad move item');
    if (seen.has(m.reference)) throw invalid('duplicate reference');
    seen.add(m.reference);
  }
  const recs = mv.map((m) => {
    const r = IX.resByRef.get(m.reference);
    if (!r || r.user_id !== user.id) throw notFound('unknown reservation');
    return r;
  });
  if (recs.some((r) => r.restaurant_id !== recs[0].restaurant_id)) throw invalid('bookings belong to different restaurants');
  const rest = IX.rest.get(recs[0].restaurant_id);
  const now = Date.now();
  const plans = mv.map((m, i) => planAmend(recs[i], rest, m, now));
  const set = new Set(recs);
  const dur = rest.reservation_duration_minutes * 60000;
  const finals = plans.map((p) => ({ tables: p.table_ids, s: p.ms, e: p.ms + dur }));
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].same) continue; // unchanged bookings keep their existing occupancy
    if (tableTaken(rest.id, finals[i].tables, finals[i].s, finals[i].e, set)) throw E(409, 'table_unavailable', 'table is taken');
  }
  for (let i = 0; i < finals.length; i++) {
    for (let j = i + 1; j < finals.length; j++) {
      if (shares(finals[i].tables, finals[j].tables) && overlaps(finals[i].s, finals[i].e, finals[j].s, finals[j].e) && !(plans[i].same && plans[j].same)) throw E(409, 'table_unavailable', 'moves overlap');
    }
  }
  for (const p of plans) if (!p.same) applyPlan(p);
  return { reservations: recs.map(resView) };
}

function availability(q) {
  const rid = q.get('restaurant_id'), date = q.get('date'), ps = q.get('party_size');
  if (!rid || !date || !ps) throw invalid('restaurant_id, date and party_size are required');
  const dm = DATE_RE.exec(date);
  if (!dm || !validDate(+dm[1], +dm[2], +dm[3])) throw invalid('bad date');
  if (!/^[0-9]+$/.test(ps) || +ps < 1 || !Number.isSafeInteger(+ps)) throw invalid('bad party_size');
  const rest = IX.rest.get(rid);
  if (!rest) throw notFound('unknown restaurant');
  const [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
  const party = +ps;
  const dur = rest.reservation_duration_minutes;
  const slots = [];
  for (const w of windowFor(rest, y, mo, d)) {
    for (let m = w.o; m + dur <= w.c; m += rest.slot_minutes) {
      const ms = localToInstant(rest.timezone, y, mo, d, Math.floor(m / 60), m % 60);
      if (ms === null) continue;
      if (m >= 1440) break;
      // second occurrence of a repeated hour is not bookable: only first-occurrence instants are produced
      const e = ms + dur * 60000;
      const free = (t) => !tableTaken(rest.id, [t.id], ms, e, new Set());
      const singles = rest.tables.filter((t) => t.capacity >= party && free(t));
      const ids = singles.map((t) => t.id);
      const options = singles.map((t) => ({ table_ids: [t.id], capacity: t.capacity }));
      for (const c of rest.combinable) {
        const ta = rest.tables.find((t) => t.id === c[0]), tb = rest.tables.find((t) => t.id === c[1]);
        if (ta.capacity + tb.capacity >= party && free(ta) && free(tb)) options.push({ table_ids: c.slice(), capacity: ta.capacity + tb.capacity });
      }
      const lm = `${y}-${p2(mo)}-${p2(d)}T${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
      slots.push({ starts_at_local: lm, starts_at: isoLocal(rest.timezone, ms), available_table_ids: ids, available_options: options });
    }
  }
  return { restaurant_id: rest.id, date, timezone: rest.timezone, slots };
}

// ---------- HTTP ----------
// Browser screens (stage 2). One shell page serves every screen route; app.js renders by pathname.
// All assets are bundled in the image (no CDN, no web fonts).
const ASSETS = {};
(function loadAssets() {
  const dir = nodePath.join(__dirname, 'public');
  const load = (file, type) => ({ type, body: fs.readFileSync(nodePath.join(dir, file)) });
  const page = load('index.html', 'text/html; charset=utf-8');
  for (const r of ['/', '/signup', '/login', '/lookup']) ASSETS[r] = page;
  ASSETS['/static/app.js'] = load('app.js', 'text/javascript; charset=utf-8');
  ASSETS['/static/style.css'] = load('style.css', 'text/css; charset=utf-8');
})();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024 * 1024) { reject(malformed('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseJson(text, allowEmpty) {
  if (allowEmpty && text.trim() === '') return {};
  try { return JSON.parse(text); } catch (e) { throw malformed('invalid JSON'); }
}
function send(res, status, body) {
  if (status === 204) { res.writeHead(204); res.end(); return; }
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function authUser(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  const uid = m ? S.tokens[m[1]] : undefined;
  const u = uid !== undefined ? IX.userById.get(uid) : undefined;
  if (!u) throw E(401, 'unauthenticated', 'missing or invalid token');
  return u;
}

function newToken(user) {
  const t = crypto.randomBytes(24).toString('hex');
  S.tokens[t] = user.id;
  return t;
}

// Idempotent write: returns [status, body]. Fully synchronous between lookup and store.
function idempotent(req, user, path, body, fn) {
  const key = req.headers['idempotency-key'];
  if (key === undefined || key === '') throw E(400, 'missing_idempotency_key', 'Idempotency-Key required');
  if (key.length > 255) throw invalid('Idempotency-Key too long');
  if (!isObj(body)) throw malformed('body must be a JSON object');
  const fp = canon(body);
  const ik = user.id + '\u0000' + path + '\u0000' + key;
  const prior = IX.idem.get(ik);
  if (prior) {
    if (prior.fp !== fp) throw E(409, 'idempotency_key_reuse', 'key already used with a different body');
    return [200, prior.body];
  }
  const out = fn();
  const rec = { user: user.id, path, key, fp, status: 201, body: out };
  S.idem.push(rec); IX.idem.set(ik, rec);
  return [201, out];
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;
  const seg = path.split('/').slice(1).map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });

  if (method === 'GET' || method === 'HEAD') {
    const asset = ASSETS[path];
    if (asset) {
      res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-cache' });
      res.end(method === 'HEAD' ? undefined : asset.body);
      return;
    }
  }
  if (method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });

  if (path === '/_test/reset' && method === 'POST') {
    const fx = parseJson(await readBody(req), true);
    install(await buildFromFixture(fx));
    return send(res, 204);
  }
  if (path === '/_test/export' && method === 'GET') {
    return send(res, 200, JSON.parse(JSON.stringify({ track: 'tablekeeper', format_version: 1, state: S })));
  }
  if (path === '/_test/import' && method === 'POST') {
    const o = parseJson(await readBody(req), false);
    install(validateImport(o));
    return send(res, 204);
  }

  if (method === 'POST' && (path === '/auth/signup' || path === '/auth/login')) {
    const b = parseJson(await readBody(req), false);
    if (!isObj(b)) throw malformed('body must be an object');
    const signup = path === '/auth/signup';
    for (const k of ['email', 'password', 'display_name']) {
      if (b[k] !== undefined && typeof b[k] !== 'string') throw malformed(k + ' must be a string');
    }
    if (b.email === undefined || b.password === undefined) throw invalid('email and password required');
    const email = b.email.toLowerCase();
    if (signup) {
      if (!/^[^@\s]+@[^@\s]+$/.test(b.email)) throw invalid('bad email');
      if (b.password.length < 8) throw invalid('password too short');
      if (IX.userByEmail.has(email)) throw E(409, 'email_taken', 'email already registered');
      const pw = await makePw(b.password);
      if (IX.userByEmail.has(email)) throw E(409, 'email_taken', 'email already registered');
      const u = { id: nextId('user', 'u_', IX.userById), email, display_name: b.display_name || b.email.split('@')[0], pw };
      S.users.push(u); IX.userById.set(u.id, u); IX.userByEmail.set(email, u);
      return send(res, 201, { user_id: u.id, display_name: u.display_name, token: newToken(u) });
    }
    const u = IX.userByEmail.get(email);
    const ok = u ? await checkPw(b.password, u.pw) : (await hashPw(b.password, 'x'), false);
    if (!ok || IX.userById.get(u.id) !== u) throw E(401, 'unauthenticated', 'invalid credentials');
    return send(res, 200, { user_id: u.id, display_name: u.display_name, token: newToken(u) });
  }

  // public
  if (method === 'GET' && path === '/restaurants') {
    return send(res, 200, { restaurants: S.restaurants.map((r) => ({ id: r.id, name: r.name, timezone: r.timezone })) });
  }
  if (method === 'GET' && seg[0] === 'restaurants' && seg.length === 2) {
    const r = IX.rest.get(seg[1]);
    if (!r) throw notFound('unknown restaurant');
    return send(res, 200, r);
  }
  if (method === 'GET' && path === '/availability') return send(res, 200, availability(url.searchParams));

  // authenticated
  if (path === '/reservations' || path === '/reservation-moves' || seg[0] === 'reservations') {
    const user = authUser(req);
    if (path === '/reservations' && method === 'POST') {
      const text = await readBody(req);
      if (req.headers['idempotency-key'] === undefined || req.headers['idempotency-key'] === '') throw E(400, 'missing_idempotency_key', 'Idempotency-Key required');
      const [st, out] = idempotent(req, user, path, parseJson(text, false), () => createReservation(user, parseJson(text, false)));
      return send(res, st, out);
    }
    if (path === '/reservation-moves' && method === 'POST') {
      const text = await readBody(req);
      if (req.headers['idempotency-key'] === undefined || req.headers['idempotency-key'] === '') throw E(400, 'missing_idempotency_key', 'Idempotency-Key required');
      const [st, out] = idempotent(req, user, path, parseJson(text, false), () => moves(user, parseJson(text, false)));
      return send(res, st, out);
    }
    if (path === '/reservations' && method === 'GET') {
      const mine = S.reservations.filter((r) => r.user_id === user.id).sort((a, b) => b.starts_ms - a.starts_ms || (a.id < b.id ? 1 : -1));
      return send(res, 200, { reservations: mine.map(resView) });
    }
    if (seg[0] === 'reservations' && seg.length === 2 && method === 'GET') {
      const r = IX.resByRef.get(seg[1]);
      if (!r || r.user_id !== user.id) throw notFound();
      return send(res, 200, resView(r));
    }
    if (seg[0] === 'reservations' && seg.length === 3 && seg[2] === 'cancel' && method === 'POST') {
      await readBody(req);
      const r = IX.resByRef.get(seg[1]);
      if (!r || r.user_id !== user.id) throw notFound();
      if (r.status !== 'cancelled') {
        const rest = IX.rest.get(r.restaurant_id);
        if (Date.now() >= r.starts_ms - rest.cancellation_cutoff_minutes * 60000) throw E(409, 'cutoff_passed', 'cutoff has passed');
        r.status = 'cancelled';
      }
      return send(res, 200, resView(r));
    }
    if (seg[0] === 'reservations' && seg.length === 2 && method === 'PATCH') {
      const b = parseJson(await readBody(req), false);
      if (!isObj(b)) throw malformed('body must be an object');
      return send(res, 200, amend(user, seg[1], b));
    }
  }
  throw notFound('no such route');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message } });
    console.error(e);
    send(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
