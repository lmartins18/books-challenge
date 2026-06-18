// Book Challenge — vanilla front-end. One module, no framework.
// Views: leaderboard, shelf, add (search + ISBN scan), settings.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

// --- In-app dialog (promise-based; replaces native prompt/confirm) ----------
function dialog({ title, message = "", okText = "OK", cancelText = "Cancel",
                  danger = false, input = null }) {
  const modal = $("#modal");
  const field = $("#modal-field");
  const inputEl = $("#modal-input");
  const ok = $("#modal-ok");
  const cancel = $("#modal-cancel");

  $("#modal-title").textContent = title;
  const msg = $("#modal-msg");
  msg.textContent = message;
  msg.classList.toggle("hidden", !message);
  ok.textContent = okText;
  cancel.textContent = cancelText;
  ok.classList.toggle("danger", !!danger);

  if (input) {
    field.classList.remove("hidden");
    inputEl.type = input.type || "text";
    if (input.inputmode) inputEl.setAttribute("inputmode", input.inputmode);
    else inputEl.removeAttribute("inputmode");
    inputEl.placeholder = input.placeholder || "";
    inputEl.value = input.value ?? "";
  } else {
    field.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  requestAnimationFrame(() => {
    modal.classList.add("show");
    (input ? inputEl : ok).focus();
    if (input) inputEl.select();
  });

  return new Promise((resolve) => {
    const close = (result) => {
      modal.classList.remove("show");
      setTimeout(() => modal.classList.add("hidden"), 180);
      ok.onclick = cancel.onclick = scrim.onclick = inputEl.onkeydown = null;
      document.removeEventListener("keydown", onEsc, true);
      resolve(result);
    };
    const scrim = modal.querySelector(".modal-scrim");
    const accept = () => close(input ? inputEl.value : true);
    ok.onclick = accept;
    cancel.onclick = scrim.onclick = () => close(input ? null : false);
    inputEl.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); accept(); } };
    const onEsc = (e) => { if (e.key === "Escape") close(input ? null : false); };
    document.addEventListener("keydown", onEsc, true);
  });
}
const confirmDialog = (opts) => dialog({ okText: "Confirm", ...opts });
const promptDialog = (opts) => dialog({ input: { type: "text", ...opts.input }, ...opts });

const state = { me: null, view: "leaderboard" };

// --- Login ------------------------------------------------------------------
async function showLogin() {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  const { 0: readers } = [await api("/readers")];
  const pick = $("#reader-pick");
  pick.innerHTML = "";
  $("#pin-pad").classList.add("hidden");
  for (const r of readers) {
    const b = el(`<button class="btn">${esc(r.name)}${r.hasPin ? "" : " · set PIN"}</button>`);
    b.onclick = () => openPinPad(r);
    pick.appendChild(b);
  }
}

function openPinPad(reader) {
  $("#reader-pick").classList.add("hidden");
  const pad = $("#pin-pad");
  pad.classList.remove("hidden");
  $("#pin-prompt").textContent = reader.hasPin
    ? `Enter ${reader.name}'s PIN`
    : `Set a PIN for ${reader.name}`;
  $("#login-err").textContent = "";
  const pin = $("#pin");
  pin.value = "";
  pin.focus();
  const submit = async () => {
    try {
      const { reader: me } = await api("/login", { method: "POST", body: { readerId: reader.id, pin: pin.value } });
      state.me = me;
      enterApp();
    } catch (e) {
      $("#login-err").textContent =
        e.message === "wrong_pin" ? "Wrong PIN" :
        e.message === "pin_must_be_4_to_8_digits" ? "PIN must be 4–8 digits" : "Login failed";
    }
  };
  $("#pin-go").onclick = submit;
  pin.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  $("#pin-back").onclick = showLogin;
}

function enterApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#me-name").textContent = state.me.name;
  navigate(state.view);
}

$("#logout").onclick = async (e) => {
  e.preventDefault();
  await api("/logout", { method: "POST" });
  state.me = null;
  showLogin();
};

// --- Navigation -------------------------------------------------------------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => navigate(tab.dataset.view);
});
function navigate(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  ({ leaderboard: renderLeaderboard, shelf: renderShelf, add: renderAdd, settings: renderSettings }[view])();
}

// --- Leaderboard ------------------------------------------------------------
function daysLeft(ends_on) {
  const end = new Date(ends_on + "T23:59:59");
  return Math.max(0, Math.ceil((end - new Date()) / 86400000));
}
async function renderLeaderboard() {
  const v = $("#view");
  v.innerHTML = `<p class="muted">Loading…</p>`;
  const { season, standings, covers } = await api("/leaderboard");
  const max = Math.max(1, ...standings.map((s) => s.score));
  v.innerHTML = "";
  const head = el(`
    <div class="card">
      <div class="season-head"><h2>🏆 ${esc(season.name)}</h2>
        <span class="days">${daysLeft(season.ends_on)} days left</span></div>
    </div>`);
  v.appendChild(head);

  const board = el(`<div class="card"></div>`);
  standings.forEach((s, i) => {
    const leader = i === 0 && s.score > 0;
    const row = el(`
      <div class="standing ${leader ? "leader" : ""}">
        <div class="rank">${i + 1}</div>
        <div>
          <div class="name">${esc(s.name)}</div>
          <div class="sub">${s.raw_pages} pages · ${s.books_finished} finished</div>
          <div class="bar"><i style="width:${(s.score / max) * 100}%"></i></div>
        </div>
        <div class="score">${s.score}</div>
      </div>`);
    board.appendChild(row);
  });
  v.appendChild(board);

  if (covers.length) {
    const wall = el(`<div class="card"><h2>Recently read</h2><div class="coverwall"></div></div>`);
    covers.forEach((c) => wall.querySelector(".coverwall").appendChild(
      el(`<img loading="lazy" src="${esc(c.cover_url)}" alt="${esc(c.title)}" title="${esc(c.title)}">`)));
    v.appendChild(wall);
  }
}

// --- Shelf ------------------------------------------------------------------
async function renderShelf() {
  const v = $("#view");
  v.innerHTML = `<p class="muted">Loading…</p>`;
  const { books } = await api("/books");
  v.innerHTML = `<h2>📖 My Books</h2>`;
  if (!books.length) {
    v.appendChild(el(`<p class="muted">No books yet. Tap <b>Add</b> to start.</p>`));
    return;
  }
  const shelf = el(`<div class="shelf"></div>`);
  for (const b of books) {
    const pct = b.page_count ? Math.min(100, Math.round((b.current_page / b.page_count) * 100)) : 0;
    const card = el(`
      <div class="book ${b.status === "finished" ? "finished" : ""}">
        <img class="cover" loading="lazy" src="${esc(b.cover_url || "/icons/icon.svg")}" alt="">
        <div class="meta">
          <div class="t">${esc(b.title)}</div>
          <div class="a">${esc(b.author || "")}</div>
          <div class="tag">×${b.difficulty_multiplier} · ${b.current_page}${b.page_count ? "/" + b.page_count : ""} p</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </div>
      </div>`);
    card.querySelector(".cover").onclick = () => bookActions(b);
    card.querySelector(".meta").onclick = () => bookActions(b);
    shelf.appendChild(card);
  }
  v.appendChild(shelf);
}

async function bookActions(b) {
  const page = await promptDialog({
    title: b.title,
    message: `What page are you on now?${b.page_count ? " (of " + b.page_count + ")" : ""}`,
    okText: "Save progress",
    input: { type: "number", inputmode: "numeric", value: b.current_page, placeholder: "Page number" },
  });
  if (page === null) return;
  const toPage = parseInt(page, 10);
  if (!Number.isInteger(toPage)) return toast("Enter a page number");
  try {
    const r = await api(`/books/${b.id}/progress`, { method: "POST", body: { toPage } });
    if (r.pagesLogged > 0) toast(`+${r.pagesLogged} pages logged`);
    else if (r.pagesLogged < 0) toast(`Corrected to page ${toPage}`);
    renderShelf();
  } catch {
    toast("Could not log progress");
  }
}

// --- Add (search + scan) ----------------------------------------------------
function renderAdd() {
  const v = $("#view");
  v.innerHTML = `<h2>➕ Add a Book</h2>`;
  const bar = el(`
    <div class="card">
      <div class="searchbar">
        <input id="q" placeholder="Search title or author…" autocomplete="off">
        <button id="scan" class="btn ghost" title="Scan ISBN">📷</button>
      </div>
      <div id="results"></div>
    </div>`);
  v.appendChild(bar);
  const q = $("#q");
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => runSearch(q.value), 350); };
  q.onkeydown = (e) => { if (e.key === "Enter") runSearch(q.value); };
  $("#scan").onclick = startScan;
}

async function runSearch(q) {
  q = q.trim();
  const box = $("#results");
  if (!q) return (box.innerHTML = "");
  box.innerHTML = `<p class="muted">Searching…</p>`;
  try {
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    renderResults(results);
  } catch {
    box.innerHTML = `<p class="err">Search unavailable. Try again.</p>`;
  }
}

function renderResults(results) {
  const box = $("#results");
  box.innerHTML = "";
  if (!results.length) return (box.innerHTML = `<p class="muted">No matches.</p>`);
  for (const r of results) addResultCard(box, r);
}

function addResultCard(box, r) {
  const excluded = !!r.excludeReason;
  const card = el(`
    <div class="result">
      <img loading="lazy" src="${esc(r.coverUrl || "/icons/icon.svg")}" alt="">
      <div class="info">
        <div class="t">${esc(r.title)}</div>
        <div class="a">${esc(r.author || "Unknown author")}</div>
        <div class="badges">
          <span class="badge">${r.pageCount ? r.pageCount + " p" : "pages ?"}</span>
          <span class="badge">×${r.suggestedMultiplier}</span>
          ${excluded ? `<span class="badge warn">excluded</span>` : ""}
        </div>
      </div>
      <button class="btn sm">Add</button>
    </div>`);
  card.querySelector("button").onclick = () => addBook(r, excluded);
  box.appendChild(card);
}

async function addBook(r, excluded) {
  if (excluded && !(await confirmDialog({
    title: "Add this book anyway?",
    message: `${r.excludeReason}. Kids' books & comics don't count toward the challenge.`,
    okText: "Add anyway",
    danger: true,
  }))) return;
  const body = { ...r, difficultyMultiplier: r.suggestedMultiplier, force: excluded };
  try {
    await api("/books", { method: "POST", body });
    toast(`Added "${r.title}"`);
    navigate("shelf");
  } catch (e) {
    if (e.message === "already_on_shelf") toast("Already on your shelf");
    else if (e.message === "excluded") toast("Excluded — kids/comic");
    else toast("Could not add book");
  }
}

// --- ISBN barcode scanning --------------------------------------------------
// Native BarcodeDetector when available; lazy-load ZXing from a CDN otherwise.
async function startScan() {
  const overlay = $("#scanner");
  const video = $("#scan-video");
  overlay.classList.remove("hidden");
  let stream, zxingControls, raf;
  const stop = () => {
    overlay.classList.add("hidden");
    if (raf) cancelAnimationFrame(raf);
    if (zxingControls) zxingControls.stop();
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };
  $("#scan-close").onclick = stop;

  const onCode = async (raw) => {
    const isbn = String(raw).replace(/[^0-9Xx]/g, "");
    if (isbn.length < 10) return;
    stop();
    toast("Looking up…");
    try {
      const { result } = await api(`/lookup?isbn=${isbn}`);
      navigate("add");
      $("#q").value = result.title;
      renderResults([result]);
    } catch {
      toast("No book found for that barcode");
      navigate("add");
    }
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();
  } catch {
    stop();
    return toast("Camera unavailable");
  }

  if ("BarcodeDetector" in window) {
    const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a"] });
    const tick = async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) return onCode(codes[0].rawValue);
      } catch { /* keep trying */ }
      raf = requestAnimationFrame(tick);
    };
    tick();
  } else {
    try {
      const ZX = await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm");
      const reader = new ZX.BrowserMultiFormatReader();
      zxingControls = await reader.decodeFromVideoElement(video, (res) => res && onCode(res.getText()));
    } catch {
      stop();
      toast("Scanning not supported on this device");
    }
  }
}

// --- Settings ---------------------------------------------------------------
async function renderSettings() {
  const v = $("#view");
  v.innerHTML = `<h2>⚙️ Settings</h2><p class="muted">Loading…</p>`;
  const [{ genres }, { seasons }] = await Promise.all([
    api("/genre-multipliers"),
    api("/seasons"),
  ]);
  v.innerHTML = `<h2>⚙️ Settings</h2>`;

  // Difficulty multipliers
  const gcard = el(`<div class="card"><h2>Difficulty multipliers</h2>
    <p class="muted">Score = pages × multiplier. Auto-applied by genre; editable per book when adding.</p>
    <div id="genres"></div>
    <button id="save-genres" class="btn">Save multipliers</button></div>`);
  const gbox = gcard.querySelector("#genres");
  for (const g of genres) {
    gbox.appendChild(el(`<div class="genre-row">
      <label>${esc(g.label)}</label>
      <input type="number" step="0.05" min="0.1" value="${g.multiplier}" data-key="${g.genre_key}">
    </div>`));
  }
  gcard.querySelector("#save-genres").onclick = async () => {
    const updates = [...gbox.querySelectorAll("input")].map((i) => ({ genre_key: i.dataset.key, multiplier: i.value }));
    await api("/genre-multipliers", { method: "PUT", body: { genres: updates } });
    toast("Saved");
  };
  v.appendChild(gcard);

  // Seasons
  const scard = el(`<div class="card"><h2>Seasons</h2><div id="seasons"></div>
    <div class="row"><button id="new-year" class="btn ghost sm">New year</button>
      <button id="new-month" class="btn ghost sm">New month</button></div></div>`);
  const sbox = scard.querySelector("#seasons");
  for (const s of seasons) {
    const row = el(`<div class="standing">
      <div class="rank">${s.is_active ? "●" : ""}</div>
      <div><div class="name">${esc(s.name)}</div><div class="sub">${s.starts_on} → ${s.ends_on}</div></div>
      ${s.is_active ? "" : `<button class="btn sm ghost">Activate</button>`}
    </div>`);
    const btn = row.querySelector("button");
    if (btn) btn.onclick = async () => { await api(`/seasons/${s.id}/activate`, { method: "POST" }); renderSettings(); };
    sbox.appendChild(row);
  }
  scard.querySelector("#new-year").onclick = () => createSeason("year");
  scard.querySelector("#new-month").onclick = () => createSeason("month");
  v.appendChild(scard);

  // PIN
  const pcard = el(`<div class="card"><h2>Change PIN</h2>
    <input id="cur-pin" type="password" inputmode="numeric" placeholder="Current PIN">
    <div style="height:.5rem"></div>
    <input id="new-pin" type="password" inputmode="numeric" placeholder="New PIN (4–8 digits)">
    <button id="save-pin" class="btn" style="margin-top:.7rem">Update PIN</button></div>`);
  pcard.querySelector("#save-pin").onclick = async () => {
    try {
      await api("/change-pin", { method: "POST", body: { currentPin: $("#cur-pin").value, newPin: $("#new-pin").value } });
      toast("PIN updated");
      pcard.querySelectorAll("input").forEach((i) => (i.value = ""));
    } catch (e) {
      toast(e.message === "wrong_pin" ? "Current PIN wrong" : "Could not update PIN");
    }
  };
  v.appendChild(pcard);
}

async function createSeason(kind) {
  const now = new Date();
  let name, starts_on, ends_on;
  if (kind === "year") {
    const y = now.getFullYear();
    name = `${y} Challenge`; starts_on = `${y}-01-01`; ends_on = `${y}-12-31`;
  } else {
    const y = now.getFullYear(), m = now.getMonth();
    const pad = (n) => String(n + 1).padStart(2, "0");
    const last = new Date(y, m + 1, 0).getDate();
    name = now.toLocaleString("en", { month: "long", year: "numeric" });
    starts_on = `${y}-${pad(m)}-01`; ends_on = `${y}-${pad(m)}-${last}`;
  }
  await api("/seasons", { method: "POST", body: { name, kind, starts_on, ends_on, activate: true } });
  toast(`Started ${name}`);
  renderSettings();
}

// --- Boot -------------------------------------------------------------------
(async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  try {
    const { reader } = await api("/me");
    if (reader) { state.me = reader; enterApp(); }
    else showLogin();
  } catch {
    showLogin();
  }
})();
