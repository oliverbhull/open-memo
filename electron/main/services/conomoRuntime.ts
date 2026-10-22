import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Configure the model-independent connection to the separately running service. */
export function configureConomo(env: NodeJS.ProcessEnv, runtimeRoot: string): void {
  const worker = env.CONOMO_WORKER || path.join(runtimeRoot, 'conomo');
  if (!fs.existsSync(worker)) throw new Error(`Conomo runtime worker missing: ${worker}. Run npm run build:conomo.`);
  env.MEMO_ASR_BACKEND = 'conomo';
  env.MEMO_ASR_WORKER = worker;
  env.CONOMO_SOCKET = env.CONOMO_SOCKET || path.join(os.homedir(), 'Library/Application Support/Conomo/speech.sock');
  env.MEMO_CONTEXTUAL_VOCAB = '1';
}
