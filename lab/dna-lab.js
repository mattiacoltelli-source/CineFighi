// ─── dna-lab.js ──────────────────────────────────────────────────────────────
// ESPERIMENTO — Step 4 "DNA completo" (dopo Step 1-3: playground, porzione
// reale, aumento progressivo).
//
// Stessa esplorazione spaziale dello Step 1 (approccio A, 2.5D con un filo di
// prospettiva vera), ma ora la rete è quella VERA:
//   - i dati sono la libreria del gruppo, letta come fa l'app
//     (storage.js::fetchLibrary/fetchUsers) — sola lettura, nessuna scrittura;
//   - chi si collega a chi lo decide dna.js, importato tale e quale: stesso
//     indice, stessi vicini, stesso ordine, stessi ponti, stessa chiusura;
//   - i nodi hanno lo stesso markup di dna-view.js (nodeInner/nodeButton).
// Come nel DNA vero: nessun tetto ai nodi, selettore delle persone (con la
// modalità condivisa a 2-3 persone e i punti d'incontro), pannello completo.
//
// La profondità resta la distanza in salti dal nodo che stai guardando: il
// nodo attivo davanti, i vicini subito dietro, il resto sfuma in fondo.

import * as DNA from "../dna.js?v=da87024";
import { avatarHtml } from "../ui.js?v=da87024";
import { escapeHtml } from "../cine-core.js?v=da87024";

const DNA_POSTER = "https://image.tmdb.org/t/p/w185";

// Nel bundle di prova (artifact) i dati e le locandine arrivano già dentro la
// pagina; nel repo si leggono dal vivo, con le stesse funzioni dell'app.
async function loadData() {
  if (window.__LAB_DATA__) return window.__LAB_DATA__;
  const { fetchLibrary, fetchUsers } = await import("../storage.js?v=da87024");
  const [db, users] = await Promise.all([fetchLibrary(), fetchUsers()]);
  return { db, users };
}
const posterSrc = (path) => window.__LAB_POSTERS__?.[path] || `${DNA_POSTER}${path}`;

// ─── PARAMETRI DELLO SPAZIO (invariati dallo Step 1) ─────────────────────────

const F = 560;                               // focale: più bassa = prospettiva più forte
const DEPTH = [-30, 70, 260, 440, 600];      // z per 0,1,2,3,4+ salti dal nodo attivo
const OPAC  = [1, 1, .6, .34, .2];           // stessa scala di .dna-h0..h4 (panoramica, rete piatta)
// "Nebbia di distanza" (Step 3): a zoom normale si vede la propria zona — il
// nodo attivo, i vicini, un velo dei nodi a 2 salti — e il resto svanisce
// nella profondità. Allontanandosi col pinch la nebbia si dirada fino alla
// scala qui sopra: è la panoramica. Senza, oltre i ~30 nodi i lontani
// convergevano verso il centro (prospettiva) e riempivano di rumore lo sfondo
// attorno al nodo attivo.
const OPAC_ZONA = [1, 1, .5, .1, 0];
const FOG_Z = 380;                           // quanto allontanarsi per diradarla del tutto
const FLATTEN = 0.75;                        // in panoramica la profondità si appiattisce di tanto
const LABEL_MIN_SCALE = .62;
const Z_MIN = -1500, Z_MAX = 170;           // Z_MIN largo: serve alla panoramica
const MAX_TILT = 0.14;                       // ~8°
const DRAG_THRESHOLD = 8;

// Layout: gli stessi numeri di dna-view.js (raggio, distanze minime).
const RADIUS_WIDE = 126, RADIUS_NARROW = 112;
const MIN_GAP = 94, MIN_DX = 66, MIN_DY = 92, PLACE_TRIES = 24;

// ─── STATO ───────────────────────────────────────────────────────────────────

let data = null, index = null, net = null, focusId = null, rootUser = null;
// "Tu" (nel lab lo scegli dal menu; nell'app è chi ha fatto l'accesso) e chi
// sta dentro la rete: null = tutto il gruppo, come selectedPeople in dna-view.
let me = null, selectedPeople = null, sheetOpen = false;
const vis = new Map();          // id -> { h, th, grow, dom }
const edgeDom = new Map();      // "a|b" -> <line>
const cam = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 };
let depthOn = true;
const tiltOn = true;   // provata negli Step 1-3: resta sempre accesa
let W = 0, H = 0;
let dragged = false;

const el = (id) => document.getElementById(id);
const stage = el("labStage");
const nodesEl = el("labNodes");
const edgesEl = el("labEdges");
const edgeKey = (e) => (e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`);

const ramiPerTap = () => (H >= 340 ? 5 : 4);
const raggio = () => (ramiPerTap() === 5 ? RADIUS_WIDE : RADIUS_NARROW);

// ─── AVVIO ───────────────────────────────────────────────────────────────────

function storedRoot() { try { return localStorage.getItem("dnaLabRoot"); } catch { return null; } }
function storeRoot(u) { try { localStorage.setItem("dnaLabRoot", u); } catch {} }

async function boot() {
  el("labPanel").innerHTML = `<p class="dna-hint">Sto caricando la libreria…</p>`;
  try {
    data = await loadData();
  } catch (err) {
    console.error(err);
    el("labPanel").innerHTML = `<p class="dna-hint">Non riesco a leggere la libreria. Riprova tra poco.</p>`;
    return;
  }
  const conta = likedCounts(data.db);
  const conVoti = data.users.filter(u => conta.get(u));
  const sel = el("labRoot");
  sel.innerHTML = conVoti.map(u => `<option value="${escapeHtml(u)}">Tu: ${escapeHtml(u)}</option>`).join("");
  const salvato = storedRoot();
  me = conVoti.includes(salvato) ? salvato : conVoti[0];
  sel.value = me;
  sel.addEventListener("change", () => { me = sel.value; storeRoot(me); reset(); });
  reset();
}

// ─── PERSONE (come dna-view.js: stesso selettore, stessa logica) ─────────────

function likedCounts(db) {
  const conta = new Map();
  for (const t of db || []) {
    for (const [nome, v] of Object.entries(t.votes || {})) {
      if (Number(v?.vote) >= DNA.LIKE_THRESHOLD) conta.set(nome, (conta.get(nome) || 0) + 1);
    }
  }
  return conta;
}

function rootUserFor(persone) {
  if (persone.includes(me) && index.byPerson.get(me)?.length) return me;
  return persone
    .map(u => ({ u, n: index.byPerson.get(u)?.length || 0 }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n || a.u.localeCompare(b.u))[0]?.u || null;
}

function peopleLabel() {
  if (!selectedPeople) return "Tutti";
  if (selectedPeople.length === 1) return selectedPeople[0];
  if (selectedPeople.length <= 3) return selectedPeople.map(u => (u === me ? "Tu" : u)).join(" + ");
  return `${selectedPeople.length} persone`;
}

function renderPeopleSheet() {
  const conta = likedCounts(data.db);
  const tutti = !selectedPeople;
  const riga = (nome, attiva, meta, avatar) => `
    <button type="button" class="dna-sheet__row${attiva ? " is-active" : ""}" data-user="${escapeHtml(nome)}">
      ${avatar}
      <span class="dna-sheet__name">${escapeHtml(nome === "*" ? "Tutti" : nome)}</span>
      <span class="dna-sheet__meta">${escapeHtml(meta)}</span>
      <span class="dna-sheet__dot"></span>
    </button>`;
  el("labPeopleList").innerHTML = [
    riga("*", tutti, `${data.users.length} persone`, `<span class="dna-sheet__all">∗</span>`),
    ...data.users.map(u => riga(u, !tutti && selectedPeople.includes(u), `${conta.get(u) || 0} amati`, avatarHtml(u, 26)))
  ].join("");
}

function togglePerson(nome) {
  if (nome === "*") { selectedPeople = null; return; }
  const attuale = selectedPeople ? [...selectedPeople] : [];
  const i = attuale.indexOf(nome);
  if (i === -1) attuale.push(nome); else attuale.splice(i, 1);
  selectedPeople = attuale.length ? data.users.filter(u => attuale.includes(u)) : null;
}

function openSheet(apri) {
  sheetOpen = apri;
  if (apri) renderPeopleSheet();
  el("labPeopleSheet").classList.toggle("hidden", !apri);
  el("labPeopleBtn").setAttribute("aria-expanded", apri ? "true" : "false");
}

el("labPeopleBtn").addEventListener("click", () => openSheet(!sheetOpen));
el("labPeopleDone").addEventListener("click", () => openSheet(false));
el("labPeopleList").addEventListener("click", e => {
  const riga = e.target.closest(".dna-sheet__row");
  if (!riga || !data) return;
  togglePerson(riga.dataset.user);
  renderPeopleSheet();
  reset();
});

function reset() {
  if (!data || !me) return;
  // Come showDna: la rete è proprio un'altra rete, costruita dallo stesso
  // motore sulle sole persone scelte.
  const persone = selectedPeople || data.users;
  index = DNA.buildIndex(data.db, persone);
  rootUser = rootUserFor(persone);
  el("labPeopleLabel").textContent = peopleLabel();
  el("labPeopleBtn").classList.toggle("is-active", !!selectedPeople);
  if (!rootUser) {
    net = null;
    vis.clear(); edgeDom.clear();
    nodesEl.innerHTML = ""; edgesEl.innerHTML = ""; el("labCrumbs").innerHTML = "";
    el("labPanel").innerHTML = `<p class="dna-hint">Nessuno dei selezionati ha ancora votato un titolo 7 o più.</p>`;
    return;
  }
  net = DNA.createNetwork(index, rootUser);
  focusId = net.rootId;
  const root = net.nodes.get(net.rootId);
  root.x = 0; root.y = 0;
  vis.clear(); edgeDom.clear();
  nodesEl.innerHTML = ""; edgesEl.innerHTML = "";
  Object.assign(cam, { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, vx: 0, vy: 0 });
  sync();
  retarget();
  for (const v of vis.values()) { v.h = v.th; v.grow = 1; }
  refreshUi();
  kick();
}

// ─── LAYOUT RADIALE (come dna-view.js) ───────────────────────────────────────

function baseAngleFor(node) {
  if (!node.parent) return -Math.PI / 2;
  const p = net.nodes.get(node.parent);
  if (!p || p.x === null) return -Math.PI / 2;
  return Math.atan2(node.y - p.y, node.x - p.x);
}

function tooClose(x, y, ignoreId) {
  for (const n of net.nodes.values()) {
    if (n.id === ignoreId || n.x === null) continue;
    const dx = Math.abs(n.x - x), dy = Math.abs(n.y - y);
    if (Math.hypot(dx, dy) < MIN_GAP || (dx < MIN_DX && dy < MIN_DY)) return true;
  }
  return false;
}

function place(parent, angle) {
  for (let i = 0; i < PLACE_TRIES; i++) {
    const step = Math.ceil(i / 2) * 0.26 * (i % 2 ? 1 : -1);
    const r = raggio() + Math.floor(i / 8) * 34;
    const x = parent.x + Math.cos(angle + step) * r, y = parent.y + Math.sin(angle + step) * r;
    if (!tooClose(x, y, parent.id)) return { x, y };
  }
  for (let ring = 1; ring <= 6; ring++) {
    const r = raggio() + PLACE_TRIES * 3 + ring * 34;
    for (let k = 0; k < 16; k++) {
      const a = angle + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
      const x = parent.x + Math.cos(a) * r, y = parent.y + Math.sin(a) * r;
      if (!tooClose(x, y, parent.id)) return { x, y };
    }
  }
  const r = raggio() + PLACE_TRIES * 3;
  return { x: parent.x + Math.cos(angle) * r, y: parent.y + Math.sin(angle) * r };
}

function layoutChildren(parentId, childIds) {
  const parent = net.nodes.get(parentId);
  if (!parent || !childIds.length) return;
  const base = baseAngleFor(parent);
  const spread = parentId === net.rootId ? Math.PI * 2 * (childIds.length - 1) / childIds.length : Math.PI;
  const start = base - spread / 2;
  const step = childIds.length > 1 ? spread / (childIds.length - 1) : 0;
  childIds.forEach((id, i) => {
    const node = net.nodes.get(id);
    if (!node || node.x !== null) return;
    const pos = place(parent, start + step * i);
    node.x = pos.x; node.y = pos.y;
  });
}

// ─── APRI / CHIUDI: dna.js così com'è ────────────────────────────────────────
// (Gli Step 2-3 si fermavano a 20/35/50 nodi per verificare leggibilità e
// fluidità gradino per gradino; qui, come nel DNA vero, nessun tetto.)

function expandNode(id) {
  const added = DNA.expand(net, index, id, ramiPerTap());
  layoutChildren(id, added);
  return added;
}

function retarget() {
  const hops = DNA.hopsFrom(net, focusId);
  for (const [id, v] of vis) v.th = Math.min(hops.get(id) ?? 4, 4);
}

// Allinea DOM e stato visivo alla rete: nodi/archi nuovi entrano, quelli
// richiusi da collapse() escono.
function sync() {
  for (const [id, v] of vis) {
    if (!net.nodes.has(id)) { v.dom.remove(); vis.delete(id); }
  }
  for (const n of net.nodes.values()) {
    if (n.x === null || vis.has(n.id)) continue;
    const parentVis = n.parent && vis.get(n.parent);
    vis.set(n.id, { h: parentVis ? parentVis.h : 4, th: 4, grow: n.parent ? 0 : 1, dom: nodeDom(n) });
  }
  const vivi = new Set(net.edges.map(edgeKey));
  for (const [k, line] of edgeDom) if (!vivi.has(k)) { line.remove(); edgeDom.delete(k); }
  for (const e of net.edges) {
    const k = edgeKey(e);
    if (edgeDom.has(k)) continue;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const incontro = isMeetingPoint(net.nodes.get(e.a)) || isMeetingPoint(net.nodes.get(e.b));
    line.setAttribute("class", `dna-edge dna-edge--${e.kind}${incontro ? " is-shared" : ""}`);
    edgesEl.appendChild(line);
    edgeDom.set(k, line);
  }
}

// ─── DOM: stesso markup di dna-view.js ───────────────────────────────────────

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function nodeInner(node) {
  if (node.type === "persona") return avatarHtml(node.label, 52);
  if (node.type === "film") {
    return node.meta.poster_path
      ? `<span class="dna-node__poster" style="background-image:url('${posterSrc(node.meta.poster_path)}')"></span>`
      : `<span class="dna-node__poster dna-node__poster--empty">🎬</span>`;
  }
  if (node.type === "regista") return `<span class="dna-node__director">${escapeHtml(initials(node.label))}</span>`;
  if (node.type === "attore") return `<span class="dna-node__actor">${escapeHtml(initials(node.label))}</span>`;
  return `<span class="dna-node__genre">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
}

// Stessi criteri di dna-view.js::isMeetingPoint / lovedLevel.
function isMeetingPoint(n) {
  if (!index?.shared || !selectedPeople) return false;
  if (n.type !== "film" && n.type !== "genere" && n.type !== "regista" && n.type !== "attore") return false;
  return DNA.sharedCountOf(index, n.id) === selectedPeople.length;
}

function lovedLevel(n) {
  if (n.type !== "film" || index?.shared) return 0;
  const fan = (n.meta.fans || []).length;
  return fan >= 5 ? 2 : fan >= 3 ? 1 : 0;
}

function nodeDom(n) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `dna-node dna-node--${n.type}${isMeetingPoint(n) ? " is-shared" : ""}${lovedLevel(n) ? ` is-loved-${lovedLevel(n)}` : ""}`;
  b.dataset.node = n.id;
  b.setAttribute("aria-label", n.label);
  b.innerHTML = `${nodeInner(n)}<span class="dna-node__label">${escapeHtml(n.label)}</span>`;
  nodesEl.appendChild(b);
  return b;
}

function refreshUi() {
  for (const [id, v] of vis) {
    const n = net.nodes.get(id);
    v.dom.classList.toggle("is-focus", id === focusId);
    v.dom.classList.toggle("is-root", id === net.rootId);
    v.dom.classList.toggle("is-open", n.expanded);
  }
  for (const e of net.edges) edgeDom.get(edgeKey(e))?.classList.toggle("is-focus", e.a === focusId || e.b === focusId);
  el("labHint").classList.toggle("hidden", net.nodes.size > 1);
  const n = selectedPeople?.length;
  let insieme = 0;
  if (n === 2 || n === 3) for (const f of index.films.values()) if (f.fans.length === n) insieme++;
  const affinita = insieme ? ` · ${insieme} ${insieme === 1 ? "titolo amato" : "titoli amati"} ${n === 2 ? "da entrambi" : "da tutti e tre"}` : "";
  el("labCount").textContent = `${net.nodes.size} nodi${affinita} · doppio tocco sul vuoto: panoramica`;
  renderCrumbs();
  renderPanel();
}

function renderCrumbs() {
  // Percorso più corto dalla radice al nodo attivo, sugli archi aperti.
  const prev = new Map([[net.rootId, null]]);
  const adj = new Map();
  for (const e of net.edges) {
    (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(e.b);
    (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(e.a);
  }
  const q = [net.rootId];
  while (q.length) {
    const cur = q.shift();
    for (const nx of adj.get(cur) || []) if (!prev.has(nx)) { prev.set(nx, cur); q.push(nx); }
  }
  const path = [];
  for (let id = focusId; id; id = prev.get(id)) path.unshift(id);
  el("labCrumbs").innerHTML = path.map((id, i) =>
    `${i ? `<span class="lab-crumb-sep">›</span>` : ""}<button type="button" class="lab-crumb${id === focusId ? " is-here" : ""}" data-go="${escapeHtml(id)}">${escapeHtml(net.nodes.get(id).label)}</button>`
  ).join("");
  el("labCrumbs").lastElementChild?.scrollIntoView({ inline: "end", block: "nearest" });
}

// Pannello: gli stessi testi di dna-view.js::panelBody, in versione corta.
function fansHtml(fans) {
  return `<div class="dna-fans">${fans.slice()
    .sort((a, b) => b.vote - a.vote || a.name.localeCompare(b.name))
    .map(f => `<span class="dna-fan">${avatarHtml(f.name, 22)}<span class="dna-fan__name">${escapeHtml(f.name)}</span><span class="dna-fan__vote">${f.vote.toFixed(1)}</span></span>`)
    .join("")}</div>`;
}

function panelIcon(node) {
  if (node.type === "persona") return avatarHtml(node.label, 30);
  if (node.type === "regista") return `<span class="dna-chip dna-chip--regista">${escapeHtml(initials(node.label))}</span>`;
  if (node.type === "attore") return `<span class="dna-chip dna-chip--attore">${escapeHtml(initials(node.label))}</span>`;
  if (node.type === "genere") return `<span class="dna-chip dna-chip--genere">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
  return "";
}

// Gli stessi testi di dna-view.js::panelBody.
function pillsHtml(items) {
  return `<div class="dna-pills">${items.map(t => `<span class="dna-pill">${escapeHtml(t)}</span>`).join("")}</div>`;
}

function panelBody(node) {
  const m = node.meta;
  const incontro = isMeetingPoint(node)
    ? `<p class="dna-panel__line dna-panel__line--shared">Punto d'incontro: piace a ${selectedPeople.length === 2 ? "entrambi" : "tutti e tre"}.</p>`
    : "";

  if (node.type === "persona") {
    const n = m.liked || 0;
    const io = node.label === me;
    const riga = (titolo, lista, nome, num) => (lista || []).length
      ? `<p class="dna-panel__line">${titolo}: ${lista.map(x => `${escapeHtml(x[nome])} (${x[num]})`).join(" · ")}.</p>` : "";
    return `
      <p class="dna-panel__line">${io ? "Hai" : "Ha"} amato ${n} ${n === 1 ? "titolo" : "titoli"} (voto 7 o più).</p>
      ${riga("Generi più presenti", m.topGenres, "genere", "film")}
      ${riga("Registi ricorrenti", m.topDirectors, "name", "film")}
      ${riga("Attori ricorrenti", m.topActors, "name", "film")}`;
  }

  if (node.type === "film") {
    const tipo = m.media_type === "tv" ? "Serie" : "Film";
    const regia = m.director ? `Regia di ${escapeHtml(m.director)}` : "";
    const fans = m.fans || [];
    return `
      ${incontro}
      <p class="dna-panel__line">${tipo}${regia ? ` · ${regia}` : ""}</p>
      ${(m.cast || []).length ? `<p class="dna-panel__line">Con ${m.cast.map(a => escapeHtml(a)).join(", ")}</p>` : ""}
      <p class="dna-panel__line dna-panel__label">Chi l'ha amato (${fans.length})</p>
      ${fansHtml(fans)}
      ${(m.genres || []).length ? pillsHtml(m.genres) : ""}`;
  }

  if (node.type === "regista" || node.type === "attore") {
    const titoli = (m.titoli || []).length
      ? `<p class="dna-panel__line">Nella rete: ${m.titoli.map(t => escapeHtml(t)).join(" · ")}${m.films > m.titoli.length ? ` e altri ${m.films - m.titoli.length}` : ""}.</p>`
      : "";
    return `
      ${incontro}
      <p class="dna-panel__line">${m.films} ${m.films === 1 ? "film amato" : "film amati"} nel gruppo, da ${m.people} ${m.people === 1 ? "persona" : "persone"} diverse.</p>
      ${titoli}`;
  }

  const c = m.count || 0;
  const chi = (m.topFans || []).length
    ? `<p class="dna-panel__line">Chi lo ama di più: ${m.topFans.map(f => `${escapeHtml(f.name)} (${f.film})`).join(" · ")}.</p>`
    : "";
  return `
    ${incontro}
    <p class="dna-panel__line">${c} ${c === 1 ? "titolo amato" : "titoli amati"} dal gruppo in questo genere.</p>
    ${chi}`;
}

function renderPanel() {
  const node = net.nodes.get(focusId);
  const titolo = node.type === "film" && node.meta.year ? `${node.label} (${node.meta.year})` : node.label;
  const hint = node.expanded ? "Toccalo di nuovo per richiudere" : "Toccalo per aprire i collegamenti";
  el("labPanel").innerHTML = `
    <div class="dna-panel__head">${panelIcon(node)}<strong>${escapeHtml(titolo)}</strong></div>
    ${panelBody(node)}
    <span class="dna-panel__hint">${hint}</span>`;
}

// ─── CAMERA ──────────────────────────────────────────────────────────────────

const lerpTable = (tab, h) => {
  const i = Math.max(0, Math.min(tab.length - 1, h));
  const lo = Math.floor(i), hi = Math.min(tab.length - 1, lo + 1);
  return tab[lo] + (tab[hi] - tab[lo]) * (i - lo);
};
// Allontanandosi la profondità si appiattisce: da vicino è una pila di piani
// (la tua zona davanti), da lontano diventa una mappa leggibile di tutto
// quello che hai aperto.
const depthOf = (h) => (depthOn ? lerpTable(DEPTH, h) * (1 - FLATTEN * nebbia()) : 0);
const focusPlane = () => depthOf(0);
function nebbia() { return depthOn ? Math.max(0, Math.min(1, -cam.z / FOG_Z)) : 1; }
function opacityAt(h) {
  const f = nebbia();
  return lerpTable(OPAC_ZONA, h) * (1 - f) + lerpTable(OPAC, h) * f;
}
const scaleAt = (z) => F / Math.max(1, F + z - cam.z);
// Scala del piano del nodo attivo per una data distanza della camera.
const scaleAtCam = (tz) => F / Math.max(1, F + focusPlane() - tz);

function aimAt(id, newIds = []) {
  const f = net.nodes.get(id);
  let minX = f.x, maxX = f.x, minY = f.y, maxY = f.y;
  for (const nid of newIds) {
    const n = net.nodes.get(nid);
    if (!n || n.x === null || Math.hypot(n.x - f.x, n.y - f.y) > raggio() * 1.3) continue;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const r = raggio();
  const clamp = (v, c) => Math.max(c - r, Math.min(c + r, v));
  cam.tx = clamp((minX + maxX) / 2, f.x);
  cam.ty = clamp((minY + maxY) / 2, f.y);
  cam.tz = 0;
  cam.vx = cam.vy = 0;
}

function clampCam() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of net.nodes.values()) {
    if (n.x === null) continue;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  cam.tx = Math.max(minX - 60, Math.min(maxX + 60, cam.tx));
  cam.ty = Math.max(minY - 60, Math.min(maxY + 60, cam.ty));
}

// ─── LOOP DI ANIMAZIONE (gira solo mentre qualcosa si muove) ─────────────────

let raf = 0, last = 0, pointersDown = 0;
let fpsFrames = 0, fpsT0 = 0;

function kick() { if (!raf && net) { last = performance.now(); fpsT0 = last; fpsFrames = 0; raf = requestAnimationFrame(frame); } }
function approach(cur, target, dt, tau) { return cur + (target - cur) * (1 - Math.exp(-dt / tau)); }

function frame(now) {
  const dt = Math.min(48, now - last);
  last = now;
  let moving = pointersDown > 0;

  if (!pointersDown && (Math.abs(cam.vx) + Math.abs(cam.vy) > 0.002)) {
    cam.tx += cam.vx * dt; cam.ty += cam.vy * dt;
    const k = Math.exp(-dt / 260);
    cam.vx *= k; cam.vy *= k;
    clampCam();
    moving = true;
  }

  const ease = (key, tkey, tau, eps) => {
    const v = approach(cam[key], cam[tkey], dt, tau);
    const lontano = Math.abs(v - cam[tkey]) > eps;
    if (lontano) moving = true;
    cam[key] = lontano ? v : cam[tkey];
  };
  ease("x", "tx", pointersDown ? 30 : 120, 0.05);
  ease("y", "ty", pointersDown ? 30 : 120, 0.05);
  ease("z", "tz", 90, 0.1);
  if (!pointersDown) { cam.tyaw = 0; cam.tpitch = 0; }
  ease("yaw", "tyaw", 160, 0.0005);
  ease("pitch", "tpitch", 160, 0.0005);

  for (const v of vis.values()) {
    const h = approach(v.h, v.th, dt, 140);
    v.h = Math.abs(h - v.th) > 0.002 ? h : v.th;
    const g = approach(v.grow, 1, dt, 120);
    v.grow = 1 - g < 0.002 ? 1 : g;
    if (v.h !== v.th || v.grow !== 1) moving = true;
  }

  draw();

  fpsFrames++;
  if (now - fpsT0 > 500) {
    el("labFps").textContent = `${Math.round(fpsFrames * 1000 / (now - fpsT0))} fps`;
    fpsFrames = 0; fpsT0 = now;
  }
  raf = moving ? requestAnimationFrame(frame) : 0;
}

function project(n, v) {
  const p = n.parent && net.nodes.get(n.parent);
  const e = 1 - Math.pow(1 - v.grow, 3);
  const wx = p && p.x !== null ? p.x + (n.x - p.x) * e : n.x;
  const wy = p && p.y !== null ? p.y + (n.y - p.y) * e : n.y;
  let dx = wx - cam.x, dy = wy - cam.y, dz = depthOf(v.h) - focusPlane();
  if (cam.yaw) {
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    [dx, dz] = [dx * c + dz * s, -dx * s + dz * c];
  }
  if (cam.pitch) {
    const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
    [dy, dz] = [dy * c + dz * s, -dy * s + dz * c];
  }
  const z = focusPlane() + dz;
  const s = scaleAt(z);
  return { x: W / 2 + dx * s, y: H * 0.47 + dy * s, s, z };
}

// Scrive nel DOM solo ciò che è cambiato dall'ultimo frame, e niente per i
// nodi fuori dal riquadro: con 50 nodi riscrivere tutto ad ogni frame (stile,
// z-index, classi, attributi degli archi) dimezzava gli fps su una CPU lenta.
const CULL_MARGIN = 90;
const setIf = (cache, key, value, write) => { if (cache[key] !== value) { cache[key] = value; write(value); } };

function draw() {
  const proj = new Map();
  for (const [id, v] of vis) {
    const n = net.nodes.get(id);
    const p = project(n, v);
    const fuori = p.x < -CULL_MARGIN || p.x > W + CULL_MARGIN || p.y < -CULL_MARGIN || p.y > H + CULL_MARGIN;
    let o = fuori ? 0 : opacityAt(v.h) * Math.min(1, v.grow * 1.6);
    if (o < 0.04) o = 0;   // nella nebbia: né disegnato né toccabile
    p.o = o;
    proj.set(id, p);
    const c = v.cache || (v.cache = {});
    const st = v.dom.style;
    // display:none e non visibility: ogni nodo ha will-change, cioè un suo
    // livello sul compositor, e con 100+ nodi anche quelli invisibili pesano.
    setIf(c, "vis", o ? "" : "none", x => { st.display = x; });
    if (!o) continue;
    setIf(c, "t", `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0) translate(-50%,-50%) scale(${p.s.toFixed(3)})`, x => { st.transform = x; });
    setIf(c, "o", o.toFixed(2), x => { st.opacity = x; });
    // Per livello di salto, non per z continuo: cambia solo quando cambia il focus.
    setIf(c, "z", String(10 - Math.round(v.h)), x => { st.zIndex = x; });
    setIf(c, "nl", p.s < LABEL_MIN_SCALE, x => { v.dom.classList.toggle("no-label", x); });
  }
  for (const e of net.edges) {
    const a = proj.get(e.a), b = proj.get(e.b), line = edgeDom.get(edgeKey(e));
    if (!a || !b || !line) continue;
    const c = line.__c || (line.__c = {});
    const va = vis.get(e.a), vb = vis.get(e.b);
    const o = a.o && b.o ? opacityAt(Math.max(va.h, vb.h)) * Math.min(va.grow, vb.grow) : 0;
    setIf(c, "o", o.toFixed(2), x => { line.style.opacity = x; });
    // Fuori dal disegno, non solo trasparente: l'SVG si ridipinge intero ad
    // ogni frame, e con 100+ nodi gli archi nella nebbia pesavano lo stesso.
    setIf(c, "d", o ? "" : "none", x => { line.style.display = x; });
    if (!o) continue;
    const focus = e.a === focusId || e.b === focusId;
    setIf(c, "x1", a.x.toFixed(1), x => line.setAttribute("x1", x));
    setIf(c, "y1", a.y.toFixed(1), x => line.setAttribute("y1", x));
    setIf(c, "x2", b.x.toFixed(1), x => line.setAttribute("x2", x));
    setIf(c, "y2", b.y.toFixed(1), x => line.setAttribute("y2", x));
    setIf(c, "w", ((focus ? 4 : 2.6) * Math.min(a.s, b.s)).toFixed(1), x => { line.style.strokeWidth = x; });
  }
}

// ─── INPUT ───────────────────────────────────────────────────────────────────

// Stessa regola di dna-view.js: toccare il nodo attivo lo apre/richiude,
// toccarne un altro lo apre (se chiuso) e ci porta la camera.
function onTapNode(id) {
  const n = net.nodes.get(id);
  if (!n) return;
  let added = [];
  if (id === focusId) {
    if (n.expanded) DNA.collapse(net, id);
    else added = expandNode(id);
  } else if (!n.expanded) {
    added = expandNode(id);
  }
  focusId = id;
  sync();
  retarget();
  aimAt(id, added);
  refreshUi();
  kick();
}

nodesEl.addEventListener("click", e => {
  const b = e.target.closest(".dna-node");
  if (!b || dragged || !net) return;
  onTapNode(b.dataset.node);
});

el("labCrumbs").addEventListener("click", e => {
  const b = e.target.closest("[data-go]");
  if (!b || !net?.nodes.has(b.dataset.go)) return;
  focusId = b.dataset.go;
  retarget();
  aimAt(focusId);
  refreshUi();
  kick();
});

const pts = new Map();
let gesture = null;

stage.addEventListener("pointerdown", e => {
  if (e.button > 0 || !net || e.target.closest(".dna-sheet")) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pointersDown = pts.size;
  if (pts.size === 1) {
    dragged = false;
    gesture = { mode: "pan", x0: e.clientX, y0: e.clientY, cx: cam.tx, cy: cam.ty, lx: e.clientX, ly: e.clientY, lt: performance.now() };
    cam.vx = cam.vy = 0;
  } else if (pts.size === 2) {
    const [p, q] = [...pts.values()];
    dragged = true;
    gesture = { mode: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, s0: scaleAtCam(cam.tz) };
    try { stage.setPointerCapture(e.pointerId); } catch {}
  }
  kick();
});

stage.addEventListener("pointermove", e => {
  if (!pts.has(e.pointerId) || !gesture) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (gesture.mode === "pinch" && pts.size >= 2) {
    const [p, q] = [...pts.values()];
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    // Proporzionale: la rete si ingrandisce quanto si allargano le dita.
    const sNew = gesture.s0 * d / gesture.d0;
    cam.tz = Math.max(Z_MIN, Math.min(Z_MAX, F + focusPlane() - F / Math.max(0.05, sNew)));
    kick();
    return;
  }
  if (gesture.mode !== "pan") return;

  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
  if (!dragged) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragged = true;
    try { stage.setPointerCapture(e.pointerId); } catch {}
  }
  // Il piano del nodo attivo segue il dito 1:1; quelli dietro scorrono più
  // piano da soli, per la prospettiva: è quello il parallax.
  const s = scaleAt(focusPlane());
  cam.tx = gesture.cx - dx / s;
  cam.ty = gesture.cy - dy / s;
  clampCam();

  const now = performance.now(), dtm = Math.max(1, now - gesture.lt);
  const vxs = (e.clientX - gesture.lx) / dtm, vys = (e.clientY - gesture.ly) / dtm;
  cam.vx = cam.vx * 0.6 + (-vxs / s) * 0.4;
  cam.vy = cam.vy * 0.6 + (-vys / s) * 0.4;
  if (tiltOn) {
    cam.tyaw = Math.max(-MAX_TILT, Math.min(MAX_TILT, -vxs * 0.09));
    cam.tpitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, vys * 0.09));
  }
  gesture.lx = e.clientX; gesture.ly = e.clientY; gesture.lt = now;
  kick();
});

function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  try { stage.releasePointerCapture(e.pointerId); } catch {}
  pointersDown = pts.size;
  if (pts.size === 1 && gesture?.mode === "pinch") {
    const [p] = [...pts.values()];
    gesture = { mode: "pan", x0: p.x, y0: p.y, cx: cam.tx, cy: cam.ty, lx: p.x, ly: p.y, lt: performance.now() };
    cam.vx = cam.vy = 0;
  } else if (!pts.size) {
    gesture = null;
    if (dragged) setTimeout(() => { dragged = false; }, 0);
    else if (!e.target.closest(".dna-node")) doppioTocco();
  }
  kick();
}
// Doppio tocco sul vuoto: panoramica (la nebbia si dirada), e di nuovo per
// tornare nella zona. Lo stesso si ottiene col pinch, ma un pinch non lo
// scopre nessuno da solo.
let ultimoTocco = 0;
function doppioTocco() {
  const now = performance.now();
  if (now - ultimoTocco >= 320) { ultimoTocco = now; return; }
  ultimoTocco = 0;
  if (cam.tz < -FOG_Z / 2) { aimAt(focusId); kick(); return; }   // di nuovo: torna nella zona
  // Panoramica: inquadra tutta la rete aperta.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of net.nodes.values()) {
    if (n.x === null) continue;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const sFit = Math.min((W - 24) / (maxX - minX + 110), (H - 24) / (maxY - minY + 120), 1);
  cam.tx = (minX + maxX) / 2;
  cam.ty = (minY + maxY) / 2 - (H * 0.03) / sFit;   // il centro del riquadro è a 0,47 H
  // A nebbia diradata il piano del focus è a z = DEPTH[0] * (1 - FLATTEN).
  cam.tz = Math.max(Z_MIN, Math.min(-FOG_Z, F + DEPTH[0] * (1 - FLATTEN) - F / sFit));
  cam.vx = cam.vy = 0;
  kick();
}

stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);

stage.addEventListener("wheel", e => {
  e.preventDefault();
  const sNew = scaleAtCam(cam.tz) * Math.exp(-e.deltaY * 0.0015);
  cam.tz = Math.max(Z_MIN, Math.min(Z_MAX, F + focusPlane() - F / sNew));
  kick();
}, { passive: false });

// ─── INTERRUTTORI DI CONFRONTO ───────────────────────────────────────────────

function bindToggle(id, get, set) {
  const b = el(id);
  b.addEventListener("click", () => {
    set(!get());
    b.classList.toggle("is-on", get());
    b.setAttribute("aria-pressed", get() ? "true" : "false");
    kick();
  });
}
bindToggle("labDepth", () => depthOn, v => { depthOn = v; });
el("labReset").addEventListener("click", reset);

function measure() {
  W = stage.clientWidth;
  H = stage.clientHeight;
  kick();
}
window.addEventListener("resize", measure);
measure();
boot();
// Solo per le prove automatiche: lo stato in sola lettura.
window.__dnaLab = { get net() { return net; }, get focusId() { return focusId; } };
