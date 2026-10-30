import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppTokenAccess } from '../../../config/app-token-store.js';
import { addContact, createCallAction, deleteContact, findContacts, getRecord, InvalidCallRequestError, listContacts, listRecords, searchRecords, sendSmsAction, updateContact } from '../../../actions/phone-actions.js';
import type { PhoneEntry } from '../../../config/timbre-config.js';
import type { Hub } from '../../../hub.js';
import type { RecordSearchIndex } from '../../../records/record-search-index.js';
import { matchV1Route, matchesV1Path } from './contract.js';

export interface V1HandlerOptions {
  hub: Hub;
  phones: PhoneEntry[];
  dataDir: string;
  log: (message: string) => void;
  searchIndex: RecordSearchIndex;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true, strict: false });
const validators = new WeakMap<object, ValidateFunction>();

export async function handleV1Request(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: V1HandlerOptions,
  access: AppTokenAccess,
): Promise<boolean> {
  const matched = matchV1Route(req.method ?? '', url.pathname);
  if (!matched) return json(res, matchesV1Path(url.pathname) ? 405 : 404, { error: matchesV1Path(url.pathname) ? 'method not allowed' : 'not found' });
  const { route, params } = matched;
  const paramErrors = validate(route.params, params);
  if (paramErrors) return json(res, 400, { error: 'invalid request', details: paramErrors });

  const phone = options.phones.find((item) => item.id === params.phoneId);
  if (!phone) return json(res, 404, { error: 'phone not found' });
  if (!access.phoneIds.includes('*') && !access.phoneIds.includes(phone.id)) return json(res, 403, { error: 'phone scope denied' });
  if (!access.actions.includes(route.action)) return json(res, 403, { error: 'action scope denied' });

  const parsedQuery = queryValues(url);
  if (parsedQuery.duplicate) return json(res, 400, { error: 'duplicate query parameter' });
  const query = parsedQuery.values;
  const queryErrors = validate(route.query, query);
  if (queryErrors) return json(res, 400, { error: 'invalid request', details: queryErrors });

  let body: unknown;
  if (route.body) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'application/json required' });
    try { body = await options.readJson(req); }
    catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const bodyErrors = validate(route.body, body);
    if (bodyErrors) return json(res, 400, { error: 'invalid request', details: bodyErrors });
  }

  const context = { hub: options.hub, dataDir: options.dataDir, log: options.log, searchIndex: options.searchIndex };
  switch (route.operationId) {
    case 'sendSms': {
      try {
        const input = body as { to: string; text: string };
        return json(res, 200, await sendSmsAction(context, phone, input.to, input.text, access.name));
      } catch {
        return json(res, 502, { error: 'SMS send failed' });
      }
    }
    case 'listRecords': {
      const result = listRecords(context, phone.id, query as { limit?: number; cursor?: string; filter?: 'all' | 'calls' | 'sms' | 'conferences' | 'blocked' });
      return result ? json(res, 200, result) : json(res, 404, { error: 'phone not found' });
    }
    case 'getRecord': {
      const result = getRecord(context, phone.id, params.interactionId);
      return result ? json(res, 200, result) : json(res, 404, { error: 'record not found' });
    }
    case 'searchRecords': return json(res, 200, searchRecords(context, phone.id, String(query.q ?? '')));
    case 'listContacts': return json(res, 200, listContacts(context, phone));
    case 'findContacts': return json(res, 200, findContacts(context, phone, String(query.number)));
    case 'addContact': {
      try { return json(res, 201, await addContact(context, phone, body as never)); }
      catch { return json(res, 400, { error: 'contact is invalid' }); }
    }
    case 'updateContact': {
      try {
        const contact = await updateContact(context, phone, params.contactId, body as never);
        return contact ? json(res, 200, contact) : json(res, 404, { error: 'contact not found' });
      } catch { return json(res, 400, { error: 'contact is invalid' }); }
    }
    case 'deleteContact': {
      if (!await deleteContact(context, phone, params.contactId)) return json(res, 404, { error: 'contact not found' });
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    case 'createCall': {
      try { return json(res, 202, await createCallAction(context, phone, body, access.name)); }
      catch (err) {
        return json(res, err instanceof InvalidCallRequestError ? 400 : 409, { error: (err as Error).message || 'call could not be started' });
      }
    }
    default: return json(res, 404, { error: 'not found' });
  }
}

function validate(schema: AnySchema | undefined, value: unknown): Array<{ path: string; message: string }> | null {
  if (!schema) return null;
  const existing = validators.get(schema as object);
  const validator = existing ?? ajv.compile(schema);
  if (!existing) validators.set(schema as object, validator);
  if (validator(value)) return null;
  return (validator.errors ?? []).map((error) => ({ path: error.instancePath, message: error.message ?? 'invalid value' }));
}

function queryValues(url: URL): { values: Record<string, string>; duplicate: boolean } {
  const query: Record<string, string> = {};
  let duplicate = false;
  for (const [key, value] of url.searchParams) {
    if (key in query) duplicate = true;
    query[key] = value;
  }
  return { values: query, duplicate };
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

