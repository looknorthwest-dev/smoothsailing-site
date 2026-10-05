// SmoothSailing front end: plain ES modules, no build step. All dynamic text goes through textContent (h()).
const $ = (s, el = document) => el.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}

// Two backends, one API: window.SS_API (config.js) is the Apps Script web-app URL; empty means the local dev server (REST).
// Apps Script gets one JSON envelope per call, sent as text/plain so the browser doesn't need a CORS preflight.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
let passAsk = null;
function askPass(msg = "") {
  passAsk ??= new Promise((resolve) => {
    const input = h("input", { type: "password", autocomplete: "current-password", required: true, style: "width:100%" });
    const box = h("form", { class: "card", style: "max-width:380px;margin:12vh auto", onsubmit: (ev) => { ev.preventDefault(); passAsk = null; overlay.remove(); resolve(input.value); } },
      h("h2", {}, "⛵ SmoothSailing"), h("p", { class: "meta" }, msg || "Enter your passphrase to continue."), input,
      h("div", { style: "margin-top:12px" }, h("button", { class: "primary" }, "Unlock")));
    const overlay = h("div", { style: "position:fixed;inset:0;background:var(--bg);z-index:30;padding:16px" }, box);
    document.body.append(overlay); input.focus();
  });
  return passAsk;
}

async function api(method, url, body, retried = false) {
  if (!window.SS_API) {
    const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  }
  const pass = store.get("ss_pass") ?? (await askPass());
  let j;
  try {
    const r = await fetch(window.SS_API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ pass, method, path: url, body: body ?? {} }) });
    j = await r.json();
  } catch { throw new Error("Couldn't reach the SmoothSailing server. Check your connection and try again."); }
  if (j.ok) { store.set("ss_pass", pass); return j.data; }
  if (j.status === 401) {
    store.del("ss_pass");
    if (!retried) { const p = await askPass("That passphrase didn't work. Try again."); store.set("ss_pass", p); return api(method, url, body, true); }
  }
  throw new Error(j.error || "Request failed");
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), err ? 6000 : 2500);
}
// Run an action, show errors as a toast, disable the button while busy.
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

// For slow Claude calls: show progress on the button, and put its label back on failure.
async function thinking(btn, doneLabel, fn) {
  const before = btn.textContent;
  btn.textContent = "Thinking…";
  const ok = await act(btn, async () => { await fn(); return true; });
  btn.textContent = ok ? doneLabel : before;
}

const CAT = { health: "Health", creativity: "Creativity", learning: "Learning", upkeep: "Upkeep", recreation: "Recreation" };
const catDot = (c) => h("span", { class: `dot cat-${c}`, title: CAT[c] });
const fmtMin = (m) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? (m % 60) + "m" : ""}`.trim() : `${m}m`);
const dayName = (iso) => new Date(iso + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const every = (t) => (t.cadence_every === 1 ? `every ${t.cadence_unit}` : `every ${t.cadence_every} ${t.cadence_unit}s`);

const view = $("#view");
// replaceChildren() would render null/false as text, so filter first.
const mount = (...kids) => view.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const views = { today, plan, routines, journal, wins, settings };
let current = "today";

async function show() {
  current = views[location.hash.slice(1)] ? location.hash.slice(1) : "today";
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + current));
  try { await views[current](); } catch (e) { mount(h("div", { class: "card" }, h("b", {}, "Couldn't load this page. "), e.message)); }
}
window.addEventListener("hashchange", show);
const refresh = () => show();

// ---------------------------------------------------------------------------------------------------------------- Today
async function today() {
  const d = await api("GET", "/api/today");
  const mode = d.day.mode;
  const labelInput = h("input", { placeholder: "What's the big thing? (optional)", value: d.day.label, maxlength: 80 });
  const setMode = (m) => (ev) => act(ev.currentTarget, async () => {
    const r = await api("PUT", `/api/days/${d.date}`, { mode: m, label: labelInput.value });
    if (r.moved.length) toast(`Pushed back ${r.moved.length} routine${r.moved.length > 1 ? "s" : ""} to open days`);
    refresh();
  });
  const seg = h("div", { class: "seg" }, [["normal", "Normal day"], ["major", "Major project day"], ["rest", "Rest day"]]
    .map(([m, t]) => h("button", { class: mode === m ? "on" : "", onclick: setMode(m) }, t)));

  const banner = mode === "normal" ? null : h("div", { class: `banner ${mode}` },
    mode === "major" ? "Major project day — routine chores are pushed back so you can focus." : "Rest day — routines are pushed back. Take it easy.",
    d.day.label ? ` (${d.day.label})` : "");

  const upcoming = d.upcoming.filter((u) => u.mode !== "normal");

  mount(
    h("h1", {}, dayName(d.date)),
    h("p", { class: "sub" }, "Set the shape of today and SmoothSailing will move the movable stuff out of the way."),
    h("div", { class: "inline", style: "margin-bottom:14px" }, seg, labelInput),
    banner,
    upcoming.length ? h("p", { class: "meta" }, "Coming up: ", upcoming.map((u) => `${dayName(u.date)} (${u.mode}${u.label ? ": " + u.label : ""})`).join(" · ")) : null,
    h("div", { class: "grid" }, weatherCard(d.weather), bodyCard(d), balanceCard(d.balance)),
    h("div", { class: "card" }, h("h2", {}, "Due now"),
      d.due.length ? d.due.map((t) => dueRow(t)) : h("div", { class: "empty" }, mode === "normal" ? "Nothing due. Enjoy the calm." : "Nothing on the list today — that's the point.")),
    d.pushed.length ? h("div", { class: "card" }, h("h2", {}, "Pushed back"),
      d.pushed.map((t) => h("div", { class: `row cat-${t.category}` }, h("span", { class: "dot" }),
        h("div", { class: "grow" }, h("div", { class: "title" }, t.title), h("div", { class: "meta" }, `was ${dayName(t.pushed_from)} → now ${dayName(t.next_due)}`))))) : null,
    quickLog(d),
    d.done_today.length ? h("div", { class: "card" }, h("h2", {}, "Done today"), d.done_today.map(entryRow)) : null,
  );
}

function weatherCard(w) {
  const c = h("div", { class: "card" }, h("h2", {}, "Weather"));
  if (!w) { c.append(h("div", { class: "empty" }, "Set your location in ", h("a", { href: "#settings" }, "Settings"), " to see the forecast.")); return c; }
  c.append(h("div", { class: "big" }, `${w.now.temp}${w.units}`), h("div", { class: "meta" }, `${w.now.summary} · feels ${w.now.feels}${w.units} · wind ${w.now.wind} · ${w.location}`));
  for (const day of w.days) c.append(h("div", { class: "row" }, h("div", { class: "grow" }, dayName(day.date)),
    h("div", { class: "meta" }, `${day.summary} ${day.high}°/${day.low}° · ${day.rain_chance ?? 0}% rain`)));
  return c;
}

function bodyCard(d) {
  const r = d.reading, c = h("div", { class: "card" }, h("h2", {}, "Body (Fitbit)"));
  if (!d.readings.length) { c.append(h("div", { class: "empty" }, "No readings yet. Connect Fitbit or enter numbers in ", h("a", { href: "#settings" }, "Settings"), ".")); return c; }
  const latest = r ?? d.readings[0];
  const stat = (v, l) => h("div", {}, h("b", {}, v ?? "–"), h("span", {}, l));
  c.append(h("div", { class: "meta" }, r ? "Today" : `Latest (${dayName(latest.date)})`),
    h("div", { class: "stat" }, stat(latest.steps?.toLocaleString(), "steps"),
      stat(latest.sleep_minutes != null ? fmtMin(latest.sleep_minutes) : null, "sleep"),
      stat(latest.resting_hr, "resting bpm"), stat(latest.active_minutes, "active min")));
  const maxSteps = Math.max(1, ...d.readings.map((x) => x.steps ?? 0));
  c.append(h("h3", {}, "Steps, last week"), h("div", { style: "display:flex;gap:4px;align-items:flex-end;height:48px" },
    [...d.readings].reverse().map((x) => h("div", { title: `${dayName(x.date)}: ${x.steps ?? "?"}`, style: `flex:1;background:var(--accent);opacity:.75;border-radius:3px;height:${Math.max(4, ((x.steps ?? 0) / maxSteps) * 100)}%` }))));
  return c;
}

function balanceCard(bal) {
  const max = Math.max(1, ...bal.map((b) => b.minutes));
  return h("div", { class: "card" }, h("h2", {}, "Balance, last 14 days"),
    bal.map((b) => h("div", { class: "bal" }, h("span", {}, b.name),
      h("div", { class: "bar" }, h("i", { style: `width:${(b.minutes / max) * 100}%;background:var(--c-${b.category})` })),
      h("span", { class: "meta", title: `${b.count} things` }, b.minutes ? fmtMin(b.minutes) : "—"))),
    h("p", { class: "meta" }, "Short bars are the areas that have been quiet lately."));
}

function dueRow(t) {
  const done = (win) => (ev) => act(ev.currentTarget, async () => { await api("POST", `/api/tasks/${t.id}/complete`, { accomplishment: win }); toast(win ? "Done — added to Wins ★" : "Done"); refresh(); });
  return h("div", { class: `row cat-${t.category}` }, h("span", { class: "dot" }),
    h("div", { class: "grow" }, h("div", { class: "title" }, t.title),
      h("div", { class: "meta" }, `${CAT[t.category]}${t.subcategory ? " · " + t.subcategory : ""} · ${every(t)} · ~${fmtMin(t.est_minutes)}`)),
    t.days_overdue ? h("span", { class: "tag warn" }, `${t.days_overdue}d overdue`) : null,
    h("button", { class: "primary", onclick: done(false) }, "Done"),
    h("button", { title: "Done, and it's a win", onclick: done(true) }, "★"),
    t.deferrable ? h("button", { class: "ghost", onclick: (ev) => act(ev.currentTarget, async () => { await api("POST", `/api/tasks/${t.id}/push`, { days: 1 }); refresh(); }) }, "Later") : null);
}

function quickLog(d) {
  const title = h("input", { placeholder: "Something you did…", required: true, style: "flex:1;min-width:180px" });
  const cat = h("select", {}, d.categories.map((c) => h("option", { value: c.id }, c.name)));
  const mins = h("input", { type: "number", min: 0, placeholder: "min", style: "width:80px" });
  const win = h("input", { type: "checkbox" });
  return h("form", { class: "card", onsubmit: (ev) => { ev.preventDefault(); act(ev.submitter, async () => {
      await api("POST", "/api/completions", { title: title.value, category: cat.value, minutes: mins.value, accomplishment: win.checked }); toast("Logged"); refresh(); }); } },
    h("h2", {}, "Log something you did"), h("div", { class: "inline" }, title, cat, mins, h("label", { class: "inline", style: "margin:0" }, win, "★ win"), h("button", { class: "primary" }, "Add")));
}

// ------------------------------------------------------------------------------------------------------- Plan & Food
async function plan() {
  const d = await api("GET", "/api/today");
  const pantry = h("textarea", { placeholder: "What's in the fridge/pantry? Anything to use up? (optional)" });
  const planBox = h("div"), foodBox = h("div");
  const renderPlan = (p) => planBox.replaceChildren(...(p ? planView(p, d.date) : [h("div", { class: "empty" }, "No plan yet for today.")]));
  const renderFood = (f) => foodBox.replaceChildren(...(f ? foodView(f) : [h("div", { class: "empty" }, "No ideas yet.")]));
  renderPlan(d.plan); renderFood(d.food);
  mount(
    h("h1", {}, "Plan & Food"),
    h("p", { class: "sub" }, "Claude looks at your day type, weather, Fitbit trends, what's due and what you've neglected."),
    h("div", { class: "card" }, h("div", { class: "inline" }, h("h2", { style: "margin:0;flex:1" }, "Today's plan"),
      h("button", { class: "primary", onclick: (ev) => thinking(ev.currentTarget, "Re-plan", async () => renderPlan(await api("POST", "/api/ai/plan"))) }, d.plan ? "Re-plan" : "Plan my day")), planBox),
    h("div", { class: "card" }, h("div", { class: "inline" }, h("h2", { style: "margin:0;flex:1" }, "Food prep ideas"),
      h("button", { class: "primary", onclick: (ev) => thinking(ev.currentTarget, "More ideas", async () => renderFood(await api("POST", "/api/ai/food", { pantry: pantry.value }))) }, d.food ? "More ideas" : "Get ideas")),
      h("label", {}, "Pantry notes"), pantry, foodBox),
  );
}

function planView(p, date) {
  const out = [h("div", { class: "title", style: "font-size:1.1rem" }, p.headline), h("p", { class: "meta" }, p.read_of_the_day)];
  for (const when of ["morning", "midday", "afternoon", "evening"]) {
    const bs = p.blocks.filter((b) => b.when === when);
    if (!bs.length) continue;
    out.push(h("div", { class: "when" }, when));
    for (const b of bs) out.push(h("div", { class: `row cat-${b.category}` }, h("span", { class: "dot" }),
      h("div", { class: "grow" }, h("div", { class: "title" }, b.title), h("div", { class: "meta" }, b.why)), h("span", { class: "tag" }, fmtMin(b.minutes))));
  }
  if (p.push_back.length) {
    out.push(h("div", { class: "when" }, "Suggested to push back"));
    for (const x of p.push_back) out.push(h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, `Routine #${x.task_id} → ${dayName(x.to_date)}`), h("div", { class: "meta" }, x.reason)),
      h("button", { onclick: (ev) => act(ev.currentTarget, async () => { await api("POST", `/api/tasks/${x.task_id}/push`, { to: x.to_date }); toast("Pushed"); ev.currentTarget.disabled = true; }) }, "Apply")));
  }
  out.push(h("p", { class: "meta", style: "margin-top:12px" }, p.balance_note));
  return out;
}

function foodView(f) {
  return [h("p", { class: "meta" }, f.theme), ...f.ideas.map((i) => h("div", { class: "row" }, h("div", { class: "grow" },
    h("div", { class: "title" }, i.name), h("div", { class: "meta" }, i.why_today), h("div", {}, i.how)),
    h("span", { class: "tag" }, `${i.prep_minutes}m`), i.batch_friendly ? h("span", { class: "tag good" }, "batch") : null)),
    f.shopping_note ? h("p", { class: "meta" }, "🛒 " + f.shopping_note) : null];
}

// ------------------------------------------------------------------------------------------------------------ Routines
async function routines() {
  const tasks = await api("GET", "/api/tasks");
  const cats = Object.keys(CAT);
  mount(
    h("div", { class: "inline" }, h("h1", { style: "flex:1" }, "Routines"), h("button", { class: "primary", onclick: () => taskDialog() }, "+ Add routine")),
    h("p", { class: "sub" }, "Things that come around again — daily, weekly, monthly, yearly. The next one is due a full cycle after you actually finish this one."),
    ...cats.map((c) => {
      const list = tasks.filter((t) => t.category === c);
      return h("div", { class: "card" }, h("h2", {}, CAT[c]), list.length ? list.map((t) => h("div", { class: `row cat-${c}`, style: t.active ? "" : "opacity:.5" }, h("span", { class: "dot" }),
        h("div", { class: "grow" }, h("div", { class: "title" }, t.title), h("div", { class: "meta" }, `${t.subcategory ? t.subcategory + " · " : ""}${every(t)} · ~${fmtMin(t.est_minutes)} · next ${t.next_due ? dayName(t.next_due) : "—"}${t.last_done ? " · last " + dayName(t.last_done) : ""}`)),
        t.deferrable ? null : h("span", { class: "tag", title: "Never pushed back on major days" }, "fixed"),
        h("button", { class: "ghost", onclick: () => taskDialog(t) }, "Edit"))) : h("div", { class: "empty" }, "Nothing here yet."));
    }));
}

function taskDialog(t = null) {
  const dlg = $("#dlg");
  const f = {
    title: h("input", { value: t?.title ?? "", required: true, maxlength: 200, style: "width:100%" }),
    category: h("select", {}, Object.entries(CAT).map(([id, n]) => h("option", { value: id, selected: (t?.category ?? "upkeep") === id }, n))),
    subcategory: h("input", { value: t?.subcategory ?? "", placeholder: "cleaning, maintenance, food…" }),
    every: h("input", { type: "number", min: 1, value: t?.cadence_every ?? 1, style: "width:80px" }),
    unit: h("select", {}, ["day", "week", "month", "year"].map((u) => h("option", { value: u, selected: (t?.cadence_unit ?? "week") === u }, u + "(s)"))),
    mins: h("input", { type: "number", min: 1, value: t?.est_minutes ?? 20, style: "width:90px" }),
    next: h("input", { type: "date", value: t?.next_due ?? new Date().toLocaleDateString("sv") }),
    defer: h("input", { type: "checkbox", checked: t ? t.deferrable : true }),
    active: h("input", { type: "checkbox", checked: t ? t.active : true }),
  };
  const body = () => ({ title: f.title.value, category: f.category.value, subcategory: f.subcategory.value, cadence_every: f.every.value,
    cadence_unit: f.unit.value, est_minutes: f.mins.value, next_due: f.next.value, deferrable: f.defer.checked, active: f.active.checked });
  dlg.replaceChildren(h("form", { method: "dialog", onsubmit: (ev) => { ev.preventDefault(); act(ev.submitter, async () => {
      await (t ? api("PUT", `/api/tasks/${t.id}`, body()) : api("POST", "/api/tasks", body())); dlg.close(); refresh(); }); } },
    h("h2", {}, t ? "Edit routine" : "New routine"),
    h("label", {}, "Name"), f.title,
    h("div", { class: "cols2" }, h("div", {}, h("label", {}, "Category"), f.category), h("div", {}, h("label", {}, "Kind (optional)"), f.subcategory)),
    h("label", {}, "Repeats every"), h("div", { class: "inline" }, f.every, f.unit),
    h("div", { class: "cols2" }, h("div", {}, h("label", {}, "Minutes"), f.mins), h("div", {}, h("label", {}, "Next due"), f.next)),
    h("label", { class: "inline" }, f.defer, "Can be pushed back on major / rest days"),
    t ? h("label", { class: "inline" }, f.active, "Active") : null,
    h("div", { class: "inline", style: "margin-top:16px" },
      h("button", { class: "primary" }, "Save"), h("button", { type: "button", onclick: () => dlg.close() }, "Cancel"),
      t ? h("button", { type: "button", class: "danger ghost", style: "margin-left:auto", onclick: (ev) => { if (confirm(`Delete "${t.title}"? Past completions stay in your journal.`)) act(ev.currentTarget, async () => { await api("DELETE", `/api/tasks/${t.id}`); dlg.close(); refresh(); }); } }, "Delete") : null)));
  dlg.showModal();
}

// --------------------------------------------------------------------------------------------- Journal & Wins
function entryRow(e) {
  return h("div", { class: `row cat-${e.category}` }, h("span", { class: "dot" }),
    h("div", { class: "grow" }, h("div", { class: "title" }, e.title), h("div", { class: "meta" }, `${CAT[e.category]}${e.subcategory ? " · " + e.subcategory : ""}${e.minutes ? " · " + fmtMin(e.minutes) : ""}${e.notes ? " · " + e.notes : ""}`)),
    h("button", { class: "star" + (e.accomplishment ? " on" : ""), title: "Toggle win", onclick: (ev) => act(ev.currentTarget, async () => { await api("PATCH", `/api/completions/${e.id}`, { accomplishment: !e.accomplishment }); refresh(); }) }, e.accomplishment ? "★" : "☆"),
    h("button", { class: "ghost danger", title: "Delete entry", onclick: (ev) => { if (confirm("Delete this entry?")) act(ev.currentTarget, async () => { await api("DELETE", `/api/completions/${e.id}`); refresh(); }); } }, "✕"));
}

function grouped(entries, keyFn, labelFn) {
  const groups = new Map();
  for (const e of entries) { const k = keyFn(e); (groups.get(k) ?? groups.set(k, []).get(k)).push(e); }
  return [...groups].map(([k, list]) => h("div", { class: "card" }, h("h2", {}, labelFn(k), h("span", { class: "meta" }, `  ${list.length}`)), list.map(entryRow)));
}

async function journal() {
  const filter = sessionStorage.getItem("jcat") ?? "";
  const rows = await api("GET", "/api/completions" + (filter ? `?category=${filter}` : ""));
  const sel = h("select", { onchange: (e) => { sessionStorage.setItem("jcat", e.target.value); refresh(); } },
    h("option", { value: "" }, "All categories"), Object.entries(CAT).map(([id, n]) => h("option", { value: id, selected: filter === id }, n)));
  mount(h("div", { class: "inline" }, h("h1", { style: "flex:1" }, "Journal"), sel),
    h("p", { class: "sub" }, "A record of everything you've done. Tap ☆ to make something a win."),
    ...(rows.length ? grouped(rows, (e) => e.completed_on, dayName) : [h("div", { class: "empty" }, "Nothing logged yet.")]));
}

async function wins() {
  const rows = await api("GET", "/api/completions?accomplishments=1");
  const month = (iso) => new Date(iso + "T12:00").toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const counts = Object.entries(CAT).map(([id, n]) => h("div", {}, h("b", {}, rows.filter((r) => r.category === id).length), h("span", {}, n)));
  mount(h("h1", {}, "Wins"), h("p", { class: "sub" }, `${rows.length} accomplishment${rows.length === 1 ? "" : "s"} so far.`),
    h("div", { class: "card" }, h("div", { class: "stat" }, counts)),
    ...(rows.length ? grouped(rows, (e) => month(e.completed_on), (m) => m) : [h("div", { class: "empty" }, "Star something you've done (☆ in the Journal, or ★ when you mark a routine done) and it lands here.")]));
}

// ------------------------------------------------------------------------------------------------------------ Settings
async function settings() {
  const s = await api("GET", "/api/settings");
  const loc = h("input", { value: s.location, placeholder: "City, e.g. Portland, Oregon", style: "flex:1;min-width:200px" });
  const units = h("select", {}, ["imperial", "metric"].map((u) => h("option", { value: u, selected: s.units === u }, u === "imperial" ? "°F / mph" : "°C / km/h")));
  const food = h("textarea", { placeholder: "Allergies, dislikes, diet, equipment, how much you like to cook…" }, s.food_prefs);
  const profile = h("textarea", { style: "min-height:220px", placeholder: "Who you are, how you like to be talked to, what balance means for you…" }, s.profile);
  const R = (id) => h("input", { type: "number", min: 0, step: "any", id: "r-" + id, style: "width:110px" });
  const r = { steps: R("steps"), sleep_hours: R("sleep"), resting_hr: R("hr"), active_minutes: R("act") };
  mount(h("h1", {}, "Settings"),
    h("div", { class: "card" }, h("h2", {}, "Location & units"), h("div", { class: "inline" }, loc, units),
      h("div", { style: "margin-top:10px" }, h("button", { class: "primary", onclick: (ev) => act(ev.currentTarget, async () => {
        const out = await api("PUT", "/api/settings", { location: loc.value, units: units.value }); toast(out.location ? `Location: ${out.location}` : "Saved"); refresh(); }) }, "Save"))),
    h("div", { class: "card" }, h("h2", {}, "Food preferences"), food,
      h("div", { style: "margin-top:10px" }, h("button", { onclick: (ev) => act(ev.currentTarget, async () => { await api("PUT", "/api/settings", { food_prefs: food.value }); toast("Saved"); }) }, "Save"))),
    h("div", { class: "card" }, h("h2", {}, "About us (private)"),
      h("p", { class: "meta" }, "Sent to Claude with every plan so suggestions fit your life. Stored only in your database. No codes or passwords."), profile,
      h("div", { style: "margin-top:10px" }, h("button", { onclick: (ev) => act(ev.currentTarget, async () => { await api("PUT", "/api/settings", { profile: profile.value }); toast("Saved"); }) }, "Save"))),
    h("div", { class: "card" }, h("h2", {}, "Fitbit"),
      h("p", { class: "meta" }, !s.fitbit.configured ? "Not configured — add FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET to the backend settings (see README)." : s.fitbit.connected ? "Connected." : "Configured, not connected."),
      h("div", { class: "inline" },
        s.fitbit.configured && !s.fitbit.connected ? h("button", { class: "primary", onclick: (ev) => act(ev.currentTarget, async () => {
          const { url } = await api("POST", "/api/fitbit/connect"); window.open(url, "_blank", "noopener"); toast("Approve in the Fitbit tab, then come back and press Sync now"); }) }, "Connect Fitbit") : null,
        s.fitbit.connected ? [h("button", { class: "primary", onclick: (ev) => act(ev.currentTarget, async () => { await api("POST", "/api/fitbit/sync"); toast("Synced"); }) }, "Sync now"),
          h("button", { onclick: (ev) => act(ev.currentTarget, async () => { await api("POST", "/api/fitbit/disconnect"); refresh(); }) }, "Disconnect")] : null),
      h("h3", {}, "Or enter today's numbers by hand"),
      h("div", { class: "inline" }, ["steps", "sleep_hours", "resting_hr", "active_minutes"].map((k) => h("label", { style: "margin:0" }, k.replace("_", " "), h("br"), r[k]))),
      h("div", { style: "margin-top:10px" }, h("button", { onclick: (ev) => act(ev.currentTarget, async () => {
        await api("POST", "/api/readings", { steps: r.steps.value, sleep_minutes: r.sleep_hours.value === "" ? "" : Math.round(r.sleep_hours.value * 60), resting_hr: r.resting_hr.value, active_minutes: r.active_minutes.value });
        toast("Saved"); }) }, "Save reading"))),
    h("div", { class: "card" }, h("h2", {}, "Claude"), h("p", { class: "meta" }, s.ai.configured ? `API key found. Planning and food ideas use ${s.ai.model ?? "Claude"}.` : "No API key yet — add ANTHROPIC_API_KEY to the backend settings (see README).")));
}

show();
