# Rubrica UX (esperienza d'uso)

La UX si giudica **sui compiti dell'utente**, non sullo "stile". Prima di dare punteggi elenca 3–5 compiti
principali dell'app (es. "aggiungo un film", "do un voto", "trovo cosa guardare") e percorrili davvero,
contando passaggi e tocchi. Un criterio senza prove vale "n/d", mai un numero a sensazione.

## Criteri (pesi → punteggio UX = media pesata, arrotondata a 0,5)

| # | Criterio | Peso | Che cosa verificare (prova richiesta) |
|---|---|---|---|
| 1 | **Riuscita dei compiti** | 25% | Ogni compito si completa? Quanti tocchi/passaggi? Dove ci si perde? (percorso + screenshot dei passaggi) |
| 2 | **Chiarezza e orientamento** | 15% | Si capisce dove si è, cosa si può fare, cosa succede dopo? Etichette, titoli, navigazione, azione primaria evidente |
| 3 | **Feedback e stati** | 15% | Caricamento, vuoto, errore, successo, offline: esistono e dicono cosa fare? (forza ciascuno e fotografalo) |
| 4 | **Prevenzione e recupero errori** | 10% | Azioni distruttive con conferma/annulla, input validati, messaggi che spiegano come rimediare |
| 5 | **Ergonomia mobile** | 15% | Bersagli ≥ 44 px, azioni a portata di pollice, gesti non in conflitto con lo scroll, tastiera che non copre i campi, safe-area |
| 6 | **Accessibilità** | 10% | Nomi accessibili, ordine del focus, contrasto, zoom 200%, `prefers-reduced-motion`, lingua dichiarata |
| 7 | **Velocità percepita** | 10% | LCP, CLS, long task, scatti nelle animazioni, lavoro inutile al caricamento (dal rilievo di `audit.mjs`) |

## Ancore del punteggio (valgono per ogni criterio)

- **0–3** rotto: l'utente non riesce o abbandona. Un blocco totale di un compito primario = max 3.
- **4–5** debole: si riesce, ma con attrito evidente o errori ricorrenti.
- **6–7** buono: funziona, piccoli attriti.
- **8–9** molto buono: scorrevole, stati curati, nessun attrito rilevato nei compiti provati.
- **10** esemplare: riservato a un caso che confronteresti con le migliori app del settore. Non darlo "perché funziona".

Regole di taratura: un solo **blocker** (compito primario impossibile, perdita di dati, crash) porta il criterio
a ≤ 4 e la UX complessiva a ≤ 6. Se non hai provato un criterio, scrivi **n/d** e non entra nella media.

## Controlli concreti da non saltare

- Primo avvio e utente nuovo (nessun dato, nessun profilo).
- Stati forzati: rete assente, API che risponde 500, lista vuota, lista lunghissima, testo molto lungo, nome molto lungo.
- Ripetizione: doppio tocco su un'azione che scrive, back del browser, ricarica a metà flusso.
- Tastiera: Tab attraverso le schermate principali; il focus è visibile e nell'ordine giusto.
- PWA/mobile: orientamento, barra del browser che compare/scompare, notch, app installata vs browser.
