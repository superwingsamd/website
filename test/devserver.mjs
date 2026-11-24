// Local preview: serves /public like GitHub Pages and runs Code.gs in the mock Apps Script runtime at /__api.
//   node test/devserver.mjs   →  http://localhost:8787   (LATENCY=600 to feel Apps Script's delay)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { loadGas } from './gas-mock.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8787), LATENCY = Number(process.env.LATENCY || 0);
const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', jpg: 'image/jpeg', png: 'image/png', xml: 'application/xml', txt: 'text/plain' };
const { gas, props } = loadGas(ROOT + 'apps-script/Code.gs', {
  fetchHandler: (url, o) => {
    if (url.includes('oauth')) return { code: 200, body: '{"access_token":"x","expires_in":3600}' };
    if (url.includes('zeptomail') || url.includes('mail.zoho')) { const b = JSON.parse(o.payload); console.log('[mail]', b.subject, '→', b.to?.[0]?.email_address?.address || b.toAddress); return { code: 201, body: '{}' }; }
    return { code: 204, body: '' };
  },
});
gas.reset(); gas.setup(); gas.reset();
gas.doPost({ postData: { contents: JSON.stringify({ path: '/api/admin/settings', method: 'PUT', body: {}, token: null }) } });
console.log('SETUP TOKEN:', props.get('SETUP_TOKEN'));
export { gas, props };

async function file(p) {
  const tries = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html', p + '/index.html'];
  for (const t of tries) {
    try { if ((await stat(ROOT + 'public' + t)).isFile()) return { body: await readFile(ROOT + 'public' + t), type: TYPES[t.split('.').pop()] || 'application/octet-stream', status: 200 }; } catch {}
  }
  return { body: await readFile(ROOT + 'public/404.html'), type: TYPES.html, status: 404 };
}
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__api') {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
    gas.reset();
    const out = req.method === 'POST' ? gas.doPost({ postData: { contents: Buffer.concat(chunks).toString() } }) : gas.doGet({ parameter: Object.fromEntries(url.searchParams) });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(out.getContent());
  }
  if (url.pathname === '/assets/config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(`window.SW_CONFIG={API_URL:'http://localhost:${PORT}/__api'};`);
  }
  const f = await file(decodeURIComponent(url.pathname));
  res.writeHead(f.status, { 'content-type': f.type });
  res.end(f.body);
}).listen(PORT, () => console.log(`Preview on http://localhost:${PORT}`));
