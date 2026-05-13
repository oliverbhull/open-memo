import { AppCommand, AppConfig } from './SettingsService';
import { logger } from '../utils/logger';

type CommandIntentType = 'open_app' | 'app_command';

export interface CommandIntent {
  id: string;
  type: CommandIntentType;
  app: string;
  command?: string;
  phrase: string;
  examples: string[];
  matchedText: string;
}

export interface IntentMatch {
  intent: CommandIntent;
  score: number;
}

type FeatureExtractionPipeline = (text: string, options?: Record<string, unknown>) => Promise<{
  data: Float32Array | number[];
}>;

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MODEL_LOAD_TIMEOUT_MS = 1200;
const MATCH_TIMEOUT_MS = 1000;

export class CommandIntentEmbeddings {
  private intents: CommandIntent[] = [];
  private catalogKey = '';
  private embeddingCache = new Map<string, Float32Array>();
  private pipeline: FeatureExtractionPipeline | null = null;
  private pipelineLoadPromise: Promise<FeatureExtractionPipeline | null> | null = null;

  updateCatalog(apps: AppConfig[], globalCommands: AppCommand[]): void {
    const enabledApps = apps.filter(app => app.enabled);
    const nextIntents = [
      ...this.buildOpenAppIntents(enabledApps),
      ...this.buildCommandIntents('Global', globalCommands),
      ...enabledApps.flatMap(app => this.buildCommandIntents(app.name, app.commands)),
    ];
    const nextKey = JSON.stringify(
      nextIntents.map(intent => ({
        id: intent.id,
        examples: intent.examples,
      }))
    );

    if (nextKey === this.catalogKey) {
      return;
    }

    this.intents = nextIntents;
    this.catalogKey = nextKey;
    this.embeddingCache.clear();

    logger.info(`[CommandIntentEmbeddings] Updated catalog with ${this.intents.length} intents`);
    this.prewarmCatalog();
  }

  async findBestMatch(text: string, candidateIntents: CommandIntent[]): Promise<IntentMatch | null> {
    if (candidateIntents.length === 0) {
      return null;
    }

    return this.withTimeout(this.findBestMatchInternal(text, candidateIntents), MATCH_TIMEOUT_MS, null);
  }

  getIntentsForScope(activeApp: string): CommandIntent[] {
    return this.intents.filter(intent => {
      if (intent.type === 'open_app') {
        return true;
      }
      return intent.app === 'Global' || this.sameApp(intent.app, activeApp);
    });
  }

  getAllIntents(): CommandIntent[] {
    return this.intents;
  }

  private async findBestMatchInternal(text: string, candidateIntents: CommandIntent[]): Promise<IntentMatch | null> {
    const inputEmbedding = await this.embed(text);
    if (!inputEmbedding) {
      return null;
    }

    await this.ensureCatalogEmbeddings(candidateIntents);

    let best: IntentMatch | null = null;
    for (const intent of candidateIntents) {
      let bestIntentScore = 0;
      for (const example of intent.examples) {
        const exampleEmbedding = this.embeddingCache.get(this.cacheKey(example));
        if (!exampleEmbedding) {
          continue;
        }

        bestIntentScore = Math.max(bestIntentScore, this.cosineSimilarity(inputEmbedding, exampleEmbedding));
      }

      if (!best || bestIntentScore > best.score) {
        best = { intent, score: bestIntentScore };
      }
    }

    return best;
  }

  private prewarmCatalog(): void {
    this.ensureCatalogEmbeddings(this.intents).catch(error => {
      logger.warn('[CommandIntentEmbeddings] Failed to prewarm catalog embeddings:', error);
    });
  }

  private async ensureCatalogEmbeddings(intents: CommandIntent[]): Promise<void> {
    const examples = Array.from(new Set(intents.flatMap(intent => intent.examples)));
    for (const example of examples) {
      await this.embed(example);
    }
  }

  private async embed(text: string): Promise<Float32Array | null> {
    const key = this.cacheKey(text);
    const cached = this.embeddingCache.get(key);
    if (cached) {
      return cached;
    }

    const extractor = await this.getPipeline();
    if (!extractor) {
      return null;
    }

    try {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const embedding = Float32Array.from(output.data);
      this.embeddingCache.set(key, embedding);
      return embedding;
    } catch (error) {
      logger.warn('[CommandIntentEmbeddings] Failed to embed text:', error);
      return null;
    }
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline | null> {
    if (this.pipeline) {
      return this.pipeline;
    }

    if (!this.pipelineLoadPromise) {
      this.pipelineLoadPromise = this.loadPipeline();
    }

    return this.withTimeout(this.pipelineLoadPromise, MODEL_LOAD_TIMEOUT_MS, null);
  }

  private async loadPipeline(): Promise<FeatureExtractionPipeline | null> {
    try {
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (
        specifier: string
      ) => Promise<{ pipeline: (task: string, model: string) => Promise<FeatureExtractionPipeline> }>;
      const { pipeline } = await dynamicImport('@huggingface/transformers');
      const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL);
      this.pipeline = extractor;
      logger.info(`[CommandIntentEmbeddings] Loaded embedding model: ${EMBEDDING_MODEL}`);
      return extractor;
    } catch (error) {
      logger.warn('[CommandIntentEmbeddings] Local embedding model unavailable; using lexical commands only:', error);
      this.pipelineLoadPromise = null;
      return null;
    }
  }

  private buildOpenAppIntents(apps: AppConfig[]): CommandIntent[] {
    return apps.flatMap(app => {
      const phrases = this.uniquePhrases([app.name, ...app.aliases]);
      return phrases.map(phrase => ({
        id: `open_app:${app.name}:${phrase}`,
        type: 'open_app' as const,
        app: app.name,
        phrase,
        matchedText: phrase,
        examples: this.openAppExamples(phrase),
      }));
    });
  }

  private buildCommandIntents(appName: string, commands: AppCommand[]): CommandIntent[] {
    return commands.flatMap(command => {
      const phrases = this.uniquePhrases([command.trigger, ...command.aliases]);
      return phrases.map(phrase => ({
        id: `app_command:${appName}:${command.trigger}:${phrase}`,
        type: 'app_command' as const,
        app: appName,
        command: command.trigger,
        phrase,
        matchedText: phrase,
        examples: this.commandExamples(phrase),
      }));
    });
  }

  private openAppExamples(phrase: string): string[] {
    return this.uniquePhrases([
      `open ${phrase}`,
      `launch ${phrase}`,
      `start ${phrase}`,
      `run ${phrase}`,
      `please open ${phrase}`,
      `can you open ${phrase}`,
      `switch to ${phrase}`,
      `bring up ${phrase}`,
    ]);
  }

  private commandExamples(phrase: string): string[] {
    return this.uniquePhrases([
      phrase,
      `please ${phrase}`,
      `can you ${phrase}`,
      `do ${phrase}`,
      `execute ${phrase}`,
      `trigger ${phrase}`,
      `run ${phrase}`,
      `make a ${phrase}`,
      `open ${phrase}`,
      `switch to ${phrase}`,
    ]);
  }

  private uniquePhrases(phrases: string[]): string[] {
    return Array.from(
      new Set(
        phrases
          .map(phrase => phrase.trim())
          .filter(Boolean)
      )
    );
  }

  private sameApp(intentApp: string, activeApp: string): boolean {
    return !!activeApp && intentApp.toLowerCase() === activeApp.toLowerCase();
  }

  private cacheKey(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>(resolve => {
          timeout = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
