// Script di diagnostica una tantum (Guardiano, job "sito-vero"), non parte
// della suite di test vera e propria: capisce se il 404 nativo di GitHub
// Pages che a volte incontra Playwright viene dal motore di rete di
// Playwright stesso (questo script usa lo stesso client HTTP, "request",
// niente browser) o solo dal browser vero. curl ha già escluso rete,
// IPv4/IPv6 e HTTP/1.1 vs HTTP/2 (vedi guardiano.yml) — qui si guardano
// anche le intestazioni della risposta, per capire quale nodo/cache di
// Fastly l'ha servita quando succede.
import { request } from "@playwright/test";

const URL = "https://mattiacoltelli-source.github.io/CineFighi/";
const INTESTAZIONI_UTILI = ["server", "via", "x-cache", "x-served-by", "age", "cache-control"];

const ctx = await request.newContext();
for (let i = 1; i <= 3; i++) {
  const res = await ctx.get(URL);
  console.log(`tentativo ${i}: HTTP ${res.status()}`);
  const intestazioni = res.headers();
  for (const chiave of INTESTAZIONI_UTILI) {
    if (intestazioni[chiave]) console.log(`  ${chiave}: ${intestazioni[chiave]}`);
  }
}
await ctx.dispose();
