# fixbook

Bun server that accepts listing payloads via POST and stores them in Neon (Postgres) with Drizzle. Records are kept for 7 days; older rows are removed on each request.

## Setup

```bash
bun install
```

Copy `.env.example` to `.env` and set `DATABASE_URL` to your [Neon](https://neon.tech) connection string. Then push the schema:

```bash
bun run db:push
```

## Run

```bash
bun start
```

Listens on `PORT` (default 3000).

## API

**GET /marketplace/item/:id** — Serves HTML with Open Graph and Twitter meta tags so Discord (and other platforms) render a rich embed with the listing's title, price, listed date, details, and description. Browsers are redirected immediately to `facebook.com/marketplace/item/:id`. The path matches Facebook's structure so you can replace `facebook.com` with your project URL when sharing. Set `FIXBOOK_HOST` so `og:url` points to your deployed URL.

**POST /** — Create a listing. Body (JSON):

| Field       | Type     | Required |
|------------|----------|----------|
| `id`       | string   | yes      |
| `title`    | string   | yes      |
| `price`    | string   | yes      |
| `listed`   | string   | yes      |
| `details`  | string[] | yes      |
| `description` | string | yes      |
| `images`      | string[] | no (default `[]`) – image URLs for the embed |

Example:

```bash
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -d '{"id":"abc","title":"Widget","price":"$10","listed":"today","details":["new"],"description":"A widget.","images":["https://example.com/img1.jpg"]}'
```

Responses: `201` with `{ "ok": true, "id": "..." }`, or `4xx/5xx` with `{ "error": "..." }`.

## 7-day retention

On every POST, the server deletes rows where `created_at < NOW() - 7 days`. No cron or worker is required; cleanup runs in-process with each insert.
