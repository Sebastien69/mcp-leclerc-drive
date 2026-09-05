/**
 * Shared domain types for the Leclerc Drive MCP server.
 *
 * These are the shapes the MCP tools expose to the model. The raw shapes
 * returned by the Leclerc Drive backend are mapped into these in the client
 * layer (see src/leclerc/client.ts). Field availability was verified live on
 * 2026-09-05 (search page + "Mes produits habituels") — see docs/api-capture.md.
 */

export interface Product {
  /** Product identifier used by add_to_cart / update_quantity. ⚠️ Not stable
   *  over months (re-referencing, packaging changes) — see docs/api-capture.md §7. */
  id: string;
  /** Display label, e.g. "Lait demi-écrémé UHT Délisse Bouteille - 6x1L". */
  label: string;
  /** Brand when the site exposes it. Not present in search results (only on the
   *  product page as `sLibelleMarque`); usually undefined here. */
  brand?: string;
  /** Unit price in euros, e.g. 6.30. */
  price: number;
  /** Advertised promo price in euros, when the site sets one (`sPrixPromo` > 0). */
  promoPrice?: number;
  /** Price per kilo / litre as displayed, e.g. "1,05 € / l". */
  pricePerUnit?: string;
  /** Same, numeric (e.g. 1.05) — use this to sort and compare. */
  pricePerUnitValue?: number;
  /** Unit of measure `pricePerUnitValue` refers to: "kg", "l", "pièce"… Only
   *  compare per-unit prices between products sharing the same unit. */
  unit?: string;
  /** Total content in `unit`, e.g. 6 (litres) for a 6×1 L pack. */
  content?: number;
  /** Nutri-Score letter A–E, when available. */
  nutriScore?: string;
  /** Whether the item is currently orderable in the selected store. */
  available: boolean;
  /** Stock quantity exposed by the site (`iQteDisponible`), when present. */
  stock?: number;
  /** Aisle id (`iIdRayon`) — used to look for substitutes in the same aisle. */
  aisleId?: string;
  /** Family id (`iIdFamille`), finer than the aisle. */
  familyId?: string;
  /** Thumbnail image URL, when available. */
  imageUrl?: string;
  /** Product page URL (relative), when available. */
  productUrl?: string;
}

export type SearchSort = "price_per_unit" | "price" | "relevance";

export interface SearchOptions {
  /** Sort order. Default: price per unit ascending (available products first). */
  sort?: SearchSort;
  /** Max number of products returned. Applied AFTER sorting. */
  limit?: number;
}

export interface SearchResult {
  products: Product[];
  /** Number of products found before `limit` was applied. */
  total: number;
}

export interface CartItem {
  product: Product;
  quantity: number;
  /** quantity * unit price, in euros. */
  lineTotal: number;
}

export interface Cart {
  items: CartItem[];
  /** Number of distinct lines in the cart. */
  itemCount: number;
  /** Sum of all line totals, in euros. */
  total: number;
  storeId: string;
}
