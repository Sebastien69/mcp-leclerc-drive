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
  Local : `~/Desktop/Perso-Dev/mcp-leclerc-drive`. Build avec Node 24 (`nvm use 24`).
- Drive de l'utilisateur : **176901 Lyon 9e**, host courses `fd5-courses.leclercdrive.fr`,
  espace client `fd5-espace-client.leclercdrive.fr`.
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
- Prochaine étape : lot 2, en s'appuyant sur §6–7 de `docs/api-capture.md`.

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
