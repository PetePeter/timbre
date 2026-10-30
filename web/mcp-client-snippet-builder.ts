export interface McpClientSetupSnippets {
  claudeCode: string;
  codex: string;
  copilot: string;
}

/** Builds user-level HTTP MCP setup snippets for the supported command-line clients. */
export class McpClientSnippetBuilder {
  build(url: string, token: string, serverName = 'timbre'): McpClientSetupSnippets {
    const authorization = `Bearer ${token}`;
    const jsonServer = {
      type: 'http',
      url,
      headers: { Authorization: authorization },
      tools: ['*'],
    };

    return {
      claudeCode: `claude mcp add --scope user --transport http ${serverName} ${url} --header "Authorization: ${authorization}"`,
      codex: [
        `[mcp_servers.${serverName}]`,
        `url = ${JSON.stringify(url)}`,
        `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
      ].join('\n'),
      copilot: JSON.stringify({ mcpServers: { [serverName]: jsonServer } }, null, 2),
    };
  }
}
