import fs from "node:fs";
import path from "node:path";

// Load environment variables from .env and .env.local if present
if (typeof process.loadEnvFile === "function") {
  const envPath = path.join(process.cwd(), ".env");
  const envLocal = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    try { process.loadEnvFile(envPath); } catch (_) {}
  }
  if (fs.existsSync(envLocal)) {
    try { process.loadEnvFile(envLocal); } catch (_) {}
  }
}

// Default to dev mode if NODE_ENV is not production
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "development";
}
if (!process.env.VITE_DEV && process.env.NODE_ENV !== "production") {
  process.env.VITE_DEV = "true";
}

// Entry point for AI Studio Build & Cloud Run deployment.
// If dist/server.cjs exists and we are not in dev mode, delegate directly to the pre-bundled production server.
// Otherwise, dynamically import the dev server handler.
const bundledServer = path.join(process.cwd(), "dist", "server.cjs");

if (fs.existsSync(bundledServer) && process.env.VITE_DEV !== "true") {
  await import(`file://${bundledServer}`);
} else {
  await import("./server.entry.ts");
}
