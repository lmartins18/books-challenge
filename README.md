# 📚 Book Challenge

A self-hosted, installable **PWA** for a fair, friendly reading competition
between two readers (Luis & Eliana). It scores **pages read, not books
finished**, and weights every page by a **difficulty multiplier** — because
grinding through philosophy is harder than a beach novel.

## How it's fair

- **Pages, not books.** A 700-page tome beats three novellas. Progress is
  logged as "I'm now on page N"; the page delta is what counts.
- **Difficulty multiplier.** `score = pages_read × multiplier`. Each book gets a
  multiplier auto-suggested from its genre (Philosophy 1.5 · Science 1.4 ·
  History 1.3 · Literary 1.2 · General non-fiction 1.15 · Popular fiction 1.0),
  and either reader can override it per book when adding. Tunable in Settings.
- **No kids' books or comics.** Juvenile/picture-book/comic/graphic-novel/manga
  titles are detected from their categories and blocked (with a force-add escape
  hatch, since category data is imperfect).
- **Seasons.** A leaderboard per time-boxed season (a calendar year by default;
  monthly seasons too), each with its own winner; past seasons are archived.

## Book metadata

Goodreads' public API was retired in 2020, so metadata (covers, page counts,
categories) comes from two free sources, merged server-side:

- **Google Books** — reliable `pageCount` + categories (drive the multiplier and
  the kids/comics exclusion).
- **Open Library** — broad coverage and clean cover images; fallback for pages.

Add books by **title/author search** or by **scanning the ISBN barcode** with
your phone camera (PWA, HTTPS required — provided by the tunnel).

## Auth

Each reader has a **PIN** (4–8 digits). The first login sets it; it's stored
only as a **bcrypt hash**. A **signed, http-only cookie** then carries the
reader's identity (valid for a year, so you log in once per device). No external
auth provider.

## Run it locally

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Then open **http://localhost:3000**. Pick a reader, set a PIN, and start adding
books. The SQLite database is created on first boot under the `app-data` volume
(or `./app/data` if you run `node server.js` directly).

To run without Docker:

```bash
cd app && npm install && SESSION_SECRET=dev npm start
```

## Deploy (self-hosted)

Mirrors the sibling `db` project. Production is a 2-service stack — `app` +
`cloudflared` — with **no published ports**: the Cloudflare Tunnel reaches the
app over the internal Docker network and Cloudflare terminates TLS. Pushing to
`main` triggers `.github/workflows/deploy.yml` on the self-hosted runner, which
builds the image with `buildx` (AppArmor unconfined) and runs
`docker compose up -d --no-build` under the `prod` profile.

**One-time setup:**

1. Create a **Cloudflare Tunnel**; point its public hostname
   `books.lmartins18.com` at `http://app:3000`. Add the DNS record.
2. Add GitHub Actions **secrets**: `SESSION_SECRET` (e.g. `openssl rand -hex 32`),
   `CF_TUNNEL_TOKEN`, and optionally `GOOGLE_BOOKS_API_KEY`.
3. (Optional) Add a **Cloudflare Access** policy on the hostname for a second
   gate — the in-app PIN already protects all data.

The SQLite database lives on the `app-data` Docker volume and survives
redeploys.

## Layout

```
docker-compose.yml          # app + cloudflared (prod profile); no published ports
docker-compose.dev.yml      # publishes 3000, skips the tunnel
.env.example                # SESSION_SECRET, GOOGLE_BOOKS_API_KEY?, CF_TUNNEL_TOKEN
.github/workflows/deploy.yml
app/
  Dockerfile                # node:20-alpine + build toolchain for better-sqlite3
  server.js                 # express: auth, /api/*, scoring
  db.js                     # sqlite schema, seed, difficulty + exclusion logic
  metadata.js               # Open Library + Google Books, merged & normalized
  public/                   # index.html, app.js, styles.css, manifest, sw.js, icons
```

## Notes & limits

- **Difficulty data is imperfect.** Genre categories from the APIs aren't always
  precise; the per-book override and the editable multipliers in Settings are
  the fix. Force-add is there for the same reason on exclusions.
- **Barcode scanning** uses the native `BarcodeDetector` API where available
  (Android/Chrome) and lazy-loads ZXing from a CDN otherwise (iOS/Safari). The
  ISBN lookup itself is online, so this needs connectivity anyway.
- **Future ideas (not in v1):** charts (pages-over-time, head-to-head race),
  reading streaks, milestone badges.
```
# books-challenge
