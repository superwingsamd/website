# Superwings Foundation: website and portal

- **Website:** static pages on **GitHub Pages** at `superwingsfoundation.org`.
- **Back end:** **Google Apps Script** (`apps-script/Code.gs`) using a **Google Sheet** as the database. It is published as a web app at your `/exec` URL.
- **Images:** stored in a Google Drive folder.
- **Email:** sent through **ZeptoMail**, falling back to the **Zoho Mail self-client**.

## Features

- **Events:** each event gets its own page at `/events/<name>/` with a cover image, details, a timed agenda and registration. Registrants get a confirmation, a reminder and a thank-you, and their data is **deleted automatically 7 days after the event**.
- **Volunteer programme:** for General, University service learning, IB Diploma CAS and IBCP Community Engagement. Students have their own sign-in to log hours, CAS strands, learning outcomes and reflections. Coordinators verify the entries, and students can print an hours statement. Universities and schools can apply to partner.
- **Trustees and coordinators:** shown with photos and messages.
- **Sign-ins:** for administrators, trustees, coordinators and students.
- **Donations:** UPI, QR code and bank details, with numbered email receipts. 12A and 80G text appears once filled in.
- **Email:** branded HTML for every email. Send from the portal and choose the From address. Bulk sends use a queue, and there is a sent log.
- **Fast loading:** pages show cached content instantly and refresh in the background. Links you hover over are prefetched. Portal sections swap in only once they are ready, and failures retry quietly without showing an error page.
- **SEO:** every published event is pre-rendered with title, description, canonical link, Open Graph tags and **schema.org Event** data. `sitemap.xml` and `robots.txt` are generated automatically.

---

## 1. Google: database and API (about 10 minutes)

1. Using the foundation's Google account, create a new **Google Sheet** and name it *Superwings Foundation – Database*.
2. In the sheet, go to **Extensions → Apps Script**. Delete what's there and paste in **`apps-script/Code.gs`**.
   In **Project Settings**, tick *Show "appsscript.json"*, then paste in **`apps-script/appsscript.json`**. This sets the time zone to Asia/Kolkata.
3. In the editor, choose the function **`setup`** and click **Run**, then approve the permissions. It creates all the tabs, the Drive image folder and the 5-minute trigger, and prints a **SETUP TOKEN** in the log.
   (You can see the token again later from **Superwings → Show setup token** in the Sheet's menu.)
4. Click **Deploy → New deployment → Web app**. Set *Execute as:* **Me** and *Who has access:* **Anyone**, then click Deploy. Copy the URL that ends in **`/exec`**.

> **When you change Code.gs later**, go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. This keeps the same `/exec` URL. If you create a *new* deployment instead, you get a new URL.

## 2. GitHub: website

1. Paste the `/exec` URL into **`public/assets/config.js`**. Optionally, also add it as a repository variable named **`SW_API_URL`** (*Settings → Secrets and variables → Actions → Variables*).
2. Go to **Settings → Pages → Source: GitHub Actions**.
3. Under **Custom domain**, enter `superwingsfoundation.org` and tick *Enforce HTTPS*. At your domain registrar, add these DNS records:
   - `A` records for `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www` → `<your-github-username>.github.io`
4. Push to `main`. The **Build and publish website** action tests the back end, pre-renders event pages, writes the sitemap and publishes the site.

**Auto-refresh when you publish an event (recommended):** create a fine-grained GitHub token for this repo with **Contents: Read and write**. Then in Apps Script, go to **Project Settings → Script Properties** and add:
`GITHUB_TOKEN` = the token, and `GITHUB_REPO` = `your-username/your-repo`.
After that, creating, editing or deleting an event rebuilds the event pages and the sitemap within a couple of minutes. Without it, they refresh every 6 hours anyway.

## 3. Google Search Console

1. Add the property **superwingsfoundation.org**. A *Domain* property, verified with a DNS TXT record, covers both `www` and the bare domain.
2. Go to **Sitemaps** and submit `https://superwingsfoundation.org/sitemap.xml`.
3. `robots.txt` already points to the sitemap and keeps `/portal/` out of search. You can test an event page with Google's *Rich Results Test* to see its Event data.

## 4. First sign-in

1. Open `https://superwingsfoundation.org/portal/`, enter the SETUP TOKEN, your name, email and a password.
2. Go to **Settings → Email delivery**:
   - **ZeptoMail:** verify `superwingsfoundation.org` in ZeptoMail (SPF, DKIM and bounce records), then paste the agent's *Send Mail Token*.
   - **Zoho Mail self-client (fallback):** at api-console.zoho.in, create a Self Client with scope `ZohoMail.messages.CREATE,ZohoMail.accounts.READ`. Exchange the code for a refresh token, paste the Client ID, Client Secret and refresh token, then press **Fetch account ID**.
   - **Gmail (last resort):** in the Apps Script editor, run `authorizeGmail` once and allow the Gmail permission. To send *as* contact@superwingsfoundation.org, add it in Gmail under *Settings → Accounts → Send mail as*. Limit: ~100 emails/day on free Gmail, 1,500 on Workspace.
   - Press **Send test email** for each. The order is ZeptoMail → Zoho → Gmail; you can change which goes first.
3. If anything fails to load, open **Settings → System check**. It tells you exactly what's missing (sheet tabs, headers, trigger, email). You can also open `<your /exec URL>?action=health` directly in a browser.
4. Add your From addresses under **Settings → From addresses**, add people under **Trustees & team**, and fill in **Settings → Donations & tax**.

Email tokens are stored in **Script Properties**, not in the Sheet, so anyone who can view the Sheet can't see them.

---

## Working on it locally

```bash
npm test          # 69 end-to-end tests of Code.gs in a mock Apps Script runtime (Node 22, no installs)
npm run preview   # http://localhost:8787: the full site + portal against the mock (setup token is printed)
LATENCY=600 npm run preview   # same, with Apps Script-like delays to check the soft loading
API_URL=https://…/exec npm run build   # pre-render event pages + sitemap from the live API
```

## Layout

```
apps-script/   Code.gs (back end), appsscript.json (manifest)
public/        the website (published as-is by GitHub Pages)
  index.html  events/index.html  event.html (event template)  volunteer.html  donate.html  404.html
  assets/      config.js (your /exec URL)  site.js  site.css  logo.jpg
  portal/      index.html  portal.js  portal.css  certificate.html
scripts/build.mjs   pre-renders /events/<slug>/, writes sitemap.xml and robots.txt
test/               gas-mock.mjs, gas.test.mjs, devserver.mjs
.github/workflows/pages.yml
```

## Notes and limits

- **Apps Script quotas:** a consumer Google account allows about 20,000 outbound requests a day (emails count here), 6 minutes per run, and about 90 minutes a day of trigger time. The 5-minute job uses only a fraction of that. Google Workspace accounts get higher limits.
- **Speed:** each Apps Script call takes roughly 0.5–1.5 seconds. The site hides this by showing cached data first and prefetching, and the server caches the public data for a few minutes.
- **Sheet tabs:** you can read the tabs, but don't rename them or reorder their columns. The `sessions`, `resets` and `outbox` tabs are hidden.
- **IB:** CAS uses the seven learning outcomes. IBCP *Service Learning* is called *Community Engagement* in the current guide (first assessment May 2027).
