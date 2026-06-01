import { defineConfig } from "drizzle-kit";

// For Railway production: DATABASE_URL is a real Postgres connection string.
// For local sandbox dev: we use PGlite embedded Postgres directly via the
// drizzle pglite driver — no drizzle-kit push needed in dev (schema is
// pushed automatically at server boot in storage.ts).
export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder",
  },
});
