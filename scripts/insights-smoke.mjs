#!/usr/bin/env node
/**
 * Live, read-only check of the lot-3 tools against the ledger + site:
 * usual products, cart proposal (dry run), compare_products, find_substitutes.
 * Nothing is added to the cart.
 *
 *   npm run build && node scripts/insights-smoke.mjs [query]
 */
import { ChromeSession } from "../dist/browser.js";
import { loadConfig } from "../dist/config.js";
import { LeclercClient } from "../dist/leclerc/client.js";
import { usualProducts, proposeCart, compareProducts, findSubstitutes } from "../dist/leclerc/insights.js";
import { Ledger } from "../dist/ledger.js";
import { StoreState } from "../dist/store.js";

const query = process.argv[2] || "huile d'olive";
const config = loadConfig();
const browser = new ChromeSession({ chromePath: config.chromePath, profileDir: config.chromeProfileDir, port: config.chromePort, headless: config.headless });
const store = new StoreState(config);
const client = new LeclercClient(config, browser, store);
const ledger = new Ledger();
const t0 = Date.now();
const lap = (l) => console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`);

try {
  console.log("ledger:", JSON.stringify(ledger.summary()));

  lap("get_usual_products(min_orders=5, limit=12)");
  for (const u of usualProducts(ledger, { minOrders: 5, limit: 12 })) {
    const c = u.current;
    console.log(`  ${u.orders}/${u.totalOrders}  ~${u.avgQuantity}  last ${u.lastDate}  paid ~${u.medianPaid}  ${u.label}  → ${c?.status}${c?.available === false ? " INDISPO" : ""}${u.priceDeltaPct !== undefined ? ` ${u.priceDeltaPct}%` : ""}`);
  }

  lap("build_cart_from_history(last_n=1, dry_run)");
  const p = proposeCart(ledger, 1);
  console.log(`  orders ${p.orders} → ready ${p.ready.length} (≈${p.estimatedTotal} €), review ${p.review.length}, gone ${p.gone.length}`);
  for (const i of p.review.slice(0, 5)) console.log(`  review: ${i.label} — ${i.reason}`);
  for (const i of p.gone.slice(0, 5)) console.log(`  gone:   ${i.label} — ${i.reason}`);

  lap(`compare_products("${query}")`);
  const c = await compareProducts(ledger, client, query, 6);
  for (const g of c.groups) {
    console.log(`  per ${g.unit}:`);
    for (const { product: pr, timesBought, medianPaid, deltaPct, verdict } of g.items) {
      console.log(`    ${pr.pricePerUnit ?? "-"}  ${pr.price}€${pr.promoPrice ? ` promo ${pr.promoPrice}` : ""}  ${pr.label}${timesBought ? `  [bought ${timesBought}×, ~${medianPaid}, ${deltaPct}% → ${verdict}]` : ""}`);
    }
  }

  const gone = [...ledger.products().values()].find((r) => r.status === "missing") ;
  const indispo = [...ledger.products().values()].find((r) => r.status === "active" && r.available === false);
  for (const ref of [gone, indispo].filter(Boolean)) {
    lap(`find_substitutes(${ref.productId} "${ref.label}" [${ref.status}])`);
    const r = await findSubstitutes(ledger, client, { productId: ref.productId }, 4);
    for (const s of r.substitutes) console.log(`    ${s.score}  ${s.product.pricePerUnit ?? "-"}  ${s.product.price}€  ${s.product.label}  (${s.reasons.join(", ")})`);
  }
  lap("done");
} finally {
  await browser.close();
}
