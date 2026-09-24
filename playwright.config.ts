import { defineConfig, devices } from "@playwright/test";

// Suite di guardia di CineFighi: SOLA LETTURA. Non crea utenti, non vota, non
// scrive niente sul database condiviso del gruppo — carica l'app esattamente
// come farebbe una persona che la apre e la guarda. E' il motivo per cui puo'
// girare in automatico su dati veri senza le cautele che avevano portato a
// sospendere la vecchia suite in qa-agent (quella, prima di ogni run, creava
// un utente "_QA_Agent_" dentro la libreria del gruppo).
//
// Sta dentro questo repo e non in qa-agent apposta: cosi' quando l'app cambia,
// il test si aggiorna nello stesso commit della modifica invece di restare
// indietro in un altro progetto — che e' esattamente come la vecchia suite era
// finita a testare una schermata che non esiste piu'.
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // In CI un solo worker: il server statico dei test locali e' a thread singolo
  // e con due worker insieme produce falsi fallimenti da concorrenza.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    // In locale si punta al server statico, in CI la si sovrascrive col sito
    // vero o con quello servito dal runner.
    baseURL: process.env.CINEFIGHI_URL ?? "http://localhost:8123/",
    ...devices["Pixel 7"],
    // Vie d'uscita per i container di sviluppo, entrambe assenti in CI (dove
    // Playwright scarica il suo browser e la rete e' normale):
    //   CHROMIUM_PATH  - browser gia' installato altrove, per non riscaricarlo
    //   CHROMIUM_ARGS  - argomenti extra, es. il flag che serve dove un proxy
    //                    intercetta il TLS e senza il quale il browser non
    //                    raggiunge Supabase (la lista utenti resta vuota e
    //                    i test falliscono per un motivo che non c'entra
    //                    niente con l'app).
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      ...(process.env.CHROMIUM_ARGS ? { args: process.env.CHROMIUM_ARGS.split(" ") } : {}),
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
