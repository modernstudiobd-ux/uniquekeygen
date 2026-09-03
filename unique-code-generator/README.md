# Unique Code Generator

A production-oriented unique-code generator: GitHub Pages frontend (PWA) →
Cloudflare Worker API → Cloudflare D1, where a database-level `UNIQUE`
constraint — not browser storage, not timestamps, not device IDs — is the
only thing that decides whether a code can ever be issued.

```
GitHub Pages (PWA)  --HTTPS-->  Cloudflare Worker  -->  Cloudflare D1
                                  /api/generate           UNIQUE(code)
```

See `worker/src/index.js` for the core guarantee: candidates are never
checked-then-inserted — they're inserted directly with `INSERT OR IGNORE`,
and D1's `UNIQUE` constraint is the sole arbiter of success. Full rationale
is in the Stage 1 design notes below.

## Project structure

```
unique-code-generator/
├── frontend/              — static PWA, deployed to GitHub Pages
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── config.js          — set API_BASE_URL here after deploying the Worker
│   ├── manifest.json
│   ├── service-worker.js
│   └── icons/
├── worker/                 — Cloudflare Worker + D1
│   ├── src/
│   │   ├── index.js        — /api/generate, /api/health, orchestration
│   │   ├── charset.js       — character preset resolution
│   │   ├── pattern.js       — prefix/pattern/postfix → template
│   │   ├── random.js        — crypto.getRandomValues, unbiased selection
│   │   └── rateLimit.js
│   ├── migrations/0001_initial.sql
│   ├── test/                — unit + concurrency tests against a real SQLite-backed D1 mock
│   ├── wrangler.toml
│   └── package.json
├── .github/workflows/deploy-pages.yml   — optional auto-deploy for frontend/
└── README.md
```

## Prerequisites

- Node.js 18+ and npm
- A Cloudflare account (free tier is enough)
- A GitHub account and a repository to hold this project

## Deployment

### 1. Install Wrangler

```bash
cd worker
npm install
```

(`wrangler` is a devDependency of `worker/package.json`; the steps below use
`npx wrangler`. A global install — `npm install -g wrangler` — works too.)

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

Opens a browser window to authorize Wrangler against your Cloudflare account.

### 3. Create the D1 database

```bash
npx wrangler d1 create unique-code-generator-db
```

This prints a `database_id`. Copy it into `worker/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`.

### 4. Create tables / 5. Apply migrations

The schema lives in `worker/migrations/0001_initial.sql`. Apply it locally
first (for `wrangler dev` testing), then to the real remote database:

```bash
npx wrangler d1 migrations apply unique-code-generator-db --local
npx wrangler d1 migrations apply unique-code-generator-db --remote
```

### 6. Configure the D1 binding

Already set up in `worker/wrangler.toml` under `[[d1_databases]]` — the
Worker accesses the database through `env.DB`, matching the `binding = "DB"`
value. Nothing else to configure here beyond the `database_id` from step 3.

### 7. Deploy the Worker

```bash
npx wrangler deploy
```

### 8. Get the Worker URL

The deploy command prints something like:

```
https://unique-code-generator.<your-subdomain>.workers.dev
```

Copy this — you'll need it in the next step. You can re-fetch it anytime
with `npx wrangler deployments list`, or from the Cloudflare dashboard.

### 9. Configure the frontend API URL

Edit `frontend/config.js`:

```js
window.APP_CONFIG = {
  API_BASE_URL: "https://unique-code-generator.<your-subdomain>.workers.dev",
};
```

### 10. Deploy the frontend to GitHub Pages

Two options — pick one:

**Option A — native GitHub Pages, no Actions needed.**
GitHub Pages can only serve from the repo root or a `/docs` folder on a
branch (not an arbitrary subfolder), so either:
- rename `frontend/` to `docs/` at the repo root, or
- copy its contents into a `docs/` folder,

then in your repo: **Settings → Pages → Source: Deploy from a branch →
Branch: `main`, Folder: `/docs`**.

**Option B — GitHub Actions (keeps `frontend/` where it is).**
This repo already includes `.github/workflows/deploy-pages.yml`, which
publishes `frontend/` to GitHub Pages automatically on every push to `main`.
Just enable it once: **Settings → Pages → Source: GitHub Actions.**

Either way, note the resulting Pages URL (e.g.
`https://yourusername.github.io/your-repo/`).

**Now go back and set CORS correctly:** in `worker/wrangler.toml`, set
`ALLOWED_ORIGIN` to the **origin** of that Pages URL — scheme + host only,
no path, no trailing slash (e.g. `https://yourusername.github.io`, even if
the app itself lives under `/your-repo/` — CORS checks the origin, not the
path). Then redeploy the Worker so the new value takes effect:

```bash
npx wrangler deploy
```

Avoid leaving `ALLOWED_ORIGIN` as a wildcard (`*`) in production — scoping it
to your actual frontend origin is what the Worker's CORS headers rely on.

### 11. Test the system

**Health check:**

```bash
curl https://unique-code-generator.<your-subdomain>.workers.dev/api/health
# {"status":"ok"}
```

**Generate a small batch:**

```bash
curl -X POST https://unique-code-generator.<your-subdomain>.workers.dev/api/generate \
  -H "Content-Type: application/json" \
  -d '{"quantity":5,"length":8,"charsetPreset":"upperLowerNumbers"}'
```

You should get back 5 distinct codes and a `requestId`. Run it again — the
5 new codes will never overlap the first 5, because they're now permanent
rows in D1.

**End-to-end in the browser:**
1. Open your GitHub Pages URL.
2. Confirm the live preview updates as you change settings.
3. Generate a batch, copy/export a few codes.
4. Reload the page, check History still shows them.
5. Go offline (DevTools → Network → Offline) and confirm Generate is
   blocked with the offline message, while the UI and History still work.
6. Reinstall as a PWA (address bar install icon, or "Add to Home Screen"
   on mobile) and repeat — codes generated from a fresh install are still
   checked against the same D1 database, so duplicates across installs are
   impossible by construction.

## Local worker testing (no Cloudflare account needed)

```bash
cd worker
npm install
node test/run-tests.mjs
```

This runs the full test suite (charsets, patterns, unbiased randomness,
capacity math, rate limiting, and — most importantly — the concurrency
scenario from the spec: 3 simulated devices requesting 100 codes each
simultaneously, verified to return exactly 300 unique codes with zero
duplicates) against an in-memory SQLite database wired up to look like D1's
own binding API. It's not a substitute for testing against the real
Cloudflare edge, but it does exercise the actual worker source unmodified,
and it's what caught two real bugs during development (see git history /
prior conversation for details — an over-reservation bug in batch sizing,
and a timestamp-format bug in the rate limiter).
