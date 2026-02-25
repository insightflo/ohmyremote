import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildClaudeCommandSpec,
  CLAUDE_SAFE_ALLOWED_TOOLS,
  CLAUDE_UNSAFE_ALLOWED_TOOLS,
  parseClaudeJsonOutput,
  parseClaudeStreamJsonOutput,
} from "../src/claude-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test("builds json args with safe defaults", () => {
  const spec = buildClaudeCommandSpec({
    prompt: "hello",
    outputFormat: "json",
  });

  assert.equal(spec.command, "claude");
  assert.deepEqual(spec.args, [
    "-p",
    "hello",
    "--output-format",
    "json",
    "--tools",
    CLAUDE_SAFE_ALLOWED_TOOLS.join(","),
    "--allowedTools",
    CLAUDE_SAFE_ALLOWED_TOOLS.join(","),
  ]);
});

test("builds stream-json args with unsafe tools and optional limits", () => {
  const spec = buildClaudeCommandSpec({
    prompt: "unsafe task",
    outputFormat: "stream-json",
    toolPolicy: "unsafe",
    disallowedTools: ["Write"],
    maxTurns: 5,
    maxBudgetUsd: 0.5,
  });

  assert.deepEqual(spec.args, [
    "-p",
    "unsafe task",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--tools",
    CLAUDE_UNSAFE_ALLOWED_TOOLS.join(","),
    "--allowedTools",
    CLAUDE_UNSAFE_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    "Write",
    "--max-turns",
    "5",
    "--max-budget-usd",
    "0.5",
  ]);
});

test("builds session args for continue and resume+fork", () => {
  const continueSpec = buildClaudeCommandSpec({
    prompt: "continue",
    outputFormat: "json",
    session: { mode: "continue" },
  });
  assert.ok(continueSpec.args.includes("--continue"));
  assert.ok(!continueSpec.args.includes("--resume"));

  const resumeSpec = buildClaudeCommandSpec({
    prompt: "resume",
    outputFormat: "json",
    session: { mode: "resume", engineSessionId: "sess_42", forkSession: true },
  });
  assert.ok(!resumeSpec.args.includes("--continue"));
  assert.deepEqual(
    resumeSpec.args.slice(4, 7),
    ["--resume", "sess_42", "--fork-session"]
  );
});

test("parses json fixture with result and session id", () => {
  const fixturePath = path.join(__dirname, "fixtures", "claude", "json.ok.json");
  const fixture = readFileSync(fixturePath, "utf8");
  const parsed = parseClaudeJsonOutput(fixture);

  assert.equal(parsed.result, "Hello from Claude");
  assert.equal(parsed.engineSessionId, "sess_claude_123");
  assert.deepEqual(parsed.usage, { input_tokens: 12, output_tokens: 34 });
});

test("parses stream-json fixture to normalized events and tolerates malformed lines", () => {
  const fixturePath = path.join(__dirname, "fixtures", "claude", "stream-json.partial.jsonl");
  const fixture = readFileSync(fixturePath, "utf8");
  const parsed = parseClaudeStreamJsonOutput(fixture, "success");

  assert.equal(parsed.engineSessionId, "sess_stream_123");
  assert.equal(parsed.malformedLineCount, 1);
  assert.deepEqual(
    parsed.events.map((event) => event.type),
    ["run_started", "text_delta", "text_delta", "run_finished"]
  );
});

test("safe mode always uses Read/Glob/Grep by default", () => {
  const spec = buildClaudeCommandSpec({
    prompt: "default safe tools",
    outputFormat: "json",
    toolPolicy: "safe",
  });

  const toolsFlagIndex = spec.args.indexOf("--tools");
  assert.notEqual(toolsFlagIndex, -1);
  const toolsValue = spec.args[toolsFlagIndex + 1];
  assert.equal(toolsValue, "Read,Glob,Grep");

  const allowedToolsFlagIndex = spec.args.indexOf("--allowedTools");
  assert.notEqual(allowedToolsFlagIndex, -1);
  const allowedToolsValue = spec.args[allowedToolsFlagIndex + 1];
  assert.equal(allowedToolsValue, "Read,Glob,Grep");
});
