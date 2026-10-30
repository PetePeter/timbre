import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppTokenStore } from '../src/config/app-token-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeStore(): AppTokenStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'timbre-app-tokens-'));
  dirs.push(dir);
  return new AppTokenStore(path.join(dir, 'app-tokens.json'));
}

describe('AppTokenStore', () => {
  it('returns the secret only when created and persists only its hash', () => {
    const store = makeStore();
    const created = store.create({ name: 'Calendar', phoneIds: ['phone-a'], actions: ['records.read'] });
    const saved = readFileSync(store.filePath, 'utf8');

    expect(created.token).toMatch(/^tm_[A-Za-z0-9_-]{40,}$/);
    expect(saved).not.toContain(created.token);
    expect(saved).toContain(createHash('sha256').update(created.token).digest('hex'));
    expect(store.list()).toEqual([created.app]);
    expect(store.list()[0]).not.toHaveProperty('hash');
    expect(store.authenticate(created.token)).toMatchObject({ id: created.app.id, name: 'Calendar', phoneIds: ['phone-a'] });
  });

  it('revokes tokens and returns no access for bad or revoked secrets', () => {
    const store = makeStore();
    const created = store.create({ name: 'Calendar', phoneIds: ['*'], actions: ['sms.send'] });

    expect(store.authenticate('bad-token')).toBeNull();
    expect(store.revoke(created.app.id)).toBe(true);
    expect(store.authenticate(created.token)).toBeNull();
    expect(store.revoke(created.app.id)).toBe(false);
  });
});
