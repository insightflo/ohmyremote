import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Bot } from "grammy";

function loadEnv(): void {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..", "..", "..");
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config();
}

async function main(): Promise<void> {
  loadEnv();

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerUserId = Number(process.env.TELEGRAM_OWNER_USER_ID ?? "0");
  if (!token || token.trim().length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
    throw new Error("TELEGRAM_OWNER_USER_ID is required");
  }

  const bot = new Bot(token);
  await bot.api.sendMessage(ownerUserId, "OhMyRemote test message");
  console.log(`sent test message to TELEGRAM_OWNER_USER_ID=${ownerUserId}`);
}

void main();
