#!/usr/bin/env node
/**
 * MCP server for E.Leclerc Drive.
 *
 * Exposes search / cart tools over stdio so Claude Desktop, Claude Code, or any
 * MCP client can drive grocery ordering natively instead of via browser
 * automation.
 *
 * Login, slot booking and checkout stay manual on purpose: no tool here ever
 * validates an order or pays.
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ChromeSession } from "./browser.js";
import { loadConfig } from "./config.js";
import { LeclercClient } from "./leclerc/client.js";
import { HistoryClient } from "./leclerc/history.js";
import { HistoryImporter } from "./leclerc/importer.js";
import {
  buildCartFromHistory,
  compareProducts,
  findSubstitutes,
  usualProducts,
} from "./leclerc/insights.js";
import { FoundStore, StoreLocator } from "./leclerc/locator.js";
import { Ledger } from "./ledger.js";
import { StoreState } from "./store.js";
import { Cart, Product } from "./types.js";

// Single source of truth for the version: read it from package.json (one dir up
// from dist/index.js) so serverInfo never drifts from the published package.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const config = loadConfig();
const browser = new ChromeSession({
  chromePath: config.chromePath,
  profileDir: config.chromeProfileDir,
  port: config.chromePort,
  headless: config.headless,
});
const store = new StoreState(config);
const client = new LeclercClient(config, browser, store);
const locator = new StoreLocator(config, browser);
const ledger = new Ledger();
const history = new HistoryClient(client);
const importer = new HistoryImporter(client, history, ledger, () => store.current().storeId);

// Cache of the last find_stores results, so set_store can resolve the host
// (and noPR) from just a store id the user picked.
const lastFound = new Map<string, FoundStore>();

const server = new McpServer({
  name: "mcp-leclerc-drive",
  version: pkg.version,
});

// MCP tool annotations. `readOnlyHint` tells the agent a tool has no side
// effect; `destructiveHint: false` marks an additive mutation (add_to_cart),
// true marks one that can remove/lower cart lines.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const eur = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

function formatProduct(p: Product): string {
  const priceBit =
    p.promoPrice !== undefined && p.promoPrice < p.price
      ? `— ${eur(p.promoPrice)} (promo, au lieu de ${eur(p.price)})`
      : `— ${eur(p.price)}`;
  const bits = [
    p.label,
    p.brand ? `(${p.brand})` : null,
    priceBit,
    p.pricePerUnit ? `[${p.pricePerUnit}]` : null,
    p.nutriScore ? `Nutri-Score ${p.nutriScore}` : null,
    p.available ? null : "⚠️ indisponible",
    `id=${p.id}`,
    p.aisleId ? `rayon=${p.aisleId}` : null,
  ].filter(Boolean);
  return bits.join(" ");
}

function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const lines = cart.items.map(
    (it) =>
      `• ${it.quantity}× ${it.product.label} — ${eur(it.lineTotal)} ` +
      `(id=${it.product.id})`,
  );
  return (
    `Panier (magasin ${cart.storeId}) — ${cart.itemCount} article(s) :\n` +
    lines.join("\n") +
    `\n\nTotal : ${eur(cart.total)}`
  );
}

/** Wrap a tool body so thrown errors become structured MCP error content. */
function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Erreur : ${message}` }], isError: true };
}

server.registerTool(
  "search_product",
  {
    title: "Rechercher des produits",
    description:
      "Recherche des produits dans le catalogue Leclerc Drive du magasin configuré. " +
      "Retourne label, prix (et prix promo), prix au kilo/litre, disponibilité, l'id " +
      "à utiliser pour add_to_cart et l'id de rayon. Trié par défaut du moins cher au " +
      "plus cher au kilo/litre (produits disponibles d'abord) — le tri est appliqué " +
      "AVANT la limite. Ne compare le prix au kilo/litre qu'entre produits de même unité.",
    inputSchema: {
      query: z.string().describe("Termes de recherche, ex. 'lait demi-écrémé bio'"),
      sort: z
        .enum(["price_per_unit", "price", "relevance"])
        .default("price_per_unit")
        .describe(
          "Ordre : 'price_per_unit' (prix au kg/L croissant, défaut), 'price' (prix " +
            "unitaire croissant) ou 'relevance' (ordre du site).",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .default(20)
        .describe("Nombre max de produits retournés, après tri (défaut 20)."),
    },
    annotations: READ_ONLY,
  },
  async ({ query, sort, limit }) => {
    try {
      const { products, total } = await client.searchProducts(query, { sort, limit });
      if (total === 0) return asText(`Aucun produit trouvé pour « ${query} ».`);
      const head =
        total > products.length
          ? `${total} produits trouvés, ${products.length} affichés (tri : ${sort}) :\n`
          : `${total} produit(s) trouvé(s) (tri : ${sort}) :\n`;
      return asText(head + products.map(formatProduct).join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "add_to_cart",
  {
    title: "Ajouter au panier",
    description:
      "Ajoute un produit au panier (modifie le panier Leclerc réel). Utilise l'id " +
      "retourné par search_product. Ne valide jamais de commande.",
    inputSchema: {
      product_id: z.string().describe("Identifiant produit (champ id de search_product)"),
      quantity: z.number().int().positive().default(1).describe("Quantité cible"),
    },
    annotations: ADDITIVE,
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.addToCart(product_id, quantity);
      return asText(`Ajouté.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "add_many",
  {
    title: "Ajouter plusieurs produits",
    description:
      "Ajoute plusieurs produits au panier en une fois (modifie le panier Leclerc réel). " +
      "Même effet que add_to_cart répété, mais un seul appel et un seul état de panier en retour. " +
      "Les requêtes restent espacées côté serveur (anti-DataDome).",
    inputSchema: {
      items: z
        .array(z.object({ product_id: z.string(), quantity: z.number().int().positive().default(1) }))
        .min(1)
        .max(80)
        .describe("Liste de {product_id, quantity}"),
    },
    annotations: ADDITIVE,
  },
  async ({ items }) => {
    try {
      const r = await client.addMany(items.map((i) => ({ productId: i.product_id, quantity: i.quantity })));
      const head = `Ajoutés : ${r.added.length}/${items.length}.` +
        (r.failed.length ? ` Échecs : ${r.failed.map((f) => `${f.productId} (${f.error})`).join("; ")}.` : "");
      return asText(`${head}\n\n${r.cart ? formatCart(r.cart) : ""}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "remove_from_cart",
  {
    title: "Retirer du panier",
    description: "Retire complètement un produit du panier (modifie le panier Leclerc réel).",
    inputSchema: { product_id: z.string().describe("Identifiant produit à retirer") },
    annotations: DESTRUCTIVE,
  },
  async ({ product_id }) => {
    try {
      const cart = await client.removeFromCart(product_id);
      return asText(`Retiré.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "update_quantity",
  {
    title: "Modifier une quantité",
    description:
      "Fixe la quantité d'un produit déjà présent dans le panier (modifie le panier " +
      "Leclerc réel). 0 retire la ligne.",
    inputSchema: {
      product_id: z.string().describe("Identifiant produit"),
      quantity: z.number().int().nonnegative().describe("Nouvelle quantité (0 pour retirer)"),
    },
    annotations: DESTRUCTIVE,
  },
  async ({ product_id, quantity }) => {
    try {
      const cart = await client.updateQuantity(product_id, quantity);
      return asText(`Quantité mise à jour.\n\n${formatCart(cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "get_cart",
  {
    title: "Voir le panier",
    description: "Affiche le contenu complet du panier avec le total.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    try {
      const cart = await client.getCart();
      return asText(formatCart(cart));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "find_stores",
  {
    title: "Trouver des drives",
    description:
      "Recherche les drives E.Leclerc proches d'un code postal ou d'une ville, triés " +
      "par distance. Retourne pour chacun : nom, identifiant (à passer à set_store), " +
      "type de service (drive/relais/livraison), distance et magasin.",
    inputSchema: { query: z.string().describe("Code postal ou ville, ex. '44000' ou 'Nantes'") },
    annotations: READ_ONLY,
  },
  async ({ query }) => {
    try {
      const stores = await locator.findStores(query);
      if (stores.length === 0) return asText(`Aucun drive trouvé pour « ${query} ».`);
      lastFound.clear();
      for (const s of stores) lastFound.set(s.storeId, s);
      const lines = stores.map((s) => {
        const dist = s.distanceKm !== undefined ? `${s.distanceKm.toFixed(1)} km` : "";
        return `• ${s.name} — ${s.serviceType} ${dist} (id=${s.storeId})`;
      });
      return asText(
        `Drives autour de « ${query} » :\n${lines.join("\n")}\n\n` +
          `Pour en choisir un : set_store avec son id. Les courses fonctionnent sur les « drive ».`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "set_store",
  {
    title: "Choisir le magasin",
    description:
      "Sélectionne le magasin actif (et le mémorise pour les prochaines sessions). " +
      "Utilise l'id renvoyé par find_stores. ⚠️ La session Chrome est liée à un seul " +
      "drive : choisir un autre magasin que celui où tu es connecté renvoie « session expirée ».",
    inputSchema: {
      store_id: z.string().describe("Identifiant magasin (champ id de find_stores)"),
      host: z
        .string()
        .optional()
        .describe("Host backend (optionnel) si le magasin n'a pas été trouvé via find_stores"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ store_id, host }) => {
    try {
      const found = lastFound.get(store_id);
      if (!found && !host) {
        return asError(
          new Error(
            `Magasin ${store_id} inconnu. Lance d'abord find_stores, puis set_store avec un id ` +
              `de la liste (ou fournis le paramètre host).`,
          ),
        );
      }
      const selection = found
        ? { storeId: found.storeId, noPR: found.noPR, host: found.host, name: found.name }
        : { storeId: store_id, noPR: store_id, host: host as string };
      store.set(selection);
      return asText(
        `Magasin actif : ${selection.name ?? selection.storeId} ` +
          `(id=${selection.storeId} @ ${selection.host}). Mémorisé.`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "get_store",
  {
    title: "Magasin actif",
    description: "Affiche le magasin actuellement sélectionné (id, host).",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const s = store.current();
    return asText(`Magasin actif : ${s.name ?? s.storeId} (id=${s.storeId} @ ${s.host}).`);
  },
);


// ---- Order history / ledger (lot 2) ---------------------------------------

server.registerTool(
  "import_order_history",
  {
    title: "Importer l'historique de commandes",
    description:
      "Importe les dernières commandes passées (page « Mes commandes » du compte connecté) " +
      "dans un ledger local (~/.mcp-leclerc-drive/orders.jsonl), sans doublon. Chaque " +
      "produit historique est re-résolu contre le catalogue du jour (ids instables) et les " +
      "produits disparus sont marqués comme tels. À lancer en début de session : idempotent, " +
      "ne récupère que les commandes inconnues. Premier import ≈ 1 à 3 min pour 20 commandes. " +
      "Ne modifie ni le panier ni les commandes.",
    inputSchema: {
      limit: z.number().int().positive().max(100).default(20).describe("Nombre de commandes récentes à considérer"),
      resolve_limit: z
        .number()
        .int()
        .nonnegative()
        .max(200)
        .default(40)
        .describe("Max de recherches catalogue pour les produits absents de « Mes produits habituels »"),
      ean_limit: z
        .number()
        .int()
        .nonnegative()
        .max(200)
        .default(25)
        .describe("Max de fiches produit chargées pour récupérer EAN/marque (0 pour désactiver)"),
      force_resolve: z.boolean().default(false).describe("Re-résoudre tous les produits, pas seulement les nouveaux"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ limit, resolve_limit, ean_limit, force_resolve }) => {
    try {
      const r = await importer.run({
        limit,
        resolveLimit: resolve_limit,
        eanLimit: ean_limit,
        forceResolve: force_resolve,
        onProgress: (m) => console.error(`[import] ${m}`),
      });
      const secs = Math.round(r.durationMs / 1000);
      const lines = [
        `Import terminé en ${secs} s.`,
        `Commandes vues : ${r.ordersSeen} — importées : ${r.ordersImported.length}` +
          (r.ordersImported.length ? ` (${r.ordersImported.join(", ")})` : "") +
          ` — déjà connues : ${r.ordersSkipped}.`,
        `Produits résolus : ${r.productsResolved.byId} par id, ${r.productsResolved.byLabel} par libellé, ` +
          `${r.productsResolved.missing} disparus, ${r.productsResolved.unresolved} en attente` +
          (r.productsResolved.unresolved ? " (relance import_order_history pour continuer)" : "") +
          `. Fiches produit (EAN) chargées : ${r.eanFetched}.`,
        `Ledger : ${r.ledger.orders} commande(s), ${r.ledger.products} produit(s) distinct(s)` +
          (r.ledger.from ? `, du ${r.ledger.from} au ${r.ledger.to}` : "") +
          ` — ${r.ledger.missing} disparu(s), ${r.ledger.unresolved} non résolu(s).`,
      ];
      return asText(lines.join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "get_order_history",
  {
    title: "Voir l'historique importé",
    description:
      "Liste les commandes présentes dans le ledger local (importées par import_order_history), " +
      "avec date, total et nombre de lignes. Avec order_no, détaille les lignes d'une commande " +
      "(produit, quantité, prix payé, statut actuel du produit).",
    inputSchema: {
      order_no: z.string().optional().describe("Numéro de commande à détailler (optionnel)"),
      limit: z.number().int().positive().max(100).default(20).describe("Nombre de commandes listées"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ order_no, limit }) => {
    try {
      const orders = ledger.orders();
      if (orders.length === 0) {
        return asText("Ledger vide. Lance import_order_history pour importer tes commandes.");
      }
      if (order_no) {
        const o = orders.find((x) => x.orderNo === order_no);
        if (!o) return asText(`Commande ${order_no} inconnue du ledger.`);
        const lines = o.lines.map((l) => {
          const rec = ledger.product(l.productId);
          const status =
            !rec ? "" : rec.status === "missing" ? " ⚠️ disparu du catalogue" :
            rec.status === "unresolved" ? " (non résolu)" :
            rec.currentId !== l.productId ? ` → id actuel ${rec.currentId}` : "";
          const avail = rec?.status === "active" && rec.available === false ? " ⚠️ indisponible" : "";
          return `• ${l.quantity}× ${l.label} — ${eur(l.unitPrice)}/u, ${eur(l.lineTotal)} (id=${l.productId})${status}${avail}`;
        });
        return asText(
          `Commande ${o.orderNo} du ${o.date.replace("T", " ").slice(0, 16)} — ${o.lines.length} ligne(s)` +
            (o.total !== undefined ? `, total ${eur(o.total)}` : "") +
            (o.savings ? `, économies ${eur(o.savings)}` : "") +
            ` :\n${lines.join("\n")}`,
        );
      }
      const s = ledger.summary();
      const rows = orders.slice(0, limit).map(
        (o) =>
          `• ${o.orderNo} — ${o.date.slice(0, 10)} — ${o.lines.length} ligne(s)` +
          (o.itemCount ? `, ${o.itemCount} articles` : "") +
          (o.total !== undefined ? ` — ${eur(o.total)}` : "") +
          (o.state ? ` (${o.state})` : ""),
      );
      return asText(
        `${s.orders} commande(s) dans le ledger (${s.from} → ${s.to}), ${s.products} produits distincts, ` +
          `${s.missing} disparus, ${s.unresolved} non résolus.\n${rows.join("\n")}`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

// ---- High-level tools (lot 3) ----------------------------------------------

const pct = (n: number) => `${n > 0 ? "+" : ""}${n} %`;

server.registerTool(
  "get_usual_products",
  {
    title: "Mes produits récurrents",
    description:
      "Produits achetés de façon récurrente d'après le ledger (import_order_history), avec " +
      "fréquence, quantité habituelle, dernier achat, prix médian payé et état actuel " +
      "(disponible, disparu, prix du jour vs médiane). Lecture seule, sans appel au site.",
    inputSchema: {
      min_orders: z.number().int().positive().default(2).describe("Nombre minimal de commandes contenant le produit"),
      limit: z.number().int().positive().max(300).default(50).describe("Nombre de produits listés"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ min_orders, limit }) => {
    try {
      const list = usualProducts(ledger, { minOrders: min_orders, limit });
      if (list.length === 0) {
        return asText(
          ledger.orders().length === 0
            ? "Ledger vide. Lance import_order_history d'abord."
            : `Aucun produit présent dans au moins ${min_orders} commandes.`,
        );
      }
      const rows = list.map((u) => {
        const st = u.current;
        const state =
          !st || st.status === "unresolved" ? "non résolu" :
          st.status === "missing" ? "⚠️ disparu" :
          st.available === false ? "⚠️ indisponible" :
          `${eur(st.promoPrice !== undefined && st.promoPrice < (st.price ?? 0) ? st.promoPrice : st.price ?? 0)}` +
            (u.priceDeltaPct !== undefined ? ` (${pct(u.priceDeltaPct)} vs médiane)` : "");
        return (
          `• ${u.label} — ${u.orders}/${u.totalOrders} commandes, ~${u.avgQuantity}/commande, ` +
          `dernier ${u.lastDate}` +
          (u.medianPaid ? `, payé ~${eur(u.medianPaid)}` : "") +
          ` — ${state}` +
          (st?.status === "active" && st.currentId ? ` id=${st.currentId}` : ` id_hist=${u.productId}`)
        );
      });
      return asText(`${list.length} produit(s) récurrent(s) :\n${rows.join("\n")}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "build_cart_from_history",
  {
    title: "Panier depuis l'historique",
    description:
      "Reconstitue un panier à partir des N dernières commandes du ledger. En mode dry_run " +
      "(défaut) ne fait que proposer : produits prêts à ajouter (identiques, disponibles), " +
      "produits à arbitrer (correspondance approximative ou indisponibles) et produits disparus. " +
      "Avec dry_run=false, ajoute au panier Leclerc réel les produits « prêts » (jamais ceux à " +
      "arbitrer). Ne valide jamais de commande.",
    inputSchema: {
      last_n: z.number().int().positive().max(20).default(1).describe("Nombre de commandes récentes à reprendre"),
      dry_run: z.boolean().default(true).describe("true = proposer seulement ; false = ajouter les produits prêts au panier"),
      skip_ids: z.array(z.string()).default([]).describe("Ids (historiques ou actuels) à ne pas ajouter"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ last_n, dry_run, skip_ids }) => {
    try {
      const p = await buildCartFromHistory(ledger, client, {
        lastN: last_n,
        dryRun: dry_run,
        skipIds: skip_ids,
        onProgress: (m) => console.error(`[cart] ${m}`),
      });
      const fmt = (items: typeof p.ready) =>
        items.map((i) => `  • ${i.quantity}× ${i.label}${i.price !== undefined ? ` — ${eur(i.price)}` : ""}` +
          (i.addId ? ` (id=${i.addId})` : ` (id_hist=${i.productId})`) + (i.reason && i.reason !== "identique" ? ` — ${i.reason}` : ""));
      const out = [
        `Depuis ${p.orders.length} commande(s) : ${p.orders.join(", ")}.`,
        `Prêts à ajouter (${p.ready.length}, ≈ ${eur(p.estimatedTotal)}) :`,
        ...(p.ready.length ? fmt(p.ready) : ["  (aucun)"]),
        `À arbitrer (${p.review.length}) :`,
        ...(p.review.length ? fmt(p.review) : ["  (aucun)"]),
        `Disparus / non résolus (${p.gone.length}) :`,
        ...(p.gone.length ? fmt(p.gone) : ["  (aucun)"]),
      ];
      if (p.added) {
        out.push(
          `\nAjoutés au panier : ${p.added.length}` +
            (p.failed?.length ? ` — échecs : ${p.failed.map((f) => `${f.productId} (${f.error})`).join("; ")}` : "") +
            ". Utilise get_cart pour vérifier.",
        );
      } else {
        out.push("\nMode proposition : rien n'a été ajouté. Relance avec dry_run=false pour ajouter les produits prêts.");
      }
      return asText(out.join("\n"));
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "compare_products",
  {
    title: "Comparer des produits",
    description:
      "Recherche des produits et les compare au prix par unité (kg ou L), par groupe d'unité " +
      "identique. Pour les produits déjà achetés, compare le prix du jour à la médiane des prix " +
      "payés (ledger) et qualifie la promo : « vraie promo » (≥ 10 % sous la médiane), « prix " +
      "habituel » ou « plus cher qu'avant ». Plus fiable que le prix barré affiché.",
    inputSchema: {
      query: z.string().describe("Termes de recherche, ex. 'huile d'olive'"),
      limit: z.number().int().positive().max(50).default(15).describe("Produits par groupe d'unité"),
    },
    annotations: READ_ONLY,
  },
  async ({ query, limit }) => {
    try {
      const c = await compareProducts(ledger, client, query, limit);
      if (c.total === 0) return asText(`Aucun produit trouvé pour « ${query} ».`);
      const blocks = c.groups.map((g) => {
        const rows = g.items.map(({ product: p, timesBought, medianPaid, deltaPct, verdict }) => {
          const best = p.promoPrice !== undefined && p.promoPrice < p.price ? p.promoPrice : p.price;
          return (
            `• ${p.pricePerUnit ? `[${p.pricePerUnit}] ` : ""}${p.label} — ${eur(best)}` +
            (p.promoPrice !== undefined && p.promoPrice < p.price ? ` (affiché promo, au lieu de ${eur(p.price)})` : "") +
            (p.available ? "" : " ⚠️ indisponible") +
            (timesBought ? ` — acheté ${timesBought}×, payé ~${eur(medianPaid ?? 0)}${deltaPct !== undefined ? `, ${pct(deltaPct)} → ${verdict}` : ""}` : "") +
            ` id=${p.id}`
          );
        });
        return `Prix au ${g.unit} (${g.items.length} produits) :\n${rows.join("\n")}`;
      });
      return asText(`${c.total} produit(s) pour « ${query} », du moins cher au plus cher par unité.\n\n${blocks.join("\n\n")}`);
    } catch (err) {
      return asError(err);
    }
  },
);

server.registerTool(
  "find_substitutes",
  {
    title: "Trouver un substitut",
    description:
      "Propose les produits les plus proches d'un produit habituel indisponible ou disparu : " +
      "même rayon, même unité, même format, prix par unité le plus proche, libellé/marque " +
      "similaires. Donne product_id (id historique ou actuel connu du ledger) ou un libellé.",
    inputSchema: {
      product_id: z.string().optional().describe("Id du produit de référence (ledger)"),
      label: z.string().optional().describe("Libellé de référence si l'id est inconnu"),
      limit: z.number().int().positive().max(20).default(5),
    },
    annotations: READ_ONLY,
  },
  async ({ product_id, label, limit }) => {
    try {
      const r = await findSubstitutes(ledger, client, { productId: product_id, label }, limit);
      if (r.substitutes.length === 0) return asText(`Aucun substitut disponible trouvé pour « ${r.reference.label} ».`);
      const rows = r.substitutes.map(
        ({ product: p, reasons }) =>
          `• ${p.label} — ${eur(p.promoPrice !== undefined && p.promoPrice < p.price ? p.promoPrice : p.price)}` +
          (p.pricePerUnit ? ` [${p.pricePerUnit}]` : "") +
          (reasons.length ? ` — ${reasons.join(", ")}` : "") +
          ` id=${p.id}`,
      );
      return asText(
        `Substituts pour « ${r.reference.label} »` +
          (r.reference.pricePerUnitValue ? ` (référence ${r.reference.pricePerUnitValue} €/${r.reference.unit ?? "u"})` : "") +
          ` :\n${rows.join("\n")}`,
      );
    } catch (err) {
      return asError(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const s = store.current();
  // stderr only — stdout is the MCP channel.
  console.error(
    `mcp-leclerc-drive ready (store ${s.storeId} @ ${s.host}, ` +
      `auth: real Chrome via CDP${config.headless ? " [headless]" : ""})`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
