/**
 * Order history — Leclerc's customer area (`fdN-espace-client.leclercdrive.fr`).
 *
 * Unlike the store pages, these are plain server-rendered HTML (no JSON blob),
 * validated live on 2026-09-05 — see docs/api-capture.md §7:
 *
 *  - list:   GET /drive/magasin-{id}-{id}/mes-commandes.aspx?AnneeSelectionnee=YYYY
 *            one <table id="…lvHistCom_ctrlN_tbEspaceClient"> per order
 *  - detail: GET /drive/magasin-{id}-{id}/detail-commande.aspx?iIdC=<opaque>
 *            one <li class="liWCCD353_LigneArticle" iidproduit=… stitre1=… stitre2=…>
 *            per line, with p.pWCCD353_Quantite ("x2") and p.pWCCD051_Prix.
 *
 * Parsers are pure functions over the HTML string (regex + tag stripping, no DOM
 * dependency) and throw ContractChangedError when the markup no longer matches.
 */

import { OrderLine, OrderRecord } from "../ledger.js";
import { Product } from "../types.js";
import { LeclercClient, RawProduct, mapProduct, scanProductRecords, assertStorePage } from "./client.js";
import { ContractChangedError } from "./errors.js";

export interface OrderSummary {
  orderNo: string;
  /** ISO local date-time, e.g. "2026-09-01T10:27:00". */
  date: string;
  detailUrl: string;
  state?: string;
  service?: string;
  total?: number;
  deliveryFee?: number;
  itemCount?: number;
  savings?: number;
}

export interface ProductSheet {
  ean?: string;
  brand?: string;
  ingredients?: string;
  allergens?: string;
  origin?: string;
}

// ---- Guards ---------------------------------------------------------------

/** The customer-area pages don't carry the store marker; use their own markers. */
function assertEspaceClientPage(html: string, marker: RegExp, what: string): void {
  if (marker.test(html)) return;
  if (/session a expir|sessionexpiree|identifiez-vous|connectez-vous/i.test(html)) {
    throw new Error(
      "Session Leclerc Drive expirée ou non connectée. Ouvre Leclerc Drive dans la fenêtre " +
        "Chrome du serveur, connecte-toi, puis réessaie.",
    );
  }
  if (/datadome|captcha-delivery/i.test(html) && html.length < 20000) {
    throw new Error(
      "Bloqué par Leclerc Drive (challenge DataDome). Recharge Leclerc Drive dans Chrome puis réessaie.",
    );
  }
  throw new ContractChangedError(`La page « ${what} » n'a pas la structure attendue.`);
}

// ---- Parsers (pure) ---------------------------------------------------------

/**
 * Parse the "Mes commandes" list page. Newest first (site order).
 *
 * Layout (validated live): one `<tr>` per order inside `<table id="historique">`;
 * the order-number link has id `…lvHistCom_ctrl{N}_hlNumeroCommande`, and the
 * totals cell holds a nested `<table id="…lvHistCom_ctrl{N}_tbEspaceClient">`.
 * We cut one block per `ctrl{N}` (from its row start to the next block's row start).
 */
export function parseOrderList(html: string): OrderSummary[] {
  assertEspaceClientPage(html, /Mon historique de commandes|lvHistCom_ctrl|HistoriqueCommandes/i, "Mes commandes");
  // First occurrence of each ctrl index → row start.
  const firstAt = new Map<number, number>();
  for (const m of html.matchAll(/lvHistCom_ctrl(\d+)_/g)) {
    const n = Number(m[1]);
    if (!firstAt.has(n)) firstAt.set(n, m.index ?? 0);
  }
  const starts = [...firstAt.values()]
    .map((at) => {
      const tr = html.lastIndexOf("<tr", at);
      return tr >= 0 ? tr : at;
    })
    .sort((a, b) => a - b);
  const out: OrderSummary[] = [];
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined);
    const href = block.match(/href="([^"]*detail-commande\.aspx\?[^"]*)"/i)?.[1];
    const text = stripTags(block);
    const no = text.match(/N°\s*(\d{5,})/)?.[1];
    const dt = text.match(/(\d{2})\/(\d{2})\/(\d{4}) à (\d{2})h(\d{2})/);
    if (!no || !dt || !href) continue;
    const afterNo = text.slice(text.indexOf(no));
    const before = text.slice(0, text.indexOf("N°")).trim();
    out.push({
      orderNo: no,
      date: `${dt[3]}-${dt[2]}-${dt[1]}T${dt[4]}:${dt[5]}:00`,
      detailUrl: decodeEntities(href),
      state: before.split(" ").slice(-2).join(" ").replace(/^(\S+ )?(Livrée|Annulée|Retirée|Validée|Prête|En cours|En préparation)$/, "$2") || undefined,
      service: afterNo.match(/\d{2}h\d{2}\s+(.+?)\s+Paiement/)?.[1]?.trim(),
      // No thousands separator on purpose: "entre 10h30 et 11h30 137,16 €" must give 137.16.
      total: firstEuro(afterNo.match(/(\d+,\d{2})\s*€/)?.[1]),
      deliveryFee: firstEuro(afterNo.match(/Frais de livraison\s*:\s*(\d+,\d{2})/)?.[1]),
      itemCount: num(afterNo.match(/(\d+)\s+produits?/)?.[1]),
      savings: firstEuro(afterNo.match(/Economies\s*:\s*(\d+,\d{2})/i)?.[1]),
    });
  }
  return out;
}

/**
 * "En voir plus" pager: the list shows 5 orders and a link-button that posts back
 * (`__doPostBack('…lbEnVoirPlus','')`) to append the rest. Returns the postback
 * target when the page has more to load, else undefined.
 */
export function parseLoadMoreTarget(html: string): string | undefined {
  // Live markup encodes the quotes: href="javascript:__doPostBack(&#39;…lbEnVoirPlus&#39;,&#39;&#39;)".
  const q = "(?:'|&#39;|&apos;)";
  const m =
    html.match(new RegExp(`aWCCD353_Plus[^>]*href="javascript:__doPostBack\\(${q}([^'&"]+)${q},${q}[^'&"]*${q}\\)"`)) ??
    html.match(new RegExp(`__doPostBack\\(${q}([^'&"]*lbEnVoirPlus[^'&"]*)${q}`));
  return m ? decodeEntities(m[1]) : undefined;
}

/** Hidden inputs + selects of the first form, for replaying an ASP.NET postback. */
export function parseFormFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const name = tag.match(/\bname="([^"]*)"/i)?.[1];
    if (!name) continue;
    fields[decodeEntities(name)] = decodeEntities(tag.match(/\bvalue="([^"]*)"/i)?.[1] ?? "");
  }
  for (const m of html.matchAll(/<select\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const sel = m[2].match(/<option[^>]*\bselected[^>]*\bvalue="([^"]*)"/i) ??
      m[2].match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected/i);
    if (sel) fields[decodeEntities(m[1])] = decodeEntities(sel[1]);
  }
  return fields;
}

/** Years offered by the year filter (e.g. [2026, 2025, 2024]). */
export function parseAvailableYears(html: string): number[] {
  const sel = html.match(/<select[^>]*ddlFiltreAnnees[^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? "";
  const years = [...sel.matchAll(/value="(\d{4})"/g)].map((x) => Number(x[1]));
  return [...new Set(years)].sort((a, b) => b - a);
}

/** Parse an order detail page into lines (+ header info). */
export function parseOrderDetail(html: string): { orderNo: string; date: string; lines: OrderLine[] } {
  assertEspaceClientPage(html, /liWCCD353_LigneArticle|COMMANDE N°/i, "Détail de la commande");
  const text = stripTags(html);
  const h = text.match(/COMMANDE N°\s*(\d{5,}) DU (\d{2})\/(\d{2})\/(\d{4}) À (\d{2})H(\d{2})/i);
  if (!h) throw new ContractChangedError("En-tête « COMMANDE N°… DU … » introuvable sur le détail de commande.");
  const orderNo = h[1];
  const date = `${h[4]}-${h[3]}-${h[2]}T${h[5]}:${h[6]}:00`;

  // Aisle headings ("Fruits Légumes (22 produits)", possibly split across tags)
  // precede their lines; map each line to the closest heading above it.
  const headings: Array<{ at: number; name: string }> = [];
  for (const hm of html.matchAll(/>([^<>]{2,60}?)\s*(?:<\/?\w+[^>]*>\s*){0,4}\(\s*\d+\s+produits?\s*\)/g)) {
    const name = decodeEntities(hm[1]).trim();
    if (name) headings.push({ at: hm.index ?? 0, name });
  }

  const lines: OrderLine[] = [];
  const re = /<li\b([^>]*\bclass="[^"]*liWCCD353_LigneArticle[^"]*"[^>]*)>([\s\S]*?)(?=<li\b[^>]*liWCCD353_LigneArticle|<\/ul>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const productId = attrs.match(/\biidproduit="(\d+)"/i)?.[1];
    if (!productId) continue;
    const t1 = decodeEntities(attrs.match(/\bstitre1="([^"]*)"/i)?.[1] ?? "");
    const t2 = decodeEntities(attrs.match(/\bstitre2="([^"]*)"/i)?.[1] ?? "");
    const qty = num(stripTags(body.match(/class="[^"]*pWCCD353_Quantite[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/x/i, "")) ?? 1;
    const lineTotal = firstEuro(stripTags(body.match(/class="[^"]*pWCCD051_Prix[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "")) ?? 0;
    const aisleId = body.match(/rayon-(\d+)-/)?.[1];
    const heading = headings.filter((x) => x.at < (m!.index ?? 0)).pop()?.name;
    lines.push({
      productId,
      label: [t1, t2].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || `Produit ${productId}`,
      quantity: qty,
      lineTotal,
      unitPrice: qty > 0 ? round2(lineTotal / qty) : lineTotal,
      aisleId,
      aisle: heading,
    });
  }
  if (lines.length === 0) {
    throw new ContractChangedError("Aucune ligne « liWCCD353_LigneArticle » trouvée sur le détail de commande.");
  }
  return { orderNo, date, lines };
}

/**
 * Product sheet (`fiche-produits-…aspx`): EAN, brand, ingredients…
 *
 * ⚠️ The sheet embeds ~20 product records (recommendations, "often bought
 * with"), each with its own `sCodeEAN`. Taking the first EAN on the page
 * silently attributes another product's code (seen live: an aubergine got a
 * pepper's EAN). So we only read records whose `iIdProduit` is the requested
 * one, merging the fields across them.
 */
export function parseProductSheet(html: string, productId: string): ProductSheet {
  assertStorePage(html);
  const own = scanProductRecords(html).filter((r) => String(r.iIdProduit) === String(productId));
  const pick = <K extends keyof RawProduct>(k: K): string | undefined => {
    for (const r of own) {
      const v = r[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return decodeEntities(String(v)).trim();
    }
    return undefined;
  };
  const ean = pick("sCodeEAN")?.replace(/\D/g, "");
  return {
    ean: ean && ean.length >= 8 ? ean : undefined,
    brand: pick("sLibelleMarque"),
    ingredients: pick("sComposition"),
    allergens: pick("sAllergenes"),
    origin: pick("sLibelleOrigine") ?? pick("sOrigine"),
  };
}

/** "Mes produits habituels": Leclerc's own aggregated already-bought list. */
export function parseHabitualProducts(html: string): Product[] {
  assertStorePage(html);
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const rp of scanProductRecords(html)) {
    if (rp.sType && rp.sType !== "Produit") continue;
    if (!rp.sLibelleLigne1) continue;
    const id = String(rp.iIdProduit);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(mapProduct(rp));
  }
  return out;
}

// ---- Client -----------------------------------------------------------------

export class HistoryClient {
  constructor(private readonly client: LeclercClient) {}

  /**
   * Orders for one year (site default = current year), newest first. The page
   * shows 5 orders; "En voir plus" is replayed as a POST postback (validated
   * live: one postback appended the remaining 7 of 12 orders of 2025) until
   * the button disappears or `maxPages` is hit.
   */
  async listOrders(year?: number, maxPages = 10): Promise<{ orders: OrderSummary[]; years: number[] }> {
    const q = year ? `?AnneeSelectionnee=${year}` : "";
    const url = this.client.espaceClientUrl(`mes-commandes.aspx${q}`);
    let html = await this.client.fetchHtml(url);
    const years = parseAvailableYears(html);
    for (let page = 1; page < maxPages; page++) {
      const target = parseLoadMoreTarget(html);
      if (!target) break;
      const fields = parseFormFields(html);
      fields.__EVENTTARGET = target;
      fields.__EVENTARGUMENT = "";
      const next = await this.client.postForm(url, fields);
      if (parseOrderList(next).length <= parseOrderList(html).length) break; // no progress
      html = next;
    }
    return { orders: parseOrderList(html), years };
  }

  /**
   * Newest `limit` orders across years: walks the year filter backwards until
   * `limit` is reached or years run out. One page load per year touched.
   */
  async listRecentOrders(limit: number): Promise<OrderSummary[]> {
    const first = await this.listOrders();
    let all = [...first.orders];
    const years = first.years.length ? first.years : [new Date().getFullYear()];
    const current = years[0];
    for (const y of years.filter((y) => y < current)) {
      if (all.length >= limit) break;
      const { orders } = await this.listOrders(y);
      all = all.concat(orders);
    }
    const byNo = new Map(all.map((o) => [o.orderNo, o]));
    return [...byNo.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  async fetchOrder(summary: OrderSummary, storeId: string): Promise<OrderRecord> {
    const url = new URL(summary.detailUrl, this.client.espaceClientUrl("")).toString();
    const html = await this.client.fetchHtml(url);
    const d = parseOrderDetail(html);
    return {
      orderNo: d.orderNo || summary.orderNo,
      date: d.date || summary.date,
      storeId,
      state: summary.state,
      service: summary.service,
      total: summary.total,
      deliveryFee: summary.deliveryFee,
      savings: summary.savings,
      itemCount: summary.itemCount,
      lines: d.lines,
      importedAt: new Date().toISOString(),
    };
  }

  async habitualProducts(): Promise<Product[]> {
    const html = await this.client.fetchHtml(this.client.storeUrl("produits-habituels.aspx"));
    return parseHabitualProducts(html);
  }

  async productSheet(productUrl: string, productId: string): Promise<ProductSheet> {
    const url = new URL(productUrl, this.client.storeUrl("")).toString();
    return parseProductSheet(await this.client.fetchHtml(url), productId);
  }
}

// ---- Helpers ----------------------------------------------------------------

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function firstEuro(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d[\d\s ]*,\d{2})/);
  if (!m) return undefined;
  const n = Number(m[1].replace(/[\s ]/g, "").replace(",", "."));
  return Number.isNaN(n) ? undefined : n;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&agrave;/g, "à")
    .replace(/&ccedil;/g, "ç");
}
