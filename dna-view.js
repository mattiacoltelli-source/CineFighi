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
} from "./dna.js?v=1c91d26";
import { escapeHtml } from "./cine-core.js?v=1c91d26";
import { avatarHtml, haptic } from "./ui.js?v=1c91d26";

// Quanti vicini apre un tap. Quattro invece di cinque: meno rami per tap
// vuol dire nodi più grandi e una rete che resta leggibile su un telefono,
// e il pannello qui sotto racconta comunque tutto quello che un nodo in più
// avrebbe mostrato.
const MAX_NEIGHBOURS = 4;

// Budget DOM: oltre questi limiti (misurati DALLA camera, non dalla radice,
// altrimenti esplorando in profondità sparirebbe tutto) i nodi lontani
// perdono prima l'etichetta e poi escono dal DOM. Restano comunque in memoria
// nella rete: tornando indietro ricompaiono identici, stesse posizioni.
const MAX_DOM_NODES = 32;
const LABEL_MAX_HOPS = 3;
const DOM_MAX_HOPS = 4;

const RADIUS = 112;         // distanza figlio-genitore
const MIN_GAP = 94;         // distanza minima tra due nodi qualsiasi (nodo 62px + etichetta)
const PLACE_TRIES = 24;

// posterUrl() di cine-core serve immagini w500: qui i poster stanno in un
// nodo da 48px e possono essercene decine a schermo. w154 è circa dieci volte
// più leggero e a questa dimensione indistinguibile.
const DNA_POSTER = "https://image.tmdb.org/t/p/w185";

let index = null;
let net = null;
let focusId = null;
let signature = "";
let bound = false;

// Spostamento manuale della camera rispetto al nodo attivo (vedi il
// trascinamento in fondo al file). Si azzera ad ogni tap su un nodo: toccare
// un nodo ricentra sempre, quindi non ci si perde mai fuori dalla rete.
let panX = 0;
let panY = 0;
let shownIds = [];          // i nodi davvero nel DOM all'ultimo render

// Oltre questa distanza in pixel un trascinamento non è più un tap. Sotto,
// il dito che si muove di poco mentre tocca non deve aprire niente per
// sbaglio, ma nemmeno sembrare che l'app non abbia sentito il tocco.
const DRAG_THRESHOLD = 8;
const PAN_MARGIN = 48;      // quanto si può andare oltre l'ultimo nodo

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
    panX = 0; panY = 0;
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

function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function nodeInner(node) {
  if (node.type === "persona") return avatarHtml(node.label, 52);
  if (node.type === "film") {
    const src = node.meta.poster_path ? `${DNA_POSTER}${node.meta.poster_path}` : "";
    return src
      ? `<span class="dna-node__poster" style="background-image:url('${src}')"></span>`
      : `<span class="dna-node__poster dna-node__poster--empty">🎬</span>`;
  }
  if (node.type === "regista") {
    return `<span class="dna-node__director">${escapeHtml(initials(node.label))}</span>`;
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
      const suFocus = e.a === focusId || e.b === focusId ? " is-focus" : "";
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="dna-edge dna-edge--${e.kind}${suFocus}"/>`;
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

  shownIds = visible.map(n => n.id);
  applyCamera();

  renderPanel(net.nodes.get(focusId));
}

// Il pannello è il posto dove sta l'informazione: la rete mostra i
// collegamenti, qui si legge chi, quanto e perché. È il motivo per cui un tap
// apre pochi rami — quello che non diventa un nodo si legge qui sotto.
// Unico punto in cui si muove la camera: posizione del nodo attivo più lo
// spostamento manuale. È una sola translate sul contenitore, non un
// riposizionamento dei nodi, quindi il telefono la anima sul compositor.
function applyCamera(animata = true) {
  const canvas = el("dnaCanvas");
  if (!canvas || !net) return;
  const focus = net.nodes.get(focusId) || net.nodes.get(net.rootId);
  canvas.classList.toggle("is-dragging", !animata);
  canvas.style.transform = `translate(${(-focus.x + panX).toFixed(1)}px, ${(-focus.y + panY).toFixed(1)}px)`;
}

// Fin dove si può trascinare: quanto basta a portare al centro qualunque
// nodo a schermo, e non un pixel di più. Così non si finisce mai nel vuoto
// senza sapere come tornare indietro.
function panLimits() {
  const focus = net?.nodes.get(focusId);
  if (!focus) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let dxMin = 0, dxMax = 0, dyMin = 0, dyMax = 0;
  for (const id of shownIds) {
    const n = net.nodes.get(id);
    if (!n || n.x === null) continue;
    dxMin = Math.min(dxMin, n.x - focus.x); dxMax = Math.max(dxMax, n.x - focus.x);
    dyMin = Math.min(dyMin, n.y - focus.y); dyMax = Math.max(dyMax, n.y - focus.y);
  }
  return {
    minX: -dxMax - PAN_MARGIN, maxX: -dxMin + PAN_MARGIN,
    minY: -dyMax - PAN_MARGIN, maxY: -dyMin + PAN_MARGIN
  };
}

function renderPanel(node) {
  const panel = el("dnaPanel");
  if (!panel || !node) return;

  const chiudi = node.expanded
    ? `<span class="dna-panel__hint">Toccalo di nuovo per richiudere</span>`
    : `<span class="dna-panel__hint">Toccalo per aprire i collegamenti</span>`;

  // "Scheda →" sta nella riga del titolo e non in fondo: su un telefono
  // piccolo un bottone in coda al pannello finisce dietro la barra di
  // navigazione, e la scheda è la cosa che si vuole raggiungere subito.
  const scheda = node.type === "film"
    ? `<button type="button" class="dna-panel__scheda open-detail" data-id="${escapeHtml(node.meta.id)}">Scheda →</button>`
    : "";

  panel.innerHTML = `
    <div class="dna-panel__head">${panelIcon(node)}<strong>${escapeHtml(panelTitle(node))}</strong>${scheda}</div>
    ${panelBody(node)}
    ${chiudi}`;
}

function panelIcon(node) {
  if (node.type === "persona") return avatarHtml(node.label, 30);
  if (node.type === "regista") return `<span class="dna-chip dna-chip--regista">${escapeHtml(initials(node.label))}</span>`;
  if (node.type === "genere") return `<span class="dna-chip dna-chip--genere">${escapeHtml(node.label.slice(0, 3).toUpperCase())}</span>`;
  return "";
}

function panelTitle(node) {
  if (node.type === "film" && node.meta.year) return `${node.label} (${node.meta.year})`;
  return node.label;
}

function fansHtml(fans) {
  return `<div class="dna-fans">${fans
    .slice()
    .sort((a, b) => b.vote - a.vote || a.name.localeCompare(b.name))
    .map(f => `<span class="dna-fan">${avatarHtml(f.name, 22)}<span class="dna-fan__name">${escapeHtml(f.name)}</span><span class="dna-fan__vote">${f.vote.toFixed(1)}</span></span>`)
    .join("")}</div>`;
}

function pillsHtml(items) {
  return `<div class="dna-pills">${items.map(t => `<span class="dna-pill">${escapeHtml(t)}</span>`).join("")}</div>`;
}

function panelBody(node) {
  const m = node.meta;

  if (node.type === "persona") {
    const n = m.liked || 0;
    const io = node.id === net.rootId;
    const generi = (m.topGenres || []).length
      ? `<p class="dna-panel__line">Generi più presenti: ${m.topGenres.map(g => `${escapeHtml(g.genere)} (${g.film})`).join(" · ")}.</p>`
      : "";
    const registi = (m.topDirectors || []).length
      ? `<p class="dna-panel__line">Registi ricorrenti: ${m.topDirectors.map(d => `${escapeHtml(d.name)} (${d.film})`).join(" · ")}.</p>`
      : "";
    return `
      <p class="dna-panel__line">${io ? "Hai" : "Ha"} amato ${n} ${n === 1 ? "titolo" : "titoli"} (voto 7 o più).</p>
      ${generi}
      ${registi}`;
  }

  if (node.type === "film") {
    const tipo = m.media_type === "tv" ? "Serie" : "Film";
    const regia = m.director ? `Regia di ${escapeHtml(m.director)}` : "";
    const fans = m.fans || [];
    return `
      <p class="dna-panel__line">${tipo}${regia ? ` · ${regia}` : ""}</p>
      <p class="dna-panel__line dna-panel__label">Chi l'ha amato (${fans.length})</p>
      ${fansHtml(fans)}
      ${(m.genres || []).length ? pillsHtml(m.genres) : ""}`;
  }

  if (node.type === "regista") {
    const titoli = (m.titoli || []).length
      ? `<p class="dna-panel__line">Nella rete: ${m.titoli.map(t => escapeHtml(t)).join(" · ")}${m.films > m.titoli.length ? ` e altri ${m.films - m.titoli.length}` : ""}.</p>`
      : "";
    return `
      <p class="dna-panel__line">${m.films} ${m.films === 1 ? "film amato" : "film amati"} nel gruppo, da ${m.people} ${m.people === 1 ? "persona" : "persone"} diverse.</p>
      ${titoli}`;
  }

  const c = m.count || 0;
  const chi = (m.topFans || []).length
    ? `<p class="dna-panel__line">Chi lo ama di più: ${m.topFans.map(f => `${escapeHtml(f.name)} (${f.film})`).join(" · ")}.</p>`
    : "";
  return `
    <p class="dna-panel__line">${c} ${c === 1 ? "titolo amato" : "titoli amati"} dal gruppo in questo genere.</p>
    ${chi}`;
}

// ─── EVENTI ──────────────────────────────────────────────────────────────────

export function initDnaView() {
  if (bound) return;
  bound = true;

  bindPan();

  const nodesEl = el("dnaNodes");
  if (nodesEl) {
    nodesEl.addEventListener("click", e => {
      const btn = e.target.closest(".dna-node");
      if (!btn) return;
      const id = btn.dataset.node;
      const node = net?.nodes.get(id);
      if (!node) return;
      if (dragged) return;   // era un trascinamento, non un tocco
      haptic(8);
      // Un tap su un nodo che non è quello attivo lo SELEZIONA soltanto: serve
      // a leggerne il pannello (chi l'ha votato, i generi, la regia) senza
      // toccare la rete. Apre o richiude solo il nodo già attivo, cioè quello
      // che il pannello sta già descrivendo — così guardare non è mai un'azione
      // distruttiva, e "richiudi" non capita mai per sbaglio.
      if (id === focusId) {
        if (node.expanded) collapse(net, id);
        else expandNode(id, false);
      } else if (!node.expanded) {
        expandNode(id, false);
      }
      focusId = id;
      panX = 0; panY = 0;   // toccare un nodo ricentra sempre
      render();
    });
  }
}

// Trascinamento a un dito per guardarsi intorno. 1:1, senza inerzia e senza
// pinch: un trascinamento diretto è già quello che il pollice si aspetta,
// mentre l'inerzia fatta male è la prima cosa che tradisce un finto nativo.
// Serve perché i nodi ai bordi del riquadro sono tagliati a metà e prima
// l'unico modo di raggiungerli era toccarli, cioè espanderli.
let dragged = false;

function bindPan() {
  const stage = el("dnaStage");
  if (!stage) return;

  let pid = null, x0 = 0, y0 = 0, baseX = 0, baseY = 0, lim = null;

  stage.addEventListener("pointerdown", e => {
    if (!net || pid !== null || e.button > 0) return;
    pid = e.pointerId;
    dragged = false;
    x0 = e.clientX; y0 = e.clientY;
    baseX = panX; baseY = panY;
    lim = panLimits();
  });

  stage.addEventListener("pointermove", e => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!dragged) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      stage.classList.add("is-panning");
      // Da qui in poi il gesto è nostro: il browser non deve più provare a
      // scrollare la pagina a metà trascinamento.
      try { stage.setPointerCapture(pid); } catch {}
    }
    panX = Math.min(lim.maxX, Math.max(lim.minX, baseX + dx));
    panY = Math.min(lim.maxY, Math.max(lim.minY, baseY + dy));
    applyCamera(false);   // niente transizione mentre il dito è giù: deve seguirlo
  });

  const fine = e => {
    if (e.pointerId !== pid) return;
    try { stage.releasePointerCapture(pid); } catch {}
    pid = null;
    stage.classList.remove("is-panning");
    applyCamera(true);
    // Il click arriva DOPO il pointerup: il flag deve sopravvivere fino a lì,
    // e sparire subito dopo, altrimenti il tap successivo verrebbe ignorato.
    if (dragged) setTimeout(() => { dragged = false; }, 0);
  };
  stage.addEventListener("pointerup", fine);
  stage.addEventListener("pointercancel", fine);
}

// "Ricomincia da me": butta via l'esplorazione e riparte dal nodo persona.
// Il prossimo showDna() ricostruisce tutto da zero (la firma non combacia più).
export function resetDna() {
  signature = "";
  net = null;
  panX = 0;
  panY = 0;
}
