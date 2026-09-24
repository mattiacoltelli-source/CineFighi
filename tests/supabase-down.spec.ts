import { test, expect } from "@playwright/test";
import { soloLettura } from "./helpers";

// Stesso discorso di tmdb-down.spec.ts: portato qui da qa-agent, sospeso per
// CineFighi dal 2026-09-23 (vedi qa-agent/README.md). Non possiamo riusare
// entra(): presuppone che il selettore utenti abbia gia' una lista, che con
// Supabase giu' non arriva mai.
//
// init() (app.js) ha gia' un try/catch dedicato sia su fetchUsers che su
// fetchLibrary, apposta perche' un errore di rete non svuotasse in silenzio
// la libreria condivisa del gruppo (vedi lo storico "Fix toast di successo
// ingannevoli e liste che si svuotano su errore"): qui li mettiamo alla
// prova davvero, con un fallimento vero, non solo letto nel codice.
//
// Cache fredda senza bisogno di pulirla a mano: ogni test riceve gia' un
// browser context nuovo (nessun currentUser salvato), che e' esattamente lo
// scenario "nessuno ha ancora scelto un profilo su questo dispositivo".
test("con Supabase irraggiungibile l'app avvisa dell'errore e propone comunque la scelta utente, invece di restare bloccata", async ({ page }) => {
  const scritture = soloLettura(page);

  await page.route(/supabase\.co/, route => route.abort());
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // init() fa piu' fetch falliti in sequenza (utenti, poi libreria): li
  // verifichiamo entrambi, non solo il primo.
  await expect(
    page.locator(".toast.error .toast__text", { hasText: "Impossibile contattare il server" })
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(".toast.error .toast__text", { hasText: "Impossibile aggiornare la libreria" })
  ).toBeVisible({ timeout: 10_000 });

  // Senza sessione salvata l'app deve proporre la scelta utente invece di
  // restare bloccata sullo splash.
  await expect(page.locator("#userPickerOverlay")).not.toHaveClass(/hidden/);

  expect(scritture, `la suite ha tentato di scrivere:\n${scritture.join("\n")}`).toEqual([]);
});
