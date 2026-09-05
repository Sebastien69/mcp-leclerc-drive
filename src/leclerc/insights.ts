/**
 * Lot 3 — high-level views on top of the ledger and the live catalogue:
 *
 *  - usualProducts():        recurring products with purchase frequency;
 *  - buildCartFromHistory(): what to re-add from the last N orders, split into
 *                            "safe to add" / "needs a decision" / "gone";
 *  - compareProducts():      per-unit price comparison for a query, with the
 *                            paid-price median from the ledger to tell a real
 *                            promo from a fake strike-through price;
 *  - findSubstitutes():      closest alternatives (same aisle, same unit, same
 *                            format, closest per-unit price) for a product.
 *
 * Only `buildCartFromHistory({ dryRun: false })` mutates anything (adds to cart).
 * Checkout, slot booking and payment stay manual — nothing here touches them.
 */

import { Ledger, median, ProductRecord, PurchaseStats } from "../ledger.js";
import { Product } from "../types.js";
import { LeclercClient } from "./client.js";
import { formatTokens, labelSimilarity, tokens } from "./resolve.js";

// ---- Usual products ----------------------------------------------------------

export interface UsualProduct {
  /** Historical id (ledger key). */
  productId: string;
  label: string;
  /** Orders containing the product / orders in the ledger. */
  orders: number;
  totalOrders: number;
  /** Average quantity per order containing it. */
  avgQuantity: number;
  lastDate: string;
  lastQuantity: number;
  /** Median unit price paid (before immediate discounts). */
  medianPaid?: number;
  /** Resolution against today's catalogue (may be undefined if not resolved yet). */
  current?: ProductRecord;
  /** Current best price (promo if any) vs median paid, in % (negative = cheaper). */
  priceDeltaPct?: number;
}

export function usualProducts(ledger: Ledger, opts: { minOrders?: number; limit?: number } = {}): UsualProduct[] {
  const minOrders = opts.minOrders ?? 2;
  const totalOrders = ledger.orders().length;
  const out: UsualProduct[] = [];
  for (const s of ledger.purchaseStats().values()) {
    if (s.orders < minOrders) continue;
    out.push(toUsual(s, totalOrders, ledger.product(s.productId)));
  }
  out.sort((a, b) => b.orders - a.orders || b.lastDate.localeCompare(a.lastDate));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function toUsual(s: PurchaseStats, totalOrders: number, current?: ProductRecord): UsualProduct {
  const medianPaid = median(s.unitPrices);
  const now = currentBestPrice(current);
  return {
    productId: s.productId,
    label: s.label,
    orders: s.orders,
    totalOrders,
    avgQuantity: Math.round((s.totalQuantity / s.orders) * 10) / 10,
    lastDate: s.lastDate.slice(0, 10),
    lastQuantity: s.lastQuantity,
    medianPaid,
    current,
    priceDeltaPct:
      medianPaid && now !== undefined ? Math.round(((now - medianPaid) / medianPaid) * 100) : undefined,
  };
}

function currentBestPrice(rec?: ProductRecord): number | undefined {
  if (!rec || rec.status !== "active" || rec.price === undefined) return undefined;
  return rec.promoPrice !== undefined && rec.promoPrice < rec.price ? rec.promoPrice : rec.price;
}

// ---- Cart from history -------------------------------------------------------

export interface CartProposalItem {
  productId: string;
  label: string;
  quantity: number;
  /** Id to add to the cart (current catalogue id). */
  addId?: string;
  currentLabel?: string;
  price?: number;
  reason: string;
}

export interface CartProposal {
  /** From these orders (newest first). */
  orders: string[];
  /** Same product still in the catalogue and orderable: safe to add. */
  ready: CartProposalItem[];
  /** Resolved by fuzzy label match or currently unavailable: needs a decision. */
  review: CartProposalItem[];
  /** Missing from the catalogue or not resolved yet. */
  gone: CartProposalItem[];
  /** Filled when dryRun is false. */
  added?: { productId: string; quantity: number }[];
  failed?: { productId: string; error: string }[];
  estimatedTotal: number;
}

export function proposeCart(ledger: Ledger, lastN = 1): CartProposal {
  const orders = ledger.orders().slice(0, Math.max(1, lastN));
  // Quantity: the most recent order's quantity for that product.
  const seen = new Map<string, { label: string; quantity: number }>();
  for (const o of orders) {
    for (const l of o.lines) {
      if (!seen.has(l.productId)) seen.set(l.productId, { label: l.label, quantity: l.quantity });
    }
  }
  const proposal: CartProposal = { orders: orders.map((o) => o.orderNo), ready: [], review: [], gone: [], estimatedTotal: 0 };
  for (const [productId, { label, quantity }] of seen) {
    const rec = ledger.product(productId);
    const base: CartProposalItem = { productId, label, quantity, reason: "" };
    if (!rec || rec.status === "unresolved") {
      proposal.gone.push({ ...base, reason: "non résolu — relance import_order_history" });
      continue;
    }
    if (rec.status === "missing") {
      proposal.gone.push({ ...base, reason: "disparu du catalogue" });
      continue;
    }
    const item: CartProposalItem = {
      ...base,
      addId: rec.currentId,
      currentLabel: rec.currentLabel,
      price: currentBestPrice(rec),
      reason: "",
    };
    if (rec.available === false) {
      proposal.review.push({ ...item, reason: "indisponible actuellement — voir find_substitutes" });
    } else if (rec.matchType === "label_fuzzy") {
      proposal.review.push({ ...item, reason: `correspondance approximative : « ${rec.currentLabel} »` });
    } else {
      proposal.ready.push({ ...item, reason: rec.matchType === "label_exact" ? "même libellé, nouvel id" : "identique" });
      proposal.estimatedTotal += (item.price ?? 0) * quantity;
    }
  }
  proposal.estimatedTotal = Math.round(proposal.estimatedTotal * 100) / 100;
  return proposal;
}

export async function buildCartFromHistory(
  ledger: Ledger,
  client: LeclercClient,
  opts: { lastN?: number; dryRun?: boolean; skipIds?: string[]; onProgress?: (m: string) => void } = {},
): Promise<CartProposal> {
  const proposal = proposeCart(ledger, opts.lastN ?? 1);
  if (opts.dryRun ?? true) return proposal;
  const skip = new Set(opts.skipIds ?? []);
  proposal.added = [];
  proposal.failed = [];
  for (const it of proposal.ready) {
    if (!it.addId || skip.has(it.productId) || skip.has(it.addId)) continue;
    try {
      opts.onProgress?.(`ajout ${it.quantity}× ${it.label}`);
      await client.addToCart(it.addId, it.quantity);
      proposal.added.push({ productId: it.addId, quantity: it.quantity });
    } catch (err) {
      proposal.failed.push({ productId: it.addId, error: (err as Error).message });
    }
  }
  return proposal;
}

// ---- Compare products --------------------------------------------------------

export interface ComparedProduct {
  product: Product;
  /** Times bought (from the ledger), when known. */
  timesBought?: number;
  medianPaid?: number;
  /** Best current price vs median paid, in %. */
  deltaPct?: number;
  /** "vraie promo" when today's best price is ≥ 10 % under the median paid. */
  verdict?: "vraie promo" | "prix habituel" | "plus cher qu'avant";
}

export interface Comparison {
  query: string;
  total: number;
  /** Grouped by unit so per-unit prices are only compared like with like. */
  groups: { unit: string; items: ComparedProduct[] }[];
}

export async function compareProducts(
  ledger: Ledger,
  client: LeclercClient,
  query: string,
  limit = 15,
): Promise<Comparison> {
  const { products: all, total } = await client.searchProducts(query, { sort: "price_per_unit", limit: 200 });
  const products = focusOnQuery(query, all);
  const history = historyByCurrentId(ledger);
  const byUnit = new Map<string, ComparedProduct[]>();
  for (const p of products) {
    const unit = p.unit ?? "?";
    const list = byUnit.get(unit) ?? [];
    if (list.length >= limit) continue;
    list.push(withHistory(p, history.get(p.id)));
    byUnit.set(unit, list);
  }
  const groups = [...byUnit.entries()]
    .map(([unit, items]) => ({ unit, items }))
    .sort((a, b) => b.items.length - a.items.length);
  return { query, total, groups };
}

/**
 * Leclerc's search is loose ("huile d'olive" returns hand soap and vinaigrette
 * "à l'huile d'olive"). Keep the products whose label carries every query token
 * when that leaves enough to compare; otherwise fall back to the full list.
 */
export function focusOnQuery(query: string, products: Product[], minKeep = 3): Product[] {
  const q = [...tokens(query)].filter((t) => t.length > 2);
  if (q.length === 0) return products;
  const strict = products.filter((p) => {
    const lt = tokens(p.label);
    return q.every((t) => lt.has(t) || [...lt].some((x) => x.startsWith(t) || t.startsWith(x)));
  });
  return strict.length >= minKeep ? strict : products;
}

function withHistory(p: Product, stats?: PurchaseStats): ComparedProduct {
  const out: ComparedProduct = { product: p };
  if (!stats) return out;
  out.timesBought = stats.orders;
  out.medianPaid = median(stats.unitPrices);
  const best = p.promoPrice !== undefined && p.promoPrice < p.price ? p.promoPrice : p.price;
  if (out.medianPaid) {
    out.deltaPct = Math.round(((best - out.medianPaid) / out.medianPaid) * 100);
    out.verdict = out.deltaPct <= -10 ? "vraie promo" : out.deltaPct >= 10 ? "plus cher qu'avant" : "prix habituel";
  }
  return out;
}

/** Purchase stats keyed by the CURRENT catalogue id (via the ledger's resolutions). */
export function historyByCurrentId(ledger: Ledger): Map<string, PurchaseStats> {
  const out = new Map<string, PurchaseStats>();
  const stats = ledger.purchaseStats();
  for (const [productId, s] of stats) {
    const rec = ledger.product(productId);
    const key = rec?.status === "active" && rec.currentId ? rec.currentId : productId;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...s, unitPrices: [...s.unitPrices] });
    } else {
      // Two historical ids resolved to the same current product: merge.
      prev.orders += s.orders;
      prev.totalQuantity += s.totalQuantity;
      prev.unitPrices.push(...s.unitPrices);
      if (s.lastDate > prev.lastDate) {
        prev.lastDate = s.lastDate;
        prev.lastQuantity = s.lastQuantity;
        prev.label = s.label;
      }
      if (s.firstDate < prev.firstDate) prev.firstDate = s.firstDate;
    }
  }
  return out;
}

// ---- Substitutes -------------------------------------------------------------

export interface Substitute {
  product: Product;
  score: number;
  reasons: string[];
}

export interface SubstituteReference {
  label: string;
  aisleId?: string;
  unit?: string;
  pricePerUnitValue?: number;
  price?: number;
  brand?: string;
}

/**
 * Rank candidates for a reference product: same aisle, same unit (required when
 * both known), same format, closest per-unit price, closest label/brand. Pure.
 */
export function rankSubstitutes(ref: SubstituteReference, candidates: Product[], excludeId?: string): Substitute[] {
  const refFormat = formatTokens(ref.label);
  const out: Substitute[] = [];
  for (const c of candidates) {
    if (excludeId && c.id === excludeId) continue;
    if (!c.available) continue;
    if (ref.unit && c.unit && ref.unit !== c.unit) continue;
    let score = 0;
    const reasons: string[] = [];
    if (ref.aisleId && c.aisleId === ref.aisleId) {
      score += 3;
      reasons.push("même rayon");
    }
    const cf = formatTokens(c.label);
    if (refFormat.size && cf.size && [...refFormat].every((t) => cf.has(t)) && refFormat.size === cf.size) {
      score += 2;
      reasons.push("même format");
    }
    if (ref.brand && c.label.toLowerCase().includes(ref.brand.toLowerCase())) {
      score += 2;
      reasons.push("même marque");
    }
    const sim = labelSimilarity(ref.label, c.label);
    score += sim * 3;
    if (ref.pricePerUnitValue && c.pricePerUnitValue) {
      const rel = Math.abs(c.pricePerUnitValue - ref.pricePerUnitValue) / ref.pricePerUnitValue;
      score += Math.max(0, 2 - rel * 4); // 0 % away → +2, ≥ 50 % away → 0
      if (c.pricePerUnitValue <= ref.pricePerUnitValue) reasons.push("moins cher ou égal au " + (c.unit ?? "unité"));
    }
    out.push({ product: c, score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function findSubstitutes(
  ledger: Ledger,
  client: LeclercClient,
  ref: { productId?: string; label?: string },
  limit = 5,
): Promise<{ reference: SubstituteReference; substitutes: Substitute[] }> {
  let reference: SubstituteReference | undefined;
  let excludeId: string | undefined;
  if (ref.productId) {
    const rec = ledger.product(ref.productId) ?? [...ledger.products().values()].find((r) => r.currentId === ref.productId);
    // Missing products have no catalogue data in their record: fall back to the
    // aisle recorded on their order lines.
    const aisleFromOrders = (id: string): string | undefined => {
      for (const o of ledger.orders()) {
        const l = o.lines.find((x) => x.productId === id && x.aisleId);
        if (l) return l.aisleId;
      }
      return undefined;
    };
    if (rec) {
      reference = {
        label: rec.currentLabel ?? rec.label,
        aisleId: rec.aisleId ?? aisleFromOrders(rec.productId),
        unit: rec.unit,
        pricePerUnitValue: rec.pricePerUnitValue,
        price: rec.price,
        brand: rec.brand,
      };
      excludeId = rec.currentId ?? rec.productId;
    } else {
      const s = ledger.purchaseStats().get(ref.productId);
      if (s) reference = { label: s.label, aisleId: aisleFromOrders(ref.productId) };
      excludeId = ref.productId;
    }
  }
  if (!reference && ref.label) reference = { label: ref.label };
  if (!reference) throw new Error("Indique un product_id connu du ledger ou un libellé.");

  // Query on the first label line (before the format part), like the resolver.
  const query = reference.label.split(" - ")[0].split(/\s+\d/)[0].slice(0, 60) || reference.label;
  const { products } = await client.searchProducts(query, { sort: "relevance", limit: 200 });
  return { reference, substitutes: rankSubstitutes(reference, products, excludeId).slice(0, limit) };
}
