// ─── app.js ────────────────────────────────────────────────────────────
// Il "cervello" dell'app: inizializza le schermate, gestisce i click,
// richiama storage.js (Supabase) e tmdb.js, e passa i dati a ui.js per disegnare.

import {
  average, escapeHtml,
  votingLeaderboard, mostAffinePair, mostDivergentPair, mostDivisive, mostUnanimous,
  groupMemberProfiles, groupProfileStats
} from "./cine-core.js?v=ac294cc";
import {
  getCurrentUser, setCurrentUser, MAX_USERS,
  getLastSeenAt, setLastSeenAt, getGenreView, setGenreView,
  fetchUsers, addUser,
  fetchLibrary, addTitle, addToWatchlist, removeFromWatchlist, ensureWatchlistMembership, updateTitleStatus, removeTitle,
  upsertVote, removeVote,
  loadLatestReport, regenerateReport,
  loadLatestGroupReport, regenerateGroupReport
} from "./storage.js?v=ac294cc";
import { tmdbFetchDetail, tmdbSearch } from "./tmdb.js?v=ac294cc";
import {
  showToast, avatarHtml, initScreens, switchScreen,
  renderShelf, renderSearchResults, renderLibraryList, renderGenreFilters,
  renderGenreBars, renderGenreBubbles, renderRanking, toggleRankingList, renderGroupReport, toggleUserCardFact,
  renderDetailFacts, renderVotesList, renderReportMeta, renderGroupReportMeta, renderReportContent, renderReportGate,
  haptic, animateValue
} from "./ui.js?v=ac294cc";
import { initDnaView, showDna, resetDna } from "./dna-view.js?v=ac294cc";

const MIN_VOTED_FOR_REPORT = 50;
let currentUser = null;
let users = [];
let db = [];               // libreria completa (titoli + voti)
let libraryStatus = "all"; // all | watchlist | seen  (impostato dai "Vedi tutto")
let libraryFilter = "all"; // all | movie | tv
let libraryGenre = "all";
let libraryScope = "group"; // group | me — "Io" tiene solo i titoli che ho votato
let librarySort = "recenti"; // recenti | voto-desc | voto-asc
// Le etichette sono anche l'ordine del giro: ogni tocco passa alla successiva.
const LIBRARY_SORTS = [
  { id: "recenti", label: "Recenti" },
  { id: "voto-desc", label: "Voto \u2193" },
  { id: "voto-asc", label: "Voto \u2191" },
];
let watchlistMode = "me";  // me | group (Home)
let statsMode = "me";   // group | me
let reportMode = "io"; // gruppo | io
let rankingMedia = "movie"; // movie | tv
let genreView = getGenreView(); // bars | bubbles — preferenza di vista dei Generi, per dispositivo
let currentDetailId = null;
let previewItem = null;    // titolo TMDB non ancora salvato, aperto solo per consultazione
let detailReturnScreen = "home";
let currentType = "multi"; // per la ricerca
let confirmYesAction = null;
let reportTapCount = 0;   // gesto nascosto "7 tap sul titolo Report" per forzare una rigenerazione
let reportTapTimer = null;
// "Visto l'ultima volta" letto la prima volta all'avvio (vedi init()) e poi
// riaggiornato ogni volta che si lascia la Home per un'altra scheda (vedi
// goToScreen/markHomeSeen): così i puntini restano visibili per tutta la
// permanenza sulla Home, ma spariscono non appena la si lascia e si torna
// indietro (es. Home → Statistiche → Home), senza bisogno di ricaricare la pagina.
let sessionLastSeenAt = null;

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

    // Installata da home screen, "chiudere e riaprire" spesso NON ricarica
    // davvero la pagina: iOS/Android la riprendono da dove era rimasta
    // (bfcache) invece di rieseguire questo script, quindi reg.update() qui
    // sopra non gira mai più — un aggiornamento reale può restare invisibile
    // a tempo indeterminato anche dopo un vero riavvio dell'app. pageshow
    // (con persisted=true proprio per il ripristino da bfcache) copre
    // questo caso; visibilitychange copre anche il semplice "torno dal
    // background" senza passare da bfcache.
    const recheckForUpdate = () => { if (document.visibilityState === "visible") reg.update(); };
    window.addEventListener("pageshow", recheckForUpdate);
    document.addEventListener("visibilitychange", recheckForUpdate);
  }).catch(() => {});

  let alreadyReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (alreadyReloading) return;
    alreadyReloading = true;
    // NON location.reload(): su un'app installata sulla home (standalone/PWA),
    // reload() spesso si comporta come una navigazione normale invece che come
    // una ricarica forzata, quindi GitHub Pages può servire l'HTML dalla cache
    // del telefono (max-age=600) — quello VECCHIO, con ancora dentro i link a
    // styles.css/app.js/ecc. con l'hash di versione di PRIMA. Risultato: il
    // banner "Aggiorna" appare (il file sw.js è sempre rivalidato dal
    // browser), l'utente lo preme, ma i file serviti restano quelli di prima.
    // Navigando invece a un URL mai visto (con un parametro in più), quell'URL
    // è per forza un cache-miss: il browser DEVE andare in rete, prende
    // l'HTML fresco con i nuovi hash, e i file dietro quegli hash sono a loro
    // volta URL mai richiesti prima, quindi cache-miss anche loro.
    const url = new URL(window.location.href);
    url.searchParams.set("_v", Date.now().toString(36));
    window.location.replace(url.toString());
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
}

function openUserPicker(blocking) {
  const overlay = document.getElementById("userPickerOverlay");
  overlay.classList.remove("hidden");
  overlay.dataset.blocking = blocking ? "1" : "0";
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
  // Chi ha già scelto un profilo su questo stesso dispositivo (currentUser,
  // letto da getCurrentUser() in init()) trova la propria riga già
  // evidenziata: il caso comune è la stessa persona che riapre l'app, non
  // qualcuno che sceglie tra 15 nomi ogni volta da zero.
  list.innerHTML = users.map(u => {
    const recent = u === currentUser;
    return `
    <button class="user-pick-btn${recent ? " user-pick-btn--recent" : ""}" data-user="${escapeHtml(u)}">
      ${avatarHtml(u, 32)}<span>${escapeHtml(u)}</span>
      <span class="user-pick-btn__chevron" aria-hidden="true">›</span>
    </button>
  `;
  }).join("");

  const full = users.length >= MAX_USERS;
  document.getElementById("userPickerFullNote").classList.toggle("hidden", !full);
  document.getElementById("userPickerAddRow").classList.toggle("hidden", full);

  // La sfumatura in fondo alla lista ha senso solo quando c'è davvero
  // altro da scorrere: con pochi nomi (lista non scrollabile) sarebbe solo
  // un'ombra ingiustificata sotto l'ultima riga, perfettamente visibile.
  const listWrap = list.closest(".user-picker__list-wrap");
  listWrap?.classList.toggle("user-picker__list-wrap--fade", list.scrollHeight > list.clientHeight + 1);
}

// ─── CONFERMA AZIONI PERICOLOSE (es. rimuovere un titolo) ────────────────────

// yesLabel/danger: le chiamate distruttive (es. rimuovi titolo) usano il
// bottone rosso "Elimina definitivamente" — il gesto segreto dei 7 tap sotto
// (rigenera report) non distrugge nulla, quindi usa un'etichetta e uno
// stile neutri invece di riusare quelli allarmanti pensati per le
// cancellazioni.
function askConfirm(text, onYes, { yesLabel = "Elimina definitivamente", danger = true } = {}) {
  document.getElementById("confirmText").textContent = text;
  const yesBtn = document.getElementById("confirmYesBtn");
  yesBtn.textContent = yesLabel;
  yesBtn.classList.toggle("btn--danger", danger);
  confirmYesAction = onYes;
  document.getElementById("confirmOverlay").classList.remove("hidden");
}

function closeConfirm() {
  document.getElementById("confirmOverlay").classList.add("hidden");
  confirmYesAction = null;
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
  if (screen === "tonight") showDna({ db, users, currentUser });
}

function renderHome() {
  document.querySelectorAll("#watchlistModeToggle .io-gruppo-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === watchlistMode);
  });

  const watch = db
    .filter(x => x.status === "watchlist" && (watchlistMode === "group" || x.watchlist_by?.includes(currentUser)))
    .slice(0, 10);
  // db è ordinato per created_at (quando il titolo è stato CATALOGATO): va
  // bene per la watchlist ("cosa ho aggiunto di recente"), ma "Ultimi film/
  // serie visti" deve riflettere quando sono stati davvero VISTI — un
  // titolo in watchlist da tempo, appena votato, altrimenti resterebbe
  // sepolto nella sua vecchia posizione invece di comparire qui. Ordiniamo
  // esplicitamente per seen_at (vedi storage.js::updateTitleStatus/addTitle).
  const byRecentlySeen = (a, b) => new Date(b.seen_at || 0) - new Date(a.seen_at || 0);
  const seenMovies = db.filter(x => x.status === "seen" && x.media_type === "movie").sort(byRecentlySeen).slice(0, 10);
  const seenSeries = db.filter(x => x.status === "seen" && x.media_type === "tv").sort(byRecentlySeen).slice(0, 10);

  document.getElementById("watchShelfEmpty").textContent = watchlistMode === "group"
    ? "La watchlist del gruppo è vuota."
    : "La tua watchlist è vuota.";

  toggleEmpty("watchShelf", "watchShelfEmpty", watch);
  toggleEmpty("seenMovieShelf", "seenMovieShelfEmpty", seenMovies);
  toggleEmpty("seenSeriesShelf", "seenSeriesShelfEmpty", seenSeries);

  renderShelf("watchShelf", watch, sessionLastSeenAt, watchlistMode === "group");
  renderShelf("seenMovieShelf", seenMovies, sessionLastSeenAt);
  renderShelf("seenSeriesShelf", seenSeries, sessionLastSeenAt);
}

function toggleEmpty(shelfId, emptyId, items) {
  document.getElementById(shelfId).classList.toggle("hidden", items.length === 0);
  document.getElementById(emptyId).classList.toggle("hidden", items.length > 0);
}

// ─── RICERCA ────────────────────────────────────────────────────────────────

// Mostra/nasconde la "X" per svuotare la ricerca in base al contenuto reale
// del campo — funzione condivisa invece che chiusura locale a bindGlobalEvents,
// perché va richiamata anche da handleAddFromSearch qui sotto: quel percorso
// svuota #searchInput scrivendo .value direttamente, che NON genera un evento
// "input" (a differenza di quando l'utente cancella a mano), quindi senza
// questa chiamata esplicita la X restava visibile e non funzionante dopo aver
// aggiunto un titolo dai risultati.
function syncSearchClearBtn() {
  const searchInput = document.getElementById("searchInput");
  const searchClearBtn = document.getElementById("searchClearBtn");
  if (!searchInput || !searchClearBtn) return;
  const hasValue = !!searchInput.value;
  searchClearBtn.classList.toggle("hidden", !hasValue);
  document.querySelector(".search-input-wrap")?.classList.toggle("has-value", hasValue);
}

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
    const libraryMap = new Map(db.map(x => [`${x.media_type}_${x.tmdb_id}`, x]));
    res.innerHTML = renderSearchResults(normalized, libraryMap, currentUser);
    res.dataset.cache = JSON.stringify(normalized);
  } catch (e) {
    console.error(e);
    empty.textContent = "Errore di ricerca. Controlla la connessione.";
    empty.classList.remove("hidden");
  }
}

// Cerca il titolo nella cache di una sezione (i risultati della ricerca), lo
// aggiunge in libreria e mostra il toast d'esito.
async function addItemFromCache(containerId, tmdbId, type, status) {
  const cache = JSON.parse(document.getElementById(containerId).dataset.cache || "[]");
  const item = cache.find(x => String(x.id) === String(tmdbId) && x.media_type === type);
  if (!item) return null;

  const fullItem = await tmdbFetchDetail(type, tmdbId).catch(() => item);
  const res = status === "watchlist"
    ? await addToWatchlist(fullItem, currentUser)
    : await addTitle(fullItem, status, currentUser);

  if (!res.ok) {
    const msg = res.reason === "already_seen" ? "Il gruppo l'ha già segnato come visto"
      : res.reason === "duplicate" ? "Già in libreria" : "Errore, riprova";
    showToast(msg, "error");
    return null;
  }

  haptic(12);
  if (res.joined) {
    // Titolo già esistente in watchlist (di qualcun altro): ci siamo solo
    // uniti, non è un nuovo titolo — aggiorna l'item già presente in db
    // invece di duplicarlo.
    const existing = byId(res.title.id);
    if (existing) {
      existing.watchlist_by = existing.watchlist_by || [];
      if (!existing.watchlist_by.includes(currentUser)) existing.watchlist_by.push(currentUser);
    } else {
      db.unshift({ ...res.title, votes: {}, watchlist_by: [currentUser] });
    }
    showToast(`${fullItem.title} aggiunto alla tua watchlist`, "success");
  } else {
    showToast(`${fullItem.title} aggiunto`, "success");
    db.unshift({ ...res.title, votes: {}, watchlist_by: res.title.watchlist_by || [] });
  }
  return res.title.id;
}

async function handleAddFromSearch(tmdbId, type, status) {
  const savedId = await addItemFromCache("results", tmdbId, type, status);
  if (!savedId) return;
  renderAfterLocalChange();
  document.getElementById("searchInput").value = "";
  syncSearchClearBtn();
  document.getElementById("resultsSection").classList.add("hidden");
  openDetail(savedId);
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
  document.getElementById("detailSaveVoteBtn").classList.add("btn--full-row");
  document.getElementById("detailClearVoteBtn").classList.add("hidden");
  const previewStatusBtn = document.getElementById("detailStatusBtn");
  previewStatusBtn.textContent = "Aggiungi a watchlist";
  previewStatusBtn.classList.add("btn");
  previewStatusBtn.classList.remove("btn-link-quiet", "hidden");
  document.getElementById("detailRemoveBtn").classList.add("hidden");
  document.getElementById("detailPrimaryActions").classList.remove("detail-primary-actions--secondary");

  goToScreen("detail");
  pushHistoryState("detail");
}

// ─── LIBRERIA (raggiunta solo dai "Vedi tutto" della home) ───────────────────

function openLibrarySection(status, mediaFilter) {
  libraryStatus = status;
  libraryFilter = mediaFilter;
  libraryGenre = "all";
  libraryScope = "group";
  librarySort = "recenti";

  const titles = { all: "Libreria", watchlist: "Watchlist", seen: "Titoli visti" };
  document.getElementById("libraryTitle").textContent = titles[status] || "Libreria";

  renderLibraryScreen();
  goToScreen("library");
}

// Il voto su cui si ordina e' quello che la riga sta mostrando: il mio in
// modalita' "Io", la media del gruppo in "Gruppo". Nessun controllo in piu'
// da spiegare, e l'ordine non contraddice mai il numero che si legge.
function libraryVoteOf(item) {
  if (libraryScope === "me") return Number(item.votes?.[currentUser]?.vote ?? NaN);
  const media = average(item.votes);
  return media === null ? NaN : media;
}

function sortLibraryItems(items) {
  if (librarySort === "recenti") return items;   // db e' gia' per created_at
  const segno = librarySort === "voto-desc" ? -1 : 1;
  // Copia: con tutti i filtri su "tutti" items E' db, e ordinarlo sul posto
  // cambierebbe l'ordine della libreria per tutto il resto dell'app.
  return [...items].sort((a, b) => {
    const va = libraryVoteOf(a);
    const vb = libraryVoteOf(b);
    // Chi non ha voto resta in fondo in entrambi i versi: un elenco ordinato
    // per voto che si apre sui titoli senza voto non sta ordinando niente.
    if (!Number.isFinite(va) && !Number.isFinite(vb)) return 0;
    if (!Number.isFinite(va)) return 1;
    if (!Number.isFinite(vb)) return -1;
    return segno * (va - vb) || a.title.localeCompare(b.title, "it");
  });
}

function renderLibraryScreen() {
  let items = db;
  if (libraryStatus !== "all") items = items.filter(x => x.status === libraryStatus);
  if (libraryFilter === "movie") items = items.filter(x => x.media_type === "movie");
  if (libraryFilter === "tv") items = items.filter(x => x.media_type === "tv");

  // "Io" prima dei generi: cosi' le pastiglie mostrano solo i generi in cui ho
  // davvero votato qualcosa, invece di offrirne di gia' vuoti.
  if (libraryScope === "me") items = items.filter(x => x.votes && x.votes[currentUser]);

  const genreSet = new Set();
  items.forEach(x => (x.genre_names || []).forEach(g => genreSet.add(g)));
  const genres = [...genreSet].sort((a, b) => a.localeCompare(b, "it"));
  if (libraryGenre !== "all" && !genres.includes(libraryGenre)) libraryGenre = "all";
  renderGenreFilters(genres, libraryGenre);

  if (libraryGenre !== "all") items = items.filter(x => (x.genre_names || []).includes(libraryGenre));

  items = sortLibraryItems(items);

  document.querySelectorAll(".filter-pill[data-filter]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.filter === libraryFilter);
  });
  document.querySelectorAll("#libraryScopeToggle .io-gruppo-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === libraryScope);
  });
  const sortBtn = document.getElementById("librarySortBtn");
  if (sortBtn) {
    sortBtn.textContent = LIBRARY_SORTS.find(o => o.id === librarySort).label;
    sortBtn.classList.toggle("active", librarySort !== "recenti");
  }
  const countEl = document.getElementById("libraryCount");
  if (countEl) {
    const n = items.length;
    countEl.textContent = libraryScope === "me"
      ? `${n} ${n === 1 ? "titolo che hai votato" : "titoli che hai votato"}`
      : `${n} ${n === 1 ? "titolo" : "titoli"}`;
  }

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
  document.getElementById("libraryList")
    .insertAdjacentHTML("beforeend", renderLibraryList(next, libraryScope === "me" ? currentUser : null));
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
  document.querySelectorAll("#statsIoGruppoToggle .io-gruppo-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === statsMode);
  });
  document.querySelectorAll("#rankingMediaToggle .genre-view-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.media === rankingMedia);
  });
  document.querySelectorAll("#genreViewToggle .genre-view-btn").forEach(btn => {
    const on = btn.dataset.genreView === genreView;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  document.getElementById("genreLegend").textContent = genreView === "bubbles"
    ? "Riempimento = quanti titoli · Colore = quanto piace (azzurro basso → arancione alto)"
    : "★ media voto";

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
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => {
      const votes = genreVotesAcc[label] || [];
      const avgVote = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : null;
      return { label, value, avgVote };
    });
  (genreView === "bubbles" ? renderGenreBubbles : renderGenreBars)(topGenres);

  const ranked = relevant
    .filter(item => item.media_type === rankingMedia)
    .map(item => {
      const score = statsMode === "me" ? item.votes[currentUser].vote : average(item.votes);
      return { ...item, __score: score };
    })
    .filter(item => Number.isFinite(item.__score))
    .sort((a, b) => b.__score - a.__score);

  renderRanking(ranked, rankingMedia === "movie" ? "Film" : "Serie TV");
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
let groupReportCache = null;
let groupReportRefreshing = false;

function myVotedSeenCount() {
  return db.filter(x => x.status === "seen" && x.votes && x.votes[currentUser]).length;
}

async function renderReport() {
  const report = await loadLatestReport(currentUser, updated => {
    reportCache = updated;
    renderReportScreen();
  });
  if (report) reportCache = report;

  const groupReport = await loadLatestGroupReport(updated => {
    groupReportCache = updated;
    renderGroupReportScreen();
  });
  if (groupReport) groupReportCache = groupReport;

  renderReportScreen();
  renderGroupReportScreen();
  maybeAutoRefreshReport();
  maybeAutoRefreshGroupReport();
}

function renderReportScreen() {
  document.querySelectorAll("#reportIoGruppoToggle .io-gruppo-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === reportMode);
  });

  const votedCount = myVotedSeenCount();
  const hasReport = !!reportCache;
  const isIo = reportMode === "io";

  renderReportMeta(reportCache);
  renderReportContent(reportCache);
  renderReportGate(votedCount, MIN_VOTED_FOR_REPORT);

  document.getElementById("reportMetaLine").classList.toggle("hidden", !isIo);
  document.getElementById("reportGate").classList.toggle("hidden", !isIo || hasReport || votedCount >= MIN_VOTED_FOR_REPORT);
  document.getElementById("reportBody").classList.toggle("hidden", !isIo || (!hasReport && votedCount < MIN_VOTED_FOR_REPORT));
  document.getElementById("groupReportMetaLine").classList.toggle("hidden", isIo);
  document.getElementById("groupReportBody").classList.toggle("hidden", isIo);

  const btn = document.getElementById("reportRefreshBtn");
  // Il bottone compare solo per generare il PRIMO report (e solo quando si
  // hanno abbastanza titoli votati): dopo, gli aggiornamenti sono automatici.
  // Ha senso solo in vista "Io". Il Gruppo non ha un tasto equivalente:
  // si aggiorna da solo ogni 4 mesi (cron reale lato Supabase, vedi la
  // migrazione group_report_cron_4_months — maybeAutoRefreshGroupReport
  // qui resta solo come rete di sicurezza), o subito col gesto nascosto
  // dei 7 tap sul titolo "Report".
  btn.classList.toggle("hidden", !isIo || hasReport || votedCount < MIN_VOTED_FOR_REPORT);
}

// Report di Gruppo: le statistiche/podi restano SEMPRE ricalcolate al volo
// da `db` (già in memoria, nessuna chiamata di rete) — stesso identico
// modello di affidabilità delle Statistiche. Il profilo di gruppo e le
// descrizioni per persona usano invece groupReportCache quando presente
// (scritto da Claude, vedi handleGroupReportRefresh) — renderGroupReport
// in ui.js sa già ripiegare sul testo templato se è null. Richiamata ad
// ogni apertura della tab Report, indipendentemente da quale sotto-vista
// (Io/Gruppo) sia attiva al momento, così il toggle è sempre pronto senza
// dover ricalcolare al click.
function renderGroupReportScreen() {
  renderGroupReportMeta(groupReportCache);
  renderGroupReport({
    groupStats: groupProfileStats(db, users),
    memberProfiles: groupMemberProfiles(db, users, { minVotes: MIN_VOTED_FOR_REPORT }),
    leaderboard: votingLeaderboard(db),
    pair: mostAffinePair(db),
    divergentPair: mostDivergentPair(db),
    divisive: mostDivisive(db),
    unanimous: mostUnanimous(db),
    claudeReport: groupReportCache,
  });
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

// Nessun tasto visibile per questo (rimosso: si aggiornava da solo ogni
// anno comunque, vedi maybeAutoRefreshGroupReport sotto) — chiamata solo
// dal gesto nascosto dei 7 tap (vedi bindGlobalEvents), che mostra già
// la sua conferma prima e un toast di esito dopo: niente stato "spinning"
// da gestire qui, solo il flag groupReportRefreshing per evitare doppie
// chiamate in corsa.
async function handleGroupReportRefresh(force = false) {
  if (groupReportRefreshing) return;

  if (!navigator.onLine) {
    showToast("Sei offline. Connettiti per generare il report.", "error", "Report");
    return;
  }

  groupReportRefreshing = true;

  try {
    const report = await regenerateGroupReport(force);
    groupReportCache = report;
    renderGroupReportScreen();
    // Il server puo' aver rifiutato di rigenerare perche' il report e'
    // ancora recente: in quel caso restituisce quello che c'e' gia', e dirlo
    // "generato" sarebbe una bugia.
    showToast(
      report?.skipped
        ? `Il report ha ${report.days_old} giorni: e' gia' aggiornato.`
        : "Report di gruppo generato.",
      report?.skipped ? "info" : "success",
      "Report",
    );
  } catch (e) {
    console.error(e);
    showToast(e.message || "Generazione non riuscita. Riprova.", "error", "Report");
  } finally {
    groupReportRefreshing = false;
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

// Stesso schema del report personale sopra: se è passato più di un anno
// dall'ultima generazione, si rigenera da sola in background — così un
// utente nuovo che nel frattempo ha iniziato a votare finisce comunque nel
// report di gruppo entro un anno, senza che nessuno debba ricordarsi di
// toccare "Aggiorna" (che resta comunque disponibile per un aggiornamento
// immediato, es. appena arriva qualcuno di nuovo).
function maybeAutoRefreshGroupReport() {
  if (!groupReportCache || groupReportRefreshing) return;
  const last = new Date(groupReportCache.generated_at);
  if (isNaN(last.getTime())) return;
  const nextDue = new Date(last);
  nextDue.setFullYear(nextDue.getFullYear() + 1);
  if (new Date() >= nextDue) handleGroupReportRefresh();
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
// (podio o righe sotto), riporta la vista esattamente sulla sua card invece di lasciare
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
  document.getElementById("detailSaveVoteBtn").classList.toggle("btn--full-row", !hasMyVote);
  document.getElementById("detailClearVoteBtn").classList.toggle("hidden", !hasMyVote);

  const isSeen = item.status !== "watchlist";
  const statusBtn = document.getElementById("detailStatusBtn");
  // In watchlist, "Salva voto" è l'unico modo per segnare un titolo come
  // visto (un voto implica "l'ho visto", vedi handleSaveVote): niente
  // bottone per segnarlo visto senza votare, non serve. Una volta visto,
  // "Segna come non visto" resta per correggere un errore.
  statusBtn.classList.toggle("hidden", !isSeen);
  statusBtn.classList.remove("btn");
  statusBtn.classList.add("btn-link-quiet");
  statusBtn.textContent = "Segna come non visto";
  document.getElementById("detailRemoveBtn").textContent =
    isSeen ? "Rimuovi" : "Rimuovi dalla mia watchlist";
  document.getElementById("detailRemoveBtn").classList.remove("hidden");
  document.getElementById("detailPrimaryActions").classList.add("detail-primary-actions--secondary");

  goToScreen("detail");
  if (push) pushHistoryState("detail");
}

// Salva in libreria il titolo attualmente in "consultazione" (previewItem,
// non ancora in libreria), con lo status indicato. Usata sia da
// handleSaveVote (status "seen") che da handleToggleStatus (status
// "watchlist"). Ritorna l'id salvato, o null in caso di errore vero.
async function promotePreviewItem(status) {
  if (status === "watchlist") {
    // Se qualcun altro l'ha già messo in watchlist nel frattempo, ci
    // uniamo alla stessa riga condivisa invece di fallire come duplicato
    // (vedi addToWatchlist in storage.js).
    const res = await addToWatchlist(previewItem, currentUser);
    if (!res.ok) return null;
    const existing = res.joined ? byId(res.title.id) : null;
    if (existing) {
      existing.watchlist_by = existing.watchlist_by || [];
      if (!existing.watchlist_by.includes(currentUser)) existing.watchlist_by.push(currentUser);
    } else {
      db.unshift({ ...res.title, votes: {}, watchlist_by: res.title.watchlist_by || [currentUser] });
    }
    return res.title.id;
  }

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
  // Stesso principio di promotePreviewItem sopra: un voto significa sempre
  // "l'ho visto", anche se il titolo era già in libreria come watchlist.
  if (item.status === "watchlist") {
    const statusRes = await updateTitleStatus(item.id, "seen");
    if (statusRes.ok) { item.status = "seen"; item.seen_at = new Date().toISOString(); }
  }
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
  showToast("Voto rimosso", "success");
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
  // Tornando in watchlist da "visto", assicuriamoci che chi ha appena
  // premuto il tasto sia registrato come uno di chi la vuole vedere —
  // altrimenti sparirebbe subito dalla SUA watchlist (vedi
  // ensureWatchlistMembership in storage.js).
  if (nextStatus === "watchlist") {
    await ensureWatchlistMembership(item.id, currentUser);
    item.watchlist_by = item.watchlist_by || [];
    if (!item.watchlist_by.includes(currentUser)) item.watchlist_by.push(currentUser);
  }
  haptic(12);
  item.status = nextStatus;
  item.seen_at = nextStatus === "seen" ? new Date().toISOString() : null;
  renderAfterLocalChange();
  openDetail(item.id, { push: false });
}

async function handleRemove() {
  const item = byId(currentDetailId);
  if (!item) return;

  // Un titolo ancora in watchlist non ha voti da perdere: rimuovere significa
  // solo "non lo voglio più nella MIA lista" — se qualcun altro ce l'ha
  // ancora, il titolo condiviso resta (vedi removeFromWatchlist), quindi non
  // serve la conferma pesante usata per un titolo già visto e votato.
  if (item.status === "watchlist") {
    const res = await removeFromWatchlist(item.id, currentUser);
    if (!res.ok) { showToast("Errore, riprova", "error"); return; }
    haptic(12);
    showToast("Rimosso dalla tua watchlist", "success");
    currentDetailId = null;
    if (res.deleted) {
      db = db.filter(x => x.id !== item.id);
    } else {
      item.watchlist_by = (item.watchlist_by || []).filter(u => u !== currentUser);
    }
    renderAfterLocalChange();
    goToScreen("home");
    try { history.replaceState({ screen: "home" }, "", location.href); } catch {}
    return;
  }

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
  // Niente più bottone "✕" dedicato: un tap sullo sfondo scuro (fuori dalla
  // card) chiude, come un qualunque foglio/overlay — ma solo quando il
  // picker non è bloccante, altrimenti la primissima scelta profilo
  // diventerebbe annullabile senza aver scelto nessuno.
  document.getElementById("userPickerOverlay").addEventListener("click", e => {
    if (e.target.id === "userPickerOverlay" && e.currentTarget.dataset.blocking !== "1") closeUserPicker();
  });
  document.getElementById("userPickerAddBtn").addEventListener("click", handleAddUser);
  document.getElementById("userPickerInput").addEventListener("keydown", e => {
    if (e.key === "Enter") handleAddUser();
  });
  document.getElementById("userPickerList").addEventListener("click", e => {
    const btn = e.target.closest(".user-pick-btn");
    if (btn) selectUser(btn.dataset.user);
  });

  document.getElementById("confirmYesBtn").addEventListener("click", async () => {
    const action = confirmYesAction;
    closeConfirm();
    if (action) await action();
  });
  document.getElementById("confirmNoBtn").addEventListener("click", closeConfirm);

  // Gesto nascosto: 7 tap rapidi sul titolo "Report" forzano, previa
  // conferma, una rigenerazione immediata del report attualmente aperto
  // (Io o Gruppo) — utile per non aspettare l'aggiornamento automatico
  // annuale quando arriva un utente nuovo o sono cambiati un bel po' di
  // voti. Il conteggio si azzera da solo se passano più di 4s tra un tap
  // e il successivo, per non scattare per sbaglio con tap normali sparsi.
  // Ogni tap dà un feedback tattile leggero così l'utente sente che viene
  // contato, senza doverlo verificare a schermo.
  document.getElementById("reportTitleTap").addEventListener("click", () => {
    reportTapCount++;
    clearTimeout(reportTapTimer);
    reportTapTimer = setTimeout(() => { reportTapCount = 0; }, 4000);
    if (reportTapCount < 7) { haptic(6); return; }
    reportTapCount = 0;
    clearTimeout(reportTapTimer);
    haptic(20);
    const isIo = reportMode === "io";
    askConfirm(
      isIo
        ? "Rigenerare ora il tuo report personale? Userà una chiamata a Claude, anche se non è ancora passato un anno dall'ultimo aggiornamento."
        : "Rigenerare ora il report di gruppo? Userà una chiamata a Claude, anche se non è ancora passato un anno dall'ultimo aggiornamento.",
      // Il gesto nascosto e' l'unico che forza: l'utente ha appena confermato
      // di voler spendere una chiamata a Claude.
      async () => { if (isIo) await handleReportRefresh(); else await handleGroupReportRefresh(true); },
      { yesLabel: "Rigenera", danger: false }
    );
  });

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

  // "X" per svuotare la ricerca in un tap, invece di cancellare a mano e
  // ripremere Cerca: appare solo quando c'è testo, e riusa la stessa logica
  // di reset già usata da doSearch() per una query vuota.
  {
    const searchInput = document.getElementById("searchInput");
    const searchClearBtn = document.getElementById("searchClearBtn");
    searchInput.addEventListener("input", syncSearchClearBtn);
    searchClearBtn.addEventListener("click", () => {
      haptic(8);
      searchInput.value = "";
      syncSearchClearBtn();
      doSearch("");
      searchInput.focus();
    });
    syncSearchClearBtn();
  }

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
    const expandBtn = e.target.closest("[data-expand-fact]");
    if (expandBtn) { haptic(6); toggleUserCardFact(expandBtn); return; }
  });

  document.querySelectorAll(".filter-pill[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => { libraryFilter = btn.dataset.filter; renderLibraryScreen(); });
  });
  document.getElementById("libraryScopeToggle").addEventListener("click", e => {
    const btn = e.target.closest(".io-gruppo-btn");
    if (!btn || btn.dataset.mode === libraryScope) return;
    libraryScope = btn.dataset.mode;
    renderLibraryScreen();
  });

  document.getElementById("librarySortBtn").addEventListener("click", () => {
    const i = LIBRARY_SORTS.findIndex(o => o.id === librarySort);
    librarySort = LIBRARY_SORTS[(i + 1) % LIBRARY_SORTS.length].id;
    renderLibraryScreen();
  });

  document.getElementById("libraryGenreFilters").addEventListener("click", e => {
    const btn = e.target.closest("[data-genre-filter]");
    if (btn) { libraryGenre = btn.dataset.genreFilter; renderLibraryScreen(); }
  });

  document.querySelectorAll("#watchlistModeToggle .io-gruppo-btn").forEach(btn => {
    btn.addEventListener("click", () => { haptic(8); watchlistMode = btn.dataset.mode; renderHome(); });
  });
  document.querySelectorAll("#statsIoGruppoToggle .io-gruppo-btn").forEach(btn => {
    btn.addEventListener("click", () => { statsMode = btn.dataset.mode; renderStats(); });
  });
  document.querySelectorAll("#reportIoGruppoToggle .io-gruppo-btn").forEach(btn => {
    btn.addEventListener("click", () => { haptic(8); reportMode = btn.dataset.mode; renderReportScreen(); });
  });
  document.querySelectorAll("#rankingMediaToggle .genre-view-btn").forEach(btn => {
    btn.addEventListener("click", () => { rankingMedia = btn.dataset.media; renderStats(); });
  });
  document.querySelectorAll("#genreViewToggle .genre-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      haptic(8);
      genreView = btn.dataset.genreView;
      setGenreView(genreView);
      renderStats();
    });
  });
  document.getElementById("rankingExpandBtn").addEventListener("click", () => { haptic(8); toggleRankingList(); });

  document.getElementById("reportRefreshBtn").addEventListener("click", () => { haptic(8); handleReportRefresh(); });

  // DNA (la schermata che prima era "Stasera"). Il tap sui nodi lo gestisce
  // dna-view.js in delega; qui resta solo il "Ricomincia da me", che ha
  // bisogno di db/users/currentUser e quindi vive di là da app.js.
  initDnaView();
  document.getElementById("dnaResetBtn").addEventListener("click", () => {
    resetDna();
    showDna({ db, users, currentUser });
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
