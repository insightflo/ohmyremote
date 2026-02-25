import { startLongPolling } from "./index.js";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..", "..", "..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.trim().length === 0) {
    console.warn("TELEGRAM_BOT_TOKEN is not set; bot start skipped.");
    return;
  }

  await startLongPolling(token);
}

void main();
