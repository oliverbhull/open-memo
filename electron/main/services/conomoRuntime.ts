import fs from 'node:fs';
import path from 'node:path';

/** Configure the model-independent connection to the separately running service. */
export function configureConomo(env: NodeJS.ProcessEnv, runtimeRoot: string): void {
  const worker = env.CONOMO_WORKER || path.join(runtimeRoot, 'conomo');
  if (!fs.existsSync(worker)) throw new Error(`Conomo runtime worker missing: ${worker}. Run npm run build:conomo.`);
  env.MEMO_ASR_BACKEND = 'conomo';
  env.MEMO_ASR_WORKER = worker;
  // Leave routing to the bridge: bundled workers select a versioned private
  // socket; external workers select their shared default. Preserve explicit overrides.
  env.MEMO_CONTEXTUAL_VOCAB = '1';
}
