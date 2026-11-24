// Build step for GitHub Pages: pre-renders every published event at /events/<slug>/ (fast first paint + SEO),
// and writes sitemap.xml and robots.txt. If the API is unreachable, it still writes a sitemap of the static pages.
//
//   API_URL=https://script.google.com/macros/s/…/exec node scripts/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'public');
const SITE = (process.env.SITE_URL || 'https://superwingsfoundation.org').replace(/\/$/, '');
const API = process.env.API_URL || (readFileSync(join(PUB, 'assets/config.js'), 'utf8').match(/API_URL:\s*'([^']+)'/) || [])[1];
const TZ = 'Asia/Kolkata';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso, o) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...o }).format(new Date(iso));
const media = (id, w) => (!id ? '' : /^https?:/.test(id) ? id : `https://lh3.googleusercontent.com/d/${id}${w ? '=w' + w : ''}`);
const today = new Date().toISOString().slice(0, 10);

async function fetchExport() {
  if (!API || API.includes('PASTE_YOUR')) { console.warn('API_URL not set: building static pages only.'); return null; }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${API}?action=export`, { redirect: 'follow' });
      const j = await res.json();
      if (j.ok) return j.data;
      throw new Error(j.error);
    } catch (e) { console.warn(`Export attempt ${i + 1} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
  }
  console.warn('API unreachable: building static pages only.');
  return null;
}

function eventPage(template, ev, settings) {
  const url = `${SITE}/events/${ev.slug}/`;
  const desc = (ev.subtitle || ev.description || '').replace(/\s+/g, ' ').slice(0, 180) || `${fmt(ev.start_at, { dateStyle: 'long' })} · ${ev.venue || 'Ahmedabad'}`;
  const img = ev.cover_id ? media(ev.cover_id, 1200) : `${SITE}/assets/logo.jpg`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Event', name: ev.title, description: desc, startDate: ev.start_at, endDate: ev.end_at,
    eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode', image: [img], url,
    location: { '@type': 'Place', name: ev.venue || 'Ahmedabad', address: { '@type': 'PostalAddress', streetAddress: ev.address || '', addressLocality: 'Ahmedabad', addressRegion: 'Gujarat', addressCountry: 'IN' } },
    organizer: { '@type': 'NGO', name: settings.org_name || 'Superwings Foundation', url: SITE },
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: 0, priceCurrency: 'INR', availability: 'https://schema.org/InStock', url, validFrom: ev.created_at || ev.start_at },
  };
  const head = `<title>${esc(ev.title)} | Superwings Foundation</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Superwings Foundation">
<meta property="og:title" content="${esc(ev.title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:url" content="${url}"><meta name="twitter:card" content="summary_large_image">
${ev.cover_id ? `<link rel="preload" as="image" href="${esc(media(ev.cover_id, 1800))}">` : ''}
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  // Content visible to search engines and to anyone without JavaScript; replaced by the live page on load.
  const agenda = ev.agenda || [];
  const body = `<main id="main"><div class="ev-hero">${ev.cover_id ? `<img class="bg" src="${esc(media(ev.cover_id, 1800))}" alt="">` : ''}<div class="wrap">
<h1>${esc(ev.title)}</h1>${ev.subtitle ? `<p class="sub">${esc(ev.subtitle)}</p>` : ''}
<div class="chips"><span class="chip y">${esc(fmt(ev.start_at, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</span>
<span class="chip">${esc(fmt(ev.start_at, { hour: 'numeric', minute: '2-digit', hour12: true }))} – ${esc(fmt(ev.end_at, { hour: 'numeric', minute: '2-digit', hour12: true }))} IST</span>${ev.venue ? `<span class="chip">${esc(ev.venue)}</span>` : ''}</div></div></div>
<section><div class="wrap">${(ev.description || '').split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')}
${agenda.length ? `<h2>Agenda</h2><ul>${agenda.map((a) => `<li>${esc(a.start_time || '')}${a.end_time ? '–' + esc(a.end_time) : ''} ${esc(a.title)}${a.speaker ? ' (' + esc(a.speaker) + ')' : ''}</li>`).join('')}</ul>` : ''}
<p><a href="/events/">All events</a></p></div></section></main>
<script>window.__EVENT__=${JSON.stringify({ event: { ...ev, agenda: undefined, ended: ev.end_at < new Date().toISOString(), can_register: !!ev.reg_open && ev.end_at >= new Date().toISOString(), seats_left: null }, agenda }).replace(/</g, '\\u003c')};</script>`;
  return template
    .replace(/<title>[\s\S]*?<\/title>/, head)
    .replace(/<main id="main">[\s\S]*?<\/main>/, body);
}

function sitemap(events) {
  const pages = [['/', 'weekly', '1.0'], ['/events/', 'daily', '0.9'], ['/volunteer', 'monthly', '0.8'], ['/donate', 'monthly', '0.7']];
  const urls = pages.map(([p, f, pr]) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod><changefreq>${f}</changefreq><priority>${pr}</priority></url>`);
  for (const e of events) {
    urls.push(`  <url><loc>${SITE}/events/${esc(e.slug)}/</loc><lastmod>${(e.updated_at || e.created_at || today).slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>${e.end_at >= new Date().toISOString() ? '0.8' : '0.5'}</priority>${e.cover_id ? `<image:image><image:loc>${esc(media(e.cover_id, 1200))}</image:loc></image:image>` : ''}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>\n`;
}

const data = await fetchExport();
const events = (data?.events || []).filter((e) => /^[a-z0-9-]+$/.test(e.slug));
const template = readFileSync(join(PUB, 'event.html'), 'utf8');

// remove pages of events that were unpublished or renamed
for (const name of readdirSync(join(PUB, 'events'))) {
  const dir = join(PUB, 'events', name);
  if (statSync(dir).isDirectory() && !events.some((e) => e.slug === name)) rmSync(dir, { recursive: true });
}
for (const ev of events) {
  mkdirSync(join(PUB, 'events', ev.slug), { recursive: true });
  writeFileSync(join(PUB, 'events', ev.slug, 'index.html'), eventPage(template, ev, data.settings || {}));
}
writeFileSync(join(PUB, '404.html'), template.replace('<title>Event | Superwings Foundation</title>', '<title>Superwings Foundation</title>\n<meta name="robots" content="noindex">'));
writeFileSync(join(PUB, 'sitemap.xml'), sitemap(events));
writeFileSync(join(PUB, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /portal/\n\nSitemap: ${SITE}/sitemap.xml\n`);
if (!existsSync(join(PUB, '.nojekyll'))) writeFileSync(join(PUB, '.nojekyll'), '');
console.log(`Built ${events.length} event page(s), sitemap.xml (${events.length + 4} URLs) and robots.txt.`);
