import { eq } from "drizzle-orm";
import { lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { listings, listingSchema, type Listing } from "./db/schema.js";
import { db } from "./db/index.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST =
  process.env.FIXBOOK_HOST ??
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://localhost:${PORT}`);
const ITEM_PATH = (id: string) => `/marketplace/item/${id}`;
const facebookUrl = (id: string) =>
  `https://www.facebook.com/marketplace/item/${id}`;
const projectUrl = (id: string) => `${HOST.replace(/\/$/, "")}${ITEM_PATH(id)}`;
const oEmbedUrl = (id: string) => `${projectUrl(id)}/oembed`;
const BOT_UA_REGEX = /Discordbot|Slackbot|Twitterbot|facebookexternalhit/i;
const MAX_DESCRIPTION_LENGTH = 200;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const deleteExpiredListings = async () =>
  await db
    .delete(listings)
    .where(lt(listings.createdAt, sql`NOW() - INTERVAL '7 days'`));

const escapeHtmlAttr = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

const truncate = (value: string, maxLength: number) =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3).trimEnd()}...`;

function parseListed(listed: string): { timeAgo: string; location?: string } {
  const cleaned = normalizeWhitespace(listed.replace(/^Listed\s+/i, ""));
  const inMatch = cleaned.match(/^(.+?)\s+in\s+(.+)$/i);
  if (inMatch)
    return { timeAgo: inMatch[1].trim(), location: inMatch[2].trim() };

  const parts = cleaned
    .split(/\s+[·•|]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return { timeAgo: parts[0], location: parts.slice(1).join(" / ") };
  }

  return { timeAgo: cleaned || "Listed on Facebook Marketplace" };
}

function summarizeDetails(details: string[]): string {
  if (details.length === 0) return "";
  const values = details
    .flatMap((detail) =>
      detail
        .split(" · ")
        .map((part) =>
          part.includes(":")
            ? part.replace(/^[^:]+:\s*/, "").trim()
            : part.trim(),
        ),
    )
    .filter(Boolean);
  return values.slice(0, 5).join(" / ");
}

function cleanDescription(description: string, listing: Listing): string {
  let out = description;

  out = out.replace(new RegExp(escapeRegex(listing.price), "gi"), " ");
  out = out.replace(new RegExp(escapeRegex(listing.listed), "gi"), " ");

  const { location } = parseListed(listing.listed);
  if (location) {
    out = out.replace(new RegExp(escapeRegex(location), "gi"), " ");
  }

  out = out
    .replace(/\bLocation is approximate\b/gi, " ")
    .replace(/\bSend seller a message\b/gi, " ")
    .replace(/\bSeller's description\b/gi, " ");

  out = out.replace(/\s*(See more|See less)\s*$/gi, " ");

  return normalizeWhitespace(out);
}

function listingMetaLine(listing: Listing): string {
  const { timeAgo, location } = parseListed(listing.listed);
  const details = summarizeDetails(listing.details);
  const parts = [
    `💵 ${listing.price}`,
    `📅 ${timeAgo}`,
    ...(location ? [`📍 ${location}`] : []),
    ...(details ? [`🏷️ ${details}`] : []),
  ];
  return truncate(parts.join(" • "), 255);
}

const embedDescription = (listing: Listing) => {
  const cleanedDescription = cleanDescription(listing.description, listing);
  return cleanedDescription
    ? truncate(cleanedDescription, MAX_DESCRIPTION_LENGTH)
    : listingMetaLine(listing);
};

const embedHtml = (listing: Listing) => {
  const pageUrl = projectUrl(listing.id);
  const redirectUrl = facebookUrl(listing.id);
  const desc = embedDescription(listing);
  const escapedTitle = escapeHtmlAttr(listing.title);
  const escapedDesc = escapeHtmlAttr(desc);
  const primaryImage = listing.images?.at(0);
  const hasImage = !!primaryImage;

  const imageMetas = primaryImage
    ? listing.images
        .map(
          (url) =>
            `<meta property="og:image" content="${escapeHtmlAttr(url)}">`,
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
  ${primaryImage ? `<meta name="twitter:image" content="${escapeHtmlAttr(primaryImage)}">` : ""}
  <link rel="alternate" type="application/json+oembed" href="${escapeHtmlAttr(oEmbedUrl(listing.id))}" title="${escapedTitle}">
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
  const isBot = BOT_UA_REGEX.test(ua);

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
    author_name: listingMetaLine(listing),
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
    const row = {
      id: data.id,
      title: data.title,
      price: data.price,
      listed: data.listed,
      details: data.details,
      description: data.description,
      images: data.images,
    };
    await db
      .insert(listings)
      .values(row)
      .onConflictDoUpdate({
        target: listings.id,
        set: {
          title: row.title,
          price: row.price,
          listed: row.listed,
          details: row.details,
          description: row.description,
          images: row.images,
        },
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message, detail }, 500);
  }

  return jsonResponse({ ok: true, id: data.id }, 201);
});

export default app;
