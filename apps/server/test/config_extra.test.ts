import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

test('valid config succeeds with defaults', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohmyremote-config-ok-'));
  const projectsPath = path.join(tempDir, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([]));

  try {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_OWNER_USER_ID: '123456789',
      PROJECTS_CONFIG_PATH: projectsPath,
    });

    assert.strictEqual(config.TELEGRAM_BOT_TOKEN, 'token');
    assert.strictEqual(config.TELEGRAM_OWNER_USER_ID, 123456789);
    assert.strictEqual(config.DASHBOARD_BIND_HOST, '127.0.0.1');
    assert.strictEqual(config.DASHBOARD_PORT, 4312);
    assert.strictEqual(config.MAX_UPLOAD_BYTES, 26214400);
    assert.deepStrictEqual(config.projects, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
