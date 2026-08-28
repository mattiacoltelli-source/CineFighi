// ─── app.js ────────────────────────────────────────────────────────────
// Il "cervello" dell'app: inizializza le schermate, gestisce i click,
// richiama storage.js (Supabase) e tmdb.js, e passa i dati a ui.js per disegnare.

import {
  uniqueKey, average, escapeHtml, decadeOf, GENRE_NAME_TO_ID,
  votingLeaderboard, mostAffinePair, mostDivergentPair, mostDivisive, mostUnanimous
} from "./cine-core.js?v=9672499";
import {
  getCurrentUser, setCurrentUser, clearCurrentUser, MAX_USERS,
  getLastSeenAt, setLastSeenAt,
  fetchUsers, addUser, deleteUser,
  fetchLibrary, addTitle, updateTitleStatus, removeTitle,
  upsertVote, removeVote,
  loadLatestReport, regenerateReport
} from "./storage.js?v=9672499";
import {
  tmdbFetchDetail, tmdbSearch, tmdbFetchDiscoverLevel, tmdbFetchDecadeCandidates,
  tmdbFetchOutOfComfortZoneCandidates, buildFallbackQueries
} from "./tmdb.js?v=9672499";
import {
  showToast, avatarHtml, initScreens, switchScreen,
  renderShelf, renderSearchResults, renderLibraryList, renderGenreFilters,
  renderGenreBars, renderRanking, toggleRankingList, renderCuriosita, renderTonightList, renderDiscoverResult, renderClassicResult,
  renderDetailFacts, renderVotesList, renderReportMeta, renderReportContent, renderReportGate,
  haptic, animateValue
} from "./ui.js?v=9672499";

const MIN_VOTED_FOR_REPORT = 50;

let currentUser = null;
let users = [];
let db = [];               // libreria completa (titoli + voti)
let libraryStatus = "all"; // all | watchlist | seen  (impostato dai "Vedi tutto")
let libraryFilter = "all"; // all | movie | tv
let libraryGenre = "all";
let watchlistMode = "me";  // me | group (Home)
let statsMode = "group";   // group | me
let rankingMedia = "movie"; // movie | tv
let currentDetailId = null;
let previewItem = null;    // titolo TMDB non ancora salvato, aperto solo per consultazione
let detailReturnScreen = "home";
let currentType = "multi"; // per la ricerca
let confirmYesAction = null;
// "Visto l'ultima volta" letto la prima volta all'avvio (vedi init()) e poi
// riaggiornato ogni volta che si lascia la Home per un'altra scheda (vedi
// goToScreen/markHomeSeen): così i puntini restano visibili per tutta la
// permanenza sulla Home, ma spariscono non appena la si lascia e si torna
// indietro (es. Home → Statistiche → Home), senza bisogno di ricaricare la pagina.
let sessionLastSeenAt = null;

const SUGGEST_HISTORY_MAX = 40;
const LIBRARY_REFRESH_COOLDOWN_MS = 60000;
let lastLibraryRefreshAt = 0;

// "Vedi tutto" (renderLibraryScreen) carica i risultati a blocchi invece di
// disegnarli tutti in un colpo solo: con una libreria grande, renderizzare
// centinaia di card assieme (e far partire altrettante richieste per le
// locandine) è la prima cosa a rallentare l'app, molto prima di qualunque
// limite lato Supabase. Vedi renderNextLibraryPage/observeLibrarySentinel.
const LIBRARY_PAGE_SIZE = 40;
let libraryFilteredItems = [];
let libraryRenderedCount = 0;
let libraryLoadMoreObserver = null;

// ───────────────────────────────────────────────────────────────────────────

// ─── AGGIORNAMENTI (service worker leggero, solo notifica) ───────────────────

function initUpdateCheck() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("./sw.js").then(reg => {
    reg.update(); // controlla subito se c'è una versione più recente

    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateBanner(newWorker);
        }
      });
    });
  }).catch(() => {});

  let alreadyReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (alreadyReloading) return;
    alreadyReloading = true;
    window.location.reload();
  });
}

function showUpdateBanner(worker) {
  if (document.getElementById("updateBanner")) return;
  const bar = document.createElement("div");
  bar.id = "updateBanner";
  bar.innerHTML = `
    <span>🔄 Nuova versione disponibile</span>
    <button id="updateBtn">Aggiorna</button>
  `;
  document.body.appendChild(bar);
  document.getElementById("updateBtn").addEventListener("click", () => {
    worker.postMessage({ type: "SKIP_WAITING" });
    bar.remove();
  });
}

async function init() {
  initScreens();
  bindGlobalEvents();

  try { history.replaceState({ screen: "home" }, "", location.href); } catch {}
  window.addEventListener("popstate", e => {
    const screen = (e.state && e.state.screen) || "home";
    const wasDetail = getVisibleScreen() === "detail";
    haptic(8);
    goToScreen(screen);
    if (screen === "stats") {
      renderStats();
      if (wasDetail) restoreRankingScrollPosition(currentDetailId);
    }
    if (screen === "report") renderReport();
  });

  // Le azioni dell'utente ora aggiornano `db` in locale invece di rileggere
  // tutta la libreria condivisa (vedi renderAfterLocalChange): niente più
  // occasioni "gratuite" per accorgersi delle modifiche fatte da altri.
  // Un refresh quando si torna sull'app (con un minimo di cooldown per non
  // rifarlo ad ogni cambio di tab troppo ravvicinato) colma il vuoto senza
  // reintrodurre un fetch completo ad ogni singola azione.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastLibraryRefreshAt < LIBRARY_REFRESH_COOLDOWN_MS) return;
    lastLibraryRefreshAt = Date.now();
    reloadLibrary();
  });

  currentUser = getCurrentUser();

  // FIX: se fetchUsers fallisce (rete/Supabase giù), non trattiamo l'esito
  // come "nessun utente" — altrimenti un utente già selezionato verrebbe
  // rispedito alla schermata di scelta profilo solo per un errore di rete.
  let usersFetchOk = true;
  try {
    users = await fetchUsers();
  } catch (e) {
    users = [];
    usersFetchOk = false;
    showToast("Impossibile contattare il server: controlla la connessione", "error");
  }

  if (!currentUser || (usersFetchOk && !users.includes(currentUser))) {
    openUserPicker(true);
  } else {
    document.getElementById("app").classList.remove("hidden");
    updateUserChip();
  }

  // Letto PRIMA di sovrascriverlo: è il confronto con cui questa sessione
  // deciderà quali titoli marcare come "nuovi" (vedi renderHome()).
  sessionLastSeenAt = getLastSeenAt();
  setLastSeenAt(new Date().toISOString());

  await reloadLibrary();
  lastLibraryRefreshAt = Date.now();

  setTimeout(() => document.getElementById("splash")?.classList.add("hide"), 850);
  initUpdateCheck();
}

async function reloadLibrary() {
  // FIX: se fetchLibrary fallisce, NON sovrascriviamo `db` con una lista
  // vuota — altrimenti un semplice errore di rete svuota silenziosamente
  // Home/Statistiche per tutti, facendo credere che i titoli siano spariti.
  // Manteniamo lo stato precedente e avvisiamo l'utente.
  let freshDb;
  try {
    freshDb = await fetchLibrary();
  } catch (e) {
    showToast("Impossibile aggiornare la libreria: controlla la connessione", "error");
    return;
  }
  db = freshDb;
  renderAfterLocalChange();
}

// Ridisegna Home e Statistiche dopo una modifica già applicata a `db` in
// locale — usata al posto di reloadLibrary() per le azioni dell'utente
// (aggiungi, vota, rimuovi): il server ci ha già confermato l'esito, quindi
// non serve un altro giro di rete a rileggere tutta la libreria condivisa
// solo per riflettere una modifica di cui conosciamo già il risultato.
function renderAfterLocalChange() {
  renderHome();
  renderStats();
}

// FIX: id arriva quasi sempre come stringa (es. card.dataset.id nel DOM),
// mentre in db è numerico (Supabase restituisce t.id come number). Un
// confronto stretto === falliva sempre, impedendo di aprire il dettaglio.
function byId(id) { return db.find(x => String(x.id) === String(id)); }

// ─── USER PICKER ───────────────────────────────────────────────────────────

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
  // FIX: come reloadLibrary, non svuotiamo la lista utenti mostrata se
  // fetchUsers fallisce per un errore di rete.
  try {
    users = await fetchUsers();
  } catch (e) {
    showToast("Impossibile aggiornare la lista utenti", "error");
    return;
  }
  const list = document.getElementById("userPickerList");
  list.innerHTML = users.map(u => `
    <div class="user-pick-row">
      <button class="user-pick-btn" data-user="${escapeHtml(u)}">
        ${avatarHtml(u, 32)}<span>${escapeHtml(u)}</span>
      </button>
      <button class="user-delete-btn" data-user="${escapeHtml(u)}" title="Elimina utente">🗑</button>
    </div>
  `).join("");

  const full = users.length >= MAX_USERS;
  document.getElementById("userPickerFullNote").classList.toggle("hidden", !full);
  document.getElementById("userPickerAddRow").classList.toggle("hidden", full);
}

// ─── CONFERMA AZIONI PERICOLOSE (es. eliminare un utente) ────────────────────

function askConfirm(text, onYes) {
  document.getElementById("confirmText").textContent = text;
  confirmYesAction = onYes;
  document.getElementById("confirmOverlay").classList.remove("hidden");
}

function closeConfirm() {
  document.getElementById("confirmOverlay").classList.add("hidden");
  confirmYesAction = null;
}

async function handleDeleteUser(name) {
  askConfirm(
    `Eliminare "${name}" dal gruppo? I voti già dati restano nella classifica, ma non potrà più votare finché non si aggiunge di nuovo.`,
    async () => {
      const res = await deleteUser(name);
      if (!res.ok) { showToast("Errore, riprova", "error"); return; }
      haptic([10, 40, 10]);
      showToast(`${name} eliminato dal gruppo`, "success");
      if (name === currentUser) {
        currentUser = null;
        clearCurrentUser();
        document.getElementById("app").classList.add("hidden");
      }
      await renderUserPickerList();
      if (!currentUser) openUserPicker(true);
    }
  );
}

async function handleAddUser() {
  const input = document.getElementById("userPickerInput");
  const res = await addUser(input.value);
  if (!res.ok) {
    if (res.reason === "full") showToast(`Gruppo al completo (${MAX_USERS}/${MAX_USERS})`, "error");
    else if (res.reason === "too_long") showToast("Nome troppo lungo", "error");
    else if (res.reason === "empty") showToast("Inserisci un nome", "error");
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
  // La Home viene disegnata per la prima volta da reloadLibrary() durante
  // init(), PRIMA che l'utente scelga il profilo dal picker (currentUser è
  // ancora vuoto in quel momento): la watchlist "Io" risultava filtrata su
  // nessuno e restava vuota finché non si cambiava schermata e si tornava
  // su Home. Ridisegnarla anche qui, non solo le Statistiche, la aggiorna
  // subito col profilo appena scelto.
  renderHome();
  renderStats();
  if (currentDetailId) openDetail(currentDetailId, { push: false });
}

// ─── HOME ───────────────────────────────────────────────────────────────────

// Segna "vista" la Home adesso: usata quando la si lascia per un'altra
// scheda, così i puntini dei titoli nuovi non ricompaiono al ritorno.
function markHomeSeen() {
  sessionLastSeenAt = new Date().toISOString();
  setLastSeenAt(sessionLastSeenAt);
}

// Wrapper attorno a switchScreen (ui.js): se si sta lasciando la Home per
// un'altra schermata, segna la Home come vista; se invece ci si sta
// arrivando, la ridisegna così i puntini ormai visti spariscono subito.
function goToScreen(screen) {
  if (getVisibleScreen() === "home" && screen !== "home") markHomeSeen();
  switchScreen(screen);
  if (screen === "home") renderHome();
}

function renderHome() {
  document.querySelectorAll("#watchlistModeToggle .stats-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === watchlistMode);
  });

  const watch = db
    .filter(x => x.status === "watchlist" && (watchlistMode === "group" || x.added_by === currentUser))
    .slice(0, 10);
  const seenMovies = db.filter(x => x.status === "seen" && x.media_type === "movie").slice(0, 10);
  const seenSeries = db.filter(x => x.status === "seen" && x.media_type === "tv").slice(0, 10);

  document.getElementById("watchShelfEmpty").textContent = watchlistMode === "group"
    ? "La watchlist del gruppo è vuota."
    : "La tua watchlist è vuota.";

  toggleEmpty("watchShelf", "watchShelfEmpty", watch);
  toggleEmpty("seenMovieShelf", "seenMovieShelfEmpty", seenMovies);
  toggleEmpty("seenSeriesShelf", "seenSeriesShelfEmpty", seenSeries);

  renderShelf("watchShelf", watch, sessionLastSeenAt);
  renderShelf("seenMovieShelf", seenMovies, sessionLastSeenAt);
  renderShelf("seenSeriesShelf", seenSeries, sessionLastSeenAt);
}

function toggleEmpty(shelfId, emptyId, items) {
  document.getElementById(shelfId).classList.toggle("hidden", items.length === 0);
  document.getElementById(emptyId).classList.toggle("hidden", items.length > 0);
}

// ─── RICERCA ────────────────────────────────────────────────────────────────

async function doSearch(q) {
  const sec = document.getElementById("resultsSection");
  const res = document.getElementById("results");
  const empty = document.getElementById("resultsEmpty");

  if (!q) {
    sec.classList.add("hidden");
    res.innerHTML = "";
    return;
  }

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

// Cerca il titolo nella cache di una sezione (risultati ricerca o consigli di
// "Stasera"), lo aggiunge in libreria e mostra il toast d'esito. Usata sia da
// handleAddFromSearch che da handleAddFromTonight, che differiscono solo per
// cosa fare DOPO l'aggiunta.
async function addItemFromCache(containerId, tmdbId, type, status) {
  const cache = JSON.parse(document.getElementById(containerId).dataset.cache || "[]");
  const item = cache.find(x => String(x.id) === String(tmdbId) && x.media_type === type);
  if (!item) return null;

  const fullItem = await tmdbFetchDetail(type, tmdbId).catch(() => item);
  const res = await addTitle(fullItem, status, currentUser);

  if (!res.ok) {
    showToast(res.reason === "duplicate" ? "Già in libreria" : "Errore, riprova", "error");
    return null;
  }
  showToast(`${fullItem.title} aggiunto`, "success");
  haptic(12);
  db.unshift({ ...res.title, votes: {} });
  return res.title.id;
}

async function handleAddFromSearch(tmdbId, type, status) {
  const savedId = await addItemFromCache("results", tmdbId, type, status);
  if (!savedId) return;
  renderAfterLocalChange();
  document.getElementById("searchInput").value = "";
  document.getElementById("resultsSection").classList.add("hidden");
  openDetail(savedId);
}

// ─── AGGIUNTA DA STASERA (rimane in pagina, sparisce dai consigliati) ────────

// Rimuove (se presente) la card dai consigli di "Stasera" — usata sia quando
// si aggiunge direttamente dai tasti sulla card, sia quando si salva un voto
// o si aggiunge a watchlist passando dalla "Scheda" di consultazione.
function removeFromTonightCard(tmdbId, mediaType) {
  const area = document.getElementById("tonightResult");
  if (!area) return;
  const key = `${mediaType}_${tmdbId}`;
  area.querySelector(`[data-tonight-key="${key}"]`)?.remove();
  try {
    const cache = JSON.parse(area.dataset.cache || "[]");
    const newCache = cache.filter(x => !(String(x.id) === String(tmdbId) && x.media_type === mediaType));
    area.dataset.cache = JSON.stringify(newCache);
  } catch {}
}

async function handleAddFromTonight(tmdbId, type, status) {
  const savedId = await addItemFromCache("tonightResult", tmdbId, type, status);
  if (!savedId) return;
  removeFromTonightCard(tmdbId, type);
  renderAfterLocalChange();
}

// ─── SCHEDA DI CONSULTAZIONE (per titoli non ancora salvati) ─────────────────

// Riempie la parte "statica" della scheda dettaglio (poster, titolo, anno,
// tipo, trama, dati) — condivisa sia da openPreview (titolo non ancora
// salvato) che da openDetail (titolo già in libreria).
function fillDetailHeader(item) {
  document.getElementById("detailPoster").style.backgroundImage = item.poster_path ? `url('https://image.tmdb.org/t/p/w500${item.poster_path}')` : "";
  document.getElementById("detailTitle").textContent = item.title;
  document.getElementById("detailYear").textContent = item.year;
  document.getElementById("detailType").textContent = item.media_type === "movie" ? "Film" : "Serie TV";
  document.getElementById("detailOverview").textContent = item.overview || "Nessuna trama disponibile.";
  document.getElementById("detailFacts").innerHTML = renderDetailFacts(item);
}

async function openPreview(tmdbId, type) {
  const existing = db.find(x => x.tmdb_id === Number(tmdbId) && x.media_type === type);
  if (existing) { openDetail(existing.id); return; }

  const fullItem = await tmdbFetchDetail(type, tmdbId).catch(() => null);
  if (!fullItem) { showToast("Errore nel caricare la scheda", "error"); return; }

  currentDetailId = null;
  previewItem = fullItem;
  detailReturnScreen = getVisibleScreen();
  haptic(8);

  fillDetailHeader(fullItem);
  document.getElementById("detailVotesList").innerHTML = renderVotesList({}, currentUser);

  document.getElementById("detailVoteSlider").value = 7;
  document.getElementById("detailVoteValue").textContent = "7.0";
  document.getElementById("detailCommentInput").value = "";

  document.getElementById("detailSaveVoteBtn").textContent = "✓ Salva voto (segna come visto)";
  document.getElementById("detailClearVoteBtn").classList.add("hidden");
  document.getElementById("detailStatusBtn").textContent = "♡ Aggiungi a watchlist";
  document.getElementById("detailRemoveBtn").classList.add("hidden");

  goToScreen("detail");
  pushHistoryState("detail");
}

// ─── LIBRERIA (raggiunta solo dai "Vedi tutto" della home) ───────────────────

function openLibrarySection(status, mediaFilter) {
  libraryStatus = status;
  libraryFilter = mediaFilter;
  libraryGenre = "all";

  const titles = { all: "Libreria", watchlist: "Watchlist", seen: "Titoli visti" };
  document.getElementById("libraryTitle").textContent = titles[status] || "Libreria";

  renderLibraryScreen();
  goToScreen("library");
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
  listEl.innerHTML = "";
  libraryFilteredItems = items;
  libraryRenderedCount = 0;

  if (!items.length) {
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    renderNextLibraryPage();
  }
  observeLibrarySentinel();
}

// Aggiunge il prossimo blocco di risultati alla lista già disegnata, invece
// di ridisegnare tutto da capo: chiamata sia dal render iniziale che dal
// IntersectionObserver quando la sentinella in fondo alla lista diventa
// visibile (utente vicino al fondo dello scroll).
function renderNextLibraryPage() {
  const next = libraryFilteredItems.slice(libraryRenderedCount, libraryRenderedCount + LIBRARY_PAGE_SIZE);
  if (!next.length) return;
  document.getElementById("libraryList").insertAdjacentHTML("beforeend", renderLibraryList(next));
  libraryRenderedCount += next.length;
}

// Un solo observer, riusato a ogni apertura di "Vedi tutto": osserva sempre
// la stessa sentinella (mai ricreata nel DOM), quindi basta assicurarsi che
// sia "in ascolto" — nessun rischio di observer duplicati.
function observeLibrarySentinel() {
  const sentinel = document.getElementById("libraryLoadMoreSentinel");
  if (!sentinel) return;
  if (!libraryLoadMoreObserver) {
    libraryLoadMoreObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) renderNextLibraryPage();
    }, { rootMargin: "600px" }); // carica il blocco successivo un po' prima che l'utente arrivi in fondo
    libraryLoadMoreObserver.observe(sentinel);
  }
}

// ─── STATISTICHE (generi + classifica, con toggle Io/Gruppo) ─────────────────

function renderStats() {
  document.querySelectorAll("#statsIoGruppoToggle .stats-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === statsMode);
  });
  document.querySelectorAll("#rankingMediaToggle .stats-toggle-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.media === rankingMedia);
  });

  // Le 4 card numeriche: di gruppo in modalità "Gruppo", personali in "Io".
  // "In watchlist" personale conta solo i titoli che HAI aggiunto tu e che
  // sono ancora in watchlist in questo momento (si aggiorna da solo quando
  // li segni visti o li rimuovi).
  if (statsMode === "me") {
    const myVoted = db.filter(x => x.votes && x.votes[currentUser]);
    const myWatch = db.filter(x => x.status === "watchlist" && x.added_by === currentUser);
    animateValue(document.getElementById("statSeen"), myVoted.length);
    animateValue(document.getElementById("statWatch"), myWatch.length);
    animateValue(document.getElementById("statMovies"), myVoted.filter(x => x.media_type === "movie").length);
    animateValue(document.getElementById("statSeries"), myVoted.filter(x => x.media_type === "tv").length);
  } else {
    const seenAll = db.filter(x => x.status === "seen");
    const watchAll = db.filter(x => x.status === "watchlist");
    animateValue(document.getElementById("statSeen"), seenAll.length);
    animateValue(document.getElementById("statWatch"), watchAll.length);
    animateValue(document.getElementById("statMovies"), seenAll.filter(x => x.media_type === "movie").length);
    animateValue(document.getElementById("statSeries"), seenAll.filter(x => x.media_type === "tv").length);
  }

  const relevant = statsMode === "me"
    ? db.filter(x => x.votes && x.votes[currentUser])
    : db.filter(x => x.votes && Object.keys(x.votes).length > 0);

  const genreCount = {};
  const genreVotesAcc = {};
  relevant.forEach(item => {
    const score = statsMode === "me" ? item.votes[currentUser].vote : average(item.votes);
    (item.genre_names || []).forEach(g => {
      genreCount[g] = (genreCount[g] || 0) + 1;
      if (Number.isFinite(score)) {
        if (!genreVotesAcc[g]) genreVotesAcc[g] = [];
        genreVotesAcc[g].push(score);
      }
    });
  });
  const topGenres = Object.entries(genreCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([label, value]) => {
      const votes = genreVotesAcc[label] || [];
      const avgVote = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : null;
      return { label, value, avgVote };
    });
  renderGenreBars(topGenres);

  const ranked = relevant
    .filter(item => item.media_type === rankingMedia)
    .map(item => {
      const score = statsMode === "me" ? item.votes[currentUser].vote : average(item.votes);
      return { ...item, __score: score };
    })
    .filter(item => Number.isFinite(item.__score))
    .sort((a, b) => b.__score - a.__score);

  renderRanking(ranked, rankingMedia === "movie" ? "Film" : "Serie TV");

  // Curiosità: solo in vista Gruppo, non ha un senso "personale" (chi vota
  // di più, le coppie affini, i titoli divisivi sono per forza cose del
  // gruppo intero, non del singolo utente). Il contenitore resta nel DOM,
  // si nasconde/mostra con .hidden — stesso pattern già in uso altrove
  // (es. userPickerAddRow, reportGate).
  const curiositaEl = document.getElementById("curiositaSection");
  if (curiositaEl) {
    if (statsMode === "me") {
      curiositaEl.classList.add("hidden");
    } else {
      curiositaEl.classList.remove("hidden");
      renderCuriosita({
        leaderboard: votingLeaderboard(db),
        pair: mostAffinePair(db),
        divergentPair: mostDivergentPair(db),
        divisive: mostDivisive(db),
        unanimous: mostUnanimous(db),
      });
    }
  }
}

// ─── REPORT ───────────────────────────────────────────────────────────────
// A differenza delle Statistiche (ricalcolate live dalla libreria ad ogni
// apertura), il Report è un testo generato da Claude e salvato su Supabase,
// personale per ogni utente (basato SOLO sui titoli che ha votato lui).
// Il tasto "Aggiorna" è attivo solo finché non esiste ancora un report: una
// volta generato per la prima volta, gli aggiornamenti successivi avvengono
// da soli una volta all'anno (controllato qui, ad ogni apertura della tab).

let reportCache = null;
let reportRefreshing = false;

function myVotedSeenCount() {
  return db.filter(x => x.status === "seen" && x.votes && x.votes[currentUser]).length;
}

async function renderReport() {
  const report = await loadLatestReport(currentUser, updated => {
    reportCache = updated;
    renderReportScreen();
  });
  if (report) reportCache = report;

  renderReportScreen();
  maybeAutoRefreshReport();
}

function renderReportScreen() {
  const votedCount = myVotedSeenCount();
  const hasReport = !!reportCache;

  renderReportMeta(reportCache);
  renderReportContent(reportCache);
  renderReportGate(votedCount, MIN_VOTED_FOR_REPORT);

  document.getElementById("reportGate").classList.toggle("hidden", hasReport || votedCount >= MIN_VOTED_FOR_REPORT);
  document.getElementById("reportBody").classList.toggle("hidden", !hasReport && votedCount < MIN_VOTED_FOR_REPORT);

  const btn = document.getElementById("reportRefreshBtn");
  // Il bottone compare solo per generare il PRIMO report (e solo quando si
  // hanno abbastanza titoli votati): dopo, gli aggiornamenti sono automatici.
  btn.classList.toggle("hidden", hasReport || votedCount < MIN_VOTED_FOR_REPORT);
}

async function handleReportRefresh() {
  if (reportRefreshing) return;
  const btn = document.getElementById("reportRefreshBtn");

  if (!navigator.onLine) {
    showToast("Sei offline. Connettiti per generare il report.", "error", "Report");
    return;
  }

  reportRefreshing = true;
  btn.disabled = true;
  btn.classList.add("spinning");

  try {
    const report = await regenerateReport(currentUser);
    reportCache = report;
    renderReportScreen();
    showToast("Report generato.", "success", "Report");
  } catch (e) {
    console.error(e);
    showToast(e.message || "Generazione non riuscita. Riprova.", "error", "Report");
  } finally {
    reportRefreshing = false;
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
}

// Nessun cron lato Supabase (a differenza di Cos90): il controllo "è passato
// più di un anno dall'ultimo report?" avviene qui, ad ogni apertura della
// tab Report — se sì, si rigenera da sola in background, senza bisogno che
// l'utente tocchi alcun bottone.
function maybeAutoRefreshReport() {
  if (!reportCache || reportRefreshing) return;
  const last = new Date(reportCache.generated_at);
  if (isNaN(last.getTime())) return;
  const nextDue = new Date(last);
  nextDue.setFullYear(nextDue.getFullYear() + 1);
  if (new Date() >= nextDue) handleReportRefresh();
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

function buildOutOfZoneReason(item, profile) {
  const reasons = ["fuori dai generi che guardi di solito"];
  const tmdbVote = Number(item.vote_average) || 0;
  if (tmdbVote >= 7.2) reasons.push("voto molto alto su TMDB");
  if (profile.topDecade && decadeOf(item.year) === profile.topDecade) reasons.push("nella tua decade preferita");
  return reasons;
}

// Sceglie i 2 slot "fuori zona" evitando che finiscano sullo stesso genere
// principale (es. entrambi animazione, che su TMDB ha spesso voto medio
// molto alto e rischia di dominare il pool ordinato per voto).
function pickOutOfZoneTwo(ranked) {
  if (!ranked.length) return [];
  const first = ranked[0];
  const firstGenre = (first.item.genre_names && first.item.genre_names[0]) || "Altro";
  const second = ranked.slice(1).find(entry => {
    const g = (entry.item.genre_names && entry.item.genre_names[0]) || "Altro";
    return g !== firstGenre;
  }) || ranked[1];
  return second ? [first, second] : [first];
}

// Quante persone la persona selezionata ha già votato: sotto i 3 voti il
// profilo di gusti è troppo debole per dare consigli sensati.
function votedCount() {
  return db.filter(x => x.votes && x.votes[currentUser]).length;
}

function getSelectedTonightGenre() {
  const el = document.getElementById("tonightGenreSelect");
  return el ? el.value : "all";
}

// Sceglie 5 titoli diversificando SIA per genere principale SIA per decade,
// così i consigli non finiscono tutti sullo stesso genere o sulla stessa epoca.
function pickDiverse(ranked, count = 5) {
  const selected = [];
  const usedKeys = new Set();
  const usedGenres = new Map();
  const usedDecades = new Map();

  for (const entry of ranked) {
    if (selected.length >= count) break;
    const key = uniqueKey(entry.item);
    if (usedKeys.has(key)) continue;

    const primaryGenre = (entry.item.genre_names && entry.item.genre_names[0]) || "Altro";
    const decade = decadeOf(entry.item.year);
    const genreUsage = usedGenres.get(primaryGenre) || 0;
    const decadeUsage = usedDecades.get(decade) || 0;
    const isLastSlot = selected.length >= count - 1;

    if (!isLastSlot && (genreUsage >= 1 || decadeUsage >= 2)) continue;

    selected.push(entry);
    usedKeys.add(key);
    usedGenres.set(primaryGenre, genreUsage + 1);
    usedDecades.set(decade, decadeUsage + 1);
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

// Range di decadi su cui pescare i candidati in parallelo: garantisce che i
// consigli non siano quasi sempre film recenti (limite dell'algoritmo
// originale), includendo anche un blocco di classici pre-2000.
function tonightDecadeRanges() {
  const currentYear = new Date().getFullYear();
  return [
    { start: 1960, end: 1999 },
    { start: 2000, end: 2009 },
    { start: 2010, end: 2019 },
    { start: 2020, end: currentYear }
  ];
}

async function recommendTonightFive() {
  const area = document.getElementById("tonightResult");

  if (votedCount() < 3) {
    area.innerHTML = `<p class="tonight__hint">Vota almeno 3 titoli per ricevere consigli personalizzati.</p>`;
    return;
  }
  if (!navigator.onLine) {
    area.innerHTML = `<p class="tonight__hint">Sei offline. Connettiti per ricevere consigli.</p>`;
    return;
  }

  area.innerHTML = `<p class="tonight__hint">🔍 Sto cercando 6 titoli adatti…</p>`;

  const profile = getUserTasteProfile();
  const genreIds = profile.topGenres.map(g => GENRE_NAME_TO_ID[g]).filter(Boolean);
  const excludedKeys = new Set(db.map(x => `${x.media_type}_${x.tmdb_id}`));

  try {
    const [decadePools, outOfZoneRaw] = await Promise.all([
      Promise.all(
        tonightDecadeRanges().map(d =>
          tmdbFetchDecadeCandidates(profile.prefType, d.start, d.end, genreIds, excludedKeys)
        )
      ),
      tmdbFetchOutOfComfortZoneCandidates(profile.prefType, genreIds, excludedKeys)
    ]);

    const candidatesMap = new Map();
    decadePools.flat().forEach(item => candidatesMap.set(uniqueKey(item), item));

    // Se il mix per decade non basta (catalogo piccolo, generi rari), allarghiamo
    // con la ricerca a livelli generica esistente.
    if (candidatesMap.size < 10) {
      const fallback = buildFallbackQueries(profile, null, {});
      for (const level of fallback.levels) {
        const found = await tmdbFetchDiscoverLevel(level.urls, fallback.type, excludedKeys);
        found.forEach(item => candidatesMap.set(uniqueKey(item), item));
        if (candidatesMap.size >= 14) break;
      }
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
          affinity,
          reasons: buildReason(item, profile, affinity),
          // Un po' di casualità nell'ordinamento: a parità di gusti, richieste
          // ripetute nella stessa serata non restituiscono sempre la stessa lista.
          rankScore: scoreCandidate(item, profile, []) + Math.random() * 2.5
        };
      })
      .sort((a, b) => b.rankScore - a.rankScore);

    // 4 slot ad alta affinità, diversificati per genere e decade
    const topFour = pickDiverse(ranked, 4)
      .sort((a, b) => Number(a.item.year || 0) - Number(b.item.year || 0));

    const usedKeys = new Set(topFour.map(entry => uniqueKey(entry.item)));

    // 2 slot fuori dai generi che guardi di solito, ma con voto TMDB alto
    // (soglia già più severa in tmdbFetchOutOfComfortZoneCandidates):
    // "diverso" qui non vuol dire "a caso". pickOutOfZoneTwo evita che i 2
    // finiscano sullo stesso genere principale.
    const outOfZoneRanked = outOfZoneRaw
      .filter(item => !usedKeys.has(uniqueKey(item)))
      .map(item => {
        const affinity = calculateAffinity(item, profile);
        return {
          item,
          affinity,
          reasons: buildOutOfZoneReason(item, profile),
          rankScore: scoreCandidate(item, profile, []) + Math.random() * 2.5
        };
      })
      .sort((a, b) => b.rankScore - a.rankScore);

    const outOfZonePicked = pickOutOfZoneTwo(outOfZoneRanked);

    const finalSix = [...topFour, ...outOfZonePicked];

    area.innerHTML = renderTonightList(finalSix);
    area.dataset.cache = JSON.stringify(finalSix.map(d => d.item));
    registerSuggested(finalSix.map(d => d.item));
  } catch (e) {
    console.error(e);
    area.innerHTML = `<p class="tonight__hint">Errore di ricerca. Controlla la connessione.</p>`;
  }
}

// ─── SCOPRI PER GENERE (un titolo alla volta, genere scelto a mano) ─────────

async function discoverByTaste() {
  const area = document.getElementById("tonightResult");

  if (votedCount() < 3) {
    area.innerHTML = `<p class="tonight__hint">Vota almeno 3 titoli per ricevere consigli personalizzati.</p>`;
    return;
  }
  if (!navigator.onLine) {
    area.innerHTML = `<p class="tonight__hint">Sei offline. Connettiti per scoprire nuovi titoli.</p>`;
    return;
  }

  area.innerHTML = `<p class="tonight__hint">🔍 Sto cercando qualcosa di nuovo…</p>`;

  const profile = getUserTasteProfile();
  const selectedGenre = getSelectedTonightGenre();
  const excludedKeys = new Set(db.map(x => `${x.media_type}_${x.tmdb_id}`));
  const { type, levels, selectedBoosts } = buildFallbackQueries(profile, null, {
    useSelectedGenre: selectedGenre !== "all",
    selectedGenre
  });

  try {
    let candidates = [];
    let levelLabel = "";
    for (const level of levels) {
      const found = await tmdbFetchDiscoverLevel(level.urls, type, excludedKeys);
      if (found.length) { candidates = found; levelLabel = level.label; break; }
    }

    if (!candidates.length) {
      area.innerHTML = `<p class="tonight__hint">Nessun risultato. Riprova più tardi.</p>`;
      return;
    }

    const scored = candidates
      .map(item => ({ item, score: scoreCandidate(item, profile, selectedBoosts) + Math.random() * 2.5 }))
      .sort((a, b) => b.score - a.score);

    const topPool = scored.slice(0, Math.min(12, scored.length));
    const chosen = topPool[Math.floor(Math.random() * topPool.length)].item;

    const genres = chosen.genre_names || [];
    const matchGenres = genres.filter(g => profile.topGenres.includes(g));
    const whyBits = [];
    if (selectedGenre !== "all" && genres.includes(selectedGenre)) whyBits.push(`hai scelto il genere ${selectedGenre}`);
    if (matchGenres.length) whyBits.push(`ami il genere ${matchGenres[0]}`);
    if (profile.topDecade && decadeOf(chosen.year) === profile.topDecade) whyBits.push(`ti piacciono gli ${profile.topDecade}`);
    if (!whyBits.length) whyBits.push("ha un buon match con i tuoi gusti");
    const fallbackNote = levelLabel !== "ricerca precisa" ? "Ho allargato la ricerca." : "";

    area.innerHTML = renderDiscoverResult(chosen, whyBits, fallbackNote);
    area.dataset.cache = JSON.stringify([chosen]);
    registerSuggested([chosen]);
  } catch (e) {
    console.error(e);
    area.innerHTML = `<p class="tonight__hint">Errore di ricerca. Controlla la connessione.</p>`;
  }
}

// ─── RIVEDI UN CLASSICO (tra i titoli già votati ≥7 dalla persona) ──────────

function suggestClassic() {
  const area = document.getElementById("tonightResult");
  const pool = db.filter(x => x.votes && x.votes[currentUser] && Number(x.votes[currentUser].vote) >= 7);

  if (!pool.length) {
    area.innerHTML = `<p class="tonight__hint">Nessun titolo con voto ≥ 7. Vota qualche titolo che hai amato.</p>`;
    return;
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];
  const myVote = pick.votes[currentUser].vote;
  const comment = myVote >= 9
    ? "Uno dei tuoi assoluti — sempre un buon motivo per rivederlo."
    : myVote >= 8
    ? "L'hai amato. Certi titoli vanno rivisti."
    : "Un bel titolo che hai apprezzato — vale una seconda visione.";

  area.innerHTML = renderClassicResult(pick, myVote, comment);
  area.dataset.cache = "[]";
}

// ─── DETTAGLIO ──────────────────────────────────────────────────────────────

function getVisibleScreen() {
  const ids = ["home", "library", "stats", "tonight", "detail"];
  for (const id of ids) {
    const el = document.getElementById(`screen-${id}`);
    if (el && !el.classList.contains("hidden")) return id;
  }
  return "home";
}

function pushHistoryState(screen) {
  try { history.pushState({ screen }, "", location.href); } catch {}
}

// Tornando a Statistiche dal dettaglio di un film aperto dalla Classifica
// (podio, righe sotto, o il podio "Film più divisivi" di Curiosità — stesso
// meccanismo open-detail/data-id ovunque, nessun caso speciale per l'uno o
// l'altro), riporta la vista esattamente sulla sua card invece di lasciare
// la Statistiche scrollata in cima. renderStats() appena chiamato ha già
// ridisegnato tutto da capo (Classifica sempre collassata a podio + 2 righe,
// vedi RANKING_LIST_INITIAL in ui.js): se il film non è tra le prime 5, va
// prima espansa la lista, altrimenti la sua card non esiste ancora nel DOM.
function restoreRankingScrollPosition(id) {
  if (!id) return;
  let card = document.querySelector(`#screen-stats [data-id="${id}"].open-detail`);
  if (!card) {
    const expandBtn = document.getElementById("rankingExpandBtn");
    if (expandBtn && !expandBtn.classList.contains("hidden")) {
      toggleRankingList();
      card = document.querySelector(`#screen-stats [data-id="${id}"].open-detail`);
    }
  }
  if (card) card.scrollIntoView({ block: "center" });
}

function openDetail(id, options = {}) {
  const push = options.push !== false; // di default vera navigazione; false = solo refresh dati
  const item = byId(id);
  if (!item) return;
  previewItem = null;
  currentDetailId = id;
  if (push) {
    detailReturnScreen = getVisibleScreen();
    haptic(8);
  }

  fillDetailHeader(item);
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
    item.status === "watchlist" ? "✓ Segna come visto" : "♡ Sposta in watchlist";
  document.getElementById("detailRemoveBtn").classList.remove("hidden");

  goToScreen("detail");
  if (push) pushHistoryState("detail");
}

// Salva in libreria il titolo attualmente in "consultazione" (previewItem,
// non ancora in libreria), con lo status indicato. Se qualcun altro l'ha
// già aggiunto nel frattempo (duplicate), recupera comunque l'id esistente.
// Usata sia da handleSaveVote (status "seen") che da handleToggleStatus
// (status "watchlist"). Ritorna l'id salvato, o null in caso di errore vero.
async function promotePreviewItem(status) {
  const res = await addTitle(previewItem, status, currentUser);
  if (!res.ok && res.reason !== "duplicate") return null;
  if (res.ok) db.unshift({ ...res.title, votes: {} });
  return res.ok
    ? res.title.id
    : (db.find(x => x.tmdb_id === previewItem.id && x.media_type === previewItem.media_type)?.id ?? null);
}

async function handleSaveVote() {
  const vote = Number(document.getElementById("detailVoteSlider").value);
  const comment = document.getElementById("detailCommentInput").value.trim();

  if (previewItem) {
    // Un voto significa sempre "l'ho già visto": lo salviamo come visto, mai in watchlist
    const savedId = await promotePreviewItem("seen");
    if (!savedId) { showToast("Errore, riprova", "error"); return; }
    const res = await upsertVote(savedId, currentUser, vote, comment);
    if (!res.ok) { showToast("Errore nel salvare il voto, riprova", "error"); return; }
    haptic(12);
    showToast("Voto salvato", "success");
    removeFromTonightCard(previewItem.id, previewItem.media_type);
    previewItem = null;
    const saved = byId(savedId);
    if (saved) { saved.votes = saved.votes || {}; saved.votes[currentUser] = { vote, comment }; }
    renderAfterLocalChange();
    openDetail(savedId, { push: false });
    return;
  }

  const item = byId(currentDetailId);
  if (!item) return;
  const res = await upsertVote(item.id, currentUser, vote, comment);
  if (!res.ok) { showToast("Errore nel salvare il voto, riprova", "error"); return; }
  haptic(12);
  showToast("Voto salvato", "success");
  item.votes = item.votes || {};
  item.votes[currentUser] = { vote, comment };
  renderAfterLocalChange();
  openDetail(item.id, { push: false });
}

async function handleClearVote() {
  const item = byId(currentDetailId);
  if (!item) return;
  const res = await removeVote(item.id, currentUser);
  if (!res.ok) { showToast("Errore, riprova", "error"); return; }
  haptic(10);
  if (item.votes) delete item.votes[currentUser];
  renderAfterLocalChange();
  openDetail(item.id, { push: false });
}

async function handleToggleStatus() {
  if (previewItem) {
    // Modalità consultazione: unico pulsante disponibile è "Aggiungi a watchlist"
    const savedId = await promotePreviewItem("watchlist");
    if (!savedId) { showToast("Errore, riprova", "error"); return; }
    haptic(12);
    showToast(`${previewItem.title} aggiunto alla watchlist`, "success");
    removeFromTonightCard(previewItem.id, previewItem.media_type);
    previewItem = null;
    renderAfterLocalChange();
    openDetail(savedId, { push: false });
    return;
  }

  const item = byId(currentDetailId);
  if (!item) return;
  const nextStatus = item.status === "watchlist" ? "seen" : "watchlist";
  const res = await updateTitleStatus(item.id, nextStatus);
  if (!res.ok) { showToast("Errore, riprova", "error"); return; }
  haptic(12);
  item.status = nextStatus;
  renderAfterLocalChange();
  openDetail(item.id, { push: false });
}

async function handleRemove() {
  const item = byId(currentDetailId);
  if (!item) return;
  // La libreria è condivisa da tutto il gruppo: un tocco per sbaglio non deve
  // cancellare un titolo (e i voti di tutti collegati) senza possibilità di
  // annullare. Stessa conferma già usata per eliminare un utente dal gruppo.
  askConfirm(
    `Rimuovere "${item.title}" dalla libreria? Anche i voti e i commenti di tutto il gruppo andranno persi.`,
    async () => {
      const res = await removeTitle(item.id);
      if (!res.ok) { showToast("Errore, riprova", "error"); return; }
      haptic(16);
      showToast("Rimosso dalla libreria", "success");
      currentDetailId = null;
      db = db.filter(x => x.id !== item.id);
      renderAfterLocalChange();
      goToScreen("home");
      try { history.replaceState({ screen: "home" }, "", location.href); } catch {}
    }
  );
}

// ─── EVENTI ───────────────────────────────────────────────────────────────

function bindGlobalEvents() {
  document.getElementById("userChip").addEventListener("click", () => openUserPicker(false));
  document.getElementById("userPickerClose").addEventListener("click", closeUserPicker);
  document.getElementById("userPickerAddBtn").addEventListener("click", handleAddUser);
  document.getElementById("userPickerInput").addEventListener("keydown", e => {
    if (e.key === "Enter") handleAddUser();
  });
  document.getElementById("userPickerList").addEventListener("click", e => {
    const delBtn = e.target.closest(".user-delete-btn");
    if (delBtn) { handleDeleteUser(delBtn.dataset.user); return; }
    const btn = e.target.closest(".user-pick-btn");
    if (btn) selectUser(btn.dataset.user);
  });

  document.getElementById("confirmYesBtn").addEventListener("click", async () => {
    const action = confirmYesAction;
    closeConfirm();
    if (action) await action();
  });
  document.getElementById("confirmNoBtn").addEventListener("click", closeConfirm);

  document.querySelectorAll(".nav__btn[data-screen]").forEach(btn => {
    btn.addEventListener("click", () => {
      const already = getVisibleScreen() === btn.dataset.screen;
      goToScreen(btn.dataset.screen);
      if (!already) { pushHistoryState(btn.dataset.screen); haptic(8); }
      if (btn.dataset.screen === "stats") renderStats();
      if (btn.dataset.screen === "report") renderReport();
    });
  });

  document.getElementById("openWatchAll").addEventListener("click", () => { openLibrarySection("watchlist", "all"); pushHistoryState("library"); });
  document.getElementById("openSeenMovies").addEventListener("click", () => { openLibrarySection("seen", "movie"); pushHistoryState("library"); });
  document.getElementById("openSeenSeries").addEventListener("click", () => { openLibrarySection("seen", "tv"); pushHistoryState("library"); });
  document.getElementById("libraryBackBtn").addEventListener("click", () => { haptic(8); history.back(); });

  document.getElementById("searchBtn").addEventListener("click", () => {
    haptic(8);
    doSearch(document.getElementById("searchInput").value.trim());
  });
  document.getElementById("searchInput").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    haptic(8);
    doSearch(document.getElementById("searchInput").value.trim());
  });
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
    if (card) { openDetail(card.dataset.id); return; }
    const previewBtn = e.target.closest(".open-preview");
    if (previewBtn) { openPreview(previewBtn.dataset.id, previewBtn.dataset.type); return; }
  });

  document.querySelectorAll(".filter-pill[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => { libraryFilter = btn.dataset.filter; renderLibraryScreen(); });
  });
  document.getElementById("libraryGenreFilters").addEventListener("click", e => {
    const btn = e.target.closest("[data-genre-filter]");
    if (btn) { libraryGenre = btn.dataset.genreFilter; renderLibraryScreen(); }
  });

  document.querySelectorAll("#watchlistModeToggle .stats-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => { haptic(8); watchlistMode = btn.dataset.mode; renderHome(); });
  });
  document.querySelectorAll("#statsIoGruppoToggle .stats-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => { statsMode = btn.dataset.mode; renderStats(); });
  });
  document.querySelectorAll("#rankingMediaToggle .stats-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => { rankingMedia = btn.dataset.media; renderStats(); });
  });
  document.getElementById("rankingExpandBtn").addEventListener("click", () => { haptic(8); toggleRankingList(); });

  document.getElementById("reportRefreshBtn").addEventListener("click", () => { haptic(8); handleReportRefresh(); });

  document.getElementById("tonightBtn").addEventListener("click", recommendTonightFive);
  document.getElementById("tonightDiscoverBtn").addEventListener("click", discoverByTaste);
  document.getElementById("tonightClassicBtn").addEventListener("click", suggestClassic);
  document.getElementById("tonightResult").addEventListener("click", e => {
    const btn = e.target.closest(".action-add-tonight");
    if (btn) handleAddFromTonight(btn.dataset.id, btn.dataset.type, btn.dataset.status);
  });

  document.getElementById("detailBackBtn").addEventListener("click", () => { haptic(8); history.back(); });
  document.getElementById("detailVoteSlider").addEventListener("input", e => {
    document.getElementById("detailVoteValue").textContent = Number(e.target.value).toFixed(1);
  });
  document.getElementById("detailSaveVoteBtn").addEventListener("click", handleSaveVote);
  document.getElementById("detailClearVoteBtn").addEventListener("click", handleClearVote);
  document.getElementById("detailStatusBtn").addEventListener("click", handleToggleStatus);
  document.getElementById("detailRemoveBtn").addEventListener("click", handleRemove);
}

init();
