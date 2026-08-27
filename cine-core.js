// ─── cine-core.js ────────────────────────────────────────────────────────────
// Funzioni "di servizio": formattazioni, calcoli, normalizzazione dati TMDB.
// Non parlano né con Supabase né con TMDB direttamente: sono utility pure.

const IMG = "https://image.tmdb.org/t/p/w500";

const GENRE_MAP = {
  28: "Azione", 12: "Avventura", 16: "Animazione", 35: "Commedia",
  80: "Crime", 99: "Documentario", 18: "Drama", 10751: "Famiglia",
  14: "Fantasy", 36: "Storia", 27: "Horror", 10402: "Musica",
  9648: "Mistero", 10749: "Romance", 878: "Fantascienza", 10770: "TV Movie",
  53: "Thriller", 10752: "Guerra", 37: "Western", 10759: "Azione & Avventura",
  10762: "Bambini", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War & Politics"
};

export const GENRE_NAME_TO_ID = {
  "Azione": 28, "Avventura": 12, "Animazione": 16, "Commedia": 35,
  "Crime": 80, "Documentario": 99, "Drama": 18, "Dramma": 18,
  "Famiglia": 10751, "Fantasy": 14, "Storia": 36, "Horror": 27,
  "Musica": 10402, "Mistero": 9648, "Romance": 10749, "Fantascienza": 878,
  "Thriller": 53, "Guerra": 10752, "Western": 37,
  "Azione & Avventura": 10759, "Sci-Fi & Fantasy": 10765
};

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeGenres(item) {
  if (Array.isArray(item.genre_ids)) return item.genre_ids.map(id => GENRE_MAP[id] || `Genere ${id}`);
  if (Array.isArray(item.genres)) return item.genres.map(g => (typeof g === "string" ? g : g.name)).filter(Boolean);
  if (Array.isArray(item.genre_names)) return item.genre_names;
  return [];
}

export function posterUrl(path) { return path ? `${IMG}${path}` : ""; }
export function backdropUrl(path) { return path ? `https://image.tmdb.org/t/p/w1280${path}` : ""; }

export function yearOf(item) {
  const d = item.release_date || item.first_air_date || "";
  return d ? d.slice(0, 4) : (item.year || "—");
}

export function titleOf(item) { return item.title || item.name || "Titolo sconosciuto"; }

export function extractDirector(item) {
  if (item.director) return item.director;
  if (item.media_type === "movie" || item.release_date) {
    const crew = item.credits?.crew || [];
    const d = crew.find(p => p.job === "Director");
    if (d?.name) return d.name;
  }
  if (item.media_type === "tv" || item.first_air_date) {
    if (Array.isArray(item.created_by) && item.created_by[0]?.name) return item.created_by[0].name;
  }
  return "";
}

// Trasforma un risultato grezzo TMDB in un oggetto pulito e uniforme
export function normalizedItem(item) {
  return {
    id: item.id,
    media_type: (item.media_type === "tv" || item.first_air_date) ? "tv" : "movie",
    title: titleOf(item),
    year: yearOf(item),
    poster_path: item.poster_path || "",
    backdrop_path: item.backdrop_path || "",
    overview: item.overview
      ? (item.overview.length > 300 ? item.overview.slice(0, 300) + "..." : item.overview)
      : "",
    vote_average: item.vote_average || 0,
    vote_count: item.vote_count || 0,
    genre_names: normalizeGenres(item),
    director: extractDirector(item),
    release_date: item.release_date || "",
    first_air_date: item.first_air_date || ""
  };
}

export function uniqueKey(item) { return `${item.media_type}_${item.id}`; }
export function mediaLabel(item) { return item.media_type === "movie" ? "Film" : "Serie TV"; }
export function mediaBadgeClass(item) { return item.media_type === "movie" ? "badge-film" : "badge-series"; }

export function decadeOf(year) {
  if (!year || year === "—" || isNaN(Number(year))) return "Sconosciuta";
  return `${Math.floor(Number(year) / 10) * 10}s`;
}

export function rawNumberToFixed(value, digits = 1, fallback = "n.d.") {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toFixed(digits) : fallback;
}

export function formatReleaseDate(dateStr) {
  if (!dateStr) return "Data non disponibile";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

export function buildDateRange(startYear, endYear, type) {
  if (!startYear || !endYear) return "";
  return type === "movie"
    ? `&primary_release_date.gte=${startYear}-01-01&primary_release_date.lte=${endYear}-12-31`
    : `&first_air_date.gte=${startYear}-01-01&first_air_date.lte=${endYear}-12-31`;
}

export function randomPage(max = 5) { return Math.floor(Math.random() * max) + 1; }

// Voto: numero da 0 a 10, con mezzi punti. Niente sintassi speciale (7+, 8-),
// teniamo la cosa semplice: si vota con uno slider.
export function sanitizeVote(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(10, Math.round(num * 2) / 2));
}

// Calcola la media di gruppo di un titolo a partire dal suo oggetto voti
// votesObj = { "Mattia": { vote: 8, comment: "..." }, "Luca": { vote: 6.5 } }
export function average(votesObj) {
  const vals = Object.values(votesObj || {})
    .map(v => Number(v.vote))
    .filter(Number.isFinite);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function voteCount(votesObj) {
  return Object.keys(votesObj || {}).length;
}

// Chi ha votato, da mostrare accanto al voto nelle shelf della Home (vedi
// ui.js::renderShelf) — { name: "Marco", others: 0 } se ha votato una
// persona sola, { name: "Marco", others: 2 } se ce ne sono altre (name e
// others separati, non già uniti in una stringa: con un nome lungo il
// troncamento CSS deve poter tagliare SOLO il nome, mai il "+N" — è
// l'unico segnale che dice "hanno votato in più persone"). Niente
// timestamp per voto in tabella "votes": l'ordine alfabetico è l'unico
// criterio deterministico disponibile (lo stesso titolo deve mostrare
// sempre lo stesso nome, non uno a caso a ogni render). null se nessuno ha
// ancora votato.
export function firstVoter(votesObj) {
  const names = Object.keys(votesObj || {}).sort((a, b) => a.localeCompare(b, "it"));
  if (!names.length) return null;
  return { name: names[0], others: names.length - 1 };
}
