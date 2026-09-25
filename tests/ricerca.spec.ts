import { test, expect } from "@playwright/test";
import { entra, osserva, soloLettura } from "./helpers";

// La ricerca (TMDB) e' una delle azioni piu' frequenti dell'app — aggiungere
// un titolo comincia sempre da qui — ma non aveva nessuna copertura, nemmeno
// indiretta. Sola lettura: cerca un titolo vero e famoso (che non sparira'
// mai da TMDB) e controlla che i risultati arrivino, mai un click su
// "aggiungi"/"visto" (quelli scrivono sul database del gruppo).

test("cercare un film vero mostra risultati con locandina", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);

  const input = page.locator("#searchInput");
  await input.fill("Il Padrino");
  await input.press("Enter");

  const risultati = page.locator("#resultsSection:not(.hidden) .poster-card");
  await risultati.first().waitFor({ state: "visible", timeout: 15_000 });

  const conta = await risultati.count();
  expect(conta, "nessun risultato per una ricerca che dovrebbe averne").toBeGreaterThan(0);

  const primaCard = await risultati.first().evaluate(el => ({
    titolo: el.querySelector(".poster-card__title")?.textContent?.trim() ?? "",
    locandina: (el.querySelector(".poster-card__img") as HTMLElement | null)?.style.backgroundImage ?? "",
  }));
  expect(primaCard.titolo.length, "il primo risultato non ha un titolo").toBeGreaterThan(0);
  expect(primaCard.locandina, "il primo risultato non ha una locandina").toContain("image.tmdb.org");

  // Svuotare la ricerca deve far sparire i risultati, non lasciarli a metà.
  await page.locator("#searchClearBtn").click();
  await expect(page.locator("#resultsSection")).toHaveClass(/hidden/);

  expect(guasti, `guasti cercando un titolo:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});

test("cercare un titolo inesistente mostra il messaggio vuoto, non resta bloccata", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);

  const input = page.locator("#searchInput");
  // Stringa senza senso, non dovrebbe matchare nulla su TMDB.
  await input.fill("xzqwkvbjplmnasdfghjklqwertyuiop123456789");
  await input.press("Enter");

  // "Ricerca in corso..." e' visibile anche subito dopo l'invio: si aspetta
  // il testo finale, non solo la visibilita' del box.
  await expect(page.locator("#resultsEmpty")).toHaveText("Nessun risultato trovato.", { timeout: 15_000 });
  const vuoti = await page.locator("#results .poster-card").count();
  expect(vuoti, "risultati mostrati per una query senza senso").toBe(0);

  expect(guasti, `guasti su ricerca vuota:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
