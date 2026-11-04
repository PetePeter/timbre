/** Models under evaluation. Override with TIMBRE_EVAL_MODELS (comma-separated names). */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createOpenAiChatClient, type ChatClient, type ChatMessage, type ToolSpec } from '../src/session/api/api-agent-loop.js';

/** `claudeCode` runs the model through the local Claude Code CLI (subscription), not an HTTP API. */
export interface ModelSpec { name: string; baseUrl?: string; model: string; apiKeyEnv?: string; reasoningEffort?: string; claudeCode?: boolean }

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';

export const MODELS: ModelSpec[] = [
  { name: 'lfm3-1.7b', baseUrl: OLLAMA, model: 'hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M' },
  { name: 'lfm3-1.7b-nothink', baseUrl: OLLAMA, model: 'hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M', reasoningEffort: 'none' },
  /** LFM3 1.7B + LoRA trained on teacher runs (eval/train/lora_sft.py), imported into Ollama as f16. */
  { name: 'lfm3-timbre', baseUrl: OLLAMA, model: 'lfm3-timbre', reasoningEffort: 'none' },
  { name: 'lfm3-timbre-q4', baseUrl: OLLAMA, model: 'lfm3-timbre-q4', reasoningEffort: 'none' },
  { name: 'lfm2.5-2.6b', baseUrl: OLLAMA, model: 'LiquidAI/lfm2.5-2.6b:q4_k_m' },
  { name: 'ornith-1.5-9b', baseUrl: OLLAMA, model: 'hf.co/bartowski/Ornith-1.5-9B-GGUF:Q4_K_M' },
  { name: 'cc-haiku', model: 'haiku', claudeCode: true },
  { name: 'cc-opus-low', model: 'opus', claudeCode: true, reasoningEffort: 'low' },
  { name: 'claude-haiku-5.5', baseUrl: OPENROUTER, model: 'anthropic/claude-haiku-5.5', apiKeyEnv: 'OPENROUTER_API_KEY' },
];

export function selectedModels(): ModelSpec[] {
  const wanted = process.env.TIMBRE_EVAL_MODELS?.split(',').map((s) => s.trim()).filter(Boolean);
  return wanted ? MODELS.filter((m) => wanted.includes(m.name)) : MODELS;
}

export function chatClient(spec: ModelSpec): ChatClient {
  if (spec.claudeCode) return claudeCodeClient(spec.model, spec.reasoningEffort);
  const apiKey = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined;
  if (spec.apiKeyEnv && !apiKey) throw new Error(`${spec.name} needs ${spec.apiKeyEnv}`);
  return createOpenAiChatClient({ baseUrl: spec.baseUrl!, model: spec.model, apiKey, temperature: 0.2, reasoningEffort: spec.reasoningEffort });
}

const NEXT_MESSAGE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    content: { type: 'string' },
    tool_calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'] } },
  },
  required: ['content', 'tool_calls'],
});

/** One completion per `claude -p` run: the conversation goes in as JSON, the next assistant message comes back via a schema. */
function claudeCodeClient(model: string, effort?: string): ChatClient {
  return {
    async complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const rest = messages.filter((m) => m.role !== 'system');
      const prompt = [
        system,
        '',
        'You are this assistant. You receive the conversation so far and the available tools as JSON.',
        'Return only your next assistant message: "content" is your text (empty string to stay silent), "tool_calls" the tools to call now (may be empty).',
      ].join('\n');
      const args = ['-p', '--model', model, ...(effort ? ['--effort', effort] : []), '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--no-session-persistence',
        '--system-prompt', prompt, '--json-schema', NEXT_MESSAGE_SCHEMA, '--output-format', 'json'];
      const out = await new Promise<string>((resolve, reject) => {
        const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], signal });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`claude exited ${code}: ${stdout.slice(0, 300)}`))));
        child.stdin.end(JSON.stringify({ messages: rest, tools }));
      });
      const reply = (JSON.parse(out) as { structured_output?: { content: string; tool_calls: Array<{ name: string; arguments: unknown }> } }).structured_output;
      if (!reply) throw new Error(`claude returned no structured output: ${out.slice(0, 300)}`);
      const toolCalls = reply.tool_calls.map((call) => ({
        id: `cc-${randomUUID()}`, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      }));
      return { message: { content: reply.content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finishReason: 'stop' };
    },
  };
}
