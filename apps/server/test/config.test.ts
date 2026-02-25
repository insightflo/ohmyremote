import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('missing TELEGRAM_BOT_TOKEN fails', () => {
  assert.throws(
    () => {
      loadConfig({
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_OWNER_USER_ID: '123456789',
      });
    },
    /TELEGRAM_BOT_TOKEN/,
  );
});

test('invalid projects schema fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohmyremote-config-'));
  const projectsPath = path.join(tempDir, 'projects.json');

  try {
    fs.writeFileSync(projectsPath, JSON.stringify([{ name: 'missing id and rootPath' }]));

    assert.throws(
      () => {
        loadConfig({
          TELEGRAM_BOT_TOKEN: 'token',
          TELEGRAM_OWNER_USER_ID: '123456789',
          PROJECTS_CONFIG_PATH: projectsPath,
        });
      },
      /Invalid projects config/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
