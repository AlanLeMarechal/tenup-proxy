const express = require("express");
const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

chromium.use(StealthPlugin());

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY || null;

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

// ─── GET /health ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── GET /autocomplete?term=... ──────────────────────────────────────────────
app.get("/autocomplete", async (req, res) => {
  const { term } = req.query;
  if (!term || term.length < 2) return res.json({});

  let context, page;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "fr-FR",
      extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    page = await context.newPage();

    // Intercept the autocomplete AJAX response
    let captured = null;
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/recherche/autocomplete/clubs/")) {
        try {
          captured = await response.json();
        } catch {}
      }
    });

    await page.goto("https://tenup.fft.fr/recherche/tournois", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Type in the club field to trigger autocomplete
    const clubInput = await page.locator('input[data-drupal-selector="edit-club-autocomplete-value-container-label-field"]').first();
    await clubInput.fill(term);

    // Wait for the AJAX request to fire and be captured (up to 5s)
    await page.waitForTimeout(2000);

    if (!captured) {
      // Fallback: try to read suggestions from DOM
      const items = await page.locator(".ui-autocomplete .ui-menu-item").allTextContents();
      return res.json(Object.fromEntries(items.map((t, i) => [String(i), t])));
    }

    return res.json(captured);
  } catch (err) {
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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "fr-FR",
      extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" },
    });
    page = await context.newPage();

    // Intercept the AJAX search response
    let captured = null;
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/system/ajax")) {
        try {
          const json = await response.json();
          const cmd = Array.isArray(json)
            ? json.find((c) => c.command === "recherche_tournois_update")
            : null;
          if (cmd) captured = cmd;
        } catch {}
      }
    });

    await page.goto("https://tenup.fft.fr/recherche/tournois", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });

    // Switch to club search mode
    const clubRadio = page.locator('input[value="club"]');
    if (await clubRadio.count() > 0) {
      await clubRadio.click();
      await page.waitForTimeout(500);
    }

    // Fill club field
    const clubInput = page.locator('input[data-drupal-selector="edit-club-autocomplete-value-container-label-field"]').first();
    await clubInput.fill(clubNom);
    await page.waitForTimeout(1500);

    // Select first autocomplete suggestion if available
    const firstSuggestion = page.locator(".ui-autocomplete .ui-menu-item").first();
    if (await firstSuggestion.count() > 0) {
      await firstSuggestion.click();
      await page.waitForTimeout(500);
    }

    // Set sport to PADEL
    const padelOption = page.locator('select[name="pratique"] option[value="PADEL"]');
    if (await padelOption.count() > 0) {
      await page.selectOption('select[name="pratique"]', "PADEL");
    }

    // Submit
    const submitBtn = page.locator('input[data-drupal-selector="edit-submit-main"], button[data-drupal-selector="edit-submit-main"]').first();
    await submitBtn.click();

    // Wait for AJAX response
    await page.waitForTimeout(4000);

    if (!captured) {
      return res.json({ tournois: [] });
    }

    const items = captured.results?.items ?? [];
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
    return res.status(500).json({ error: true, message: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`tenup-proxy listening on port ${PORT}`);
});
