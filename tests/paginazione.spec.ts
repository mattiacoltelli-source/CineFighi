import { test, expect, Page } from "@playwright/test";
import { entra, osserva, soloLettura } from "./helpers";

// Supabase (PostgREST) risponde al massimo con 1000 righe per richiesta e non
// avvisa quando taglia. Il 30/9/2026 `votes` aveva 1005 righe: il voto dato a
// "The Lighthouse" era nel database ma fetchLibrary (storage.js) non lo
// rileggeva mai — l'app diceva "Voto salvato" e al ricaricamento il voto non
// c'era. Questi test fanno da rete contro il ripetersi:
//
//   1. con Supabase FINTO (stesso tetto di 1000 righe, stessa paginazione
//      offset/limit) e tabelle piu' grandi del tetto, la libreria deve
//      tornare completa, senza righe perse ne' ripetute;
//   2. sul database VERO (sola lettura, HEAD + GET) il numero di righe che
//      l'app legge deve essere uguale a quello reale. E' il controllo che
//      scatta da solo il giorno in cui una tabella supera il tetto.

const TETTO = 1000;

type Riga = Record<string, unknown>;

async function leggiLibreria(page: Page) {
  return page.evaluate(async () => {
    const storage = await import(new URL("./storage.js", location.href).href);
    const lib: Array<{ id: string; votes: Record<string, unknown> }> = await storage.fetchLibrary();
    return {
      titoli: lib.length,
      idUnici: new Set(lib.map(t => t.id)).size,
      voti: lib.reduce((n, t) => n + Object.keys(t.votes || {}).length, 0),
      ultimoTitolo: lib.length ? lib[lib.length - 1].id : null,
    };
  });
}

test("con tabelle piu' grandi del tetto di 1000 righe la libreria torna completa", async ({ page }) => {
  const guasti = osserva(page);
  const NUM_TITOLI = 1150;
  const NUM_VOTI = 2350;

  const titoli: Riga[] = Array.from({ length: NUM_TITOLI }, (_, i) => ({
    id: `t-${String(i).padStart(5, "0")}`, tmdb_id: 100000 + i, media_type: "movie", title: `Film ${i}`,
    year: "2020", poster_path: "", backdrop_path: "", overview: "", genre_names: [], director: "",
    cast_names: [], status: "seen", added_by: "Cos", created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, seen_at: null,
  }));
  // Un voto per utente diverso su ogni titolo: nessuna chiave duplicata,
  // cosi' il conteggio finale dice esattamente quante righe sono arrivate.
  const voti: Riga[] = Array.from({ length: NUM_VOTI }, (_, i) => ({
    id: `v-${String(i).padStart(5, "0")}`, title_id: `t-${String(i % NUM_TITOLI).padStart(5, "0")}`,
    user_name: `u${Math.floor(i / NUM_TITOLI)}`, vote: 7, comment: "", created_at: "2026-01-01T00:00:00Z",
  }));
  const adds: Riga[] = [];

  // Come PostgREST: rispetta offset/limit ma non restituisce mai piu' del tetto.
  const pagina = (righe: Riga[], url: URL) => {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? TETTO), TETTO);
    return righe.slice(offset, offset + limit);
  };

  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/**", route => {
    const req = route.request();
    const url = new URL(req.url());
    const rispondi = (dati: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dati) });
    if (req.method() !== "GET") return route.fulfill({ status: 204, body: "" });
    if (url.pathname.endsWith("/users")) return rispondi([{ name: "Cos" }]);
    if (url.pathname.endsWith("/titles")) return rispondi(pagina(titoli, url));
    if (url.pathname.endsWith("/votes")) return rispondi(pagina(voti, url));
    if (url.pathname.endsWith("/watchlist_adds")) return rispondi(pagina(adds, url));
    return route.fulfill({ status: 204, body: "" });
  });

  await entra(page);
  const lib = await leggiLibreria(page);

  expect(lib.titoli, "titoli persi oltre il tetto di 1000 righe").toBe(NUM_TITOLI);
  expect(lib.idUnici, "titoli ripetuti tra una pagina e l'altra").toBe(NUM_TITOLI);
  expect(lib.voti, "voti persi oltre il tetto di 1000 righe (e' il bug di The Lighthouse)").toBe(NUM_VOTI);
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
});

test("sul database vero l'app legge tutte le righe, non un troncamento a 1000", async ({ page, request }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);

  const URL_DB = "https://dxzukpujouayxlomwryc.supabase.co/rest/v1";
  const CHIAVE = "sb_publishable_6kaInTs-_PDPHUszpj8N5w_Sb1zCXI9";   // la stessa pubblica dell'app (supabase.js)
  const conta = async (tabella: string) => {
    const res = await request.head(`${URL_DB}/${tabella}?select=id`, {
      headers: { apikey: CHIAVE, Authorization: `Bearer ${CHIAVE}`, Prefer: "count=exact" },
    });
    expect(res.ok(), `conteggio ${tabella} fallito: ${res.status()}`).toBe(true);
    return Number(res.headers()["content-range"]?.split("/")[1]);
  };

  await entra(page);
  const [titoliVeri, votiVeri] = [await conta("titles"), await conta("votes")];
  const lib = await leggiLibreria(page);

  expect(lib.titoli, `l'app legge ${lib.titoli} titoli, nel database ce ne sono ${titoliVeri}`).toBe(titoliVeri);
  expect(lib.voti, `l'app legge ${lib.voti} voti, nel database ce ne sono ${votiVeri}`).toBe(votiVeri);
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
