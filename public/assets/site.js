// Shared front-end helpers: Apps Script transport, instant cached loading, page chrome.
const SW = (() => {
  const TZ = 'Asia/Kolkata';
  const API = (window.SW_CONFIG && window.SW_CONFIG.API_URL) || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const media = (id, w) => (!id ? '' : /^https?:\/\//.test(id) ? id : `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}${w ? '=w' + w : ''}`);
  const fmt = (iso, o) => {
    let d = new Date(iso);
    if (isNaN(d.getTime()) && typeof iso === 'string') d = new Date(iso.replace(' ', 'T'));
    if (isNaN(d.getTime())) return iso ? String(iso) : '';
    return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...o }).format(d);
  };
  const date = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true });
  const when = (s, e) => (fmt(s, { dateStyle: 'medium' }) === fmt(e, { dateStyle: 'medium' })
    ? `${date(s)} · ${time(s)} – ${time(e)}` : `${date(s)}, ${time(s)} – ${date(e)}, ${time(e)}`);
  const paras = (t) => esc(t || '').split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</p>`).join('');
  const eventUrl = (slug) => `/events/${encodeURIComponent(slug)}/`;

  // ---------------------------------------------------------------- storage (never throws)
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const token = { get: () => store.get('sw_token'), set: (t) => store.set('sw_token', t), clear: () => store.del('sw_token') };

  // ---------------------------------------------------------------- transport
  // All calls are POSTs with a text/plain body, so the browser sends no CORS preflight to Apps Script.
  const mem = new Map(); // GET responses kept briefly in memory, cleared by any write
  const MEM_TTL = 60_000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function raw(path, method, body) {
    if (!navigator.onLine) throw Object.assign(new Error('You appear to be offline.'), { network: true });
    if (!API || API.includes('PASTE_YOUR')) throw Object.assign(new Error('The website is not connected to its server yet.'), { status: 0 });
    let res;
    try { res = await fetch(API, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ path, method, body: body || {}, token: token.get() }),
    }); } catch { throw Object.assign(new Error('Could not reach the server (network or deployment problem).'), { network: true }); }
    let j;
    try { j = await res.json(); }
    catch { throw Object.assign(new Error('The server did not answer with data. Check that the Apps Script web app is deployed with access set to "Anyone" and that config.js has the latest /exec URL.'), { status: 0, network: true }); }
    if (!j.ok) {
      if (j.status === 401 && token.get() && !path.startsWith('/api/auth/login')) token.clear();
      throw Object.assign(new Error(j.error || 'Request failed'), { status: j.status });
    }
    if (j.data && typeof j.data === 'object' && j.data.token) token.set(j.data.token);
    return j.data;
  }

  async function api(path, opts = {}) {
    const method = (opts.method || (opts.body ? 'POST' : 'GET')).toUpperCase();
    if (method !== 'GET') {
      if (!opts.keepCache) mem.clear();
      return raw(path, method, opts.body);
    }
    const hit = mem.get(path);
    if (hit && Date.now() - hit.t < MEM_TTL && !opts.fresh) return hit.p;
    const p = (async () => {
      let last;
      for (let i = 0; i < 3; i++) { // quiet retries for flaky networks / cold starts
        try { return await raw(path, 'GET'); }
        catch (e) { last = e; if (!e.network) break; await sleep(700 * (i + 1)); }
      }
      throw last;
    })();
    mem.set(path, { t: Date.now(), p });
    p.catch(() => mem.delete(path));
    return p;
  }

  /**
   * Stale-while-revalidate: paints cached data instantly (from a previous visit), then refreshes in the background.
   * render(data, fromCache) is called once or twice. onFail runs only if there is no cached copy and every retry failed.
   */
  async function live(path, render, onFail) {
    const key = 'swc:' + path, cached = store.get(key);
    if (cached) { try { render(cached.d, true); } catch (e) { console.warn(e); } }
    try {
      const fresh = await api(path);
      const same = cached && JSON.stringify(cached.d) === JSON.stringify(fresh);
      store.set(key, { d: fresh, t: Date.now() });
      if (!same) render(fresh, false);
      return fresh;
    } catch (e) {
      if (!cached && onFail) onFail(e);
      return cached ? cached.d : null;
    }
  }

  // A calm, non-alarming placeholder with a retry button.
  function gentle(el, retry, text = 'This is taking longer than usual.') {
    el.innerHTML = `<div class="gentle"><div class="dots"><i></i><i></i><i></i></div><p>${esc(text)}</p><button class="btn btn-ghost">Try again</button></div>`;
    el.querySelector('button').onclick = retry;
  }
  const skeleton = (n = 3, cls = 'sk-card') => Array.from({ length: n }, () => `<div class="${cls} sk"></div>`).join('');

  let siteP;
  const site = () => (siteP ||= new Promise((resolve) => {
    let done = false;
    live('/api/site', (d) => { if (!done) { done = true; resolve(d); } else document.dispatchEvent(new CustomEvent('sw:site', { detail: d })); },
      () => { if (!done) { done = true; resolve({ settings: {}, trustees: [], coordinators: [], partners: [], events: [], programmes: {} }); } });
  }));

  // Run fn with site data now (cached or fresh) and again whenever fresher data arrives.
  function onSite(fn) {
    site().then((d) => { try { fn(d); } catch (e) { console.warn(e); } });
    document.addEventListener('sw:site', (e) => { try { fn(e.detail); } catch (x) { console.warn(x); } });
  }

  // ---------------------------------------------------------------- forms
  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') {
        if (el.dataset.multi) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); }
        else out[el.name] = el.checked;
      } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    }
    return out;
  }
  function bindForm(form, onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      let box = form.querySelector(':scope > .alert');
      if (!box) { box = document.createElement('div'); box.className = 'alert'; box.hidden = true; form.prepend(box); }
      box.hidden = true;
      if (btn) { btn.disabled = true; btn.dataset.label ||= btn.textContent; btn.innerHTML = '<span class="spin"></span> Please wait…'; }
      try { await onSubmit(formData(form)); }
      catch (err) {
        box.className = 'alert err';
        box.textContent = err.status ? err.message : 'We could not reach the server. Please check your connection and try again.';
        box.hidden = false; box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; } }
    });
  }

  // ---------------------------------------------------------------- chrome, transitions, prefetch
  function chrome(active) {
    const links = [['/#about', 'About'], ['/events/', 'Events'], ['/volunteer', 'Volunteer'], ['/donate', 'Donate'], ['/#contact', 'Contact']];
    const header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML = `<div class="wrap nav">
      <a href="/" class="brand" aria-label="Superwings Foundation home"><img src="/assets/logo.jpg" alt="Superwings Foundation" width="111" height="58"></a>
      <button class="menu-btn" aria-label="Open menu" aria-expanded="false"><span></span><span></span><span></span></button>
      <ul>${links.map(([h, t]) => `<li><a href="${h}" class="${t === active ? 'active' : ''}">${t}</a></li>`).join('')}
        <li><a href="/portal/" class="btn btn-primary">${token.get() ? 'My portal' : 'Sign in'}</a></li></ul></div>`;
    document.body.prepend(header);
    const ul = header.querySelector('ul'), mb = header.querySelector('.menu-btn');
    mb.onclick = () => mb.setAttribute('aria-expanded', ul.classList.toggle('open'));
    ul.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => ul.classList.remove('open')));

    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `<div class="wrap"><div class="foot-grid">
      <div><span class="logo-pill"><img src="/assets/logo.jpg" alt="Superwings Foundation" width="92" height="48"></span>
        <p style="font-size:.94rem;max-width:300px">A public charitable trust working in education, skills, health and community welfare across Gujarat.</p></div>
      <div><h4>Explore</h4><ul><li><a href="/#about">About us</a></li><li><a href="/#work">Our work</a></li><li><a href="/#trustees">Trustees</a></li><li><a href="/events/">Events</a></li></ul></div>
      <div><h4>Get involved</h4><ul><li><a href="/volunteer">Volunteer</a></li><li><a href="/volunteer#partner">Partner with us</a></li><li><a href="/donate">Donate</a></li><li><a href="/verify">Verify a document</a></li><li><a href="/portal/">Portal sign in</a></li></ul></div>
      <div><h4>Contact</h4><ul id="foot-contact"><li><a href="mailto:contact@superwingsfoundation.org">contact@superwingsfoundation.org</a></li><li>+91 99250 21383</li></ul></div>
    </div><div class="legal"><span>© ${new Date().getFullYear()} Superwings Foundation · Public Charitable Trust</span><span id="foot-reg">Reg. No. E/23237/Ahmedabad</span></div></div>`;
    document.body.append(footer);
    const paint = ({ settings: s }) => {
      if (!s?.contact_email) return;
      footer.querySelector('#foot-contact').innerHTML = `<li><a href="mailto:${esc(s.contact_email)}">${esc(s.contact_email)}</a></li>
        <li><a href="tel:${esc(String(s.contact_phone).replace(/\s/g, ''))}">${esc(s.contact_phone)}</a></li><li style="opacity:.8">${esc(s.address)}</li>`;
      footer.querySelector('#foot-reg').textContent = [`Reg. No. ${s.reg_no}`, s.reg_12a && `12A: ${s.reg_12a}`, s.reg_80g && `80G: ${s.reg_80g}`].filter(Boolean).join(' · ');
    };
    site().then(paint);
    document.addEventListener('sw:site', (e) => paint(e.detail));
    prefetchOnIntent();
  }

  // Warm the data (and the HTML) for a page as soon as the visitor shows intent to open it.
  const warmed = new Set();
  function warm(href) {
    let u; try { u = new URL(href, location.href); } catch { return; }
    if (u.origin !== location.origin || warmed.has(u.pathname)) return;
    warmed.add(u.pathname);
    const l = document.createElement('link'); l.rel = 'prefetch'; l.href = u.pathname; document.head.append(l);
    const m = u.pathname.match(/^\/events\/([^/]+)\/?$/);
    const path = m ? `/api/events/${m[1]}` : u.pathname.replace(/\/$/, '') === '/events' ? '/api/events' : null;
    if (path && !store.get('swc:' + path)) api(path).then((d) => store.set('swc:' + path, { d, t: Date.now() })).catch(() => {});
  }
  function prefetchOnIntent() {
    const h = (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (a) warm(a.getAttribute('href')); };
    document.addEventListener('mouseover', h, { passive: true });
    document.addEventListener('touchstart', h, { passive: true });
    document.addEventListener('focusin', h);
  }

  function reveal() {
    if (!('IntersectionObserver' in window)) { document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in')); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.reveal:not(.in)').forEach((el) => io.observe(el));
  }

  function eventCard(ev) {
    const day = fmt(ev.start_at, { day: 'numeric' }), mon = fmt(ev.start_at, { month: 'short' });
    return `<a class="ev-card reveal in" href="${eventUrl(ev.slug)}">
      <div class="ev-cover">${ev.cover_id ? `<img src="${media(ev.cover_id, 800)}" alt="" loading="lazy" onload="this.classList.add('ld')">` : `<div class="ph-mark">${esc(ev.title)}</div>`}
        <div class="datechip"><b>${day}</b><small>${mon}</small></div></div>
      <div class="ev-body"><h3>${esc(ev.title)}</h3>${ev.subtitle ? `<p>${esc(ev.subtitle)}</p>` : ''}
        <div class="ev-meta">${esc(time(ev.start_at))}${ev.venue ? ' · ' + esc(ev.venue) : ''}</div></div></a>`;
  }
  const personPh = (p) => (p.photo_id ? `<img src="${media(p.photo_id, 600)}" alt="${esc(p.name)}" loading="lazy" onload="this.classList.add('ld')">` : esc(initials(p.name)));

  return { clearCache: () => mem.clear(), onSite, esc, initials, media, date, time, when, paras, api, live, gentle, skeleton, site, bindForm, formData, chrome, reveal, eventCard, personPh, fmt, token, store, eventUrl, API };
})();
