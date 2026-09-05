import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../dist/ledger.js";
import { usualProducts, proposeCart, rankSubstitutes, historyByCurrentId, focusOnQuery } from "../dist/leclerc/insights.js";

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "insights-"));
  const l = new Ledger(dir);
  const line = (productId, label, quantity, unitPrice) => ({ productId, label, quantity, lineTotal: unitPrice * quantity, unitPrice });
  l.appendOrder({ orderNo: "C", date: "2026-09-01T10:00:00", storeId: "s", importedAt: "x", lines: [
    line("1", "Lait Délisse 6x1L", 2, 6.3), line("2", "Poulet Le Gaulois 300g", 1, 3.79), line("3", "Badoit 6x1L", 2, 3.61), line("4", "Ketchup Heinz 250g", 1, 2.5),
  ]});
  l.appendOrder({ orderNo: "B", date: "2026-08-01T10:00:00", storeId: "s", importedAt: "x", lines: [
    line("1", "Lait Délisse 6x1L", 2, 6.9), line("2", "Poulet Le Gaulois 300g", 2, 3.99),
  ]});
  l.appendOrder({ orderNo: "A", date: "2026-07-01T10:00:00", storeId: "s", importedAt: "x", lines: [
    line("1", "Lait Délisse 6x1L", 1, 6.6), line("9", "Vieux lait", 1, 6.0),
  ]});
  l.upsertProduct({ productId: "1", label: "Lait Délisse 6x1L", status: "active", matchType: "id", currentId: "1", currentLabel: "Lait Délisse 6x1L", price: 6.6, promoPrice: 5.5, available: true, unit: "l", pricePerUnitValue: 0.92, aisleId: "R1", resolvedAt: "t" });
  l.upsertProduct({ productId: "2", label: "Poulet Le Gaulois 300g", status: "active", matchType: "label_fuzzy", currentId: "22", currentLabel: "Poulet Le Gaulois Label 300g", price: 4.1, available: true, resolvedAt: "t" });
  l.upsertProduct({ productId: "3", label: "Badoit 6x1L", status: "missing", resolvedAt: "t" });
  l.upsertProduct({ productId: "9", label: "Vieux lait", status: "active", matchType: "label_exact", currentId: "1", currentLabel: "Lait Délisse 6x1L", price: 6.6, available: true, resolvedAt: "t" });
  // "4" left unresolved on purpose (no record)
  return { dir, l };
}

test("usualProducts: frequency, median paid, price delta vs current best price", () => {
  const { dir, l } = seeded();
  try {
    const u = usualProducts(l, { minOrders: 2 });
    assert.deepEqual(u.map((x) => x.productId), ["1", "2"]);
    const lait = u[0];
    assert.equal(lait.orders, 3);
    assert.equal(lait.totalOrders, 3);
    assert.equal(lait.medianPaid, 6.6);
    assert.equal(lait.avgQuantity, 1.7);
    assert.equal(lait.lastQuantity, 2);
    assert.equal(lait.priceDeltaPct, -17); // promo 5.5 vs median 6.6
    assert.equal(usualProducts(l, { minOrders: 3 }).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("proposeCart: ready / review / gone split from the last order", () => {
  const { dir, l } = seeded();
  try {
    const p = proposeCart(l, 1);
    assert.deepEqual(p.orders, ["C"]);
    assert.deepEqual(p.ready.map((i) => [i.addId, i.quantity, i.price]), [["1", 2, 5.5]]);
    assert.deepEqual(p.review.map((i) => i.addId), ["22"]); // fuzzy ⇒ needs a decision
    assert.deepEqual(p.gone.map((i) => i.productId).sort(), ["3", "4"]);
    assert.equal(p.estimatedTotal, 11);
    // last 3 orders: quantities come from the most recent order containing the product
    const p3 = proposeCart(l, 3);
    assert.equal(p3.ready.find((i) => i.productId === "1").quantity, 2);
    assert.ok(p3.ready.some((i) => i.productId === "9")); // label_exact ⇒ ready
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("historyByCurrentId merges historical ids resolved to the same current product", () => {
  const { dir, l } = seeded();
  try {
    const h = historyByCurrentId(l);
    const lait = h.get("1");
    assert.equal(lait.orders, 4); // 3 orders of "1" + 1 of "9"
    assert.equal(lait.unitPrices.length, 4);
    assert.equal(h.get("22").orders, 2); // fuzzy match still keyed on current id
    assert.equal(h.get("3").orders, 1); // missing ⇒ historical id
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rankSubstitutes: same unit required, aisle/format/price closeness rewarded", () => {
  const ref = { label: "Eau gazeuse Badoit rouge - 6x1l", aisleId: "R9", unit: "l", pricePerUnitValue: 0.6, brand: "Badoit" };
  const c = (id, label, extra) => ({ id, label, price: 3, available: true, ...extra });
  const cands = [
    c("a", "Eau gazeuse Perrier fines bulles - 6x1l", { unit: "l", pricePerUnitValue: 0.62, aisleId: "R9" }),
    c("b", "Eau gazeuse Badoit verte - 6x1l", { unit: "l", pricePerUnitValue: 0.6, aisleId: "R9" }),
    c("c", "Eau gazeuse Perrier - 6x50cl", { unit: "l", pricePerUnitValue: 1.2, aisleId: "R9" }),
    c("d", "Chips gazeuses 6x1l", { unit: "kg", pricePerUnitValue: 0.6, aisleId: "R9" }),
    c("e", "Eau gazeuse Badoit rouge - 6x1l", { unit: "l", pricePerUnitValue: 0.6, aisleId: "R9", available: false }),
    c("ref", "Eau gazeuse Badoit rouge - 6x1l", { unit: "l", pricePerUnitValue: 0.6, aisleId: "R9" }),
  ];
  const r = rankSubstitutes(ref, cands, "ref");
  assert.deepEqual(r.map((x) => x.product.id), ["b", "a", "c"]); // d (other unit), e (unavailable), ref excluded
  assert.ok(r[0].reasons.includes("même marque"));
  assert.ok(r[0].reasons.includes("même format"));
  assert.ok(r[0].reasons.includes("même rayon"));
});

test("focusOnQuery keeps products carrying every query token when enough remain", () => {
  const p = (id, label) => ({ id, label, price: 1, available: true });
  const all = [
    p("1", "Recharge savon mains Manava Gel lavande - 250ml"),
    p("2", "Huile d'olive Rustica Vierge extra - 50cl"),
    p("3", "Huile d'olive Puget Classique - 1L"),
    p("4", "Huile colza et olive Bio Soleou 75cl"),
    p("5", "Gel lavant mains Le Petit Marseillais Huile d'olive 300ml"),
  ];
  assert.deepEqual(focusOnQuery("huile d'olive", all).map((x) => x.id), ["2", "3", "4", "5"]);
  // Too few strict hits ⇒ full list
  assert.equal(focusOnQuery("huile d'olive puget", all).length, 5);
  assert.equal(focusOnQuery("", all).length, 5);
});
