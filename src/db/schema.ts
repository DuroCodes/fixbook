import { sql } from "drizzle-orm";
import { z } from "zod";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const listings = pgTable("listings", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  price: text("price").notNull(),
  listed: text("listed").notNull(),
  details: text("details").array().notNull(),
  description: text("description").notNull(),
  images: text("images")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Listing = typeof listings.$inferSelect;

export const listingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  price: z.string().min(1),
  listed: z.string().min(1),
  details: z.array(z.string()),
  description: z.string().min(1),
  images: z.array(z.string().url()).default([]),
});
