import { describe, expect, it } from 'vitest';
import { McpClientSnippetBuilder } from './mcp-client-snippet-builder';

describe('McpClientSnippetBuilder', () => {
  it('builds user-level HTTP bearer setup for Claude Code, Codex, and Copilot CLI', () => {
    const snippets = new McpClientSnippetBuilder().build('http://localhost:4321/mcp/phone-a', 'phone_secret-123');

    expect(snippets.claudeCode).toBe(
      'claude mcp add --scope user --transport http timbre http://localhost:4321/mcp/phone-a --header "Authorization: Bearer phone_secret-123"',
    );
    expect(snippets.codex).toBe([
      '[mcp_servers.timbre]',
      'url = "http://localhost:4321/mcp/phone-a"',
      'http_headers = { Authorization = "Bearer phone_secret-123" }',
    ].join('\n'));
    expect(JSON.parse(snippets.copilot)).toEqual({
      mcpServers: {
        timbre: {
          type: 'http',
          url: 'http://localhost:4321/mcp/phone-a',
          headers: { Authorization: 'Bearer phone_secret-123' },
          tools: ['*'],
        },
      },
    });
  });
});
