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
  // ISO week based on UTC
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;        // Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to Thursday

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
    .replace(/>/g, "&gt;");
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
        }
      }
    }
  }`;
  const d = await gql(Q, { first, query });
  return (d?.products?.edges || []).map(e => {
    const p = e.node;
    return {
      title: p.title || "",
      url: p.onlineStoreUrl || `https://${shop}.myshopify.com/products/${p.handle}`,
    };
  });
}

function buildHtml(collectionTitle, products) {
  const items = products
    .map(
      p =>
        `<li style="margin:0 0 8px 0;"><a href="${p.url}" style="color:#111;text-decoration:none;">${esc(
          p.title
        )}</a></li>`
    )
    .join("\n");

  return `
<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.4;">
  <p style="margin:0 0 10px 0;"><strong>${esc(collectionTitle)}</strong> (${products.length} products)</p>
  <ul style="padding-left:18px;margin:0;">
${items || "    <li>No products found.</li>"}
  </ul>
</div>
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
    const html = buildHtml(title, products);

    await writeShopMetafield(html);

    console.log(`✅ Wrote ${products.length} products from "${title}" to shop metafield email.collection_html_1`);
  } catch (e) {
    console.error("❌", e.stack || e.message || e);
    process.exit(1);
  }
})();
