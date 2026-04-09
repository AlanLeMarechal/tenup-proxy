const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY || null;

// ─── GET /health ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── GET /test-browser ──────────────────────────────────────────────────────
app.get("/test-browser", async (req, res) => {
  try {
    console.log("[test-browser] launching browser...");
    const b = await getBrowser();
    const context = await b.newContext();
    const page = await context.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    const title = await page.title();
    await page.close();
    await context.close();
    console.log("[test-browser] OK, title:", title);
    return res.json({ ok: true, title });
  } catch (err) {
    console.error("[test-browser] ERROR:", err);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// Simple auth middleware
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: true, message: "Unauthorized" });
  next();
});

// Browser singleton — reused across requests
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

// ─── GET /autocomplete?term=... ──────────────────────────────────────────────
app.get("/autocomplete", async (req, res) => {
  const { term } = req.query;
  if (!term || term.length < 2) return res.json({});

  let context, page;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "fr-FR",
      extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    page = await context.newPage();

    // Navigate to TenUp to establish a valid Datadome session
    await page.goto("https://tenup.fft.fr/recherche/tournois", {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });

    // Make the autocomplete fetch from within the browser context (bypasses Datadome)
    const data = await page.evaluate(async (term) => {
      const url = `https://tenup.fft.fr/recherche/autocomplete/clubs/${encodeURIComponent(term)}?term=${encodeURIComponent(term)}`;
      const res = await fetch(url, {
        headers: {
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      return res.json();
    }, term);

    return res.json(data);
  } catch (err) {
    console.error("[autocomplete] ERROR:", err.message);
    return res.status(500).json({ error: true, message: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

// ─── GET /tournois?clubId=...&clubNom=... ────────────────────────────────────
app.get("/tournois", async (req, res) => {
  const { clubId, clubNom } = req.query;
  if (!clubNom) return res.status(400).json({ error: true, message: "clubNom requis" });

  let context, page;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "fr-FR",
      extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    page = await context.newPage();

    // Navigate to establish Datadome session + extract Drupal tokens
    await page.goto("https://tenup.fft.fr/recherche/tournois", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Wait for Drupal form tokens to be present
    await page.waitForSelector('input[name="form_build_id"]', { timeout: 10000 });

    // Extract tokens + submit form from within browser context
    const result = await page.evaluate(async ({ clubId, clubNom }) => {
      // Get Drupal tokens from the page
      const buildIdEl = document.querySelector('input[name="form_build_id"]');
      const tokenEl = document.querySelector('input[name="form_token"]');
      if (!buildIdEl || !tokenEl) return { error: true, message: "Tokens Drupal introuvables", html: document.body.innerHTML.slice(0, 500) };

      const formBuildId = buildIdEl.value;
      const formToken = tokenEl.value;

      // Build dates
      const pad = (n) => String(n).padStart(2, "0");
      const today = new Date();
      const end = new Date(today);
      end.setMonth(end.getMonth() + 3);
      const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;

      const body = new URLSearchParams({
        "recherche_type": "club",
        "club[autocomplete][value_container][value_field]": clubId || "",
        "club[autocomplete][value_container][label_field]": clubNom,
        "pratique": "PADEL",
        "date[start]": fmt(today),
        "date[end]": fmt(end),
        "page": "0",
        "sort": "_DIST_",
        "form_build_id": formBuildId,
        "form_token": formToken,
        "form_id": "recherche_tournois_form",
        "_triggering_element_name": "submit_main",
        "_triggering_element_value": "Rechercher",
      });

      const res = await fetch("https://tenup.fft.fr/system/ajax", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
        },
        body: body.toString(),
      });

      return res.json();
    }, { clubId: clubId || "", clubNom });

    if (result?.error) return res.json({ tournois: [], error: result });

    const ajaxData = Array.isArray(result) ? result : [];
    const cmd = ajaxData.find((c) => c.command === "recherche_tournois_update");
    if (!cmd) return res.json({ tournois: [] });

    const items = cmd.results?.items ?? [];
    const tournois = items.map((t) => ({
      id: String(t.id),
      nom: t.libelle ?? "",
      dateDebut: t.dateDebut?.date?.split(" ")?.[0] ?? "",
      dateFin: t.dateFin?.date?.split(" ")?.[0] ?? "",
      categorie: t.epreuves?.[0]?.typeEpreuve?.code ?? null,
      epreuve: t.epreuves?.[0]?.natureEpreuve?.libelle ?? null,
      surface: t.naturesTerrains?.[0] ?? null,
      installation: t.installation ?? null,
      jugeArbitre: t.jugeArbitre ?? null,
    }));

    return res.json({ tournois });
  } catch (err) {
    console.error("[tournois] ERROR:", err.message);
    return res.status(500).json({ error: true, message: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`tenup-proxy listening on port ${PORT}`);
});
