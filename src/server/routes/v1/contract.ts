import type { AnySchema } from 'ajv';
import type { AppAction } from '../../../config/app-token-store.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface V1Route {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  action: AppAction;
  params?: AnySchema;
  query?: AnySchema;
  body?: AnySchema;
  bodyComponent?: string;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): AnySchema => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const v1Schemas: Record<string, AnySchema> = {
  SmsRequest: objectSchema({
    to: { type: 'string', minLength: 3, maxLength: 32 },
    text: { type: 'string', minLength: 1, maxLength: 2000 },
  }, ['to', 'text']),
  ContactWrite: objectSchema({
    name: { type: 'string', minLength: 1, maxLength: 120 },
    numbers: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 3, maxLength: 32 }, uniqueItems: true },
    group: { type: 'string', maxLength: 80 },
    trusted: { type: 'boolean' },
    isUser: { type: 'boolean' },
    pin: { type: 'string', pattern: '^$|^[0-9]{6,32}$' },
    clearPin: { type: 'boolean' },
  }, ['name', 'numbers', 'group', 'trusted', 'isUser']),
};

const phoneIdParams = objectSchema({ phoneId: { type: 'string', pattern: '^[\\w-]{1,128}$' } }, ['phoneId']);
const interactionParams = objectSchema({
  phoneId: { type: 'string', pattern: '^[\\w-]{1,128}$' },
  interactionId: { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,128}$' },
}, ['phoneId', 'interactionId']);
const contactParams = objectSchema({
  phoneId: { type: 'string', pattern: '^[\\w-]{1,128}$' },
  contactId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
}, ['phoneId', 'contactId']);

export const v1Routes: readonly V1Route[] = [
  { method: 'POST', path: '/v1/phones/{phoneId}/sms', operationId: 'sendSms', summary: 'Send a policy-checked SMS', action: 'sms.send', params: phoneIdParams, body: v1Schemas.SmsRequest, bodyComponent: 'SmsRequest' },
  { method: 'GET', path: '/v1/phones/{phoneId}/records', operationId: 'listRecords', summary: 'List phone records', action: 'records.read', params: phoneIdParams, query: objectSchema({
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    cursor: { type: 'string', maxLength: 512 },
    filter: { type: 'string', enum: ['all', 'calls', 'sms', 'conferences', 'blocked'], default: 'all' },
  }) },
  { method: 'GET', path: '/v1/phones/{phoneId}/records/{interactionId}', operationId: 'getRecord', summary: 'Get one phone record', action: 'records.read', params: interactionParams },
  { method: 'GET', path: '/v1/phones/{phoneId}/search', operationId: 'searchRecords', summary: 'Search phone records', action: 'search.read', params: phoneIdParams, query: objectSchema({ q: { type: 'string', maxLength: 512, default: '' } }) },
  { method: 'GET', path: '/v1/phones/{phoneId}/contacts/lookup', operationId: 'findContacts', summary: 'Find contacts by number', action: 'contacts.read', params: phoneIdParams, query: objectSchema({ number: { type: 'string', minLength: 3, maxLength: 32 } }, ['number']) },
  { method: 'GET', path: '/v1/phones/{phoneId}/contacts', operationId: 'listContacts', summary: 'List phone contacts', action: 'contacts.read', params: phoneIdParams },
  { method: 'POST', path: '/v1/phones/{phoneId}/contacts', operationId: 'addContact', summary: 'Add a phone contact', action: 'contacts.write', params: phoneIdParams, body: v1Schemas.ContactWrite, bodyComponent: 'ContactWrite' },
  { method: 'PUT', path: '/v1/phones/{phoneId}/contacts/{contactId}', operationId: 'updateContact', summary: 'Update a phone contact', action: 'contacts.write', params: contactParams, body: v1Schemas.ContactWrite, bodyComponent: 'ContactWrite' },
  { method: 'DELETE', path: '/v1/phones/{phoneId}/contacts/{contactId}', operationId: 'deleteContact', summary: 'Delete a phone contact', action: 'contacts.write', params: contactParams },
  { method: 'POST', path: '/v1/phones/{phoneId}/calls', operationId: 'createCall', summary: 'Create an outbound call (not yet implemented)', action: 'calls.create', params: phoneIdParams },
];

export interface MatchedV1Route { route: V1Route; params: Record<string, string> }

export function matchV1Route(method: string, pathname: string): MatchedV1Route | null {
  const candidates = v1Routes.flatMap((route) => {
    const params = matchPath(route.path, pathname);
    return params ? [{ route, params, specificity: route.path.replace(/\{[^}]+\}/g, '').length }] : [];
  });
  const mostSpecific = Math.max(-1, ...candidates.map((candidate) => candidate.specificity));
  const match = candidates.find((candidate) => candidate.specificity === mostSpecific && candidate.route.method === method);
  return match ? { route: match.route, params: match.params } : null;
}

export function matchesV1Path(pathname: string): boolean {
  return v1Routes.some((route) => matchPath(route.path, pathname) !== null);
}

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of v1Routes) {
    const pathItem = paths[route.path] ?? (paths[route.path] = {});
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      security: [{ AppToken: [] }],
      parameters: [
        ...pathParameters(route.path, route.params),
        ...schemaParameters(route.query, 'query'),
      ],
      responses: responseContract(route.operationId),
    };
    if (route.bodyComponent) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${route.bodyComponent}` } } },
      };
    }
    pathItem[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Timbre REST API', version: '1.0.0' },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: { AppToken: { type: 'http', scheme: 'bearer', bearerFormat: 'Timbre app token' } },
      schemas: v1Schemas,
    },
  };
}

function matchPath(template: string, pathname: string): Record<string, string> | null {
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const pieces = template.split(/\{[^}]+\}/g);
  const pattern = `^${pieces.map((piece, index) => `${escapeRegex(piece)}${index < names.length ? '([^/]+)' : ''}`).join('')}$`;
  const match = new RegExp(pattern).exec(pathname);
  if (!match) return null;
  try { return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])); }
  catch { return Object.fromEntries(names.map((name, index) => [name, match[index + 1]])); }
}

function pathParameters(path: string, schema?: AnySchema): unknown[] {
  const properties = (schema as { properties?: Record<string, AnySchema> } | undefined)?.properties ?? {};
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1], in: 'path', required: true, schema: properties[match[1]] ?? { type: 'string' },
  }));
}

function schemaParameters(schema: AnySchema | undefined, location: 'query'): unknown[] {
  const shape = schema as { properties?: Record<string, AnySchema>; required?: string[] } | undefined;
  return Object.entries(shape?.properties ?? {}).map(([name, value]) => ({
    name, in: location, required: shape?.required?.includes(name) ?? false, schema: value,
  }));
}

function responseContract(operationId: string): Record<string, unknown> {
  if (operationId === 'createCall') return { '501': { description: 'Outbound calls are not implemented.' }, default: { description: 'Request error.' } };
  if (operationId === 'addContact') return { '201': { description: 'Contact created.' }, default: { description: 'Request error.' } };
  if (operationId === 'deleteContact') return { '204': { description: 'Contact deleted.' }, default: { description: 'Request error.' } };
  return { '200': { description: 'Request succeeded.' }, default: { description: 'Request error.' } };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
