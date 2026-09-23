// ─── dna-view.js ─────────────────────────────────────────────────────────────
// Disegna la rete costruita da dna.js. Tutta la logica di "chi si collega a
// chi" sta là: qui ci sono solo geometria, DOM e camera.
//
// Come è disegnata: i nodi sono <button> in position:absolute su un piano
// virtuale illimitato, gli archi sono <line> dentro un unico <svg> con
// overflow:visible (così le coordinate negative si vedono lo stesso). Nessuna
// libreria, nessun canvas, nessuna simulazione a forze: con al massimo 5 figli
// per nodo un layout radiale calcolato una volta sola basta, costa nulla e
// soprattutto non fa ballare i nodi già piazzati ad ogni apertura.

import {
  buildIndex, createNetwork, expand, collapse, hopsFrom, nodeType
} from "./dna.js?v=89252ec";
import { escapeHtml } from "./cine-core.js?v=89252ec";
import { avatarHtml, haptic } from "./ui.js?v=89252ec";

// Quanti vicini apre un tap. Cinque è il numero oltre il quale il ventaglio
// radiale inizia a sovrapporsi su uno schermo da telefono.
const MAX_NEIGHBOURS = 5;

// Budget DOM: oltre questi limiti (misurati DALLA camera, non dalla radice,
// altrimenti esplorando in profondità sparirebbe tutto) i nodi lontani
// perdono prima l'etichetta e poi escono dal DOM. Restano comunque in memoria
// nella rete: tornando indietro ricompaiono identici, stesse posizioni.
const MAX_DOM_NODES = 40;
const LABEL_MAX_HOPS = 2;
const DOM_MAX_HOPS = 4;

const RADIUS = 96;          // distanza figlio-genitore
const MIN_GAP = 78;         // distanza minima tra due nodi qualsiasi (nodo 52px + etichetta)
const PLACE_TRIES = 24;

// posterUrl() di cine-core serve immagini w500: qui i poster stanno in un
// nodo da 48px e possono essercene decine a schermo. w154 è circa dieci volte
// più leggero e a questa dimensione indistinguibile.
const DNA_POSTER = "https://image.tmdb.org/t/p/w154";

let index = null;
let net = null;
let focusId = null;
let signature = "";
let bound = false;

const el = (id) => document.getElementById(id);

// ─── COSTRUZIONE / RICOSTRUZIONE ─────────────────────────────────────────────

// La rete si ricostruisce solo se sono cambiati l'utente o i voti: altrimenti
// tornando sulla schermata si perderebbe tutto quello che si è esplorato.
function librarySignature(db, currentUser) {
  // Somma dei voti oltre al loro numero: così cambia anche quando un voto
  // viene solo modificato (8 → 5 toglie un film dalla rete, e il conteggio
  // da solo non se ne accorgerebbe).
  let n = 0, sum = 0;
  for (const t of db) {
    for (const v of Object.values(t.votes || {})) { n++; sum += Number(v?.vote) || 0; }
  }
  return `${currentUser}|${db.length}|${n}|${sum}`;
}

export function showDna({ db, users, currentUser }) {
  const stage = el("dnaStage");
  if (!stage) return;

  if (!db || !db.length) {
    renderMessage("Sto caricando la libreria…");
    return;
  }

  const sig = librarySignature(db, currentUser);
  if (sig !== signature || !net) {
    signature = sig;
    index = buildIndex(db, users);
    net = createNetwork(index, currentUser);
    focusId = net.rootId;
    const root = net.nodes.get(net.rootId);
    root.x = 0;
    root.y = 0;
    // Il primo livello è già aperto: una schermata con un pallino solo e
    // nessun indizio su cosa fare non aiuta nessuno.
    expandNode(net.rootId, false);
  }

  const root = net.nodes.get(net.rootId);
  if (!root || !index.byPerson.get(currentUser)?.length) {
    renderMessage("Vota almeno un titolo con 7 o più: la rete parte da lì.");
    return;
  }

  render();
}

function renderMessage(text) {
  const nodes = el("dnaNodes");
  const edges = el("dnaEdges");
  const panel = el("dnaPanel");
  if (edges) edges.innerHTML = "";
  if (nodes) nodes.innerHTML = "";
  if (panel) panel.innerHTML = `<p class="dna-hint">${escapeHtml(text)}</p>`;
}

// ─── LAYOUT RADIALE ──────────────────────────────────────────────────────────

// I figli si aprono a ventaglio dalla parte opposta al genitore: così un ramo
// cresce verso l'esterno invece di ripiegarsi su quello da cui è arrivato.
function baseAngleFor(node) {
  if (!node.parent) return -Math.PI / 2;          // radice: si parte verso l'alto
  const p = net.nodes.get(node.parent);
  if (!p || p.x === null) return -Math.PI / 2;
  return Math.atan2(node.y - p.y, node.x - p.x);
}

function tooClose(x, y, ignoreId) {
  for (const n of net.nodes.values()) {
    if (n.id === ignoreId || n.x === null) continue;
    if (Math.hypot(n.x - x, n.y - y) < MIN_GAP) return true;
  }
  return false;
}

// Una posizione occupata non si libera mai: un nodo piazzato non si muove più
// (niente jitter ad ogni apertura). Se il posto ideale è occupato si ruota di
// poco, alternando i due versi, e solo dopo si allarga il raggio.
function place(parent, angle) {
  for (let i = 0; i < PLACE_TRIES; i++) {
    const step = Math.ceil(i / 2) * 0.26 * (i % 2 ? 1 : -1);
    const r = RADIUS + Math.floor(i / 8) * 34;
    const x = parent.x + Math.cos(angle + step) * r;
    const y = parent.y + Math.sin(angle + step) * r;
    if (!tooClose(x, y, parent.id)) return { x, y };
  }
  const r = RADIUS + PLACE_TRIES * 3;
  return { x: parent.x + Math.cos(angle) * r, y: parent.y + Math.sin(angle) * r };
}

function layoutChildren(parentId, childIds) {
  const parent = net.nodes.get(parentId);
  if (!parent || !childIds.length) return;

  const base = baseAngleFor(parent);
  // La radice si apre a giro completo, tutti gli altri su un ventaglio di 180°
  // centrato sulla direzione di crescita.
  const spread = parentId === net.rootId ? Math.PI * 2 * (childIds.length - 1) / childIds.length : Math.PI;
  const start = base - spread / 2;
  const step = childIds.length > 1 ? spread / (childIds.length - 1) : 0;

  childIds.forEach((id, i) => {
    const node = net.nodes.get(id);
    if (!node || node.x !== null) return;   // già piazzato: non si tocca
    const pos = place(parent, start + step * i);
    node.x = pos.x;
    node.y = pos.y;
  });
}

// ─── APERTURA / CHIUSURA ─────────────────────────────────────────────────────

function expandNode(id, focus = true) {
  const added = expand(net, index, id, MAX_NEIGHBOURS);
  layoutChildren(id, added);
  if (focus) focusId = id;
}

// ─── RENDER ──────────────────────────────────────────────────────────────────

function nodeInner(node) {
  if (node.type === "persona") return avatarHtml(node.label, 42);
  if (node.type === "film") {
    const src = node.meta.poster_path ? `${DNA_POSTER}${node.meta.poster_path}` : "";
    return src
      ? `<span class="dna-node__poster" style="background-image:url('${src}')"></span>`
      : `<span class="dna-node__poster dna-node__poster--empty">🎬</span>`;
  }
  return `<span class="dna-node__genre">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
}

function render() {
  const nodesEl = el("dnaNodes");
  const edgesEl = el("dnaEdges");
  const canvas = el("dnaCanvas");
  if (!nodesEl || !edgesEl || !canvas) return;

  const hops = hopsFrom(net, focusId);

  // Budget: prima i più vicini alla camera, a parità l'id (ordine stabile).
  const visible = [...net.nodes.values()]
    .filter(n => n.x !== null && (hops.get(n.id) ?? Infinity) <= DOM_MAX_HOPS)
    .sort((a, b) => (hops.get(a.id) - hops.get(b.id)) || a.id.localeCompare(b.id))
    .slice(0, MAX_DOM_NODES);
  const shown = new Set(visible.map(n => n.id));

  edgesEl.innerHTML = net.edges
    .filter(e => shown.has(e.a) && shown.has(e.b))
    .map(e => {
      const a = net.nodes.get(e.a);
      const b = net.nodes.get(e.b);
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="dna-edge dna-edge--${e.kind}"/>`;
    })
    .join("");

  nodesEl.innerHTML = visible.map(n => {
    const h = hops.get(n.id);
    const withLabel = h <= LABEL_MAX_HOPS;
    const cls = [
      "dna-node",
      `dna-node--${n.type}`,
      n.id === focusId ? "is-focus" : "",
      n.id === net.rootId ? "is-root" : "",
      n.expanded ? "is-open" : "",
      withLabel ? "" : "is-far"
    ].filter(Boolean).join(" ");
    return `<button type="button" class="${cls}" data-node="${escapeHtml(n.id)}"
      style="left:${n.x.toFixed(1)}px;top:${n.y.toFixed(1)}px"
      aria-label="${escapeHtml(n.label)}">
      ${nodeInner(n)}
      ${withLabel ? `<span class="dna-node__label">${escapeHtml(n.label)}</span>` : ""}
    </button>`;
  }).join("");

  const focus = net.nodes.get(focusId) || net.nodes.get(net.rootId);
  canvas.style.transform = `translate(${(-focus.x).toFixed(1)}px, ${(-focus.y).toFixed(1)}px)`;

  renderPanel(net.nodes.get(focusId));
}

function renderPanel(node) {
  const panel = el("dnaPanel");
  if (!panel || !node) return;

  const chiudi = node.expanded ? `<span class="dna-panel__hint">Toccalo di nuovo per richiudere</span>` : "";

  if (node.type === "persona") {
    const n = node.meta.liked || 0;
    const chi = node.id === net.rootId ? "Tu" : escapeHtml(node.label);
    panel.innerHTML = `
      <div class="dna-panel__head">${avatarHtml(node.label, 28)}<strong>${escapeHtml(node.label)}</strong></div>
      <p class="dna-panel__line">${chi} ${node.id === net.rootId ? "hai" : "ha"} amato ${n} ${n === 1 ? "titolo" : "titoli"}.</p>
      ${chiudi}`;
    return;
  }

  if (node.type === "film") {
    const anno = node.meta.year ? ` (${node.meta.year})` : "";
    const regia = node.meta.director ? `<p class="dna-panel__line">Regia di ${escapeHtml(node.meta.director)}.</p>` : "";
    const fans = node.meta.fans || 0;
    panel.innerHTML = `
      <div class="dna-panel__head"><strong>${escapeHtml(node.label)}${anno}</strong></div>
      <p class="dna-panel__line">Amato da ${fans} ${fans === 1 ? "persona" : "persone"} del gruppo.</p>
      ${regia}
      <button type="button" class="btn btn--ghost dna-panel__btn open-detail" data-id="${escapeHtml(node.meta.id)}">Apri la scheda</button>
      ${chiudi}`;
    return;
  }

  const c = node.meta.count || 0;
  panel.innerHTML = `
    <div class="dna-panel__head"><strong>${escapeHtml(node.label)}</strong></div>
    <p class="dna-panel__line">${c} ${c === 1 ? "titolo amato" : "titoli amati"} dal gruppo in questo genere.</p>
    ${chiudi}`;
}

// ─── EVENTI ──────────────────────────────────────────────────────────────────

export function initDnaView() {
  if (bound) return;
  bound = true;

  const nodesEl = el("dnaNodes");
  if (nodesEl) {
    nodesEl.addEventListener("click", e => {
      const btn = e.target.closest(".dna-node");
      if (!btn) return;
      const id = btn.dataset.node;
      const node = net?.nodes.get(id);
      if (!node) return;
      haptic(8);
      // Regola unica: il primo tap apre, il secondo richiude. La scheda di un
      // film si apre dal pulsante nel pannello, mai al tap sul nodo — così non
      // c'è mai da indovinare cosa farà un tocco.
      if (node.expanded) collapse(net, id);
      else expandNode(id, false);
      focusId = id;
      render();
    });
  }
}

// "Ricomincia da me": butta via l'esplorazione e riparte dal nodo persona.
// Il prossimo showDna() ricostruisce tutto da zero (la firma non combacia più).
export function resetDna() {
  signature = "";
  net = null;
}
