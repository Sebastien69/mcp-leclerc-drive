/**
 * import_order_history — one idempotent mechanism for both the cold start
 * (backfill the last N orders) and the routine "pick up what's new" call.
 *
 * Steps (each bounded so a run stays in the order of a minute):
 *  1. list the newest `limit` orders (1 page per year touched), skip known ones;
 *  2. fetch each unknown order's detail and append it to the ledger;
 *  3. re-resolve historical products against today's catalogue:
 *       - first via "Mes produits habituels" (1 page, ~all recurring products),
 *       - then by label search for the rest (≤ resolveLimit searches),
 *       - anything still unmatched is explicitly recorded as `missing`;
 *  4. fetch the product sheet (EAN, brand) for ≤ eanLimit resolved products
 *     that don't have one yet — cached forever in the ledger.
 *
 * Re-running continues where the budgets stopped. Nothing here mutates the cart.
 */

import { Ledger, ProductRecord } from "../ledger.js";
import { Product } from "../types.js";
import { LeclercClient } from "./client.js";
import { HistoryClient } from "./history.js";
import { bestLabelMatch } from "./resolve.js";

export interface ImportOptions {
  /** Newest N orders to consider (default 20). */
  limit?: number;
  /** Max label searches for products not found in "produits habituels" (default 40). */
  resolveLimit?: number;
  /** Max product sheets fetched for EAN/brand this run (default 25). */
  eanLimit?: number;
  /** Re-resolve every product, not just new/unresolved ones. */
  forceResolve?: boolean;
  /** Progress callback (stderr logging). */
  onProgress?: (msg: string) => void;
}

export interface ImportReport {
  /** Set when Leclerc/DataDome started refusing requests: the run stopped early. */
  blocked?: string;
  ordersSeen: number;
  ordersImported: string[];
  ordersSkipped: number;
  productsResolved: { byId: number; byLabel: number; missing: number; unresolved: number };
  eanFetched: number;
  ledger: ReturnType<Ledger["summary"]>;
  durationMs: number;
}

export class HistoryImporter {
  constructor(
    private readonly client: LeclercClient,
    private readonly history: HistoryClient,
    private readonly ledger: Ledger,
    private readonly storeId: () => string,
  ) {}

  async run(opts: ImportOptions = {}): Promise<ImportReport> {
    const t0 = Date.now();
    const limit = opts.limit ?? 20;
    const resolveLimit = opts.resolveLimit ?? 40;
    const eanLimit = opts.eanLimit ?? 25;
    const log = opts.onProgress ?? (() => undefined);

    // 1–2. Orders --------------------------------------------------------------
    const summaries = await this.history.listRecentOrders(limit);
    const imported: string[] = [];
    let skipped = 0;
    for (const s of summaries) {
      if (this.ledger.hasOrder(s.orderNo)) {
        skipped++;
        continue;
      }
      log(`commande ${s.orderNo} (${s.date.slice(0, 10)})…`);
      const order = await this.history.fetchOrder(s, this.storeId());
      this.ledger.appendOrder(order);
      imported.push(s.orderNo);
    }

    // 3. Resolution ------------------------------------------------------------
    const stats = this.ledger.purchaseStats();
    const todo = [...stats.values()].filter((p) => {
      const rec = this.ledger.product(p.productId);
      return opts.forceResolve || !rec || rec.status === "unresolved";
    });
    const counts = { byId: 0, byLabel: 0, missing: 0, unresolved: 0 };
    let blocked: string | undefined;
    if (todo.length > 0) {
      log(`résolution de ${todo.length} produit(s) contre le catalogue…`);
      const habitual = await this.history.habitualProducts();
      const byId = new Map(habitual.map((p) => [p.id, p]));
      let searches = 0;
      for (const p of todo) {
        const now = new Date().toISOString();
        const prev = this.ledger.product(p.productId);
        const hit = byId.get(p.productId);
        if (hit) {
          this.ledger.upsertProduct(recordFrom(p.productId, p.label, hit, "id", now, prev));
          counts.byId++;
          continue;
        }
        // Not among the habitual products: look it up by label (bounded).
        if (searches >= resolveLimit) {
          if (!prev) {
            this.ledger.upsertProduct({ productId: p.productId, label: p.label, status: "unresolved", resolvedAt: now });
          }
          counts.unresolved++;
          continue;
        }
        searches++;
        const query = p.label.split(" - ")[0].split(/\s+\d/)[0].slice(0, 60) || p.label;
        let found: Product | undefined;
        let kind: "label_exact" | "label_fuzzy" | undefined;
        try {
          const { products } = await this.client.searchProducts(query, { sort: "relevance", limit: 200 });
          const exactId = products.find((c) => c.id === p.productId);
          if (exactId) {
            this.ledger.upsertProduct(recordFrom(p.productId, p.label, exactId, "id", now, prev));
            counts.byId++;
            continue;
          }
          const m = bestLabelMatch(p.label, products, (c) => c.label);
          if (m) {
            found = m.item;
            kind = m.kind;
          }
        } catch (err) {
          log(`recherche « ${query} » échouée : ${(err as Error).message}`);
          counts.unresolved++;
          if (!prev) {
            this.ledger.upsertProduct({ productId: p.productId, label: p.label, status: "unresolved", resolvedAt: now });
          }
          if (isBlock(err)) {
            // DataDome strike: stop hammering, the rest stays "unresolved" for the next run.
            blocked = (err as Error).message;
            counts.unresolved += todo.length - todo.indexOf(p) - 1;
            break;
          }
          continue;
        }
        if (found && kind) {
          this.ledger.upsertProduct(recordFrom(p.productId, p.label, found, kind, now, prev));
          counts.byLabel++;
        } else {
          this.ledger.upsertProduct({
            productId: p.productId,
            label: p.label,
            status: "missing",
            resolvedAt: now,
            ean: prev?.ean,
            brand: prev?.brand,
            eanFetchedAt: prev?.eanFetchedAt,
          });
          counts.missing++;
        }
      }
    }

    // 4. EAN / brand from the product sheet (once per product) -----------------
    let eanFetched = 0;
    if (eanLimit > 0 && !blocked) {
      const pending = [...this.ledger.products().values()].filter(
        (r) => r.status === "active" && !r.eanFetchedAt && r.productUrl,
      );
      for (const r of pending.slice(0, eanLimit)) {
        try {
          const sheet = await this.history.productSheet(r.productUrl as string, r.currentId ?? r.productId);
          this.ledger.upsertProduct({
            ...r,
            ean: sheet.ean ?? r.ean,
            brand: sheet.brand ?? r.brand,
            eanFetchedAt: new Date().toISOString(),
          });
          eanFetched++;
        } catch (err) {
          log(`fiche produit ${r.currentId ?? r.productId} : ${(err as Error).message}`);
          if (isBlock(err)) {
            blocked = (err as Error).message;
            break;
          }
        }
      }
    }

    return {
      blocked,
      ordersSeen: summaries.length,
      ordersImported: imported,
      ordersSkipped: skipped,
      productsResolved: counts,
      eanFetched,
      ledger: this.ledger.summary(),
      durationMs: Date.now() - t0,
    };
  }
}

/** A DataDome / expired-session refusal, as raised by LeclercClient.send(). */
function isBlock(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Bloqué par Leclerc Drive|HTTP 403|HTTP 429|Session Leclerc Drive expirée/.test(m);
}

function recordFrom(
  productId: string,
  label: string,
  current: Product,
  matchType: ProductRecord["matchType"],
  now: string,
  prev?: ProductRecord,
): ProductRecord {
  return {
    productId,
    label,
    status: "active",
    matchType,
    currentId: current.id,
    currentLabel: current.label,
    price: current.price,
    promoPrice: current.promoPrice,
    pricePerUnitValue: current.pricePerUnitValue,
    unit: current.unit,
    available: current.available,
    aisleId: current.aisleId,
    familyId: current.familyId,
    productUrl: current.productUrl,
    ean: prev?.ean,
    brand: current.brand ?? prev?.brand,
    eanFetchedAt: prev?.eanFetchedAt,
    resolvedAt: now,
  };
}
