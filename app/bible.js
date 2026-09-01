// ---------------------------------------------------------------------------
// Built-in metadata source: the 66 books of the Bible, Genesis -> Revelation.
//
// Page counts differ per printed edition, so progress is tracked in CHAPTERS
// (edition-independent): pageCount is the chapter count and the front-end
// shows "ch" instead of "p" for these. Categories mark them as religion so
// they pick up that genre's multiplier. Covers are generated inline SVGs —
// no external source has covers for individual Bible books.
// ---------------------------------------------------------------------------

// [name, chapters], canonical order. OT then NT.
const OT = [
  ["Genesis", 50], ["Exodus", 40], ["Leviticus", 27], ["Numbers", 36],
  ["Deuteronomy", 34], ["Joshua", 24], ["Judges", 21], ["Ruth", 4],
  ["1 Samuel", 31], ["2 Samuel", 24], ["1 Kings", 22], ["2 Kings", 25],
  ["1 Chronicles", 29], ["2 Chronicles", 36], ["Ezra", 10], ["Nehemiah", 13],
  ["Esther", 10], ["Job", 42], ["Psalms", 150], ["Proverbs", 31],
  ["Ecclesiastes", 12], ["Song of Solomon", 8], ["Isaiah", 66],
  ["Jeremiah", 52], ["Lamentations", 5], ["Ezekiel", 48], ["Daniel", 12],
  ["Hosea", 14], ["Joel", 3], ["Amos", 9], ["Obadiah", 1], ["Jonah", 4],
  ["Micah", 7], ["Nahum", 3], ["Habakkuk", 3], ["Zephaniah", 3],
  ["Haggai", 2], ["Zechariah", 14], ["Malachi", 4],
];
const NT = [
  ["Matthew", 28], ["Mark", 16], ["Luke", 24], ["John", 21], ["Acts", 28],
  ["Romans", 16], ["1 Corinthians", 16], ["2 Corinthians", 13],
  ["Galatians", 6], ["Ephesians", 6], ["Philippians", 4], ["Colossians", 4],
  ["1 Thessalonians", 5], ["2 Thessalonians", 3], ["1 Timothy", 6],
  ["2 Timothy", 4], ["Titus", 3], ["Philemon", 1], ["Hebrews", 13],
  ["James", 5], ["1 Peter", 5], ["2 Peter", 3], ["1 John", 5], ["2 John", 1],
  ["3 John", 1], ["Jude", 1], ["Revelation", 22],
];

// Generated cover: charred background, amber serif title, testament footer.
function cover(name, testament) {
  // Wrap the name onto up to three lines so long titles stay legible.
  const words = name.split(" ");
  const lines = words.length <= 1 ? [name]
    : words.length === 2 ? [words[0], words[1]]
    : [words[0], words[1], words.slice(2).join(" ")];
  const size = Math.max(...lines.map((l) => l.length)) > 9 ? 30 : 38;
  const startY = 190 - (lines.length - 1) * (size / 2 + 4);
  const text = lines
    .map((l, i) => `<tspan x="120" y="${startY + i * (size + 8)}">${l}</tspan>`)
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 360">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#1d0c08"/><stop offset="1" stop-color="#0a0404"/>` +
    `</linearGradient></defs>` +
    `<rect width="240" height="360" fill="url(#g)"/>` +
    `<rect x="8" y="8" width="224" height="344" fill="none" stroke="#f97316" stroke-opacity="0.45"/>` +
    `<text x="120" y="52" text-anchor="middle" font-family="Georgia,serif" font-size="13" letter-spacing="4" fill="#ffb08a">THE BIBLE</text>` +
    `<text text-anchor="middle" font-family="Georgia,serif" font-weight="bold" font-size="${size}" fill="#fbbf24">${text}</text>` +
    `<text x="120" y="322" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-size="13" fill="#e0cbc0">${testament}</text>` +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

const BOOKS = [
  ...OT.map(([name, ch]) => ({ name, ch, testament: "Old Testament" })),
  ...NT.map(([name, ch]) => ({ name, ch, testament: "New Testament" })),
].map((b) => ({
  source: "bible",
  title: b.name,
  author: "The Bible",
  isbn13: null,
  coverUrl: cover(b.name, b.testament),
  pageCount: b.ch,
  unit: "chapters",
  categories: ["Religion", "Bible", b.testament],
}));

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Common alternate names -> canonical title.
const ALIASES = {
  songofsongs: "Song of Solomon",
  canticles: "Song of Solomon",
  psalm: "Psalms",
  revelations: "Revelation",
  apocalypse: "Revelation",
};

// "bible" (or similar) lists all 66 in canonical order; otherwise match book
// names loosely in both directions ("john" -> John, 1-3 John; "revelations"
// still finds Revelation).
export function bibleSearch(q) {
  const qn = norm(q);
  if (qn.length < 3) return [];
  if (qn.includes("bible") || qn === "scripture") return [...BOOKS];
  const alias = Object.keys(ALIASES).find((a) => qn === a || a.includes(qn));
  return BOOKS.filter((b) => {
    const bn = norm(b.title);
    return bn.includes(qn) || qn.includes(bn) || (alias && b.title === ALIASES[alias]);
  });
}
