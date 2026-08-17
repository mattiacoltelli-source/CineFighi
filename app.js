// ─── app.js ──────────────────────────────────────────────────────────────────
// Il "cervello" dell'app: inizializza le schermate, gestisce i click,
// richiama storage.js (Supabase) e tmdb.js, e passa i dati a ui.js per disegnare.

import {
  uniqueKey, average, escapeHtml, decadeOf
} from "./cine-core.js?v=8";
import {
  getCurrentUser, setCurrentUser, MAX_USERS,
  fetchUsers, addUser,
  fetchLibrary, addTitle, updateTitleStatus, removeTitle,
  upsertVote, removeVote
} from "./storage.js?v=8";
import { tmdbFetchDetail, tmdbSearch, tmdbFetchDiscoverLevel, buildFallbackQueries } from "./tmdb.js?v=8";
import {
  showToast, avatarHtml, initScreens, switchScreen,
  renderShelf, renderSearchResults, renderLibraryList, renderGenreFilters,
  renderGenreBars, renderRanking, renderTonightList,
  renderDetailFacts, renderVotesList
} from "./ui.js?v=8";

let currentUser = null;
let users = [];
let db = [];               // libreria completa (titoli + voti)
let libraryStatus = "all"; // all | watchlist | seen  (impostato dai "Vedi tutto")
let libraryFilter = "all"; // all | movie | tv
let libraryGenre = "all";
let statsMode = "group";   // group | me
let currentDetailId = null;
let detailReturnScreen = "home";
let currentType = "multi"; // per la ricerca

const SUGGEST_HISTORY_MAX = 40;

// ───────────────────────────────────────────────────────────────────────────

async function init() {
  initScreens();
  bindGlobalEvents();

  try { history.replaceState({ screen: "home" }, "", location.href); } catch {}
  window.addEventListener("popstate", e => {
    const screen = (e.state && e.state.screen) || "home";
    switchScreen(screen);
    if (screen === "stats") renderStats();
  });

  currentUser = getCurrentUser();
  users = await fetchUsers();

  if (!currentUser || !users.includes(currentUser)) {
    openUserPicker(true);
  } else {
    document.getElementById("app").classList.remove("hidden");
    updateUserChip();
  }

  await reloadLibrary();
}

async function reloadLibrary() {
  db = await fetchLibrary();
  renderHome();
  renderStats();
}

function byId(id) { return db.find(x => x.id === id); }

// ─── USER PICKER ─────────────────────────────────────────────────────────────

function updateUserChip() {
  const chip = document.getElementById("userChip");
  chip.innerHTML = `${avatarHtml(currentUser, 24)}<span>${escapeHtml(currentUser)}</span>`;
  const intro = document.getElementById("tonightIntro");
  if (intro) intro.textContent = `Consigli basati sui tuoi voti, ${currentUser}.`;
}

function openUserPicker(blocking) {
  const overlay = document.getElementById("userPickerOverlay");
  overlay.classList.remove("hidden");
  overlay.dataset.blocking = blocking ? "1" : "0";
  document.getElementById("userPickerClose").classList.toggle("hidden", !!blocking);
  renderUserPickerList();
}

function closeUserPicker() {
  document.getElementById("userPickerOverlay").classList.add("hidden");
}

async function renderUserPickerList() {
  users = await fetchUsers();
  const list = document.getElementById("userPickerList");
  list.innerHTML = users.map(u => `
    <button class="user-pick-btn" data-user="${escapeHtml(u)}">
      ${avatarHtml(u, 32)}<span>${escapeHtml(u)}</span>
    </button>
  `).join("");

  const full = users.length >= MAX_USERS;
  document.getElementById("userPickerFullNote").classList.toggle("hidden", !full);
  document.getElementById("userPickerAddRow").classList.toggle("hidden", full);
}

async function handleAddUser() {
  const input = document.getElementById("userPickerInput");
  const res = await addUser(input.value);
  if (!res.ok) {
    if (res.reason === "full") showToast(`Gruppo al completo (${MAX_USERS}/${MAX_USERS})`, "error");
    else if (res.reason === "too_long") showToast("Nome troppo lungo", "error");
    else showToast("Errore, riprova", "error");
    return;
  }
  input.value = "";
  selectUser(res.name);
}

function selectUser(name) {
  currentUser = name;
  setCurrentUser(name);
  updateUserChip();
  document.getElementById("app").classList.remove("hidden");
  closeUserPicker();
  renderStats();
  if (currentDetailId) openDetail(currentDetailId);
}

// ─── HOME ────────────────────────────────────────────────────────────────────

function renderHome() {
  const watch = db.filter(x => x.status === "watchlist").slice(0, 10);
  const seenMovies = db.filter(x => x.status === "seen" && x.media_type === "movie").slice(0, 10);
  const seenSeries = db.filter(x => x.status === "seen" && x.media_type === "tv").slice(0, 10);

  toggleEmpty("watchShelf", "watchShelfEmpty", watch);
  toggleEmpty("seenMovieShelf", "seenMovieShelfEmpty", seenMovies);
  toggleEmpty("seenSeriesShelf", "seenSeriesShelfEmpty", seenSeries);

  renderShelf("watchShelf", watch);
  renderShelf("seenMovieShelf", seenMovies);
  renderShelf("seenSeriesShelf", seenSeries);
}

function toggleEmpty(shelfId, emptyId, items) {
  document.getElementById(shelfId).classList.toggle("hidden", items.length === 0);
  document.getElementById(emptyId).classList.toggle("hidden", items.length > 0);
}

// ─── RICERCA ─────────────────────────────────────────────────────────────────

let searchDebounce = null;

function onSearchInput() {
  const q = document.getElementById("searchInput").value.trim();
  clearTimeout(searchDebounce);
  if (!q) {
    document.getElementById("resultsSection").classList.add("hidden");
    return;
  }
  searchDebounce = setTimeout(() => doSearch(q), 400);
}

async function doSearch(q) {
  const sec = document.getElementById("resultsSection");
  const res = document.getElementById("results");
  const empty = document.getElementById("resultsEmpty");

  sec.classList.remove("hidden");
  empty.textContent = "Ricerca in corso…";
  empty.classList.remove("hidden");
  res.innerHTML = "";

  try {
    const items = await tmdbSearch(q, currentType);
    const normalized = items
      .filter(x => x.poster_path)
      .map(x => ({
        id: x.id,
        media_type: currentType === "multi" ? x.media_type : currentType,
        title: x.title || x.name || "Senza titolo",
        year: (x.release_date || x.first_air_date || "").slice(0, 4) || "—",
        poster_path: x.poster_path,
        overview: x.overview || "",
        genre_names: [],
        vote_average: x.vote_average || 0
      }));

    if (!normalized.length) {
      empty.textContent = "Nessun risultato trovato.";
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");
    const libraryMap = new Map(db.map(x => [`${x.media_type}_${x.tmdb_id}`, x.id]));
    res.innerHTML = renderSearchResults(normalized, libraryMap);
    res.dataset.cache = JSON.stringify(normalized);
  } catch (e) {
    console.error(e);
    empty.textContent = "Errore di ricerca. Controlla la connessione.";
    empty.classList.remove("hidden");
  }
}

async function handleAddFromSearch(tmdbId, type, status) {
  const cache = JSON.parse(document.getElementById("results").dataset.cache || "[]");
  const item = cache.find(x => String(x.id) === String(tmdbId) && x.media_type === type);
  if (!item) return;

  const fullItem = await tmdbFetchDetail(type, tmdbId).catch(() => item);
  const res = await addTitle(fullItem, status, currentUser);

  if (!res.ok) {
    showToast(res.reason === "duplicate" ? "Già in libreria" : "Errore, riprova", "error");
    return;
  }
  showToast(`${fullItem.title} aggiunto`, "success");
  await reloadLibrary();
  document.getElementById("searchInput").value = "";
  document.getElementById("resultsSection").classList.add("hidden");
  openDetail(res.title.id);
}

// ─── CONFERMA AGGIUNTA (si apre toccando la locandina, prima di aggiungere) ──

async function handleAddFromTonight(tmdbId, type, status) {
  const cache = JSON.parse(document.getElementById("tonightResult").dataset.cache || "[]");
  const item = cache.find(x => String(x.id) === String(tmdbId) && x.media_type === type);
  if (!item) return;

  const fullItem = await tmdbFetchDetail(type, tmdbId).catch(() => item);
  const res = await addTitle(fullItem, status, currentUser);

  if (!res.ok) {
    showToast(res.reason === "duplicate" ? "Già in libreria" : "Errore, riprova", "error");
    return;
  }
  showToast(`${fullItem.title} aggiunto`, "success");
  await reloadLibrary();
  openDetail(res.title.id);
}

// ─── LIBRERIA (raggiunta solo dai "Vedi tutto" della home) ───────────────────

function openLibrarySection(status, mediaFilter) {
  libraryStatus = status;
  libraryFilter = mediaFilter;
  libraryGenre = "all";

  const titles = { all: "Libreria", watchlist: "Watchlist", seen: "Titoli visti" };
  document.getElementById("libraryTitle").textContent = titles[status] || "Libreria";

  renderLibraryScreen();
  switchScreen("library");
}

function renderLibraryScreen() {
  let items = db;
  if (libraryStatus !== "all") items = items.filter(x => x.status === libraryStatus);
  if (libraryFilter === "movie") items = items.filter(x => x.media_type === "movie");
  if (libraryFilter === "tv") items = items.filter(x => x.media_type === "tv");

  const genreSet = new Set();
  items.forEach(x => (x.genre_names || []).forEach(g => genreSet.add(g)));
  const genres = [...genreSet].sort((a, b) => a.localeCompare(b, "it"));
  if (libraryGenre !== "all" && !genres.includes(libraryGenre)) libraryGenre = "all";
  renderGenreFilters(genres, libraryGenre);

  if (libraryGenre !== "all") items = items.filter(x => (x.genre_names || []).includes(libraryGenre));

  document.querySelectorAll(".filter-pill[data-filter]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === libraryFilter);
  });

  const listEl = document.getElementById("libraryList");
  const emptyEl = document.getElementById("libraryEmpty");
  if (!items.length) {
    listEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    listEl.innerHTML = renderLibraryList(items);
  }
}

// ─── STATISTICHE (generi + classifica, con toggle Io/Gruppo) ─────────────────

function renderStats() {
  document.querySelectorAll(".stats-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === statsMode);
  });

  const relevant = statsMode === "me"
    ? db.filter(x => x.votes && x.votes[currentUser])
    : db.filter(x => x.votes && Object.keys(x.votes).length > 0);

  const genreCount = {};
  relevant.forEach(item => {
    (item.genre_names || []).forEach(g => { genreCount[g] = (genreCount[g] || 0) + 1; });
  });
  const topGenres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([label, value]) => ({ label, value }));
  renderGenreBars(topGenres);

  const ranked = relevant
    .map(item => {
      const score = statsMode === "me" ? item.votes[currentUser].vote : average(item.votes);
      return { ...item, __score: score };
    })
    .filter(item => Number.isFinite(item.__score))
    .sort((a, b) => b.__score - a.__score);

  renderRanking(ranked);
}

// ─── STASERA COSA GUARDO — algoritmo completo (come CineTracker) ─────────────

function suggestHistoryKey() { return `cinefighiSuggestHistory:${currentUser}`; }

function loadSuggestHistory() {
  try {
    const raw = localStorage.getItem(suggestHistoryKey());
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveSuggestHistory(history) {
  try {
    localStorage.setItem(suggestHistoryKey(), JSON.stringify(history.slice(0, SUGGEST_HISTORY_MAX)));
  } catch {}
}

function registerSuggested(items) {
  const now = Date.now();
  const history = [
    ...items.map(item => ({ key: uniqueKey(item), at: now })),
    ...loadSuggestHistory()
  ].slice(0, SUGGEST_HISTORY_MAX);
  saveSuggestHistory(history);
}

function getHistoryPenalty(key) {
  const now = Date.now();
  let penalty = 0;
  loadSuggestHistory().forEach(entry => {
    if (entry.key !== key) return;
    const hoursAgo = (now - entry.at) / (1000 * 60 * 60);
    if (hoursAgo < 6) penalty += 15;
    else if (hoursAgo < 24) penalty += 10;
    else if (hoursAgo < 72) penalty += 5;
    else if (hoursAgo < 168) penalty += 2.5;
  });
  return penalty;
}

// Costruisce il profilo di gusti della persona selezionata, dai suoi voti
function getUserTasteProfile() {
  const votedItems = db.filter(x => x.votes && x.votes[currentUser]);
  if (!votedItems.length) return null;

  const genreCount = {};
  const genreVotes = {};
  const decadeCount = {};
  let movieCount = 0, tvCount = 0;

  votedItems.forEach(item => {
    if (item.media_type === "movie") movieCount++; else tvCount++;

    const decade = decadeOf(item.year);
    decadeCount[decade] = (decadeCount[decade] || 0) + 1;

    const voteNum = item.votes[currentUser].vote;
    (item.genre_names || []).forEach(g => {
      genreCount[g] = (genreCount[g] || 0) + 1;
      if (Number.isFinite(voteNum)) {
        if (!genreVotes[g]) genreVotes[g] = [];
        genreVotes[g].push(voteNum);
      }
    });
  });

  const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g);
  const topDecade = Object.entries(decadeCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const prefType = movieCount >= tvCount ? "movie" : "tv";

  const genreAverages = {};
  Object.keys(genreCount).forEach(g => {
    const votes = genreVotes[g] || [];
    genreAverages[g] = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 6.8;
  });

  const overallVotes = votedItems.map(x => x.votes[currentUser].vote).filter(Number.isFinite);
  const avgVote = overallVotes.length ? overallVotes.reduce((a, b) => a + b, 0) / overallVotes.length : 7;

  return { topGenres, topDecade, prefType, genreAverages, avgVote };
}

function calculateAffinity(item, profile) {
  const genres = item.genre_names || [];
  let genreBase = 0, matched = 0;

  genres.forEach(g => {
    if (profile.genreAverages[g]) { genreBase += profile.genreAverages[g]; matched++; }
    else if (profile.topGenres.includes(g)) { genreBase += 7.5; matched++; }
  });

  if (!matched) { genreBase = Math.max(6.4, profile.avgVote); matched = 1; }

  let score10 = genreBase / matched;
  if (profile.topDecade && decadeOf(item.year) === profile.topDecade) score10 += 0.35;
  if (item.media_type === profile.prefType) score10 += 0.25;

  const tmdbVote = Number(item.vote_average) || 0;
  if (tmdbVote > 0) score10 += Math.min(0.45, (tmdbVote - 6) * 0.1);

  score10 = Math.max(6.2, Math.min(9.6, score10));
  return Math.round(score10 * 10);
}

function scoreCandidate(item, profile, selectedBoosts) {
  let score = 0;
  const genres = item.genre_names || [];

  genres.forEach(g => {
    if (profile.topGenres.includes(g)) score += 4;
    if (profile.genreAverages[g]) score += Math.max(0, profile.genreAverages[g] - 5.5);
    if (selectedBoosts.includes(g)) score += 3;
  });

  if (profile.topDecade && decadeOf(item.year) === profile.topDecade) score += 2;
  if (item.media_type === profile.prefType) score += 1;

  score += Math.min(2.5, (item.vote_average || 0) / 4);
  score += Math.min(2, (item.vote_count || 0) / 1200);
  score -= getHistoryPenalty(uniqueKey(item));

  return score;
}

function buildReason(item, profile, affinity) {
  const reasons = [];
  const matches = (item.genre_names || []).filter(g => profile.topGenres.includes(g));
  if (matches.length) reasons.push(`match con ${matches.slice(0, 2).join(" + ")}`);
  if (profile.topDecade && decadeOf(item.year) === profile.topDecade) reasons.push("decade che guardi spesso");
  if (affinity >= 88) reasons.push("compatibilità molto alta");
  else if (affinity >= 80) reasons.push("buona sintonia con i tuoi gusti");
  return reasons.slice(0, 3);
}

// Sceglie 5 titoli diversificando i generi, come nell'originale
function pickDiverse(ranked, count = 5) {
  const selected = [];
  const usedKeys = new Set();
  const usedGenres = new Map();

  for (const entry of ranked) {
    if (selected.length >= count) break;
    const key = uniqueKey(entry.item);
    if (usedKeys.has(key)) continue;

    const primaryGenre = (entry.item.genre_names && entry.item.genre_names[0]) || "Altro";
    const usage = usedGenres.get(primaryGenre) || 0;
    if (usage >= 1 && selected.length < count - 1) continue;

    selected.push(entry);
    usedKeys.add(key);
    usedGenres.set(primaryGenre, usage + 1);
  }

  if (selected.length < count) {
    for (const entry of ranked) {
      if (selected.length >= count) break;
      const key = uniqueKey(entry.item);
      if (usedKeys.has(key)) continue;
      selected.push(entry);
      usedKeys.add(key);
    }
  }

  return selected.slice(0, count);
}

async function runTonight() {
  const area = document.getElementById("tonightResult");
  area.innerHTML = `<p class="tonight__hint">Cerco qualcosa per te…</p>`;

  const profile = getUserTasteProfile();
  if (!profile) {
    area.innerHTML = renderTonightList([]);
    return;
  }

  const excludedKeys = new Set(db.map(x => `${x.media_type}_${x.tmdb_id}`));
  const fallback = buildFallbackQueries(profile, null, {});

  const candidatesMap = new Map();
  for (const level of fallback.levels) {
    const found = await tmdbFetchDiscoverLevel(level.urls, fallback.type, excludedKeys);
    found.forEach(item => candidatesMap.set(uniqueKey(item), item));
    if (candidatesMap.size >= 16) break; // già abbastanza scelta, non serve allargare oltre
  }

  const candidates = [...candidatesMap.values()];
  if (!candidates.length) {
    area.innerHTML = `<p class="tonight__hint">Non ho trovato consigli nuovi al momento. Riprova tra poco.</p>`;
    return;
  }

  const ranked = candidates
    .map(item => {
      const affinity = calculateAffinity(item, profile);
      return {
        item,
        score: scoreCandidate(item, profile, fallback.selectedBoosts),
        affinity,
        reasons: buildReason(item, profile, affinity)
      };
    })
    .sort((a, b) => b.score - a.score);

  const diverse = pickDiverse(ranked, 5);

  area.innerHTML = renderTonightList(diverse);
  area.dataset.cache = JSON.stringify(diverse.map(d => d.item));
  registerSuggested(diverse.map(d => d.item));
}

// ─── DETTAGLIO ───────────────────────────────────────────────────────────────

function getVisibleScreen() {
  const ids = ["home", "library", "stats", "tonight"];
  for (const id of ids) {
    const el = document.getElementById(`screen-${id}`);
    if (el && !el.classList.contains("hidden")) return id;
  }
  return "home";
}

function pushHistoryState(screen) {
  try { history.pushState({ screen }, "", location.href); } catch {}
}

function openDetail(id) {
  const item = byId(id);
  if (!item) return;
  currentDetailId = id;
  detailReturnScreen = getVisibleScreen();

  document.getElementById("detailPoster").style.backgroundImage = item.poster_path ? `url('https://image.tmdb.org/t/p/w500${item.poster_path}')` : "";
  document.getElementById("detailTitle").textContent = item.title;
  document.getElementById("detailYear").textContent = item.year;
  document.getElementById("detailType").textContent = item.media_type === "movie" ? "Film" : "Serie TV";
  document.getElementById("detailOverview").textContent = item.overview || "Nessuna trama disponibile.";
  document.getElementById("detailFacts").innerHTML = renderDetailFacts(item);
  document.getElementById("detailVotesList").innerHTML = renderVotesList(item.votes, currentUser);

  const myVote = item.votes?.[currentUser]?.vote ?? 7;
  const myComment = item.votes?.[currentUser]?.comment ?? "";
  document.getElementById("detailVoteSlider").value = myVote;
  document.getElementById("detailVoteValue").textContent = Number(myVote).toFixed(1);
  document.getElementById("detailCommentInput").value = myComment;

  const hasMyVote = !!item.votes?.[currentUser];
  document.getElementById("detailSaveVoteBtn").textContent = hasMyVote ? "Aggiorna voto" : "Salva voto";
  document.getElementById("detailClearVoteBtn").classList.toggle("hidden", !hasMyVote);

  document.getElementById("detailStatusBtn").textContent =
    item.status === "watchlist" ? "✓ Segna come visto" : "★ Sposta in watchlist";

  switchScreen("detail");
  pushHistoryState("detail");
}

async function handleSaveVote() {
  const item = byId(currentDetailId);
  if (!item) return;
  const vote = Number(document.getElementById("detailVoteSlider").value);
  const comment = document.getElementById("detailCommentInput").value.trim();
  await upsertVote(item.id, currentUser, vote, comment);
  showToast("Voto salvato", "success");
  await reloadLibrary();
  openDetail(item.id);
}

async function handleClearVote() {
  const item = byId(currentDetailId);
  if (!item) return;
  await removeVote(item.id, currentUser);
  await reloadLibrary();
  openDetail(item.id);
}

async function handleToggleStatus() {
  const item = byId(currentDetailId);
  if (!item) return;
  const nextStatus = item.status === "watchlist" ? "seen" : "watchlist";
  await updateTitleStatus(item.id, nextStatus);
  await reloadLibrary();
  openDetail(item.id);
}

async function handleRemove() {
  const item = byId(currentDetailId);
  if (!item) return;
  await removeTitle(item.id);
  showToast("Rimosso dalla libreria", "success");
  currentDetailId = null;
  await reloadLibrary();
  switchScreen("home");
}

// ─── EVENTI ──────────────────────────────────────────────────────────────────

function bindGlobalEvents() {
  document.getElementById("userChip").addEventListener("click", () => openUserPicker(false));
  document.getElementById("userPickerClose").addEventListener("click", closeUserPicker);
  document.getElementById("userPickerAddBtn").addEventListener("click", handleAddUser);
  document.getElementById("userPickerInput").addEventListener("keydown", e => {
    if (e.key === "Enter") handleAddUser();
  });
  document.getElementById("userPickerList").addEventListener("click", e => {
    const btn = e.target.closest(".user-pick-btn");
    if (btn) selectUser(btn.dataset.user);
  });

  document.querySelectorAll(".nav__btn[data-screen]").forEach(btn => {
    btn.addEventListener("click", () => {
      switchScreen(btn.dataset.screen);
      pushHistoryState(btn.dataset.screen);
      if (btn.dataset.screen === "stats") renderStats();
    });
  });

  document.getElementById("openWatchAll").addEventListener("click", () => { openLibrarySection("watchlist", "all"); pushHistoryState("library"); });
  document.getElementById("openSeenMovies").addEventListener("click", () => { openLibrarySection("seen", "movie"); pushHistoryState("library"); });
  document.getElementById("openSeenSeries").addEventListener("click", () => { openLibrarySection("seen", "tv"); pushHistoryState("library"); });
  document.getElementById("libraryBackBtn").addEventListener("click", () => history.back());

  document.getElementById("searchInput").addEventListener("input", onSearchInput);
  document.querySelectorAll(".tab[data-type]").forEach(tab => {
    tab.addEventListener("click", () => {
      currentType = tab.dataset.type;
      document.querySelectorAll(".tab[data-type]").forEach(t => t.classList.toggle("active", t === tab));
      const q = document.getElementById("searchInput").value.trim();
      if (q) doSearch(q);
    });
  });
  document.getElementById("results").addEventListener("click", e => {
    const btn = e.target.closest(".action-add");
    if (btn) { handleAddFromSearch(btn.dataset.id, btn.dataset.type, btn.dataset.status); return; }
  });

  document.body.addEventListener("click", e => {
    const card = e.target.closest(".open-detail");
    if (card) openDetail(card.dataset.id);
  });

  document.querySelectorAll(".filter-pill[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => { libraryFilter = btn.dataset.filter; renderLibraryScreen(); });
  });
  document.getElementById("libraryGenreFilters").addEventListener("click", e => {
    const btn = e.target.closest("[data-genre-filter]");
    if (btn) { libraryGenre = btn.dataset.genreFilter; renderLibraryScreen(); }
  });

  document.querySelectorAll(".stats-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => { statsMode = btn.dataset.mode; renderStats(); });
  });

  document.getElementById("tonightBtn").addEventListener("click", runTonight);
  document.getElementById("tonightResult").addEventListener("click", e => {
    const btn = e.target.closest(".action-add-tonight");
    if (btn) handleAddFromTonight(btn.dataset.id, btn.dataset.type, btn.dataset.status);
  });

  document.getElementById("detailBackBtn").addEventListener("click", () => history.back());
  document.getElementById("detailVoteSlider").addEventListener("input", e => {
    document.getElementById("detailVoteValue").textContent = Number(e.target.value).toFixed(1);
  });
  document.getElementById("detailSaveVoteBtn").addEventListener("click", handleSaveVote);
  document.getElementById("detailClearVoteBtn").addEventListener("click", handleClearVote);
  document.getElementById("detailStatusBtn").addEventListener("click", handleToggleStatus);
  document.getElementById("detailRemoveBtn").addEventListener("click", handleRemove);
}

init();
