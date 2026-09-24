import { test, expect } from "@playwright/test";
import { entra, soloLettura } from "./helpers";

// La vecchia suite in qa-agent copriva questo scenario, ma quel repo di
// test separato non testa piu' CineFighi in nessuna forma (rimozione
// completa dal 2026-09-24, vedi il suo README). Lo portiamo qui, nella
// suite di guardia di questo repo, che e' quella davvero attiva ad ogni
// push.
//
// doSearch() (app.js) ha gia' un try/catch dedicato a TMDB irraggiungibile:
// qui verifichiamo che funzioni davvero, non solo che esista nel codice.
test("la ricerca con TMDB irraggiungibile fallisce con un messaggio chiaro, non resta bloccata in silenzio", async ({ page }) => {
  const scritture = soloLettura(page);
  await entra(page);

  // Solo TMDB, non Supabase: entra() ha gia' fatto le sue letture, e questo
  // test non deve toccare il database del gruppo.
  await page.route(/api\.themoviedb\.org/, route => route.abort());

  await page.locator("#searchInput").fill("Inception");
  await page.locator("#searchBtn").click();

  const empty = page.locator("#resultsEmpty");
  await expect(empty).toBeVisible({ timeout: 10_000 });
  await expect(empty).toHaveText("Errore di ricerca. Controlla la connessione.");

  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
