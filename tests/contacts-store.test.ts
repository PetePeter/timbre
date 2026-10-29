import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContactsStore } from '../src/contacts/contacts-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function makeStore(countryCode = '+61', log = () => undefined) {
  const dir = path.join(tmpdir(), `timbre-contacts-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return { dir, store: new ContactsStore(dir, 'phone-a', countryCode, log) };
}

describe('ContactsStore', () => {
  it('normalizes input and persists the address book across a restart', async () => {
    const { dir, store } = makeStore();
    const added = await store.add({
      name: 'Jordan Lee',
      numbers: ['(0412) 345 678', '0061 2 9876 5432'],
      group: 'Family',
      trusted: true,
      isUser: true,
    });

    expect(added.numbers).toEqual(['+61412345678', '+61298765432']);
    expect(new ContactsStore(dir, 'phone-a', '+61').list()).toEqual([added]);
  });

  it('matches caller IDs after E.164, international-prefix, or national formatting', async () => {
    const { store } = makeStore();
    const added = await store.add({
      name: 'Jordan Lee', numbers: ['0412 345 678'], group: '', trusted: false, isUser: false,
    });

    expect(store.findByNumber('+61 (412) 345-678')).toEqual([added]);
    expect(store.findByNumber('0061 412 345 678')).toEqual([added]);
    expect(store.findByNumber('0412-345-678')).toEqual([added]);
    expect(store.findByNumber('private')).toEqual([]);
  });

  it('isolates a phone book from other phone IDs', async () => {
    const dir = path.join(tmpdir(), `timbre-contacts-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    const first = new ContactsStore(dir, 'phone-a', '+61');
    const second = new ContactsStore(dir, 'phone-b', '+61');
    await first.add({ name: 'Jordan', numbers: ['0412345678'], group: '', trusted: true, isUser: false });

    expect(second.list()).toEqual([]);
  });

  it('reports corrupt persisted data and throws instead of returning an empty book', () => {
    const dir = path.join(tmpdir(), `timbre-contacts-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    const folder = path.join(dir, 'phones', 'phone-a');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'contacts.json'), '{ broken');
    const messages: string[] = [];

    expect(() => new ContactsStore(dir, 'phone-a', '+61', (message) => messages.push(message)).list())
      .toThrow(/contacts file/i);
    expect(messages).toHaveLength(1);
  });

});
