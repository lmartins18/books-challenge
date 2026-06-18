// ---------------------------------------------------------------------------
// Book Challenge — Express server.
//
// A fair, page-weighted reading competition for two readers. Score is
// pages-read x per-book difficulty multiplier, tallied per season. Auth is a
// per-reader PIN (bcrypt-hashed) carried in a signed identity cookie.
// ---------------------------------------------------------------------------
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db,
  tx,
  matchMultiplier,
  exclusionReason,
  seasonForDate,
  ensureActiveSeason,
} from "./db.js";
import { search, lookupIsbn } from "./metadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PROD = process.env.NODE_ENV === "production";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-insecure-secret-change-me";

const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

const today = () => new Date().toISOString().slice(0, 10);

// --- Auth helpers -----------------------------------------------------------
const COOKIE = "reader";
const cookieOpts = {
  httpOnly: true,
  sameSite: "lax",
  secure: PROD,
  signed: true,
  maxAge: 1000 * 60 * 60 * 24 * 365, // a year — it's a personal device
};

function currentReaderId(req) {
  const raw = req.signedCookies?.[COOKIE];
  const id = raw ? parseInt(raw, 10) : NaN;
  return Number.isInteger(id) ? id : null;
}

// Guard: everything under /api except the auth/bootstrap routes requires a
// valid signed cookie. Mounted at "/api", so req.path here is prefix-stripped
// (e.g. "/health", not "/api/health").
const OPEN = new Set(["/health", "/readers", "/login", "/me"]);
app.use("/api", (req, res, next) => {
  if (OPEN.has(req.path)) return next();
  const id = currentReaderId(req);
  if (!id) return res.status(401).json({ error: "not_authenticated" });
  const reader = db.prepare("SELECT id, name FROM readers WHERE id=?").get(id);
  if (!reader) {
    res.clearCookie(COOKIE, cookieOpts);
    return res.status(401).json({ error: "not_authenticated" });
  }
  req.reader = reader;
  next();
});

// --- Health -----------------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Readers / auth ---------------------------------------------------------
// Login screen data: who exists and whether each has set a PIN yet.
app.get("/api/readers", (_req, res) => {
  const rows = db.prepare("SELECT id, name, pin_hash FROM readers ORDER BY id").all();
  res.json(rows.map((r) => ({ id: r.id, name: r.name, hasPin: !!r.pin_hash })));
});

// Who am I (from the cookie)? Drives the initial app render.
app.get("/api/me", (req, res) => {
  const id = currentReaderId(req);
  if (!id) return res.json({ reader: null });
  const reader = db.prepare("SELECT id, name FROM readers WHERE id=?").get(id);
  res.json({ reader: reader || null });
});

// Login. First time a reader logs in, the PIN they type becomes their PIN.
app.post("/api/login", (req, res) => {
  const { readerId, pin } = req.body || {};
  const reader = db
    .prepare("SELECT id, name, pin_hash FROM readers WHERE id=?")
    .get(readerId);
  if (!reader) return res.status(404).json({ error: "unknown_reader" });
  if (!/^\d{4,8}$/.test(String(pin || "")))
    return res.status(400).json({ error: "pin_must_be_4_to_8_digits" });

  if (!reader.pin_hash) {
    // First login sets the PIN.
    const hash = bcrypt.hashSync(String(pin), 10);
    db.prepare("UPDATE readers SET pin_hash=? WHERE id=?").run(hash, reader.id);
  } else if (!bcrypt.compareSync(String(pin), reader.pin_hash)) {
    return res.status(401).json({ error: "wrong_pin" });
  }
  res.cookie(COOKIE, String(reader.id), cookieOpts);
  res.json({ reader: { id: reader.id, name: reader.name } });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
});

app.post("/api/change-pin", (req, res) => {
  const { currentPin, newPin } = req.body || {};
  const reader = db
    .prepare("SELECT pin_hash FROM readers WHERE id=?")
    .get(req.reader.id);
  if (reader.pin_hash && !bcrypt.compareSync(String(currentPin || ""), reader.pin_hash))
    return res.status(401).json({ error: "wrong_pin" });
  if (!/^\d{4,8}$/.test(String(newPin || "")))
    return res.status(400).json({ error: "pin_must_be_4_to_8_digits" });
  db.prepare("UPDATE readers SET pin_hash=? WHERE id=?").run(
    bcrypt.hashSync(String(newPin), 10),
    req.reader.id
  );
  res.json({ ok: true });
});

// --- Metadata search / lookup ----------------------------------------------
// Attach our domain verdicts (suggested multiplier + exclusion) to each result.
function annotate(meta) {
  const { multiplier, genre_key } = matchMultiplier(meta.categories);
  const exclude = exclusionReason(meta.categories);
  return { ...meta, suggestedMultiplier: multiplier, genreKey: genre_key, excludeReason: exclude };
}

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ results: [] });
  try {
    const results = await search(q);
    res.json({ results: results.map(annotate) });
  } catch (e) {
    res.status(502).json({ error: "metadata_unavailable", detail: String(e) });
  }
});

app.get("/api/lookup", async (req, res) => {
  const isbn = String(req.query.isbn || "").trim();
  if (!isbn) return res.status(400).json({ error: "isbn_required" });
  try {
    const meta = await lookupIsbn(isbn);
    if (!meta) return res.status(404).json({ error: "not_found" });
    res.json({ result: annotate(meta) });
  } catch (e) {
    res.status(502).json({ error: "metadata_unavailable", detail: String(e) });
  }
});

// --- Seasons ----------------------------------------------------------------
app.get("/api/seasons", (_req, res) => {
  res.json({ seasons: db.prepare("SELECT * FROM seasons ORDER BY starts_on DESC").all() });
});

app.post("/api/seasons", (req, res) => {
  const { name, kind = "custom", starts_on, ends_on, activate = true } = req.body || {};
  if (!name || !starts_on || !ends_on)
    return res.status(400).json({ error: "name_dates_required" });
  const id = tx(() => {
    if (activate) db.prepare("UPDATE seasons SET is_active=0").run();
    const info = db
      .prepare(
        "INSERT INTO seasons (name, kind, starts_on, ends_on, is_active) VALUES (?,?,?,?,?)"
      )
      .run(name, kind, starts_on, ends_on, activate ? 1 : 0);
    return info.lastInsertRowid;
  });
  res.json({ season: db.prepare("SELECT * FROM seasons WHERE id=?").get(id) });
});

app.post("/api/seasons/:id/activate", (req, res) => {
  const season = db.prepare("SELECT id FROM seasons WHERE id=?").get(req.params.id);
  if (!season) return res.status(404).json({ error: "not_found" });
  tx(() => {
    db.prepare("UPDATE seasons SET is_active=0").run();
    db.prepare("UPDATE seasons SET is_active=1 WHERE id=?").run(season.id);
  });
  res.json({ ok: true });
});

// --- Leaderboard ------------------------------------------------------------
// Score = SUM(pages_delta * book difficulty) per reader for a season.
app.get("/api/leaderboard", (req, res) => {
  const season =
    (req.query.seasonId &&
      db.prepare("SELECT * FROM seasons WHERE id=?").get(req.query.seasonId)) ||
    ensureActiveSeason();
  const rows = db
    .prepare(
      `SELECT r.id, r.name,
              COALESCE(SUM((p.to_page - p.from_page) * rb.difficulty_multiplier), 0) AS score,
              COALESCE(SUM(p.to_page - p.from_page), 0)                              AS raw_pages,
              COUNT(DISTINCT CASE WHEN rb.status='finished' THEN rb.id END)          AS books_finished
       FROM readers r
       LEFT JOIN reader_books rb ON rb.reader_id = r.id
       LEFT JOIN progress_log  p ON p.reader_book_id = rb.id AND p.season_id = ?
       GROUP BY r.id
       ORDER BY score DESC, raw_pages DESC`
    )
    .all(season.id);
  const standings = rows.map((r) => ({
    ...r,
    score: Math.round(r.score * 10) / 10,
  }));
  // Cover wall: most-recently-progressed books this season.
  const covers = db
    .prepare(
      `SELECT DISTINCT b.cover_url, b.title
       FROM progress_log p
       JOIN reader_books rb ON rb.id = p.reader_book_id
       JOIN books b ON b.id = rb.book_id
       WHERE p.season_id = ? AND b.cover_url IS NOT NULL
       ORDER BY p.at DESC LIMIT 24`
    )
    .all(season.id);
  res.json({ season, standings, covers });
});

// --- My books ---------------------------------------------------------------
app.get("/api/books", (req, res) => {
  const rows = db
    .prepare(
      `SELECT rb.id, rb.status, rb.current_page, rb.difficulty_multiplier,
              rb.started_at, rb.finished_at,
              b.title, b.author, b.cover_url, b.page_count, b.id AS book_id
       FROM reader_books rb
       JOIN books b ON b.id = rb.book_id
       WHERE rb.reader_id = ?
       ORDER BY (rb.status='finished'), rb.started_at DESC`
    )
    .all(req.reader.id);
  res.json({ books: rows });
});

// Add a book to my shelf from a metadata result. Caches the book row (shared
// across readers) and creates my reader_books link.
app.post("/api/books", (req, res) => {
  const m = req.body || {};
  if (!m.title) return res.status(400).json({ error: "title_required" });

  const exclude = exclusionReason(m.categories || []);
  if (exclude && !m.force)
    return res.status(409).json({ error: "excluded", reason: exclude });

  const { multiplier } = matchMultiplier(m.categories || []);
  const difficulty =
    typeof m.difficultyMultiplier === "number" ? m.difficultyMultiplier : multiplier;

  // Reuse an existing cached book by ISBN or title+author.
  let book = m.isbn13
    ? db.prepare("SELECT * FROM books WHERE isbn13=?").get(m.isbn13)
    : null;
  if (!book)
    book = db
      .prepare("SELECT * FROM books WHERE title=? AND IFNULL(author,'')=IFNULL(?, '')")
      .get(m.title, m.author || null);

  if (!book) {
    const info = db
      .prepare(
        `INSERT INTO books (title, author, isbn13, cover_url, page_count,
                            categories_json, suggested_multiplier, is_excluded, exclude_reason)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(
        m.title,
        m.author || null,
        m.isbn13 || null,
        m.coverUrl || null,
        m.pageCount || null,
        JSON.stringify(m.categories || []),
        multiplier,
        exclude ? 1 : 0,
        exclude || null
      );
    book = db.prepare("SELECT * FROM books WHERE id=?").get(info.lastInsertRowid);
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO reader_books (reader_id, book_id, difficulty_multiplier)
         VALUES (?,?,?)`
      )
      .run(req.reader.id, book.id, difficulty);
    res.json({ readerBookId: info.lastInsertRowid, book });
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      return res.status(409).json({ error: "already_on_shelf" });
    throw e;
  }
});

// Update difficulty or status of one of my books.
app.put("/api/books/:id", (req, res) => {
  const rb = db
    .prepare("SELECT * FROM reader_books WHERE id=? AND reader_id=?")
    .get(req.params.id, req.reader.id);
  if (!rb) return res.status(404).json({ error: "not_found" });
  const difficulty =
    typeof req.body.difficultyMultiplier === "number"
      ? req.body.difficultyMultiplier
      : rb.difficulty_multiplier;
  const status = ["reading", "finished", "abandoned"].includes(req.body.status)
    ? req.body.status
    : rb.status;
  const finishedAt =
    status === "finished" ? rb.finished_at || new Date().toISOString() : null;
  db.prepare(
    "UPDATE reader_books SET difficulty_multiplier=?, status=?, finished_at=? WHERE id=?"
  ).run(difficulty, status, finishedAt, rb.id);
  res.json({ ok: true });
});

// Log progress: I'm now on page N. Records the delta against the season that
// contains today, and advances current_page. Auto-finishes at the last page.
app.post("/api/books/:id/progress", (req, res) => {
  const rb = db
    .prepare(
      `SELECT rb.*, b.page_count FROM reader_books rb
       JOIN books b ON b.id = rb.book_id
       WHERE rb.id=? AND rb.reader_id=?`
    )
    .get(req.params.id, req.reader.id);
  if (!rb) return res.status(404).json({ error: "not_found" });

  const toPage = parseInt(req.body.toPage, 10);
  if (!Number.isInteger(toPage) || toPage < 0)
    return res.status(400).json({ error: "bad_page" });
  const fromPage = rb.current_page;
  if (toPage === fromPage) return res.json({ ok: true, noChange: true });

  const season = seasonForDate(today());
  tx(() => {
    db.prepare(
      `INSERT INTO progress_log (reader_book_id, from_page, to_page, season_id)
       VALUES (?,?,?,?)`
    ).run(rb.id, fromPage, toPage, season ? season.id : null);

    const finished = rb.page_count && toPage >= rb.page_count;
    db.prepare(
      "UPDATE reader_books SET current_page=?, status=?, finished_at=? WHERE id=?"
    ).run(
      toPage,
      finished ? "finished" : rb.status === "abandoned" ? "reading" : rb.status,
      finished ? new Date().toISOString() : rb.finished_at,
      rb.id
    );
  });
  res.json({ ok: true, pagesLogged: toPage - fromPage });
});

app.delete("/api/books/:id", (req, res) => {
  const rb = db
    .prepare("SELECT id FROM reader_books WHERE id=? AND reader_id=?")
    .get(req.params.id, req.reader.id);
  if (!rb) return res.status(404).json({ error: "not_found" });
  tx(() => {
    db.prepare("DELETE FROM progress_log WHERE reader_book_id=?").run(rb.id);
    db.prepare("DELETE FROM reader_books WHERE id=?").run(rb.id);
  });
  res.json({ ok: true });
});

// --- Genre multipliers (Settings) -------------------------------------------
app.get("/api/genre-multipliers", (_req, res) => {
  res.json({
    genres: db.prepare("SELECT * FROM genre_multipliers ORDER BY multiplier DESC").all(),
  });
});

app.put("/api/genre-multipliers", (req, res) => {
  const updates = Array.isArray(req.body.genres) ? req.body.genres : [];
  const stmt = db.prepare("UPDATE genre_multipliers SET multiplier=? WHERE genre_key=?");
  tx(() => {
    for (const g of updates) {
      const m = parseFloat(g.multiplier);
      if (g.genre_key && m > 0) stmt.run(m, g.genre_key);
    }
  });
  res.json({ ok: true });
});

// --- Static PWA -------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Book Challenge listening on http://localhost:${PORT}`);
});
