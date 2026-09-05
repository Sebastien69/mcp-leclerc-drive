# Leclerc Drive — Reverse-engineered API (validated 2026-06-13)

Captured live against store **053701** (La Ville-aux-Dames) on host
`fd9-courses.leclercdrive.fr`. All endpoints below were observed AND replayed
successfully from the page context with `credentials: 'include'` (cookies,
incl. DataDome, replayed).

> Path note: the store path is `magasin-{id}-{id}` for the API (e.g.
> `magasin-053701-053701`). The trailing `-La-Ville-aux-Dames` slug appears in
> the HTML page URLs but is **cosmetic** — the backend keys off the id.

## 0. Auth / anti-bot

- ✅ **v0.3 (current): requests run inside a real Chrome via CDP** (see
  `src/browser.ts`), so they carry the browser's cookies + TLS fingerprint +
  solved DataDome challenge. This is the only approach that survives DataDome's
  *active* mode. The cookie-replay notes below document the earlier (v0.1–0.2)
  approach and why it was abandoned.
- ⚠️⚠️ **DataDome escalates to "active" mode and then cookie-replay is dead.**
  After enough automated traffic (and it hits real end users too), DataDome stops
  accepting the cookie alone and requires the JS challenge to be executed. Then a
  Node `fetch` gets **403 even with a fresh, browser-valid `datadome` cookie and
  a changed IP**, while the real browser still loads fine. Not recoverable by
  refreshing Chrome. → v0.3 fixes this by *being* a real browser.
- [v0.1–0.2, superseded] Session was cookie-based: replay the full `Cookie`
  header from a logged-in browser.
- ⚠️ **DataDome** bot protection is active (`api-js.datadome.co/js/`). A
  `datadome` cookie is part of the session and **must** be replayed, or requests
  will be challenged. Confirmed: a cold Node `fetch` (no cookies) gets **HTTP
  403** with a DataDome challenge; replaying the browser cookies (incl.
  `datadome`) returns the real **HTTP 200** page. This is the main fragility of
  the cookie-replay approach.
- The MCP reads these cookies straight from the local Chrome profile
  (`chrome-cookies-secure`), so no manual copy-paste is needed — see
  `src/auth/cookies.ts`.
- ⚠️ **Bursts get struck.** Observed live: firing ~5 cart mutations in parallel
  immediately triggered DataDome — both writes *and* subsequent reads returned
  403 for that client, while the real browser session stayed fine. Recovery:
  refresh Leclerc Drive in Chrome (re-issues a valid `datadome` cookie). The
  client now serializes + spaces out + retries all requests to avoid this — see
  `src/leclerc/throttle.ts`. Keep a human-like cadence; don't parallelize.
- Mutating requests send header `X-Requested-With: XMLHttpRequest` and
  `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.

- ⚠️ **Long sequential runs get struck too (2026-09-05).** With the v0.3 CDP
  approach and the 1 s + jitter cadence, a single run of ~400 page loads
  (200 searches + product sheets of ~480 KB) hit HTTP 403 after ~200 sheets;
  every later request in that run failed (4 attempts each), ~55 min wasted.
  Keep a run under ~200 requests, prefer small EAN budgets (≤ 50) spread over
  sessions, and stop at the first 403 (the importer now does).

## 1. search_product — `GET .../recherche.aspx?TexteRecherche={query}`

- Server-rendered HTML (ASP.NET). **No separate search XHR.**
- Needs the session cookie (DataDome blocks anonymous fetches), but no account
  is required beyond a valid browser session.
- In the **raw HTML**, products are passed to widget init calls as
  `Utilitaires.widget.initOptions('..._pnlElementProduit', {"objContenu":{"lstElements":[{"objElement":{ ...iIdProduit... }}]}})`.
  (The `_objDataSourceGroupeTrieFiltre` name only exists as a client-side global
  built from this — don't key off it server-side.) The client extracts products
  by scanning the HTML for the smallest JSON object enclosing each `iIdProduit`
  (= `objElement`, pure JSON). Validated live: `search("café")` → 200 products.
  Each product object exposes:

  | Field | Meaning |
  | --- | --- |
  | `iIdProduit` | **product id** (used for all cart ops), e.g. `2612` |
  | `sLibelleLigne1`, `sLibelleLigne2` | label (2 lines) |
  | `nrPVUnitaireTTC` / `sPrixUnitaire` | unit price (numeric / formatted) |
  | `sPrixPromo` | promo price when applicable |
  | `nrPVParUniteDeMesureTTC` / `sPrixParUniteDeMesure` | price per L/kg |
  | `iQteDisponible` | stock available (0 → unavailable) |
  | `iQuantitePanier` | quantity currently in cart |
  | `sUrlVignetteProduit` | thumbnail URL |
  | `iIdRayon`, `iIdFamille`, `niIdSousFamille` | category ids |

- Product images also load from
  `fd9-photos.leclercdrive.fr/image.ashx?id={photoId}&use=l&cat=p` and
  Nutri-Score from `...&use=nsc` (note: photo id ≠ `iIdProduit`).

## 2. add / update / remove — `POST .../panier.aspx?op=1`

Single endpoint for all cart mutations. `op=1` constant.

- **Body**: `d=<URL-encoded JSON>` (one form field named `d`).
- **JSON payload**:

  ```json
  {
    "eTypeAction": 1,
    "iIdProduit": "2612",
    "iQuantite": 2,
    "sNoPointLivraison": "053701",
    "objContexteProvenanceArticle": {
      "eOrigine": 4, "eTypePage": 3,
      "sTexteRecherche": "lait", "eVue": 0,
      "sInformationsComplementaires": "uni-2"
    }
  }
  ```

  - `eTypeAction`: **1** = add / increase, **2** = decrease / remove.
  - `iQuantite`: the **new absolute target quantity** (NOT a delta).
  - **Remove** = `eTypeAction: 2`, `iQuantite: 0`. ✅ validated (cart went to 0).
  - `objContexteProvenanceArticle` is analytics context and is **optional** —
    removals succeeded without it.

- **Response**: JSON array of events. Relevant ones, keyed by `sIdUnique`:
  - `Produit{id}` (`eTypeEvenement` 101/103/104): per-line state —
    `iQuantitePanier`, `rTotalAPayer`/`sTotalAPayer` (line total).
  - `Rayon{id}` (503): aisle rollup.
  - **`Panier{store}` (`eTypeEvenement` 1): cart grand total** —
    `iQuantitePanier` (total items), `rTotalAPayer`/`sTotalAPayer`,
    `sTotalHorsReductions`, `sMontantEconomies`, `fQuantiteDisponibleDepassee`.

  → Read the `Panier{store}` event for the authoritative cart total after any op.

## 3. get_cart

- `GET .../panier.aspx` (no `op`) → **404**. There is no plain cart page at that
  path.
- Instead, **every store page embeds the cart** in the "Panier" context:
  - `"lstProduits":[ {full product records} ]` — full `objElement`s with labels,
    `iQuantitePanier`, and per-line `rTotalAPayer`/`sTotalAPayer`.
  - `"lstProduitsLight":[ {"iIdProduit","iQtePanier","rTotalAPayer",...} ]` —
    a lightweight summary (no labels), immediately followed by the cart totals
    `"iQuantitePanier"`, `"sTotalHorsReductions"`, **`"sTotalAPayer"`** (grand total).
- Implementation (validated live): fetch `recherche.aspx?TexteRecherche=<no-match
  token>` so the page carries only cart records, extract the `lstProduits` array
  (exact key, so it doesn't match `lstProduitsLight`), map each record, and read
  the grand total from the `sTotalAPayer` next to `lstProduitsLight`.
- Note: cart line records use `iQuantitePanier` (full list) / `iQtePanier`
  (light list) — the client accepts either.

## 4. Store locator (find_stores) — `api-recherchemagasins.leclercdrive.fr`

A clean JSON REST API (separate from the ASP.NET store sites), validated live
2026-06-13. Behind DataDome like the rest — replay the Chrome cookie (the
`datadome` cookie on `.leclercdrive.fr` covers this subdomain). Base:
`https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1`.

Three chained calls:

1. `GET /autocomplete?search={postal|city}&provider=Woosmap`
   → `{ postalCodes: [ { id, postalCode, city } ], pointsLivraisonParNom, ... }`.
   Take `postalCodes[0].id` (an opaque Woosmap token).
2. `GET /autocomplete/coordinates?id={id}&provider=Woosmap`
   → `{ latitude, longitude }` for the place.
3. `GET /MapPoint/nearby?latitude={lat}&longitude={lng}&postalCode={cp}`
   → `{ points: [ store, ... ] }`, nearest first.

Each `point` carries: `name`, **`noPL`** (store id, zero-padded string),
**`noPR`** (retrieval point; == noPL for drives), `serviceType`
(`drive` / `relais` / `livraison`), `distance` (km), `postalCode`,
`coordinates {latitude, longitude}`, and **`urlSiteCourse` / `urlBase`** — the
store's shopping host (e.g. `fd8`/`fd9`/`fd14-courses.leclercdrive.fr`, **varies
per store**). The client maps these into the active `StoreSelection`
(see `src/store.ts`, `src/leclerc/locator.ts`).

⚠️ **Session is bound to one drive.** Shopping (search/cart) only works against
the drive the Chrome session is currently logged into. `set_store` to a store the
browser isn't on yields a "session expirée" page. Replaying Leclerc's
"switch drive" call to rebind the session server-side is an open item (would let
set_store switch to any drive) — see below.

## Open items / to refine

- Confirm `objContexteProvenanceArticle` can be fully omitted on **add** (only
  verified omittable on remove).
- Find a clean read-only cart endpoint if one exists (avoid HTML scrape).
- DataDome cookie lifetime / refresh behaviour for long-lived sessions.
- **Reverse-engineer the "switch drive" call** so `set_store` can rebind the
  session to any drive server-side (today it must match the browser's drive).
- Checkout / slot-booking flow (out of scope).

---

# Addendum 2026-09-05 — a second store (cluster `fd5`), fork Sebastien69

Captured live from a logged-in Chrome session (DevTools + in-page inspection).
Store host `fd5-courses.leclercdrive.fr`; the customer area lives on a
**separate host**, `fd5-espace-client.leclercdrive.fr`.

## 5. Product record contract (search + produits-habituels) — re-validated

Same `objElement` records as §1, ~200 per search page (`lait` → 206 records,
204 unique). Fields confirmed present on **every** record (206/206):

| Field | Observed | Use |
| --- | --- | --- |
| `nrPVUnitaireTTC` / `sPrixUnitaire` | `6.3` / `"6,30 €"` | unit price |
| `sPrixPromo` | `"0,00 €"` when no promo | promo price (>0 ⇒ promo) |
| `nrPVParUniteDeMesureTTC` / `sPrixParUniteDeMesure` | `1.05` / `"1,05 € / l"` | **numeric** price per unit — sort on it |
| `sUniteMesureTotale` | `"l"`, `"kg"` | unit of the per-unit price |
| `nrContenanceTotale`, `nrContenanceUnitaire`, `sUniteMesure` | `6`, `1`, `"L"` | pack content |
| `eDisponibilite` | `0` orderable, `1` unavailable | availability (with `iQteDisponible`) |
| `iQteDisponible` | `100`, `0` when unavailable | stock |
| `iQteMaxPanier`, `iQteMinPanier`, `iQuantitePanier` | | cart limits / current qty |
| `iIdRayon`, `iIdFamille`, `niIdSousFamille` | `284320`, `284370` | category ids (substitution scope) |
| `sUrlPageProduit`, `sUrlVignetteProduit` | | product sheet / thumbnail |
| `fProduitSubstitution`, `sUrlRemplacerProduit` | `true` on unavailable items | "Produits similaires" page |
| `objAvisClient` `{IdProduit, Note, NbAvis}` | | ratings |
| `sPrixPromoParUniteDeMesure` | rare (2/206) | promo price per unit |
| `neTypeLotBrii`, `nrPVBRIIDeduit`, `nfBriiDispo` | ~10 % of records | "bon de réduction immédiat" lots |

**Not present in list pages**: `sLibelleMarque`, `sNutriScore`, `sCodeEAN`,
`sComposition`, `fProduitEpuise`. Brand/EAN/ingredients only exist on the
product sheet (`sUrlPageProduit`) — one extra page load per product, so fetch
lazily and cache (see CLAUDE.md, EAN section). `fProduitEpuise` (from ncleton's
contract) was never observed; the mapper honours it if it ever appears.

Availability rule (validated on 267 + 206 records): `eDisponibilite === 0 &&
iQteDisponible > 0`. All unavailable items were exactly `1 / 0`.

## 6. "Mes produits habituels" — `GET .../produits-habituels.aspx`

`https://{host}/magasin-{id}-{id}-{slug}/produits-habituels.aspx` on the
**courses** host. Leclerc's own aggregated "already ordered" page:

- **Single page, no pagination**: 267 unique products (~2.7 MB HTML) in the same
  `objElement` format, inside widget `..._pnlElementProduitHabituels`, grouped by
  aisle (`sLibelleRayon`, `lstEnfants`). `scanProductRecords()` works as-is.
- Carries **current** catalogue data (today's price, availability), **not**
  purchase frequency or dates. Unavailable habitual products are kept
  (35/267 shown as "Bientôt disponible", with `fProduitSubstitution: true`).
- Filters are exposed as JSON too (`lstBlocsFiltres`: aisles, brands,
  promotions, seasonal).
- ⇒ It is the cheap answer to "what do I usually buy" (one load instead of N
  order pages), but the frequency / price-paid history still needs §7.

## 7. Order history — `fd5-espace-client.leclercdrive.fr`

### 7a. List — `GET /drive/magasin-{id}-{id}-{slug}/mes-commandes.aspx`

- **Server-rendered HTML table**, NOT an `initOptions` JSON blob (the only
  `initOptions` calls on the page are the header widgets). Parse the DOM.
- One `<table id$="lvHistCom_ctrl{N}_tbEspaceClient">` per order, 5 orders
  shown for 2026 so far. Each row: state ("Livrée"), order number link
  `N°12345678` → `detail-commande.aspx?iIdC={opaque base64 id}`, order date/time,
  service, payment, slot, total, delivery fee, product count ("55 produits" =
  total quantity, not lines), savings.
- **History depth**: year filter `ddlFiltreAnnees` offers **2024, 2025, 2026**
  ⇒ ≥ 2 years available. Switching year is a plain **GET**:
  `mes-commandes.aspx?AnneeSelectionnee=2025` (the dropdown's change handler
  redirects; a POST postback on the dropdown does NOT filter).
- **Pagination**: 5 orders per page + an « En voir plus » link-button
  (`a.aWCCD353_Plus`, `__doPostBack('…ascWCCD010_HistoriqueCommandes$lbEnVoirPlus','')`).
  Replaying it as a classic form POST (all hidden inputs + selects of the form,
  `__EVENTTARGET` = that target) returns the full page with the extra orders —
  validated live: 2025 went from 5 to its 12 orders in one postback, after which
  the button disappears. Not an async (UpdatePanel) response.
- Order counts observed: 2026 → 5 (Jun–Sep), 2025 → 12. The row markup is one
  `<tr>` per order in `<table id="historique">` (number link
  `…lvHistCom_ctrl{N}_hlNumeroCommande`, totals in a nested
  `…lvHistCom_ctrl{N}_tbEspaceClient` table).

### 7b. Detail — `GET .../detail-commande.aspx?iIdC=...`

- Also plain HTML. **Each product line is
  `<li class="liWCCD353_LigneArticle" iidproduit="126817" stitre1="Filet de poulet extra tendre" stitre2="Le Gaulois - 300g">`**
  — the product id and both label lines are attributes (39/39 lines had
  `iidproduit`). Inside: `p.pWCCD353_Quantite` ("x2"), `p.pWCCD051_Prix`
  (line total, "7,58 €"), `a.aWCCD353_VoirRayon` (href → `rayon-{iIdRayon}-…`),
  thumbnail `img.imgWCCD353_Produit`.
- Lines are grouped by aisle heading ("Fruits Légumes (22 produits)").
- Prices shown are **before** immediate discounts; a "Détail de mes économies"
  block at the bottom lists the BRII lots and the total saved.
- Header: `COMMANDE N°12345678 DU 01/09/2026 À 10H27`.
- ✅ `iidproduit` 126817 (order of 2026-09-01) matches the current catalogue id
  of the same product on produits-habituels. Id drift over longer periods is
  still expected — re-resolve by label when the id is unknown to the catalogue.

### 7c. Cross-host note

Validated live: `fetch(..., {credentials: "include"})` from a courses page to
the espace-client host (and the reverse) returns **200 with a readable body**
(CORS allowed, `type: "cors"`). So the client fetches history pages from the
store tab without navigating. Same cookies (`.leclercdrive.fr`), same DataDome
session — no re-login observed.

## 8. Product sheet — `GET .../fiche-produits-{id}-{slug}.aspx`

`sUrlPageProduit` from any product record (~480 KB page, carries the store
marker). Embedded JSON exposes what list pages don't: **`sCodeEAN`** (13
digits), **`sLibelleMarque`** ("Marque repère"), `sComposition`,
`sAllergenes`, `sConservation`, `sOrigine` / `sLibelleOrigine`. No Nutri-Score
field found. One page load per product ⇒ fetched lazily and cached in the ledger.

⚠️ The sheet embeds **~20 product records with their own `sCodeEAN`**
(recommendations, "souvent achetés ensemble"); the requested product appears
in ~3 of them. Read the EAN only from records whose `iIdProduit` matches —
taking the first `sCodeEAN` on the page attributes another product's code
(observed: an aubergine sheet returned the pepper's EAN 3701385102484).
