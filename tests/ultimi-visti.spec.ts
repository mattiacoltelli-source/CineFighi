import { test, expect } from "@playwright/test";
import { entra, osserva } from "./helpers";

// "Ultimi film visti" in Home deve mettere in cima cio' che e' stato visto o
// votato per ultimo. Il 30/9/2026 un film gia' "visto" da un altro (seen_at di
// agosto) e votato quel giorno restava sepolto: si ordinava solo per seen_at.
// Supabase FINTO (nessuna chiamata esce verso la rete vera).

const titolo = (n: number, extra: Record<string, unknown>) => ({
  id: `t-${n}`, tmdb_id: 1000 + n, media_type: "movie", title: `Film ${n}`, year: "2020",
  poster_path: "", backdrop_path: "", overview: "", genre_names: [], director: "", cast_names: [],
  status: "seen", added_by: "Mattia", created_at: "2026-08-01T00:00:00Z", seen_at: null, ...extra,
});

test("gli ultimi visti sono in ordine di ultima attivita', compreso un voto recente su un titolo visto da tempo", async ({ page }) => {
  const guasti = osserva(page);
  const titoli = [
    titolo(1, { seen_at: "2026-09-10T10:00:00Z" }),                  // visto a meta' mese
    titolo(2, { seen_at: "2026-09-20T10:00:00Z" }),                  // visto piu' di recente
    titolo(3, { seen_at: "2026-08-19T08:00:00Z" }),                  // visto ad agosto...
    titolo(4, { seen_at: "2026-09-25T10:00:00Z" }),                  // l'ultimo segnato visto
  ];
  const voti = [
    { id: "v1", title_id: "t-3", user_name: "Cos", vote: 7, comment: "", created_at: "2026-09-30T16:21:00Z" },  // ...ma votato OGGI
    { id: "v2", title_id: "t-1", user_name: "Mattia", vote: 8, comment: "", created_at: "2026-09-10T10:05:00Z" },
  ];

  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/**", route => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const ok = (d: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(d) });
    if (req.method() !== "GET") return route.fulfill({ status: 204, body: "" });
    if (p.endsWith("/users")) return ok([{ name: "Mattia" }, { name: "Cos" }]);
    if (p.endsWith("/titles")) return ok(titoli);
    if (p.endsWith("/votes")) return ok(voti);
    if (p.endsWith("/watchlist_adds")) return ok([]);
    return route.fulfill({ status: 204, body: "" });
  });

  await entra(page);
  const ordine = await page.locator("#seenMovieShelf .shelf-card__title").allTextContents();

  expect(ordine, "ordine degli ultimi film visti").toEqual(["Film 3", "Film 4", "Film 2", "Film 1"]);
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
});
