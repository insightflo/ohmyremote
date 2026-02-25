import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedEngineEvent } from "@ohmyremote/core";

import { TelegramRunStreamer, type TelegramMessageTransport } from "../src/index.js";

class CountingTransport implements TelegramMessageTransport {
  public sendCount = 0;
  public editCount = 0;
  private nextMessageId = 1;

  public async sendMessage(): Promise<{ messageId: number }> {
    this.sendCount += 1;
    return { messageId: this.nextMessageId++ };
  }

  public async editMessage(): Promise<void> {
    this.editCount += 1;
  }
}

test("coalesces high-rate deltas to throttled status updates", async () => {
  let now = 0;
  const transport = new CountingTransport();
  const streamer = new TelegramRunStreamer(transport, {
    editIntervalMs: 1000,
    chunkIntervalMs: 60_000,
    now: () => now,
  });

  const event: NormalizedEngineEvent = { type: "text_delta", text: "x" };

  for (let i = 0; i < 350; i += 1) {
    now = i * 10;
    await streamer.handleEvent(100, "run-1", event);
  }

  assert.equal(transport.sendCount >= 1, true);
  assert.equal(transport.editCount <= 3, true);
});
