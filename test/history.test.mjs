import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseOrderList,
  parseOrderDetail,
  parseProductSheet,
  parseAvailableYears,
  parseLoadMoreTarget,
  parseFormFields,
} from "../dist/leclerc/history.js";
import { bestLabelMatch, normalizeLabel, labelSimilarity } from "../dist/leclerc/resolve.js";
import { Ledger, median } from "../dist/ledger.js";

// Synthetic fixtures mirroring the live markup observed on 2026-09-05
// (docs/api-capture.md §7). Real pages can't be committed (they carry session data).
const row = (n, no, date, total, items, sav) => `
<tr class="noBorder">
 <td><span class="spanWCCD353_Etat spanWCCD353_Niveau1"></span><span class="bold">Livrée</span></td>
 <td><p><a id="ctl00_ctl00_mainMutiUnivers_main_ascWCCD010_HistoriqueCommandes_lvHistCom_ctrl${n}_hlNumeroCommande" class="block aNumCommande" href="https://fd5-espace-client.leclercdrive.fr/drive/magasin-000001-000001-Ville-Test/detail-commande.aspx?iIdC=abc${n}%3d%3d">N°${no}</a><span>${date}</span></p></td>
 <td><p class="pWCCD353_PointRetrait"><span class="block tdLabel">Livraison à domicile par un professionnel</span></p></td>
 <td><p class="pWCCD353_MoyenPaiement"><span class="block tdLabel"><span>Paiement par carte bancaire</span></span></p></td>
 <td><p class="pWCCD353_PointRetrait"><span class="spanTdHoraire tdLabel"><span>Livraison 31/12/2025 entre 10h30 et 11h30</span></span></p></td>
 <td class="alignRight"><p class="tbEspaceClientMontant">${total} €</p>
   <table id="ctl00_ctl00_mainMutiUnivers_main_ascWCCD010_HistoriqueCommandes_lvHistCom_ctrl${n}_tbEspaceClient" class="tbEspaceClient"><tbody>
   <tr><td>Frais de livraison : 9,90 €</td></tr><tr><td>${items} produits</td></tr>${sav ? `<tr><td>Economies : ${sav} €</td></tr>` : ""}
   </tbody></table></td>
 <td><select><option>Sélectionner une action</option></select></td>
</tr>`;

const listPage = (rows, withMore = true) => `<html><body><form method="post" action="./mes-commandes.aspx" id="aspnetForm">
<input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="dDwtMTIzNDU2Nzg5O3Q8O2w8aTwxPjs+O2w8dDw7bDxpPDE+Oz4=" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="/wEWAgKq" />
<input type="hidden" name="ctl00$ctl00$Et" value="x" />
<input type="text" name="not_hidden" value="ignored" />
<select name="ctl00$ctl00$mainMutiUnivers$main$ascWCCD010_HistoriqueCommandes$ddlFiltreAnnees" id="ddlFiltreAnnees">
 <option value="2026">Année 2026</option><option selected="selected" value="2025">Année 2025</option><option value="2024">Année 2024</option>
</select>
<h2>Mon historique de commandes</h2>
<table id="historique" class="tbEspaceClient"><tbody>${rows}</tbody></table>
${withMore ? `<a class="aWCCD353_Plus" href="javascript:__doPostBack(&#39;ctl00$ctl00$mainMutiUnivers$main$ascWCCD010_HistoriqueCommandes$lbEnVoirPlus&#39;,&#39;&#39;)">En voir plus</a>` : ""}
</form></body></html>`;

test("parseOrderList: one summary per row, totals not polluted by the slot", () => {
  const html = listPage(
    row(0, "12345001", "30/12/2025 à 22h21", "137,16", 41) +
      row(1, "12345002", "27/11/2025 à 18h43", "211,11", 60, "0,70"),
  );
  const orders = parseOrderList(html);
  assert.equal(orders.length, 2);
  assert.deepEqual(
    { ...orders[0], detailUrl: undefined },
    {
      orderNo: "12345001",
      date: "2025-12-30T22:21:00",
      detailUrl: undefined,
      state: "Livrée",
      service: "Livraison à domicile par un professionnel",
      total: 137.16,
      deliveryFee: 9.9,
      itemCount: 41,
      savings: undefined,
    },
  );
  assert.match(orders[0].detailUrl, /detail-commande\.aspx\?iIdC=abc0%3d%3d$/);
  assert.equal(orders[1].savings, 0.7);
  assert.deepEqual(parseAvailableYears(html), [2026, 2025, 2024]);
});

test("parseLoadMoreTarget + parseFormFields replay the « En voir plus » postback", () => {
  const html = listPage(row(0, "1", "01/01/2025 à 10h00", "1,00", 1));
  assert.equal(
    parseLoadMoreTarget(html),
    "ctl00$ctl00$mainMutiUnivers$main$ascWCCD010_HistoriqueCommandes$lbEnVoirPlus",
  );
  assert.equal(parseLoadMoreTarget(listPage("", false)), undefined);
  const f = parseFormFields(html);
  assert.equal(f.__VIEWSTATE, "dDwtMTIzNDU2Nzg5O3Q8O2w8aTwxPjs+O2w8dDw7bDxpPDE+Oz4=");
  assert.equal(f["ctl00$ctl00$Et"], "x");
  assert.equal(f.not_hidden, undefined);
  assert.equal(f["ctl00$ctl00$mainMutiUnivers$main$ascWCCD010_HistoriqueCommandes$ddlFiltreAnnees"], "2025");
});

test("parseOrderList: session/contract guards", () => {
  assert.throws(() => parseOrderList("<html>Votre session a expiré, identifiez-vous</html>"), /Session/);
  assert.throws(() => parseOrderList("<html><body>random</body></html>"), /ContractChanged|structure attendue/);
});

const li = (id, t1, t2, qty, price, rayon) => `
<li class="liWCCD353_LigneArticle" iidproduit="${id}" stitre1="${t1}" stitre2="${t2}">
 <img class="imgWCCD353_Produit" src="/image.ashx?id=1" />
 <p><span>${t1}</span><br/><span>${t2}</span></p>
 <a class="aWCCD353_VoirRayon" href="/magasin-000001-000001-Ville-Test/rayon-${rayon}-Volailles.aspx?Filtres=x">Voir le rayon</a>
 <a class="aWCCD353_BtnListes" href="#">Ajouter à mes listes</a>
 <p class="pWCCD353_Quantite">x${qty}</p>
 <p class="pWCCD051_Prix">${price} €</p>
</li>`;

const detailPage = `<html><body>
<h1>COMMANDE N°12345678 DU 01/09/2026 À 10H27</h1>
<div class="rayon"><h3>Viandes Poissons (2 produits)</h3><ul>
${li(126817, "Filet de poulet extra tendre", "Le Gaulois - 300g", 2, "7,58", 284326)}
</ul></div>
<div class="rayon"><h3><span>Fruits L&#233;gumes</span> <span class="nb">(22 produits)</span></h3><ul>
${li(53001, "Courgettes Bio Bio Village", "Filet - 750g", 2, "4,98", 284400)}
${li(53002, "Poivron doux rouge", "1p", 3, "2,37", 284400)}
</ul></div>
</body></html>`;

test("parseOrderDetail: header, lines, quantities, unit price, aisle", () => {
  const d = parseOrderDetail(detailPage);
  assert.equal(d.orderNo, "12345678");
  assert.equal(d.date, "2026-09-01T10:27:00");
  assert.equal(d.lines.length, 3);
  assert.deepEqual(d.lines[0], {
    productId: "126817",
    label: "Filet de poulet extra tendre Le Gaulois - 300g",
    quantity: 2,
    lineTotal: 7.58,
    unitPrice: 3.79,
    aisleId: "284326",
    aisle: "Viandes Poissons",
  });
  assert.equal(d.lines[2].unitPrice, 0.79);
  assert.equal(d.lines[2].aisle, "Fruits Légumes");
  assert.throws(() => parseOrderDetail("<html>COMMANDE N°1 DU 01/01/2026 À 10H00</html>"), /ContractChanged|LigneArticle/);
});

test("parseProductSheet: EAN/brand read from the requested product's own records only", () => {
  const html = `<html>lstProduitsLight
   initOptions('reco', {"objElement":{"iIdProduit":222290,"sLibelleLigne1":"Poivron","sCodeEAN":"3701385102484","sLibelleMarque":""}});
   initOptions('main', {"objElement":{"iIdProduit":2613,"sLibelleLigne1":"Lait","sCodeEAN":"3564700012345","sLibelleMarque":"Marque rep\\u00e8re","sComposition":"\\nLAIT ORIGINE : FRANCE","sAllergenes":"","sLibelleOrigine":null}});
  </html>`;
  assert.deepEqual(parseProductSheet(html, "2613"), {
    ean: "3564700012345",
    brand: "Marque repère",
    ingredients: "LAIT ORIGINE : FRANCE",
    allergens: undefined,
    origin: undefined,
  });
  // Unknown id ⇒ nothing, never another product's EAN.
  assert.equal(parseProductSheet(html, "999").ean, undefined);
});

test("resolve: normalization and label matching", () => {
  assert.equal(normalizeLabel("Lait demi-&#233;cr&#233;m&#233; UHT Délisse  6x1L"), "lait demi ecreme uht delisse 6x1l");
  assert.ok(labelSimilarity("Filet de poulet extra tendre Le Gaulois - 300g", "Filet de poulet extra tendre Le Gaulois 300g") > 0.99);
  const cands = [
    { id: "1", label: "Filet de poulet jaune Le Gaulois 720g" },
    { id: "2", label: "Filet de poulet extra tendre Le Gaulois - 300g" },
    { id: "3", label: "Lait demi-écrémé" },
  ];
  const exact = bestLabelMatch("Filet de poulet extra tendre Le Gaulois - 300g", cands, (c) => c.label);
  assert.equal(exact.item.id, "2");
  assert.equal(exact.kind, "label_exact");
  const fuzzy = bestLabelMatch("Filet de poulet extra tendre Le Gaulois Label - 300g", cands, (c) => c.label);
  assert.equal(fuzzy.item.id, "2");
  assert.equal(fuzzy.kind, "label_fuzzy");
  assert.equal(bestLabelMatch("Eau gazeuse Badoit 6x1L", cands, (c) => c.label), undefined);
  // Same words, different format ⇒ different reference (seen live: 250g → 342g, 200g → 350g).
  assert.equal(bestLabelMatch("Tomato Ketchup Heinz - 250g", [{ id: "9", label: "Tomato Ketchup Heinz - 342g" }], (c) => c.label), undefined);
  // Brand swap on a short label falls under the threshold (seen live: Ferrero → Regia).
  assert.equal(bestLabelMatch("Couscous Grain Moyen Ferrero - 500g", [{ id: "9", label: "Couscous Grain Moyen Regia - 500G" }], (c) => c.label), undefined);
});

test("ledger: append-only JSONL, dedup by order, last product record wins, stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const l = new Ledger(dir);
    const order = (no, date, qty, price) => ({
      orderNo: no, date, storeId: "000001", lines: [{ productId: "126817", label: "Poulet", quantity: qty, lineTotal: price * qty, unitPrice: price }], importedAt: "x",
    });
    l.appendOrder(order("A", "2026-09-01T10:00:00", 2, 3.79));
    l.appendOrder(order("A", "2026-09-01T10:00:00", 9, 9)); // duplicate ignored
    l.appendOrder(order("B", "2026-06-01T10:00:00", 1, 3.5));
    assert.equal(l.orders().length, 2);
    assert.equal(l.orders()[0].orderNo, "A"); // newest first
    l.upsertProduct({ productId: "126817", label: "Poulet", status: "unresolved", resolvedAt: "t1" });
    l.upsertProduct({ productId: "126817", label: "Poulet", status: "active", currentId: "126817", resolvedAt: "t2" });
    const fresh = new Ledger(dir); // re-read from disk
    assert.equal(fresh.product("126817").status, "active");
    const st = fresh.purchaseStats().get("126817");
    assert.equal(st.orders, 2);
    assert.equal(st.totalQuantity, 3);
    assert.equal(median(st.unitPrices), (3.79 + 3.5) / 2);
    assert.equal(st.lastQuantity, 2);
    assert.deepEqual(fresh.summary(), { orders: 2, products: 1, from: "2026-06-01", to: "2026-09-01", missing: 0, unresolved: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger meta: staleness drives the automatic refresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-meta-"));
  try {
    const l = new Ledger(dir);
    assert.equal(l.lastImportAt(), undefined);
    assert.equal(l.isStale(12), true);
    const t = new Date("2026-09-05T10:00:00Z");
    l.markImported(t);
    assert.equal(new Ledger(dir).lastImportAt(), "2026-09-05T10:00:00.000Z");
    assert.equal(l.isStale(12, new Date("2026-09-05T21:00:00Z")), false);
    assert.equal(l.isStale(12, new Date("2026-09-05T23:00:00Z")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
