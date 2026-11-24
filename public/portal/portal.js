// Superwings Foundation portal: trustees, admins, coordinators and student volunteers.
(() => {
  const { esc, api, bindForm, media, initials } = SW;
  let VIEW = document; // the section being rendered; queries are scoped to it so a section can render off-screen
  const $ = (s, r) => (r || VIEW).querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.getElementById('root');
  let ME = null;

  // ------------------------------------------------------------------ utilities
  function toast(msg, err) {
    const t = Object.assign(document.createElement('div'), { className: 'toast' + (err ? ' err' : ''), textContent: msg });
    document.body.append(t); setTimeout(() => t.remove(), 3200);
  }
  function modal(html) {
    const bg = Object.assign(document.createElement('div'), { className: 'modal-bg' });
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="x" aria-label="Close">×</button>${html}</div>`;
    const close = () => bg.remove();
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    $('.x', bg).onclick = close;
    document.body.append(bg);
    return { el: $('.modal', bg), close };
  }
  const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;
  // Dates can arrive as "2026-11-24", "2026-11-24 10:00:00" or full ISO. Never throw on a bad value.
  const toDate = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    const tries = [/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00+05:30' : s, s.replace(' ', 'T'), s.replace(' ', 'T') + 'Z'];
    for (const t of tries) { const x = new Date(t); if (!isNaN(x.getTime())) return x; }
    return null;
  };
  const fmtSafe = (v, o) => { const x = toDate(v); if (!x) return v ? String(v) : ''; try { return SW.fmt(x.toISOString(), o); } catch { return String(v); } };
  const dt = (v) => fmtSafe(v, { dateStyle: 'medium', timeStyle: 'short' });
  const d = (v) => fmtSafe(v, { dateStyle: 'medium' });
  const toInput = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 16) : '');
  const fromInput = (v) => (v ? `${v}:00+05:30` : '');
  const sel = (name, opts, val) => `<select name="${name}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const LEAD = ['admin', 'trustee'], STAFF = ['admin', 'trustee', 'coordinator'];
  const isLead = () => LEAD.includes(ME.role);
  async function wrap(fn) { try { return await fn(); } catch (e) { toast(e.message, true); } }

  async function resizeImage(file, max = 1600, square = false) {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    let sw = img.width, sh = img.height, sx = 0, sy = 0;
    if (square) { const m = Math.min(sw, sh); sx = (sw - m) / 2; sy = (sh - m) / 2; sw = sh = m; }
    const scale = Math.min(1, max / Math.max(sw, sh));
    const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    let q = 0.85, out = c.toDataURL('image/jpeg', q);
    while (out.length > 1_300_000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
    return out;
  }
  // image picker: <div data-img="fieldname" data-square> … hidden input keeps the media id
  function imgPicker(name, id, { square = false, max = 1600, label = 'Upload image' } = {}) {
    return `<div class="img-pick" data-img="${name}" ${square ? 'data-square' : ''} data-max="${max}">
      <div class="prev ${square ? 'sq' : ''}" style="${id ? `background-image:url(${media(id)})` : ''}"></div>
      <div class="bar"><label class="btn light sm" style="cursor:pointer">${label}<input type="file" accept="image/*" hidden></label>
      <button type="button" class="btn light sm" data-clear ${id ? '' : 'hidden'}>Remove</button></div>
      <input type="hidden" name="${name}" value="${esc(id || '')}"></div>`;
  }
  function wireImgPickers(scope) {
    scope.querySelectorAll('[data-img]').forEach((box) => {
      const file = $('input[type=file]', box), hidden = $('input[type=hidden]', box), prev = $('.prev', box), clr = $('[data-clear]', box);
      file.onchange = async () => {
        if (!file.files[0]) return;
        prev.style.opacity = '.4';
        try {
          const data = await resizeImage(file.files[0], Number(box.dataset.max), box.hasAttribute('data-square'));
          const r = await api('/api/admin/media', { body: { mime: 'image/jpeg', data } });
          hidden.value = r.id; prev.style.backgroundImage = `url(${r.url})`; clr.hidden = false;
        } catch (e) { toast(e.message, true); } finally { prev.style.opacity = ''; }
      };
      clr.onclick = () => { hidden.value = ''; prev.style.backgroundImage = ''; clr.hidden = true; };
    });
  }

  // ------------------------------------------------------------------ auth screens
  function authShell(title, sub, inner) {
    VIEW = document; window.onhashchange = null;
    root.innerHTML = `<div class="auth"><div class="auth-card"><a href="/"><img class="logo" src="/assets/logo.jpg" alt="Superwings Foundation"></a>
      <h1>${title}</h1><p class="sub">${sub}</p>${inner}</div></div>`;
  }
  function loginScreen(msg) {
    authShell('Sign in', 'Trustees, coordinators and volunteers', `${msg ? `<div class="alert ok" style="margin-bottom:14px">${esc(msg)}</div>` : ''}
      <form class="form" id="f"><label class="f">Email<input name="email" type="email" required autocomplete="username"></label>
      <label class="f">Password<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn btn-primary" type="submit">Sign in</button></form>
      <div class="links"><a id="forgot">Forgot password?</a><a href="/volunteer#join">New volunteer? Sign up</a></div>`);
    bindForm($('#f'), async (b) => { await api('/api/auth/login', { body: b }); location.hash = ''; boot(); });
    $('#forgot').onclick = forgotScreen;
  }
  function forgotScreen() {
    authShell('Reset password', 'We will email you a link to set a new password', `<form class="form" id="f">
      <label class="f">Email<input name="email" type="email" required></label><button class="btn btn-primary" type="submit">Send link</button></form>
      <div class="links"><a id="back">← Back to sign in</a></div>`);
    bindForm($('#f'), async (b) => { await api('/api/auth/forgot', { body: b }); loginScreen('If that email has an account, a reset link is on its way.'); });
    $('#back').onclick = () => loginScreen();
  }
  function resetScreen(token) {
    authShell('Set your password', 'Choose a password with at least 8 characters', `<form class="form" id="f">
      <label class="f">New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label class="f">Confirm password<input name="confirm" type="password" required autocomplete="new-password"></label>
      <button class="btn btn-primary" type="submit">Save and sign in</button></form>`);
    bindForm($('#f'), async (b) => {
      if (b.password !== b.confirm) throw new Error('Passwords do not match');
      await api('/api/auth/reset', { body: { token, password: b.password } });
      history.replaceState(null, '', '/portal/'); boot();
    });
  }
  function setupScreen() {
    authShell('Welcome! Set up the portal', 'Create the first administrator account', `<form class="form" id="f">
      <label class="f">Setup token <span class="hint">The SETUP_TOKEN secret you set in Cloudflare</span><input name="token" required></label>
      <label class="f">Your name<input name="name" required></label><label class="f">Email<input name="email" type="email" required></label>
      <label class="f">Password<input name="password" type="password" minlength="8" required></label>
      <button class="btn btn-primary" type="submit">Create administrator</button></form>`);
    bindForm($('#f'), async (b) => { await api('/api/auth/setup', { body: b }); boot(); });
  }
  async function logout() { try { await api('/api/auth/logout', { body: {} }); } catch { /* signed out locally anyway */ } SW.token.clear(); SW.clearCache(); ME = null; history.replaceState(null, '', '/portal/'); loginScreen('You have signed out.'); }

  // ------------------------------------------------------------------ shell
  let navSeq = 0, lastView = null;
  const calm = (title, text, retry) => `<div class="panel" style="text-align:center;padding:48px 24px"><h2>${esc(title)}</h2><p class="muted" style="margin:8px 0 18px">${esc(text)}</p>${retry ? '<button class="btn btn-primary sm" data-retry>Try again</button>' : ''}</div>`;
  const skel = '<div class="sk sk-line" style="width:240px;height:34px;margin-bottom:22px"></div><div class="stats">' + '<div class="sk" style="height:96px"></div>'.repeat(4) + '</div><div class="sk sk-block"></div>';
  function shell(items, render) {
    VIEW = document;
    root.innerHTML = `<div class="progress" id="prog"></div><div class="app"><aside class="side"><a class="logo-pill" href="/" target="_blank"><img src="/assets/logo.jpg" alt="Superwings Foundation"></a>
      <nav id="nav"></nav><div class="me"><strong>${esc(ME.name)}</strong>${esc(ME.role_label || ME.role)}<br><a href="#account">Account</a><a id="logout">Sign out</a></div></aside>
      <div><div class="mobile-nav" id="mnav"></div><main class="main" id="main">${skel}</main></div></div>`;
    document.getElementById('logout').onclick = logout;
    const prog = document.getElementById('prog');
    const draw = async () => {
      const seq = ++navSeq;
      const [path] = location.hash.slice(1).split('?');
      const [view, ...args] = (path || items[0][0]).split('/');
      const links = items.map(([k, t, sep]) => (sep ? `<div class="sep">${sep}</div>` : '') + `<a href="#${k}" class="${k === view ? 'on' : ''}">${t}</a>`).join('');
      document.getElementById('nav').innerHTML = links;
      document.getElementById('mnav').innerHTML = items.map(([k, t]) => `<a href="#${k}" class="${k === view ? 'on' : ''}">${t}</a>`).join('') + '<a id="mlogout">Sign out</a>';
      document.getElementById('mlogout').onclick = logout;
      document.querySelectorAll('#nav a, #mnav a[href]').forEach((a) => a.addEventListener('click', () => { if (a.getAttribute('href') === '#' + (location.hash.slice(1) || items[0][0])) { SW.clearCache(); draw(); } }));
      lastView = view;
      prog.className = 'progress on';
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const next = Object.assign(document.createElement('main'), { className: 'main', id: 'main' });
        VIEW = next;
        try {
          await render(view, args, next);
          if (seq !== navSeq) return;
          document.getElementById('main').replaceWith(next);
          next.classList.add('fade-in'); window.scrollTo({ top: 0 }); prog.className = 'progress';
          return;
        } catch (e) {
          if (seq !== navSeq) return;
          if (e.status === 401) { SW.token.clear(); return loginScreen('Your session has ended. Please sign in again.'); }
          if (!e.network) { // the server answered with a reason: show it instead of retrying
            next.innerHTML = calm(e.status === 403 ? 'Not available for your role' : e.status === 404 ? 'Not found' : 'This section could not load', e.message, e.status >= 500);
            const rb = next.querySelector('[data-retry]'); if (rb) rb.onclick = () => { SW.clearCache(); draw(); };
            document.getElementById('main').replaceWith(next); prog.className = 'progress';
            return;
          }
          lastErr = e;
          console.warn('Section load failed:', e);
          await sleep(700 * (attempt + 1));
          if (seq !== navSeq) return;
        }
      }
      prog.className = 'progress';
      const cur = document.getElementById('main');
      if (cur.querySelector('.sk') || !cur.textContent.trim()) {
        cur.innerHTML = calm('Still connecting…', lastErr ? lastErr.message : 'The server is taking longer than usual to respond.', true);
        cur.querySelector('[data-retry]').onclick = draw;
      } else toast('Could not load this section: ' + (lastErr ? lastErr.message : 'no response') + (isLead() ? ' (see Settings → System check)' : ''), true);
    };
    window.onhashchange = draw;
    draw();
  }
  const top = (title, actions = '') => `<div class="topbar"><h1>${title}</h1><div class="bar">${actions}</div></div>`;

  // ================================================================== STAFF
  async function staffApp() {
    const me = await api('/api/me'); Object.assign(ME, me.user);
    const items = [
      ['dashboard', 'Dashboard', 'Overview'], ['events', 'Events'], ['volunteers', 'Volunteers', 'Volunteer programme'], ['hours', 'Hours review'], ['partners', 'Partner institutions'],
      ['email', 'Email', 'Communication'],
      ...(isLead() ? [['people', 'Trustees & team', 'Organisation'], ['donations', 'Donations'], ['users', 'Portal users'], ['settings', 'Settings']] : []),
      ['account', 'My account'],
    ];
    const views = { dashboard, events, volunteers, hours, partners, email: emailView, people, donations, users, settings, account };
    shell(items, (v, args, main) => (views[v] || dashboard)(main, args));
    // warm the most used sections in the background so switching feels instant
    setTimeout(async () => {
      for (const p of ['/api/admin/events', '/api/admin/volunteers', '/api/admin/activities?status=pending', '/api/admin/senders', '/api/admin/partners']) {
        try { await api(p); } catch { /* fine */ }
      }
    }, 1200);
  }

  async function dashboard(main) {
    const s = await api('/api/admin/dashboard');
    const ready = s.email_ready.zeptomail || s.email_ready.zoho_mail;
    main.innerHTML = top(`Hello, ${esc(ME.name.split(' ')[0])}`) +
      (!ready && isLead() ? `<div class="notice"><strong>Email is not connected yet.</strong> Registration confirmations, reminders and receipts cannot be sent until you connect ZeptoMail or the Zoho Mail self-client. <a href="#settings/email" style="color:var(--green);font-weight:800">Connect email →</a></div>` : '') +
      (s.failed_emails_7d ? `<div class="notice">${s.failed_emails_7d} email(s) failed in the last 7 days. <a href="#email/log" style="color:var(--green);font-weight:800">See log →</a></div>` : '') +
      `<div class="stats">
        <div class="stat" onclick="location.hash='events'"><b>${s.upcoming_events}</b><span>Upcoming events</span></div>
        <div class="stat" onclick="location.hash='events'"><b>${s.registrations}</b><span>Event registrations</span></div>
        <div class="stat ${s.pending_volunteers ? 'hot' : ''}" onclick="location.hash='volunteers'"><b>${s.pending_volunteers}</b><span>Volunteer applications</span></div>
        <div class="stat ${s.pending_activities ? 'hot' : ''}" onclick="location.hash='hours'"><b>${s.pending_activities}</b><span>Hours to verify</span></div>
        <div class="stat ${s.pending_partners ? 'hot' : ''}" onclick="location.hash='partners'"><b>${s.pending_partners}</b><span>Partnership requests</span></div>
        <div class="stat" onclick="location.hash='volunteers'"><b>${s.active_volunteers}</b><span>Active volunteers</span></div>
        <div class="stat" onclick="location.hash='hours'"><b>${Number(s.verified_hours).toLocaleString('en-IN')}</b><span>Verified service hours</span></div>
        ${isLead() ? `<div class="stat ${s.pending_donations ? 'hot' : ''}" onclick="location.hash='donations'"><b>${s.pending_donations}</b><span>Donations to confirm</span></div>` : ''}
      </div>
      <div class="panel"><h2>Quick actions</h2><div class="bar">
        <a class="btn btn-primary sm" href="#events/new">New event</a><a class="btn light sm" href="#email">Compose email</a>
        ${isLead() ? '<a class="btn light sm" href="#people">Edit trustees & team</a><a class="btn light sm" href="#settings">Settings</a>' : ''}
        <a class="btn light sm" href="/" target="_blank">View website ↗</a></div></div>`;
  }

  // ------------------------------------------------------------------ events
  async function events(main, [id, sub]) {
    if (id === 'new') return eventEditor(main, null);
    if (id) return eventEditor(main, Number(id), sub);
    const { events: list } = await api('/api/admin/events');
    const now = new Date().toISOString();
    main.innerHTML = top('Events', '<a class="btn btn-primary sm" href="#events/new">+ New event</a>') + `<div class="panel tw">
      ${list.length ? `<table class="t"><thead><tr><th>Event</th><th>When</th><th>Status</th><th>Registrations</th><th></th></tr></thead><tbody>
      ${list.map((e) => `<tr class="click" onclick="location.hash='events/${e.id}'"><td><strong>${esc(e.title)}</strong><div class="muted" style="font-size:.8rem">/events/${esc(e.slug)}</div></td>
        <td>${esc(dt(e.start_at))}${e.end_at < now ? ' <span class="pill">past</span>' : ''}</td><td>${pill(e.status)}${e.reg_open ? '' : ' <span class="pill cancelled">reg. closed</span>'}</td>
        <td>${e.registrations}${e.capacity ? ' / ' + e.capacity : ''}</td><td><a href="/events/${esc(e.slug)}" target="_blank" onclick="event.stopPropagation()">View ↗</a></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty-s">No events yet. Create your first one.</div>'}</div>`;
  }

  function agendaRow(a = {}) {
    return `<div class="agenda-row"><input name="a_start" placeholder="10:00" value="${esc(a.start_time || '')}"><input name="a_end" placeholder="10:30" value="${esc(a.end_time || '')}">
      <input name="a_title" placeholder="Session title" value="${esc(a.title || '')}"><input name="a_speaker" placeholder="Speaker / lead (optional)" value="${esc(a.speaker || '')}">
      <div class="ctl" style="grid-row:span 2"><button type="button" data-up title="Move up">↑</button><button type="button" data-down title="Move down">↓</button><button type="button" data-del title="Remove">✕</button></div>
      <textarea name="a_desc" placeholder="Short description (optional)">${esc(a.description || '')}</textarea></div>`;
  }

  async function eventEditor(main, id, sub) {
    const [{ senders }, data] = await Promise.all([api('/api/admin/senders'), id ? api('/api/admin/events/' + id) : Promise.resolve({ event: { status: 'draft', reg_open: 1 }, agenda: [] })]);
    const e = data.event;
    const tabs = id ? `<div class="subtabs"><button data-t="details" class="${!sub ? 'on' : ''}">Details & agenda</button><button data-t="registrations" class="${sub === 'registrations' ? 'on' : ''}">Registrations</button><button data-t="email" class="${sub === 'email' ? 'on' : ''}">Email registrants</button></div>` : '';
    main.innerHTML = top(id ? esc(e.title) : 'New event', `<a class="btn light sm" href="#events">← All events</a>${id ? `<a class="btn light sm" href="/events/${esc(e.slug)}" target="_blank">View page ↗</a>` : ''}`) + tabs + '<div id="ev-body"></div>';
    main.querySelectorAll('.subtabs button').forEach((b) => (b.onclick = () => (location.hash = `events/${id}${b.dataset.t === 'details' ? '' : '/' + b.dataset.t}`)));
    const body = $('#ev-body');
    if (sub === 'registrations') return eventRegs(body, id, e);
    if (sub === 'email') return eventEmail(body, id, e, senders);

    body.innerHTML = `<form class="form" id="ef">
      <div class="panel"><h2>Basics</h2><div class="form">
        <label class="f">Title<input name="title" required value="${esc(e.title || '')}"></label>
        <label class="f">Short tagline<input name="subtitle" value="${esc(e.subtitle || '')}" placeholder="One line shown under the title"></label>
        <div class="row"><label class="f">Web address <span class="hint">superwingsfoundation.org/events/…</span><input name="slug" value="${esc(e.slug || '')}" placeholder="auto from title"></label>
        <label class="f">Status${sel('status', [['draft', 'Draft (hidden)'], ['published', 'Published']], e.status)}</label></div>
        <label class="f">Cover image <span class="hint">Wide image, at least 1600 px across</span>${imgPicker('cover_id', e.cover_id, { label: 'Upload cover' })}</label>
        <label class="f">About the event <span class="hint">Plain text. Leave a blank line between paragraphs. Links work.</span><textarea name="description" style="min-height:180px">${esc(e.description || '')}</textarea></label>
      </div></div>
      <div class="panel"><h2>When & where</h2><div class="form">
        <div class="row"><label class="f">Starts (IST)<input type="datetime-local" name="start_at" required value="${toInput(e.start_at)}"></label>
        <label class="f">Ends (IST)<input type="datetime-local" name="end_at" required value="${toInput(e.end_at)}"></label></div>
        <div class="row"><label class="f">Venue<input name="venue" value="${esc(e.venue || '')}"></label><label class="f">Address<input name="address" value="${esc(e.address || '')}"></label></div>
        <label class="f">Google Maps link<input name="map_url" value="${esc(e.map_url || '')}" placeholder="https://maps.app.goo.gl/…"></label>
      </div></div>
      <div class="panel"><h2>Agenda</h2><p class="muted" style="font-size:.9rem;margin-bottom:12px">Add sessions in time order. Times are shown exactly as typed.</p>
        <div id="agenda">${(data.agenda.length ? data.agenda : [{}]).map(agendaRow).join('')}</div>
        <button type="button" class="btn light sm" id="add-ag">+ Add session</button></div>
      <div class="panel"><h2>Registration & emails</h2><div class="form">
        <div class="row"><label class="f">Capacity <span class="hint">Leave empty for unlimited</span><input type="number" min="1" name="capacity" value="${esc(e.capacity ?? '')}"></label>
        <label class="f">Send event emails from${sel('sender_id', [['', 'Default sender'], ...senders.map((s) => [s.id, `${s.name} <${s.address}>`])], e.sender_id)}</label></div>
        <label class="check"><input type="checkbox" name="reg_open" ${e.reg_open ? 'checked' : ''}><span>Registration is open</span></label>
        <div class="help">Everyone who registers gets a confirmation at once, a reminder before the event and a thank-you after it. Registration data is <strong>deleted automatically 7 days after the event ends</strong>. Download the CSV before then if you need it.</div>
      </div></div>
      <div class="bar"><button class="btn btn-primary" type="submit">${id ? 'Save changes' : 'Create event'}</button>
      ${id && isLead() ? '<span class="spacer"></span><button type="button" class="btn danger sm" id="del">Delete event</button>' : ''}</div>
    </form>`;
    wireImgPickers(body);
    const ag = $('#agenda');
    $('#add-ag').onclick = () => ag.insertAdjacentHTML('beforeend', agendaRow());
    ag.onclick = (ev) => {
      const row = ev.target.closest('.agenda-row'); if (!row) return;
      if (ev.target.matches('[data-del]')) row.remove();
      if (ev.target.matches('[data-up]') && row.previousElementSibling) row.after(row.previousElementSibling);
      if (ev.target.matches('[data-down]') && row.nextElementSibling) row.nextElementSibling.after(row);
    };
    bindForm($('#ef'), async (b) => {
      const agenda = [...ag.querySelectorAll('.agenda-row')].map((r) => ({
        start_time: $('[name=a_start]', r).value, end_time: $('[name=a_end]', r).value, title: $('[name=a_title]', r).value,
        speaker: $('[name=a_speaker]', r).value, description: $('[name=a_desc]', r).value,
      }));
      const payload = { ...b, start_at: fromInput(b.start_at), end_at: fromInput(b.end_at), agenda };
      const r = id ? await api('/api/admin/events/' + id, { method: 'PUT', body: payload }) : await api('/api/admin/events', { body: payload });
      toast(id ? 'Event saved' : 'Event created');
      if (!id) location.hash = 'events/' + r.id; else eventEditor(main, id);
    });
    const del = $('#del');
    if (del) del.onclick = () => wrap(async () => {
      if (!confirm('Delete this event, its agenda and all registrations? This cannot be undone.')) return;
      await api('/api/admin/events/' + id, { method: 'DELETE' }); toast('Event deleted'); location.hash = 'events';
    });
  }

  async function eventRegs(body, id, e) {
    const { registrations: rs } = await api(`/api/admin/events/${id}/registrations`);
    const flag = (v) => (v === 1 ? '✓' : v === 2 ? '…' : '–');
    body.innerHTML = `<div class="panel"><div class="bar" style="margin-bottom:14px"><strong>${rs.length} registered${e.capacity ? ` of ${e.capacity}` : ''}</strong><span class="spacer"></span>
      <button class="btn light sm" id="csv">Download CSV</button></div>
      <p class="muted" style="font-size:.86rem;margin-bottom:12px">Deleted automatically 7 days after the event (${esc(d(new Date(new Date(e.end_at).getTime() + 7 * 864e5).toISOString()))}). Email columns: ✓ sent · … queued · – not yet.</p>
      <div class="tw">${rs.length ? `<table class="t"><thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Organisation</th><th>Notes</th><th title="Confirmation / reminder / thank-you">Emails</th><th></th></tr></thead><tbody>
      ${rs.map((r) => `<tr><td><code>${esc(r.code)}</code></td><td>${esc(r.name)}</td><td>${esc(r.email)}<br><span class="muted">${esc(r.phone || '')}</span></td><td>${esc(r.organisation || '')}</td>
        <td style="max-width:220px">${esc(r.notes || '')}</td><td>${flag(r.confirm_sent)} ${flag(r.reminder_sent)} ${flag(r.followup_sent)}</td>
        <td><button class="btn danger sm" data-del="${r.id}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty-s">No registrations yet.</div>'}</div></div>`;
    $('#csv', body).onclick = () => wrap(async () => {
      const { csv } = await api(`/api/admin/events/${id}/registrations?format=csv`);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' })), download: `registrations-${e.slug}.csv` });
      document.body.append(a); a.click(); a.remove();
    });
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => wrap(async () => {
      if (!confirm('Remove this registration?')) return;
      await api('/api/admin/registrations/' + b.dataset.del, { method: 'DELETE' }); eventRegs(body, id, e);
    })));
  }

  function eventEmail(body, id, e, senders) {
    body.innerHTML = `<div class="panel"><h2>Email everyone registered</h2><form class="form" id="bf">
      <label class="f">From${sel('sender_id', [['', 'Event default'], ...senders.map((s) => [s.id, `${s.name} <${s.address}>`])], e.sender_id)}</label>
      <label class="f">Subject<input name="subject" required value="Update: ${esc(e.title)}"></label>
      <label class="f">Heading inside the email<input name="title" placeholder="Defaults to the subject"></label>
      <label class="f">Message <span class="hint">“Dear &lt;name&gt;,” is added automatically. Blank line = new paragraph.</span><textarea name="body" required style="min-height:200px"></textarea></label>
      <button class="btn btn-primary" type="submit">Send to all registrants</button></form></div>`;
    bindForm($('#bf'), async (b) => {
      if (!confirm('Send this email to everyone registered for the event?')) return;
      const r = await api(`/api/admin/events/${id}/email`, { body: b });
      toast(`Queued ${r.queued}, sent ${r.sent_now} now. The rest go out within 5 minutes.`);
    });
  }

  // ------------------------------------------------------------------ volunteers
  async function volunteers(main, [uid]) {
    const status = new URLSearchParams(location.hash.split('?')[1] || '').get('s') || '';
    const { volunteers: list } = await api('/api/admin/volunteers' + (status ? '?status=' + status : ''));
    main.innerHTML = top('Volunteers', `<select id="vs" class="btn light sm">${[['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([v, t]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${t}</option>`).join('')}</select>`) +
      `<div class="panel tw">${list.length ? `<table class="t"><thead><tr><th>Volunteer</th><th>Programme</th><th>Institution</th><th>Verified hours</th><th>Status</th><th>Joined</th></tr></thead><tbody>
      ${list.map((v) => `<tr class="click" data-u="${v.user_id}"><td><strong>${esc(v.name)}</strong><br><span class="muted">${esc(v.email)}</span></td><td>${esc(v.programme_label)}</td>
        <td>${esc(v.partner_name || v.institution || '')}${v.grade ? `<br><span class="muted">${esc(v.grade)}</span>` : ''}</td><td>${v.hours}</td><td>${pill(v.status)}</td><td>${esc(d(v.created_at))}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty-s">No volunteers here yet. Share <a href="/volunteer#join" target="_blank">the sign-up page</a>.</div>'}</div>`;
    $('#vs').onchange = (e) => (location.hash = 'volunteers' + (e.target.value ? '?s=' + e.target.value : ''));
    main.querySelectorAll('[data-u]').forEach((tr) => (tr.onclick = () => volunteerModal(Number(tr.dataset.u), () => volunteers(main, []))));
    if (uid) volunteerModal(Number(uid), () => volunteers(main, []));
  }

  async function volunteerModal(uid, refresh) {
    const { profile: p, activities, totals } = await api('/api/admin/volunteers/' + uid);
    const m = modal(`<h2 style="font-size:1.6rem">${esc(p.name)} ${pill(p.status)}</h2><p class="muted">${esc(p.programme_label)}</p>
      <div class="cols" style="margin:16px 0"><div class="help" style="background:#f7faf5">
        <strong>Contact</strong><br>${esc(p.email)}<br>${esc(p.phone || '')}<br><br><strong>Institution</strong><br>${esc(p.partner_name || p.institution || '—')} ${esc(p.grade || '')}
        <br><br><strong>Supervisor</strong><br>${esc(p.supervisor_name || '—')} ${esc(p.supervisor_email || '')}</div>
        <div class="help"><strong>Interests</strong><br>${esc(p.interests || '—')}<br><br><strong>Availability</strong><br>${esc(p.availability || '—')}
        <br><br><strong>Guardian consent</strong> ${p.guardian_consent ? 'Yes' : 'Not needed / not given'}</div></div>
      <div class="bar" style="margin-bottom:16px"><span class="big-num" style="font-size:2rem">${totals.approved}</span><span class="muted">verified hours · ${totals.pending} pending</span><span class="spacer"></span>
        <a class="btn light sm" target="_blank" href="/portal/certificate.html?u=${uid}">Hours statement ↗</a></div>
      <label class="f">Note to the volunteer (optional, included in the email)<textarea id="vnote" style="min-height:70px"></textarea></label>
      <div class="bar" style="margin:12px 0 22px"><button class="btn btn-primary sm" data-s="approved">Approve</button><button class="btn danger sm" data-s="rejected">Decline</button><button class="btn light sm" data-s="pending">Mark pending</button></div>
      <h3>Activities</h3>${activities.length ? activities.map(actCard).join('') : '<p class="muted">No activities logged yet.</p>'}`);
    m.el.querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => wrap(async () => {
      await api('/api/admin/volunteers/' + uid, { method: 'PUT', body: { status: b.dataset.s, note: $('#vnote', m.el).value } });
      toast('Volunteer updated'); m.close(); refresh();
    })));
  }

  const STRAND = { creativity: 'Creativity', activity: 'Activity', service: 'Service' };
  function actCard(a, actions = '') {
    const tags = [...(a.strands ? a.strands.split(',').map((s) => STRAND[s]) : []), ...(a.outcomes ? a.outcomes.split(',') : [])];
    return `<div class="act"><div class="h"><strong>${esc(a.title)}</strong>${pill(a.status)}<span class="spacer"></span><span class="meta">${esc(d(a.date))} · ${a.hours} h</span></div>
      ${a.name ? `<div class="meta">${esc(a.name)} · ${esc(a.programme_label || '')}</div>` : ''}
      ${tags.length ? `<div class="tagset">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      ${a.description ? `<p style="font-size:.92rem;margin-top:8px">${esc(a.description)}</p>` : ''}
      ${a.reflection ? `<div class="refl"><strong>Reflection:</strong> ${esc(a.reflection)}</div>` : ''}
      ${a.review_note ? `<div class="meta" style="margin-top:6px">Coordinator note: ${esc(a.review_note)}</div>` : ''}${actions}</div>`;
  }

  async function hours(main, [st = 'pending']) {
    const { activities } = await api('/api/admin/activities?status=' + st);
    main.innerHTML = top('Hours review') + `<div class="subtabs">${['pending', 'approved', 'rejected'].map((s) => `<button class="${s === st ? 'on' : ''}" onclick="location.hash='hours/${s}'">${s === 'pending' ? 'To verify' : s === 'approved' ? 'Verified' : 'Returned'}</button>`).join('')}</div>
      <div id="acts">${activities.length ? activities.map((a) => actCard(a, st === 'pending' ? `<div class="bar" style="margin-top:12px"><input class="f" data-note placeholder="Note (optional)" style="flex:1;min-width:200px;font:inherit;padding:.5rem .8rem;border:1.5px solid var(--line);border-radius:10px">
        <button class="btn btn-primary sm" data-a="${a.id}" data-s="approved">Verify</button><button class="btn danger sm" data-a="${a.id}" data-s="rejected">Return</button></div>` : '')).join('') : '<div class="panel empty-s">Nothing here.</div>'}</div>`;
    main.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => wrap(async () => {
      const note = $('[data-note]', b.closest('.act')).value;
      if (b.dataset.s === 'rejected' && !note) { toast('Add a note explaining what to change', true); return; }
      await api('/api/admin/activities/' + b.dataset.a, { method: 'PUT', body: { status: b.dataset.s, review_note: note } });
      b.closest('.act').remove(); toast(b.dataset.s === 'approved' ? 'Verified' : 'Returned to volunteer');
    })));
  }

  // ------------------------------------------------------------------ partners
  async function partners(main) {
    const { partners: list } = await api('/api/admin/partners');
    main.innerHTML = top('Partner institutions') + `<div class="panel tw">${list.length ? `<table class="t"><thead><tr><th>Institution</th><th>Contact</th><th>Programme</th><th>Students</th><th>Status</th></tr></thead><tbody>
      ${list.map((p) => `<tr class="click" data-p="${p.id}"><td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.type)}</span></td><td>${esc(p.contact_name || '')}<br><span class="muted">${esc(p.email || '')} ${esc(p.phone || '')}</span></td>
        <td>${esc(p.programme || '')}</td><td>${p.students_joined} joined${p.students ? ` / ${p.students} expected` : ''}</td><td>${pill(p.status)}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty-s">No partnership requests yet. Institutions can apply at <a href="/volunteer#partner" target="_blank">/volunteer#partner</a>.</div>'}</div>`;
    main.querySelectorAll('[data-p]').forEach((tr) => (tr.onclick = () => {
      const p = list.find((x) => x.id === Number(tr.dataset.p));
      const m = modal(`<h2 style="font-size:1.5rem;margin-bottom:12px">${esc(p.name)}</h2>${p.message ? `<div class="help" style="margin-bottom:14px">${esc(p.message)}</div>` : ''}
        <form class="form" id="pf"><div class="row"><label class="f">Name<input name="name" value="${esc(p.name)}" required></label><label class="f">Type${sel('type', [['university', 'University'], ['school', 'School'], ['organisation', 'Organisation']], p.type)}</label></div>
        <div class="row"><label class="f">Contact person<input name="contact_name" value="${esc(p.contact_name || '')}"></label><label class="f">Email<input name="email" value="${esc(p.email || '')}"></label></div>
        <div class="row"><label class="f">Phone<input name="phone" value="${esc(p.phone || '')}"></label><label class="f">Programme<input name="programme" value="${esc(p.programme || '')}"></label></div>
        <label class="f">Logo${imgPicker('logo_id', p.logo_id, { max: 400, label: 'Upload logo' })}</label>
        <label class="f">Status${sel('status', [['pending', 'Pending'], ['approved', 'Approved (shown on website, students can pick it)'], ['rejected', 'Declined']], p.status)}</label>
        <label class="check"><input type="checkbox" name="notify" checked><span>Email the contact person when the status changes</span></label>
        <div class="bar"><button class="btn btn-primary" type="submit">Save</button>${isLead() ? '<span class="spacer"></span><button type="button" class="btn danger sm" id="pdel">Delete</button>' : ''}</div></form>`);
      wireImgPickers(m.el);
      bindForm($('#pf', m.el), async (b) => { await api('/api/admin/partners/' + p.id, { method: 'PUT', body: b }); toast('Saved'); m.close(); partners(main); });
      const del = $('#pdel', m.el);
      if (del) del.onclick = () => wrap(async () => { if (!confirm('Delete this partner?')) return; await api('/api/admin/partners/' + p.id, { method: 'DELETE' }); m.close(); partners(main); });
    }));
  }

  // ------------------------------------------------------------------ people
  async function people(main) {
    const { people: list } = await api('/api/admin/people');
    const group = (kind, title, hint) => `<div class="panel"><div class="bar" style="margin-bottom:10px"><h2 style="margin:0">${title}</h2><span class="spacer"></span><button class="btn btn-primary sm" data-new="${kind}">+ Add</button></div>
      <p class="muted" style="font-size:.88rem;margin-bottom:12px">${hint}</p>
      ${list.filter((p) => p.kind === kind).map((p) => `<div class="act click" data-id="${p.id}" style="cursor:pointer;display:flex;gap:14px;align-items:center">
        <div style="width:56px;height:56px;border-radius:50%;overflow:hidden;background:var(--yellow-soft);display:grid;place-items:center;font-family:'Baloo 2';font-weight:800;color:var(--green-dark);flex:none">${p.photo_id ? `<img src="${media(p.photo_id)}" style="width:100%;height:100%;object-fit:cover">` : esc(initials(p.name))}</div>
        <div style="flex:1"><strong>${esc(p.name)}</strong> ${p.visible ? '' : '<span class="pill cancelled">hidden</span>'}<div class="meta">${esc(p.title || '')}</div>
        ${p.message ? `<div class="meta" style="margin-top:4px">“${esc(p.message.slice(0, 120))}${p.message.length > 120 ? '…' : ''}”</div>` : ''}</div><span class="muted">Order ${p.sort}</span></div>`).join('') || '<p class="muted">None yet.</p>'}</div>`;
    main.innerHTML = top('Trustees & team') + group('trustee', 'Trustees', 'Shown in the Board of Trustees list. Trustees with a message appear in “From our trustees” on the home page.') +
      group('coordinator', 'Volunteer programme coordinators', 'Shown on the home page and the Volunteer page, with photo and short bio.');
    const edit = (p) => {
      const m = modal(`<h2 style="font-size:1.5rem;margin-bottom:12px">${p.id ? 'Edit' : 'Add'} ${p.kind === 'trustee' ? 'trustee' : 'coordinator'}</h2><form class="form" id="pf">
        <input type="hidden" name="kind" value="${p.kind}">
        <label class="f">Photo <span class="hint">Square crop, faces work best</span>${imgPicker('photo_id', p.photo_id, { square: true, max: 600, label: 'Upload photo' })}</label>
        <div class="row"><label class="f">Name<input name="name" required value="${esc(p.name || '')}"></label><label class="f">Role / title<input name="title" value="${esc(p.title || '')}" placeholder="${p.kind === 'trustee' ? 'Managing Trustee' : 'Volunteer Programme Coordinator'}"></label></div>
        ${p.kind === 'trustee' ? `<label class="f">Message <span class="hint">A personal note shown on the home page. Leave empty to hide.</span><textarea name="message" style="min-height:140px">${esc(p.message || '')}</textarea></label>` :
          `<label class="f">Short bio<textarea name="bio" style="min-height:90px">${esc(p.bio || '')}</textarea></label>`}
        <div class="row"><label class="f">Email (not shown publicly)<input name="email" value="${esc(p.email || '')}"></label><label class="f">Display order<input type="number" name="sort" value="${p.sort ?? 0}"></label></div>
        <label class="check"><input type="checkbox" name="visible" ${p.visible === 0 ? '' : 'checked'}><span>Show on website</span></label>
        <div class="bar"><button class="btn btn-primary" type="submit">Save</button>${p.id ? '<span class="spacer"></span><button type="button" class="btn danger sm" id="pdel">Delete</button>' : ''}</div></form>`);
      wireImgPickers(m.el);
      bindForm($('#pf', m.el), async (b) => {
        await api('/api/admin/people' + (p.id ? '/' + p.id : ''), { method: p.id ? 'PUT' : 'POST', body: b }); toast('Saved'); m.close(); people(main);
      });
      const del = $('#pdel', m.el);
      if (del) del.onclick = () => wrap(async () => { if (!confirm('Delete?')) return; await api('/api/admin/people/' + p.id, { method: 'DELETE' }); m.close(); people(main); });
    };
    main.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => edit({ kind: b.dataset.new })));
    main.querySelectorAll('[data-id]').forEach((el) => (el.onclick = () => edit(list.find((p) => p.id === Number(el.dataset.id)))));
  }

  // ------------------------------------------------------------------ donations
  async function donations(main) {
    const { donations: list } = await api('/api/admin/donations');
    const total = list.filter((x) => x.status === 'received').reduce((t, x) => t + x.amount, 0);
    main.innerHTML = top('Donations', '<button class="btn btn-primary sm" id="add">+ Record offline donation</button>') +
      `<div class="stats" style="grid-template-columns:repeat(3,1fr)"><div class="stat"><b>${inr(total)}</b><span>Received (all time)</span></div>
      <div class="stat"><b>${list.filter((x) => x.status === 'pledged').length}</b><span>Awaiting confirmation</span></div><div class="stat"><b>${list.filter((x) => x.status === 'received').length}</b><span>Receipts issued</span></div></div>
      <div class="panel tw">${list.length ? `<table class="t"><thead><tr><th>Donor</th><th>Amount</th><th>Mode / ref</th><th>PAN</th><th>Status</th><th>Receipt</th><th>Date</th></tr></thead><tbody>
      ${list.map((x) => `<tr class="click" data-d="${x.id}"><td><strong>${esc(x.name)}</strong><br><span class="muted">${esc(x.email)}</span></td><td><strong>${inr(x.amount)}</strong>${x.purpose ? `<br><span class="muted">${esc(x.purpose)}</span>` : ''}</td>
        <td>${esc(x.mode || '')}<br><span class="muted">${esc(x.txn_ref || '')}</span></td><td>${esc(x.pan || '—')}</td><td>${pill(x.status)}</td><td>${esc(x.receipt_no || '')}</td><td>${esc(d(x.received_at || x.created_at))}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty-s">No donations recorded yet.</div>'}</div>`;
    $('#add').onclick = () => {
      const m = modal(`<h2 style="font-size:1.5rem;margin-bottom:12px">Record a donation</h2><form class="form" id="df">
        <div class="row"><label class="f">Donor name<input name="name" required></label><label class="f">Email<input name="email" type="email" required></label></div>
        <div class="row"><label class="f">Amount (₹)<input name="amount" type="number" min="1" required></label><label class="f">Mode${sel('mode', [['Bank transfer', 'Bank transfer'], ['UPI', 'UPI'], ['Cheque', 'Cheque'], ['Cash', 'Cash']], 'Bank transfer')}</label></div>
        <div class="row"><label class="f">Reference<input name="txn_ref"></label><label class="f">PAN<input name="pan" maxlength="10"></label></div>
        <label class="f">Address<input name="address"></label><label class="f">Purpose<input name="purpose"></label>
        <button class="btn btn-primary" type="submit">Save</button></form>`);
      bindForm($('#df', m.el), async (b) => { await api('/api/admin/donations', { body: b }); toast('Recorded. Open it to issue a receipt.'); m.close(); donations(main); });
    };
    main.querySelectorAll('[data-d]').forEach((tr) => (tr.onclick = () => {
      const x = list.find((y) => y.id === Number(tr.dataset.d));
      const m = modal(`<h2 style="font-size:1.5rem">${inr(x.amount)} from ${esc(x.name)} ${pill(x.status)}</h2>
        <div class="help" style="margin:14px 0">${esc(x.email)} · ${esc(x.phone || '')}<br>${esc(x.address || '')}<br>${x.message ? `<em>${esc(x.message)}</em>` : ''}</div>
        <form class="form" id="df"><div class="row"><label class="f">Transaction reference<input name="txn_ref" value="${esc(x.txn_ref || '')}"></label><label class="f">Donor PAN<input name="pan" maxlength="10" value="${esc(x.pan || '')}"></label></div>
        ${x.status !== 'received' ? `<label class="f">Date received<input type="date" name="received_on" value="${new Date().toISOString().slice(0, 10)}"></label>` : `<p>Receipt <strong>${esc(x.receipt_no)}</strong> issued ${esc(d(x.received_at))}.</p>`}
        <div class="bar">${x.status !== 'received' ? '<button class="btn btn-primary" data-act="receive">Mark received & email receipt</button>' : '<button class="btn btn-primary" data-act="resend">Resend receipt</button>'}
        <button class="btn light" data-act="save">Save details</button>${x.status === 'pledged' ? '<span class="spacer"></span><button class="btn danger sm" data-act="cancel">Cancel pledge</button>' : ''}</div></form>`);
      const f = $('#df', m.el);
      f.onsubmit = (e) => e.preventDefault();
      f.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => wrap(async () => {
        const v = SW.formData(f), act = b.dataset.act;
        const body = { txn_ref: v.txn_ref, pan: v.pan };
        if (act === 'receive') Object.assign(body, { status: 'received', received_at: v.received_on ? v.received_on + 'T12:00:00+05:30' : undefined, send_receipt: true });
        if (act === 'resend') Object.assign(body, { status: 'received', send_receipt: true });
        if (act === 'cancel') body.status = 'cancelled';
        const r = await api('/api/admin/donations/' + x.id, { method: 'PUT', body });
        toast(act === 'receive' || act === 'resend' ? (r.emailed ? `Receipt ${r.receipt_no} emailed` : `Receipt ${r.receipt_no} saved, but the email failed (check Email log)`) : 'Saved');
        m.close(); donations(main);
      })));
    }));
  }

  // ------------------------------------------------------------------ email
  async function emailView(main, [tab = 'compose']) {
    const tabs = [['compose', 'Compose'], ...(isLead() ? [['outbox', 'Queue'], ['log', 'Sent log']] : [])];
    main.innerHTML = top('Email') + `<div class="subtabs">${tabs.map(([k, t]) => `<button class="${k === tab ? 'on' : ''}" onclick="location.hash='email/${k}'">${t}</button>`).join('')}</div><div id="eb"></div>`;
    const eb = $('#eb');
    if (tab === 'log') {
      const { log } = await api('/api/admin/email/log');
      eb.innerHTML = `<div class="panel tw">${log.length ? `<table class="t"><thead><tr><th>When</th><th>Type</th><th>To</th><th>From</th><th>Subject</th><th>Via</th><th>Status</th></tr></thead><tbody>
        ${log.map((l) => `<tr><td style="white-space:nowrap">${esc(dt(l.created_at))}</td><td>${esc(l.kind)}</td><td>${esc(l.to_addr)}</td><td>${esc(l.from_addr || '')}</td><td>${esc(l.subject)}</td><td>${esc(l.provider || '—')}</td>
          <td>${pill(l.status)}${l.error ? `<div class="muted" style="font-size:.76rem;max-width:260px">${esc(l.error)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-s">No emails sent yet.</div>'}</div>`;
      return;
    }
    if (tab === 'outbox') {
      const o = await api('/api/admin/email/outbox');
      eb.innerHTML = `<div class="panel"><div class="bar"><span>Queued: <strong>${o.counts.queued || 0}</strong> · Failed: <strong>${o.counts.failed || 0}</strong> · Sent: <strong>${o.counts.sent || 0}</strong></span><span class="spacer"></span>
        <button class="btn light sm" id="run">Send queued now</button><button class="btn light sm" id="retry">Retry failed</button></div>
        <p class="muted" style="font-size:.86rem;margin-top:10px">Bulk emails, reminders and thank-you notes go out through this queue every 5 minutes, up to 40 per run.</p>
        <div class="tw" style="margin-top:12px">${o.items.length ? `<table class="t"><thead><tr><th>To</th><th>Subject</th><th>Type</th><th>Attempts</th><th>Last error</th></tr></thead><tbody>
        ${o.items.map((i) => `<tr><td>${esc(i.to_addr)}</td><td>${esc(i.subject)}</td><td>${esc(i.kind)}</td><td>${i.attempts}</td><td class="muted" style="font-size:.8rem">${esc(i.last_error || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-s">The queue is empty.</div>'}</div></div>`;
      $('#run').onclick = () => wrap(async () => { const r = await api('/api/admin/cron/run', { body: {} }); toast(`Sent ${r.sent}, failed ${r.failed}`); emailView(main, ['outbox']); });
      $('#retry').onclick = () => wrap(async () => { const r = await api('/api/admin/email/outbox/retry', { body: {} }); toast(`Sent ${r.sent}, failed ${r.failed}`); emailView(main, ['outbox']); });
      return;
    }
    const { senders } = await api('/api/admin/senders');
    eb.innerHTML = `<div class="cols"><div class="panel"><form class="form" id="cf">
      <label class="f">From${sel('sender_id', senders.length ? senders.map((s) => [s.id, `${s.name} <${s.address}>`]) : [['', 'Default (add senders in Settings)']], senders[0]?.id)}</label>
      <label class="f">To <span class="hint">Separate addresses with commas</span><textarea name="to" required style="min-height:60px"></textarea></label>
      <label class="f">CC<input name="cc"></label>
      <label class="f">Subject<input name="subject" required></label>
      <label class="f">Heading inside the email<input name="title" placeholder="Defaults to the subject"></label>
      <label class="f">Message <span class="hint">Blank line = new paragraph</span><textarea name="body" required style="min-height:220px"></textarea></label>
      <div class="row"><label class="f">Button label (optional)<input name="cta_label" placeholder="Register now"></label><label class="f">Button link<input name="cta_url" placeholder="https://…"></label></div>
      <label class="check"><input type="checkbox" name="individually" checked><span>Send a separate email to each recipient, so addresses stay private</span></label>
      <div class="bar"><button class="btn btn-primary" type="submit">Send</button><button class="btn light" type="button" id="pv">Update preview</button></div></form></div>
      <div><iframe class="preview-frame" id="frame" title="Email preview"></iframe></div></div>`;
    const f = $('#cf');
    const frame = $('#frame');
    const preview = async () => {
      try { const r = await api('/api/admin/email/preview', { body: SW.formData(f), keepCache: true }); frame.srcdoc = r.html; } catch { /* preview is optional */ }
    };
    $('#pv').onclick = preview; preview();
    let t; f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(preview, 600); });
    bindForm(f, async (b) => {
      const r = await api('/api/admin/email/send', { body: b });
      if (r.queued) toast(`${r.queued} emails queued. They will go out within a few minutes.`);
      else if (r.ok) toast(`Sent to ${r.sent} recipient(s)`);
      else throw new Error(`Sent ${r.sent}. Failed: ${r.errors.join('; ')}`);
    });
  }

  // ------------------------------------------------------------------ users
  async function users(main) {
    const { users: list } = await api('/api/admin/users');
    const roles = [['trustee', 'Trustee'], ['coordinator', 'Coordinator'], ...(ME.role === 'admin' ? [['admin', 'Administrator']] : [])];
    main.innerHTML = top('Portal users', '<button class="btn btn-primary sm" id="inv">+ Invite</button>') + `<div class="panel tw"><table class="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((u) => `<tr data-u="${u.id}"><td><strong>${esc(u.name)}</strong>${u.id === ME.id ? ' <span class="pill">you</span>' : ''}</td><td>${esc(u.email)}</td>
        <td>${u.id === ME.id || (u.role === 'admin' && ME.role !== 'admin') ? esc(u.role) : sel('role', [...roles, ...(u.role === 'admin' && ME.role !== 'admin' ? [['admin', 'Administrator']] : [])], u.role)}</td>
        <td>${u.id === ME.id ? pill(u.status) : sel('status', [['active', 'Active'], ['disabled', 'Disabled']], u.status)}</td>
        <td>${ME.role === 'admin' && u.id !== ME.id ? '<button class="btn danger sm" data-del>Delete</button>' : ''}</td></tr>`).join('')}</tbody></table>
      <p class="muted" style="font-size:.86rem;margin-top:12px">Student volunteers sign up themselves and are managed under Volunteers. <strong>Coordinators</strong> manage events, volunteers, hours, partners and email. <strong>Trustees</strong> and <strong>administrators</strong> can also manage donations, people, users and settings.</p></div>`;
    main.querySelectorAll('tr[data-u] select').forEach((s) => (s.onchange = () => wrap(async () => {
      const tr = s.closest('tr'); const role = $('[name=role]', tr)?.value; const status = $('[name=status]', tr)?.value;
      await api('/api/admin/users/' + tr.dataset.u, { method: 'PUT', body: { role, status } }); toast('Updated');
    })));
    main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => wrap(async () => {
      if (!confirm('Delete this user permanently?')) return;
      await api('/api/admin/users/' + b.closest('tr').dataset.u, { method: 'DELETE' }); users(main);
    })));
    $('#inv').onclick = () => {
      const m = modal(`<h2 style="font-size:1.5rem;margin-bottom:12px">Invite someone</h2><form class="form" id="uf">
        <label class="f">Name<input name="name" required></label><label class="f">Email<input name="email" type="email" required></label>
        <label class="f">Role${sel('role', roles, 'coordinator')}</label><p class="muted" style="font-size:.88rem">They get an email with a link to set their password.</p>
        <button class="btn btn-primary" type="submit">Send invite</button></form>`);
      bindForm($('#uf', m.el), async (b) => {
        const r = await api('/api/admin/users', { body: b });
        if (r.emailed) { toast('Invite sent'); m.close(); users(main); }
        else { m.el.innerHTML = `<h2>User added</h2><p style="margin:12px 0">The invite email could not be sent (email isn't connected yet). Share this one-time link with them. It works for 24 hours:</p><textarea style="width:100%;min-height:80px">${esc(r.invite_link)}</textarea>`; users(main); }
      });
    };
  }

  // ------------------------------------------------------------------ settings
  async function settings(main, [tab = 'organisation']) {
    const [{ settings: s }, { senders }] = await Promise.all([api('/api/admin/settings'), api('/api/admin/senders')]);
    const T = [['organisation', 'Organisation'], ['donations', 'Donations & tax'], ['email', 'Email delivery'], ['senders', 'From addresses'], ['automation', 'Automation'], ['health', 'System check']];
    main.innerHTML = top('Settings') + `<div class="subtabs">${T.map(([k, t]) => `<button class="${k === tab ? 'on' : ''}" onclick="location.hash='settings/${k}'">${t}</button>`).join('')}</div><div id="sb"></div>`;
    const sb = $('#sb');
    const inp = (k, label, hint = '', type = 'text') => `<label class="f">${label}${hint ? ` <span class="hint">${hint}</span>` : ''}<input type="${type}" name="${k}" value="${esc(s[k] ?? '')}"></label>`;
    const save = (formEl) => bindForm(formEl, async (b) => { await api('/api/admin/settings', { method: 'PUT', body: { settings: b } }); toast('Settings saved'); settings(main, [tab]); });

    if (tab === 'organisation') {
      sb.innerHTML = `<form class="panel form" id="sf"><h2>Organisation details</h2><p class="muted" style="font-size:.9rem">Shown on the website, in email footers and on receipts.</p>
        ${inp('org_name', 'Organisation name')}<div class="row">${inp('contact_email', 'Public contact email')}${inp('contact_phone', 'Public phone')}</div>
        <label class="f">Registered address<textarea name="address" style="min-height:70px">${esc(s.address)}</textarea></label>
        <div class="row">${inp('reg_no', 'Trust registration no.')}${inp('darpan_id', 'NGO Darpan ID')}</div><div class="row">${inp('pan', 'Trust PAN')}${inp('site_url', 'Website address', 'Used in scheduled emails, e.g. https://superwingsfoundation.org')}</div>
        <div class="row">${inp('instagram', 'Instagram URL')}${inp('linkedin', 'LinkedIn URL')}</div>
        <button class="btn btn-primary" type="submit">Save</button></form>`;
      save($('#sf'));
    }
    if (tab === 'donations') {
      sb.innerHTML = `<form class="panel form" id="sf"><h2>Tax registrations</h2><p class="muted" style="font-size:.9rem">Leave empty until you have them. Once 80G is filled in, the donate page and receipts show the tax-deduction statement automatically.</p>
        <div class="row">${inp('reg_12a', '12A registration no.')}${inp('reg_80g', '80G registration no.')}</div><div class="row">${inp('reg_80g_validity', '80G validity', 'e.g. AY 2026-27 to 2030-31')}${inp('csr1', 'CSR-1 registration no.')}</div>
        <h2 style="margin-top:14px">How people pay</h2><div class="row">${inp('upi_id', 'UPI ID', 'e.g. superwings@sbi')}<label class="f">UPI QR code${imgPicker('upi_qr_id', s.upi_qr_id, { max: 800, label: 'Upload QR' })}</label></div>
        <div class="row">${inp('bank_account_name', 'Account name')}${inp('bank_account_no', 'Account number')}</div><div class="row">${inp('bank_ifsc', 'IFSC')}${inp('bank_name', 'Bank name')}</div>${inp('bank_branch', 'Branch')}
        <label class="f">Note on the donate page<textarea name="donation_note" style="min-height:60px">${esc(s.donation_note)}</textarea></label>
        <button class="btn btn-primary" type="submit">Save</button></form>`;
      wireImgPickers(sb); save($('#sf'));
    }
    if (tab === 'email') {
      const set = (v) => (v ? '<span class="pill approved">connected</span>' : '<span class="pill pending">not connected</span>');
      sb.innerHTML = `<form class="panel form" id="pf"><h2>Which service sends email first?</h2>
        <label class="check"><input type="radio" name="email_primary" value="zeptomail" ${s.email_primary !== 'zoho_mail' ? 'checked' : ''}><span><strong>ZeptoMail</strong> first (recommended), then the Zoho Mail self-client, then Gmail</span></label>
        <label class="check"><input type="radio" name="email_primary" value="zoho_mail" ${s.email_primary === 'zoho_mail' ? 'checked' : ''}><span><strong>Zoho Mail self-client</strong> first, then ZeptoMail, then Gmail</span></label>
        <label class="check"><input type="radio" name="email_primary" value="gmail" ${s.email_primary === 'gmail' ? 'checked' : ''}><span><strong>Gmail</strong> first (good while you set up ZeptoMail), then ZeptoMail, then Zoho</span></label>
        <p class="muted" style="font-size:.86rem">If the first service fails, the next one is tried automatically. Every attempt is recorded in Email → Sent log.</p>
        <div><button class="btn btn-primary sm" type="submit">Save</button></div></form>

        <form class="panel form" id="zf"><div class="bar"><h2 style="margin:0">Zoho ZeptoMail</h2>${set(s.zepto_token)}</div>
        <div class="help"><ol><li>Sign in to <a href="https://www.zoho.in/zeptomail/" target="_blank" rel="noopener">ZeptoMail</a> with the foundation's Zoho account and verify the domain <code>superwingsfoundation.org</code> (add the SPF, DKIM and CNAME records it shows to your DNS).</li>
        <li>Open <em>Mail Agents</em>, then your agent, then <em>SMTP/API</em>, and copy the <em>Send Mail Token</em>.</li><li>Paste it below and press Save. The token is encrypted before it is stored.</li></ol></div>
        <div class="row"><label class="f">Data centre${sel('zepto_host', [['api.zeptomail.in', 'India (zeptomail.in)'], ['api.zeptomail.com', 'Global (zeptomail.com)'], ['api.zeptomail.eu', 'Europe (zeptomail.eu)']], s.zepto_host)}</label>
        <label class="f">Send Mail Token<input name="zepto_token" type="password" value="${esc(s.zepto_token)}" placeholder="Zoho-enczapikey …" autocomplete="off"></label></div>
        <div class="bar"><button class="btn btn-primary sm" type="submit">Save</button><button class="btn light sm" type="button" data-test="zeptomail">Send test email</button></div></form>

        <form class="panel form" id="hf"><div class="bar"><h2 style="margin:0">Fallback: Zoho Mail self-client</h2>${set(s.zoho_refresh_token && s.zoho_account_id)}</div>
        <div class="help"><ol><li>Go to the <a href="https://api-console.zoho.in/" target="_blank" rel="noopener">Zoho API Console</a> (zoho.in for India accounts) and choose <em>Add Client</em>, then <em>Self Client</em>.</li>
        <li>Copy the <em>Client ID</em> and <em>Client Secret</em>.</li>
        <li>Under <em>Generate Code</em>, enter the scope <code>ZohoMail.messages.CREATE,ZohoMail.accounts.READ</code>, choose 10 minutes, and generate the code.</li>
        <li>Exchange the code for a refresh token. Run this in a terminal within 10 minutes:<br><code style="display:block;white-space:pre-wrap;margin-top:6px;padding:8px">curl -X POST "https://accounts.zoho.in/oauth/v2/token?grant_type=authorization_code&amp;client_id=CLIENT_ID&amp;client_secret=CLIENT_SECRET&amp;code=CODE"</code>Copy the <code>refresh_token</code> from the reply.</li>
        <li>Paste the three values below, Save, then press <em>Fetch account ID</em>. Senders must be addresses that mailbox is allowed to send as.</li></ol></div>
        <div class="row"><label class="f">Data centre${sel('zoho_dc', [['in', 'India (zoho.in)'], ['com', 'Global (zoho.com)'], ['eu', 'Europe (zoho.eu)'], ['au', 'Australia'], ['jp', 'Japan']], s.zoho_dc)}</label>${inp('zoho_client_id', 'Client ID')}</div>
        <div class="row"><label class="f">Client Secret<input name="zoho_client_secret" type="password" value="${esc(s.zoho_client_secret)}" autocomplete="off"></label><label class="f">Refresh token<input name="zoho_refresh_token" type="password" value="${esc(s.zoho_refresh_token)}" autocomplete="off"></label></div>
        ${inp('zoho_account_id', 'Account ID', 'Filled in by “Fetch account ID”')}
        <div class="bar"><button class="btn btn-primary sm" type="submit">Save</button><button class="btn light sm" type="button" id="acct">Fetch account ID</button><button class="btn light sm" type="button" data-test="zoho_mail">Send test email</button></div></form>

        <form class="panel form" id="gf"><div class="bar"><h2 style="margin:0">Last-resort fallback: Gmail</h2><span id="gstat"><span class="pill pending">checking…</span></span></div>
        <div class="help">Sends from the Google account that owns the Apps Script, so no setup is needed beyond one permission. Limits: about <strong>100 emails a day</strong> on a free Gmail account and 1,500 on Google Workspace.
        <ol><li>In the Apps Script editor, select <code>authorizeGmail</code> and click <em>Run</em> once, then allow the Gmail permission.</li>
        <li>To send <em>as</em> an address such as contact@superwingsfoundation.org, add it in Gmail: <em>Settings → Accounts → Send mail as</em>. Otherwise Gmail sends from the account's own address, with replies going to your contact email.</li></ol></div>
        <label class="check"><input type="checkbox" name="gmail_enabled" ${s.gmail_enabled === '0' ? '' : 'checked'}><span>Use Gmail when the other services fail</span></label>
        <div class="bar"><button class="btn btn-primary sm" type="submit">Save</button><button class="btn light sm" type="button" data-test="gmail">Send test email</button></div></form>`;
      api('/api/admin/email/gmail').then((g) => {
        const el = $('#gstat', sb); if (!el) return;
        el.innerHTML = g.authorised ? `<span class="pill approved">ready</span> <span class="muted" style="font-size:.85rem">${esc(g.account)} · ${g.quota} left today${g.aliases.length ? ' · send-as: ' + esc(g.aliases.join(', ')) : ''}</span>` : '<span class="pill pending">run authorizeGmail()</span>';
      }).catch(() => {});
      save($('#pf')); save($('#zf')); save($('#hf'));
      bindForm($('#gf'), async (b) => { await api('/api/admin/settings', { method: 'PUT', body: { settings: { gmail_enabled: b.gmail_enabled ? '1' : '0' } } }); toast('Settings saved'); settings(main, ['email']); });
      $('#acct').onclick = () => wrap(async () => { const r = await api('/api/admin/email/zoho-account', { body: {} }); toast(`Connected: account ${r.accountId} ${r.address}`); settings(main, ['email']); });
      sb.querySelectorAll('[data-test]').forEach((b) => (b.onclick = () => wrap(async () => {
        const to = prompt('Send a test email to:', ME.email); if (!to) return;
        const r = await api('/api/admin/email/test', { body: { to, provider: b.dataset.test } });
        r.ok ? toast(`Test sent via ${r.provider}`) : toast(r.error, true);
      })));
    }
    if (tab === 'senders') {
      sb.innerHTML = `<div class="panel"><h2>From addresses</h2><p class="muted" style="font-size:.9rem;margin-bottom:12px">Choose which of these to send from when you compose an email or set up an event. Each address must be on a domain verified in ZeptoMail, and allowed in the Zoho mailbox for the fallback.</p>
        <table class="t"><thead><tr><th>Display name</th><th>Address</th><th>Default</th><th></th></tr></thead><tbody>
        ${senders.map((x) => `<tr data-id="${x.id}"><td><input class="f" name="name" value="${esc(x.name)}" style="font:inherit;padding:.4rem .6rem;border:1.5px solid var(--line);border-radius:8px;width:100%"></td>
          <td><input name="address" value="${esc(x.address)}" style="font:inherit;padding:.4rem .6rem;border:1.5px solid var(--line);border-radius:8px;width:100%"></td>
          <td><input type="radio" name="def" ${x.is_default ? 'checked' : ''}></td><td class="bar"><button class="btn light sm" data-save>Save</button><button class="btn danger sm" data-del>Delete</button></td></tr>`).join('')}
        </tbody></table>
        <form class="form" id="nf" style="margin-top:18px"><h3>Add an address</h3><div class="row"><label class="f">Display name<input name="name" required placeholder="Superwings Events"></label><label class="f">Address<input name="address" type="email" required placeholder="events@superwingsfoundation.org"></label></div>
        <label class="check"><input type="checkbox" name="is_default"><span>Make this the default</span></label><div><button class="btn btn-primary sm" type="submit">Add</button></div></form></div>`;
      bindForm($('#nf'), async (b) => { await api('/api/admin/senders', { body: b }); toast('Added'); settings(main, ['senders']); });
      sb.querySelectorAll('tr[data-id]').forEach((tr) => {
        const body = () => ({ name: $('[name=name]', tr).value, address: $('[name=address]', tr).value, is_default: $('[name=def]', tr).checked });
        $('[data-save]', tr).onclick = () => wrap(async () => { await api('/api/admin/senders/' + tr.dataset.id, { method: 'PUT', body: body() }); toast('Saved'); settings(main, ['senders']); });
        $('[name=def]', tr).onchange = () => wrap(async () => { await api('/api/admin/senders/' + tr.dataset.id, { method: 'PUT', body: { ...body(), is_default: true } }); toast('Default updated'); settings(main, ['senders']); });
        $('[data-del]', tr).onclick = () => wrap(async () => { if (!confirm('Delete this address?')) return; await api('/api/admin/senders/' + tr.dataset.id, { method: 'DELETE' }); settings(main, ['senders']); });
      });
    }
    if (tab === 'health') {
      sb.innerHTML = '<div class="panel"><h2>System check</h2><p class="muted" id="hc-sub">Checking the server…</p><div id="hc"></div><div class="bar" style="margin-top:14px"><button class="btn light sm" id="hc-run">Run again</button></div></div>';
      const run = async () => {
        $('#hc', sb).innerHTML = '<div class="sk sk-block" style="height:200px"></div>';
        try {
          const t0 = Date.now(); const h = await api('/api/admin/health', { fresh: true });
          $('#hc-sub', sb).textContent = `Server answered in ${Date.now() - t0} ms. API: ${SW.API}`;
          $('#hc', sb).innerHTML = `<table class="t"><tbody>${h.checks.map((c) => `<tr><td style="width:34px">${c.ok ? '✅' : '⚠️'}</td><td><strong>${esc(c.name)}</strong></td><td class="muted">${esc(c.detail)}</td></tr>`).join('')}</tbody></table>`;
        } catch (e) { $('#hc-sub', sb).textContent = 'Could not reach the server.'; $('#hc', sb).innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
      };
      $('#hc-run', sb).onclick = run; run();
    }
    if (tab === 'automation') {
      sb.innerHTML = `<form class="panel form" id="sf"><h2>Event emails</h2>
        <div class="row">${inp('reminder_hours', 'Send reminders this many hours before an event', '', 'number')}${inp('followup_hours', 'Send thank-you emails this many hours after it ends', '', 'number')}</div>
        <div class="help">The scheduled job runs every 5 minutes. It queues reminders and thank-you notes, sends queued email, and <strong>deletes event registration data 7 days after each event ends</strong>.</div>
        <div class="bar"><button class="btn btn-primary sm" type="submit">Save</button><button class="btn light sm" type="button" id="run">Run the scheduled job now</button></div></form>`;
      save($('#sf'));
      $('#run').onclick = () => wrap(async () => { const r = await api('/api/admin/cron/run', { body: {} }); toast(`Reminders ${r.reminders_queued}, thank-yous ${r.followups_queued}, sent ${r.sent}, deleted ${r.registrations_deleted}`); });
    }
  }

  // ------------------------------------------------------------------ account (all roles)
  async function account(main) {
    main.innerHTML = top('My account') + `<div class="panel" style="max-width:520px"><p><strong>${esc(ME.name)}</strong><br>${esc(ME.email)}<br><span class="muted">${esc(ME.role_label || ME.role)}</span></p></div>
      <form class="panel form" id="pw" style="max-width:520px"><h2>Change password</h2><label class="f">Current password<input type="password" name="current" required autocomplete="current-password"></label>
      <label class="f">New password<input type="password" name="password" minlength="8" required autocomplete="new-password"></label><button class="btn btn-primary" type="submit">Update password</button></form>`;
    bindForm($('#pw'), async (b) => { await api('/api/me/password', { body: b }); toast('Password updated'); $('#pw').reset(); });
  }

  // ================================================================== STUDENT
  async function studentApp() {
    Object.assign(ME, (await api('/api/me')).user);
    const items = [['overview', 'Overview', 'My volunteering'], ['log', 'Log an activity'], ['activities', 'My activities'], ['profile', 'Profile'], ['statement', 'Hours statement'], ['account', 'My account']];
    shell(items, async (v, args, main) => {
      const data = await api('/api/me'); Object.assign(ME, data.user);
      if (v === 'statement') { location.href = `/portal/certificate.html?u=${ME.id}`; return; }
      return ({ overview: sOverview, log: sLog, activities: sActivities, profile: sProfile, account }[v] || sOverview)(main, args, data);
    });
  }
  const LOS = [['LO1', 'Identify own strengths and develop areas for growth'], ['LO2', 'Show challenges were undertaken, developing new skills'], ['LO3', 'Initiate and plan a CAS experience'],
    ['LO4', 'Show commitment and perseverance'], ['LO5', 'Work collaboratively and recognise its benefits'], ['LO6', 'Engage with issues of global significance'], ['LO7', 'Recognise and consider the ethics of choices and actions']];

  function sOverview(main, _a, { profile: p, activities, totals }) {
    const banner = p.status === 'pending' ? `<div class="notice"><strong>Your application is being reviewed.</strong> A coordinator will approve it soon. Then you can start logging activities.</div>`
      : p.status === 'rejected' ? `<div class="notice">Your application was not approved. Write to us if you think this is a mistake.</div>` : '';
    main.innerHTML = top(`Hi, ${esc(ME.name.split(' ')[0])}`, p.status === 'approved' ? '<a class="btn btn-primary sm" href="#log">+ Log an activity</a>' : '') + banner +
      `<div class="stats" style="grid-template-columns:repeat(3,1fr)"><div class="stat"><b>${totals.approved}</b><span>Verified hours</span></div><div class="stat"><b>${totals.pending}</b><span>Hours awaiting verification</span></div><div class="stat"><b>${totals.count}</b><span>Activities logged</span></div></div>
      <div class="panel"><h2>${esc(p.programme_label)}</h2><p class="muted">${esc(p.partner_name || p.institution || '')} ${esc(p.grade || '')} · Status ${pill(p.status)}</p>
      ${p.programme === 'ibdp_cas' ? `<div class="help" style="margin-top:12px">For CAS, tag each experience with its strands and the learning outcomes you showed. Over your CAS programme, aim to cover all seven outcomes.<div class="tagset" style="margin-top:8px">${LOS.map(([k]) => `<span style="${activities.some((a) => a.status === 'approved' && (a.outcomes || '').includes(k)) ? 'background:var(--green);color:#fff' : ''}">${k}</span>`).join('')}</div></div>` : ''}</div>
      <div class="panel"><div class="bar" style="margin-bottom:10px"><h2 style="margin:0">Recent activities</h2><span class="spacer"></span><a href="#activities" class="btn light sm">See all</a></div>
      ${activities.slice(0, 3).map((a) => actCard(a)).join('') || '<p class="muted">Nothing logged yet.</p>'}</div>`;
  }

  function activityForm(p, a = {}) {
    const cas = p.programme === 'ibdp_cas';
    const st = (a.strands || '').split(','), lo = (a.outcomes || '').split(',');
    return `<form class="form" id="af"><div class="row"><label class="f">Date<input type="date" name="date" required value="${esc(a.date || new Date().toISOString().slice(0, 10))}"></label>
      <label class="f">Hours<input type="number" name="hours" step="0.25" min="0.25" max="24" required value="${esc(a.hours ?? '')}"></label></div>
      <label class="f">What did you do?<input name="title" required value="${esc(a.title || '')}" placeholder="e.g. Reading circle with Grade 3 children, Thaltej"></label>
      <label class="f">Details<textarea name="description" style="min-height:90px">${esc(a.description || '')}</textarea></label>
      ${cas ? `<label class="f">CAS strands</label><div class="chk-grid" style="grid-template-columns:repeat(3,1fr)">${Object.entries(STRAND).map(([k, t]) => `<label><input type="checkbox" data-multi="1" name="strands" value="${k}" ${st.includes(k) ? 'checked' : ''}>${t}</label>`).join('')}</div>
        <label class="f">Learning outcomes shown</label><div class="chk-grid">${LOS.map(([k, t]) => `<label><input type="checkbox" data-multi="1" name="outcomes" value="${k}" ${lo.includes(k) ? 'checked' : ''}><span><strong>${k}</strong> ${t}</span></label>`).join('')}</div>` : ''}
      <label class="f">Reflection <span class="hint">What did you learn? What would you do differently? What impact did it have?</span><textarea name="reflection" style="min-height:140px">${esc(a.reflection || '')}</textarea></label>
      <button class="btn btn-primary" type="submit">${a.id ? 'Save and resubmit' : 'Submit for verification'}</button></form>`;
  }

  function sLog(main, _a, { profile: p }) {
    if (p.status !== 'approved') { main.innerHTML = top('Log an activity') + '<div class="notice">You can log activities once a coordinator approves your application.</div>'; return; }
    main.innerHTML = top('Log an activity') + `<div class="panel" style="max-width:780px">${activityForm(p)}</div>`;
    bindForm($('#af'), async (b) => { await api('/api/me/activities', { body: b }); toast('Submitted for verification'); location.hash = 'activities'; });
  }

  function sActivities(main, _a, { profile: p, activities }) {
    main.innerHTML = top('My activities', p.status === 'approved' ? '<a class="btn btn-primary sm" href="#log">+ Log an activity</a>' : '') +
      (activities.length ? activities.map((a) => actCard(a, a.status !== 'approved' ? `<div class="bar" style="margin-top:10px"><button class="btn light sm" data-edit="${a.id}">Edit</button><button class="btn danger sm" data-del="${a.id}">Delete</button></div>` : '')).join('') : '<div class="panel empty-s">Nothing logged yet.</div>');
    main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => wrap(async () => { if (!confirm('Delete this activity?')) return; await api('/api/me/activities/' + b.dataset.del, { method: 'DELETE' }); location.reload(); })));
    main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => {
      const a = activities.find((x) => x.id === Number(b.dataset.edit));
      const m = modal(`<h2 style="font-size:1.5rem;margin-bottom:12px">Edit activity</h2>${activityForm(p, a)}`);
      bindForm($('#af', m.el), async (body) => { await api('/api/me/activities/' + a.id, { method: 'PUT', body }); toast('Resubmitted'); m.close(); sActivities(main, [], { profile: p, activities: (await api('/api/me')).activities }); });
    }));
  }

  function sProfile(main, _a, { profile: p }) {
    main.innerHTML = top('Profile') + `<form class="panel form" id="pf" style="max-width:780px"><p class="muted">Programme: <strong>${esc(p.programme_label)}</strong>${p.partner_name ? ` · ${esc(p.partner_name)}` : ''}</p>
      <div class="row"><label class="f">Name<input name="name" required value="${esc(p.name)}"></label><label class="f">Phone<input name="phone" value="${esc(p.phone || '')}"></label></div>
      <div class="row"><label class="f">School / university<input name="institution" value="${esc(p.institution || '')}"></label><label class="f">Grade / year<input name="grade" value="${esc(p.grade || '')}"></label></div>
      <div class="row"><label class="f">Supervisor / coordinator name<input name="supervisor_name" value="${esc(p.supervisor_name || '')}"></label><label class="f">Supervisor email<input name="supervisor_email" value="${esc(p.supervisor_email || '')}"></label></div>
      <label class="f">Interests<textarea name="interests" style="min-height:70px">${esc(p.interests || '')}</textarea></label><label class="f">Availability<input name="availability" value="${esc(p.availability || '')}"></label>
      <button class="btn btn-primary" type="submit">Save</button></form>`;
    bindForm($('#pf'), async (b) => { await api('/api/me/profile', { method: 'PUT', body: b }); toast('Profile saved'); });
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const q = new URLSearchParams(location.search);
    if (q.get('reset')) return resetScreen(q.get('reset'));
    try {
      const st = await api('/api/auth/status');
      if (st.setupNeeded) return setupScreen();
      if (!st.user) return loginScreen();
      ME = st.user;
      return ME.role === 'student' ? studentApp() : staffApp();
    } catch (e) { authShell('Portal unavailable', esc(e.message), ''); }
  }
  boot();
})();
