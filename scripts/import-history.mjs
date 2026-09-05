#!/usr/bin/env node
/**
 * Run import_order_history from the command line (same code path as the MCP
 * tool), against the LIVE site through the server's Chrome. Read-only on the
 * Leclerc side; writes ~/.mcp-leclerc-drive/{orders,products}.jsonl.
 *
 *   npm run build && node scripts/import-history.mjs [limit] [resolveLimit] [eanLimit]
 */

import { ChromeSession } from "../dist/browser.js";
import { loadConfig } from "../dist/config.js";
import { LeclercClient } from "../dist/leclerc/client.js";
import { HistoryClient } from "../dist/leclerc/history.js";
import { HistoryImporter } from "../dist/leclerc/importer.js";
import { Ledger } from "../dist/ledger.js";
import { StoreState } from "../dist/store.js";

const [limit = "20", resolveLimit = "40", eanLimit = "25"] = process.argv.slice(2);
const config = loadConfig();
const browser = new ChromeSession({
  chromePath: config.chromePath,
  profileDir: config.chromeProfileDir,
  port: config.chromePort,
  headless: config.headless,
});
const store = new StoreState(config);
const client = new LeclercClient(config, browser, store);
const ledger = new Ledger();
const importer = new HistoryImporter(client, new HistoryClient(client), ledger, () => store.current().storeId);

try {
  const s = store.current();
  console.log(`Store ${s.storeId} @ ${s.host} — ledger: ${JSON.stringify(ledger.summary())}\n`);
  const r = await importer.run({
    limit: Number(limit),
    resolveLimit: Number(resolveLimit),
    eanLimit: Number(eanLimit),
    onProgress: (m) => console.log(`  … ${m}`),
  });
  console.log("\n" + JSON.stringify(r, null, 2));
} finally {
  await browser.close();
}
