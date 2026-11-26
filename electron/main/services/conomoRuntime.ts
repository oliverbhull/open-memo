import fs from 'node:fs';
import path from 'node:path';
import { resolveModelAssetPath } from './ModelAssets';

/** Configure the local speech worker used by the macOS dictation sidecar. */
export function configureConomo(env: NodeJS.ProcessEnv, runtimeRoot: string): void {
  const worker = env.CONOMO_WORKER || path.join(runtimeRoot, 'conomo');
  if (!fs.existsSync(worker)) throw new Error(`Conomo runtime worker missing: ${worker}. Run npm run build:conomo.`);
  if (!env.CONOMO_WORKER) env.CONOMO_MODEL_DIR = resolveModelAssetPath('conomo', runtimeRoot);
  env.MEMO_ASR_BACKEND = 'conomo';
  env.MEMO_ASR_WORKER = worker;
  // Worker implementations own their routing, including explicit socket overrides.
}
