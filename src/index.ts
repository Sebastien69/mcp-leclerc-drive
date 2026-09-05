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
import { FoundStore, StoreLocator } from "./leclerc/locator.js";
import { Ledger, median } from "./ledger.js";
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

// Kept minimal on purpose: the aggregated views (usual products, promo
// qualification against the paid-price median) are lot 3. `median` is imported
// here so the ledger helper is exercised by the typechecker until then.
void median;

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
