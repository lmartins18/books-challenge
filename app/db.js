// ---------------------------------------------------------------------------
// SQLite layer: schema, seed data, and the small amount of domain logic that
// belongs next to the data (difficulty mapping + kids/comics exclusion).
//
// One file on disk (DATA_DIR/books.db). better-sqlite3 is synchronous, which
// keeps the request handlers in server.js flat and easy to read.
// ---------------------------------------------------------------------------
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "books.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// node:sqlite has no .transaction() helper (unlike better-sqlite3), so wrap a
// function in BEGIN/COMMIT and roll back on throw.
export function tx(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS readers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    pin_hash   TEXT,                       -- NULL until the reader sets a PIN
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS seasons (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'year',   -- 'year' | 'month' | 'custom'
    starts_on TEXT NOT NULL,                   -- YYYY-MM-DD (inclusive)
    ends_on   TEXT NOT NULL,                   -- YYYY-MM-DD (inclusive)
    is_active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS genre_multipliers (
    genre_key  TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    multiplier REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    title                TEXT NOT NULL,
    author               TEXT,
    isbn13               TEXT,
    cover_url            TEXT,
    page_count           INTEGER,
    categories_json      TEXT,
    suggested_multiplier REAL NOT NULL DEFAULT 1.0,
    is_excluded          INTEGER NOT NULL DEFAULT 0,
    exclude_reason       TEXT
  );

  CREATE TABLE IF NOT EXISTS reader_books (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    reader_id             INTEGER NOT NULL REFERENCES readers(id),
    book_id               INTEGER NOT NULL REFERENCES books(id),
    difficulty_multiplier REAL NOT NULL,
    status                TEXT NOT NULL DEFAULT 'reading', -- reading|finished|abandoned
    current_page          INTEGER NOT NULL DEFAULT 0,
    started_at            TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at           TEXT,
    UNIQUE(reader_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS progress_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reader_book_id INTEGER NOT NULL REFERENCES reader_books(id) ON DELETE CASCADE,
    at             TEXT NOT NULL DEFAULT (datetime('now')),
    from_page      INTEGER NOT NULL,
    to_page        INTEGER NOT NULL,
    season_id      INTEGER REFERENCES seasons(id)
  );

  CREATE INDEX IF NOT EXISTS idx_progress_season ON progress_log(season_id);
  CREATE INDEX IF NOT EXISTS idx_readerbooks_reader ON reader_books(reader_id);
`);

// --- Seed: the two readers (PINs unset until first login) -------------------
const seedReader = db.prepare(
  "INSERT OR IGNORE INTO readers (name) VALUES (?)"
);
for (const name of ["Luis", "Eliana"]) seedReader.run(name);

// --- Seed: genre difficulty multipliers (editable in Settings) --------------
// Ordered hardest -> easiest. matchMultiplier() picks the hardest match so a
// "Philosophy / Fiction" book still reads as philosophy.
const GENRE_SEED = [
  ["religion", "Religious texts", 10.0],
  ["language", "Different language (non-native)", 2.0],
  ["philosophy", "Philosophy", 1.5],
  ["science", "Science / Math / Tech", 1.4],
  ["history", "History / Politics", 1.3],
  ["literary", "Literary / Poetry / Classics", 1.2],
  ["nonfiction", "General non-fiction", 1.15],
  ["fiction", "Popular fiction", 1.0],
];
const seedGenre = db.prepare(
  "INSERT OR IGNORE INTO genre_multipliers (genre_key, label, multiplier) VALUES (?,?,?)"
);
for (const [k, l, m] of GENRE_SEED) seedGenre.run(k, l, m);

// Keyword -> genre_key. First (hardest) match wins.
const GENRE_KEYWORDS = [
  ["religion", ["religion", "theolog", "bible", "biblical", "christian", "islam", "quran", "koran", "judais", "torah", "buddhis", "hindu", "scripture", "spiritual"]],
  ["philosophy", ["philosoph", "ethic", "metaphysic"]],
  ["science", ["science", "mathemat", "physics", "biology", "technolog", "medical", "computer", "engineering"]],
  ["history", ["history", "histor", "politic", "war", "biography", "economics"]],
  ["literary", ["literary", "poetry", "drama", "classic", "essays"]],
  ["nonfiction", ["nonfiction", "non-fiction", "self-help", "business", "psychology", "reference"]],
  ["fiction", ["fiction", "novel", "fantasy", "mystery", "romance", "thriller"]],
];

// Categories/subjects that disqualify a book from the challenge.
const EXCLUDE_KEYWORDS = [
  "juvenile", "children", "picture book", "comics", "graphic novel",
  "manga", "board book", "early reader", "ages ",
];

// Given an array of category/subject strings, return { multiplier, genre_key }.
export function matchMultiplier(categories = []) {
  const hay = categories.join(" | ").toLowerCase();
  for (const [key, words] of GENRE_KEYWORDS) {
    if (words.some((w) => hay.includes(w))) {
      const row = db
        .prepare("SELECT multiplier FROM genre_multipliers WHERE genre_key=?")
        .get(key);
      return { multiplier: row ? row.multiplier : 1.0, genre_key: key };
    }
  }
  return { multiplier: 1.0, genre_key: "fiction" };
}

// Return an exclude reason string if the categories look like a kids' book or
// comic, otherwise null.
export function exclusionReason(categories = []) {
  const hay = categories.join(" | ").toLowerCase();
  const hit = EXCLUDE_KEYWORDS.find((w) => hay.includes(w));
  return hit ? `Looks like a kids' book or comic ("${hit.trim()}")` : null;
}

// --- One-time migrations (keyed, run once per database) ----------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

function once(key, fn) {
  const done = db.prepare("SELECT value FROM app_meta WHERE key=?").get(key);
  if (done) return;
  tx(() => {
    fn();
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, datetime('now'))").run(key);
  });
}

// Armageddon reset: keep readers (and their shelves/history) but clear every
// PIN — the first login after launch sets a fresh one. Retire all previous
// seasons and start a one-month doomsday season.
once("armageddon-2026-09", () => {
  db.prepare("UPDATE readers SET pin_hash=NULL").run();
  db.prepare("UPDATE seasons SET is_active=0").run();
  // Religion split out of philosophy into its own 10x category (the seed above
  // only inserts the new row; existing DBs still carry the old combined label).
  db.prepare("UPDATE genre_multipliers SET label='Philosophy' WHERE genre_key='philosophy'").run();
  db.prepare(
    `INSERT INTO seasons (name, kind, starts_on, ends_on, is_active)
     VALUES ('Armageddon', 'custom', '2026-09-01', '2026-09-30', 1)`
  ).run();
});

// The 2026 year challenge originally ran through Dec 31, so its range overlaps
// Armageddon and September progress was credited to it (leaderboard showed 0).
// Finish the old challenge at Aug 31 and move progress logged since launch to
// the active season.
once("armageddon-2026-09-finish-old", () => {
  const active = db.prepare("SELECT id FROM seasons WHERE is_active=1").get();
  if (!active) return;
  db.prepare(
    "UPDATE seasons SET ends_on='2026-08-31' WHERE id != ? AND starts_on < '2026-09-01' AND ends_on >= '2026-09-01'"
  ).run(active.id);
  db.prepare(
    "UPDATE progress_log SET season_id=? WHERE date(at) >= '2026-09-01'"
  ).run(active.id);
});

// --- Seed: an active season for the current calendar year -------------------
export function ensureActiveSeason() {
  const active = db.prepare("SELECT * FROM seasons WHERE is_active=1").get();
  if (active) return active;
  const year = new Date().getFullYear();
  const info = db
    .prepare(
      `INSERT INTO seasons (name, kind, starts_on, ends_on, is_active)
       VALUES (?, 'year', ?, ?, 1)`
    )
    .run(`${year} Challenge`, `${year}-01-01`, `${year}-12-31`);
  return db.prepare("SELECT * FROM seasons WHERE id=?").get(info.lastInsertRowid);
}
ensureActiveSeason();

// Resolve which season a given date (YYYY-MM-DD) falls in: prefer a season
// whose range contains the date, else the active season. Ranges can overlap
// (a retired year season spans the same months as a short active one), so the
// active season wins, then monthly over yearly.
export function seasonForDate(ymd) {
  const inRange = db
    .prepare(
      "SELECT * FROM seasons WHERE ? BETWEEN starts_on AND ends_on ORDER BY is_active DESC, (kind='month') DESC LIMIT 1"
    )
    .get(ymd);
  if (inRange) return inRange;
  return db.prepare("SELECT * FROM seasons WHERE is_active=1").get();
}
