import type { AnySchema } from 'ajv';
import type { AppAction } from '../../../config/app-token-store.js';
import type { RecordKind } from '../../../records/event-types.js';

type HttpMethod = 'GET' | 'POST';
export interface V1Route {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  action?: AppAction;
  /** App routes can run without choosing a phone line. */
  scope?: 'app' | 'phone';
  /** Record routes only return records of this kind. */
  records?: RecordKind;
  /** Server-sent events over HTTP only; not offered as an MCP tool. */
  stream?: true;
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
  CallRequest: {
    type: 'object',
    properties: {
      to: { type: 'string', minLength: 1, maxLength: 120 },
      task: { type: 'string', minLength: 1, maxLength: 4000 },
      skillId: { type: 'string', minLength: 1, maxLength: 80, description: 'Saved skill id returned by GET /v1/call-skills.' },
      params: { type: 'object', description: 'Values keyed by the selected skill fields.', additionalProperties: { type: 'string', maxLength: 1000 } },
      maxWaitMin: { type: 'number', exclusiveMinimum: 0, maximum: 60, description: 'Hang up after this many minutes without speech; default 2.' },
      mode: {
        type: 'string', enum: ['agent', 'drive'],
        description: 'agent: the built-in voice agent speaks and listens to carry out task. drive: no built-in agent; you speak with say_call and listen with call_events (needs calls.receive); task is optional.',
      },
    },
    required: [],
    additionalProperties: false,
    oneOf: [
      { required: ['to'], not: { anyOf: [{ required: ['skillId'] }, { required: ['params'] }] } },
      { required: ['skillId', 'params'], not: { anyOf: [{ required: ['to'] }, { required: ['task'] }] } },
    ],
  },
  SayRequest: objectSchema({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']),
  ConferenceRequest: objectSchema({ to: { type: 'string', minLength: 3, maxLength: 32 } }, ['to']),
};

const phoneIdParams = objectSchema({ phoneId: { type: 'string', pattern: '^[\\w-]{1,128}$' } }, ['phoneId']);
const interactionParams = objectSchema({
  phoneId: { type: 'string', pattern: '^[\\w-]{1,128}$' },
  interactionId: { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,128}$' },
}, ['phoneId', 'interactionId']);

const callIdSchema = { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' };
const liveCallId = { ...callIdSchema, description: 'Live callId or interactionId returned by create_call.' };
const callParams = objectSchema({ phoneId: { type: 'string', pattern: '^[\\w-]{1,128}$' }, callId: liveCallId }, ['phoneId', 'callId']);
const callEventsQuery = objectSchema({
  callId: { ...callIdSchema, description: 'Only this call: a live callId or the interactionId returned by create_call.' },
  after: { type: 'integer', minimum: 0, default: 0, description: 'Return events after this seq; pass the last seq you saw.' },
});

/** Live event feeds require calls.receive; controls act only on a call this app claimed or created. */
function liveCallRoutes(): V1Route[] {
  const control = (verb: string, operationId: string, summary: string, extra: Partial<V1Route> = {}): V1Route => ({
    method: 'POST', path: `/v1/phones/{phoneId}/calls/{callId}/${verb}`, operationId, summary, action: 'calls.receive', params: callParams, ...extra,
  });
  return [
    { method: 'GET', path: '/v1/phones/{phoneId}/calls/live', operationId: 'streamCallEvents', summary: 'Stream live call events (SSE): ringing inbound calls, and every call this app created', action: 'calls.receive', params: phoneIdParams, stream: true },
    { method: 'GET', path: '/v1/phones/{phoneId}/calls/events', operationId: 'callEvents', summary: 'Poll live call events: state, utterance (speaker remote = the far end; local = spoken on our side, the built-in agent included) and ended. Covers ringing inbound calls and every call this app created: pass callId = the interactionId from create_call, and after = the last seq you saw. Polling keeps the app subscribed for 30 seconds', action: 'calls.receive', params: phoneIdParams, query: callEventsQuery },
    control('answer', 'answerCall', 'Claim and answer a ringing call within the answer window'),
    control('say', 'sayCall', 'Speak text on a call this app answered or created; on a created call it is spoken alongside the built-in agent', { body: v1Schemas.SayRequest, bodyComponent: 'SayRequest' }),
    control('hold', 'holdCall', 'Hold a call this app answered or created'),
    control('resume', 'resumeCall', 'Resume a call this app answered or created'),
    control('hangup', 'hangupCall', 'Hang up a call this app answered or created'),
    control('conference', 'conferenceCall', 'Add a policy-checked number to a call this app answered or created', {
      action: 'calls.conference', params: callParams,
      body: v1Schemas.ConferenceRequest, bodyComponent: 'ConferenceRequest',
    }),
  ];
}

const pageQuery = objectSchema({
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
  cursor: { type: 'string', maxLength: 512 },
});
const searchQuery = objectSchema({ q: { type: 'string', maxLength: 512, default: '' } });

function recordRoutes(kind: RecordKind, action: AppAction): V1Route[] {
  const [segment, noun, plural, name, names] = kind === 'sms'
    ? ['sms', 'SMS', 'SMS', 'Sms', 'Sms']
    : ['calls', 'call', 'calls', 'Call', 'Calls'];
  return [
    { method: 'GET', path: `/v1/phones/{phoneId}/${segment}`, operationId: `list${names}`, summary: `List ${plural}`, action, records: kind, params: phoneIdParams, query: pageQuery },
    { method: 'GET', path: `/v1/phones/{phoneId}/${segment}/search`, operationId: `search${names}`, summary: `Search ${plural}`, action, records: kind, params: phoneIdParams, query: searchQuery },
    { method: 'GET', path: `/v1/phones/{phoneId}/${segment}/{interactionId}`, operationId: `get${name}`, summary: `Get one ${noun}`, action, records: kind, params: interactionParams },
  ];
}

export const v1Routes: readonly V1Route[] = [
  { method: 'GET', path: '/v1/phones', operationId: 'listPhones', summary: 'List phones this token can access', scope: 'app' },
  { method: 'GET', path: '/v1/call-skills', operationId: 'listCallSkills', summary: 'List reusable outbound call skills', action: 'calls.make', scope: 'app' },
  { method: 'POST', path: '/v1/phones/{phoneId}/sms', operationId: 'sendSms', summary: 'Send a policy-checked SMS', action: 'sms.send', params: phoneIdParams, body: v1Schemas.SmsRequest, bodyComponent: 'SmsRequest' },
  ...recordRoutes('sms', 'sms.list'),
  { method: 'POST', path: '/v1/phones/{phoneId}/calls', operationId: 'createCall', summary: "Place a policy-checked outbound call; the recording notice plays when answered. mode agent (default): Timbre's built-in voice agent speaks and listens to carry out task (the goal in plain words, e.g. 'Ask Octavio whether he is free for dinner on Friday') or a saved call skill, and reports back. mode drive: no built-in agent, you are the voice: poll call_events (callId = the returned interactionId, after = last seq) to hear the far end, speak with say_call, end with hangup_call; it hangs up by itself after maxWaitMin minutes without speech. Returns interactionId; call_events and the call controls need calls.receive", action: 'calls.make', params: phoneIdParams, body: v1Schemas.CallRequest, bodyComponent: 'CallRequest' },
  ...recordRoutes('call', 'calls.list'),
  ...liveCallRoutes(),
  { method: 'GET', path: '/v1/phones/{phoneId}/contacts/lookup', operationId: 'findContacts', summary: 'Find contacts by number', action: 'contacts.list', params: phoneIdParams, query: objectSchema({ number: { type: 'string', minLength: 3, maxLength: 32 } }, ['number']) },
  { method: 'GET', path: '/v1/phones/{phoneId}/contacts', operationId: 'listContacts', summary: 'List phone contacts', action: 'contacts.list', params: phoneIdParams },
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
  if (operationId === 'createCall') return { '202': { description: 'Call accepted; follow its interaction ID in records.' }, '400': { description: 'Invalid request.' }, '403': { description: 'Token scope denied.' }, '409': { description: 'Call blocked by phone policy or line state.' } };
  return { '200': { description: 'Request succeeded.' }, default: { description: 'Request error.' } };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
