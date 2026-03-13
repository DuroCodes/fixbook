import { eq } from "drizzle-orm";
import { lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { listings, listingSchema, type Listing } from "./db/schema.js";
import { db } from "./db/index.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST =
  process.env.FIXBOOK_HOST ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`);
const ITEM_PATH = (id: string) => `/marketplace/item/${id}`;
const facebookUrl = (id: string) =>
  `https://www.facebook.com/marketplace/item/${id}`;
const projectUrl = (id: string) => `${HOST.replace(/\/$/, "")}${ITEM_PATH(id)}`;
const oEmbedUrl = (id: string) => `${projectUrl(id)}/oembed`;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const deleteExpiredListings = async () =>
  await db
    .delete(listings)
    .where(lt(listings.createdAt, sql`NOW() - INTERVAL '7 days'`));

// Parse "Listed 11 weeks ago in Richland, MO" -> { timeAgo, location? }
function parseListed(listed: string): { timeAgo: string; location?: string } {
  const inMatch = listed.match(/^Listed\s+(.+?)\s+in\s+(.+)$/i);
  if (inMatch) return { timeAgo: inMatch[1].trim(), location: inMatch[2].trim() };
  const rest = listed.replace(/^Listed\s+/i, "").trim();
  return { timeAgo: rest || listed };
}

// Compact details: "Exterior color: White · Interior color: Tan" -> "White / Tan"
function detailsSummary(details: string[]): string {
  if (details.length === 0) return "";
  const values = details.flatMap((d) =>
    d.split(" · ").map((s) => (s.includes(":") ? s.replace(/^[^:]+:\s*/, "").trim() : s.trim()))
  ).filter(Boolean);
  return values.slice(0, 5).join(" / "); // cap so embed doesn't explode
}

// Remove price, listed text, and location from description to avoid duplication.
function stripRedundantFromDescription(description: string, listing: Listing): string {
  let out = description;
  const priceEscaped = listing.price.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(new RegExp(priceEscaped, "gi"), " ").trim();
  out = out.replace(new RegExp(listing.listed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ").trim();
  const { location } = parseListed(listing.listed);
  if (location) {
    out = out.replace(new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ").trim();
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

// Emoji line for author + meta (like FixupX): 💵 $600 📅 11 weeks ago 📍 Richland, MO 📝 White / Tan
function emojiLine(listing: Listing): string {
  const { timeAgo, location } = parseListed(listing.listed);
  const parts = [
    `💵 ${listing.price}`,
    `📅 ${timeAgo}`,
    ...(location ? [`📍 ${location}`] : []),
    ...(detailsSummary(listing.details) ? [`📝 ${detailsSummary(listing.details)}`] : []),
  ];
  return parts.join(" ");
}

// Meta description is plain text only (og:description/twitter:description).
const embedDescription = (listing: Listing) => {
  const line = emojiLine(listing);
  const strippedDesc = stripRedundantFromDescription(listing.description, listing);
  return strippedDesc ? `${line} ${strippedDesc}` : line;
};

// Key stats for oEmbed author_name (Discord shows this line in bold, like FixupX).
const oEmbedAuthorLine = (listing: Listing) => emojiLine(listing);

const embedHtml = (listing: Listing) => {
  const pageUrl = projectUrl(listing.id);
  const redirectUrl = facebookUrl(listing.id);
  const desc = embedDescription(listing);
  const escapedTitle = listing.title.replace(/"/g, "&quot;");
  const escapedDesc = desc.replace(/"/g, "&quot;");
  const primaryImage = listing.images?.at(0);
  const hasImage = !!primaryImage;

  const imageMetas = primaryImage
    ? listing.images
        .map(
          (url) =>
            `<meta property="og:image" content="${url.replace(/"/g, "&quot;")}">`,
        )
        .join("\n  ")
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${redirectUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Fixbook">
  <meta property="og:title" content="${escapedTitle}">
  <meta property="og:description" content="${escapedDesc}">
  <meta property="og:url" content="${pageUrl}">
  ${imageMetas}
  <meta name="twitter:card" content="${hasImage ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${escapedTitle}">
  <meta name="twitter:description" content="${escapedDesc}">
  ${primaryImage ? `<meta name="twitter:image" content="${primaryImage.replace(/"/g, "&quot;")}">` : ""}
  <link rel="alternate" type="application/json+oembed" href="${oEmbedUrl(listing.id).replace(/"/g, "&quot;")}" title="${escapedTitle}">
  <title>${escapedTitle}</title>
</head>
<body>
  <script>
    window.location.replace(${JSON.stringify(redirectUrl)});
  </script>
</body>
</html>`;
};

const app = new Hono();

app.get("/marketplace/item/:id", async (c) => {
  const { id } = c.req.param();

  const [listing] = await db
    .select()
    .from(listings)
    .where(eq(listings.id, id))
    .limit(1);

  if (!listing) return jsonResponse({ error: "Not found" }, 404);

  const ua = c.req.header("user-agent") ?? "";
  const isBot = /Discordbot|Slackbot|Twitterbot|facebookexternalhit/i.test(ua);

  if (isBot)
    return new Response(embedHtml(listing), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  return new Response(null, {
    status: 301,
    headers: {
      Location: facebookUrl(listing.id),
    },
  });
});

app.get("/marketplace/item/:id/oembed", async (c) => {
  const { id } = c.req.param();

  const [listing] = await db
    .select()
    .from(listings)
    .where(eq(listings.id, id))
    .limit(1);

  if (!listing) return jsonResponse({ error: "Not found" }, 404);

  const body = {
    version: "1.0",
    type: "link",
    title: listing.title,
    author_name: oEmbedAuthorLine(listing),
    author_url: facebookUrl(listing.id),
    provider_name: "Fixbook",
    provider_url: HOST.replace(/\/$/, ""),
  };
  return jsonResponse(body);
});

app.post("/", async (c) => {
  const json: unknown = await c.req.json();

  const { data, success, error } = listingSchema.safeParse(json);
  if (!success)
    return jsonResponse(
      {
        error: "Validation failed",
        issues: error.flatten(),
      },
      400,
    );

  try {
    await deleteExpiredListings();
    await db.insert(listings).values({
      id: data.id,
      title: data.title,
      price: data.price,
      listed: data.listed,
      details: data.details,
      description: data.description,
      images: data.images,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    return jsonResponse({ error: message }, 500);
  }

  return jsonResponse({ ok: true, id: data.id }, 201);
});

export default app;
