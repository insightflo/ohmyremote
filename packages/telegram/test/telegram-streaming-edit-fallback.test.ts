import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedEngineEvent } from "@ohmyremote/core";

import { TelegramRunStreamer, type TelegramMessageTransport } from "../src/index.js";

class FallbackTransport implements TelegramMessageTransport {
  public sendCount = 0;
  public editCount = 0;
  private nextMessageId = 1;

  public async sendMessage(): Promise<{ messageId: number }> {
    this.sendCount += 1;
    return { messageId: this.nextMessageId++ };
  }

  public async editMessage(): Promise<void> {
    this.editCount += 1;
    throw new Error("edit failed");
  }
}

test("falls back to sendMessage when editMessage fails", async () => {
  let now = 0;
  const transport = new FallbackTransport();
  const streamer = new TelegramRunStreamer(transport, {
    editIntervalMs: 1000,
    chunkIntervalMs: 60_000,
    now: () => now,
  });

  const event: NormalizedEngineEvent = { type: "text_delta", text: "chunk" };

  now = 1000;
  await streamer.handleEvent(100, "run-2", event);

  now = 2500;
  await streamer.handleEvent(100, "run-2", event);

  assert.equal(transport.editCount, 1);
  assert.equal(transport.sendCount, 2);
});
