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

  // Regression: Ollama 0.40 rejects null content ("invalid message content type: <nil>"), breaking every tool round.
  it('sends empty text, not null, for assistant tool-call and silent messages', async () => {
    const client = createOpenAiChatClient({ baseUrl, model: 'm' });
    await client.complete([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'chat_send', arguments: '{}' } }] },
      { role: 'tool', content: 'sent', tool_call_id: 't1' },
      { role: 'assistant', content: null },
    ], []);

    const sent = requestBodies[0].messages as Array<{ content: unknown }>;
    expect(sent.map((message) => message.content)).toEqual(['Hello', '', 'sent', '']);
  });
});

describe('OpenAI chat client streamed replies', () => {
  let server: Server;
  let chunks: string[];

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) response.write(`data: ${chunk}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = () => {
    const address = server.address() as { port: number };
    return createOpenAiChatClient({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'm' });
  };

  // Regression: a call agent that rightly stays silent was treated as a failed model and hung up.
  it('accepts a finished reply with no text as deliberate silence', async () => {
    chunks = [
      JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    await expect(client().complete([{ role: 'user', content: '(The call connected.)' }], [])).resolves
      .toMatchObject({ message: { content: null }, finishReason: 'stop' });
  });

  it('still fails a stream that never finishes a choice', async () => {
    chunks = [JSON.stringify({ error: { message: 'upstream overloaded' } })];
    await expect(client().complete([{ role: 'user', content: 'Hi' }], [])).rejects.toThrow(/no choices/);
  });
});
