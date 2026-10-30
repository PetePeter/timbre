import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContactsStore } from '../src/contacts/contacts-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeStore() {
  const dir = path.join(tmpdir(), `timbre-summary-contacts-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return { dir, store: new ContactsStore(dir, 'phone-a', '+61') };
}

const base = { name: 'Casey', numbers: ['0412345678'], group: '', trusted: true, isUser: true };

describe('ContactsStore summary notification preferences', () => {
  it('persists an explicit user preference list across restart', async () => {
    const { dir, store } = makeStore();
    const added = await store.add({ ...base, summaryNotifications: ['missed', 'left_message'] });

    expect(added.summaryNotifications).toEqual(['missed', 'left_message']);
    expect(new ContactsStore(dir, 'phone-a', '+61').list()[0]?.summaryNotifications)
      .toEqual(['missed', 'left_message']);
  });

  it('defaults new contacts to no summary notifications', async () => {
    const { store } = makeStore();

    expect((await store.add(base)).summaryNotifications).toEqual([]);
  });

  it('keeps a legacy contact with no saved preference distinguishable', () => {
    const { dir, store } = makeStore();
    const folder = path.join(dir, 'phones', 'phone-a');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'contacts.json'), JSON.stringify([{
      id: 'legacy-owner', name: 'Me', numbers: ['+61412345678'], group: '', trusted: true, isUser: true,
    }]));

    expect(store.list()[0]).not.toHaveProperty('summaryNotifications');
  });

  it('rejects unknown preference values', async () => {
    const { store } = makeStore();

    await expect(store.add({ ...base, summaryNotifications: ['spam'] })).rejects.toThrow(/summary notification/i);
  });
});
