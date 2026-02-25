import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildOpenCodeCommandSpec,
  createOpenCodePermissionConfigContent,
  OPENCODE_UNSAFE_BASH_POLICY,
  parseOpenCodeJsonlOutput,
} from "../src/opencode-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("builds direct mode command for new session", () => {
  const spec = buildOpenCodeCommandSpec({ prompt: "hello opencode" });

  assert.equal(spec.command, "opencode");
  assert.deepEqual(spec.args, ["run", "hello opencode", "--format", "json"]);
});

test("builds continue mode with fork, attach, and file flags", () => {
  const spec = buildOpenCodeCommandSpec({
    prompt: "continue",
    session: { mode: "continue", forkSession: true },
    attachUrl: "ws://127.0.0.1:3000/session",
    fileAttachments: ["/tmp/a.txt", "/tmp/b.txt"],
  });

  assert.deepEqual(spec.args, [
    "run",
    "continue",
    "--format",
    "json",
    "--continue",
    "--fork",
    "--attach",
    "ws://127.0.0.1:3000/session",
    "-f",
    "/tmp/a.txt",
    "-f",
    "/tmp/b.txt",
  ]);
});

test("builds resume mode with session id", () => {
  const spec = buildOpenCodeCommandSpec({
    prompt: "resume",
    session: { mode: "resume", engineSessionId: "sess_42" },
  });

  assert.deepEqual(spec.args, [
    "run",
    "resume",
    "--format",
    "json",
    "--session",
    "sess_42",
  ]);
});

test("safe permission config denies by default and never uses ask", () => {
  const configContent = createOpenCodePermissionConfigContent("safe");
  const config = JSON.parse(configContent) as {
    permission: Record<string, unknown>;
  };

  assert.match(configContent, /^\{/);
  assert.doesNotMatch(configContent, /"ask"/i);
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.permission.read, "allow");
  assert.equal(config.permission.glob, "allow");
  assert.equal(config.permission.grep, "allow");
  assert.equal(config.permission.list, "allow");
  assert.equal(config.permission.external_directory, "deny");
  assert.equal(config.permission.edit, undefined);
});

test("unsafe permission config enables edit and restricted bash policy", () => {
  const configContent = createOpenCodePermissionConfigContent("unsafe");
  const config = JSON.parse(configContent) as {
    permission: {
      bash: Record<string, string>;
      edit: Record<string, string>;
      [key: string]: unknown;
    };
  };

  assert.doesNotMatch(configContent, /"ask"/i);
  assert.equal(config.permission["*"], "deny");
  assert.deepEqual(config.permission.edit, { "*": "allow" });
  assert.deepEqual(config.permission.bash, { ...OPENCODE_UNSAFE_BASH_POLICY });
});

test("parses jsonl fixture and maps events including file events", () => {
  const fixturePath = path.join(__dirname, "fixtures", "opencode", "events.ok.jsonl");
  const fixture = readFileSync(fixturePath, "utf8");
  const parsed = parseOpenCodeJsonlOutput(fixture, "success");

  assert.equal(parsed.malformedLineCount, 0);
  assert.equal(parsed.engineSessionId, "sess_lower_2");
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    [
      "run_started",
      "text_delta",
      "text_delta",
      "tool_start",
      "tool_end",
      "file_uploaded",
      "file_downloaded",
      "run_finished",
    ]
  );
});

test("tolerates malformed jsonl lines and reports malformed count", () => {
  const fixturePath = path.join(__dirname, "fixtures", "opencode", "events.malformed.jsonl");
  const fixture = readFileSync(fixturePath, "utf8");
  const parsed = parseOpenCodeJsonlOutput(fixture, "error");

  assert.equal(parsed.malformedLineCount, 2);
  assert.equal(parsed.engineSessionId, "sess_lower_bad");
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ["run_started", "text_delta", "run_finished"]
  );
});

test("captures engineSessionId from sessionID and sessionId", () => {
  const upper = parseOpenCodeJsonlOutput('{"type":"started","sessionID":"upper_only"}\n', "success");
  const lower = parseOpenCodeJsonlOutput('{"type":"started","sessionId":"lower_only"}\n', "success");

  assert.equal(upper.engineSessionId, "upper_only");
  assert.equal(lower.engineSessionId, "lower_only");
});
