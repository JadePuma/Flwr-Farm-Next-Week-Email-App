// update-collection-basic.js
// Usage (GitHub Actions):
//   node update-collection-basic.js [collection-handle]
//
// If no handle is provided, it will:
//   - compute the NEXT ISO week number (UTC, based on "today + 7 days")
//   - build handle: week-<N>-plants  (e.g. week-4-plants)
//
// Env vars required:
//   SHOPIFY_SHOP (subdomain, e.g. "flwr-farm")
//   SHOPIFY_ADMIN_TOKEN (shpca_... or shpat_...)

const shop  = process.env.SHOPIFY_SHOP;
const token = process.env.SHOPIFY_ADMIN_TOKEN;

function isoWeekNumberUTC(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;          // Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - day);  // shift to Thursday

  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const diffDays = Math.floor((d - yearStart) / 86400000) + 1;
  return Math.ceil(diffDays / 7);
}

function nextWeekHandleUTC(suffix = "plants") {
  const now = new Date();
  const nextWeekDate = new Date(now.getTime() + 7 * 86400000); // +7 days
  const nextWeek = isoWeekNumberUTC(nextWeekDate);
  return `week-${nextWeek}-${suffix}`;
}

// Optional override: node update-collection-basic.js week-4-plants
const handle = process.argv[2] || nextWeekHandleUTC("plants");

if (!shop || !token) {
  console.error("Usage: SHOPIFY_SHOP=... SHOPIFY_ADMIN_TOKEN=... node update-collection-basic.js [collection-handle]");
  process.exit(1);
}

const API = `https://${shop}.myshopify.com/admin/api/2024-10/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);

  const json = JSON.parse(text);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(amountStr, currencyCode) {
  const n = Number(amountStr);
  if (!Number.isFinite(n)) return "";

  const symbols = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    HUF: "Ft",
    CAD: "$",
    AUD: "$",
  };

  const symbol = symbols[currencyCode] || currencyCode;
  return `${symbol}${n.toFixed(2)}`;
}

function collectionUrlFromHandle(h) {
  return `https://${shop}.myshopify.com/collections/${h}`;
}

async function getCollectionNumericId(h) {
  const Q = `query($handle:String!){
    collectionByHandle(handle:$handle){ id title }
  }`;
  const d = await gql(Q, { handle: h });
  const c = d?.collectionByHandle;
  if (!c) throw new Error(`Collection not found: ${h}`);
  return { title: c.title, numericId: c.id.split("/").pop() };
}

async function getProductsInCollection(numericId, first = 50) {
  const query = `collection_id:${numericId}`;
  const Q = `query($first:Int!,$query:String!){
    products(first:$first, query:$query, sortKey:TITLE){
      edges{
        node{
          title
          handle
          onlineStoreUrl
          featuredImage {
            url
            altText
          }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
          }
        }
      }
    }
  }`;

  const d = await gql(Q, { first, query });

  return (d?.products?.edges || []).map(e => {
    const p = e.node;

    const money = p?.priceRangeV2?.minVariantPrice;
    const price = money ? formatMoney(money.amount, money.currencyCode) : "";

    const imageUrl = p?.featuredImage?.url || "";
    const imageAlt = p?.featuredImage?.altText || p?.title || "";

    return {
      title: p.title || "",
      // NOTE: we no longer use product URLs in the HTML, but keep this if you want later
      url: p.onlineStoreUrl || `https://${shop}.myshopify.com/products/${p.handle}`,
      price,
      imageUrl,
      imageAlt,
    };
  });
}

function buildHtml(collectionTitle, products, collectionLink) {

  const rows = products.map((p, index) => {

    const bgColor = index % 2 === 0 ? "#f4ebe6" : "#d6b5a2";

    const img = p.imageUrl
      ? `<img src="${p.imageUrl}" alt="${esc(p.imageAlt)}" width="72" height="72"
              style="display:block;object-fit:cover;border:none;">`
      : `<div style="width:72px;height:72px;background:#eee;"></div>`;

    const price = p.price
      ? `<div style="margin-top:4px;color:#222829;font-size:13px;">${esc(p.price)}</div>`
      : "";

    return `
      <tr style="background:${bgColor};">
        <td style="padding:12px 10px;vertical-align:top;width:84px;">
          ${img}
        </td>
        <td style="padding:12px 10px;vertical-align:top;">
          <div style="color:#222829;font-weight:600;">
            ${esc(p.title)}
          </div>
          ${price}
        </td>
      </tr>
    `.trim();

  }).join("\n");

  const empty = `
    <tr>
      <td style="padding:12px;color:#222829;">No products found.</td>
    </tr>
  `.trim();

  return `
<a href="${collectionLink}" style="text-decoration:none;color:#222829;display:block;">
  <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.4;color:#222829;">
      
      <table role="presentation" cellpadding="0" cellspacing="0"
             style="width:100%;border-collapse:collapse;">
        <tbody>
          ${products.length ? rows : empty}
        </tbody>
      </table>

  </div>
</a>
`.trim();
}




async function writeShopMetafield(html) {
  const shopQ = `query{ shop{ id } }`;
  const { shop: { id: shopId } } = await gql(shopQ);

  const M = `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){
      metafields{ id namespace key }
      userErrors{ field message }
    }
  }`;

  const variables = {
    metafields: [
      {
        ownerId: shopId,
        namespace: "email",
        key: "collection_html_1",
        type: "multi_line_text_field",
        value: html,
      },
    ],
  };

  const d = await gql(M, variables);
  const errs = d?.metafieldsSet?.userErrors || [];
  if (errs.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errs)}`);
}

(async () => {
  try {
    console.log(`ℹ️ Using collection handle: ${handle}`);

    const { title, numericId } = await getCollectionNumericId(handle);
    const products = await getProductsInCollection(numericId, 50);

    const collectionLink = collectionUrlFromHandle(handle);
    const html = buildHtml(title, products, collectionLink);

    await writeShopMetafield(html);

    console.log(`✅ Wrote ${products.length} products from "${title}" to shop metafield email.collection_html_1`);
    console.log(`🔗 Collection link used: ${collectionLink}`);
  } catch (e) {
    console.error("❌", e.stack || e.message || e);
    process.exit(1);
  }
})();
