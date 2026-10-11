#!/usr/bin/env node
// Raccolta di PROVE oggettive per l'audit UI/UX di una web app. Non giudica: misura.
// Uso:  node audit.mjs --url http://localhost:8123/ --out ./audit-out [--viewports 390x844,1280x800] [--themes light,dark]
//                      [--steps steps.json] [--allow-writes]
// - Per default è SOLA LETTURA: ogni richiesta di rete che non sia GET/HEAD/OPTIONS viene bloccata e contata.
// - steps.json (opzionale): [{"click":"selettore"},{"wait":500},{"goto":"/percorso"},{"shot":"nome"}] per arrivare in una schermata.
// Service worker bloccati in sola lettura (altrimenti le sue richieste aggirano il blocco). Il contrasto è approssimato:
// ignora sfondi a gradiente/immagine e opacità degli antenati, quindi i falsi positivi vanno verificati nello screenshot.
// Richiede Playwright già installato (non installa nulla).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : (process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const url = arg("url"); if (!url) { console.error("Manca --url"); process.exit(2); }
const out = path.resolve(arg("out", "./audit-out")); fs.mkdirSync(out, { recursive: true });
const viewports = String(arg("viewports", "390x844,1280x800")).split(",").map((s) => { const [w, h] = s.split("x").map(Number); return { w, h: h || 800 }; });
const themes = String(arg("themes", "light,dark")).split(",");
const steps = arg("steps") ? JSON.parse(fs.readFileSync(arg("steps"), "utf8")) : [];
const allowWrites = arg("allow-writes", false) === true;

async function loadPlaywright() {
  const tries = [() => import("playwright"), () => import("@playwright/test")];
  for (const root of [process.cwd(), "/opt/node22/lib/node_modules", "/usr/lib/node_modules", "/usr/local/lib/node_modules"]) {
    tries.push(() => import(createRequire(path.join(root, "x.js")).resolve("playwright")));
  }
  for (const t of tries) { try { const m = await t(); if (m.chromium) return m; if (m.default?.chromium) return m.default; } catch {} }
  throw new Error("Playwright non trovato: installalo nel progetto (non lo faccio io).");
}

// Eseguito DENTRO la pagina: misure sul DOM visibile.
function inPage() {
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05; };
  const sel = (e) => { if (e.id) return "#" + e.id; const c = [...e.classList].slice(0, 2).join("."); return e.tagName.toLowerCase() + (c ? "." + c : ""); };
  const rgba = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (e) => { let n = e; while (n) { const c = rgba(getComputedStyle(n).backgroundColor); if (c && c.a > 0.95) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const res = { tapSmall: [], fontTiny: 0, fontTinyEx: [], contrast: [], noName: [], imgNoAlt: 0, overflowX: document.documentElement.scrollWidth > innerWidth + 1, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, dom: document.querySelectorAll("*").length, headings: [], landmarks: {}, viewportMeta: !!document.querySelector('meta[name=viewport]'), lang: document.documentElement.lang || "" };
  for (const e of document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=tab],[tabindex]:not([tabindex='-1'])")) {
    if (!vis(e)) continue; const r = e.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) res.tapSmall.push({ el: sel(e), w: Math.round(r.width), h: Math.round(r.height) });
    const name = (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || e.innerText || e.getAttribute("title") || e.value || e.getAttribute("alt") || "").trim();
    const hasLabel = e.labels && e.labels.length;
    if (!name && !hasLabel && !e.querySelector("img[alt]:not([alt=''])")) res.noName.push(sel(e));
  }
  res.tapSmallCount = res.tapSmall.length; res.tapSmall = res.tapSmall.slice(0, 15); res.noNameCount = res.noName.length; res.noName = res.noName.slice(0, 10);
  const seen = new Set();
  for (const e of document.querySelectorAll("body *")) {
    if (!vis(e)) continue;
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1); if (!own) continue;
    const s = getComputedStyle(e), px = parseFloat(s.fontSize);
    if (px < 12) { res.fontTiny++; if (res.fontTinyEx.length < 8) res.fontTinyEx.push({ el: sel(e), px }); }
    const fg = rgba(s.color), bg = bgOf(e); if (!fg) continue;
    const eff = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const big = px >= 24 || (px >= 18.66 && +s.fontWeight >= 700), need = big ? 3 : 4.5, c = ratio(eff, bg), key = sel(e) + Math.round(c * 10);
    if (c < need && !seen.has(key)) { seen.add(key); res.contrast.push({ el: sel(e), ratio: +c.toFixed(2), need, px }); }
  }
  res.contrastCount = res.contrast.length; res.contrast = res.contrast.slice(0, 15);
  res.imgNoAlt = [...document.querySelectorAll("img")].filter((i) => vis(i) && !i.hasAttribute("alt")).length;
  res.headings = [...document.querySelectorAll("h1,h2,h3")].filter(vis).slice(0, 12).map((h) => h.tagName + ": " + h.innerText.trim().slice(0, 40));
  for (const l of ["main", "nav", "header", "footer"]) res.landmarks[l] = document.querySelectorAll(l + ",[role=" + l.replace("header", "banner").replace("footer", "contentinfo").replace("nav", "navigation") + "]").length;
  return res;
}

const pw = await loadPlaywright();
const browser = await pw.chromium.launch();
const report = { url, date: new Date().toISOString(), readOnly: !allowWrites, runs: [] };
for (const vp of viewports) for (const theme of themes) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme, deviceScaleFactor: 2, hasTouch: vp.w < 700, isMobile: vp.w < 700, serviceWorkers: allowWrites ? "allow" : "block" });
  const page = await ctx.newPage(); const run = { viewport: `${vp.w}x${vp.h}`, theme, console: [], pageErrors: [], failedRequests: [], blockedWrites: [], shots: [] };
  page.on("console", (m) => { if (m.type() === "error") run.console.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => run.pageErrors.push(String(e).slice(0, 200)));
  page.on("requestfailed", (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText || "")) run.failedRequests.push(r.url().slice(0, 120)); });
  if (!allowWrites) await page.route("**/*", (route) => { const m = route.request().method(); if (["GET", "HEAD", "OPTIONS"].includes(m)) return route.continue(); run.blockedWrites.push(m + " " + route.request().url().slice(0, 100)); return route.abort(); });
  await page.addInitScript(() => {
    window.__q = { lcp: 0, cls: 0, long: 0, longMs: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__q.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__q.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__q.long++; window.__q.longMs += e.duration; } }).observe({ type: "longtask", buffered: true });
  });
  const base = `${vp.w}x${vp.h}-${theme}`;
  try {
    await page.goto(url, { waitUntil: "load", timeout: 45000 }); await page.waitForTimeout(800);
    run.stepErrors = [];
    for (const [i, st] of steps.entries()) {
      try {
        if (st.goto) await page.goto(new URL(st.goto, url).href, { waitUntil: "load" });
        if (st.click) await page.locator(st.click).first().click({ timeout: 8000 });
        if (st.wait) await page.waitForTimeout(st.wait);
      } catch (e) { run.stepErrors.push(`passo ${i + 1} ${JSON.stringify(st)}: ${String(e).slice(0, 120)}`); }
      if (st.shot) { const f = `${base}-${st.shot}.png`; await page.screenshot({ path: path.join(out, f), fullPage: true }); run.shots.push(f); run["m_" + st.shot] = await page.evaluate(inPage); }
    }
    const f = `${base}.png`; await page.screenshot({ path: path.join(out, f), fullPage: true }); run.shots.push(f);
    run.metrics = await page.evaluate(inPage);
    run.perf = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { ...window.__q, lcp: Math.round(window.__q.lcp), cls: +window.__q.cls.toFixed(3), longMs: Math.round(window.__q.longMs), domContentLoaded: Math.round(n?.domContentLoadedEventEnd || 0), load: Math.round(n?.loadEventEnd || 0), transferKB: Math.round((performance.getEntriesByType("resource").reduce((a, r) => a + (r.transferSize || 0), 0) + (n?.transferSize || 0)) / 1024) }; });
  } catch (e) { run.error = String(e).slice(0, 300); }
  report.runs.push(run); await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(out, "audit.json"), JSON.stringify(report, null, 1));
for (const r of report.runs) {
  const m = r.metrics || {}, p = r.perf || {};
  console.log(`[${r.viewport} ${r.theme}] overflowX=${m.overflowX} tap<44=${m.tapSmallCount} font<12=${m.fontTiny} contrasto=${m.contrastCount} senzaNome=${m.noNameCount} imgSenzaAlt=${m.imgNoAlt} | LCP=${p.lcp}ms CLS=${p.cls} longtask=${p.long}(${p.longMs}ms) peso=${p.transferKB}KB | errori console=${r.console.length + r.pageErrors.length} richieste fallite=${r.failedRequests.length} scritture bloccate=${r.blockedWrites.length} passi falliti=${(r.stepErrors || []).length}${r.error ? " ERRORE: " + r.error : ""}`);
}
console.log("Output in", out);
