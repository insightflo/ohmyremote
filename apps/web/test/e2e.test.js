import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../src/App.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installDom(pathname = "/") {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost${pathname}`,
  });

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "history", { value: dom.window.history, configurable: true });
  Object.defineProperty(globalThis, "location", { value: dom.window.location, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "MouseEvent", { value: dom.window.MouseEvent, configurable: true });

  return dom;
}

test("projects page and run detail render without crashing", async () => {
  const dom = installDom("/");
  const root = createRoot(document.getElementById("root"));

  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    fetchCalls.push(value);

    if (value === "/api/projects") {
      return {
        ok: true,
        json: async () => [
          {
            id: "project-1",
            name: "Project One",
            rootPath: "/tmp/project",
            defaultEngine: "claude",
          },
        ],
      };
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  await act(async () => {
    root.render(React.createElement(App));
    await flush();
    await flush();
  });

  assert.equal(fetchCalls.includes("/api/projects"), true);
  assert.match(document.body.textContent ?? "", /Project One/);

  await act(async () => {
    window.history.pushState({}, "", "/runs/run-1");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    await flush();
    await flush();
  });

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "/api/runs/run-1") {
      return {
        ok: true,
        json: async () => ({ id: "run-1", projectId: "project-1", sessionId: "session-1", status: "completed" }),
      };
    }

    if (value === "/api/runs/run-1/events") {
      return {
        ok: true,
        json: async () => [
          { id: "event-1", seq: 1, eventType: "run_started", payloadJson: "{}" },
          { id: "event-2", seq: 2, eventType: "run_finished", payloadJson: "{}" },
        ],
      };
    }

    throw new Error(`unexpected fetch ${value}`);
  };

  assert.match(document.body.textContent ?? "", /run_started/);

  await act(async () => {
    root.unmount();
    await flush();
  });
  dom.window.close();
});

test("api failures show a degraded error banner", async () => {
  const dom = installDom("/");
  const root = createRoot(document.getElementById("root"));

  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: async () => ({}),
  });

  await act(async () => {
    root.render(React.createElement(App));
    await flush();
    await flush();
  });

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent ?? "", /Failed to load projects/);

  await act(async () => {
    root.unmount();
    await flush();
  });
  dom.window.close();
});
