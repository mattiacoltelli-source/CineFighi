# Rubrica UI (aspetto e coerenza visiva)

La UI si giudica **guardando gli screenshot** (aprili con lo strumento di lettura immagini), non solo i numeri.
Confronta schermate diverse fra loro: la coerenza si vede solo mettendole una accanto all'altra.
Se il progetto ha un'identità visiva o un design system (CLAUDE.md, token CSS, file di tema), quello è il metro:
valuta la fedeltà **a quello**, non al tuo gusto.

## Criteri (pesi → punteggio UI = media pesata, arrotondata a 0,5)

| # | Criterio | Peso | Che cosa verificare (prova richiesta) |
|---|---|---|---|
| 1 | **Coerenza visiva** | 25% | Stessi componenti = stesso aspetto ovunque (bottoni, card, chip, input). Colori, raggi, ombre da token, non valori sparsi (grep dei valori nel CSS) |
| 2 | **Gerarchia e leggibilità** | 20% | Si capisce in 3 secondi cosa conta di più? Dimensione/peso/colore guidano l'occhio; un solo punto focale per schermata |
| 3 | **Spaziatura e layout** | 15% | Griglia e ritmo regolari, allineamenti, nessun elemento tagliato o sovrapposto, nessuno scroll orizzontale |
| 4 | **Tipografia** | 10% | Max 2 famiglie, scala di misure definita, testo ≥ 12 px, interlinea e lunghezza riga confortevoli |
| 5 | **Colore e contrasto** | 15% | Contrasto AA (4,5:1 testo, 3:1 grande/icone) in chiaro **e** scuro; il colore non è l'unico portatore di significato |
| 6 | **Responsive e temi** | 10% | 360 / 390 / 768 / 1280 px, chiaro e scuro: nessuna rottura, adattamento sensato (non solo "rimpicciolito") |
| 7 | **Movimento e rifinitura** | 5% | Transizioni brevi e utili, nessun salto di layout (CLS), nessun effetto che appesantisce i telefoni medi |

## Ancore e taratura
Stesse ancore della UX (0–3 rotto, 4–5 debole, 6–7 buono, 8–9 molto buono, 10 esemplare).
Penalità automatiche dal rilievo di `audit.mjs`: scroll orizzontale = Spaziatura ≤ 5; contrasto sotto soglia su testo
primario = Colore ≤ 5; tema scuro con testo illeggibile = Responsive e temi ≤ 4.

## Controlli concreti da non saltare
- Una schermata per tipo (lista, dettaglio, form, vuoto, errore, modale, menu) e **tutte** nelle due modalità di tema.
- Il peggior caso: il testo più lungo, l'immagine che manca, il numero più grande.
- Elementi fissi (barre in alto/in basso, toast) che coprono contenuto o si sovrappongono fra loro.
- Cerca nel CSS valori "a occhio" ripetuti (stesso colore scritto in 5 modi, `z-index` fuori scala, `!important`).
