/**
 * The v1 operations behind both the REST routes and the app MCP tools, so
 * the two surfaces cannot drift. Inputs are already validated and scoped.
 */
import {
  createCallAction, findContacts, getRecord, InvalidCallRequestError,
  listContacts, listRecords, searchRecords, sendSmsAction,
} from '../../../actions/phone-actions.js';
import type { AppTokenAccess } from '../../../config/app-token-store.js';
import type { PhoneEntry } from '../../../config/timbre-config.js';
import type { CallSkill } from '../../../config/call-skills.js';
import type { Hub } from '../../../hub.js';
import { AppCallNotFoundError, AppCallRefusedError, type AppCallAction } from '../../../phone/phone-bridge.js';
import { describeLine } from '../../../phone/phone-line-service.js';
import { resolveCallRequest } from '../../../actions/call-skills.js';
import type { RecordQueryOptions } from '../../../records/event-types.js';
import type { RecordSearchIndex } from '../../../records/record-search-index.js';
import type { V1Route } from './contract.js';

export interface V1Context {
  hub: Hub;
  phones: PhoneEntry[];
  callSkills: CallSkill[];
  dataDir: string;
  log: (message: string) => void;
  searchIndex: RecordSearchIndex;
}
export interface V1Input {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
}
export interface V1Result { status: number; body: unknown }

const ok = (body: unknown): V1Result => ({ status: 200, body });
const fail = (status: number, error: string): V1Result => ({ status, body: { error } });
const CALL_CONTROL: Record<string, AppCallAction> = {
  sayCall: 'say', dtmfCall: 'dtmf', holdCall: 'hold', resumeCall: 'resume', hangupCall: 'hangup', conferenceCall: 'conference', joinCall: 'join',
};

export async function executeV1Operation(
  route: V1Route,
  context: V1Context,
  phone: PhoneEntry | undefined,
  access: AppTokenAccess,
  { params, query, body }: V1Input,
): Promise<V1Result> {
  if (route.scope === 'app') {
    switch (route.operationId) {
      case 'listPhones':
        return ok(context.phones
          .filter((item) => access.phoneIds.includes('*') || access.phoneIds.includes(item.id))
          .map(({ id, name }) => ({ id, name, status: describeLine(context.hub.line(id)?.getStatus()) })));
      case 'listCallSkills': return ok(context.callSkills);
      default: return fail(404, 'not found');
    }
  }
  if (!phone) return fail(404, 'phone not found');

  switch (route.operationId) {
    case 'sendSms':
      try { return ok(await sendSmsAction(context, phone, String(body.to), String(body.text), access.name)); }
      catch { return fail(502, 'SMS send failed'); }
    case 'listSms': case 'listCalls': {
      const result = listRecords(context, phone.id, route.records!, query as RecordQueryOptions);
      return result ? ok(result) : fail(404, 'phone not found');
    }
    case 'getSms': case 'getCall': {
      const result = getRecord(context, phone.id, route.records!, params.interactionId);
      return result ? ok(result) : fail(404, 'record not found');
    }
    case 'searchSms': case 'searchCalls': return ok(searchRecords(context, phone.id, route.records!, String(query.q ?? '')));
    case 'listContacts': return ok(listContacts(context, phone));
    case 'findContacts': return ok(findContacts(context, phone, String(query.number)));
    case 'createCall':
      try {
        const request = resolveCallRequest(body, context.callSkills);
        if (request.mode === 'drive' && !access.actions.includes('calls.receive')) {
          return fail(403, 'Drive mode needs calls.receive: the app must be able to hear and control the call.');
        }
        return { status: 202, body: await createCallAction(context, phone, request, access.name, access.id) };
      }
      catch (err) { return fail(err instanceof InvalidCallRequestError ? 400 : 409, (err as Error).message || 'call could not be started'); }
    case 'callEvents': {
      const callId = typeof query.callId === 'string' ? query.callId : undefined;
      return ok({ events: context.hub.appCalls(phone.id).poll(access.id, callId, Number(query.after ?? 0)) });
    }
    case 'answerCall': {
      const claimed = context.hub.appCalls(phone.id).claim(params.callId, { id: access.id, name: access.name });
      if (claimed === 'taken') return fail(409, 'call already answered by another app');
      if (claimed === 'unknown') return fail(404, 'call not found or no longer ringing');
      return ok({ callId: params.callId, state: 'answering' });
    }
    default: {
      const action = CALL_CONTROL[route.operationId];
      if (!action) return fail(404, 'not found');
      const arg = action === 'say' ? String(body.text) : action === 'dtmf' ? String(body.digits) : action === 'conference' ? String(body.to) : undefined;
      try {
        await context.hub.appCallAction(phone.id, params.callId, access.id, action, arg);
        return ok({ callId: params.callId, ok: true });
      } catch (err) {
        if (err instanceof AppCallNotFoundError) return fail(404, 'call not found');
        if (err instanceof AppCallRefusedError) return fail(409, err.message);
        context.log(`app call ${action} failed: ${(err as Error).message}`);
        return fail(502, `call ${action} failed`);
      }
    }
  }
}
