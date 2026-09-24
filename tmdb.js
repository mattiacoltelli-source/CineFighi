// ─── tmdb.js ─────────────────────────────────────────────────────────────────
// Tutte le chiamate a TMDB: ricerca e dettaglio titolo.

import { normalizedItem } from "./cine-core.js?v=02e0087";

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
