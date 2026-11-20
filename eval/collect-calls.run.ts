/**
 * `npm run collect-calls` (nightly): archive new call recordings, then replay each new call
 * through the teacher and keep passing runs as training data in <dataDir>/eval/real-calls/.
 * TIMBRE_TRAINING_DIR: the archive (default X:\LLM\timbre-training, holding archive-calls.sh).
 * TIMBRE_TEACHER: a model name from eval/models.ts (default cc-opus-low).
 */
import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from '../src/config/timbre-config.js';
import { chatClient, MODELS } from './models.js';
import { collectCalls } from './real-calls.js';

it('collects training data from new real calls', async () => {
  const archive = process.env.TIMBRE_TRAINING_DIR ?? 'X:\\LLM\\timbre-training';
  const script = path.join(archive, 'archive-calls.sh');
  // Git Bash: plain `bash` on Windows is WSL, which has no %APPDATA%.
  const bash = process.env.GIT_BASH ?? 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (existsSync(script)) execFileSync(bash, [script], { stdio: 'inherit' });
  const name = process.env.TIMBRE_TEACHER ?? 'cc-opus-low';
  const spec = MODELS.find((m) => m.name === name);
  if (!spec) throw new Error(`Unknown TIMBRE_TEACHER ${name}`);
  const outDir = path.join(dataDir(), 'eval', 'real-calls');
  await collectCalls({ callsDir: path.join(archive, 'calls'), outDir, model: chatClient(spec), modelName: name });  // logs to outDir/collect.log
}, 6 * 60 * 60_000);
