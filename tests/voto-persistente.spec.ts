import { test, expect, Page } from "@playwright/test";
import { osserva } from "./helpers";

// Il 30/9/2026 un voto a "The Lighthouse" risulto' salvato ("Voto salvato"), era
// nel database, ma al ricaricamento non c'era: la tabella votes aveva piu' di
// 1000 righe, l'app ne leggeva solo le prime 1000 e il voto nuovo cadeva fuori.
// Questo test rifa' il giro intero con un Supabase FINTO che ricorda quello
// che riceve e che si comporta come quello vero sul tetto: 1000 righe per
// richiesta, niente di piu', senza avvisare. Dopo aver votato si ricarica la
// pagina e il voto deve essere ancora li'. Nessuna chiamata esce verso la rete.

const TETTO = 1000;
const ID_TITOLO = "aaaaaaaa-0000-0000-0000-00000000b001";
const ID_RIEMPITIVO = "aaaaaaaa-0000-0000-0000-00000000b002";

const titolo = (id: string, n: number, nome: string) => ({
  id, tmdb_id: 880000 + n, media_type: "movie", title: nome, year: "2019", poster_path: "", backdrop_path: "",
  overview: "", genre_names: ["Horror"], director: "Regista", cast_names: [], status: "seen", added_by: "Cos",
  created_at: "2026-08-19T08:00:00Z", seen_at: "2026-08-19T08:00:00Z",
});

type Riga = Record<string, unknown>;

async function entraSeServe(page: Page) {
  const picker = page.locator("#userPickerList button").first();
  const app = page.locator("#app:not(.hidden)");
  await Promise.race([picker.waitFor({ state: "visible", timeout: 30_000 }), app.waitFor({ state: "visible", timeout: 30_000 })]);
  if (await picker.isVisible().catch(() => false)) await picker.click();
  await app.waitFor({ state: "visible", timeout: 30_000 });
}

test("un voto dato con la tabella votes oltre le 1000 righe si rilegge dopo il ricaricamento", async ({ page }) => {
  const guasti = osserva(page);

  const titoli = [titolo(ID_TITOLO, 1, "Titolo Bersaglio"), titolo(ID_RIEMPITIVO, 2, "Titolo Riempitivo")];
  // 1004 voti gia' presenti (tutti di altre persone, sul titolo riempitivo) +
  // quello di Cos sul bersaglio: il voto nuovo di Mattia sara' il 1006esimo.
  const voti: Riga[] = Array.from({ length: 1004 }, (_, i) => ({
    id: `v-${String(i).padStart(5, "0")}`, title_id: ID_RIEMPITIVO, user_name: `altro${i}`, vote: 7, comment: "", created_at: "2026-09-01T00:00:00Z",
  }));
  voti.push({ id: "v-cos", title_id: ID_TITOLO, user_name: "Cos", vote: 8, comment: "", created_at: "2026-08-19T08:01:00Z" });

  const pagina = (righe: Riga[], url: URL) => {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? TETTO), TETTO);
    return righe.slice(offset, offset + limit);
  };

  await page.route("**/dxzukpujouayxlomwryc.supabase.co/rest/v1/**", async route => {
    const req = route.request();
    const url = new URL(req.url());
    const ok = (dati: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(dati) });
    const p = url.pathname;

    if (req.method() === "GET") {
      if (p.endsWith("/users")) return ok([{ name: "Mattia" }, { name: "Cos" }]);
      if (p.endsWith("/titles")) return ok(pagina(titoli, url));
      if (p.endsWith("/votes")) return ok(pagina(voti, url));
      if (p.endsWith("/watchlist_adds")) return ok([]);
    }
    if (p.endsWith("/votes") && req.method() === "POST") {
      // upsert: (title_id, user_name) e' unico, un secondo voto aggiorna la riga
      const nuovo = JSON.parse(req.postData() || "{}");
      const esistente = voti.find(v => v.title_id === nuovo.title_id && v.user_name === nuovo.user_name);
      const riga = esistente ? Object.assign(esistente, nuovo) : { id: `v-nuovo-${voti.length}`, created_at: new Date().toISOString(), ...nuovo };
      if (!esistente) voti.push(riga);
      return ok([riga], 201);   // come Supabase vero con .select(): l'array della riga scritta
    }
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("./");
  await entraSeServe(page);

  await page.locator(".shelf-card", { hasText: "Titolo Bersaglio" }).first().click();
  await page.waitForSelector("#screen-detail:not(.hidden)", { timeout: 10_000 });
  await page.locator("#detailVoteSlider").evaluate(el => { (el as HTMLInputElement).value = "9"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator("#detailSaveVoteBtn").click();
  await expect(page.locator(".toast.success").last()).toContainText("Voto salvato");
  expect(voti.length, "il voto non e' arrivato al finto database").toBe(1006);

  // Il punto del test: dopo il ricaricamento il voto deve essere ancora la'.
  await page.reload();
  await entraSeServe(page);
  await page.locator(".shelf-card", { hasText: "Titolo Bersaglio" }).first().click();
  await page.waitForSelector("#screen-detail:not(.hidden)", { timeout: 10_000 });

  await expect(page.locator("#detailVoteSlider"), "il voto dato non si rilegge dopo il ricaricamento (la lettura taglia a 1000 righe?)").toHaveValue("9");
  await expect(page.locator("#detailVoteSummary"), "dopo il ricaricamento l'app non riconosce il voto dato").toBeVisible();
  await expect(page.locator("#detailVoteSummaryNum")).toHaveText("9.0");
  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
});
