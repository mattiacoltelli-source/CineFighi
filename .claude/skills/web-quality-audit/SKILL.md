---
name: web-quality-audit
description: Audit di una web app o PWA con due analisi SEPARATE, UX (esperienza d'uso) e UI (aspetto e coerenza visiva), ciascuna con punteggio 0-10 basato su prove (screenshot, misure, percorsi provati) e confronto con l'audit precedente per scoprire regressioni. Usala quando l'utente chiede di valutare, rivedere o dare un voto a interfaccia, UX, UI, design o usabilità, dopo modifiche al frontend, prima di una release, oppure "controlla che non abbia peggiorato". Non modifica il codice.
---

# Web quality audit: UX e UI, separate e con prove

Obiettivo: dire **quanto è buona** un'interfaccia e **dove ha peggiorato**, con prove che chiunque può rivedere.
Questa skill **non corregge nulla**: produce un rapporto. Le correzioni si fanno solo se l'utente le chiede dopo.

## Principi (non negoziabili)

1. **UX e UI sono due analisi diverse**, con rubriche, punteggi e problemi separati. Non fonderli in un voto solo.
   UX = riesce a fare ciò che vuole? (`references/rubric-ux.md`). UI = sembra curata e coerente? (`references/rubric-ui.md`).
2. **Prima le prove, poi il giudizio.** Nessun punteggio senza almeno una prova citata (screenshot, misura, percorso).
   Se non hai provato un criterio scrivi **n/d**: non inventare e non fare la media con valori a sensazione.
3. **Non giudicare il tuo stesso lavoro con indulgenza.** Se hai appena scritto o modificato il codice, dillo nel
   rapporto e tarati più severo. Se disponibile, fai fare il giudizio UI a un sub-agente nuovo che vede solo screenshot
   e rubrica, non il diff.
4. **Punteggi ancorati**, non ottimisti: 8+ è raro, 10 è quasi mai. Le ancore sono nelle rubriche.
5. **Solo lettura.** Mai scrivere su database o dati reali, mai creare account di prova a mano, mai fare commit.
   Se il progetto ha un `CLAUDE.md` con regole sui dati di test, vale quello.
6. **Rispetta l'identità del progetto.** Se esiste un design system o un'identità visiva, quella è il metro
   (non il tuo gusto). Segnala un problema solo se è coerenza, leggibilità o usabilità: non "farei diverso".

## Procedura

### 0. Ambito
Chiarisci (senza fare troppe domande, scegli un default sensato e dichiaralo): tutta l'app, solo le schermate toccate
dall'ultimo diff (`git diff --stat` e individua le schermate), oppure una schermata indicata. Argomenti accettati:
`/web-quality-audit [url o schermata] [ux|ui|entrambe]` (se mancano, scegli tu un default e dichiaralo).

### 1. Avvia e osserva
- Capisci come gira l'app (README, `package.json`, `CLAUDE.md`); usa un server locale in sola lettura, oppure l'URL pubblicato.
- Elenca i **3–5 compiti principali** dell'utente e le **schermate chiave**. Questo è l'elenco su cui giudicherai.

### 2. Raccogli le prove (in modo ripetibile)
- Esegui `node <cartella-di-questa-skill>/scripts/audit.mjs --url <URL> --out <cartella>`: screenshot a 390 px e 1280 px, tema chiaro e scuro,
  e misure (scroll orizzontale, bersagli < 44 px, testo < 12 px, contrasto, nomi accessibili, LCP/CLS/long task,
  errori in console, richieste fallite). Per arrivare dentro una schermata passa `--steps steps.json`.
  Lo script blocca per default ogni richiesta che non sia GET. Playwright deve essere già installato: non installare nulla.
- Apri gli screenshot con lo strumento di lettura immagini: **guardali davvero**, schermata per schermata.
- Percorri i compiti a mano (Playwright) contando tocchi e passaggi; forza gli stati (vuoto, errore, offline, testo lungo).

### 3. Analisi UX, poi analisi UI
Fai prima una e poi l'altra, ciascuna con la sua rubrica. Per ogni criterio: voto, prova, problema (se c'è).
Applica le regole di taratura delle rubriche (un blocker abbassa il tetto). Classifica ogni problema:
**blocker** (impedisce un compito o perde dati), **major** (attrito forte o rottura visibile), **minor**, **nit**.
Dagli un id stabile (`UX-03`, `UI-07`) e riusa gli id già esistenti nella baseline.

### 4. Regressioni
Cerca una baseline: `docs/quality/audit-baseline.json` o l'ultimo rapporto in `docs/quality/`. Se esiste, confronta
criterio per criterio: scende di ≥ 1 punto = regressione; problemi nuovi = elencali. Se non esiste, dillo e proponi di
salvarla (non scriverla tu senza consenso). Le misure di `audit.json` si confrontano numero contro numero.

### 5. Rapporto
Usa `references/report-template.md`. Regole di forma:
- Breve in cima: i due punteggi, i primi 5 problemi per valore/sforzo, la fiducia nell'audit.
- Ogni problema: dove, come riprodurre, prova (file), correzione proposta, sforzo.
- Sempre "cosa funziona bene" e "non verificato".
- Scrivi in italiano, frasi corte, niente gergo non spiegato.
- Offri (non fare) due passi successivi: salvare il rapporto/baseline, correggere i problemi in ordine.

## Errori da evitare
- Dare 8–9 a tutto perché "funziona" (inflazione): usa le ancore.
- Un voto unico "UI/UX": sono due voti.
- Giudicare solo dal codice o solo dai numeri: servono gli screenshot e il percorso reale.
- Dedurre cosa vedrebbe l'utente su un telefono vero da un browser desktop: dichiara il limite.
- Mescolare sicurezza, SEO, copy, performance profonda: sono audit diversi (vedi "Estensioni").

## Estensioni (audit separati, non dentro questo)
Sicurezza di base, performance approfondita (profilazione, bundle), contenuti/copy, SEO e analytics meritano skill
o sezioni distinte con proprie prove. Qui la performance entra solo come "velocità percepita" (UX criterio 7).
