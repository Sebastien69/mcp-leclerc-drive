#!/usr/bin/env node
/**
 * Manual end-to-end smoke test, against the LIVE site, via the real-Chrome
 * (CDP) backend. A Chrome window opens — log into Leclerc Drive in it first.
 *
 * ⚠️ This hits your real Leclerc Drive account: it adds one item to your cart,
 * reads/updates it, then removes it (cleans up after itself). Run only with your
 * own session. Requires `npm run build` first and Google Chrome installed.
 *
 *   npm run build && npm run smoke [search-term]
 */

import { ChromeSession } from "../dist/browser.js";
import { loadConfig } from "../dist/config.js";
import { LeclercClient } from "../dist/leclerc/client.js";
import { StoreLocator } from "../dist/leclerc/locator.js";
import { StoreState } from "../dist/store.js";

const term = process.argv[2] || "café";
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

const showCart = (label, c) =>
  console.log(
    `${label}: ${c.itemCount} item(s), ${c.total} EUR — ` +
      (c.items.map((i) => `${i.quantity}x ${i.product.label} [${i.product.id}] =${i.lineTotal}`).join(" | ") ||
        "(empty)"),
  );

try {
  const s = store.current();
  console.log(`Store ${s.storeId} @ ${s.host}\n`);

  console.log(`0) find_stores("${config.storeId.slice(0, 2)}...")`);
  const near = await locator.findStores("44000");
  console.log(`   → ${near.length} drives near 44000 (e.g. ${near[0]?.name})\n`);

  console.log(`1) search_product("${term}")`);
  const { products, total } = await client.searchProducts(term, { limit: 30 });
  console.log(`   → ${total} products (showing ${products.length}, sorted by price per unit)`);
  for (const p of products.slice(0, 3)) {
    console.log(`   ${p.pricePerUnit ?? "-"}  ${p.price} EUR  ${p.available ? "" : "[indispo] "}${p.label}`);
  }
  const target = products.find((p) => p.available);
  if (!target) throw new Error("No available product found to test the cart with.");
  console.log(`   using: ${target.label} [${target.id}] @ ${target.price} EUR\n`);

  console.log(`2) add_to_cart(${target.id}, 2)`);
  showCart("   cart", await client.addToCart(target.id, 2));

  console.log(`\n3) get_cart()`);
  showCart("   cart", await client.getCart());

  console.log(`\n4) update_quantity(${target.id}, 1)`);
  showCart("   cart", await client.updateQuantity(target.id, 1));

  console.log(`\n5) remove_from_cart(${target.id})`);
  showCart("   cart", await client.removeFromCart(target.id));

  console.log(`\n6) get_cart() — should be empty`);
  showCart("   cart", await client.getCart());

  console.log("\n✓ smoke test complete (cart cleaned up).");
} finally {
  await browser.close();
}
