// Minimal Google Apps Script runtime mock for testing Code.gs in Node.
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  _ensure() { while (this.sh.data.length < this.r + this.nr - 1) this.sh.data.push([]); }
  getDisplayValues() {
    if (this.r + this.nr - 1 > this.sh.maxRows) throw new Error('Range out of bounds');
    return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => String(this.sh.data[this.r - 1 + i]?.[this.c - 1 + j] ?? '')));
  }
  setValues(v) {
    if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) throw new Error('setValues dimension mismatch');
    if (this.r + this.nr - 1 > this.sh.maxRows) throw new Error('Range out of bounds (rows)');
    this._ensure();
    v.forEach((row, i) => row.forEach((val, j) => { (this.sh.data[this.r - 1 + i] ||= [])[this.c - 1 + j] = String(val); }));
    return this;
  }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.sh.data[this.r - 1 + i]) this.sh.data[this.r - 1 + i][this.c - 1 + j] = ''; return this; }
  setNumberFormat() { return this; } setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; this.maxCols = 26; }
  getLastRow() { for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v != null)) return i + 1; return 0; }
  getMaxRows() { return this.maxRows; } getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_, n) { this.maxRows += n; } insertColumnsAfter(_, n) { this.maxCols += n; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  setFrozenRows() {} hideSheet() {}
}
class Book {
  constructor() { this.sheets = [new Sheet('Sheet1')]; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/mock'; } getName() { return 'Superwings DB'; } getId() { return 'mockid'; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; } deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

export function loadGas(file, { fetchHandler, gmail }) {
  const book = new Book();
  const props = new Map(), cache = new Map(), files = new Map();
  const signed = (buf) => [...buf].map((b) => (b > 127 ? b - 256 : b));
  const bytes = (v) => Buffer.from(Array.isArray(v) ? v.map((b) => (b + 256) % 256) : v);
  const Utilities = {
    getUuid: () => crypto.randomUUID(),
    computeHmacSha256Signature: (value, key) => signed(crypto.createHmac('sha256', bytes(key)).update(bytes(value)).digest()),
    newBlob: (data, mime, name) => ({ getBytes: () => signed(Buffer.from(typeof data === 'string' ? data : bytes(data))), mime, name, data }),
    base64Encode: (b) => bytes(b).toString('base64'),
    base64Decode: (s) => signed(Buffer.from(s, 'base64')),
    formatDate: (d, tz, pattern) => {
      const f = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(d);
      return pattern.replace('EEEE', f({ weekday: 'long' })).replace('MMMM', f({ month: 'long' })).replace('yyyy', f({ year: 'numeric' }))
        .replace(/\bd\b/, f({ day: 'numeric' })).replace('h:mm a', new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace('AM', 'am').replace('PM', 'pm'));
    },
  };
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => console.error('[gas error]', ...a) },
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book, getUi: () => { throw new Error('no ui'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k), removeAll: (ks) => ks.forEach((k) => cache.delete(k)) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities,
    ContentService: { MimeType: { JSON: 'json', XML: 'xml' }, createTextOutput: (s) => ({ mime: 'text', setMimeType(m) { this.mime = m; return this; }, getContent: () => s }) },
    UrlFetchApp: { fetch: (url, opts = {}) => { const r = fetchHandler(url, opts); return { getResponseCode: () => r.code, getContentText: () => r.body }; } },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'link' }, Permission: { VIEW: 'view' },
      createFolder: (n) => ({ getId: () => 'folder1', name: n, createFile: (blob) => { const id = 'file' + files.size; files.set(id, blob); return { getId: () => id, setSharing() {} }; } }),
      getFolderById(id) { return this.createFolder(id); },
    },
    MailApp: { getRemainingDailyQuota: () => (gmail ? gmail.quota : 100) },
    GmailApp: { getAliases: () => (gmail ? gmail.aliases : []), sendEmail: (to, subject, text, opts) => { if (gmail && gmail.fail) throw new Error('gmail down'); (gmail ? gmail.sent : []).push({ to, subject, text, opts }); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'superwings.foundation@gmail.com' }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(file, 'utf8') + '\n;this.__exports={doPost,doGet,setup,runScheduled,reset:function(){for(const k in _tables)delete _tables[k];_ss=null;}};', ctx, { filename: 'Code.gs' });
  return { gas: ctx.__exports, book, props, cache, files };
}
