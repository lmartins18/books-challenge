// ---------------------------------------------------------------------------
// Book metadata. Goodreads' API is dead (retired 2020), so we use two free
// sources and merge them:
//   - Google Books  -> reliable pageCount + categories (drive the difficulty
//                       multiplier and the kids/comics exclusion)
//   - Open Library  -> good coverage + clean cover images, fallback for pages
//
// Everything here runs server-side: keeps the optional API key off the client
// and sidesteps browser CORS. Results are normalized to a single shape:
//   { source, title, author, isbn13, coverUrl, pageCount, categories: [] }
// ---------------------------------------------------------------------------
const GOOGLE_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";
const UA = { headers: { "User-Agent": "book-challenge/1.0 (self-hosted)" } };

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...UA, ...opts });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// --- Google Books -----------------------------------------------------------
function normGoogle(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn13 = (ids.find((i) => i.type === "ISBN_13") || {}).identifier || null;
  let coverUrl = (v.imageLinks || {}).thumbnail || (v.imageLinks || {}).smallThumbnail || null;
  if (coverUrl) coverUrl = coverUrl.replace(/^http:/, "https:");
  return {
    source: "google",
    title: v.title || "Untitled",
    author: (v.authors || []).join(", ") || null,
    isbn13,
    coverUrl,
    pageCount: v.pageCount || null,
    categories: v.categories || [],
  };
}

async function googleSearch(q, max = 8) {
  const key = GOOGLE_KEY ? `&key=${GOOGLE_KEY}` : "";
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}${key}`;
  const data = await getJson(url);
  return (data.items || []).map(normGoogle);
}

// --- Open Library -----------------------------------------------------------
function olCover(coverId, isbn13) {
  if (coverId) return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
  if (isbn13) return `https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg`;
  return null;
}

async function openLibrarySearch(q, max = 8) {
  const fields = "title,author_name,isbn,cover_i,number_of_pages_median,subject";
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${max}&fields=${fields}`;
  const data = await getJson(url);
  return (data.docs || []).map((d) => ({
    source: "openlibrary",
    title: d.title || "Untitled",
    author: (d.author_name || []).join(", ") || null,
    isbn13: (d.isbn || []).find((x) => x.length === 13) || null,
    coverUrl: olCover(d.cover_i, (d.isbn || [])[0]),
    pageCount: d.number_of_pages_median || null,
    categories: (d.subject || []).slice(0, 12),
  }));
}

// The old /api/books?jscmd=data endpoint is deprecated and returns non-JSON,
// so use the stable edition endpoint /isbn/{isbn}.json and resolve the author
// name(s) and work subjects with follow-up calls. Subjects live on the work.
async function openLibraryByIsbn(isbn) {
  let ed;
  try {
    ed = await getJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
  } catch {
    return null;
  }
  // Resolve author names (best-effort, parallel).
  const author = (
    await Promise.all(
      (ed.authors || []).slice(0, 3).map(async (a) => {
        try {
          const j = await getJson(`https://openlibrary.org${a.key}.json`);
          return j.name;
        } catch {
          return null;
        }
      })
    )
  )
    .filter(Boolean)
    .join(", ");
  // Subjects from the work (drive the difficulty multiplier), best-effort.
  let categories = ed.subjects || [];
  const workKey = (ed.works || [])[0]?.key;
  if (!categories.length && workKey) {
    try {
      const w = await getJson(`https://openlibrary.org${workKey}.json`);
      categories = (w.subjects || []).slice(0, 12);
    } catch {
      /* leave empty */
    }
  }
  return {
    source: "openlibrary",
    title: ed.title || "Untitled",
    author: author || null,
    isbn13: (ed.isbn_13 || [])[0] || (isbn.length === 13 ? isbn : null),
    coverUrl: olCover((ed.covers || [])[0], isbn),
    pageCount: ed.number_of_pages || null,
    categories,
  };
}

// Fill gaps in `primary` from `extra` without overwriting good values.
function merge(primary, extra) {
  if (!extra) return primary;
  return {
    ...primary,
    coverUrl: primary.coverUrl || extra.coverUrl,
    pageCount: primary.pageCount || extra.pageCount,
    isbn13: primary.isbn13 || extra.isbn13,
    author: primary.author || extra.author,
    categories: primary.categories?.length ? primary.categories : extra.categories,
  };
}

// --- Public API -------------------------------------------------------------
// Search: Google first (rich categories/pages), Open Library as backup. Then
// backfill missing covers/pages from Open Library by ISBN.
export async function search(q) {
  let results = [];
  try {
    results = await googleSearch(q);
  } catch {
    /* fall through to Open Library */
  }
  if (results.length === 0) {
    try {
      results = await openLibrarySearch(q);
    } catch {
      /* leave empty */
    }
  }
  return results.filter((r) => r.title);
}

// Single-book ISBN lookup (barcode scan). Try Google Books first (one call,
// rich data), then Open Library's edition endpoint; merge to fill any gaps.
export async function lookupIsbn(isbn) {
  const clean = String(isbn).replace(/[^0-9Xx]/g, "");
  let g = null,
    ol = null;
  try {
    g = (await googleSearch(`isbn:${clean}`, 1))[0] || null;
  } catch {
    /* ignore */
  }
  try {
    ol = await openLibraryByIsbn(clean);
  } catch {
    /* ignore */
  }
  if (!g && !ol) return null;
  // Prefer whichever has categories (drives difficulty); fill the rest.
  const primary = g && g.categories.length ? g : ol || g;
  return merge(primary, primary === g ? ol : g);
}
