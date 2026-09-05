# Fork de `mcp-leclerc-drive` — contexte et plan de travail

> Document de passation. Contient les décisions déjà prises et leurs raisons.
> À lire en entier avant de coder. Le lot 0 est bloquant.

## Objectif

Automatiser la préparation du panier E.Leclerc Drive depuis Claude :

- reprendre en priorité les produits déjà achetés (historique de commandes) ;
- arbitrer sur le prix (prix au kilo/litre, vraies promos) pour choisir le bon produit ;
- **connexion et validation de commande restent manuelles** — le MCP ne doit
  jamais choisir de créneau, valider une commande ni payer.

Contraintes non négociables, dans l'ordre :

1. **Installation simple.** Pas de service à démarrer, pas de clé API, pas de
   fichier de config à remplir. C'est le critère qui a tranché le choix de base.
2. Vitesse : un panier de ~40 articles doit rester de l'ordre de la minute.

## État d'avancement (mis à jour le 2026-09-05)

- Fork : <https://github.com/Sebastien69/mcp-leclerc-drive> (`origin`), amont en `upstream`.
  Build avec Node 24 (`nvm use 24`).
- Captures live faites sur un drive du cluster `fd5` : host courses
  `fd5-courses.leclercdrive.fr`, espace client `fd5-espace-client.leclercdrive.fr`.
  Le magasin de l'utilisateur est dans `~/.mcp-leclerc-drive/config.json`, pas ici.
- **Lot 0 : fait** — résultats dans `docs/api-capture.md` §5–7. Résumé :
  1. « Mes commandes » et le détail d'une commande sont du **HTML serveur**, pas
     du JSON `initOptions`. Les lignes de commande sont des
     `<li class="liWCCD353_LigneArticle" iidproduit="…" stitre1="…" stitre2="…">`
     avec `p.pWCCD353_Quantite` (« x2 ») et `p.pWCCD051_Prix` (total ligne).
     `scanProductRecords()` ne sert donc pas pour l'historique : parser le DOM.
  2. Profondeur : filtre par année **2024 / 2025 / 2026** (≥ 2 ans). Changer
     d'année = postback ASP.NET (`__VIEWSTATE`, `__EVENTVALIDATION`).
  3. **La page agrégée existe** : `produits-habituels.aspx` (host courses), 267
     produits en une seule page, même format `objElement` que la recherche —
     mais sans fréquence ni prix payés. Elle remplace le backfill pour « mes
     produits habituels » ; l'historique reste nécessaire pour la fréquence et
     la médiane des prix payés.
- **Lot 1 : fait** — `RawProduct`/`mapProduct` élargis (promo, prix/unité
  numérique + unité, contenance, rayon/famille, stock), disponibilité
  `eDisponibilite === 0 && iQteDisponible > 0` (validée live, `fProduitEpuise`
  jamais observé, `sLibelleMarque` absent des listes), `sort` + `limit` sur
  `search_product` (tri avant troncature), `ContractChangedError`, annotations
  MCP (`registerTool`). Non testé en live via le serveur MCP (pas de session
  Chrome dédiée sur cette machine encore) : lancer `npm run smoke` une fois.
- **Lot 2 : implémenté, test live en attente de connexion.** Fichiers :
  `src/ledger.ts` (JSONL `~/.mcp-leclerc-drive/orders.jsonl` + `products.jsonl`,
  dernier enregistrement produit gagnant), `src/leclerc/history.ts` (parsers DOM
  purs + `HistoryClient`), `src/leclerc/resolve.ts` (normalisation/Jaccard des
  libellés), `src/leclerc/importer.ts` (`import_order_history`). Outils MCP :
  `import_order_history(limit, resolve_limit, ean_limit, force_resolve)` et
  `get_order_history(order_no?)`. Tests : `npm test` (7 tests, fixtures
  synthétiques calquées sur le HTML live). CLI : `npm run import`.
  Décisions prises :
  - Le filtre année est un GET `?AnneeSelectionnee=YYYY` ; la pagination
    (5 commandes) se rejoue par POST du postback « En voir plus » (validé live :
    2025 = 12 commandes en un seul postback).
  - Les fetch cross-origin courses ↔ espace-client passent avec CORS +
    credentials (validé live) : pas de navigation d'onglet nécessaire.
  - Résolution en deux temps : d'abord « Mes produits habituels » (1 page, couvre
    l'essentiel), puis recherche par libellé bornée par `resolve_limit` ; le
    reste est `unresolved` et reprend au prochain import ; introuvable ⇒
    `missing` explicite. Match par id si l'id existe encore, sinon libellé
    exact normalisé, sinon Jaccard ≥ 0,6.
  - EAN/marque : fiche produit (`sCodeEAN`, `sLibelleMarque`, `sComposition`,
    `sAllergenes` présents, validé live) chargée au plus `ean_limit` fois par
    import, cachée dans `products.jsonl`.
  - Le prix de ligne du détail de commande est **avant** remises immédiates ;
    les économies sont au niveau de la commande (`savings`).
- Le serveur a sa config magasin dans `~/.mcp-leclerc-drive/config.json`
  (`set_store` ou fichier écrit à la main). Sa fenêtre Chrome dédiée (port 9222, profil
  `~/.mcp-leclerc-drive/chrome`) doit être connectée à Leclerc Drive une fois.
- **Import validé en live** (2026-09-05) : 30 commandes (sept. 2025 → sept.
  2026), ~780 produits distincts. Corrections issues du live : href du postback
  encodé en `&#39;`, EAN lu uniquement dans les enregistrements du produit
  demandé (la fiche embarque ~20 produits recommandés avec leur propre EAN),
  correspondance floue durcie (tokens de format identiques + Jaccard ≥ 0,7,
  sinon « Ketchup 250g » matchait « 342g »). Une correspondance `label_fuzzy`
  reste enregistrée `active` mais est traitée comme « à arbitrer » par
  `build_cart_from_history`, jamais ajoutée automatiquement.
- **Lot 3 : fait** — `src/leclerc/insights.ts` : `get_usual_products`,
  `build_cart_from_history(last_n, dry_run=true, skip_ids)`,
  `compare_products(query)` (groupé par unité, verdict « vraie promo » si
  ≥ 10 % sous la médiane payée), `find_substitutes(product_id|label)`
  (même rayon/unité/format, prix par unité le plus proche). Tests dans
  `test/insights.test.mjs`.
- **Lot 4 : fait (partie utile)** — `add_many(items)` et cache du dernier
  panier connu dans `LeclercClient` (fusion des événements de mutation dans le
  panier complet ; `updateQuantity` ne recharge la page que si le cache est
  vide).
- **Lot 3 validé en live** (`node scripts/insights-smoke.mjs`, lecture seule,
  ~3,5 s hors ledger) : 12 produits récurrents ≥ 5 commandes sur 30, proposition
  de panier sur la dernière commande = 28 prêts / 6 à arbitrer / 5 disparus,
  comparaison « huile d'olive » groupée kg / l, substituts trouvés.
- Limites connues à garder en tête :
  - `compare_products` dépend de la recherche Leclerc, très large : on garde les
    libellés portant tous les mots de la requête (`focusOnQuery`), sinon la
    liste complète. Les bouillons « à l'huile d'olive » passent encore.
  - L'id de rayon d'une ligne de commande (lien « Voir le rayon ») ne coïncide
    pas toujours avec `iIdRayon` des résultats de recherche (sous-rayon vs
    rayon) : « même rayon » n'est alors pas détecté, le classement reste
    correct via libellé/format/prix.
  - Une correspondance floue reste une variante (parfum, brique vs bouteille) :
    elle n'est jamais ajoutée automatiquement.
  - ~95 produits sur 456 résolus sont « disparus » après 12 mois : beaucoup de
    fruits/légumes saisonniers et formats changés. C'est attendu.
  - Rythme mesuré : ~1,5–1,8 s par requête (recherche, détail, fiche). Import
    initial de 30 commandes + 200 résolutions ≈ 6 min ; ensuite quelques
    secondes.
  - **DataDome frappe aussi les longues séries** : un run de ~400 pages
    (200 recherches + fiches EAN) a pris un 403 après ~200 fiches, et tout le
    reste du run a échoué (55 min perdues). L'importeur s'arrête désormais au
    premier blocage (`blocked` dans le rapport). Garder `ean_limit` ≤ 50 par
    session ; 192 fiches sur 474 produits actifs ont leur EAN, le reste se
    complètera au fil des imports.
- Reste : push GitHub (auth manquante) ; vivre avec, le premier vrai panier
  dira si les seuils (0,7 / 10 %) sont bons.

## Décision : forker `skunkobi/mcp-leclerc-drive`

<https://github.com/skunkobi/mcp-leclerc-drive> — MIT, TypeScript, ~1350 lignes.

Deux MCP Leclerc existent. L'autre est `ncleton-petitmaker/leclerc-drive-mcp`
(MIT, ~1470 lignes, Camoufox). Il a un meilleur modèle de données mais a été
écarté :

| | skunkobi (**retenu**) | ncleton (écarté) |
|---|---|---|
| Installation | `npx -y mcp-leclerc-drive`, utilise le Chrome déjà installé | camofox global + service local + clé API + 7 variables `.env` |
| Anti-bot | Chrome réel piloté en CDP | Camoufox |
| Magasin | dynamique (`find_stores` / `set_store`) | figé dans `.env`, un seul drive |
| Débit | ~1 s + jitter par appel | plafond Camoufox 20 appels/min/profil |
| Résultats de recherche | ~200 produits en un chargement | plafonné à 20, `slice` brut sans tri |
| Mutations panier | directes | 2 phases + jeton 5 min (double le coût) |

Sur un panier de 40 articles : ~1 min contre ~4 min. Et le cap à 20 résultats de
ncleton était en réalité sa limite la plus gênante — il coupe avant qu'on puisse
comparer les prix.

**À porter depuis ncleton** (bonnes idées, code MIT lisible) :

- validation des réponses par Zod, avec une `ContractChangedError` explicite
  quand Leclerc change ses champs — au lieu du mapping tolérant actuel qui
  renvoie des zéros silencieusement ;
- la logique de disponibilité : `eDisponibilite === 0 && quantité > 0 &&
  !fProduitEpuise`, au lieu de `iQteDisponible > 0` ;
- la lecture de l'EAN (`sCodeEAN`), des ingrédients (`sComposition`) et de la
  marque (`sLibelleMarque`).

## État du code repris

Le code est propre. À conserver tel quel :

- `assertStorePage()` — garde anti-DataDome : si la page ne contient pas le
  marqueur `lstProduitsLight`, une erreur explicite est levée au lieu de
  renvoyer « 0 résultat ». Ne pas affaiblir.
- `throttle.ts` — sérialisation, espacement, backoff sur 403/429.
- `scanProductRecords()` / `extractArrayNamed()` — extraction par comptage
  d'accolades, tolérante aux membres non-JSON. Ces extracteurs sont génériques
  et resserviront pour l'historique.
- Les messages d'erreur en français qui disent quoi faire (« reconnecte-toi dans
  Chrome puis réessaie »).

Défauts identifiés :

- **`mapProduct()` jette des données déjà parsées.** L'objet produit de la page
  de recherche expose `sPrixPromo`, `nrPVParUniteDeMesureTTC` (prix au kilo ou
  au litre, **en numérique**), `sLibelleMarque`, `iIdRayon` / `iIdFamille` —
  tous ignorés par le mapper. Le `Product` déclare `nutriScore` et `brand` mais
  ne les renseigne jamais. Aucun reverse-engineering nécessaire pour corriger,
  seulement élargir `RawProduct` et le mapper.
- `pricePerUnit` n'est conservé que comme chaîne (`"1,29 €/L"`), inutilisable
  pour trier.
- `available` = `iQteDisponible > 0` → faux négatifs quand le champ est absent.
- `search_product` ne trie ni ne pagine.
- `updateQuantity()` fait deux aller-retours (lecture du panier puis mutation).
- `getCart()` charge une page de recherche volontairement vide
  (`zzzznomatchzzz`) pour scraper le panier embarqué. Fonctionne, mais chaque
  lecture coûte un chargement de page complet.
- Aucune annotation MCP (`readOnlyHint` / `destructiveHint`) : rien n'indique à
  l'agent que `add_to_cart` mute l'état.
- Aucun historique de commandes.

## Lot 0 — vérification préalable (bloquant)

**À faire avant d'écrire du code.** Tout le lot 2 en dépend.

Dans la fenêtre Chrome ouverte par le serveur et déjà connectée : ouvrir « Mes
commandes », DevTools, onglet réseau. Vérifier :

1. **Le format.** Est-ce le même motif que le reste du site — une page `.aspx`
   avec un blob JSON embarqué dans un appel `Utilitaires.widget.initOptions(...)` ?
   Si oui, `extractArrayNamed()` et `scanProductRecords()` fonctionnent quasi
   tels quels et le lot 2 est peu risqué.
2. **La profondeur d'historique conservée.** 3 mois change complètement la
   valeur du backfill ; un an donne les habitudes saisonnières.
3. **L'existence d'une page agrégée** type « déjà commandé » / « mes
   habitudes ». Si elle existe, une seule page donne la liste des produits
   récurrents — beaucoup moins cher que de parcourir N commandes.

Consigner le résultat dans `docs/api-capture.md`, qui documente déjà les
endpoints existants et sert de référence.

## Lot 1 — prix et sélection (~30 lignes, sans risque)

- Élargir `RawProduct` et `mapProduct()` : `sPrixPromo`, marque, rayon, et
  surtout `nrPVParUniteDeMesureTTC` exposé **en numérique** à côté de la chaîne
  d'affichage.
- Ajouter `sort` (défaut : prix par unité croissant) et `limit` à
  `search_product`. **Trier avant de tronquer.**
- Reprendre la logique de disponibilité de ncleton. Vérifier en live que
  `eDisponibilite` et `fProduitEpuise` sont bien présents dans cette réponse.
- Ajouter les annotations MCP sur les outils mutatifs.

## Lot 2 — historique et ledger

Un seul mécanisme couvre les deux besoins : `import_order_history(limit)`,
idempotent, dédupliqué par numéro de commande.

- Premier lancement : remonte les N dernières commandes et constitue le ledger
  d'un coup, ce qui règle le démarrage à froid.
- Ensuite : appelé en début de session, ne récupère que les commandes inconnues.

Ne pas partir sur un snapshot du panier avant checkout : il faut y penser
manuellement, et le panier au moment du snapshot n'est pas forcément ce qui a
été validé après les derniers ajustements. L'historique dit ce qui a réellement
été acheté.

Bénéfice secondaire : les commandes passées portent les prix payés à l'époque.
La base de comparaison pour distinguer une vraie promo d'un faux prix barré est
donc disponible immédiatement, sans attendre des mois de collecte.

Coût du backfill : ~20 commandes × ~1,5 s ≈ 30 s, une seule fois.

Stockage : `~/.mcp-leclerc-drive/` (le projet y écrit déjà sa config et son
profil Chrome). JSONL append-only.

### Piège central : les identifiants produits ne sont pas stables

Les `iIdProduit` bougent dans le temps — changement de packaging,
re-référencement. Un id d'il y a huit mois peut ne plus exister aujourd'hui.

**Le ledger ne doit donc pas être indexé sur l'id brut.** À l'import, chaque
produit historique est re-résolu contre le catalogue actuel (libellé + marque,
et EAN quand il est connu). Les articles introuvables sont **explicitement
marqués comme disparus**, jamais silencieusement perdus. C'est là que se joue la
qualité du « reprends mes produits habituels ».

### EAN

`sCodeEAN` n'est disponible que sur la fiche produit, pas dans les résultats de
recherche : un chargement de page supplémentaire par article. Ne pas le
récupérer systématiquement. Le chercher une seule fois quand un produit entre
dans le ledger, puis le mettre en cache — coût nul sur les courses suivantes, et
il donne un identifiant stable dans le temps.

## Lot 3 — outils de haut niveau

- `get_usual_products()` — produits récurrents avec fréquence d'achat.
- `build_cart_from_history(n)` — reconstitue un panier depuis les N dernières
  commandes ; signale les produits disparus et propose des substituts.
- `compare_products(query)` — normalise au prix par unité, et compare le prix du
  jour à la médiane historique du ledger pour qualifier une promo. Plus fiable
  que le prix barré affiché. Ne comparer des prix par unité qu'entre unités
  identiques (kg vs L vs pièce).
- Substitution : quand l'habituel est indisponible, proposer le plus proche par
  marque, format et prix par unité, dans le même `iIdRayon`.

## Lot 4 — débit (si nécessaire)

- `add_many(items)` pour grouper les ajouts et éviter les aller-retours unitaires.
- Supprimer le double appel de `updateQuantity()` en gardant en mémoire le
  dernier état de panier connu, retourné par les événements de mutation.

## Points de vigilance

- **Session liée à un seul drive.** `set_store` vers un magasin sur lequel la
  session Chrome n'est pas connectée renvoie une page « session expirée ».
- Le serveur ouvre une fenêtre Chrome visible avec un port de debug (9222).
  Ne pas passer en headless : DataDome le détecte.
- Rester poli : conserver l'espacement des requêtes et le backoff existants.
- Le projet amont est peu actif. Ce fork sera à maintenir quand Leclerc changera
  son front. Garder les extracteurs génériques et les erreurs explicites, ce
  sont eux qui rendront les régressions diagnosticables.
- Non officiel, sans affiliation E.Leclerc. Usage personnel, compte propre,
  dans le respect des CGU du site.
