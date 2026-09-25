import { test, expect, Page, Route } from "@playwright/test";

// A differenza del resto della suite (sola lettura, dati veri — vedi
// helpers.ts), questi test usano Supabase FINTO (page.route intercetta ogni
// chiamata, nessuna esce mai verso la rete vera): servono a verificare cosa
// succede quando una scrittura fallisce o va in conflitto, scenari che non
// si possono innescare in modo affidabile né sicuro contro il database
// condiviso vero. Filosofia diversa apposta, per questo in un file a parte.
//
// Coprono: i 3 bug di concorrenza trovati con una code review e corretti
// (duplicato su "Visto" da ricerca, voto su una scheda di anteprima
// diventata duplicata nel frattempo, falso successo di addToWatchlist), più
// il giro completo voto/rimozione voto, che prima non aveva nessuna
// copertura nemmeno mockata.

const BASE_TITLE = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  tmdb_id: 999001,
  media_type: "movie",
  title: "Il Titolo Conteso",
  year: "2020",
  poster_path: "/x.jpg",
  backdrop_path: "",
  overview: "",
  genre_names: ["Drama"],
  director: "Qualcuno",
  status: "watchlist",
  added_by: "Cos",
  created_at: "2026-01-01T00:00:00Z",
  seen_at: null as string | null,
};

function baseRoutes(page: Page, dati: { titles: () => unknown[]; votes: () => unknown[]; watchlistAdds: () => unknown[] }) {
  return page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/**", async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const metodo = req.method();

    if (path.endsWith("/users") && metodo === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ name: "Mattia" }, { name: "Cos" }]) });
    }
    if (path.endsWith("/titles") && metodo === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dati.titles()) });
    }
    if (path.endsWith("/votes") && metodo === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dati.votes()) });
    }
    if (path.endsWith("/watchlist_adds") && metodo === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dati.watchlistAdds()) });
    }
    // Rete di sicurezza: qualunque altra chiamata a Supabase non prevista
    // esplicitamente da un test finisce qui, mai verso la rete vera.
    return route.fulfill({ status: 204, contentType: "application/json", body: "" });
  });
}

function mockTmdb(page: Page, titolo: typeof BASE_TITLE) {
  return Promise.all([
    page.route("**/api.themoviedb.org/**/search/multi**", route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ results: [{ id: titolo.tmdb_id, media_type: "movie", title: titolo.title, release_date: `${titolo.year}-01-01`, poster_path: titolo.poster_path, overview: "" }] }),
    })),
    page.route(`**/api.themoviedb.org/**/movie/${titolo.tmdb_id}**`, route => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ id: titolo.tmdb_id, media_type: "movie", title: titolo.title, release_date: `${titolo.year}-01-01`, poster_path: titolo.poster_path, overview: "trama", genres: [{ name: "Drama" }], credits: { crew: [] } }),
    })),
  ]);
}

async function entraEcerca(page: Page, query: string) {
  await page.goto("/");
  await page.locator("#userPickerList button").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#userPickerList button").first().click();
  await page.waitForSelector("#app:not(.hidden)", { timeout: 30_000 });
  await page.locator("#searchInput").fill(query);
  await page.locator("#searchInput").press("Enter");
  const card = page.locator("#results .poster-card").first();
  await card.waitFor({ state: "visible", timeout: 10_000 });
  return card;
}

test("Bug 1 — \"✓ Visto\" da ricerca su un titolo già in watchlist altrui apre comunque la scheda", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));

  await baseRoutes(page, {
    titles: () => [BASE_TITLE],
    votes: () => [],
    watchlistAdds: () => [{ title_id: BASE_TITLE.id, user_name: "Cos" }],
  });
  let patchRicevuta = false;
  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/titles**", async route => {
    const req = route.request();
    if (req.method() === "POST") {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "23505", message: "duplicate key" }) });
    }
    if (req.method() === "PATCH") {
      patchRicevuta = true;
      return route.fulfill({ status: 204, contentType: "application/json", body: "" });
    }
    return route.fallback();
  });
  await mockTmdb(page, BASE_TITLE);

  const card = await entraEcerca(page, BASE_TITLE.title);
  await card.locator('button[data-status="seen"]').click();
  await page.waitForTimeout(800);

  expect(patchRicevuta, "nessuna PATCH per segnare il titolo come visto dopo il 'duplicato'").toBe(true);
  await expect(page.locator("#screen-detail")).not.toHaveClass(/hidden/);
  await expect(page.locator("#detailTitle")).toHaveText(BASE_TITLE.title);
  expect(errori, `eccezioni JS:\n${errori.join("\n")}`).toEqual([]);
});

test("Bug 2 — un voto su una scheda di anteprima diventata duplicata nel frattempo segna comunque il titolo come visto", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));

  const T2 = { ...BASE_TITLE, id: "cccccccc-0000-0000-0000-000000000002", tmdb_id: 999002, title: "Titolo In Anteprima" };
  let libreriaHaT2 = false; // diventa true a metà test, per simulare l'aggiunta concorrente da parte di un altro utente

  await baseRoutes(page, {
    titles: () => (libreriaHaT2 ? [T2] : []),
    votes: () => [],
    watchlistAdds: () => (libreriaHaT2 ? [{ title_id: T2.id, user_name: "Cos" }] : []),
  });
  let patchRicevuta = false;
  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/titles**", async route => {
    const req = route.request();
    if (req.method() === "POST") {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "23505", message: "duplicate key" }) });
    }
    if (req.method() === "PATCH") {
      patchRicevuta = true;
      return route.fulfill({ status: 204, contentType: "application/json", body: "" });
    }
    return route.fallback();
  });
  await mockTmdb(page, T2);

  const card = await entraEcerca(page, T2.title);
  await card.locator(".open-preview").click();
  await page.waitForSelector("#screen-detail:not(.hidden)", { timeout: 10_000 });

  // A questo punto un altro utente lo ha aggiunto: simuliamo il rientro
  // dell'app in primo piano con la libreria aggiornata (vedi
  // visibilitychange/reloadLibrary in app.js) oltre il cooldown di 60s.
  libreriaHaT2 = true;
  await page.clock.install();
  await page.clock.fastForward("01:05");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(500);

  await page.locator("#detailVoteSlider").evaluate(el => { (el as HTMLInputElement).value = "8"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator("#detailSaveVoteBtn").click();
  await page.waitForTimeout(800);

  expect(patchRicevuta, "nessuna PATCH per segnare il titolo come visto dopo il 'duplicato'").toBe(true);
  await expect(page.locator(".toast.success")).toContainText("Voto salvato");
  expect(errori, `eccezioni JS:\n${errori.join("\n")}`).toEqual([]);
});

test("Bug 3 — addToWatchlist non mente più se l'insert su watchlist_adds fallisce", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));

  const T3 = { ...BASE_TITLE, id: "dddddddd-0000-0000-0000-000000000003", tmdb_id: 999003, title: "Titolo Watchlist Rotta" };

  await baseRoutes(page, { titles: () => [], votes: () => [], watchlistAdds: () => [] });
  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/titles**", async route => {
    const req = route.request();
    if (req.method() === "POST") {
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify([{ ...T3, added_by: "Mattia" }]) });
    }
    return route.fallback();
  });
  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/watchlist_adds**", async route => {
    const req = route.request();
    if (req.method() === "POST") {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "errore simulato" }) });
    }
    return route.fallback();
  });
  await mockTmdb(page, T3);

  const card = await entraEcerca(page, T3.title);
  await card.locator('button[data-status="watchlist"]').click();
  await page.waitForTimeout(800);

  await expect(page.locator(".toast.error").last()).toContainText("Errore");
  expect(errori, `eccezioni JS:\n${errori.join("\n")}`).toEqual([]);
});

test("voto e rimozione voto: giro completo su un titolo già in watchlist", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));

  const T4 = { ...BASE_TITLE, id: "eeeeeeee-0000-0000-0000-000000000004", tmdb_id: 999004, title: "Titolo Da Votare" };
  let statoAttuale = "watchlist";
  let votoAttuale: { vote: number; comment: string | null } | null = null;

  await baseRoutes(page, {
    titles: () => [{ ...T4, status: statoAttuale }],
    votes: () => (votoAttuale ? [{ title_id: T4.id, user_name: "Mattia", vote: votoAttuale.vote, comment: votoAttuale.comment }] : []),
    // La shelf Watchlist di Home in modalità "Io" (default) mostra solo i
    // titoli in cui compare l'utente corrente — deve esserci "Mattia".
    watchlistAdds: () => [{ title_id: T4.id, user_name: "Mattia" }],
  });

  let patchStatus: string | null = null;
  let postVoto: Record<string, unknown> | null = null;
  let deleteVoto = false;
  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/titles**", async route => {
    const req = route.request();
    if (req.method() === "PATCH") {
      patchStatus = JSON.parse(req.postData() || "{}").status ?? null;
      statoAttuale = "seen";
      return route.fulfill({ status: 204, contentType: "application/json", body: "" });
    }
    return route.fallback();
  });
  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/votes**", async route => {
    const req = route.request();
    if (req.method() === "POST") {
      postVoto = JSON.parse(req.postData() || "{}");
      votoAttuale = { vote: postVoto.vote as number, comment: (postVoto.comment as string | null) ?? null };
      return route.fulfill({ status: 201, contentType: "application/json", body: "[]" });
    }
    if (req.method() === "DELETE") {
      deleteVoto = true;
      votoAttuale = null;
      return route.fulfill({ status: 204, contentType: "application/json", body: "" });
    }
    return route.fallback();
  });

  await page.goto("/");
  await page.locator("#userPickerList button").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#userPickerList button").first().click();
  await page.waitForSelector("#app:not(.hidden)", { timeout: 30_000 });

  const card = page.locator(".shelf-card").first();
  await card.waitFor({ state: "visible", timeout: 15_000 });
  await card.click();
  await page.waitForSelector("#screen-detail:not(.hidden)", { timeout: 10_000 });

  await page.locator("#detailVoteSlider").evaluate(el => { (el as HTMLInputElement).value = "9"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator("#detailSaveVoteBtn").click();
  await page.waitForTimeout(800);

  expect(postVoto, "nessun POST/upsert su votes dopo aver salvato").not.toBeNull();
  expect((postVoto as any)?.vote, "il voto inviato non corrisponde a quello scelto").toBe(9);
  expect(patchStatus, "il titolo non è passato a 'seen' dopo il voto (era in watchlist)").toBe("seen");
  await expect(page.locator(".toast.success").last()).toContainText("Voto salvato");

  await page.locator("#detailClearVoteBtn").click();
  await page.waitForTimeout(800);

  expect(deleteVoto, "nessun DELETE su votes dopo aver rimosso il voto").toBe(true);
  await expect(page.locator(".toast.success").last()).toContainText("Voto rimosso");

  expect(errori, `eccezioni JS:\n${errori.join("\n")}`).toEqual([]);
});
