import { test, expect } from "@playwright/test";
import { entra, vaiA, osserva, soloLettura } from "./helpers";

// La pagina Statistiche va dall'alto verso il basso: classifica, generi più
// votati, e in fondo i quattro numeri (visti, watchlist, film, serie).
test("Statistiche: i quattro numeri chiudono la pagina, sotto classifica e generi", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);
  await vaiA(page, "stats");

  const pos = await page.evaluate(() => {
    const top = (s: string) => document.querySelector(s)!.getBoundingClientRect().top + window.scrollY;
    return {
      classifica: top("#classificaSection"),
      generi: top("#genreBars"),
      numeri: top(".stats-strip"),
    };
  });
  expect(pos.generi, "i generi stanno sopra la classifica").toBeGreaterThan(pos.classifica);
  expect(pos.numeri, "i quattro numeri non sono in fondo, sotto i generi").toBeGreaterThan(pos.generi);

  // Ci sono davvero tutti e quattro, con un numero.
  for (const id of ["statSeen", "statWatch", "statMovies", "statSeries"]) {
    await expect(page.locator(`#${id}`)).toHaveText(/^\d+$/);
  }

  expect(guasti, `guasti:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
