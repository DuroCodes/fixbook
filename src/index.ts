import { eq } from "drizzle-orm";
import { lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { listings, listingSchema, type Listing } from "./db/schema.js";
import { db } from "./db/index.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.FIXBOOK_HOST ?? `http://localhost:${PORT}`;
const ITEM_PATH = (id: string) => `/api/marketplace/item/${id}`;
const facebookUrl = (id: string) =>
  `https://www.facebook.com/marketplace/item/${id}`;
const projectUrl = (id: string) => `${HOST.replace(/\/$/, "")}${ITEM_PATH(id)}`;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const deleteExpiredListings = async () =>
  await db
    .delete(listings)
    .where(lt(listings.createdAt, sql`NOW() - INTERVAL '7 days'`));

const embedDescription = (listing: Listing) =>
  [
    `<b>Price:</b> ${listing.price}`,
    `<b>Listed:</b> ${listing.listed}`,
    ...(listing.details.length > 0
      ? ["<b>Details:</b>", ...listing.details.map((d) => `- ${d}`)]
      : []),
    "Description:",
    listing.description,
  ].join("<br>");

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
  <meta property="og:title" content="${escapedTitle}">
  <meta property="og:description" content="${escapedDesc}">
  <meta property="og:url" content="${pageUrl}">
  ${imageMetas}
  <meta name="twitter:card" content="${hasImage ? "summary_large_image" : "summary"}">
  <meta name="twitter:title" content="${escapedTitle}">
  <meta name="twitter:description" content="${escapedDesc}">
  ${primaryImage ? `<meta name="twitter:image" content="${primaryImage.replace(/"/g, "&quot;")}">` : ""}
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
