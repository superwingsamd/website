/**
 * Superwings Foundation: Google Apps Script backend
 * -------------------------------------------------
 * Database: the Google Sheet this script is bound to (one tab per table).
 * Images:   a Google Drive folder (public view links).
 * Email:    Zoho ZeptoMail first, Zoho Mail self-client as fallback.
 * Jobs:     time trigger every 5 minutes (reminders, thank-you emails, 7-day deletion, email queue).
 *
 * First time: run setup() from the editor, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). Put the /exec URL in public/assets/config.js.
 */

// ============================================================ configuration
const TZ = 'Asia/Kolkata';
const SESSION_DAYS = 14;
const MAX_SENDS_PER_RUN = 80;
const PUBLIC_KEYS = ['org_name', 'contact_email', 'contact_phone', 'address', 'reg_no', 'darpan_id', 'pan', 'reg_12a', 'reg_80g',
  'reg_80g_validity', 'csr1', 'upi_id', 'upi_qr_id', 'bank_name', 'bank_account_name', 'bank_account_no', 'bank_ifsc', 'bank_branch',
  'donation_note', 'instagram', 'linkedin', 'facebook', 'site_url'];
const SECRET_KEYS = ['zepto_token', 'zoho_client_secret', 'zoho_refresh_token']; // kept in Script Properties, never in the sheet
const DEFAULT_SETTINGS = {
  org_name: 'Superwings Foundation', contact_email: 'contact@superwingsfoundation.org', contact_phone: '+91 99250 21383',
  address: 'I-504, Safal Parivesh Flats, near Prahladnagar AUDA Garden, behind Flavours Restaurant, Satellite, Ahmedabad, Gujarat 380015',
  reg_no: 'E/23237/Ahmedabad', darpan_id: 'GJ/2025/0904643', pan: 'ABITS6749R', site_url: 'https://superwingsfoundation.org',
  email_primary: 'zeptomail', zepto_host: 'api.zeptomail.in', zoho_dc: 'in', reminder_hours: '24', followup_hours: '3', retention_days: '7',
};
const PROGRAMMES = {
  general: 'General Volunteer', university: 'University Service Learning', ibdp_cas: 'IB Diploma: CAS',
  ibcp_sl: 'IB Career-related Programme: Community Engagement',
};
const ROLE_LABEL = { admin: 'Administrator', trustee: 'Trustee', coordinator: 'Volunteer Programme Coordinator', student: 'Student Volunteer' };
const STAFF = ['admin', 'trustee', 'coordinator'], LEADERS = ['admin', 'trustee'], ANYONE = ['admin', 'trustee', 'coordinator', 'student'];

const SCHEMA = {
  users: ['id', 'email', 'name', 'phone', 'role', 'password_hash', 'status', 'created_at'],
  sessions: ['token', 'user_id', 'expires_at'],
  resets: ['token', 'user_id', 'expires_at'],
  settings: ['key', 'value'],
  people: ['id', 'kind', 'name', 'title', 'photo_id', 'message', 'bio', 'email', 'sort', 'visible'],
  events: ['id', 'slug', 'title', 'subtitle', 'description', 'cover_id', 'venue', 'address', 'map_url', 'start_at', 'end_at', 'capacity', 'reg_open', 'status', 'sender_id', 'created_at', 'updated_at'],
  agenda: ['id', 'event_id', 'start_time', 'end_time', 'title', 'speaker', 'description', 'sort'],
  registrations: ['id', 'event_id', 'code', 'name', 'email', 'phone', 'organisation', 'notes', 'confirm_sent', 'reminder_sent', 'followup_sent', 'created_at'],
  partners: ['id', 'name', 'type', 'contact_name', 'email', 'phone', 'programme', 'students', 'message', 'logo_id', 'status', 'created_at'],
  volunteers: ['user_id', 'programme', 'institution', 'partner_id', 'grade', 'supervisor_name', 'supervisor_email', 'interests', 'availability', 'guardian_consent', 'status', 'created_at'],
  activities: ['id', 'user_id', 'date', 'hours', 'title', 'description', 'strands', 'outcomes', 'reflection', 'status', 'reviewer_id', 'review_note', 'created_at'],
  donations: ['id', 'receipt_no', 'name', 'email', 'phone', 'pan', 'address', 'amount', 'mode', 'txn_ref', 'purpose', 'message', 'status', 'received_at', 'created_at'],
  senders: ['id', 'address', 'name', 'is_default'],
  email_log: ['id', 'kind', 'to_addr', 'from_addr', 'subject', 'provider', 'status', 'error', 'created_at'],
  outbox: ['id', 'to_addr', 'to_name', 'cc', 'subject', 'html', 'kind', 'sender_id', 'ref_table', 'ref_id', 'ref_flag', 'attempts', 'status', 'last_error', 'created_at'],
};
const NUMERIC = ['id', 'user_id', 'event_id', 'sort', 'visible', 'capacity', 'reg_open', 'sender_id', 'confirm_sent', 'reminder_sent', 'followup_sent',
  'partner_id', 'students', 'guardian_consent', 'hours', 'reviewer_id', 'amount', 'is_default', 'attempts', 'ref_id'];

// ============================================================ errors & validation
function HttpError(status, message) { this.status = status; this.message = message; }
function bad(msg) { throw new HttpError(400, msg); }
function str(v, max) { return v == null ? '' : String(v).trim().slice(0, max || 500); }
function optStr(v, max) { const s = str(v, max); return s === '' ? null : s; }
function reqStr(v, field, max) { const s = str(v, max); if (!s) bad(field + ' is required'); return s; }
function email(v, field) {
  const s = str(v, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) bad((field || 'Email') + ' is not a valid email address');
  return s;
}
function optEmail(v, field) { return str(v) ? email(v, field) : null; }
function oneOf(v, list, field) { if (list.indexOf(v) < 0) bad(field + ' must be one of: ' + list.join(', ')); return v; }
function num(v, field, o) {
  o = o || {};
  if ((v === '' || v == null) && o.optional) return null;
  const n = Number(v);
  const min = o.min == null ? -Infinity : o.min, max = o.max == null ? Infinity : o.max;
  if (!isFinite(n) || n < min || n > max) bad(field + ' must be a number between ' + min + ' and ' + max);
  return n;
}
function isoDateTime(v, field) {
  const d = new Date(str(v, 40));
  if (!str(v) || isNaN(d.getTime())) bad(field + ' must be a valid date and time');
  return d.toISOString();
}
function slugify(s) {
  return str(s, 120).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) bad('Password must be at least 8 characters');
  if (p.length > 200) bad('Password is too long');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function nowIso() { return new Date().toISOString(); }
function fmtDate(iso, pattern) { return Utilities.formatDate(new Date(iso), TZ, pattern || 'd MMMM yyyy'); }
function fmtWhen(s, e) {
  const sameDay = fmtDate(s) === fmtDate(e);
  return sameDay ? fmtDate(s, 'EEEE, d MMMM yyyy') + ', ' + fmtDate(s, 'h:mm a') + ' – ' + fmtDate(e, 'h:mm a') + ' IST'
    : fmtDate(s) + ', ' + fmtDate(s, 'h:mm a') + ' – ' + fmtDate(e) + ', ' + fmtDate(e, 'h:mm a') + ' IST';
}

// ============================================================ crypto helpers
function randomToken() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function randomCode(len) {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', hex = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < (len || 8); i++) out += a[parseInt(hex.substr(i * 2, 2), 16) % a.length];
  return out;
}
const HASH_ROUNDS = 400;
function hashPassword(password, salt, rounds) {
  salt = salt || Utilities.getUuid();
  rounds = rounds || HASH_ROUNDS;
  const key = Utilities.newBlob(salt).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(password).getBytes(), key);
  for (let i = 1; i < rounds; i++) h = Utilities.computeHmacSha256Signature(h.concat(Utilities.newBlob(password).getBytes()), key);
  return 'h1$' + rounds + '$' + salt + '$' + Utilities.base64Encode(h);
}
function verifyPassword(password, stored) {
  const p = String(stored || '').split('$');
  if (p[0] !== 'h1') return false;
  return hashPassword(String(password), p[2], Number(p[1])) === stored;
}

// ============================================================ sheet database
let _ss = null;
const _tables = {};
function ss() {
  if (_ss) return _ss;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return (_ss = SpreadsheetApp.openById(id));
  let active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* standalone script */ }
  if (!active) throw new HttpError(500, 'No database sheet found. Open the Apps Script editor and run setup() once.');
  return (_ss = active);
}
function toCell(v) { if (v == null) return ''; if (v === true) return '1'; if (v === false) return '0'; return String(v); }

function Table(name) {
  this.name = name; this.cols = SCHEMA[name];
  this.sh = ss().getSheetByName(name);
  if (!this.sh) throw new HttpError(500, 'Sheet "' + name + '" is missing. Run setup() once from the Apps Script editor.');
  this._rows = null;
}
Table.prototype.rows = function () {
  if (this._rows) return this._rows;
  const n = this.sh.getLastRow();
  const vals = n < 2 ? [] : this.sh.getRange(2, 1, n - 1, this.cols.length).getDisplayValues();
  const cols = this.cols;
  this._rows = vals.map(function (r, i) {
    const o = {};
    cols.forEach(function (c, j) { let v = r[j]; o[c] = v === '' ? null : NUMERIC.indexOf(c) >= 0 ? Number(v) : v; });
    Object.defineProperty(o, '_row', { value: i + 2, enumerable: false, writable: true });
    return o;
  });
  return this._rows;
};
Table.prototype.all = function (fn) { return fn ? this.rows().filter(fn) : this.rows().slice(); };
Table.prototype.find = function (fn) { return this.rows().find(fn) || null; };
Table.prototype.get = function (id, key) { key = key || 'id'; return this.find(function (r) { return r[key] === id; }); };
Table.prototype.insert = function (obj) {
  if (this.cols.indexOf('id') >= 0 && obj.id == null) obj.id = nextSeq(this.name);
  if (this.cols.indexOf('created_at') >= 0 && !obj.created_at) obj.created_at = nowIso();
  this.insertMany([obj]);
  return obj;
};
Table.prototype.insertMany = function (list) {
  if (!list.length) return;
  const self = this, rows = this.rows();
  list.forEach(function (o) {
    if (self.cols.indexOf('id') >= 0 && o.id == null) o.id = nextSeq(self.name);
    if (self.cols.indexOf('created_at') >= 0 && !o.created_at) o.created_at = nowIso();
  });
  const start = this.sh.getLastRow() + 1;
  const need = start + list.length - 1 - this.sh.getMaxRows();
  if (need > 0) this.sh.insertRowsAfter(this.sh.getMaxRows(), need + 100);
  this.sh.getRange(start, 1, list.length, this.cols.length).setNumberFormat('@')
    .setValues(list.map(function (o) { return self.cols.map(function (c) { return toCell(o[c]); }); }));
  list.forEach(function (o, i) {
    const clean = {};
    self.cols.forEach(function (c) { clean[c] = o[c] == null || o[c] === '' ? null : NUMERIC.indexOf(c) >= 0 ? Number(o[c]) : o[c] === true ? '1' : o[c] === false ? '0' : String(o[c]); });
    Object.defineProperty(clean, '_row', { value: start + i, enumerable: false, writable: true });
    rows.push(clean);
  });
};
Table.prototype.update = function (row, patch) {
  const self = this;
  Object.keys(patch).forEach(function (k) {
    const v = patch[k];
    row[k] = v == null || v === '' ? null : NUMERIC.indexOf(k) >= 0 ? Number(v) : v === true ? '1' : v === false ? '0' : String(v);
  });
  this.sh.getRange(row._row, 1, 1, this.cols.length).setNumberFormat('@').setValues([this.cols.map(function (c) { return toCell(row[c]); })]);
  return row;
};
Table.prototype.remove = function (fn) {
  const rows = this.rows(), keep = rows.filter(function (r) { return !fn(r); }), n = rows.length - keep.length;
  if (!n) return 0;
  const self = this;
  if (n <= 3) {
    rows.filter(fn).sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { self.sh.deleteRow(r._row); });
  } else {
    this.sh.getRange(2, 1, rows.length, this.cols.length).clearContent();
    if (keep.length) this.sh.getRange(2, 1, keep.length, this.cols.length).setNumberFormat('@')
      .setValues(keep.map(function (o) { return self.cols.map(function (c) { return toCell(o[c]); }); }));
  }
  this._rows = null;
  return n;
};
function T(name) { return _tables[name] || (_tables[name] = new Table(name)); }
function nextSeq(name) {
  const p = PropertiesService.getScriptProperties(), k = 'seq_' + name;
  let n = Number(p.getProperty(k) || 0);
  if (!n) n = T(name).rows().reduce(function (m, r) { return Math.max(m, r.id || 0); }, 0);
  n += 1; p.setProperty(k, String(n));
  return n;
}

// ============================================================ settings
function getSettings(keys) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  T('settings').rows().forEach(function (r) { if (r.key) out[r.key] = r.value == null ? '' : r.value; });
  const props = PropertiesService.getScriptProperties();
  SECRET_KEYS.forEach(function (k) { out[k] = props.getProperty(k) || ''; });
  if (keys) { const o = {}; keys.forEach(function (k) { o[k] = out[k] == null ? '' : out[k]; }); return o; }
  return out;
}
function setSettings(obj) {
  const props = PropertiesService.getScriptProperties(), t = T('settings');
  Object.keys(obj).forEach(function (k) {
    const v = obj[k] == null ? '' : String(obj[k]);
    if (SECRET_KEYS.indexOf(k) >= 0) {
      if (v === '••••••') return;
      if (v) props.setProperty(k, v); else props.deleteProperty(k);
      return;
    }
    const row = t.get(k, 'key');
    if (row) t.update(row, { value: v }); else t.insert({ key: k, value: v });
  });
  bustSiteCache();
}

// ============================================================ caching
function bustSiteCache() { CacheService.getScriptCache().removeAll(['site', 'events_up', 'events_past']); }
function cached(key, seconds, fn) {
  const c = CacheService.getScriptCache(), hit = c.get(key);
  if (hit) return JSON.parse(hit);
  const val = fn();
  try { c.put(key, JSON.stringify(val), seconds); } catch (e) { /* too large to cache: fine */ }
  return val;
}

// ============================================================ sessions & auth
function createSession(userId) {
  const token = randomToken();
  T('sessions').insert({ token: token, user_id: userId, expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
  return token;
}
function userFromToken(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const s = T('sessions').get(token, 'token');
  if (!s || s.expires_at < nowIso()) return null;
  const u = T('users').get(s.user_id);
  if (!u || u.status === 'disabled') return null;
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.status, token: token };
}
function requireRole(user, roles) {
  if (!user) throw new HttpError(401, 'Please sign in');
  if (roles.indexOf(user.role) < 0) throw new HttpError(403, 'You do not have access to this');
  return user;
}
function issueReset(userId) {
  const token = randomToken();
  T('resets').insert({ token: token, user_id: userId, expires_at: new Date(Date.now() + 864e5).toISOString() });
  return token;
}

// ============================================================ HTTP entry points
function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out({ ok: false, status: 400, error: 'Invalid request' }); }
  const method = String(req.method || 'GET').toUpperCase();
  const lock = method === 'GET' ? null : LockService.getScriptLock();
  try {
    if (lock) lock.waitLock(25000);
    const res = route(method, String(req.path || ''), req.body || {}, req.token, req.query || {});
    return out(Object.assign({ ok: true, status: 200 }, { data: res }));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err && err.stack || err);
    const msg = (err && err.message) || String(err);
    return out({ ok: false, status: status, error: status === 500 ? 'Server error: ' + msg : msg });
  } finally {
    if (lock) try { lock.releaseLock(); } catch (x) { /* ignore */ }
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'sitemap') return ContentService.createTextOutput(sitemapXml()).setMimeType(ContentService.MimeType.XML);
    if (p.action === 'export') return out({ ok: true, data: exportForBuild() });
    if (p.action === 'health') return out({ ok: true, data: health() });
    if (p.path) return doPost({ postData: { contents: JSON.stringify({ path: p.path, method: 'GET', token: p.token }) } });
    return out({ ok: true, service: 'Superwings Foundation API', time: nowIso() });
  } catch (err) {
    return out({ ok: false, error: err.message || String(err) });
  }
}

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

// ============================================================ router
const ROUTES = [];
function on(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, function (_, k) { keys.push(k); return '([^/]+)'; }) + '/?$');
  ROUTES.push({ method: method, re: re, keys: keys, handler: handler });
}
function route(method, path, body, token, query) {
  const clean = path.split('?')[0];
  const qs = {};
  (path.split('?')[1] || '').split('&').forEach(function (kv) { if (kv) { const p = kv.split('='); qs[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); } });
  Object.assign(qs, query);
  for (let i = 0; i < ROUTES.length; i++) {
    const r = ROUTES[i];
    if (r.method !== method) continue;
    const m = clean.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach(function (k, j) { params[k] = decodeURIComponent(m[j + 1]); });
    return r.handler({ body: body, params: params, query: qs, user: userFromToken(token), site: siteUrl() });
  }
  throw new HttpError(404, 'Not found');
}
function siteUrl() { return String(getSettings(['site_url']).site_url || DEFAULT_SETTINGS.site_url).replace(/\/$/, ''); }

// ============================================================ PUBLIC
on('GET', '/api/site', function () {
  return cached('site', 300, function () {
    const people = T('people').all(function (p) { return p.visible !== 0; }).sort(bySort);
    const pick = function (p) { return { id: p.id, kind: p.kind, name: p.name, title: p.title, photo_id: p.photo_id, message: p.message, bio: p.bio }; };
    return {
      settings: getSettings(PUBLIC_KEYS),
      trustees: people.filter(function (p) { return p.kind === 'trustee'; }).map(pick),
      coordinators: people.filter(function (p) { return p.kind === 'coordinator'; }).map(pick),
      partners: T('partners').all(function (p) { return p.status === 'approved'; }).sort(function (a, b) { return a.name.localeCompare(b.name); })
        .map(function (p) { return { id: p.id, name: p.name, type: p.type, logo_id: p.logo_id }; }),
      events: publicEvents(false).slice(0, 6),
      programmes: PROGRAMMES,
    };
  });
});
function bySort(a, b) { return (a.sort || 0) - (b.sort || 0) || a.id - b.id; }
function eventCard(e) { return { slug: e.slug, title: e.title, subtitle: e.subtitle, cover_id: e.cover_id, venue: e.venue, start_at: e.start_at, end_at: e.end_at }; }
function publicEvents(past) {
  const now = nowIso();
  return T('events').all(function (e) { return e.status === 'published' && (past ? e.end_at < now : e.end_at >= now); })
    .sort(function (a, b) { return past ? b.start_at.localeCompare(a.start_at) : a.start_at.localeCompare(b.start_at); })
    .slice(0, 50).map(eventCard);
}
on('GET', '/api/events', function (c) {
  const past = c.query.past === '1';
  return { events: cached(past ? 'events_past' : 'events_up', 120, function () { return publicEvents(past); }) };
});
function loadEvent(slug, publishedOnly) {
  const ev = T('events').find(function (e) { return e.slug === slug && (!publishedOnly || e.status === 'published'); });
  if (!ev) throw new HttpError(404, 'Event not found');
  return ev;
}
function agendaFor(id) {
  return T('agenda').all(function (a) { return a.event_id === id; }).sort(bySort)
    .map(function (a) { return { start_time: a.start_time, end_time: a.end_time, title: a.title, speaker: a.speaker, description: a.description }; });
}
function regCount(id) { return T('registrations').all(function (r) { return r.event_id === id; }).length; }
on('GET', '/api/events/:slug', function (c) {
  const ev = Object.assign({}, loadEvent(c.params.slug, true));
  const n = regCount(ev.id), ended = ev.end_at < nowIso(), full = ev.capacity ? n >= ev.capacity : false;
  delete ev.sender_id;
  ev.seats_left = ev.capacity ? Math.max(0, ev.capacity - n) : null;
  ev.can_register = !!ev.reg_open && !ended && !full; ev.ended = ended; ev.full = full;
  return { event: ev, agenda: agendaFor(ev.id) };
});

on('POST', '/api/events/:slug/register', function (c) {
  const b = c.body;
  if (str(b.website)) return { ok: true, code: 'OK' };
  const ev = loadEvent(c.params.slug, true);
  if (!ev.reg_open) bad('Registration for this event is closed');
  if (ev.end_at < nowIso()) bad('This event has already taken place');
  if (!b.consent) bad('Please accept the data notice to register');
  const reg = { event_id: ev.id, name: reqStr(b.name, 'Name', 120), email: email(b.email), phone: optStr(b.phone, 30),
    organisation: optStr(b.organisation, 160), notes: optStr(b.notes, 1000), code: randomCode(8), confirm_sent: 0, reminder_sent: 0, followup_sent: 0 };
  if (ev.capacity && regCount(ev.id) >= ev.capacity) bad('Sorry, this event is full');
  if (T('registrations').find(function (r) { return r.event_id === ev.id && r.email === reg.email; }))
    bad('This email is already registered for the event. Check your inbox for the confirmation.');
  const row = T('registrations').insert(reg);
  const t = TPL.registration(ctx(), ev, reg);
  if (sendEmail({ to: reg.email, toName: reg.name, subject: t.subject, html: t.html, kind: 'event_confirmation', senderId: ev.sender_id }).ok)
    T('registrations').update(T('registrations').get(row.id), { confirm_sent: 1 });
  return { ok: true, code: reg.code };
});

on('POST', '/api/partners', function (c) {
  const b = c.body;
  if (str(b.website)) return { ok: true };
  const pt = {
    name: reqStr(b.name, 'Institution name', 200), type: oneOf(b.type || 'university', ['university', 'school', 'organisation'], 'Type'),
    contact_name: reqStr(b.contact_name, 'Contact person', 120), email: email(b.email), phone: optStr(b.phone, 30),
    programme: optStr(b.programme, 200), students: num(b.students, 'Expected students', { min: 0, max: 100000, optional: true }),
    message: optStr(b.message, 2000), status: 'pending',
  };
  T('partners').insert(pt);
  const t = TPL.partnerReceived(ctx(), pt);
  sendEmail({ to: pt.email, toName: pt.contact_name, subject: t.subject, html: t.html, kind: 'partner_received' });
  return { ok: true };
});

on('POST', '/api/volunteer/signup', function (c) {
  const b = c.body;
  if (str(b.website)) return { ok: true };
  const programme = oneOf(b.programme, Object.keys(PROGRAMMES), 'Programme');
  const u = { name: reqStr(b.name, 'Name', 120), email: email(b.email), phone: optStr(b.phone, 30) };
  checkPassword(b.password);
  if (!b.is_adult && !b.guardian_consent) bad("Volunteers under 18 need a parent or guardian's consent");
  let partner_id = null;
  if (b.partner_id) { const p = T('partners').get(Number(b.partner_id)); if (p && p.status === 'approved') partner_id = p.id; }
  if (T('users').get(u.email, 'email')) bad('An account with this email already exists. Please sign in instead.');
  const user = T('users').insert({ email: u.email, name: u.name, phone: u.phone, role: 'student', password_hash: hashPassword(b.password), status: 'active' });
  T('volunteers').insert({ user_id: user.id, programme: programme, institution: optStr(b.institution, 200), partner_id: partner_id, grade: optStr(b.grade, 60),
    supervisor_name: optStr(b.supervisor_name, 120), supervisor_email: optEmail(b.supervisor_email, 'Supervisor email'), interests: optStr(b.interests, 1000),
    availability: optStr(b.availability, 500), guardian_consent: b.guardian_consent ? 1 : 0, status: 'pending' });
  const t = TPL.volunteerReceived(ctx(), u, PROGRAMMES[programme]);
  sendEmail({ to: u.email, toName: u.name, subject: t.subject, html: t.html, kind: 'volunteer_received' });
  return { ok: true, token: createSession(user.id), role: 'student' };
});

on('POST', '/api/donations', function (c) {
  const b = c.body;
  if (str(b.website)) return { ok: true };
  const pan = (optStr(b.pan, 10) || '').toUpperCase() || null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) bad('PAN format looks incorrect (e.g. ABCDE1234F)');
  const d = { name: reqStr(b.name, 'Name', 120), email: email(b.email), phone: optStr(b.phone, 30), pan: pan, address: optStr(b.address, 400),
    amount: num(b.amount, 'Amount', { min: 1, max: 100000000 }), mode: oneOf(b.mode || 'UPI', ['UPI', 'Bank transfer', 'Cheque', 'Cash'], 'Mode'),
    txn_ref: optStr(b.txn_ref, 120), purpose: optStr(b.purpose, 120), message: optStr(b.message, 1000), status: 'pledged' };
  T('donations').insert(d);
  const t = TPL.donationPledged(ctx(), d);
  sendEmail({ to: d.email, toName: d.name, subject: t.subject, html: t.html, kind: 'donation_pledged' });
  return { ok: true };
});

// ============================================================ AUTH
on('GET', '/api/auth/status', function (c) {
  return { setupNeeded: T('users').rows().length === 0, user: c.user ? { id: c.user.id, name: c.user.name, email: c.user.email, role: c.user.role } : null };
});
on('POST', '/api/auth/setup', function (c) {
  const b = c.body;
  if (T('users').rows().length) bad('Setup has already been completed');
  const tok = PropertiesService.getScriptProperties().getProperty('SETUP_TOKEN');
  if (!tok || b.token !== tok) throw new HttpError(403, 'Setup token is incorrect');
  checkPassword(b.password);
  const u = T('users').insert({ email: email(b.email), name: reqStr(b.name, 'Name', 120), role: 'admin', password_hash: hashPassword(b.password), status: 'active' });
  return { ok: true, token: createSession(u.id), role: 'admin' };
});
on('POST', '/api/auth/login', function (c) {
  const row = T('users').get(str(c.body.email, 254).toLowerCase(), 'email');
  if (!row || !verifyPassword(String(c.body.password || ''), row.password_hash)) throw new HttpError(401, 'Email or password is incorrect');
  if (row.status === 'disabled') throw new HttpError(403, 'This account has been disabled');
  return { ok: true, token: createSession(row.id), role: row.role };
});
on('POST', '/api/auth/logout', function (c) {
  if (c.user) T('sessions').remove(function (s) { return s.token === c.user.token; });
  return { ok: true };
});
on('POST', '/api/auth/forgot', function (c) {
  const row = T('users').get(str(c.body.email, 254).toLowerCase(), 'email');
  if (row && row.status !== 'disabled') {
    const t = TPL.passwordReset(ctx(), row, c.site + '/portal/?reset=' + issueReset(row.id));
    sendEmail({ to: row.email, toName: row.name, subject: t.subject, html: t.html, kind: 'password_reset' });
  }
  return { ok: true };
});
on('POST', '/api/auth/reset', function (c) {
  checkPassword(c.body.password);
  const r = T('resets').get(str(c.body.token, 100), 'token');
  if (!r || r.expires_at < nowIso()) bad('This link has expired. Please request a new one.');
  T('users').update(T('users').get(r.user_id), { password_hash: hashPassword(c.body.password) });
  T('resets').remove(function (x) { return x.user_id === r.user_id; });
  T('sessions').remove(function (x) { return x.user_id === r.user_id; });
  return { ok: true, token: createSession(r.user_id) };
});
on('POST', '/api/me/password', function (c) {
  requireRole(c.user, ANYONE);
  const row = T('users').get(c.user.id);
  if (!verifyPassword(String(c.body.current || ''), row.password_hash)) bad('Current password is incorrect');
  checkPassword(c.body.password);
  T('users').update(row, { password_hash: hashPassword(c.body.password) });
  T('sessions').remove(function (s) { return s.user_id === c.user.id && s.token !== c.user.token; });
  return { ok: true };
});

// ============================================================ STUDENT
function volunteerRecord(uid) {
  const v = T('volunteers').get(uid, 'user_id');
  if (!v) throw new HttpError(404, 'Volunteer profile not found');
  const u = T('users').get(uid), p = v.partner_id ? T('partners').get(v.partner_id) : null;
  const profile = Object.assign({}, v, { name: u.name, email: u.email, phone: u.phone, partner_name: p ? p.name : null, programme_label: PROGRAMMES[v.programme] });
  const acts = T('activities').all(function (a) { return a.user_id === uid; })
    .sort(function (a, b) { return b.date.localeCompare(a.date) || b.id - a.id; });
  const sum = function (st) { return acts.filter(function (a) { return a.status === st; }).reduce(function (t, a) { return t + Number(a.hours); }, 0); };
  return { profile: profile, activities: acts, totals: { approved: sum('approved'), pending: sum('pending'), count: acts.length } };
}
on('GET', '/api/me', function (c) {
  requireRole(c.user, ANYONE);
  const me = { id: c.user.id, name: c.user.name, email: c.user.email, phone: c.user.phone, role: c.user.role, role_label: ROLE_LABEL[c.user.role] };
  if (c.user.role !== 'student') return { user: me };
  return Object.assign({ user: me }, volunteerRecord(c.user.id));
});
on('PUT', '/api/me/profile', function (c) {
  requireRole(c.user, ['student']);
  const b = c.body;
  T('users').update(T('users').get(c.user.id), { name: reqStr(b.name, 'Name', 120), phone: optStr(b.phone, 30) });
  T('volunteers').update(T('volunteers').get(c.user.id, 'user_id'), { institution: optStr(b.institution, 200), grade: optStr(b.grade, 60),
    supervisor_name: optStr(b.supervisor_name, 120), supervisor_email: optEmail(b.supervisor_email, 'Supervisor email'),
    interests: optStr(b.interests, 1000), availability: optStr(b.availability, 500) });
  return { ok: true };
});
function activityInput(b) {
  const date = str(b.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Date is required');
  if (date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) bad('Date cannot be in the future');
  const strands = (Array.isArray(b.strands) ? b.strands : []).filter(function (x) { return ['creativity', 'activity', 'service'].indexOf(x) >= 0; });
  const outcomes = (Array.isArray(b.outcomes) ? b.outcomes : []).filter(function (x) { return /^LO[1-7]$/.test(x); });
  return { date: date, hours: num(b.hours, 'Hours', { min: 0.25, max: 24 }), title: reqStr(b.title, 'Activity title', 160),
    description: optStr(b.description, 3000), strands: strands.join(',') || null, outcomes: outcomes.join(',') || null, reflection: optStr(b.reflection, 6000) };
}
on('POST', '/api/me/activities', function (c) {
  requireRole(c.user, ['student']);
  const v = T('volunteers').get(c.user.id, 'user_id');
  if (!v || v.status !== 'approved') bad('You can log activities once a coordinator approves your application');
  T('activities').insert(Object.assign(activityInput(c.body), { user_id: c.user.id, status: 'pending' }));
  return { ok: true };
});
on('PUT', '/api/me/activities/:id', function (c) {
  requireRole(c.user, ['student']);
  const row = T('activities').find(function (a) { return a.id === Number(c.params.id) && a.user_id === c.user.id; });
  if (!row) throw new HttpError(404, 'Activity not found');
  if (row.status === 'approved') bad('Verified activities cannot be edited');
  T('activities').update(row, Object.assign(activityInput(c.body), { status: 'pending', review_note: null }));
  return { ok: true };
});
on('DELETE', '/api/me/activities/:id', function (c) {
  requireRole(c.user, ['student']);
  const n = T('activities').remove(function (a) { return a.id === Number(c.params.id) && a.user_id === c.user.id && a.status !== 'approved'; });
  if (!n) bad('Only unverified activities can be deleted');
  return { ok: true };
});
on('GET', '/api/certificate/:uid', function (c) {
  requireRole(c.user, ANYONE);
  const uid = Number(c.params.uid);
  if (c.user.role === 'student' && uid !== c.user.id) throw new HttpError(403, 'Not allowed');
  const rec = volunteerRecord(uid);
  rec.activities = rec.activities.filter(function (a) { return a.status === 'approved'; });
  rec.settings = getSettings(PUBLIC_KEYS);
  rec.signatories = T('people').all(function (p) { return p.visible !== 0; })
    .sort(function (a, b) { return (a.kind === 'coordinator' ? 0 : 1) - (b.kind === 'coordinator' ? 0 : 1) || bySort(a, b); })
    .slice(0, 2).map(function (p) { return { name: p.name, title: p.title }; });
  rec.issued = fmtDate(nowIso());
  return rec;
});

// ============================================================ STAFF
on('POST', '/api/admin/media', function (c) {
  requireRole(c.user, STAFF);
  const mime = oneOf(c.body.mime, ['image/jpeg', 'image/png', 'image/webp'], 'Image type');
  const data = String(c.body.data || '').replace(/^data:[^,]+,/, '');
  if (!data || data.length > 4000000) bad('Image is missing or too large');
  const blob = Utilities.newBlob(Utilities.base64Decode(data), mime, 'sw-' + Date.now() + '.' + mime.split('/')[1]);
  const file = mediaFolder().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: file.getId(), url: mediaUrl(file.getId()) };
});
function mediaUrl(id) { return 'https://lh3.googleusercontent.com/d/' + id; }
function mediaFolder() {
  const p = PropertiesService.getScriptProperties(), id = p.getProperty('MEDIA_FOLDER_ID');
  if (id) try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ }
  const f = DriveApp.createFolder('Superwings Website Images');
  p.setProperty('MEDIA_FOLDER_ID', f.getId());
  return f;
}

on('GET', '/api/admin/dashboard', function (c) {
  requireRole(c.user, STAFF);
  const now = nowIso(), weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const count = function (t, fn) { return T(t).all(fn).length; };
  const s = getSettings();
  return {
    upcoming_events: count('events', function (e) { return e.status === 'published' && e.end_at >= now; }),
    registrations: T('registrations').rows().length,
    pending_volunteers: count('volunteers', function (v) { return v.status === 'pending'; }),
    pending_activities: count('activities', function (a) { return a.status === 'pending'; }),
    pending_partners: count('partners', function (p) { return p.status === 'pending'; }),
    pending_donations: count('donations', function (d) { return d.status === 'pledged'; }),
    failed_emails_7d: count('email_log', function (l) { return l.status === 'failed' && l.created_at >= weekAgo; }),
    verified_hours: T('activities').all(function (a) { return a.status === 'approved'; }).reduce(function (t, a) { return t + a.hours; }, 0),
    active_volunteers: count('volunteers', function (v) { return v.status === 'approved'; }),
    email_ready: { zeptomail: !!s.zepto_token, zoho_mail: !!(s.zoho_refresh_token && s.zoho_account_id) },
    user: { name: c.user.name, role: c.user.role, role_label: ROLE_LABEL[c.user.role] },
  };
});

// ---- events
function eventInput(b) {
  const start_at = isoDateTime(b.start_at, 'Start'), end_at = isoDateTime(b.end_at, 'End');
  if (end_at <= start_at) bad('End must be after start');
  return { title: reqStr(b.title, 'Title', 200), slug: slugify(b.slug || b.title) || randomCode(6).toLowerCase(),
    subtitle: optStr(b.subtitle, 300), description: optStr(b.description, 20000), cover_id: optStr(b.cover_id, 100),
    venue: optStr(b.venue, 200), address: optStr(b.address, 400), map_url: optStr(b.map_url, 500), start_at: start_at, end_at: end_at,
    capacity: num(b.capacity, 'Capacity', { min: 1, max: 100000, optional: true }), reg_open: b.reg_open ? 1 : 0,
    status: oneOf(b.status || 'draft', ['draft', 'published'], 'Status'), sender_id: b.sender_id ? Number(b.sender_id) : null, updated_at: nowIso() };
}
function saveAgenda(eventId, items) {
  T('agenda').remove(function (a) { return a.event_id === eventId; });
  T('agenda').insertMany((Array.isArray(items) ? items : []).slice(0, 100).filter(function (a) { return str(a.title); }).map(function (a, i) {
    return { event_id: eventId, start_time: optStr(a.start_time, 10), end_time: optStr(a.end_time, 10), title: str(a.title, 200),
      speaker: optStr(a.speaker, 200), description: optStr(a.description, 2000), sort: i };
  }));
}
on('GET', '/api/admin/events', function (c) {
  requireRole(c.user, STAFF);
  const regs = T('registrations').rows();
  return { events: T('events').all().sort(function (a, b) { return b.start_at.localeCompare(a.start_at); }).map(function (e) {
    return { id: e.id, slug: e.slug, title: e.title, status: e.status, start_at: e.start_at, end_at: e.end_at, capacity: e.capacity, reg_open: e.reg_open,
      registrations: regs.filter(function (r) { return r.event_id === e.id; }).length };
  }) };
});
on('GET', '/api/admin/events/:id', function (c) {
  requireRole(c.user, STAFF);
  const ev = T('events').get(Number(c.params.id));
  if (!ev) throw new HttpError(404, 'Event not found');
  return { event: ev, agenda: T('agenda').all(function (a) { return a.event_id === ev.id; }).sort(bySort) };
});
on('POST', '/api/admin/events', function (c) {
  requireRole(c.user, STAFF);
  const e = eventInput(c.body);
  if (T('events').get(e.slug, 'slug')) e.slug += '-' + randomCode(4).toLowerCase();
  const row = T('events').insert(e);
  saveAgenda(row.id, c.body.agenda);
  bustSiteCache(); requestRebuild();
  return { ok: true, id: row.id, slug: e.slug };
});
on('PUT', '/api/admin/events/:id', function (c) {
  requireRole(c.user, STAFF);
  const id = Number(c.params.id), row = T('events').get(id);
  if (!row) throw new HttpError(404, 'Event not found');
  const e = eventInput(c.body);
  if (T('events').find(function (x) { return x.slug === e.slug && x.id !== id; })) bad('Another event already uses this web address (slug)');
  T('events').update(row, e);
  saveAgenda(id, c.body.agenda);
  bustSiteCache(); requestRebuild();
  return { ok: true, slug: e.slug };
});
on('DELETE', '/api/admin/events/:id', function (c) {
  requireRole(c.user, LEADERS);
  const id = Number(c.params.id);
  T('agenda').remove(function (a) { return a.event_id === id; });
  T('registrations').remove(function (r) { return r.event_id === id; });
  T('events').remove(function (e) { return e.id === id; });
  bustSiteCache(); requestRebuild();
  return { ok: true };
});
on('GET', '/api/admin/events/:id/registrations', function (c) {
  requireRole(c.user, STAFF);
  const rows = T('registrations').all(function (r) { return r.event_id === Number(c.params.id); });
  if (c.query.format === 'csv') {
    const cols = ['code', 'name', 'email', 'phone', 'organisation', 'notes', 'created_at'];
    const q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    return { csv: [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (k) { return q(r[k]); }).join(','); })).join('\r\n') };
  }
  return { registrations: rows };
});
on('DELETE', '/api/admin/registrations/:id', function (c) {
  requireRole(c.user, STAFF);
  T('registrations').remove(function (r) { return r.id === Number(c.params.id); });
  return { ok: true };
});
on('POST', '/api/admin/events/:id/email', function (c) {
  requireRole(c.user, STAFF);
  const ev = T('events').get(Number(c.params.id));
  if (!ev) throw new HttpError(404, 'Event not found');
  const subject = reqStr(c.body.subject, 'Subject', 200), body = reqStr(c.body.body, 'Message', 20000);
  const regs = T('registrations').all(function (r) { return r.event_id === ev.id; });
  if (!regs.length) bad('No one has registered for this event yet');
  const cx = ctx();
  enqueue(regs.map(function (r) {
    return { to: r.email, toName: r.name, subject: subject, kind: 'event_broadcast', senderId: c.body.sender_id || ev.sender_id,
      html: TPL.custom(cx, str(c.body.title) || subject, 'Dear ' + r.name + ',\n\n' + body, { label: 'View event', url: c.site + '/events/' + ev.slug + '/' }) };
  }));
  const d = drainOutbox(20);
  return { ok: true, queued: regs.length, sent_now: d.sent };
});

// ---- volunteers & activities
on('GET', '/api/admin/volunteers', function (c) {
  requireRole(c.user, STAFF);
  const st = c.query.status, acts = T('activities').rows();
  return { volunteers: T('volunteers').all(function (v) { return !st || v.status === st; })
    .sort(function (a, b) { return b.created_at.localeCompare(a.created_at); })
    .map(function (v) {
      const u = T('users').get(v.user_id) || {}, p = v.partner_id ? T('partners').get(v.partner_id) : null;
      return Object.assign({}, v, { name: u.name, email: u.email, phone: u.phone, partner_name: p ? p.name : null, programme_label: PROGRAMMES[v.programme],
        hours: acts.filter(function (a) { return a.user_id === v.user_id && a.status === 'approved'; }).reduce(function (t, a) { return t + a.hours; }, 0) });
    }) };
});
on('GET', '/api/admin/volunteers/:uid', function (c) { requireRole(c.user, STAFF); return volunteerRecord(Number(c.params.uid)); });
on('PUT', '/api/admin/volunteers/:uid', function (c) {
  requireRole(c.user, STAFF);
  const status = oneOf(c.body.status, ['pending', 'approved', 'rejected'], 'Status');
  const v = T('volunteers').get(Number(c.params.uid), 'user_id');
  if (!v) throw new HttpError(404, 'Volunteer not found');
  const before = v.status, u = T('users').get(v.user_id);
  T('volunteers').update(v, { status: status });
  if (before !== status && status !== 'pending' && c.body.notify !== false) {
    const t = TPL.volunteerDecision(ctx(), u, status === 'approved', optStr(c.body.note, 2000));
    sendEmail({ to: u.email, toName: u.name, subject: t.subject, html: t.html, kind: 'volunteer_decision' });
  }
  return { ok: true };
});
on('GET', '/api/admin/activities', function (c) {
  requireRole(c.user, STAFF);
  const st = c.query.status || 'pending';
  return { activities: T('activities').all(function (a) { return a.status === st; }).sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 300)
    .map(function (a) {
      const u = T('users').get(a.user_id) || {}, v = T('volunteers').get(a.user_id, 'user_id') || {};
      return Object.assign({}, a, { name: u.name, email: u.email, programme: v.programme, programme_label: PROGRAMMES[v.programme] });
    }) };
});
on('PUT', '/api/admin/activities/:id', function (c) {
  requireRole(c.user, STAFF);
  const status = oneOf(c.body.status, ['approved', 'rejected', 'pending'], 'Status');
  const a = T('activities').get(Number(c.params.id));
  if (!a) throw new HttpError(404, 'Activity not found');
  T('activities').update(a, { status: status, review_note: optStr(c.body.review_note, 2000), reviewer_id: c.user.id });
  if (status !== 'pending') {
    const u = T('users').get(a.user_id), t = TPL.activityReviewed(ctx(), u, a);
    sendEmail({ to: u.email, toName: u.name, subject: t.subject, html: t.html, kind: 'activity_reviewed' });
  }
  return { ok: true };
});

// ---- partners
on('GET', '/api/admin/partners', function (c) {
  requireRole(c.user, STAFF);
  const vols = T('volunteers').rows();
  return { partners: T('partners').all().sort(function (a, b) { return (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created_at.localeCompare(a.created_at); })
    .map(function (p) { return Object.assign({}, p, { students_joined: vols.filter(function (v) { return v.partner_id === p.id; }).length }); }) };
});
on('PUT', '/api/admin/partners/:id', function (c) {
  requireRole(c.user, STAFF);
  const b = c.body, p = T('partners').get(Number(c.params.id));
  if (!p) throw new HttpError(404, 'Partner not found');
  const before = Object.assign({}, p), status = oneOf(b.status || p.status, ['pending', 'approved', 'rejected'], 'Status');
  T('partners').update(p, { name: reqStr(b.name != null ? b.name : p.name, 'Name', 200), type: oneOf(b.type || p.type, ['university', 'school', 'organisation'], 'Type'),
    contact_name: optStr(b.contact_name != null ? b.contact_name : p.contact_name, 120), email: optEmail(b.email != null ? b.email : p.email, 'Email'),
    phone: optStr(b.phone != null ? b.phone : p.phone, 30), programme: optStr(b.programme != null ? b.programme : p.programme, 200),
    logo_id: optStr(b.logo_id != null ? b.logo_id : p.logo_id, 100), status: status });
  if (before.status !== status && status !== 'pending' && before.email && b.notify !== false) {
    const t = TPL.partnerDecision(ctx(), before, status === 'approved');
    sendEmail({ to: before.email, toName: before.contact_name, subject: t.subject, html: t.html, kind: 'partner_decision' });
  }
  bustSiteCache();
  return { ok: true };
});
on('DELETE', '/api/admin/partners/:id', function (c) {
  requireRole(c.user, LEADERS);
  const id = Number(c.params.id);
  T('volunteers').all(function (v) { return v.partner_id === id; }).forEach(function (v) { T('volunteers').update(v, { partner_id: null }); });
  T('partners').remove(function (p) { return p.id === id; });
  bustSiteCache();
  return { ok: true };
});

// ---- people
function personInput(b) {
  return { kind: oneOf(b.kind, ['trustee', 'coordinator'], 'Type'), name: reqStr(b.name, 'Name', 120), title: optStr(b.title, 160),
    photo_id: optStr(b.photo_id, 100), message: optStr(b.message, 4000), bio: optStr(b.bio, 2000), email: optEmail(b.email, 'Email'),
    sort: num(b.sort == null || b.sort === '' ? 0 : b.sort, 'Order', { min: -1000, max: 1000 }), visible: b.visible === false || b.visible === 0 ? 0 : 1 };
}
on('GET', '/api/admin/people', function (c) {
  requireRole(c.user, STAFF);
  return { people: T('people').all().sort(function (a, b) { return b.kind.localeCompare(a.kind) || bySort(a, b); }) };
});
on('POST', '/api/admin/people', function (c) { requireRole(c.user, LEADERS); T('people').insert(personInput(c.body)); bustSiteCache(); return { ok: true }; });
on('PUT', '/api/admin/people/:id', function (c) {
  requireRole(c.user, LEADERS);
  const p = T('people').get(Number(c.params.id));
  if (!p) throw new HttpError(404, 'Not found');
  T('people').update(p, personInput(c.body)); bustSiteCache();
  return { ok: true };
});
on('DELETE', '/api/admin/people/:id', function (c) {
  requireRole(c.user, LEADERS);
  T('people').remove(function (p) { return p.id === Number(c.params.id); }); bustSiteCache();
  return { ok: true };
});

// ---- donations
function nextReceiptNo(receivedIso) {
  const d = new Date(new Date(receivedIso).getTime() + 5.5 * 3600e3);
  const y = d.getUTCFullYear(), fy = d.getUTCMonth() >= 3 ? y : y - 1;
  const prefix = 'SWF/' + fy + '-' + String(fy + 1).slice(2) + '/';
  const max = T('donations').all(function (x) { return x.receipt_no && x.receipt_no.indexOf(prefix) === 0; })
    .reduce(function (m, x) { return Math.max(m, Number(x.receipt_no.split('/').pop())); }, 0);
  return prefix + ('000' + (max + 1)).slice(-4);
}
on('GET', '/api/admin/donations', function (c) {
  requireRole(c.user, LEADERS);
  return { donations: T('donations').all().sort(function (a, b) { return (a.status === 'pledged' ? 0 : 1) - (b.status === 'pledged' ? 0 : 1) || b.created_at.localeCompare(a.created_at); }).slice(0, 500) };
});
on('POST', '/api/admin/donations', function (c) {
  requireRole(c.user, LEADERS);
  const b = c.body;
  T('donations').insert({ name: reqStr(b.name, 'Name', 120), email: email(b.email), phone: optStr(b.phone, 30), pan: (optStr(b.pan, 10) || '').toUpperCase() || null,
    address: optStr(b.address, 400), amount: num(b.amount, 'Amount', { min: 1, max: 1e8 }), mode: optStr(b.mode, 40) || 'Bank transfer',
    txn_ref: optStr(b.txn_ref, 120), purpose: optStr(b.purpose, 120), message: optStr(b.message, 1000), status: 'pledged' });
  return { ok: true };
});
on('PUT', '/api/admin/donations/:id', function (c) {
  requireRole(c.user, LEADERS);
  const b = c.body, d = T('donations').get(Number(c.params.id));
  if (!d) throw new HttpError(404, 'Donation not found');
  const hadReceipt = !!d.receipt_no, status = oneOf(b.status || d.status, ['pledged', 'received', 'cancelled'], 'Status');
  let receipt_no = d.receipt_no, received_at = d.received_at;
  if (status === 'received' && !receipt_no) { received_at = b.received_at ? isoDateTime(b.received_at, 'Received date') : nowIso(); receipt_no = nextReceiptNo(received_at); }
  T('donations').update(d, { status: status, txn_ref: optStr(b.txn_ref != null ? b.txn_ref : d.txn_ref, 120),
    pan: (optStr(b.pan != null ? b.pan : d.pan, 10) || '').toUpperCase() || null, receipt_no: receipt_no, received_at: received_at });
  let emailed = null;
  if (status === 'received' && (b.send_receipt || (!hadReceipt && b.send_receipt !== false))) {
    const t = TPL.donationReceipt(ctx(), d);
    emailed = sendEmail({ to: d.email, toName: d.name, subject: t.subject, html: t.html, kind: 'donation_receipt' }).ok;
  }
  return { ok: true, receipt_no: receipt_no, emailed: emailed };
});

// ---- users
on('GET', '/api/admin/users', function (c) {
  requireRole(c.user, LEADERS);
  return { users: T('users').all(function (u) { return u.role !== 'student'; }).sort(function (a, b) { return a.role.localeCompare(b.role) || a.name.localeCompare(b.name); })
    .map(function (u) { return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, status: u.status, created_at: u.created_at }; }) };
});
on('POST', '/api/admin/users', function (c) {
  requireRole(c.user, LEADERS);
  const role = oneOf(c.body.role, ['admin', 'trustee', 'coordinator'], 'Role');
  if (role === 'admin' && c.user.role !== 'admin') throw new HttpError(403, 'Only administrators can add administrators');
  const u = { name: reqStr(c.body.name, 'Name', 120), email: email(c.body.email), phone: optStr(c.body.phone, 30) };
  if (T('users').get(u.email, 'email')) bad('A user with this email already exists');
  const row = T('users').insert({ email: u.email, name: u.name, phone: u.phone, role: role, password_hash: hashPassword(randomToken()), status: 'active' });
  const link = c.site + '/portal/?reset=' + issueReset(row.id);
  const t = TPL.invite(ctx(), u, link, ROLE_LABEL[role]);
  const r = sendEmail({ to: u.email, toName: u.name, subject: t.subject, html: t.html, kind: 'invite' });
  return { ok: true, emailed: r.ok, invite_link: r.ok ? null : link };
});
on('PUT', '/api/admin/users/:id', function (c) {
  requireRole(c.user, LEADERS);
  const id = Number(c.params.id), t = T('users').get(id);
  if (!t) throw new HttpError(404, 'User not found');
  const role = oneOf(c.body.role || t.role, ['admin', 'trustee', 'coordinator', 'student'], 'Role');
  if ((role === 'admin' || t.role === 'admin') && c.user.role !== 'admin') throw new HttpError(403, 'Only administrators can change administrators');
  const status = oneOf(c.body.status || 'active', ['active', 'disabled'], 'Status');
  if (id === c.user.id && (status === 'disabled' || role !== c.user.role)) bad('You cannot change your own role or disable yourself');
  T('users').update(t, { role: role, status: status });
  if (status === 'disabled') T('sessions').remove(function (s) { return s.user_id === id; });
  return { ok: true };
});
on('DELETE', '/api/admin/users/:id', function (c) {
  requireRole(c.user, ['admin']);
  const id = Number(c.params.id);
  if (id === c.user.id) bad('You cannot delete yourself');
  ['sessions', 'resets', 'activities'].forEach(function (n) { T(n).remove(function (r) { return r.user_id === id; }); });
  T('volunteers').remove(function (v) { return v.user_id === id; });
  T('users').remove(function (u) { return u.id === id; });
  return { ok: true };
});

// ---- settings & senders
on('GET', '/api/admin/settings', function (c) {
  requireRole(c.user, LEADERS);
  const s = getSettings();
  SECRET_KEYS.forEach(function (k) { s[k] = s[k] ? '••••••' : ''; });
  return { settings: s };
});
on('PUT', '/api/admin/settings', function (c) {
  requireRole(c.user, LEADERS);
  const allowed = PUBLIC_KEYS.concat(SECRET_KEYS, ['email_primary', 'zepto_host', 'zoho_dc', 'zoho_client_id', 'zoho_account_id', 'reminder_hours', 'followup_hours', 'gmail_enabled']);
  const o = {}, input = c.body.settings || {};
  Object.keys(input).forEach(function (k) { if (allowed.indexOf(k) >= 0) o[k] = str(input[k], 4000); });
  if (o.email_primary) oneOf(o.email_primary, ['zeptomail', 'zoho_mail', 'gmail'], 'Primary provider');
  setSettings(o);
  if ('zoho_refresh_token' in o || 'zoho_client_id' in o || 'zoho_dc' in o) CacheService.getScriptCache().remove('zoho_at');
  return { ok: true };
});
on('GET', '/api/admin/senders', function (c) {
  requireRole(c.user, STAFF);
  return { senders: T('senders').all().sort(function (a, b) { return (b.is_default || 0) - (a.is_default || 0) || a.address.localeCompare(b.address); }) };
});
function clearDefaultSender() { T('senders').all(function (s) { return s.is_default; }).forEach(function (s) { T('senders').update(s, { is_default: 0 }); }); }
on('POST', '/api/admin/senders', function (c) {
  requireRole(c.user, LEADERS);
  const address = email(c.body.address, 'From address');
  if (T('senders').get(address, 'address')) bad('This address is already listed');
  if (c.body.is_default) clearDefaultSender();
  T('senders').insert({ address: address, name: reqStr(c.body.name, 'Display name', 120), is_default: c.body.is_default ? 1 : 0 });
  return { ok: true };
});
on('PUT', '/api/admin/senders/:id', function (c) {
  requireRole(c.user, LEADERS);
  const s = T('senders').get(Number(c.params.id));
  if (!s) throw new HttpError(404, 'Not found');
  if (c.body.is_default) clearDefaultSender();
  T('senders').update(s, { address: email(c.body.address, 'From address'), name: reqStr(c.body.name, 'Display name', 120), is_default: c.body.is_default ? 1 : 0 });
  return { ok: true };
});
on('DELETE', '/api/admin/senders/:id', function (c) {
  requireRole(c.user, LEADERS);
  T('senders').remove(function (s) { return s.id === Number(c.params.id); });
  return { ok: true };
});

// ---- email tools
on('GET', '/api/admin/email/gmail', function (c) {
  requireRole(c.user, LEADERS);
  let quota = null, aliases = [], account = '';
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { /* not authorised */ }
  try { aliases = GmailApp.getAliases(); } catch (e) { /* not authorised */ }
  try { account = Session.getEffectiveUser().getEmail(); } catch (e) { /* hidden */ }
  return { authorised: quota != null, quota: quota, aliases: aliases, account: account };
});
on('POST', '/api/admin/email/zoho-account', function (c) { requireRole(c.user, LEADERS); return Object.assign({ ok: true }, zohoFetchAccountId()); });
on('POST', '/api/admin/email/test', function (c) {
  requireRole(c.user, LEADERS);
  const to = email(c.body.to || c.user.email);
  const only = c.body.provider ? oneOf(c.body.provider, ['zeptomail', 'zoho_mail', 'gmail'], 'Provider') : null;
  const label = only === 'zoho_mail' ? 'Zoho Mail (self-client)' : only === 'zeptomail' ? 'ZeptoMail' : only === 'gmail' ? 'Gmail' : 'your configured providers';
  const html = TPL.custom(ctx(), 'Test email', 'This is a test message from your Superwings Foundation portal, sent through ' + label + '.\n\nIf you can read this, email is connected correctly.');
  return sendEmail({ to: to, subject: 'Test email from the portal', html: html, kind: 'test', senderId: c.body.sender_id, only: only });
});
on('POST', '/api/admin/email/preview', function (c) {
  requireRole(c.user, STAFF);
  const b = c.body;
  return { html: TPL.custom(ctx(), str(b.title, 200) || str(b.subject, 200) || 'Preview', str(b.body, 20000) || '…', { label: str(b.cta_label, 60), url: str(b.cta_url, 500) }) };
});
on('POST', '/api/admin/email/send', function (c) {
  requireRole(c.user, STAFF);
  const b = c.body;
  const list = str(b.to, 5000).split(/[,;\s]+/).filter(Boolean).map(function (x) { return email(x, 'Recipient'); });
  if (!list.length) bad('Add at least one recipient');
  if (list.length > 500) bad('Send to at most 500 recipients at a time');
  const cc = str(b.cc, 2000).split(/[,;\s]+/).filter(Boolean).map(function (x) { return email(x, 'CC'); });
  const subject = reqStr(b.subject, 'Subject', 200);
  const html = TPL.custom(ctx(), str(b.title, 200) || subject, reqStr(b.body, 'Message', 20000), { label: str(b.cta_label, 60), url: str(b.cta_url, 500) });
  if (b.individually === false) {
    const r = sendEmail({ to: list.map(function (a) { return { address: a }; }), subject: subject, html: html, cc: cc, kind: 'compose', senderId: b.sender_id });
    return { ok: r.ok, sent: r.ok ? list.length : 0, queued: 0, errors: r.ok ? [] : [r.error] };
  }
  if (list.length <= 15) {
    let sent = 0; const errors = [];
    list.forEach(function (to) { const r = sendEmail({ to: to, subject: subject, html: html, cc: cc, kind: 'compose', senderId: b.sender_id }); if (r.ok) sent++; else errors.push(to + ': ' + r.error); });
    return { ok: !errors.length, sent: sent, queued: 0, errors: errors };
  }
  enqueue(list.map(function (to) { return { to: to, subject: subject, html: html, cc: cc, kind: 'compose', senderId: b.sender_id }; }));
  return { ok: true, sent: 0, queued: list.length, errors: [] };
});
on('GET', '/api/admin/email/log', function (c) {
  requireRole(c.user, LEADERS);
  return { log: T('email_log').all().sort(function (a, b) { return b.id - a.id; }).slice(0, 200) };
});
on('GET', '/api/admin/email/outbox', function (c) {
  requireRole(c.user, LEADERS);
  const rows = T('outbox').rows(), counts = {};
  rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  return { counts: counts, items: rows.filter(function (r) { return r.status !== 'sent'; }).sort(function (a, b) { return b.id - a.id; }).slice(0, 100)
    .map(function (r) { return { id: r.id, to_addr: r.to_addr, subject: r.subject, kind: r.kind, attempts: r.attempts, last_error: r.last_error, created_at: r.created_at }; }) };
});
on('POST', '/api/admin/email/outbox/retry', function (c) {
  requireRole(c.user, LEADERS);
  T('outbox').all(function (r) { return r.status === 'failed'; }).forEach(function (r) { T('outbox').update(r, { status: 'queued', attempts: 0 }); });
  return Object.assign({ ok: true }, drainOutbox(20));
});
on('POST', '/api/admin/cron/run', function (c) { requireRole(c.user, LEADERS); return Object.assign({ ok: true }, runScheduledInner()); });

// ============================================================ EMAIL ENGINE
const ZOHO_DC = { in: 'in', com: 'com', eu: 'eu', au: 'com.au', jp: 'jp' };
function sendZepto(s, msg) {
  if (!s.zepto_token) throw new Error('ZeptoMail is not connected');
  const token = s.zepto_token.replace(/^Zoho-enczapikey\s+/i, '');
  const body = { from: { address: msg.from.address, name: msg.from.name }, subject: msg.subject, htmlbody: msg.html,
    to: msg.to.map(function (t) { return { email_address: { address: t.address, name: t.name || t.address } }; }) };
  if (msg.cc && msg.cc.length) body.cc = msg.cc.map(function (a) { return { email_address: { address: a } }; });
  if (msg.replyTo) body.reply_to = [{ address: msg.replyTo }];
  const res = UrlFetchApp.fetch('https://' + (s.zepto_host || 'api.zeptomail.in') + '/v1.1/email', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Zoho-enczapikey ' + token, Accept: 'application/json' },
    payload: JSON.stringify(body), muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('ZeptoMail ' + code + ': ' + res.getContentText().slice(0, 300));
  return 'zeptomail';
}
function zohoAccessToken(s, force) {
  if (!s.zoho_client_id || !s.zoho_client_secret || !s.zoho_refresh_token) throw new Error('Zoho Mail self-client is not connected');
  const cache = CacheService.getScriptCache();
  if (!force) { const hit = cache.get('zoho_at'); if (hit) return hit; }
  const dc = ZOHO_DC[s.zoho_dc] || 'in';
  const res = UrlFetchApp.fetch('https://accounts.zoho.' + dc + '/oauth/v2/token', { method: 'post', muteHttpExceptions: true,
    payload: { refresh_token: s.zoho_refresh_token, client_id: s.zoho_client_id, client_secret: s.zoho_client_secret, grant_type: 'refresh_token' } });
  let data = {}; try { data = JSON.parse(res.getContentText()); } catch (e) { /* ignore */ }
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + (data.error || res.getResponseCode()));
  cache.put('zoho_at', data.access_token, Math.max(60, (Number(data.expires_in) || 3600) - 300));
  return data.access_token;
}
function zohoFetchAccountId() {
  const s = getSettings(), at = zohoAccessToken(s, true), dc = ZOHO_DC[s.zoho_dc] || 'in';
  const res = UrlFetchApp.fetch('https://mail.zoho.' + dc + '/api/accounts', { headers: { Authorization: 'Zoho-oauthtoken ' + at }, muteHttpExceptions: true });
  let data = {}; try { data = JSON.parse(res.getContentText()); } catch (e) { /* ignore */ }
  const acc = data && data.data && data.data[0];
  if (!acc) throw new HttpError(502, 'Could not read Zoho Mail accounts (' + res.getResponseCode() + ')');
  setSettings({ zoho_account_id: String(acc.accountId) });
  return { accountId: String(acc.accountId), address: acc.primaryEmailAddress || acc.mailboxAddress || '' };
}
function sendZoho(s, msg) {
  if (!s.zoho_account_id) throw new Error('Zoho Mail account ID missing (use "Fetch account ID" in settings)');
  const dc = ZOHO_DC[s.zoho_dc] || 'in';
  const payload = { fromAddress: msg.from.name ? '"' + msg.from.name + '" <' + msg.from.address + '>' : msg.from.address,
    toAddress: msg.to.map(function (t) { return t.address; }).join(','), subject: msg.subject, content: msg.html, mailFormat: 'html' };
  if (msg.cc && msg.cc.length) payload.ccAddress = msg.cc.join(',');
  const go = function (at) {
    return UrlFetchApp.fetch('https://mail.zoho.' + dc + '/api/accounts/' + s.zoho_account_id + '/messages', { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Zoho-oauthtoken ' + at }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  };
  let res = go(zohoAccessToken(s));
  if (res.getResponseCode() === 401) res = go(zohoAccessToken(s, true));
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Zoho Mail ' + code + ': ' + res.getContentText().slice(0, 300));
  return 'zoho_mail';
}
function sendGmail(s, msg) {
  if (s.gmail_enabled === '0') throw new Error('Gmail fallback is turned off');
  const recipients = msg.to.length + (msg.cc ? msg.cc.length : 0);
  if (MailApp.getRemainingDailyQuota() < recipients) throw new Error('Gmail daily sending limit reached');
  const opts = { htmlBody: msg.html, name: msg.from.name, replyTo: msg.replyTo || msg.from.address };
  if (msg.cc && msg.cc.length) opts.cc = msg.cc.join(',');
  // Gmail can only send "from" addresses added under Gmail Settings > Accounts > Send mail as.
  let aliases = [];
  try { aliases = GmailApp.getAliases().map(function (a) { return a.toLowerCase(); }); } catch (e) { /* aliases not readable */ }
  if (aliases.indexOf(String(msg.from.address).toLowerCase()) >= 0) opts.from = msg.from.address;
  const text = String(msg.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  GmailApp.sendEmail(msg.to.map(function (t) { return t.address; }).join(','), msg.subject, text, opts);
  return 'gmail';
}
function resolveSender(s, senderId) {
  const list = T('senders').rows();
  let row = senderId ? list.find(function (x) { return x.id === Number(senderId); }) : null;
  if (!row) row = list.filter(function (x) { return x.is_default; })[0] || list[0];
  return row ? { address: row.address, name: row.name } : { address: s.contact_email, name: s.org_name };
}
/** opts: { to: string | [{address,name}], toName, subject, html, kind, senderId, cc: [], only } → { ok, provider, error } */
function sendEmail(opts) {
  const s = getSettings(), from = resolveSender(s, opts.senderId);
  const to = Array.isArray(opts.to) ? opts.to : [{ address: opts.to, name: opts.toName }];
  const msg = { from: from, to: to, subject: opts.subject, html: opts.html, cc: opts.cc, replyTo: s.contact_email };
  const all = ['zeptomail', 'zoho_mail', 'gmail'];
  const first = all.indexOf(s.email_primary) >= 0 ? s.email_primary : 'zeptomail';
  const order = opts.only ? [opts.only] : [first].concat(all.filter(function (p) { return p !== first; }));
  const errors = [];
  for (let i = 0; i < order.length; i++) {
    try {
      const provider = order[i] === 'zeptomail' ? sendZepto(s, msg) : order[i] === 'zoho_mail' ? sendZoho(s, msg) : sendGmail(s, msg);
      logEmail(opts.kind, to, from, opts.subject, provider, 'sent', errors.join(' | ') || null);
      return { ok: true, provider: provider };
    } catch (e) { errors.push(String(e.message || e)); }
  }
  logEmail(opts.kind, to, from, opts.subject, null, 'failed', errors.join(' | '));
  return { ok: false, error: errors.join(' | ') };
}
function logEmail(kind, to, from, subject, provider, status, error) {
  try {
    T('email_log').insert({ kind: kind || 'other', to_addr: to.map(function (t) { return t.address; }).join(', '), from_addr: from.address,
      subject: subject, provider: provider, status: status, error: error ? String(error).slice(0, 1000) : null });
  } catch (e) { /* never break sending */ }
}
function enqueue(list) {
  T('outbox').insertMany(list.map(function (m) {
    return { to_addr: m.to, to_name: m.toName || null, cc: (m.cc || []).join(',') || null, subject: m.subject, html: m.html, kind: m.kind || 'other',
      sender_id: m.senderId || null, ref_table: m.ref ? m.ref.table : null, ref_id: m.ref ? m.ref.id : null, ref_flag: m.ref ? m.ref.flag : null, attempts: 0, status: 'queued' };
  }));
}
function drainOutbox(limit) {
  const rows = T('outbox').all(function (r) { return r.status === 'queued'; }).sort(function (a, b) { return a.id - b.id; }).slice(0, limit);
  let sent = 0, failed = 0;
  rows.forEach(function (m) {
    const r = sendEmail({ to: m.to_addr, toName: m.to_name, cc: m.cc ? m.cc.split(',') : undefined, subject: m.subject, html: m.html, kind: m.kind, senderId: m.sender_id });
    if (r.ok) {
      sent++;
      T('outbox').update(m, { status: 'sent', html: '' });
      if (m.ref_table === 'registrations' && ['reminder_sent', 'followup_sent', 'confirm_sent'].indexOf(m.ref_flag) >= 0) {
        const reg = T('registrations').get(m.ref_id); if (reg) { const p = {}; p[m.ref_flag] = 1; T('registrations').update(reg, p); }
      }
    } else {
      failed++;
      const attempts = (m.attempts || 0) + 1;
      T('outbox').update(m, { attempts: attempts, last_error: String(r.error).slice(0, 500), status: attempts >= 5 ? 'failed' : 'queued' });
    }
  });
  return { sent: sent, failed: failed };
}

// ============================================================ SCHEDULED JOB (every 5 minutes)
function runScheduled() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try { console.log(JSON.stringify(runScheduledInner())); } finally { lock.releaseLock(); }
}
function runScheduledInner() {
  const s = getSettings(), cx = ctx(), now = Date.now(), H = 3600e3;
  const iso = function (ms) { return new Date(ms).toISOString(); };
  const reminderH = Number(s.reminder_hours) || 24, followupH = Number(s.followup_hours) || 3, retentionD = Number(s.retention_days) || 7;
  const res = { reminders_queued: 0, followups_queued: 0, registrations_deleted: 0 };
  const events = T('events').all(function (e) { return e.status === 'published'; });
  const regs = T('registrations');

  events.filter(function (e) { return e.start_at > iso(now) && e.start_at <= iso(now + reminderH * H); }).forEach(function (ev) {
    const list = regs.all(function (r) { return r.event_id === ev.id && !r.reminder_sent; });
    enqueue(list.map(function (r) { const t = TPL.reminder(cx, ev, r); return { to: r.email, toName: r.name, subject: t.subject, html: t.html, kind: 'event_reminder', senderId: ev.sender_id, ref: { table: 'registrations', id: r.id, flag: 'reminder_sent' } }; }));
    list.forEach(function (r) { regs.update(r, { reminder_sent: 2 }); });
    res.reminders_queued += list.length;
  });
  events.filter(function (e) { return e.end_at <= iso(now - followupH * H) && e.end_at >= iso(now - 72 * H); }).forEach(function (ev) {
    const list = regs.all(function (r) { return r.event_id === ev.id && !r.followup_sent; });
    enqueue(list.map(function (r) { const t = TPL.followup(cx, ev, r); return { to: r.email, toName: r.name, subject: t.subject, html: t.html, kind: 'event_followup', senderId: ev.sender_id, ref: { table: 'registrations', id: r.id, flag: 'followup_sent' } }; }));
    list.forEach(function (r) { regs.update(r, { followup_sent: 2 }); });
    res.followups_queued += list.length;
  });

  // data retention: delete registrations N days after the event ends
  const cutoff = iso(now - retentionD * 864e5);
  const oldIds = T('events').all(function (e) { return e.end_at < cutoff; }).map(function (e) { return e.id; });
  if (oldIds.length) {
    const doomed = regs.all(function (r) { return oldIds.indexOf(r.event_id) >= 0; }).map(function (r) { return r.id; });
    if (doomed.length) {
      T('outbox').remove(function (o) { return o.ref_table === 'registrations' && doomed.indexOf(o.ref_id) >= 0; });
      res.registrations_deleted = regs.remove(function (r) { return oldIds.indexOf(r.event_id) >= 0; });
    }
  }
  Object.assign(res, drainOutbox(MAX_SENDS_PER_RUN));

  // housekeeping
  const nowS = iso(now), d30 = iso(now - 30 * 864e5), d180 = iso(now - 180 * 864e5);
  T('sessions').remove(function (x) { return x.expires_at < nowS; });
  T('resets').remove(function (x) { return x.expires_at < nowS; });
  T('outbox').remove(function (x) { return x.status === 'sent' && x.created_at < d30; });
  T('email_log').remove(function (x) { return x.created_at < d180; });
  return res;
}

// ============================================================ HEALTH CHECK
function health() {
  const checks = [], add = function (name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
  let book = null;
  try { book = ss(); add('Database sheet', true, book.getName()); } catch (e) { add('Database sheet', false, e.message); }
  if (book) {
    const missing = Object.keys(SCHEMA).filter(function (n) { return !book.getSheetByName(n); });
    add('Sheet tabs', !missing.length, missing.length ? 'Missing: ' + missing.join(', ') + '. Run setup().' : 'All ' + Object.keys(SCHEMA).length + ' tabs present');
    const bad = Object.keys(SCHEMA).filter(function (n) {
      const sh = book.getSheetByName(n); if (!sh) return false;
      const head = sh.getRange(1, 1, 1, SCHEMA[n].length).getDisplayValues()[0];
      return head.join('|') !== SCHEMA[n].join('|');
    });
    add('Column headers', !bad.length, bad.length ? 'Changed in: ' + bad.join(', ') + '. Do not edit row 1; run setup() to restore.' : 'OK');
  }
  const props = PropertiesService.getScriptProperties();
  add('Setup token', !!props.getProperty('SETUP_TOKEN'), props.getProperty('SETUP_TOKEN') ? 'Set' : 'Run setup()');
  let trig = false; try { trig = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runScheduled'; }); } catch (e) { /* no permission */ }
  add('5-minute job', trig, trig ? 'Trigger installed' : 'Run setup() to install it');
  let s = {}; try { s = getSettings(); } catch (e) { /* reported above */ }
  add('ZeptoMail', !!s.zepto_token, s.zepto_token ? 'Token saved' : 'Not connected');
  add('Zoho Mail self-client', !!(s.zoho_refresh_token && s.zoho_account_id), s.zoho_refresh_token ? (s.zoho_account_id ? 'Connected' : 'Fetch account ID') : 'Not connected');
  let gq = null; try { gq = MailApp.getRemainingDailyQuota(); } catch (e) { /* not authorised */ }
  add('Gmail fallback', s.gmail_enabled !== '0' && gq != null, gq == null ? 'Not authorised yet: run authorizeGmail() in the editor' : s.gmail_enabled === '0' ? 'Turned off' : gq + ' emails left today');
  return { ok: checks.every(function (c) { return c.ok || /Zepto|Zoho|Gmail/.test(c.name); }), checks: checks, time: nowIso() };
}
on('GET', '/api/admin/health', function (c) { requireRole(c.user, LEADERS); return health(); });

// ============================================================ SITEMAP & BUILD EXPORT
function exportForBuild() {
  const events = T('events').all(function (e) { return e.status === 'published'; }).map(function (e) {
    const o = Object.assign({}, e); delete o.sender_id; o.agenda = agendaFor(e.id); return o;
  });
  return { generated_at: nowIso(), settings: getSettings(PUBLIC_KEYS), events: events,
    trustees: T('people').all(function (p) { return p.kind === 'trustee' && p.visible !== 0; }).sort(bySort).map(function (p) { return { name: p.name, title: p.title }; }) };
}
function sitemapXml() {
  const base = siteUrl();
  const pages = [['/', 'weekly', '1.0'], ['/events/', 'daily', '0.9'], ['/volunteer', 'monthly', '0.8'], ['/donate', 'monthly', '0.7']];
  const urls = pages.map(function (p) { return '<url><loc>' + esc(base + p[0]) + '</loc><changefreq>' + p[1] + '</changefreq><priority>' + p[2] + '</priority></url>'; });
  T('events').all(function (e) { return e.status === 'published'; }).forEach(function (e) {
    urls.push('<url><loc>' + esc(base + '/events/' + e.slug + '/') + '</loc><lastmod>' + (e.updated_at || e.created_at || nowIso()).slice(0, 10) + '</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>');
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.join('\n') + '\n</urlset>';
}
/** Ask GitHub to rebuild the site (new event pages + sitemap). Needs Script Properties GITHUB_TOKEN and GITHUB_REPO (owner/repo). */
function requestRebuild() {
  const p = PropertiesService.getScriptProperties(), token = p.getProperty('GITHUB_TOKEN'), repo = p.getProperty('GITHUB_REPO');
  if (!token || !repo) return;
  const c = CacheService.getScriptCache();
  if (c.get('rebuild_pending')) return;
  c.put('rebuild_pending', '1', 60);
  try {
    UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }, payload: JSON.stringify({ event_type: 'content-updated' }) });
  } catch (e) { console.warn('Rebuild request failed: ' + e); }
}

// ============================================================ EMAIL TEMPLATES
function ctx() { return { s: getSettings(), siteUrl: siteUrl() }; }
const G = '#239a52', GD = '#0f4d28', Y = '#fdcb2e';
function layout(o) {
  const s = o.s, site = o.siteUrl;
  const button = o.cta ? '<tr><td style="padding:8px 40px 8px"><a href="' + esc(o.cta.url) + '" style="display:inline-block;background:' + G + ';color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:999px;font-size:15px">' + esc(o.cta.label) + '</a></td></tr>' : '';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(o.title) + '</title></head>' +
    '<body style="margin:0;padding:0;background:#f2f5ef;font-family:\'Segoe UI\',Helvetica,Arial,sans-serif;color:#1c2a22">' +
    '<span style="display:none;max-height:0;overflow:hidden;opacity:0">' + esc(o.preheader || '') + '</span>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5ef;padding:28px 12px"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 6px 24px rgba(15,77,40,.08)">' +
    '<tr><td style="height:6px;background:' + Y + ';font-size:0;line-height:0">&nbsp;</td></tr>' +
    '<tr><td align="center" style="padding:26px 40px 8px"><img src="' + esc(site) + '/assets/logo.jpg" width="150" alt="' + esc(s.org_name) + '" style="display:block;border:0;width:150px;height:auto"></td></tr>' +
    '<tr><td style="padding:14px 40px 4px"><h1 style="margin:0;font-size:24px;line-height:1.25;color:' + GD + ';font-weight:800">' + esc(o.title) + '</h1></td></tr>' +
    '<tr><td style="padding:8px 40px 16px;font-size:15.5px;line-height:1.65;color:#33443a">' + o.body + '</td></tr>' + button +
    '<tr><td style="padding:24px 40px 0"><div style="border-top:1px solid #e4ebe6"></div></td></tr>' +
    '<tr><td style="padding:16px 40px 28px;font-size:12.5px;line-height:1.6;color:#6b7b71"><strong style="color:' + GD + '">' + esc(s.org_name) + '</strong> · Public Charitable Trust · Reg. No. ' + esc(s.reg_no) + '<br>' +
    esc(s.address) + '<br><a href="mailto:' + esc(s.contact_email) + '" style="color:' + G + '">' + esc(s.contact_email) + '</a> · ' + esc(s.contact_phone) +
    ' · <a href="' + esc(site) + '" style="color:' + G + '">' + esc(site.replace(/^https?:\/\//, '')) + '</a></td></tr>' +
    '<tr><td style="height:6px;background:' + G + ';font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr></table></body></html>';
}
function P(t) { return '<p style="margin:0 0 14px">' + t + '</p>'; }
function card(rows) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7faf5;border:1px solid #e4ebe6;border-radius:12px;margin:6px 0 16px">' +
    rows.filter(function (r) { return r[1] != null && r[1] !== ''; }).map(function (r) {
      return '<tr><td style="padding:10px 16px;font-size:13px;color:#6b7b71;width:38%;vertical-align:top">' + esc(r[0]) + '</td><td style="padding:10px 16px;font-size:14.5px;font-weight:600;color:#1c2a22">' + r[1] + '</td></tr>';
    }).join('') + '</table>';
}
function nl2br(t) { return esc(t).replace(/\n/g, '<br>'); }
function inr(n) { return '₹' + Number(n).toLocaleString('en-IN'); }
function L(cx, extra) { return Object.assign({ s: cx.s, siteUrl: cx.siteUrl }, extra); }
const TPL = {
  registration: function (cx, ev, r) {
    return { subject: "You're registered: " + ev.title, html: layout(L(cx, { title: 'See you at ' + ev.title + '!', preheader: 'Your registration code is ' + r.code,
      body: P('Dear ' + esc(r.name) + ',') + P('Thank you for registering. Your place is confirmed.') +
        card([['Event', esc(ev.title)], ['When', esc(fmtWhen(ev.start_at, ev.end_at))], ['Venue', esc([ev.venue, ev.address].filter(Boolean).join(', '))],
          ['Registration code', '<span style="font-family:monospace;font-size:16px;letter-spacing:2px;color:' + G + '">' + esc(r.code) + '</span>']]) +
        P('Please keep this email handy. We will send you a reminder before the event.') +
        P('<span style="font-size:13px;color:#6b7b71">We keep your registration details only until 7 days after the event, then delete them automatically.</span>'),
      cta: { label: 'View event details', url: cx.siteUrl + '/events/' + ev.slug + '/' } })) };
  },
  reminder: function (cx, ev, r) {
    return { subject: 'Reminder: ' + ev.title + ' is coming up', html: layout(L(cx, { title: ev.title + ' is almost here', preheader: fmtWhen(ev.start_at, ev.end_at),
      body: P('Dear ' + esc(r.name) + ',') + P('A quick reminder about the event you registered for:') +
        card([['When', esc(fmtWhen(ev.start_at, ev.end_at))], ['Venue', esc([ev.venue, ev.address].filter(Boolean).join(', '))], ['Your code', esc(r.code)]]) +
        (ev.map_url ? P('<a href="' + esc(ev.map_url) + '" style="color:' + G + ';font-weight:700">Open directions in Maps →</a>') : '') + P('We look forward to seeing you.'),
      cta: { label: 'See the agenda', url: cx.siteUrl + '/events/' + ev.slug + '/#agenda' } })) };
  },
  followup: function (cx, ev, r) {
    return { subject: 'Thank you for joining ' + ev.title, html: layout(L(cx, { title: 'Thank you for being there', preheader: 'A note from ' + cx.s.org_name,
      body: P('Dear ' + esc(r.name) + ',') + P('Thank you for joining us at <strong>' + esc(ev.title) + '</strong>. Events like this only work because people like you show up.') +
        P('If you would like to stay involved, you can volunteer with us, bring your institution on board for service learning, or support our work.'),
      cta: { label: 'Get involved', url: cx.siteUrl + '/volunteer' } })) };
  },
  volunteerReceived: function (cx, u, prog) {
    return { subject: 'We have received your volunteer application', html: layout(L(cx, { title: 'Welcome aboard, almost!', preheader: 'Your application is with our coordinators',
      body: P('Dear ' + esc(u.name) + ',') + P('Thank you for applying to the ' + esc(cx.s.org_name) + ' Volunteer Programme (' + esc(prog) + '). Our coordinators will review your application and write back soon.') +
        P('You can already sign in to your volunteer portal with the email and password you chose.'),
      cta: { label: 'Open volunteer portal', url: cx.siteUrl + '/portal/' } })) };
  },
  volunteerDecision: function (cx, u, approved, note) {
    return { subject: approved ? 'Your volunteer application is approved' : 'Update on your volunteer application',
      html: layout(L(cx, { title: approved ? 'You are in!' : 'Application update', preheader: approved ? 'Start logging your service hours' : '',
        body: P('Dear ' + esc(u.name) + ',') + P(approved ? 'Your application to the Volunteer Programme has been approved. You can now log your activities, hours and reflections in the portal, and our coordinators will verify them.'
          : 'Thank you for your interest. We are unable to take your application forward at this time.') + (note ? P('<em>' + nl2br(note) + '</em>') : ''),
        cta: approved ? { label: 'Go to my portal', url: cx.siteUrl + '/portal/' } : null })) };
  },
  activityReviewed: function (cx, u, a) {
    const ok = a.status === 'approved';
    return { subject: (ok ? 'Hours verified: ' : 'Activity needs attention: ') + a.title, html: layout(L(cx, { title: ok ? 'Your hours are verified' : 'Please review your entry',
      body: P('Dear ' + esc(u.name) + ',') + card([['Activity', esc(a.title)], ['Date', esc(fmtDate(a.date + 'T12:00:00+05:30'))], ['Hours', esc(a.hours)], ['Status', ok ? 'Verified' : 'Returned']]) +
        (a.review_note ? P("Coordinator's note: <em>" + nl2br(a.review_note) + '</em>') : ''),
      cta: { label: 'Open portal', url: cx.siteUrl + '/portal/' } })) };
  },
  partnerReceived: function (cx, pt) {
    return { subject: 'Your partnership request has been received', html: layout(L(cx, { title: 'Thank you for reaching out', preheader: 'Service-learning partnership request',
      body: P('Dear ' + esc(pt.contact_name || pt.name) + ',') + P('Thank you for your interest in partnering with ' + esc(cx.s.org_name) + ' for service learning. We have received the request from <strong>' + esc(pt.name) + '</strong>, and our team will contact you to plan the next steps.') +
        card([['Institution', esc(pt.name)], ['Programme', esc(pt.programme)], ['Expected students', esc(pt.students)]]) })) };
  },
  partnerDecision: function (cx, pt, approved) {
    return { subject: approved ? 'Partnership confirmed: ' + pt.name : 'Update on your partnership request', html: layout(L(cx, { title: approved ? 'Welcome, partner!' : 'Partnership update',
      body: P('Dear ' + esc(pt.contact_name || pt.name) + ',') + P(approved ? 'We are delighted to confirm <strong>' + esc(pt.name) + '</strong> as a service-learning partner. Your students can now choose your institution when they sign up for the Volunteer Programme.'
        : 'Thank you for your interest. We are unable to take this partnership forward right now, but we would be glad to stay in touch.'),
      cta: approved ? { label: 'Share the student sign-up link', url: cx.siteUrl + '/volunteer#join' } : null })) };
  },
  donationPledged: function (cx, d) {
    return { subject: 'Thank you for your contribution', html: layout(L(cx, { title: 'Thank you for your generosity', preheader: 'Contribution of ' + inr(d.amount),
      body: P('Dear ' + esc(d.name) + ',') + P('Thank you for choosing to support ' + esc(cx.s.org_name) + '. We have recorded your contribution and will send a formal receipt once the funds reach our account.') +
        card([['Amount', inr(d.amount)], ['Mode', esc(d.mode)], ['Transaction reference', esc(d.txn_ref)], ['Purpose', esc(d.purpose)]]) })) };
  },
  donationReceipt: function (cx, d) {
    const s = cx.s;
    const tax = s.reg_80g ? P('<span style="font-size:13px;color:#6b7b71">Donations to ' + esc(s.org_name) + ' qualify for deduction under Section 80G of the Income Tax Act, 1961. 80G registration no. ' + esc(s.reg_80g) + (s.reg_80g_validity ? ', valid ' + esc(s.reg_80g_validity) : '') + '. Trust PAN: ' + esc(s.pan) + '.</span>') : '';
    return { subject: 'Receipt ' + d.receipt_no + ': ' + s.org_name, html: layout(L(cx, { title: 'Donation receipt', preheader: 'Receipt ' + d.receipt_no,
      body: P('Dear ' + esc(d.name) + ',') + P('We gratefully acknowledge the following contribution:') +
        card([['Receipt no.', esc(d.receipt_no)], ['Date received', esc(fmtDate(d.received_at))], ['Received from', esc(d.name)], ['Donor PAN', esc(d.pan)], ['Amount', inr(d.amount)],
          ['Mode', esc(d.mode)], ['Reference', esc(d.txn_ref)], ['Trust PAN', esc(s.pan)], ['12A registration', esc(s.reg_12a)]]) + tax + P('With gratitude,<br><strong>Board of Trustees</strong>') })) };
  },
  passwordReset: function (cx, u, link) {
    return { subject: 'Set your password', html: layout(L(cx, { title: 'Set your password', preheader: 'This link is valid for 24 hours',
      body: P('Dear ' + esc(u.name) + ',') + P('Use the button below to set a new password for your portal account. This link is valid for 24 hours. If you did not ask for this, you can ignore this email.'),
      cta: { label: 'Set password', url: link } })) };
  },
  invite: function (cx, u, link, roleLabel) {
    return { subject: 'You have been added to the ' + cx.s.org_name + ' portal', html: layout(L(cx, { title: 'Welcome to the portal', preheader: 'Your role: ' + roleLabel,
      body: P('Dear ' + esc(u.name) + ',') + P('You have been added to the ' + esc(cx.s.org_name) + ' portal as <strong>' + esc(roleLabel) + '</strong>. Set your password to sign in. This link is valid for 24 hours.'),
      cta: { label: 'Set password and sign in', url: link } })) };
  },
  custom: function (cx, title, bodyText, cta) {
    const body = String(bodyText).split(/\n{2,}/).map(function (p) { return P(nl2br(p)); }).join('');
    return layout(L(cx, { title: title, body: body, cta: cta && cta.url ? cta : null }));
  },
};

// ============================================================ ONE-TIME SETUP (run from the editor)
function setup() {
  const props0 = PropertiesService.getScriptProperties();
  let book = null;
  try { book = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* standalone */ }
  if (book && !props0.getProperty('SHEET_ID')) props0.setProperty('SHEET_ID', book.getId());
  if (!book && props0.getProperty('SHEET_ID')) book = SpreadsheetApp.openById(props0.getProperty('SHEET_ID'));
  if (!book) {
    book = SpreadsheetApp.create('Superwings Foundation – Database');
    props0.setProperty('SHEET_ID', book.getId());
    console.log('Created database sheet: ' + book.getUrl());
  }
  _ss = book;
  Object.keys(SCHEMA).forEach(function (name) {
    let sh = book.getSheetByName(name);
    if (!sh) sh = book.insertSheet(name);
    const cols = SCHEMA[name];
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#0f4d28').setFontColor('#ffffff');
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  const def = book.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && book.getSheets().length > 1) book.deleteSheet(def);
  ['sessions', 'resets', 'outbox'].forEach(function (n) { book.getSheetByName(n).hideSheet(); });

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SETUP_TOKEN')) props.setProperty('SETUP_TOKEN', randomCode(10));
  mediaFolder();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runScheduled') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runScheduled').timeBased().everyMinutes(5).create();
  MailApp.getRemainingDailyQuota(); GmailApp.getAliases(); // asks for Gmail permission now
  const msg = 'Setup complete.\n\nDatabase: ' + book.getUrl() + '\nSETUP TOKEN: ' + props.getProperty('SETUP_TOKEN') +
    '\n\nNext: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone). Then open /portal/ on the website and use this token to create the first admin.';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor: see the log */ }
  return msg;
}
/** Run once from the editor after adding the Gmail fallback, to grant Gmail permission. */
function authorizeGmail() {
  const q = MailApp.getRemainingDailyQuota();
  const me = Session.getEffectiveUser().getEmail();
  const msg = 'Gmail fallback authorised for ' + me + '. Emails left today: ' + q + '. Aliases: ' + (GmailApp.getAliases().join(', ') || 'none');
  console.log(msg);
  return msg;
}
/** Shows the setup token again (in case you lost it). */
function showSetupToken() { const t = PropertiesService.getScriptProperties().getProperty('SETUP_TOKEN'); console.log('SETUP TOKEN: ' + t); return t; }
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Superwings').addItem('Run setup', 'setup').addItem('Show setup token', 'showSetupToken')
      .addItem('Run scheduled job now', 'runScheduled').addToUi();
  } catch (e) { /* not in a spreadsheet UI */ }
}
