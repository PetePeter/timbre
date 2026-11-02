/** Models under evaluation. Override with TIMBRE_EVAL_MODELS (comma-separated names). */
import { createOpenAiChatClient, type ChatClient } from '../src/session/api/api-agent-loop.js';

export interface ModelSpec { name: string; baseUrl: string; model: string; apiKeyEnv?: string; reasoningEffort?: string }

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1';
const OPENROUTER = 'https://openrouter.ai/api/v1';

export const MODELS: ModelSpec[] = [
  { name: 'lfm3-1.7b', baseUrl: OLLAMA, model: 'hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M' },
  { name: 'lfm3-1.7b-nothink', baseUrl: OLLAMA, model: 'hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M', reasoningEffort: 'none' },
  { name: 'lfm2.5-2.6b', baseUrl: OLLAMA, model: 'LiquidAI/lfm2.5-2.6b:q4_k_m' },
  { name: 'ornith-1.5-9b', baseUrl: OLLAMA, model: 'hf.co/bartowski/Ornith-1.5-9B-GGUF:Q4_K_M' },
  { name: 'claude-haiku-5.5', baseUrl: OPENROUTER, model: 'anthropic/claude-haiku-5.5', apiKeyEnv: 'OPENROUTER_API_KEY' },
];

export function selectedModels(): ModelSpec[] {
  const wanted = process.env.TIMBRE_EVAL_MODELS?.split(',').map((s) => s.trim()).filter(Boolean);
  return wanted ? MODELS.filter((m) => wanted.includes(m.name)) : MODELS;
}

export function chatClient(spec: ModelSpec): ChatClient {
  const apiKey = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined;
  if (spec.apiKeyEnv && !apiKey) throw new Error(`${spec.name} needs ${spec.apiKeyEnv}`);
  return createOpenAiChatClient({ baseUrl: spec.baseUrl, model: spec.model, apiKey, temperature: 0.2, reasoningEffort: spec.reasoningEffort });
}
