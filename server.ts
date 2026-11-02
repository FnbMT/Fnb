import fs from "node:fs";
import path from "node:path";

// Entry point for AI Studio Build & Cloud Run deployment.
// If dist/server.cjs exists and we are not in dev mode, delegate directly to the pre-bundled production server.
// Otherwise, dynamically import the dev server handler.
const bundledServer = path.join(process.cwd(), "dist", "server.cjs");

if (fs.existsSync(bundledServer) && process.env.VITE_DEV !== "true") {
  await import(`file://${bundledServer}`);
} else {
  await import("./server.entry.ts");
}
