import { test, expect } from "@playwright/test";
import { entra, vaiA, SCHERMATE, tuttoRaggiungibile, nienteOverflowOrizzontale, osserva, soloLettura } from "./helpers";

// Questi test non sanno niente di cosa fa l'app: controllano solo che regga.
// E' una scelta — significa che continuano a valere dopo un redesign, e che
// NON vanno aggiornati quando cambia una stringa, un colore o un'altezza.
// Il prezzo: sanno dire "e' rotto", non "e' sbagliato".

test("l'app si apre e ogni schermata mostra qualcosa, senza guasti", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);

  for (const schermata of SCHERMATE) {
    await vaiA(page, schermata);

    const visibile = await page.evaluate(() => {
      const s = [...document.querySelectorAll("section")].find(x => !x.classList.contains("hidden"));
      return { c: (s?.textContent ?? "").trim().length, r: (s?.getBoundingClientRect().height ?? 0) };
    });
    expect(visibile.c, `la schermata "${schermata}" e' vuota`).toBeGreaterThan(0);
    expect(visibile.r, `la schermata "${schermata}" non occupa spazio`).toBeGreaterThan(0);

    const orizz = await nienteOverflowOrizzontale(page);
    expect(orizz.ok, `"${schermata}" scorre in orizzontale (${orizz.dettaglio})`).toBe(true);

    const raggiungibile = await tuttoRaggiungibile(page);
    expect(raggiungibile.ok, `su "${schermata}" del contenuto resta irraggiungibile (${raggiungibile.dettaglio})`).toBe(true);
  }

  expect(guasti, `guasti durante il giro delle schermate:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di SCRIVERE sul database del gruppo:\n${scritture.join("\n")}`).toEqual([]);
});

test("aprire la scheda di un titolo non rompe niente", async ({ page }) => {
  const guasti = osserva(page);
  const scritture = soloLettura(page);
  await entra(page);

  // Il primo titolo che la Home propone, qualunque sia.
  const card = page.locator(".shelf-card, .list-item").first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.click();
  await page.waitForTimeout(700);

  const scheda = await page.evaluate(() => {
    const s = [...document.querySelectorAll("section")].find(x => !x.classList.contains("hidden"));
    return { id: s?.id ?? "", testo: (s?.textContent ?? "").trim().length };
  });
  expect(scheda.testo, "la scheda del titolo e' vuota").toBeGreaterThan(0);

  const orizz = await nienteOverflowOrizzontale(page);
  expect(orizz.ok, `la scheda scorre in orizzontale (${orizz.dettaglio})`).toBe(true);

  expect(guasti, `guasti aprendo una scheda:\n${guasti.join("\n")}`).toEqual([]);
  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
