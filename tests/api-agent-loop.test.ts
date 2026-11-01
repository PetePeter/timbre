import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenAiChatClient } from '../src/session/api/api-agent-loop.js';

describe('OpenAI chat client reasoning effort', () => {
  let server: Server;
  let baseUrl: string;
  let requestBodies: Array<Record<string, unknown>>;

  beforeEach(async () => {
    requestBodies = [];
    server = createServer(async (request, response) => {
      let rawBody = '';
      for await (const chunk of request) rawBody += chunk.toString();
      requestBodies.push(JSON.parse(rawBody) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }],
      }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function complete(reasoningEffort: string) {
    const client = createOpenAiChatClient({ baseUrl, model: 'qwen3:8b', reasoningEffort });
    await client.complete([{ role: 'user', content: 'Hello' }], [], new AbortController().signal);
  }

  it('sends reasoning_effort when configured', async () => {
    await complete('none');

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toHaveProperty('reasoning_effort', 'none');
  });

  it('omits reasoning_effort for the empty default', async () => {
    await complete('');

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).not.toHaveProperty('reasoning_effort');
  });
});
