// ─── tmdb.js ─────────────────────────────────────────────────────────────────
// Tutte le chiamate a TMDB: ricerca, dettaglio titolo, e "discover" usato
// dall'algoritmo di "Stasera cosa guardo" (a più livelli, come CineTracker).

import { normalizedItem, uniqueKey, buildDateRange, randomPage, GENRE_NAME_TO_ID } from "./cine-core.js?v=27";

const API_KEY = "c9ebaca404bbc26bad39cce1c3aa9677";
const BASE_URL = "https://api.themoviedb.org/3";

// Cache in memoria, si azzera ad ogni ricarica della pagina
const _cache = new Map();
function cacheGet(k) { return _cache.has(k) ? _cache.get(k) : null; }
function cacheSet(k, v) { _cache.set(k, v); }

export async function tmdbSearch(query, type = "multi") {
  const cacheKey = `search|${type}|${query.trim().toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const endpoint = type === "movie"
    ? `${BASE_URL}/search/movie?api_key=${API_KEY}&language=it-IT&query=${encodeURIComponent(query)}`
    : type === "tv"
    ? `${BASE_URL}/search/tv?api_key=${API_KEY}&language=it-IT&query=${encodeURIComponent(query)}`
    : `${BASE_URL}/search/multi?api_key=${API_KEY}&language=it-IT&query=${encodeURIComponent(query)}`;

  const res = await fetch(endpoint);
  if (!res.ok) throw new Error("Errore TMDb search");
  const data = await res.json();
  const results = (data.results || []).filter(x => x.media_type !== "person").slice(0, 20);
  cacheSet(cacheKey, results);
  return results;
}

export async function tmdbFetchDetail(type, id) {
  const cacheKey = `detail|${type}|${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${BASE_URL}/${type}/${id}?api_key=${API_KEY}&language=it-IT&append_to_response=credits`);
  if (!res.ok) throw new Error("Errore dettaglio TMDb");
  const item = await res.json();
  const result = normalizedItem({ ...item, media_type: type });
  cacheSet(cacheKey, result);
  return result;
}

// Pesca titoli da uno o più URL discover, escludendo quelli già in libreria
export async function tmdbFetchDiscoverLevel(urls, type, excludedKeys) {
  const map = new Map();

  const responses = await Promise.all(urls.map(async url => {
    const cacheKey = `discover|${url}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const results = data.results || [];
      cacheSet(cacheKey, results);
      return results;
    } catch { return []; }
  }));

  responses.flat().forEach(raw => {
    const item = normalizedItem({ ...raw, media_type: type });
    const key = uniqueKey(item);
    if (excludedKeys.has(key)) return;
    if (!item.poster_path || !item.title) return;
    if ((item.vote_count || 0) < 20) return;
    map.set(key, item);
  });

  return [...map.values()];
}

// Pesca candidati mirati su un range di anni specifico (usata per garantire un
// mix di decadi diverse nei "5 consigli", invece di sperare che il pool
// generico ne contenga di ogni epoca).
export async function tmdbFetchDecadeCandidates(type, yearStart, yearEnd, genreIds, excludedKeys) {
  const minVotes = type === "movie" ? "&vote_count.gte=80" : "&vote_count.gte=30";
  const dateParam = type === "movie"
    ? `&primary_release_date.gte=${yearStart}-01-01&primary_release_date.lte=${yearEnd}-12-31`
    : `&first_air_date.gte=${yearStart}-01-01&first_air_date.lte=${yearEnd}-12-31`;

  const primaryGenre = genreIds[0] ? `&with_genres=${genreIds[0]}` : "";
  const comboGenres = genreIds.slice(0, 2).filter(Boolean).join(",");
  const comboParam = comboGenres ? `&with_genres=${comboGenres}` : "";

  const urls = [
    `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${comboParam}${dateParam}&sort_by=popularity.desc${minVotes}&page=${randomPage(5)}`,
    `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${primaryGenre}${dateParam}&sort_by=vote_average.desc${minVotes}&page=${randomPage(5)}`,
    `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${dateParam}&sort_by=popularity.desc${minVotes}&page=${randomPage(5)}`
  ];

  return tmdbFetchDiscoverLevel(urls, type, excludedKeys);
}

// Pesca candidati ESCLUDENDO i generi preferiti dell'utente (without_genres),
// con una soglia di voto più alta del solito: "fuori zona" non deve
// significare "qualità bassa".
export async function tmdbFetchOutOfComfortZoneCandidates(type, excludeGenreIds, excludedKeys) {
  const minVotes = type === "movie" ? "&vote_count.gte=150" : "&vote_count.gte=60";
  const withoutGenres = excludeGenreIds.length ? `&without_genres=${excludeGenreIds.join(",")}` : "";

  const urls = [
    `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${withoutGenres}&sort_by=vote_average.desc${minVotes}&page=${randomPage(5)}`,
    `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${withoutGenres}&sort_by=popularity.desc${minVotes}&page=${randomPage(5)}`
  ];

  return tmdbFetchDiscoverLevel(urls, type, excludedKeys);
}

// Costruisce i 4 livelli di ricerca (precisa → ampia → solo genere → fallback),
// esattamente come nell'algoritmo originale di CineTracker, basandosi sul
// profilo di gusti della persona selezionata.
export function buildFallbackQueries(profile, forcedType, options = {}) {
  const useSelectedGenre = options.useSelectedGenre === true;
  const selectedGenre = options.selectedGenre || "all";
  const selectedGenreId = (useSelectedGenre && selectedGenre !== "all")
    ? GENRE_NAME_TO_ID[selectedGenre]
    : null;

  const type = forcedType || profile.prefType;
  const selectedBoosts = useSelectedGenre && selectedGenre !== "all" ? [selectedGenre] : [];

  const mergedGenres = [...new Set(
    selectedGenreId ? [selectedGenre, ...profile.topGenres] : profile.topGenres
  )];

  const genreIds = mergedGenres.map(g => GENRE_NAME_TO_ID[g]).filter(Boolean);
  const primaryGenre = selectedGenreId || genreIds[0] || "";
  const secondaryGenre = genreIds[1] || "";
  const comboGenres = selectedGenreId
    ? [selectedGenreId, genreIds[0]].filter(Boolean).slice(0, 2).join(",")
    : genreIds.slice(0, 2).join(",");

  let preciseDate = "";
  let widerDate = "";

  if (profile.topDecade) {
    const dy = parseInt(profile.topDecade, 10);
    if (!isNaN(dy)) {
      preciseDate = buildDateRange(dy, dy + 9, type);
      widerDate = buildDateRange(Math.max(1970, dy - 10), dy + 14, type);
    }
  }

  const minVotes = type === "movie" ? "&vote_count.gte=120" : "&vote_count.gte=40";
  const [p1, p2, p3, p4] = [randomPage(10), randomPage(10), randomPage(10), randomPage(10)];

  return {
    type,
    selectedBoosts,
    levels: [
      {
        label: "ricerca precisa",
        urls: [
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${comboGenres ? `&with_genres=${comboGenres}` : ""}${preciseDate}&sort_by=popularity.desc${minVotes}&page=${p1}`,
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${primaryGenre ? `&with_genres=${primaryGenre}` : ""}${preciseDate}&sort_by=vote_average.desc${minVotes}&page=${p2}`
        ]
      },
      {
        label: "ricerca più ampia",
        urls: [
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${primaryGenre ? `&with_genres=${primaryGenre}` : ""}${widerDate}&sort_by=popularity.desc${minVotes}&page=${p3}`,
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${secondaryGenre ? `&with_genres=${secondaryGenre}` : ""}${widerDate}&sort_by=vote_count.desc${minVotes}&page=${p4}`
        ]
      },
      {
        label: "solo genere",
        urls: [
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${primaryGenre ? `&with_genres=${primaryGenre}` : ""}&sort_by=popularity.desc${minVotes}&page=${randomPage(10)}`,
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT${comboGenres ? `&with_genres=${comboGenres}` : ""}&sort_by=vote_average.desc${minVotes}&page=${randomPage(10)}`
        ]
      },
      {
        label: "fallback finale",
        urls: [
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT&sort_by=popularity.desc${minVotes}&page=${randomPage(10)}`,
          `${BASE_URL}/discover/${type}?api_key=${API_KEY}&language=it-IT&sort_by=vote_count.desc${minVotes}&page=${randomPage(10)}`
        ]
      }
    ]
  };
}
