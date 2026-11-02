import { createAndStartServer } from "./server.app";

// Dedicated server entry point: executes server startup exactly once
createAndStartServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
