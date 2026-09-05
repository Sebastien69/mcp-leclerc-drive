# mcp-leclerc-drive

> The first open-source **MCP server for E.Leclerc Drive** — let Claude search products, manage a cart, and prepare grocery orders natively, instead of clicking through the website.

> 🟢 **v0.3 — working & DataDome-proof.** All eight tools are validated end-to-end against the live site. Requests run inside a **real Chrome driven over CDP**, so they pass DataDome's bot protection (which blocks headless clients and cookie-replay). You log into Leclerc Drive once in the window that opens; the session persists. See [`docs/api-capture.md`](docs/api-capture.md) for the reverse-engineered API.

## Why

E.Leclerc Drive has no public API. Today the only way to automate it is browser automation — slow (~3–5 s per item) and fragile (blind clicks). This project exposes the underlying operations as proper MCP tools so any MCP client (Claude Desktop, Claude Code) can drive it directly.

## Tools

| Tool | Description |
| --- | --- |
| `find_stores(query)` | Find drives near a postal code or city → name, id, service type, distance, host. |
| `set_store(store_id)` | Select & remember the active store (resolves the right host automatically). |
| `get_store()` | Show the currently selected store. |
| `import_order_history(limit?, resolve_limit?, ean_limit?)` | Import past orders from « Mes commandes » into a local ledger (`~/.mcp-leclerc-drive/*.jsonl`), dedup by order number, re-resolve products against today's catalogue, flag disappeared ones. Idempotent — run it at the start of a session. |
| `get_order_history(order_no?)` | List imported orders, or the lines of one order with paid prices and current product status. |
| `search_product(query, sort?, limit?)` | Search the catalogue → products with price (+ promo), numeric price per kg/L, availability, aisle id and an `id`. Sorted by price per unit by default (available first), sort applied **before** `limit` (default 20). |
| `add_to_cart(product_id, quantity?)` | Add a product to the cart. |
| `remove_from_cart(product_id)` | Remove a line from the cart. |
| `update_quantity(product_id, quantity)` | Set a line's quantity (0 removes it). |
| `get_cart()` | Read the full cart with total. |

## Status

- [x] Reverse-engineer Leclerc Drive endpoints (search / cart / store locator — see [`docs/api-capture.md`](docs/api-capture.md))
- [x] All 8 tools validated end-to-end against the live store
- [x] Runtime store selection with persistence (`find_stores` / `set_store`)
- [x] **v0.3: DataDome-proof via real-Chrome CDP driving** (beats active bot-challenge that killed cookie-replay) ✅
- [x] Published to npm + MCP registry
- [ ] Checkout / delivery-slot booking

## Requirements

- **Node.js ≥ 22** (uses the built-in `WebSocket`)
- **Google Chrome** installed (the server drives it via CDP)

## Install (development)

```bash
git clone https://github.com/skunkobi/mcp-leclerc-drive.git
cd mcp-leclerc-drive
npm install
npm run build
```

## How auth works (real Chrome via CDP)

Leclerc Drive is protected by [DataDome](https://datadome.co/), which blocks
non-browser traffic (headless clients, cookie-replay) with HTTP 403 once it
escalates to active challenge mode. The only thing that reliably passes is a
**real browser** that executes the challenge. So that's what the server uses:

1. On first request it launches **your installed Google Chrome** with a
   dedicated, persistent profile (`~/.mcp-leclerc-drive/chrome`) and a debug
   port — **no automation flags**, so `navigator.webdriver` stays `false`.
2. A Chrome window opens. **Log into Leclerc Drive once** in it. The persistent
   profile keeps you logged in across restarts.
3. Every request runs *inside* that page via CDP, so it carries the browser's
   cookies, TLS fingerprint, and solved DataDome challenge — and passes.

No cookies are read or stored; there's no Keychain prompt. The server must run
on the same machine as Chrome, and a window does open (headless is detectable by
DataDome — don't enable it unless you know the risk).

| Env var | Default | Description |
| --- | --- | --- |
| `LECLERC_STORE_ID` | `053701` | Default store id (overridden at runtime by `set_store`). |
| `LECLERC_HOST` | `fd9-courses.leclercdrive.fr` | Default backend host (the `fdN` prefix varies by store). |
| `LECLERC_CHROME_PATH` | auto | Path to the Chrome binary, if not in the default location. |
| `LECLERC_CHROME_PROFILE_DIR` | `~/.mcp-leclerc-drive/chrome` | Persistent Chrome profile dir. |
| `LECLERC_CHROME_PORT` | `9222` | CDP remote-debugging port. |
| `LECLERC_HEADLESS` | `false` | Run Chrome headless (⚠️ DataDome-detectable — not recommended). |
| `LECLERC_MIN_INTERVAL_MS` | `1000` | Minimum delay between two requests (hygiene). |
| `LECLERC_JITTER_MS` | `400` | Extra random jitter added between requests. |
| `LECLERC_MAX_RETRIES` | `3` | Retries on a transient 403/429 before giving up. |
| `LECLERC_BACKOFF_BASE_MS` | `1500` | Base retry backoff (doubles each attempt). |

The server still serializes and spaces out requests (single queue, ~1 s + jitter,
retry with backoff) to stay polite — good hygiene even though the browser now
handles DataDome.

### Choosing your store (no env needed)

The easiest way: just **ask, in the conversation**. No env vars required.

```
> "trouve mon drive vers 44000"     → find_stores lists nearby drives
> "prends Rezé Atout Sud"           → set_store remembers it (correct host resolved)
> "cherche du lait"                  → runs on that store
```

`set_store` persists your choice to `~/.mcp-leclerc-drive/config.json`, so it
sticks across sessions, and it resolves the correct backend host for you (the
`fdN` prefix genuinely varies per store — `fd8`, `fd9`, `fd14`…).

> ⚠️ **One drive at a time.** Leclerc binds your session to a single drive. The
> store you `set_store` to must be the one your Chrome session is logged into —
> which is the normal case (your own drive). Switching to an arbitrary other
> drive your browser isn't on will return a "session expired" error.

You can still hard-set the store via `LECLERC_STORE_ID` / `LECLERC_HOST` env vars
if you prefer (e.g. for headless deploys). To find them manually: your Drive URL
looks like `https://fd9-courses.leclercdrive.fr/magasin-053701-053701-Your-Town/`
— the 6-digit number is the store id, the `fdN-courses.leclercdrive.fr` part is
the host.

### Claude Desktop / Claude Code (`mcp` config)

Install straight from npm — no clone needed:

```bash
# Claude Code
claude mcp add leclerc-drive -- npx -y mcp-leclerc-drive
```

Or in a Claude Desktop config:

```json
{
  "mcpServers": {
    "leclerc-drive": {
      "command": "npx",
      "args": ["-y", "mcp-leclerc-drive"]
    }
  }
}
```

No env needed — pick your store in-conversation with `find_stores` / `set_store`.
On first use a Chrome window opens: log into Leclerc Drive once and you're set.

## Development

```bash
npm run dev        # tsc --watch
npm run typecheck  # type-check without emitting
npm run inspect    # run under the MCP Inspector
```

## Architecture

```
src/
  index.ts          # MCP server: registers the 8 tools over stdio
  config.ts         # env-based config (store, host, Chrome/CDP, throttle)
  types.ts          # Product / CartItem / Cart
  store.ts          # active store selection + persistence (~/.mcp-leclerc-drive)
  browser.ts        # ChromeSession: drives real Chrome via CDP → beats DataDome
  leclerc/
    client.ts       # Leclerc Drive backend client (search + cart)
    locator.ts      # store finder: postal code / city → nearby drives
    throttle.ts     # request serialization + spacing + retry (hygiene)
docs/
  api-capture.md    # the reverse-engineered Leclerc Drive API
```

## Contributing

This is a community tool — **contributions are very welcome**, whether it's a
bug fix, support for your store, or a whole new capability (checkout, delivery
slots, saved lists…).

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for dev setup, how to smoke-test
against your own account (`npm run smoke`), and — most useful for this project —
a short guide on **how to reverse-engineer a new Leclerc Drive endpoint** and
wire it in. Good first issues are listed in the status checklist above.

## Feedback & contact

Feedback, bug reports, and ideas are very welcome.

- **Issues / PRs:** [open an issue](https://github.com/skunkobi/mcp-leclerc-drive/issues) on the repo.
- **Email:** alexandreyagoubi@gmail.com

## Disclaimer

Unofficial. Not affiliated with or endorsed by E.Leclerc. Use with your own account, at your own risk, in line with the site's terms of service. Intended for personal automation of your own grocery shopping.

## License

MIT
