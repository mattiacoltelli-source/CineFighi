// ─── ui.js ───────────────────────────────────────────────────────────────────
// Funzioni "di disegno": prendono dati già pronti e producono HTML.
// Non parlano con Supabase né con TMDB.

import {
  escapeHtml, mediaLabel, mediaBadgeClass, posterUrl, uniqueKey,
  average, voteCount, rawNumberToFixed
} from "./cine-core.js?v=5";

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

export function renderShelf(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(item => {
    const avg = average(item.votes);
    return `
      <div class="shelf-card open-detail" data-id="${item.id}">
        <div class="shelf-card__poster" style="background-image:url('${posterUrl(item.poster_path)}')">
          <span class="badge ${mediaBadgeClass(item)}">${mediaLabel(item)}</span>
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
                  ♡ Watchlist
                </button>
                <button class="poster-btn poster-btn--seen action-add" data-id="${item.id}" data-type="${item.media_type}" data-status="seen">
                  ✓ Già visto
                </button>
              </div>
            `}
        </div>
        <div class="poster-card__info">
          <div class="poster-card__title">${escapeHtml(item.title)}</div>
          <div class="poster-card__meta">${item.year} · ${mediaLabel(item)}</div>
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
      <div class="bar-track"><div class="bar__fill" style="width:${Math.max(8, (e.value / max) * 100)}%"></div></div>
    </div>
  `).join("");
}

// ─── STATS: classifica ───────────────────────────────────────────────────────

const MEDALS = ["🥇", "🥈", "🥉"];

export function renderRanking(items) {
  const podiumEl = document.getElementById("rankingPodium");
  const listEl = document.getElementById("rankingList");
  const badgeEl = document.getElementById("rankingCountBadge");

  badgeEl.textContent = String(items.length);

  if (!items.length) {
    podiumEl.innerHTML = `<p class="empty-hint">Vota qualcosa per vedere la classifica.</p>`;
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
      <div class="podium-card__meta">${item.year} · ${mediaLabel(item)}</div>
      <div class="podium-card__vote">★ ${item.__score.toFixed(1)}</div>
    </div>
  `).join("");

  listEl.innerHTML = rest.length ? rest.map((item, i) => `
    <div class="rank-row open-detail" data-id="${item.id}">
      <div class="rank-row__pos">${i + 4}</div>
      <div class="rank-row__poster" style="background-image:url('${posterUrl(item.poster_path)}')"></div>
      <div class="rank-row__info">
        <div class="rank-row__title">${escapeHtml(item.title)}</div>
        <div class="rank-row__meta">${item.year} · ${mediaLabel(item)}</div>
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
    <div class="tonight-list">
      ${entries.map(({ item, affinity, reasons }) => `
        <div class="tonight-card open-tonight-detail" data-id="${item.id}" data-type="${item.media_type}">
          <div class="tonight-card__poster" style="background-image:url('${posterUrl(item.poster_path)}')">
            <div class="tonight-card__affinity">${affinity}%</div>
          </div>
          <div class="tonight-card__body">
            <div class="tonight-card__title">${escapeHtml(item.title)}</div>
            <div class="tonight-card__meta">${item.year} · ${mediaLabel(item)} · ★ ${rawNumberToFixed(item.vote_average, 1)} TMDB</div>
            <div class="tonight-card__reason">
              ${reasons.length ? `🎯 ${escapeHtml(reasons.join(" · "))}` : "🎯 Consigliato in base ai tuoi gusti"}
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// ─── DETAIL ──────────────────────────────────────────────────────────────────

export function renderDetailFacts(item) {
  const facts = [
    mediaLabel(item),
    item.year,
    item.genre_names?.length ? item.genre_names.join(", ") : null,
    item.director ? `Regia: ${item.director}` : null,
    item.status === "watchlist" ? "★ In watchlist" : "✓ Visto"
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
