import { test, expect, Page } from "@playwright/test";

// La copia locale della libreria (storage.js::loadLibraryCache, app.js::init/reloadLibrary): alla riapertura
// l'app si disegna subito dall'ultima libreria vista e i dati veri la aggiornano dopo. Qui si prova che:
//   - parta davvero senza aspettare la rete;
//   - se i dati nuovi sono identici NON si tocchi niente (nessuno sfarfallio);
//   - se è cambiata una cosa sola si rifaccia quella sola (le altre card restano gli stessi nodi);
//   - una copia illeggibile o di un'altra versione venga ignorata;
//   - con il server giù si veda la copia con l'avviso, non il vuoto;
//   - un voto dato mentre la lettura è ancora in viaggio non venga cancellato dalla lettura (partita prima).
//
// Come scritture-mock.spec.ts: Supabase FINTO (page.route), nessuna chiamata esce verso la rete vera e nessun
// dato del gruppo viene letto o scritto. Lo stato "del server" sta nell'oggetto `server` e i test lo cambiano.

const CHIAVE = "cinefighiLibraryCache";
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const idTitolo = (n: number) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, "0")}`;

function titolo(n: number, extra: Record<string, unknown> = {}) {
  const visto = n <= 8;
  return {
    id: idTitolo(n), tmdb_id: 880000 + n, media_type: n % 4 === 0 ? "tv" : "movie",
    title: `Titolo ${n}`, year: "2020", poster_path: `/p${n}.jpg`, backdrop_path: "", overview: "",
    genre_names: ["Drama"], director: "Regista", cast_names: ["Attore"],
    status: visto ? "seen" : "watchlist", added_by: "Mattia",
    created_at: `2026-02-${String(n).padStart(2, "0")}T00:00:00Z`,
    seen_at: visto ? `2026-03-${String(n).padStart(2, "0")}T00:00:00Z` : null,
    ...extra,
  };
}

type Server = { titles: any[]; votes: any[]; watchlist: any[] };

// Lo "stato del server": 12 titoli (1-8 visti, 9-12 in watchlist). Mattia (il primo profilo del selettore) non ha
// votato niente, Cos ha votato i visti: così un voto di Mattia si riconosce nelle Statistiche "Io".
function nuovoServer(): Server {
  return {
    titles: Array.from({ length: 12 }, (_, i) => titolo(i + 1)),
    votes: Array.from({ length: 8 }, (_, i) => ({
      title_id: idTitolo(i + 1), user_name: "Cos", vote: 7 + (i % 3), comment: "", created_at: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
    })),
    watchlist: [9, 10, 11, 12].map(n => ({ title_id: idTitolo(n), user_name: "Mattia" })),
  };
}

// Supabase finto. Le risposte alle letture si "scattano" quando la richiesta ARRIVA e si consegnano dopo il
// cancello (se chiuso): è come un server che ha risposto prima di una scrittura ma la cui risposta arriva tardi.
function fintoSupabase(page: Page, server: Server) {
  const ctl = {
    gate: null as Promise<void> | null,
    apri: () => {},
    giu: false,
    letture: { users: 0, titles: 0, votes: 0, watchlist_adds: 0 } as Record<string, number>,
    scritture: [] as string[],
    blocca() { ctl.gate = new Promise<void>(r => { ctl.apri = () => { ctl.gate = null; r(); }; }); },
  };
  page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/**", async route => {
    const req = route.request();
    const nome = new URL(req.url()).pathname.split("/").pop()!;
    const metodo = req.method();
    if (metodo === "GET") {
      const righe = nome === "users" ? [{ name: "Mattia" }, { name: "Cos" }]
        : nome === "titles" ? server.titles : nome === "votes" ? server.votes : nome === "watchlist_adds" ? server.watchlist : [];
      const body = JSON.stringify(righe);
      ctl.letture[nome] = (ctl.letture[nome] ?? 0) + 1;
      const cancello = ctl.gate;
      if (cancello) await cancello;
      if (ctl.giu) return route.abort();
      return route.fulfill({ status: 200, contentType: "application/json", body });
    }
    if (nome === "votes" && metodo === "POST") {
      const v = JSON.parse(req.postData() || "{}");
      server.votes = server.votes.filter(x => !(x.title_id === v.title_id && x.user_name === v.user_name));
      server.votes.push({ ...v, comment: v.comment ?? "", created_at: new Date().toISOString() });
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify([v]) });
    }
    if (nome === "titles" && metodo === "PATCH") {
      const p = JSON.parse(req.postData() || "{}");
      const id = new URL(req.url()).searchParams.get("id")?.replace("eq.", "");
      const t = server.titles.find(x => x.id === id);
      if (t) Object.assign(t, p);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(t ? [t] : []) });
    }
    ctl.scritture.push(`${metodo} ${nome}`);
    return route.fulfill({ status: 204, contentType: "application/json", body: "" });
  });
  // Quello che non c'entra con la prova: niente rete vera (font, monitoraggio errori), locandine finte.
  page.route("**/fonts.googleapis.com/**", r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  page.route("**/fonts.gstatic.com/**", r => r.abort());
  page.route("**/browser.sentry-cdn.com/**", r => r.abort());
  page.route("**/image.tmdb.org/**", r => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1x1 }));
  return ctl;
}

// Prima apertura (niente copia): si sceglie il primo profilo (Mattia) e si aspetta che la copia locale sia scritta.
async function primaAperturaConCopia(page: Page) {
  await page.goto("./", { waitUntil: "domcontentloaded" });
  const lista = page.locator("#userPickerList button").first();
  await lista.waitFor({ state: "visible", timeout: 30_000 });
  await lista.click();
  await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(k => !!localStorage.getItem(k), CHIAVE, { timeout: 30_000 });
}

// Riapertura: la pagina si ricarica (stesso browser, quindi stessa copia locale).
async function riapri(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function aspettaSplashVia(page: Page) {
  await expect(page.locator("#splash")).toHaveClass(/hide/, { timeout: 15_000 });
}

test("alla riapertura l'app si disegna dalla copia locale senza aspettare la rete", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));
  const server = nuovoServer();
  const ctl = fintoSupabase(page, server);
  await primaAperturaConCopia(page);

  ctl.blocca();   // da qui la rete non risponde finché non si apre il cancello
  const lettureBase = { ...ctl.letture };
  await riapri(page);

  await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 10_000 });
  await aspettaSplashVia(page);
  await expect(page.locator("#app")).not.toHaveClass(/hidden/);
  // La rete è ancora ferma: tutto quello che si vede viene dalla copia (le letture sono partite ma non risposte).
  expect(ctl.gate, "il cancello doveva essere ancora chiuso").not.toBeNull();
  expect(await page.locator("#screen-home .shelf-card").count()).toBeGreaterThanOrEqual(8);
  // Il nome sul pulsante in alto e i dati vengono dalla copia, non dal selettore profilo.
  await expect(page.locator("#userChip")).toContainText("Mattia");

  // ...e la lettura vera è partita lo stesso, in parallelo (ferma al cancello).
  expect(ctl.letture.titles, "la lettura dei titoli doveva partire subito").toBeGreaterThan(lettureBase.titles);
  ctl.apri();
  await page.waitForTimeout(800);
  expect(ctl.scritture, `scritture inattese:\n${ctl.scritture.join("\n")}`).toEqual([]);
  expect(errori, `eccezioni JS:\n${errori.join("\n")}`).toEqual([]);
});

test("se i dati nuovi sono identici a quelli a schermo non si tocca niente (nessun ridisegno)", async ({ page }) => {
  const server = nuovoServer();
  const ctl = fintoSupabase(page, server);
  await primaAperturaConCopia(page);

  ctl.blocca();
  await riapri(page);
  await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 10_000 });
  await aspettaSplashVia(page);
  await expect.poll(() => ctl.letture.watchlist_adds, { timeout: 10_000 }).toBeGreaterThan(1);   // le letture sono partite, ferme al cancello
  await page.waitForTimeout(1500);   // le animazioni d'ingresso del primo disegno devono essere finite

  await page.evaluate(() => {
    (window as any).__mut = 0;
    const o = new MutationObserver(m => { (window as any).__mut += m.length; });
    for (const id of ["screen-home", "screen-stats"]) {
      o.observe(document.getElementById(id)!, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  });
  ctl.apri();
  await page.waitForTimeout(2000);   // il tempo che la lettura arrivi e l'app decida cosa farne

  expect(await page.evaluate(() => (window as any).__mut), "Home o Statistiche si sono mosse con dati identici").toBe(0);
});

test("se cambia una cosa sola si rifà quella sola: le altre card restano gli stessi nodi", async ({ page }) => {
  const server = nuovoServer();
  const ctl = fintoSupabase(page, server);
  await primaAperturaConCopia(page);

  // Sul server, dopo l'ultima apertura, qualcuno ha cambiato il titolo di UN film.
  const cambiato = idTitolo(3);
  server.titles.find(t => t.id === cambiato).title = "Titolo 3 (aggiornato)";

  ctl.blocca();
  await riapri(page);
  await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 10_000 });
  await aspettaSplashVia(page);
  // Finché la rete è ferma si vede ancora il titolo vecchio, dalla copia.
  await expect(page.locator(`#seenMovieShelf .shelf-card[data-id="${cambiato}"] .shelf-card__title`)).toHaveText("Titolo 3");
  await page.evaluate(() => document.querySelectorAll("#screen-home .shelf-card").forEach((c, i) => { (c as any).__tag = i + 1; }));
  const prima = await page.locator("#screen-home .shelf-card").count();
  ctl.apri();

  await expect(page.locator(`#seenMovieShelf .shelf-card[data-id="${cambiato}"] .shelf-card__title`)).toHaveText("Titolo 3 (aggiornato)", { timeout: 10_000 });
  const stato = await page.evaluate(() => Array.from(document.querySelectorAll("#screen-home .shelf-card")).map(c => ({
    id: c.getAttribute("data-id"), tag: (c as any).__tag ?? null,
  })));
  expect(stato.length, "le card sono cambiate di numero").toBe(prima);
  for (const c of stato) {
    if (c.id === cambiato) expect(c.tag, "la card cambiata doveva essere rifatta").toBeNull();
    else expect(c.tag, `la card ${c.id} non doveva essere toccata`).not.toBeNull();
  }
});

for (const [nome, rovina] of [
  ["illeggibile", (s: string) => "{ non è json"],
  ["di un'altra versione", (s: string) => s.replace(/^\{"v":"[^"]*"/, '{"v":"altra-versione"')],
  ["troppo vecchia", (s: string) => s.replace(/"at":\d+/, '"at":1000')],
  ["con titoli di forma strana", (s: string) => s.replace(/"genre_names":\["Drama"\]/, '"genre_names":"Drama"')],
] as const) {
  test(`una copia locale ${nome} viene ignorata e rifatta: l'app parte come sempre`, async ({ page }) => {
    const server = nuovoServer();
    const ctl = fintoSupabase(page, server);
    await primaAperturaConCopia(page);
    await page.evaluate(([k, src]) => {
      const f = new Function("s", `return (${src})(s)`) as (s: string) => string;
      localStorage.setItem(k, f(localStorage.getItem(k)!));
    }, [CHIAVE, rovina.toString()] as const);

    ctl.blocca();
    await riapri(page);
    await page.waitForTimeout(2500);
    // Senza copia valida non c'è niente da mostrare finché la rete non risponde.
    expect(await page.locator("#screen-home .shelf-card").count(), "la copia rovinata è stata usata").toBe(0);
    await expect(page.locator("#app")).toHaveClass(/hidden/);

    ctl.apri();
    await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(k => { const s = localStorage.getItem(k); return !!s && s.startsWith('{"v":"') && !s.startsWith('{"v":"altra-versione"') && !s.includes('"at":1000,'); }, CHIAVE, { timeout: 15_000 });
  });
}

test("una copia che passa i controlli ma fa inciampare il disegno viene scartata: l'app non resta sulla splash", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));
  const server = nuovoServer();
  fintoSupabase(page, server);
  await primaAperturaConCopia(page);
  // JSON valido e forma giusta, ma un voto nullo: average() inciampa appena si disegna la Home.
  await page.evaluate(k => localStorage.setItem(k, localStorage.getItem(k)!.replace('"votes":{"Cos"', '"votes":{"Rotto":null,"Cos"')), CHIAVE);

  await riapri(page);
  await aspettaSplashVia(page);
  await expect(page.locator("#app")).not.toHaveClass(/hidden/);
  await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(k => { const s = localStorage.getItem(k); return !!s && !s.includes('"Rotto"'); }, CHIAVE, { timeout: 15_000 });
  expect(errori, `eccezioni JS non gestite:\n${errori.join("\n")}`).toEqual([]);
});

test("con il server giù la copia locale resta a schermo, con l'avviso, e non si finisce al selettore profilo", async ({ page }) => {
  const server = nuovoServer();
  const ctl = fintoSupabase(page, server);
  await primaAperturaConCopia(page);

  ctl.giu = true;
  await riapri(page);
  await expect(page.locator("#seenMovieShelf .shelf-card").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".toast.error .toast__text", { hasText: "Impossibile aggiornare la libreria" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#app")).not.toHaveClass(/hidden/);
  await expect(page.locator("#userPickerOverlay")).toHaveClass(/hidden/);
  expect(await page.locator("#screen-home .shelf-card").count()).toBeGreaterThanOrEqual(8);
});

test("un voto dato mentre la lettura è ancora in viaggio non viene cancellato da quella lettura", async ({ page }) => {
  const errori: string[] = [];
  page.on("pageerror", e => errori.push(e.message));
  const server = nuovoServer();
  const ctl = fintoSupabase(page, server);
  await primaAperturaConCopia(page);

  ctl.blocca();
  await riapri(page);
  const card = page.locator(`#seenMovieShelf .shelf-card[data-id="${idTitolo(2)}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await aspettaSplashVia(page);

  // Mentre le letture sono ferme (e fotografano il server SENZA il voto), Mattia vota il Titolo 2.
  await card.click();
  await page.waitForSelector("#screen-detail:not(.hidden)", { timeout: 10_000 });
  await page.locator("#detailVoteSlider").evaluate(el => { (el as HTMLInputElement).value = "9"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator("#detailSaveVoteBtn").click();
  await expect(page.locator(".toast.success").last()).toContainText("Voto salvato");
  expect(server.votes.some(v => v.title_id === idTitolo(2) && v.user_name === "Mattia"), "il voto non è arrivato al server finto").toBe(true);

  const base = ctl.letture.titles;
  ctl.apri();   // arrivano le letture "vecchie": non devono vincere
  await expect.poll(() => ctl.letture.titles, { timeout: 10_000 }).toBeGreaterThan(base);   // l'app ha riletto
  await page.waitForTimeout(800);

  await page.locator("#detailBackBtn").click();
  await page.locator('.nav__btn[data-screen="stats"]').click();
  await expect(page.locator("#screen-stats .podium-card", { hasText: "Titolo 2" })).toBeVisible({ timeout: 10_000 });
  expect(errori, `eccezioni JS:\n${errori.join("\n")}`).toEqual([]);
});

// patchHtml (ui.js) deve dare ESATTAMENTE lo stesso risultato di un ridisegno completo, e lasciare gli stessi nodi
// dove un figlio è identico. Prove casuali con un generatore a seme fisso (ripetibili).
test("patchHtml dà lo stesso DOM di un ridisegno completo e riusa i nodi identici (prove casuali)", async ({ page }) => {
  fintoSupabase(page, nuovoServer());
  await page.goto("./", { waitUntil: "domcontentloaded" });
  const esito = await page.evaluate(async () => {
    const src = (document.querySelector('script[src*="app.js"]') as HTMLScriptElement).src;
    const v = new URL(src).searchParams.get("v");
    const { patchHtml } = await import(`./ui.js?v=${v}`);

    let seme = 12345;
    const rnd = () => { seme = (seme * 1664525 + 1013904223) % 4294967296; return seme / 4294967296; };
    const intero = (n: number) => Math.floor(rnd() * n);

    type Voce = { id: number | null; v: number };
    const html = (voci: Voce[]) => voci.map(x =>
      `\n  <div class="card"${x.id === null ? "" : ` data-id="${x.id}"`}>\n    <span>${x.id ?? "senza chiave"}/${x.v}</span>\n  </div>\n`).join("");
    const genera = (conChiavi: boolean): Voce[] => {
      const n = intero(9);
      const ids = Array.from({ length: 14 }, (_, i) => i).sort(() => rnd() - 0.5).slice(0, n);
      return ids.map(id => ({ id: conChiavi ? id : null, v: intero(3) }));
    };

    const problemi: string[] = [];
    let riusi = 0;
    for (let prova = 0; prova < 600; prova++) {
      const conChiavi = rnd() < 0.8;
      const a = genera(conChiavi), b = genera(conChiavi);
      const el = document.createElement("div");
      document.body.appendChild(el);
      el.innerHTML = html(a);
      Array.from(el.children).forEach((c, i) => { (c as any).__n = `n${i}`; });
      const vecchi = Array.from(el.children) as any[];
      patchHtml(el, html(b));

      const atteso = document.createElement("div");
      atteso.innerHTML = html(b);
      const got = Array.from(el.children).map(c => (c as HTMLElement).outerHTML);
      const want = Array.from(atteso.children).map(c => (c as HTMLElement).outerHTML);
      if (JSON.stringify(got) !== JSON.stringify(want)) problemi.push(`prova ${prova}: DOM diverso\n${got.join("|")}\n${want.join("|")}`);
      if (el.childNodes.length !== el.children.length) problemi.push(`prova ${prova}: nodi di testo rimasti`);
      // Un figlio identico a uno di prima (stessa chiave e stesso HTML) deve essere lo STESSO nodo.
      if (conChiavi) {
        Array.from(el.children).forEach(c => {
          const vecchio = vecchi.find(o => o.dataset.id === (c as HTMLElement).dataset.id && o.outerHTML === (c as HTMLElement).outerHTML);
          if (vecchio) { riusi++; if (vecchio !== c) problemi.push(`prova ${prova}: nodo ${(c as HTMLElement).dataset.id} ricreato pur essendo identico`); }
        });
      }
      el.remove();
    }
    // Contenitore con altro dentro (testo): ricade sul semplice innerHTML.
    const el2 = document.createElement("div");
    el2.innerHTML = "<p>a</p>";
    patchHtml(el2, "testo libero <b>x</b>");
    if (el2.innerHTML !== "testo libero <b>x</b>") problemi.push("html con testo libero non applicato");
    return { problemi, riusi };
  });
  expect(esito.problemi.slice(0, 5), esito.problemi.slice(0, 5).join("\n")).toEqual([]);
  expect(esito.riusi, "la prova non ha mai riusato un nodo: non verifica niente").toBeGreaterThan(100);
});
