// ─── ui.js ───────────────────────────────────────────────────────────────────
// Funzioni "di disegno": prendono dati già pronti e producono HTML.
// Non parlano con Supabase né con TMDB.

import {
  escapeHtml, mediaLabel, mediaBadgeClass, posterUrl, uniqueKey,
  average, voteCount, rawNumberToFixed, firstVoter
} from "./cine-core.js?v=26";

// ─── ANIMAZIONI (numeri che contano, barre che si riempiono, tattile) ───────

let _lastHapticAt = 0;
export function haptic(pattern = 10) {
  const now = Date.now();
  if (now - _lastHapticAt < 60) return;
  _lastHapticAt = now;
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

let animateValueCounter = 0;

// Chiamata due volte di fila sullo stesso elemento (es. toggle Io/Gruppo
// nelle Statistiche, cliccato subito dopo il render iniziale) prima che
// la prima animazione dei 600ms sia finita: senza un modo per invalidare
// il loop rAF precedente, i due tick() giravano in parallelo, e quello
// partito per primo (con un target ormai superato) poteva comunque
// arrivare per ultimo e "vincere", lasciando il numero sbagliato a video.
// animId etichetta ogni chiamata: un tick() il cui id non è più quello
// corrente per l'elemento si ferma da solo, silenziosamente.
export function animateValue(el, target, duration = 600) {
  if (!el) return;
  const end = Number(target) || 0;

  if (el.offsetParent === null) {
    el.textContent = String(end);
    delete el.dataset.currentValue;
    return;
  }

  const current = Number(el.dataset.currentValue || 0);
  if (current === end) { el.textContent = String(end); return; }

  const animId = ++animateValueCounter;
  el._animId = animId;

  const start = current;
  const startTime = performance.now();

  function tick(now) {
    if (el._animId !== animId) return;
    const p = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = Math.round(start + (end - start) * eased);
    el.textContent = String(v);
    el.dataset.currentValue = String(v);
    if (p < 1) requestAnimationFrame(tick);
    else { el.textContent = String(end); el.dataset.currentValue = String(end); }
  }
  requestAnimationFrame(tick);
}

export function animateBarGroups() {
  const bars = document.querySelectorAll("#genreBars .bar__fill[data-width]");
  if (!bars.length) return;
  bars.forEach(bar => { bar.style.width = "0%"; });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bars.forEach((bar, i) => {
        setTimeout(() => { bar.style.width = `${bar.dataset.width}%`; }, i * 70);
      });
    });
  });
}

// ─── TOAST ───────────────────────────────────────────────────────────────────

export function showToast(message, type = "info", title = "") {
  const wrap = document.getElementById("toastWrap");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const heading = title || (type === "success" ? "Fatto" : type === "error" ? "Attenzione" : "Info");
  toast.innerHTML = `
    <div class="toast__icon">${type === "success" ? "✓" : type === "error" ? "!" : "i"}</div>
    <div>
      <div class="toast__title">${escapeHtml(heading)}</div>
      <div class="toast__text">${escapeHtml(message)}</div>
    </div>
  `;
  document.getElementById("toastWrap").appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 260);
  }, 2600);
}

// ─── AVATAR ──────────────────────────────────────────────────────────────────

export function avatarHtml(name, size = 28) {
  const initials = name.trim().slice(0, 2).toUpperCase();
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:var(--orange)">${escapeHtml(initials)}</span>`;
}

// ─── SCREENS ─────────────────────────────────────────────────────────────────

export const SCREENS = {};
export function initScreens() {
  ["home", "library", "stats", "tonight", "report", "detail"].forEach(name => {
    SCREENS[name] = document.getElementById(`screen-${name}`);
  });
}

export function switchScreen(name) {
  Object.values(SCREENS).forEach(s => { s.classList.add("hidden"); s.classList.remove("screen-enter"); });
  SCREENS[name].classList.remove("hidden");
  requestAnimationFrame(() => SCREENS[name].classList.add("screen-enter"));
  document.querySelectorAll(".nav__btn[data-screen]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });
}

// ─── SHELVES (home) ──────────────────────────────────────────────────────────

// lastSeenAt: quando presente, i titoli aggiunti dopo quel momento ricevono
// un piccolo puntino discreto (vedi styles.css .shelf-card__new-dot) — niente
// numeri, niente banner, si nota solo se lo cerchi. Assente (null) alla primissima
// apertura in assoluto dell'app su questo dispositivo: in quel caso nessun
// titolo viene marcato "nuovo", per non riempire di puntini tutta la libreria
// esistente al primo avvio.
export function renderShelf(containerId, items, lastSeenAt) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(item => {
    const avg = average(item.votes);
    const voter = firstVoter(item.votes);
    const isNew = !!(lastSeenAt && item.created_at && item.created_at > lastSeenAt);
    return `
      <div class="shelf-card open-detail" data-id="${item.id}">
        <div class="shelf-card__poster" style="background-image:url('${posterUrl(item.poster_path)}')">
          <span class="badge ${mediaBadgeClass(item)}">${mediaLabel(item)}</span>
          ${isNew ? `<span class="shelf-card__new-dot"></span>` : ""}
          ${avg !== null ? `
            <div class="shelf-card__bottom">
              ${voter ? `
                <span class="shelf-card__voter">
                  <span class="shelf-card__voter-name">${escapeHtml(voter.name)}</span>
                  ${voter.others > 0 ? `<span class="shelf-card__voter-count">+${voter.others}</span>` : ""}
                </span>
              ` : ""}
              <span class="shelf-card__vote">★ ${avg.toFixed(1)}</span>
            </div>
          ` : ""}
        </div>
        <div class="shelf-card__info">
          <div class="shelf-card__title">${escapeHtml(item.title)}</div>
          <div class="shelf-card__meta">${item.year}</div>
        </div>
      </div>
    `;
  }).join("");
}

// ─── SEARCH RESULTS ──────────────────────────────────────────────────────────

export function renderSearchResults(items, libraryMap) {
  return items.map(item => {
    const key = `${item.media_type}_${item.id}`;
    const libId = libraryMap.get(key);
    return `
      <div class="poster-card">
        <div class="poster-card__img ${libId ? "open-detail" : ""}" data-id="${libId || ""}"
             style="background-image:url('${posterUrl(item.poster_path)}')">
          <span class="badge ${mediaBadgeClass(item)}">${mediaLabel(item)}</span>
          ${libId
            ? `<span class="poster-card__tag">✓ Già in libreria · tocca per votare</span>`
            : `
              <div class="poster-card__actions">
                <button class="poster-btn poster-btn--watch action-add" data-id="${item.id}" data-type="${item.media_type}" data-status="watchlist">
                  ♡ Lista
                </button>
                <button class="poster-btn poster-btn--seen action-add" data-id="${item.id}" data-type="${item.media_type}" data-status="seen">
                  ✓ Visto
                </button>
              </div>
            `}
        </div>
        <div class="poster-card__info">
          <div class="poster-card__title">${escapeHtml(item.title)}</div>
          <div class="poster-card__meta">${item.year} · ${mediaLabel(item)}</div>
          ${!libId ? `<button class="poster-card__scheda open-preview" data-id="${item.id}" data-type="${item.media_type}">Scheda →</button>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

// ─── LIBRARY LIST (schermata raggiunta con "Vedi tutto") ─────────────────────

export function renderLibraryList(items) {
  return items.map(item => {
    const avg = average(item.votes);
    const count = voteCount(item.votes);
    return `
      <div class="list-item open-detail" data-id="${item.id}">
        <div class="list-item__thumb" style="background-image:url('${posterUrl(item.poster_path)}')"></div>
        <div class="list-item__body">
          <div class="list-item__title">${escapeHtml(item.title)}</div>
          <div class="list-item__meta">${item.year} · ${mediaLabel(item)}${item.status === "watchlist" ? " · In watchlist" : ""}</div>
          <div class="chip-row">
            ${item.genre_names?.[0] ? `<span class="chip">${escapeHtml(item.genre_names[0])}</span>` : ""}
            ${avg !== null ? `<span class="chip chip--vote">★ ${avg.toFixed(1)} (${count})</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

export function renderGenreFilters(genres, active) {
  const wrap = document.getElementById("libraryGenreFilters");
  if (!genres.length) { wrap.innerHTML = ""; wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <button class="filter-pill ${active === "all" ? "active" : ""}" data-genre-filter="all">Tutti</button>
    ${genres.map(g => `
      <button class="filter-pill ${active === g ? "active" : ""}" data-genre-filter="${escapeHtml(g)}">${escapeHtml(g)}</button>
    `).join("")}
  `;
}

// ─── STATS: generi ───────────────────────────────────────────────────────────

export function renderGenreBars(entries) {
  const container = document.getElementById("genreBars");
  if (!entries.length) {
    container.innerHTML = `<p class="empty-hint">Ancora nessun titolo votato.</p>`;
    return;
  }
  const max = entries[0].value || 1;
  container.innerHTML = entries.map(e => `
    <div class="bar-row">
      <div class="bar-row__label">
        <span class="bar-row__name">${escapeHtml(e.label)}</span>
        <span class="bar-row__meta">
          <span class="bar-row__count">${e.value} titol${e.value === 1 ? "o" : "i"}</span>
          ${e.avgVote != null ? `<span class="bar-row__vote">★ ${e.avgVote.toFixed(1).replace(".", ",")}</span>` : ""}
        </span>
      </div>
      <div class="bar-track"><div class="bar__fill" data-width="${Math.max(8, (e.value / max) * 100)}"></div></div>
    </div>
  `).join("");
  animateBarGroups();
}

// ─── STATS: classifica ───────────────────────────────────────────────────────

// Riordina un array già ordinato per rank (items[0] = 1°) nell'ordine di
// DISEGNO del podio — 2°-1°-3°, il 1° al centro — con medaglia e flag
// "first" già risolti. Gestisce bene anche 1 o 2 soli elementi (il flag
// si basa sulla posizione nell'array ORIGINALE, mai su un indice
// ricalcolato dopo aver scartato gli slot vuoti — quello aveva già
// causato un bug qui). Usata sia dalla Classifica sia da Curiosità
// (vedi renderCuriosita) per un solo linguaggio di podio in tutta l'app.
function podiumOrder(items) {
  return [
    items[1] ? { item: items[1], medal: "🥈", first: false } : null,
    items[0] ? { item: items[0], medal: "🥇", first: true } : null,
    items[2] ? { item: items[2], medal: "🥉", first: false } : null,
  ].filter(Boolean);
}

function rankRowHtml(item, pos, typeLabel) {
  return `
    <div class="rank-row open-detail" data-id="${item.id}">
      <div class="rank-row__pos">${pos}</div>
      <div class="rank-row__poster" style="background-image:url('${posterUrl(item.poster_path)}')"></div>
      <div class="rank-row__info">
        <div class="rank-row__title">${escapeHtml(item.title)}</div>
        <div class="rank-row__meta">${item.year} · ${typeLabel}</div>
      </div>
      <div class="rank-row__vote">★ ${item.__score.toFixed(1)}</div>
    </div>
  `;
}

// Righe mostrate SUBITO dopo il podio, prima del tasto "Mostra tutti" — con
// centinaia di titoli votati (la Classifica non ha un minimo di voti, a
// differenza di Curiosità: vedi mostDivisive in cine-core.js) mostrarli
// tutti fin da subito significa caricare centinaia di locandine in un
// colpo solo, ben prima che l'utente scorra fin laggiù.
const RANKING_LIST_INITIAL = 2;

// Tutte le righe oltre il podio (item, non HTML) e l'etichetta del tipo
// corrente — bastano a ridisegnare la lista in entrambi gli stati
// (collassato/espanso) senza ricalcolare nulla. Si resettano ad ogni
// renderRanking(): cambiare vista (Io/Gruppo, Film/Serie TV) riparte
// sempre da collassato, mai da dove si era lasciato l'ultima volta.
let _rankingRest = [];
let _rankingTypeLabel = "";
let _rankingExpanded = false;

function renderRankingListRows() {
  const items = _rankingExpanded ? _rankingRest : _rankingRest.slice(0, RANKING_LIST_INITIAL);
  document.getElementById("rankingList").innerHTML =
    items.map((item, i) => rankRowHtml(item, i + 4, _rankingTypeLabel)).join("");
}

function updateExpandBtn() {
  const btn = document.getElementById("rankingExpandBtn");
  const hiddenCount = _rankingRest.length - RANKING_LIST_INITIAL;

  if (hiddenCount <= 0) {
    btn.classList.add("hidden");
    return;
  }

  btn.classList.remove("hidden");
  btn.classList.toggle("is-up", _rankingExpanded);
  btn.querySelector(".rank-expand-btn__label").textContent = _rankingExpanded ? "Mostra meno" : "Mostra tutti";
  const countEl = btn.querySelector(".rank-expand-btn__count");
  countEl.textContent = `· ${hiddenCount}`;
  countEl.classList.toggle("hidden", _rankingExpanded);
}

export function renderRanking(items, typeLabel) {
  const podiumEl = document.getElementById("rankingPodium");
  const badgeEl = document.getElementById("rankingCountBadge");

  badgeEl.textContent = String(items.length);
  _rankingRest = items.slice(3);
  _rankingTypeLabel = typeLabel;
  _rankingExpanded = false;

  if (!items.length) {
    podiumEl.innerHTML = `<p class="empty-hint">Vota qualche ${typeLabel === "Film" ? "film" : "serie"} per vedere la classifica.</p>`;
    document.getElementById("rankingList").innerHTML = "";
    document.getElementById("rankingExpandBtn").classList.add("hidden");
    return;
  }

  podiumEl.innerHTML = podiumOrder(items).map(({ item, medal, first }) => `
    <div class="podium-card open-detail${first ? " podium-card--first" : ""}" data-id="${item.id}">
      <div class="podium-card__medal">${medal}</div>
      <div class="podium-card__poster" style="background-image:url('${posterUrl(item.poster_path)}')"></div>
      <div class="podium-card__title">${escapeHtml(item.title)}</div>
      <div class="podium-card__meta">${item.year} · ${typeLabel}</div>
      <div class="podium-card__vote">★ ${item.__score.toFixed(1)}</div>
    </div>
  `).join("");

  renderRankingListRows();
  updateExpandBtn();
}

// Chiamata dal click su #rankingExpandBtn (vedi app.js). Un solo tasto per
// entrambe le direzioni — stessa posizione nel DOM, cambia solo testo e
// freccia (vedi updateExpandBtn) — così finisce naturalmente in fondo alla
// lista quando è espansa, esattamente dove serve per richiuderla. Chiudendo
// riporta anche la vista in cima alla Classifica: con centinaia di righe
// "richiudere" da solo lascerebbe l'utente sepolto in fondo alla pagina.
export function toggleRankingList() {
  if (!_rankingRest.length) return;
  _rankingExpanded = !_rankingExpanded;
  renderRankingListRows();
  updateExpandBtn();
  if (!_rankingExpanded) {
    document.getElementById("classificaSection").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ─── STATS: Curiosità (solo vista Gruppo — vedi renderStats in app.js) ───────
// Podio a 3 card, stessa forma di .podium-card già usata sopra per la
// Classifica e stesso riordino 2°-1°-3° di podiumOrder() (coerenza
// visiva: un solo linguaggio per "ecco un podio" in tutta l'app) — solo
// senza locandina, dato che leaderboard/divisivi non hanno un'immagine
// naturale, e tre card sempre della stessa altezza restano più ordinate
// di locandine finte.

function curiositaCardHtml({ medal, title, meta, value, first, openDetailId }) {
  const cls = `podium-card${openDetailId != null ? " open-detail" : ""}${first ? " podium-card--first" : ""}`;
  const idAttr = openDetailId != null ? ` data-id="${openDetailId}"` : "";
  return `
    <div class="${cls}"${idAttr}>
      <div class="podium-card__medal">${medal}</div>
      <div class="podium-card__title">${escapeHtml(title)}</div>
      ${meta ? `<div class="podium-card__meta">${escapeHtml(meta)}</div>` : ""}
      <div class="podium-card__vote">${value}</div>
    </div>
  `;
}

function affinityCalloutHtml(label, pair, { soli = false } = {}) {
  return `
    <div>
      <div class="pair-group__label">${escapeHtml(label)}</div>
      <div class="affinity-callout">
        <div class="affinity-callout__names">${escapeHtml(pair.a)} &amp; ${escapeHtml(pair.b)}</div>
        <div class="affinity-callout__detail">Differenza media di ${soli ? "soli " : ""}<b>${pair.avgDiff.toFixed(2).replace(".", ",")} punti</b> sui <b>${pair.sharedCount} titoli</b> votati da entrambi.</div>
      </div>
    </div>
  `;
}

function extremesPodiumHtml(items) {
  return podiumOrder(items).map(({ item, medal, first }) =>
    curiositaCardHtml({
      medal, title: item.title, meta: `${item.year} · ${item.count} voti`,
      value: `±${item.sd.toFixed(1).replace(".", ",")}`, first, openDetailId: item.id,
    })
  ).join("");
}

export function renderCuriosita({ leaderboard, pair, divergentPair, divisive, unanimous }) {
  const wrap = document.getElementById("curiositaSection");
  if (!wrap) return;

  const votingEl = document.getElementById("curiositaVoting");
  votingEl.innerHTML = leaderboard.length
    ? podiumOrder(leaderboard).map(({ item, medal, first }) =>
        curiositaCardHtml({ medal, title: item.user, value: `${item.count} voti`, first })
      ).join("")
    : `<p class="empty-hint">Ancora nessun voto nel gruppo.</p>`;

  const pairEl = document.getElementById("curiositaPair");
  pairEl.innerHTML = (pair || divergentPair)
    ? `<div class="pair-group">
        ${pair ? affinityCalloutHtml("Più affini", pair, { soli: true }) : ""}
        ${divergentPair ? affinityCalloutHtml("Più litigiose", divergentPair) : ""}
      </div>`
    : `<p class="empty-hint">Non ci sono ancora abbastanza titoli votati in comune tra due persone.</p>`;

  // "Gli estremi del gruppo": divisivi e unanimi condividono lo stesso
  // toggle (vedi toggleCuriositaExtremes) — resta sempre "Divisivi" appena
  // ridisegnato, coerente con la Classifica che riparte sempre collassata.
  const divisiveEl = document.getElementById("curiositaDivisive");
  const unanimousEl = document.getElementById("curiositaUnanimous");
  divisiveEl.innerHTML = divisive.length ? extremesPodiumHtml(divisive)
    : `<p class="empty-hint">Ancora nessun titolo con abbastanza voti per dirlo.</p>`;
  unanimousEl.innerHTML = unanimous.length ? extremesPodiumHtml(unanimous)
    : `<p class="empty-hint">Ancora nessun titolo con abbastanza voti per dirlo.</p>`;
  divisiveEl.classList.remove("hidden");
  unanimousEl.classList.add("hidden");
  document.querySelectorAll("#curiositaExtremesToggle .stats-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.panel === "divisive");
  });
}

export function toggleCuriositaExtremes(view) {
  document.querySelectorAll("#curiositaExtremesToggle .stats-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.panel === view);
  });
  document.getElementById("curiositaDivisive").classList.toggle("hidden", view !== "divisive");
  document.getElementById("curiositaUnanimous").classList.toggle("hidden", view !== "unanimous");
}

// ─── TONIGHT (consigli, con affinità % e motivo, come CineTracker) ───────────

export function renderTonightList(entries) {
  if (!entries.length) {
    return `<p class="tonight__hint">Vota qualche titolo prima: mi serve per capire i tuoi gusti.</p>`;
  }
  return `
    <div class="results-grid">
      ${entries.map(({ item, affinity, reasons }) => `
        <div class="poster-card" data-tonight-key="${item.media_type}_${item.id}">
          <div class="poster-card__img" style="background-image:url('${posterUrl(item.poster_path)}')">
            <span class="badge ${mediaBadgeClass(item)}">${mediaLabel(item)}</span>
            <span class="tonight-card__affinity">${affinity}%</span>
            <div class="poster-card__actions">
              <button class="poster-btn poster-btn--watch action-add-tonight" data-id="${item.id}" data-type="${item.media_type}" data-status="watchlist">
                ♡ Lista
              </button>
              <button class="poster-btn poster-btn--seen action-add-tonight" data-id="${item.id}" data-type="${item.media_type}" data-status="seen">
                ✓ Visto
              </button>
            </div>
          </div>
          <div class="poster-card__info">
            <div class="poster-card__title">${escapeHtml(item.title)}</div>
            <div class="poster-card__meta">${item.year} · ${mediaLabel(item)} · ★ ${rawNumberToFixed(item.vote_average, 1)} TMDB</div>
            <div class="tonight-card__reason">
              ${reasons.length ? `🎯 ${escapeHtml(reasons.join(" · "))}` : "🎯 Consigliato in base ai tuoi gusti"}
            </div>
            <button class="poster-card__scheda open-preview" data-id="${item.id}" data-type="${item.media_type}">Scheda →</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// ─── SCOPRI PER GENERE (un titolo, con motivo e aggiunta rapida) ────────────

export function renderDiscoverResult(chosen, whyBits, fallbackNote) {
  return `
    <div class="tonight-solo">
      <div class="poster-card" data-tonight-key="${chosen.media_type}_${chosen.id}">
        <div class="poster-card__img" style="background-image:url('${posterUrl(chosen.poster_path)}')">
          <span class="badge ${mediaBadgeClass(chosen)}">${mediaLabel(chosen)}</span>
          <div class="poster-card__actions">
            <button class="poster-btn poster-btn--watch action-add-tonight" data-id="${chosen.id}" data-type="${chosen.media_type}" data-status="watchlist">♡ Lista</button>
            <button class="poster-btn poster-btn--seen action-add-tonight" data-id="${chosen.id}" data-type="${chosen.media_type}" data-status="seen">✓ Visto</button>
          </div>
        </div>
        <div class="poster-card__info">
          <div class="poster-card__title">✨ ${escapeHtml(chosen.title)}</div>
          <div class="poster-card__meta">${chosen.year} · ${mediaLabel(chosen)} · ★ ${rawNumberToFixed(chosen.vote_average, 1)} TMDB</div>
          <div class="tonight-card__reason">
            Scelto perché ${escapeHtml(whyBits.join(", "))}.${fallbackNote ? ` ${escapeHtml(fallbackNote)}` : ""}
          </div>
          <button class="poster-card__scheda open-preview" data-id="${chosen.id}" data-type="${chosen.media_type}">Scheda →</button>
        </div>
      </div>
    </div>
  `;
}

// ─── RIVEDI UN CLASSICO (titolo già votato ≥7, apre la scheda del gruppo) ───

export function renderClassicResult(pick, myVote, comment) {
  return `
    <div class="tonight-solo">
      <div class="poster-card open-detail" data-id="${pick.id}">
        <div class="poster-card__img" style="background-image:url('${posterUrl(pick.poster_path)}')">
          <span class="badge ${mediaBadgeClass(pick)}">${mediaLabel(pick)}</span>
        </div>
        <div class="poster-card__info">
          <div class="poster-card__title">🏛️ ${escapeHtml(pick.title)}</div>
          <div class="poster-card__meta">${pick.year} · ${mediaLabel(pick)} · il tuo voto: ${Number(myVote).toFixed(1)}</div>
          <div class="tonight-card__reason">${escapeHtml(comment)}</div>
        </div>
      </div>
    </div>
  `;
}

// ─── REPORT ──────────────────────────────────────────────────────────────────

export function formatReportDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
}

// Il ciclo è una volta all'anno: la data del prossimo aggiornamento
// automatico è solo indicativa (mostrata in UI) — il controllo vero avviene
// lato client ad ogni apertura della tab (vedi app.js::maybeAutoRefreshReport).
export function nextReportDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  d.setFullYear(d.getFullYear() + 1);
  return d.toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
}

export function renderReportMeta(report) {
  const el = document.getElementById("reportMetaLine");
  if (!el) return;
  if (!report) {
    el.textContent = "Nessun report ancora generato.";
    return;
  }
  el.textContent = `Aggiornato il ${formatReportDate(report.generated_at)} · prossimo aggiornamento automatico l'${nextReportDate(report.generated_at)}`;
}

// Converte i **grassetti** in stile markdown scritti da Claude in <b>, DOPO
// aver già passato il testo da escapeHtml — l'escape avviene prima, quindi
// non c'è HTML arbitrario da interpretare, solo questa singola sostituzione
// controllata su testo già sicuro.
function mdBold(escapedText) {
  return escapedText.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

export function renderReportGate(votedCount, min) {
  const el = document.getElementById("reportGate");
  if (!el) return;
  const pct = Math.max(4, Math.min(100, (votedCount / min) * 100));
  el.innerHTML = `
    <p>Ti servono almeno ${min} titoli votati da te per generare il Report (ne hai votati ${votedCount}). Continua a votare i titoli che vedi!</p>
    <div class="bar-track" style="margin-top:12px;"><div class="bar__fill" data-width="${pct}"></div></div>
  `;
  const fill = el.querySelector(".bar__fill");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.width = `${fill.dataset.width}%`;
    });
  });
}

export function renderReportContent(report) {
  const el = document.getElementById("reportBody");
  if (!el) return;

  if (!report) {
    el.innerHTML = `<p class="empty-hint">Tocca "Aggiorna" per generare il tuo primo report.</p>`;
    return;
  }

  const { profile = [], genres_note = "", directors = [], recommendations = [] } = report.payload || {};

  const profileHtml = profile.map(p => `<p>${mdBold(escapeHtml(p))}</p>`).join("");

  const directorsHtml = directors.length
    ? directors.map(d => `
      <div class="director-row">
        <span class="director-row__name">${escapeHtml(d.name)}</span>
        <span class="director-row__n">${d.count} titoli</span>
        <span class="director-row__avg">★ ${Number(d.avg).toFixed(2)}</span>
      </div>
    `).join("")
    : `<p class="empty-hint">Nessun regista visto almeno 2 volte, per ora.</p>`;

  const recsHtml = recommendations.map((r, i) => {
    const poster = posterUrl(r.poster_path || "");
    const posterStyle = poster ? ` style="background-image:url('${escapeHtml(poster)}')"` : "";
    return `
    <div class="rec-card">
      <div class="rec-card__poster"${posterStyle}>${poster ? "" : `<span class="rec-card__num">${String(i + 1).padStart(2, "0")}</span>`}</div>
      <div class="rec-card__title">${escapeHtml(r.title)}</div>
      <div class="rec-card__meta">${escapeHtml(r.year)} &middot; ${escapeHtml(r.director)}</div>
      <div class="rec-card__why">${mdBold(escapeHtml(r.why))}</div>
    </div>
  `;
  }).join("");

  el.innerHTML = `
    <div class="taste-block">
      <div class="taste-block__title">Il tuo profilo<span class="by">scritto da Claude</span></div>
      ${profileHtml}
    </div>

    <div class="taste-block">
      <div class="taste-block__title">Generi</div>
      <p>${mdBold(escapeHtml(genres_note))}</p>
    </div>

    <div class="taste-block">
      <div class="taste-block__title">Registi che ti fidelizzano<span class="hint">★ media voto</span></div>
      ${directorsHtml}
    </div>

    <div class="section">
      <div class="taste-block__title" style="margin-bottom:12px;">10 titoli per te<span class="by">scritto da Claude</span></div>
      <div class="rec-shelf">${recsHtml}</div>
    </div>
  `;
}

// ─── DETAIL ──────────────────────────────────────────────────────────────────

export function renderDetailFacts(item) {
  const statusFact = item.status === "watchlist" ? "★ In watchlist"
    : item.status === "seen" ? "✓ Visto"
    : "Non ancora salvato";
  const facts = [
    mediaLabel(item),
    item.year,
    item.genre_names?.length ? item.genre_names.join(", ") : null,
    item.director ? `Regia: ${item.director}` : null,
    statusFact
  ].filter(Boolean);
  return facts.map(f => `<span class="detail-fact">${escapeHtml(f)}</span>`).join("");
}

export function renderVotesList(votesObj, currentUser) {
  const entries = Object.entries(votesObj || {}).sort((a, b) => b[1].vote - a[1].vote);
  if (!entries.length) return `<p class="empty-hint">Nessuno ha ancora votato.</p>`;
  return entries.map(([name, v]) => `
    <div class="vote-row">
      ${avatarHtml(name, 26)}
      <div class="vote-row__body">
        <div class="vote-row__name">${escapeHtml(name)}${name === currentUser ? " (tu)" : ""}</div>
        ${v.comment ? `<div class="vote-row__comment">${escapeHtml(v.comment)}</div>` : ""}
      </div>
      <div class="vote-row__score">${Number(v.vote).toFixed(1)}</div>
    </div>
  `).join("");
}
