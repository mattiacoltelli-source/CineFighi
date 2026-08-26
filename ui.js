// ─── ui.js ───────────────────────────────────────────────────────────────────
// Funzioni "di disegno": prendono dati già pronti e producono HTML.
// Non parlano con Supabase né con TMDB.

import {
  escapeHtml, mediaLabel, mediaBadgeClass, posterUrl, uniqueKey,
  average, voteCount, rawNumberToFixed
} from "./cine-core.js?v=17";

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

  const start = current;
  const startTime = performance.now();

  function tick(now) {
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

const AVATAR_COLORS = ["#2dd9a3", "#4da3ff", "#ffb15c", "#ff8fa3", "#b389f5", "#5eead4"];

function colorForUser(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}

export function avatarHtml(name, size = 28) {
  const initials = name.trim().slice(0, 2).toUpperCase();
  const color = colorForUser(name);
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:${color}">${escapeHtml(initials)}</span>`;
}

// ─── SCREENS ─────────────────────────────────────────────────────────────────

export const SCREENS = {};
export function initScreens() {
  ["home", "library", "stats", "tonight", "detail"].forEach(name => {
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
    const isNew = !!(lastSeenAt && item.created_at && item.created_at > lastSeenAt);
    return `
      <div class="shelf-card open-detail" data-id="${item.id}">
        <div class="shelf-card__poster" style="background-image:url('${posterUrl(item.poster_path)}')">
          <span class="badge ${mediaBadgeClass(item)}">${mediaLabel(item)}</span>
          ${isNew ? `<span class="shelf-card__new-dot"></span>` : ""}
          ${avg !== null ? `<span class="shelf-card__vote">★ ${avg.toFixed(1)}</span>` : ""}
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
        <span class="bar-row__count">${e.value}</span>
      </div>
      <div class="bar-track"><div class="bar__fill" data-width="${Math.max(8, (e.value / max) * 100)}"></div></div>
    </div>
  `).join("");
  animateBarGroups();
}

// ─── STATS: classifica ───────────────────────────────────────────────────────

const MEDALS = ["🥇", "🥈", "🥉"];

export function renderRanking(items, typeLabel) {
  const podiumEl = document.getElementById("rankingPodium");
  const listEl = document.getElementById("rankingList");
  const badgeEl = document.getElementById("rankingCountBadge");

  badgeEl.textContent = String(items.length);

  if (!items.length) {
    podiumEl.innerHTML = `<p class="empty-hint">Vota qualche ${typeLabel === "Film" ? "film" : "serie"} per vedere la classifica.</p>`;
    listEl.innerHTML = "";
    return;
  }

  const podium = items.slice(0, 3);
  const rest = items.slice(3);

  podiumEl.innerHTML = podium.map((item, i) => `
    <div class="podium-card open-detail" data-id="${item.id}">
      <div class="podium-card__medal">${MEDALS[i]}</div>
      <div class="podium-card__poster" style="background-image:url('${posterUrl(item.poster_path)}')"></div>
      <div class="podium-card__title">${escapeHtml(item.title)}</div>
      <div class="podium-card__meta">${item.year} · ${typeLabel}</div>
      <div class="podium-card__vote">★ ${item.__score.toFixed(1)}</div>
    </div>
  `).join("");

  listEl.innerHTML = rest.length ? rest.map((item, i) => `
    <div class="rank-row open-detail" data-id="${item.id}">
      <div class="rank-row__pos">${i + 4}</div>
      <div class="rank-row__poster" style="background-image:url('${posterUrl(item.poster_path)}')"></div>
      <div class="rank-row__info">
        <div class="rank-row__title">${escapeHtml(item.title)}</div>
        <div class="rank-row__meta">${item.year} · ${typeLabel}</div>
      </div>
      <div class="rank-row__vote">★ ${item.__score.toFixed(1)}</div>
    </div>
  `).join("") : "";
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
