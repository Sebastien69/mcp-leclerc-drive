/**
 * Purchase ledger — what was actually bought, imported from Leclerc's order
 * history (see docs/api-capture.md §7) and re-resolved against today's catalogue.
 *
 * Storage: append-only JSONL under ~/.mcp-leclerc-drive/ (next to config.json
 * and the Chrome profile). Two files:
 *
 *  - orders.jsonl    one line per imported order, deduplicated by order number.
 *  - products.jsonl  one line per (product, resolution event); the LAST line
 *                    for a product id wins. Appending instead of rewriting keeps
 *                    the price/availability history and makes writes crash-safe.
 *
 * ⚠️ Product ids drift over time (re-referencing, packaging). Orders keep the id
 * Leclerc used at the time; ProductRecord.currentId is the id that resolves in
 * today's catalogue (or absent when the product is `missing`). Never index on
 * the raw historical id alone.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OrderLine {
  /** Product id as it appeared in the order (may no longer exist). */
  productId: string;
  label: string;
  quantity: number;
  /** Line total before immediate discounts, in euros. */
  lineTotal: number;
  /** lineTotal / quantity, in euros. */
  unitPrice: number;
  /** Aisle id parsed from the "Voir le rayon" link, when present. */
  aisleId?: string;
  /** Aisle heading the line was listed under, e.g. "Fruits Légumes". */
  aisle?: string;
}

export interface OrderRecord {
  orderNo: string;
  /** ISO date-time of the order (local), e.g. "2026-09-01T10:27:00". */
  date: string;
  storeId: string;
  state?: string;
  service?: string;
  /** Grand total paid, in euros. */
  total?: number;
  deliveryFee?: number;
  savings?: number;
  /** Total quantity as displayed ("55 produits"). */
  itemCount?: number;
  lines: OrderLine[];
  importedAt: string;
}

export type ResolutionStatus = "active" | "missing" | "unresolved";
export type MatchType = "id" | "label_exact" | "label_fuzzy";

export interface ProductRecord {
  /** Historical product id (key). */
  productId: string;
  /** Label as seen in orders. */
  label: string;
  status: ResolutionStatus;
  matchType?: MatchType;
  /** Id that resolves in today's catalogue (== productId when matched by id). */
  currentId?: string;
  currentLabel?: string;
  price?: number;
  promoPrice?: number;
  pricePerUnitValue?: number;
  unit?: string;
  available?: boolean;
  aisleId?: string;
  familyId?: string;
  productUrl?: string;
  /** From the product sheet (fetched once, cached here). */
  ean?: string;
  brand?: string;
  eanFetchedAt?: string;
  resolvedAt: string;
}

export const DEFAULT_LEDGER_DIR = join(homedir(), ".mcp-leclerc-drive");

export class Ledger {
  private ordersCache?: OrderRecord[];
  private productsCache?: Map<string, ProductRecord>;

  constructor(private readonly dir: string = DEFAULT_LEDGER_DIR) {}

  get ordersPath(): string {
    return join(this.dir, "orders.jsonl");
  }
  get productsPath(): string {
    return join(this.dir, "products.jsonl");
  }
  get metaPath(): string {
    return join(this.dir, "ledger-meta.json");
  }

  // ---- Meta (last import) --------------------------------------------------

  /** ISO time of the last completed import, or undefined. */
  lastImportAt(): string | undefined {
    try {
      if (!existsSync(this.metaPath)) return undefined;
      const m = JSON.parse(readFileSync(this.metaPath, "utf8"));
      return typeof m.lastImportAt === "string" ? m.lastImportAt : undefined;
    } catch {
      return undefined;
    }
  }

  markImported(at: Date = new Date()): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify({ lastImportAt: at.toISOString() }, null, 2) + "\n", "utf8");
  }

  /** True when no import happened in the last `maxAgeHours`. */
  isStale(maxAgeHours: number, now: Date = new Date()): boolean {
    const last = this.lastImportAt();
    if (!last) return true;
    return now.getTime() - new Date(last).getTime() > maxAgeHours * 3600 * 1000;
  }

  // ---- Orders ------------------------------------------------------------

  orders(): OrderRecord[] {
    if (!this.ordersCache) {
      const byNo = new Map<string, OrderRecord>();
      for (const o of readJsonl<OrderRecord>(this.ordersPath)) {
        if (o && typeof o.orderNo === "string") byNo.set(o.orderNo, o);
      }
      this.ordersCache = [...byNo.values()].sort((a, b) => b.date.localeCompare(a.date));
    }
    return this.ordersCache;
  }

  hasOrder(orderNo: string): boolean {
    return this.orders().some((o) => o.orderNo === orderNo);
  }

  appendOrder(order: OrderRecord): void {
    if (this.hasOrder(order.orderNo)) return;
    appendJsonl(this.ordersPath, order);
    this.ordersCache = undefined;
  }

  // ---- Products ----------------------------------------------------------

  /** Latest record per historical product id. */
  products(): Map<string, ProductRecord> {
    if (!this.productsCache) {
      const m = new Map<string, ProductRecord>();
      for (const p of readJsonl<ProductRecord>(this.productsPath)) {
        if (p && typeof p.productId === "string") m.set(p.productId, p);
      }
      this.productsCache = m;
    }
    return this.productsCache;
  }

  product(productId: string): ProductRecord | undefined {
    return this.products().get(productId);
  }

  /** Append a new resolution event (becomes the current record). */
  upsertProduct(rec: ProductRecord): void {
    appendJsonl(this.productsPath, rec);
    this.products().set(rec.productId, rec);
  }

  /** All product ids seen in orders, with aggregate purchase stats. */
  purchaseStats(): Map<string, PurchaseStats> {
    const stats = new Map<string, PurchaseStats>();
    for (const o of this.orders()) {
      for (const l of o.lines) {
        let s = stats.get(l.productId);
        if (!s) {
          s = {
            productId: l.productId,
            label: l.label,
            orders: 0,
            totalQuantity: 0,
            unitPrices: [],
            firstDate: o.date,
            lastDate: o.date,
            lastQuantity: l.quantity,
          };
          stats.set(l.productId, s);
        }
        s.orders++;
        s.totalQuantity += l.quantity;
        if (l.unitPrice > 0) s.unitPrices.push(l.unitPrice);
        if (o.date < s.firstDate) s.firstDate = o.date;
        if (o.date >= s.lastDate) {
          s.lastDate = o.date;
          s.lastQuantity = l.quantity;
          s.label = l.label;
        }
      }
    }
    return stats;
  }

  summary(): { orders: number; products: number; from?: string; to?: string; missing: number; unresolved: number } {
    const orders = this.orders();
    const prods = [...this.products().values()];
    return {
      orders: orders.length,
      products: this.purchaseStats().size,
      from: orders.length ? orders[orders.length - 1].date.slice(0, 10) : undefined,
      to: orders.length ? orders[0].date.slice(0, 10) : undefined,
      missing: prods.filter((p) => p.status === "missing").length,
      unresolved: prods.filter((p) => p.status === "unresolved").length,
    };
  }
}

export interface PurchaseStats {
  productId: string;
  label: string;
  /** Number of orders containing the product. */
  orders: number;
  totalQuantity: number;
  /** Unit prices paid (before immediate discounts), one per order. */
  unitPrices: number[];
  firstDate: string;
  lastDate: string;
  lastQuantity: number;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- JSONL helpers ---------------------------------------------------------

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      /* skip a torn/corrupt line rather than losing the whole ledger */
    }
  }
  return out;
}

function appendJsonl(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + "\n", "utf8");
}
