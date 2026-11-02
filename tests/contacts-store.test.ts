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

  it('persists transfer target flags and allows only one catch-all per phone', async () => {
    const { dir, store } = makeStore();
    const reception = await store.add({
      name: 'Reception', numbers: ['0412 345 678'], group: 'Work', trusted: false, isUser: false,
      transferTarget: true, defaultTransfer: true,
    });
    const clinician = await store.add({
      name: 'Dr Lee', numbers: ['0412 345 679'], group: 'Work', trusted: false, isUser: false,
      transferTarget: true, defaultTransfer: false,
    });

    expect(reception).toMatchObject({ transferTarget: true, defaultTransfer: true });
    expect(clinician).toMatchObject({ transferTarget: true, defaultTransfer: false });
    expect(new ContactsStore(dir, 'phone-a', '+61').list()).toEqual([reception, clinician]);
    await expect(store.add({
      name: 'Second Reception', numbers: ['0412 345 680'], group: '', trusted: false, isUser: false,
      transferTarget: true, defaultTransfer: true,
    })).rejects.toThrow(/one default transfer/i);
    await expect(store.update(clinician.id, {
      name: clinician.name, numbers: clinician.numbers, group: clinician.group, trusted: clinician.trusted, isUser: clinician.isUser,
      transferTarget: true, defaultTransfer: true,
    })).rejects.toThrow(/one default transfer/i);
    await expect(store.add({
      name: 'Invalid', numbers: ['0412 345 681'], group: '', trusted: false, isUser: false,
      transferTarget: false, defaultTransfer: true,
    })).rejects.toThrow(/must be a transfer target/i);
  });

  it('defaults missing transfer flags on legacy contacts to false', async () => {
    const { store } = makeStore();
    const added = await store.add({ name: 'Old contact', numbers: ['0412 345 678'], group: '', trusted: false, isUser: false });

    expect(added).toMatchObject({ transferTarget: false, defaultTransfer: false });
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
