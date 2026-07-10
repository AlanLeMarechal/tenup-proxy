const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.PROXY_API_KEY || null;

const TENUP_API = "https://tenup.fft.fr/back/public/v1";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const jsonHeaders = {
  "User-Agent": UA,
  "Accept": "application/json",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

// ─── Indisponibilité TenUp (file d'attente Queue-it / surcharge / 5xx) ───────
// TenUp place ponctuellement un salon d'attente Queue-it devant le site (pics
// de trafic). Dans ce cas la requête est redirigée vers queue-it.net et répond
// du HTML au lieu du JSON attendu. On renvoie une erreur stable que le
// back-office mappe sur un message JA du type « Service indisponible ».
class TenupUnavailableError extends Error {}

function serviceUnavailable(res) {
  return res.status(503).json({
    error: true,
    code: "TENUP_UNAVAILABLE",
    message: "Service indisponible pour le moment",
  });
}

function handleError(res, scope, err) {
  console.error(`[${scope}] ERROR:`, err.message);
  if (err instanceof TenupUnavailableError) return serviceUnavailable(res);
  return res.status(500).json({ error: true, message: err.message });
}

async function tenupFetch(path, init = {}) {
  let res;
  try {
    res = await fetch(`${TENUP_API}${path}`, { ...init, headers: { ...jsonHeaders, ...init.headers } });
  } catch (err) {
    throw new TenupUnavailableError(`TenUp injoignable sur ${path} : ${err.message}`);
  }

  if (res.url.includes("queue-it.net") || res.status >= 500) {
    throw new TenupUnavailableError(`TenUp indisponible sur ${path} (${res.status})`);
  }
  if (!res.ok) throw new Error(`TenUp ${res.status} sur ${path}`);

  // Une réponse HTML signale une redirection vers la file ou une page d'erreur.
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new TenupUnavailableError(`TenUp a répondu ${type || "sans type"} sur ${path}`);
  }
  return res.json();
}

const tenupGet = (path) => tenupFetch(path);

const tenupPost = (path, body) =>
  tenupFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const searchClubs = (query) =>
  tenupPost("/clubs/recherche", { query, pratique: "PADEL", from: 0, size: 10 });

// ─── GET /health ────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// Simple auth middleware
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: true, message: "Unauthorized" });
  next();
});

// ─── GET /autocomplete?term=... ──────────────────────────────────────────────
// Contrat de sortie conservé : { "<codeClub>": "<nom>" }
app.get("/autocomplete", async (req, res) => {
  const { term } = req.query;
  if (!term || term.length < 2) return res.json({});

  try {
    const data = await searchClubs(term);
    const out = {};
    for (const club of data.clubs ?? []) out[club.code] = club.nom;
    return res.json(out);
  } catch (err) {
    return handleError(res, "autocomplete", err);
  }
});

// ─── GET /tournois?clubId=...&clubNom=... ────────────────────────────────────
app.get("/tournois", async (req, res) => {
  const { clubId, clubNom } = req.query;
  if (!clubNom && !clubId) return res.status(400).json({ error: true, message: "clubNom ou clubId requis" });

  try {
    // Le code club est la clé d'entrée ; on le résout par le nom si absent.
    let codeClub = clubId;
    if (!codeClub) {
      const search = await searchClubs(clubNom);
      const match =
        (search.clubs ?? []).find(
          (c) => c.nom.trim().toUpperCase() === String(clubNom).trim().toUpperCase()
        ) ?? (search.clubs ?? [])[0];
      if (!match) return res.json({ tournois: [] });
      codeClub = match.code;
    }

    const liste = await tenupGet(`/clubs/${encodeURIComponent(codeClub)}/tournois`);
    const padel = (liste.tournois ?? []).filter((t) => t.pratique?.code === "PADEL");

    // categorie (P250), ville, nomClub et jugeArbitre ne sont que sur la fiche.
    const fiches = await Promise.all(
      padel.map((t) =>
        tenupGet(`/tournois/${encodeURIComponent(t.id)}/fiche-tournoi`).catch((err) => {
          console.error(`[tournois] fiche ${t.id} KO:`, err.message);
          return null;
        })
      )
    );

    const tournois = padel.map((t, i) => {
      const fiche = fiches[i];
      const epreuve = fiche?.epreuves?.[0] ?? null;
      const ja = fiche?.tournoi?.jugeArbitre ?? null;

      return {
        id: String(t.id),
        code: null,
        nom: t.nom ?? "",
        dateDebut: t.dateDebut ?? "",
        dateFin: t.dateFin ?? "",
        categorie: epreuve?.categorie ?? null,
        epreuve: t.epreuves?.[0]?.natureEpreuve?.libelle ?? null,
        surface: null,
        nomClub: fiche?.tournoi?.club?.nom ?? null,
        ville: fiche?.tournoi?.ville ?? null,
        jugeArbitre: ja ? { id: ja.idCrm, nom: ja.nom, prenom: ja.prenom } : null,
      };
    });

    return res.json({ tournois });
  } catch (err) {
    return handleError(res, "tournois", err);
  }
});

app.listen(PORT, () => {
  console.log(`tenup-proxy listening on port ${PORT}`);
});
