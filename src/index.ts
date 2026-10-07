import { eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "./db/index.js";
import { listingSchema, listings, type Listing } from "./db/schema.js";

const BOT_UA = /Discordbot|Slackbot|Twitterbot|facebookexternalhit/i;
const MAX_EMBED_BYTES = 3000;
const ACCENT = 0x0866ff;

const facebookUrl = (id: string) =>
  `https://www.facebook.com/marketplace/item/${id}`;

const bytes = (value: string) => new TextEncoder().encode(value).length;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const blank = (value: string) =>
  !value || value === "Check Link" || value === "No description available."
    ? ""
    : value.trim();

const cleanTitle = (value: string) =>
  oneLine(
    value
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/^Marketplace\s*[-–—]\s*/i, "")
      .replace(/\s*\|\s*Facebook$/i, ""),
  );

const mdLabel = (value: string) =>
  cleanTitle(value).replaceAll(/[\[\]*]/g, "").slice(0, 120) || "Marketplace listing";

const usableImage = (url: string) =>
  url.startsWith("https://") && url.length <= 2048 && !/\/t45\./.test(url);

const locationOf = (listed: string) => {
  const cleaned = oneLine(listed.replace(/^Listed\s+/i, ""));
  const inMatch = cleaned.match(/^(.+?)\s+in\s+(.+)$/i);
  if (inMatch) return inMatch[2].trim();

  const parts = cleaned
    .split(/\s+[·•|]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" · ") : "";
};

const cleanDescription = (listing: Listing) => {
  const location = locationOf(listing.listed);
  let text = listing.description;
  for (const part of [listing.price, listing.listed, location]) {
    if (part) text = text.replaceAll(part, " ");
  }

  return text
    .replace(/\b(Location is approximate|Send seller a message|Seller's description)\b/gi, " ")
    .replace(/\s*(See more|See less)\s*$/i, "")
    .replace(/^#{1,3}\s*/gm, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const galleryImages = (urls: string[]) =>
  urls.filter((url) => usableImage(url) && /\.(png|gif|jpe?g|webp|avif)(\?|#|$)/i.test(url)).slice(0, 10);

const listedLine = (listed: string) => {
  const cleaned = oneLine(listed);
  return cleaned && !/^listed on facebook marketplace$/i.test(cleaned) ? cleaned : "";
};

const headerText = (listing: Listing, description: string) => {
  const price = blank(listing.price);
  const specs = listing.details
    .map(oneLine)
    .filter((detail) => detail.length > 1 && detail.length < 160)
    .slice(0, 8);

  return [
    `# **[${mdLabel(listing.title)}](${facebookUrl(listing.id)})**`,
    price && `**${price}**`,
    listedLine(listing.listed),
    ...specs,
    description && "",
    description,
  ]
    .filter((line) => line !== "")
    .join("\n");
};

const embedDocument = (listing: Listing, description: string, images: string[]) => ({
  component: {
    type: 17,
    accent_color: ACCENT,
    components: [
      { type: 10, content: headerText(listing, description) },
      ...(images.length
        ? [{ type: 12, items: images.map((url) => ({ media: { url } })) }]
        : []),
      { type: 14, spacing: 1 },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "View listing",
            url: facebookUrl(listing.id),
          },
        ],
      },
    ],
  },
});

const serializeEmbed = (listing: Listing, description: string, images: string[]) =>
  JSON.stringify(embedDocument(listing, description, images)).replaceAll("<", "\\u003c");

const componentEmbed = (listing: Listing) => {
  let images = galleryImages(listing.images ?? []);
  let description = blank(listing.description)
    ? cleanDescription(listing).slice(0, 400)
    : "";

  const size = () => bytes(serializeEmbed(listing, description, images));

  while (size() > MAX_EMBED_BYTES && images.length) images = images.slice(0, -1);
  while (size() > MAX_EMBED_BYTES && description) {
    const next = description
      .slice(0, Math.max(0, description.length - 40))
      .replace(/\s+\S*$/, "")
      .trimEnd();
    description = next.length < description.length ? next : "";
  }

  const json = serializeEmbed(listing, description, images);
  return bytes(json) <= MAX_EMBED_BYTES ? json : "";
};

const embedHtml = (listing: Listing, pageUrl: string) => {
  const title = cleanTitle(listing.title);
  const description = [blank(listing.price), listedLine(listing.listed), oneLine(cleanDescription(listing))]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
  const images = (listing.images ?? []).filter(usableImage).slice(0, 4);
  const payload = componentEmbed(listing);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  ${images.map((url) => `<meta property="og:image" content="${escapeHtml(url)}">`).join("\n  ")}
  <meta name="twitter:card" content="${images.length ? "summary_large_image" : "summary"}">
  ${payload ? `<script id="discord:component-embed" type="application/json">${payload}</script>` : ""}
  <meta http-equiv="refresh" content="0;url=${escapeHtml(facebookUrl(listing.id))}">
</head>
<body></body>
</html>`;
};

const app = new Hono();

app.get("/marketplace/item/:id", async (c) => {
  const { id } = c.req.param();
  const [listing] = await db.select().from(listings).where(eq(listings.id, id)).limit(1);
  if (!listing) return c.json({ error: "Not found" }, 404);

  if (!BOT_UA.test(c.req.header("user-agent") ?? "")) {
    return c.redirect(facebookUrl(id), 301);
  }

  return c.html(embedHtml(listing, new URL(`/marketplace/item/${id}`, c.req.url).href));
});

app.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = listingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", issues: parsed.error.flatten() }, 400);
  }

  try {
    await db.delete(listings).where(lt(listings.createdAt, sql`NOW() - INTERVAL '7 days'`));
    await db.insert(listings).values(parsed.data).onConflictDoUpdate({
      target: listings.id,
      set: parsed.data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database error";
    return c.json({ error: message }, 500);
  }

  return c.json({ ok: true, id: parsed.data.id }, 201);
});

export default app;
