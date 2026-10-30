import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContactsStore } from '../src/contacts/contacts-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function createStore() {
  const dir = path.join(tmpdir(), `timbre-contact-pin-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return { dir, store: new ContactsStore(dir, 'phone-a', '+61') };
}

describe('contact PIN storage', () => {
  it('stores a salted scrypt hash and exposes only PIN status', async () => {
    const { dir, store } = createStore();
    const pin = '864209';
    const contact = await store.add({ name: 'Maya', numbers: ['0491570156'], group: 'Family', trusted: true, isUser: false, pin });
    const pinFile = path.join(dir, 'phones', 'phone-a', 'contact-pins.json');
    const stored = readFileSync(pinFile, 'utf8');

    expect(contact).toMatchObject({ pinSet: true, pinNeedsReentry: false });
    expect(contact).not.toHaveProperty('pin');
    expect(stored).not.toContain(pin);
    expect(stored).toMatch(/"salt"\s*:/);
    expect(stored).toMatch(/"hash"\s*:/);
    expect(store.verifyPin(contact.id, pin)).toBe(true);
    expect(store.verifyPin(contact.id, '000000')).toBe(false);
    expect(store.list()[0]).not.toHaveProperty('pin');
  });

  it('persists a re-entry marker until a new PIN is set, and clears it with the PIN', async () => {
    const { dir, store } = createStore();
    const contact = await store.add({ name: 'Maya', numbers: ['0491570156'], group: '', trusted: true, isUser: false });
    store.markPinNeedsReentry(contact.id);

    const reloaded = new ContactsStore(dir, 'phone-a', '+61');
    expect(reloaded.list()[0]).toMatchObject({ pinSet: false, pinNeedsReentry: true });

    const updated = await reloaded.update(contact.id, {
      name: contact.name, numbers: contact.numbers, group: contact.group,
      trusted: contact.trusted, isUser: contact.isUser, pin: '135790',
    });
    expect(updated).toMatchObject({ pinSet: true, pinNeedsReentry: false });
    expect(reloaded.verifyPin(contact.id, '135790')).toBe(true);

    const cleared = await reloaded.update(contact.id, {
      name: contact.name, numbers: contact.numbers, group: contact.group,
      trusted: contact.trusted, isUser: contact.isUser, clearPin: true,
    });
    expect(cleared).toMatchObject({ pinSet: false, pinNeedsReentry: false });
    expect(reloaded.verifyPin(contact.id, '135790')).toBe(false);
    expect(existsSync(path.join(dir, 'phones', 'phone-a', 'contacts.json'))).toBe(true);
  });

  it('refuses PINs for contacts that are neither the user nor trusted', async () => {
    const { store } = createStore();
    await expect(store.add({ name: 'Unknown', numbers: ['0491570156'], group: '', trusted: false, isUser: false, pin: '135790' }))
      .rejects.toThrow(/user or trusted contact/);
  });
});
