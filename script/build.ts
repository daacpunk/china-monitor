import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Copy bundled chart fonts into dist/ so @napi-rs/canvas can register them at
  // runtime (the production container has no system fonts). charts.ts probes
  // dist/fonts as one of its candidate paths.
  console.log("copying chart fonts...");
  await mkdir("dist/fonts", { recursive: true });
  for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) {
    const src = `server/export/fonts/${f}`;
    if (existsSync(src)) await copyFile(src, `dist/fonts/${f}`);
    else console.warn(`  font missing: ${src}`);
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
