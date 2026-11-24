// End-to-end tests for apps-script/Code.gs using the mock Apps Script runtime.
import { loadGas } from './gas-mock.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const sent = []; let zeptoDown = false;
function fetchHandler(url, o) {
  if (url.startsWith('https://api.zeptomail.in/v1.1/email')) {
    if (zeptoDown) return { code: 500, body: '{"error":"down"}' };
    if (!o.headers.Authorization.startsWith('Zoho-enczapikey ')) throw new Error('bad zepto header');
    const b = JSON.parse(o.payload); sent.push({ via: 'zepto', to: b.to[0].email_address.address, from: b.from.address, subject: b.subject, html: b.htmlbody });
    return { code: 201, body: '{}' };
  }
  if (url.startsWith('https://accounts.zoho.in/oauth/v2/token')) {
    const pl = o.payload || {};
    if (pl.grant_type === 'authorization_code') return pl.code === '1000.aaa.bbb' ? { code: 200, body: JSON.stringify({ access_token: 'AT1', refresh_token: 'RT_NEW', expires_in: 3600 }) } : { code: 200, body: '{"error":"invalid_code"}' };
    if (pl.refresh_token && pl.refresh_token.startsWith('1000.')) return { code: 200, body: '{"error":"invalid_code"}' };
    return { code: 200, body: JSON.stringify({ access_token: 'AT1', expires_in: 3600 }) };
  }
  if (url === 'https://mail.zoho.in/api/accounts') return { code: 200, body: JSON.stringify({ data: [{ accountId: '555', primaryEmailAddress: 'contact@superwingsfoundation.org' }] }) };
  if (url.startsWith('https://mail.zoho.in/api/accounts/555/messages')) {
    const b = JSON.parse(o.payload); sent.push({ via: 'zoho', to: b.toAddress, from: b.fromAddress, subject: b.subject, html: b.content });
    return { code: 200, body: '{}' };
  }
  if (url.startsWith('https://api.github.com/')) { sent.push({ via: 'github', url }); return { code: 204, body: '' }; }
  throw new Error('unexpected fetch ' + url);
}
const gmail = { quota: 100, aliases: ['contact@superwingsfoundation.org'], sent: [], fail: false };
const { gas, book, props } = loadGas(ROOT + 'apps-script/Code.gs', { fetchHandler, gmail });

let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } };
function call(method, path, body, token) {
  gas.reset(); // each Apps Script request is a fresh execution
  const out = gas.doPost({ postData: { contents: JSON.stringify({ path, method, body, token }) } });
  return JSON.parse(out.getContent());
}
const sheet = (n) => book.getSheetByName(n);
const rowsOf = (n) => sheet(n).getLastRow() - 1;
const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();

console.log('\nSetup');
gas.reset(); gas.setup();
ok(sheet('users') && sheet('events') && !sheet('Sheet1'), 'sheets created');
const setupToken = props.get('SETUP_TOKEN');
ok(setupToken && setupToken.length === 10, 'setup token generated');
let r = call('GET', '/api/auth/status');
ok(r.ok && r.data.setupNeeded, 'setup needed');
r = call('POST', '/api/auth/setup', { token: 'nope', name: 'A', email: 'a@x.org', password: 'password123' });
ok(!r.ok && r.status === 403, 'wrong setup token rejected');
r = call('POST', '/api/auth/setup', { token: setupToken, name: 'Fenil Shah', email: 'admin@x.org', password: 'password123' });
ok(r.ok && r.data.token, 'first admin created with token');
const admin = r.data.token;
r = call('POST', '/api/auth/login', { email: 'ADMIN@x.org', password: 'password123' });
ok(r.ok && r.data.role === 'admin', 'login works (case-insensitive)');
r = call('POST', '/api/auth/login', { email: 'admin@x.org', password: 'bad' });
ok(!r.ok && r.status === 401, 'bad password rejected');
r = call('GET', '/api/admin/dashboard', null, 'garbage-token-xxxxxxxxxxxxxxxx');
ok(r.status === 401, 'invalid token rejected');

console.log('\nSettings (secrets in Script Properties, phone kept as text)');
r = call('PUT', '/api/admin/settings', { settings: { zepto_token: 'Zoho-enczapikey SECRET', contact_phone: '+91 99250 21383', reg_12a: 'AAA12A' } }, admin);
ok(r.ok, 'save settings');
ok(props.get('zepto_token') === 'Zoho-enczapikey SECRET' && !JSON.stringify(sheet('settings').data).includes('SECRET'), 'token stored outside the sheet');
r = call('GET', '/api/admin/settings', null, admin);
ok(r.data.settings.zepto_token === '••••••' && r.data.settings.contact_phone === '+91 99250 21383', 'token masked, phone intact');
call('PUT', '/api/admin/settings', { settings: { zepto_token: '••••••' } }, admin);
ok(props.get('zepto_token') === 'Zoho-enczapikey SECRET', 'mask keeps token');
call('POST', '/api/admin/senders', { address: 'events@superwingsfoundation.org', name: 'Superwings Events' }, admin);
call('POST', '/api/admin/senders', { address: 'contact@superwingsfoundation.org', name: 'Superwings Foundation', is_default: true }, admin);
r = call('GET', '/api/admin/senders', null, admin);
ok(r.data.senders.length === 2 && r.data.senders[0].address.startsWith('contact'), 'senders with default first');
const evSender = r.data.senders.find((s) => s.address.startsWith('events')).id;

console.log('\nEvents');
r = call('POST', '/api/admin/events', { title: 'Winter Literacy Drive 2026', subtitle: 'Reading camp', start_at: at(20), end_at: at(23), capacity: 3, reg_open: true,
  status: 'published', sender_id: evSender, venue: 'Thaltej Hall', agenda: [{ start_time: '10:00', title: 'Welcome' }, { start_time: '10:30', title: 'Reading circles' }, { title: '' }] }, admin);
ok(r.ok && r.data.slug === 'winter-literacy-drive-2026', 'create event', r);
const evId = r.data.id, slug = r.data.slug;
r = call('GET', '/api/events/' + slug);
ok(r.ok && r.data.agenda.length === 2 && r.data.event.seats_left === 3 && r.data.event.can_register, 'public event detail');
r = call('GET', '/api/site');
ok(r.data.events.length === 1, 'site payload lists event');
r = call('POST', `/api/events/${slug}/register`, { name: 'Asha Patel', email: 'asha@example.com', phone: '+91 98765 43210', consent: true });
ok(r.ok && r.data.code.length === 8, 'register');
ok(sent.at(-1).via === 'zepto' && sent.at(-1).from === 'events@superwingsfoundation.org' && sent.at(-1).html.includes(r.data.code), 'confirmation from event sender');
gas.reset();
ok(sheet('registrations').data[1][8] === '1' && sheet('registrations').data[1][5] === '+91 98765 43210', 'confirm flag + phone stored as text');
r = call('POST', `/api/events/${slug}/register`, { name: 'Dup', email: 'Asha@Example.com', consent: true });
ok(!r.ok && r.status === 400, 'duplicate blocked');
call('POST', `/api/events/${slug}/register`, { name: 'Ravi', email: 'ravi@example.com', consent: true });
call('POST', `/api/events/${slug}/register`, { name: 'Meera', email: 'meera@example.com', consent: true });
r = call('POST', `/api/events/${slug}/register`, { name: 'Late', email: 'late@example.com', consent: true });
ok(!r.ok && /full/.test(r.error), 'capacity enforced');
r = call('GET', `/api/admin/events/${evId}/registrations?format=csv`, null, admin);
ok(r.data.csv.includes('asha@example.com'), 'CSV export');
r = call('PUT', `/api/admin/events/${evId}`, { title: 'Winter Literacy Drive 2026', start_at: at(20), end_at: at(23), capacity: 3, reg_open: true, status: 'published',
  sender_id: evSender, agenda: [{ start_time: '09:30', title: 'Briefing' }, { start_time: '10:00', title: 'Welcome' }, { start_time: '10:30', title: 'Reading circles' }] }, admin);
r = call('GET', '/api/events/' + slug);
ok(r.data.agenda.length === 3 && r.data.agenda[0].title === 'Briefing', 'agenda replaced on update');

console.log('\nScheduled job');
let n0 = sent.length;
r = call('POST', '/api/admin/cron/run', {}, admin);
ok(r.data.reminders_queued === 3 && r.data.sent === 3, 'reminders sent', r.data);
gas.reset();
ok(sheet('registrations').data.slice(1).every((row) => row[9] === '1'), 'reminder flags set to sent');
r = call('POST', '/api/admin/cron/run', {}, admin);
ok(r.data.reminders_queued === 0, 'no duplicate reminders');
const evRow = sheet('events').data[1];
evRow[9] = at(-8); evRow[10] = at(-4);
r = call('POST', '/api/admin/cron/run', {}, admin);
ok(r.data.followups_queued === 3 && sent.slice(-3).every((m) => m.subject.startsWith('Thank you')), 'thank-you emails');
evRow[9] = at(-24 * 7 - 6); evRow[10] = at(-24 * 7 - 1);
r = call('POST', '/api/admin/cron/run', {}, admin);
ok(r.data.registrations_deleted === 3 && rowsOf('registrations') === 0, '7-day deletion', r.data);
gas.reset(); gas.runScheduled();
ok(true, 'time-trigger entry point runs');

console.log('\nZoho fallback');
call('PUT', '/api/admin/settings', { settings: { zoho_client_id: 'cid', zoho_client_secret: 'sec', zoho_refresh_token: 'rt' } }, admin);
r = call('POST', '/api/admin/email/zoho-account', {}, admin);
ok(r.ok && r.data.accountId === '555', 'fetch account id');
zeptoDown = true;
r = call('POST', '/api/admin/email/test', { to: 'admin@x.org' }, admin);
ok(r.data.ok && r.data.provider === 'zoho_mail' && sent.at(-1).via === 'zoho', 'falls back to Zoho', r.data);
zeptoDown = false;

console.log('\nVolunteers, partners, hours');
r = call('POST', '/api/partners', { name: 'Ahmedabad University', contact_name: 'SVP', email: 'svp@ahduni.edu.in', programme: 'VOL101' });
ok(r.ok, 'partner request');
r = call('PUT', '/api/admin/partners/1', { status: 'approved' }, admin);
ok(r.ok && sent.at(-1).subject.startsWith('Partnership confirmed'), 'partner approved + email');
r = call('GET', '/api/site');
ok(r.data.partners.length === 1, 'partner on site (cache busted)');
r = call('POST', '/api/volunteer/signup', { name: 'Riya', email: 'riya@s.org', password: 'riyapass1', programme: 'ibdp_cas' });
ok(!r.ok && /guardian/.test(r.error), 'guardian consent required');
r = call('POST', '/api/volunteer/signup', { name: 'Riya Shah', email: 'riya@s.org', password: 'riyapass1', programme: 'ibdp_cas', guardian_consent: true, institution: 'JGIS' });
ok(r.ok && r.data.token, 'student signs up with token');
const riya = r.data.token;
r = call('POST', '/api/me/activities', { date: '2026-11-20', hours: 2, title: 'x' }, riya);
ok(!r.ok, 'blocked before approval');
r = call('GET', '/api/admin/volunteers', null, admin);
const riyaId = r.data.volunteers[0].user_id;
call('PUT', '/api/admin/volunteers/' + riyaId, { status: 'approved' }, admin);
ok(sent.at(-1).subject.includes('approved'), 'approval email');
r = call('POST', '/api/me/activities', { date: '2026-11-20', hours: 2.5, title: 'Reading circle', strands: ['service', 'creativity', 'x'], outcomes: ['LO5', 'LO9'], reflection: 'Learned a lot' }, riya);
ok(r.ok, 'log activity');
r = call('GET', '/api/admin/activities', null, admin);
ok(r.data.activities[0].strands === 'service,creativity' && r.data.activities[0].outcomes === 'LO5', 'CAS tags validated');
call('PUT', '/api/admin/activities/' + r.data.activities[0].id, { status: 'approved' }, admin);
r = call('GET', '/api/me', null, riya);
ok(r.data.totals.approved === 2.5 && r.data.user.role_label === 'Student Volunteer', 'student totals');
r = call('POST', '/api/me/statement', {}, riya);
ok(r.ok && /^SWF\/HS\/\d{4}-\d{2}\/0001$/.test(r.data.document.ref_no) && r.data.document.data.total_hours === 2.5, 'student issues hours statement', r);
const st1 = r.data.document;
r = call('POST', '/api/me/statement', {}, riya);
ok(r.data.document.ref_no === st1.ref_no, 'same hours → same statement (no duplicates)');
r = call('GET', '/api/admin/settings', null, riya);
ok(r.status === 403, 'student blocked from admin');

console.log('\nPeople, users, donations, media, email');
call('POST', '/api/admin/people', { kind: 'trustee', name: 'Manushi Digesh Gajjar', title: 'Managing Trustee', message: 'Every child deserves wings.' }, admin);
r = call('GET', '/api/site');
ok(r.data.trustees[0].message.includes('wings'), 'trustee message on site');
r = call('POST', '/api/admin/users', { name: 'Coord', email: 'coord@x.org', role: 'coordinator' }, admin);
ok(r.data.emailed, 'invite emailed');
const tok = sent.at(-1).html.match(/reset=([a-f0-9]+)/)[1];
r = call('POST', '/api/auth/reset', { token: tok, password: 'coordpass1' });
ok(r.ok && r.data.token, 'invitee sets password');
const coord = r.data.token;
r = call('GET', '/api/admin/donations', null, coord);
ok(r.status === 403, 'coordinator blocked from donations');
r = call('POST', '/api/donations', { name: 'Kiran', email: 'kiran@e.com', amount: 5000, pan: 'abcde1234f', txn_ref: 'UPI1' });
ok(r.ok, 'donation pledge');
r = call('PUT', '/api/admin/donations/1', { status: 'received' }, admin);
ok(/^SWF\/RC\/\d{4}-\d{2}\/0001$/.test(r.data.receipt_no) && r.data.emailed && sent.at(-1).html.includes('AAA12A') && sent.at(-1).html.includes('/document?ref='), 'receipt issued on letterhead', r.data);
r = call('POST', '/api/admin/media', { mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }, admin);
ok(r.ok && r.data.url.startsWith('https://lh3.googleusercontent.com/d/'), 'image uploaded to Drive');
const many = Array.from({ length: 20 }, (_, i) => `p${i}@e.com`).join(',');
r = call('POST', '/api/admin/email/send', { to: many, subject: 'News', body: 'Hello', sender_id: evSender }, admin);
ok(r.data.queued === 20, 'bulk compose queued');
r = call('POST', '/api/admin/cron/run', {}, admin);
ok(r.data.sent === 20, 'queue drained');
r = call('POST', '/api/admin/email/preview', { subject: 'Hi', body: 'Hello' }, coord);
ok(r.data.html.includes('<!DOCTYPE html>'), 'preview html');

console.log('\nSitemap, export, GET routes, rebuild hook');
call('POST', '/api/admin/events', { title: 'Health Camp', start_at: at(100), end_at: at(104), status: 'published' }, admin);
gas.reset();
const sm = gas.doGet({ parameter: { action: 'sitemap' } }).getContent();
ok(sm.includes('<loc>https://superwingsfoundation.org/events/health-camp/</loc>') && sm.includes('<urlset'), 'sitemap.xml');
gas.reset();
const ex = JSON.parse(gas.doGet({ parameter: { action: 'export' } }).getContent());
ok(ex.ok && ex.data.events.length === 2 && !('sender_id' in ex.data.events[0]) && ex.data.events[0].agenda, 'build export');
gas.reset();
const g = JSON.parse(gas.doGet({ parameter: { path: '/api/events' } }).getContent());
ok(g.ok && g.data.events.length === 1, 'GET ?path= works');
props.set('GITHUB_TOKEN', 'ghp_x'); props.set('GITHUB_REPO', 'org/site');
call('POST', '/api/admin/events', { title: 'Tree Plantation', start_at: at(200), end_at: at(203), status: 'published' }, admin);
ok(sent.at(-1).via === 'github' && sent.at(-1).url.endsWith('/repos/org/site/dispatches'), 'rebuild requested on event change');
r = call('GET', '/api/nope');
ok(r.status === 404, 'unknown route 404');

console.log('\nOfficial documents & verification');
r = call('POST', '/api/admin/documents', { type: 'letter', title: 'Letter of Appreciation', recipient_name: 'Asha Patel', recipient_email: 'asha@example.com', body: 'Thank you.', send_email: true }, coord);
ok(r.ok && /^SWF\/LTR\//.test(r.data.document.ref_no) && r.data.emailed && sent.at(-1).subject.includes('SWF/LTR/'), 'coordinator issues letter + email');
const letter = r.data.document;
r = call('POST', '/api/admin/documents', { type: 'certificate', title: 'Certificate of Participation', recipient_name: 'Ravi', body: 'For participating.' }, admin);
ok(/^SWF\/CERT\/.*0001$/.test(r.data.document.ref_no), 'certificate numbered separately');
r = call('POST', '/api/admin/documents', { type: 'letter', title: 'Second', recipient_name: 'X', body: 'Y' }, admin);
ok(r.data.document.ref_no.endsWith('/0002'), 'numbers increase per type');
r = call('GET', '/api/verify?ref=' + encodeURIComponent(letter.ref_no.toLowerCase()) + '&code=' + letter.code.toLowerCase());
ok(r.ok && r.data.document.status === 'valid' && r.data.document.recipient_name === 'Asha Patel' && !('recipient_email' in r.data.document), 'public verify (no login, no email exposed)');
r = call('GET', '/api/verify?ref=' + encodeURIComponent(letter.ref_no) + '&code=WRONG123');
ok(!r.ok && r.status === 404, 'wrong code rejected');
r = call('GET', '/api/verify?ref=' + encodeURIComponent(st1.ref_no) + '&code=' + st1.code);
ok(r.data.document.data.activities.length === 1 && r.data.document.type_label === 'Volunteer Hours Statement', 'statement verifiable with snapshot');
r = call('GET', '/api/admin/documents', null, admin);
const lid = r.data.documents.find((d) => d.ref_no === letter.ref_no).id;
ok(r.data.documents.length === 5, 'register lists all documents');
r = call('PUT', '/api/admin/documents/' + lid, { status: 'revoked' }, admin);
ok(!r.ok, 'revoking needs a reason');
call('PUT', '/api/admin/documents/' + lid, { status: 'revoked', reason: 'Issued in error' }, admin);
r = call('GET', '/api/verify?ref=' + encodeURIComponent(letter.ref_no) + '&code=' + letter.code);
ok(r.data.document.status === 'revoked' && r.data.document.revoked_reason === 'Issued in error', 'revoked shows on verify');
r = call('PUT', '/api/admin/documents/' + lid, { status: 'revoked', reason: 'x' }, coord);
ok(r.status === 403, 'only trustees/admins revoke');
r = call('POST', '/api/admin/donations/1/document', {}, admin);
ok(/^SWF\/RC\//.test(r.data.document.ref_no) && r.data.document.data.amount === 5000, 'receipt document retrievable');
r = call('POST', '/api/admin/documents', { type: 'hours_statement', user_id: riyaId }, coord);
ok(r.data.document.ref_no === st1.ref_no, 'staff can open a student statement');

console.log('\nZoho one-time code');
call('PUT', '/api/admin/settings', { settings: { zoho_refresh_token: '1000.pasted.code' } }, admin);
r = call('POST', '/api/admin/email/zoho-account', {}, admin);
ok(!r.ok && /pasted instead of a refresh token/.test(r.error), 'pasted code gives a helpful error', r.error);
r = call('POST', '/api/admin/email/zoho-code', { code: 'hello' }, admin);
ok(!r.ok && /start with "1000\."/.test(r.error), 'rejects non-code input');
r = call('POST', '/api/admin/email/zoho-code', { code: '1000.dead.beef' }, admin);
ok(!r.ok && /Codes work once|works once|work once/.test(r.error), 'expired code explained', r.error);
r = call('POST', '/api/admin/email/zoho-code', { code: '1000.aaa.bbb' }, admin);
ok(r.ok && r.data.accountId === '555' && props.get('zoho_refresh_token') === 'RT_NEW', 'code exchanged for refresh token + account', r);

console.log('\nGmail fallback & health check');
zeptoDown = true;
call('PUT', '/api/admin/settings', { settings: { zoho_refresh_token: '' } }, admin);
r = call('POST', '/api/admin/email/test', { to: 'admin@x.org' }, admin);
ok(r.data.ok && r.data.provider === 'gmail' && gmail.sent.length === 1, 'falls back to Gmail when ZeptoMail and Zoho fail', r.data);
ok(gmail.sent[0].opts.from === 'contact@superwingsfoundation.org' && gmail.sent[0].opts.htmlBody.includes('<!DOCTYPE html>') && !gmail.sent[0].text.includes('<'), 'Gmail uses alias, HTML body and plain-text part');
r = call('POST', '/api/admin/email/test', { to: 'admin@x.org', sender_id: evSender }, admin);
ok(r.data.ok && !gmail.sent[1].opts.from && gmail.sent[1].opts.replyTo === 'contact@superwingsfoundation.org', 'non-alias sender falls back to account address with reply-to');
call('PUT', '/api/admin/settings', { settings: { gmail_enabled: '0' } }, admin);
r = call('POST', '/api/admin/email/test', { to: 'admin@x.org' }, admin);
ok(!r.data.ok && /turned off/.test(r.data.error), 'Gmail fallback can be switched off');
call('PUT', '/api/admin/settings', { settings: { gmail_enabled: '1', email_primary: 'gmail' } }, admin);
zeptoDown = false;
r = call('POST', '/api/admin/email/test', { to: 'admin@x.org' }, admin);
ok(r.data.provider === 'gmail', 'Gmail can be primary');
gmail.quota = 0;
r = call('POST', '/api/admin/email/test', { to: 'admin@x.org' }, admin);
ok(r.data.provider === 'zeptomail', 'skips Gmail when daily quota is used up');
r = call('GET', '/api/admin/email/gmail', null, admin);
ok(r.data.authorised && r.data.aliases.length === 1, 'Gmail status endpoint');
r = call('GET', '/api/admin/health', null, admin);
ok(r.ok && r.data.checks.find((c) => c.name === 'Sheet tabs').ok && r.data.checks.find((c) => c.name === 'Column headers').ok, 'health check passes', r.data);
sheet('users').data[0][1] = 'Email';
r = call('GET', '/api/admin/health', null, admin);
ok(!r.data.checks.find((c) => c.name === 'Column headers').ok, 'health check spots edited headers');
sheet('users').data[0][1] = 'email';
gas.reset(); const h = JSON.parse(gas.doGet({ parameter: { action: 'health' } }).getContent());
ok(h.ok && h.data.checks.length >= 7, 'public ?action=health works');
sheet('events').name = 'events_renamed';
r = call('GET', '/api/admin/events', null, admin);
ok(!r.ok && /Sheet "events" is missing/.test(r.error), 'server errors now explain the real cause', r.error);
sheet('events_renamed').name = 'events';

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
