import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { telefonyAdminPort } from '../src/phone/setup/telefony-admin.js';

describe('telefony admin ports', () => {
  let phonesDir = '';

  afterEach(() => {
    if (phonesDir) rmSync(phonesDir, { recursive: true, force: true });
    phonesDir = '';
  });

  it('allocates unique ports for colliding hashes and persists each phone allocation', async () => {
    phonesDir = mkdtempSync(path.join(os.tmpdir(), 'timbre-admin-ports-'));
    const [first, second] = await Promise.all([
      telefonyAdminPort('phone-114', phonesDir),
      telefonyAdminPort('phone-158', phonesDir),
    ]);

    expect(first).not.toBe(second);
    expect(await telefonyAdminPort('phone-114', phonesDir)).toBe(first);
    expect(await telefonyAdminPort('phone-158', phonesDir)).toBe(second);
    expect(JSON.parse(readFileSync(path.join(phonesDir, 'telefony-admin-ports.json'), 'utf8')))
      .toMatchObject({ 'phone-114': first, 'phone-158': second });
  });
});
