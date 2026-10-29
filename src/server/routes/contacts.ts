import type { IncomingMessage, ServerResponse } from 'node:http';
import { dataDir, type PhoneEntry } from '../../config/timbre-config.js';
import type { AddressBookContactInput } from '../../contacts/contact.js';
import { ContactsStore } from '../../contacts/contacts-store.js';

export type ContactsRoute = { phoneId: string; action: 'collection' | 'lookup' | 'contact'; contactId?: string };

export function matchContactsRoute(pathname: string): ContactsRoute | null {
  const match = /^\/api\/phones\/([\w-]+)\/contacts(?:\/(lookup|[\w-]+))?$/.exec(pathname);
  if (!match) return null;
  const segment = match[2];
  return segment === 'lookup'
    ? { phoneId: match[1], action: 'lookup' }
    : segment
      ? { phoneId: match[1], action: 'contact', contactId: segment }
      : { phoneId: match[1], action: 'collection' };
}

export interface ContactsRouteOptions {
  phones: PhoneEntry[];
  log: (message: string) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

export async function handleContactsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ContactsRouteOptions,
): Promise<boolean> {
  const route = matchContactsRoute(url.pathname);
  if (!route) return false;
  const phone = options.phones.find((candidate) => candidate.id === route.phoneId);
  if (!phone) return json(res, 404, { error: 'phone not found' });

  const contacts = new ContactsStore(dataDir(), phone.id, phone.line.countryCode, options.log);
  if (req.method === 'GET' && route.action === 'collection') return json(res, 200, contacts.list());
  if (req.method === 'GET' && route.action === 'lookup') {
    const number = url.searchParams.get('number');
    if (!number) return json(res, 400, { error: 'number is required' });
    return json(res, 200, contacts.findByNumber(number));
  }

  if (req.method === 'POST' && route.action === 'collection') {
    try {
      const contact = await contacts.add(await readInput(req, options.readJson));
      return json(res, 201, contact);
    } catch (err) { return json(res, 400, { error: (err as Error).message }); }
  }
  if (req.method === 'PUT' && route.action === 'contact') {
    try {
      const contact = await contacts.update(route.contactId!, await readInput(req, options.readJson));
      return contact ? json(res, 200, contact) : json(res, 404, { error: 'contact not found' });
    } catch (err) { return json(res, 400, { error: (err as Error).message }); }
  }
  if (req.method === 'DELETE' && route.action === 'contact') {
    if (!await contacts.delete(route.contactId!)) return json(res, 404, { error: 'contact not found' });
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  return json(res, 405, { error: 'method not allowed' });
}

async function readInput(req: IncomingMessage, readJson: ContactsRouteOptions['readJson']): Promise<AddressBookContactInput> {
  return await readJson(req) as AddressBookContactInput;
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
