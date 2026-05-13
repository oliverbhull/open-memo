import { AppConfig, AppCommand } from './SettingsService';
import { CommandIntent, CommandIntentEmbeddings } from './CommandIntentEmbeddings';
import { logger } from '../utils/logger';

export interface DetectedCommand {
  type: 'open_app' | 'app_command' | 'url' | 'none';
  app?: string;
  command?: string;
  url?: string;
  confidence: number;
  matchedText?: string; // The text that matched the command pattern
}

export class CommandDetector {
  private apps: AppConfig[];
  private globalCommands: AppCommand[];
  private intentEmbeddings: CommandIntentEmbeddings;
  private readonly semanticThreshold = 0.78;
  
  constructor(apps: AppConfig[] = [], globalCommands: AppCommand[] = []) {
    this.apps = apps;
    this.globalCommands = globalCommands;
    this.intentEmbeddings = new CommandIntentEmbeddings();
    this.intentEmbeddings.updateCatalog(this.apps, this.globalCommands);
  }

  updateApps(apps: AppConfig[]): void {
    this.apps = apps;
    this.updateIntentCatalog();
  }

  updateGlobalCommands(globalCommands: AppCommand[]): void {
    this.globalCommands = globalCommands;
    this.updateIntentCatalog();
  }

  detect(transcription: string, activeApp: string): DetectedCommand {
    return this.detectLexical(transcription, activeApp);
  }

  async detectWithIntent(transcription: string, activeApp: string): Promise<DetectedCommand> {
    const lexical = this.detectLexical(transcription, activeApp);
    if (lexical.type !== 'none') {
      logger.debug(`[CommandDetector] Lexical command match: type=${lexical.type}, confidence=${lexical.confidence}`);
      return lexical;
    }

    const semantic = await this.detectSemantic(transcription, activeApp);
    if (semantic.type !== 'none') {
      logger.debug(`[CommandDetector] Semantic command match: type=${semantic.type}, confidence=${semantic.confidence}`);
    }
    return semantic;
  }

  private updateIntentCatalog(): void {
    this.intentEmbeddings.updateCatalog(this.apps, this.globalCommands);
  }

  private detectLexical(transcription: string, activeApp: string): DetectedCommand {
    const text = transcription.toLowerCase().trim();
    const originalText = transcription.trim(); // Keep original case for matching
    
    // 1. Check for command-shaped "open <app>" pattern (highest priority).
    // Require the command to start the utterance so examples like
    // "I could say open Safari" stay on the dictation path.
    const openMatch = text.match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:open|launch|start|run)\s+([^\s,\.!?;:]+(?:\s+[^\s,\.!?;:]+)*?)(?:\s|[,\.!?;:]|$)/i);
    if (openMatch) {
      // Remove trailing punctuation (periods, exclamation marks, etc.)
      const appName = (openMatch[1] ?? '').replace(/[.,!?;:]+$/, '').trim();
      const app = this.findAppByAlias(appName);
      if (app) {
        const originalMatch = originalText.match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:open|launch|start|run)\s+([^\s,\.!?;:]+(?:\s+[^\s,\.!?;:]+)*?)(?:\s|[,\.!?;:]|$)/i);
        const matchedText = originalMatch ? originalMatch[0].trim() : `open ${app.name}`;
        return { type: 'open_app', app: app.name, confidence: 0.9, matchedText };
      }
    }
    
    // 2. Check for URL pattern. Keep URL execution regex-first and command-shaped.
    const urlMatch = this.detectUrl(text);
    if (urlMatch) {
      const originalMatch = originalText.match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:go to|goto|open|visit)\s+([^\s,\.!?;:]+(?:\s+[^\s,\.!?;:]+)*?)(?:\s|[,\.!?;:]|$)/i);
      const matchedText = originalMatch ? originalMatch[0].trim() : `go to ${urlMatch}`;
      return { type: 'url', url: urlMatch, confidence: 0.85, matchedText };
    }
    
    // 3. Check for global commands (works across all apps)
    const globalCmd = this.findCommand(text, this.globalCommands);
    if (globalCmd) {
      // Find the matched command text in the original transcription
      const matchedText = this.findMatchedCommandText(originalText, globalCmd);
      return { type: 'app_command', app: 'Global', command: globalCmd.trigger, confidence: 0.8, matchedText };
    }
    
    // 4. Check for app-scoped commands (if app is active)
    const activeConfig = this.findAppByName(activeApp);
    if (activeConfig) {
      const cmd = this.findCommand(text, activeConfig.commands);
      if (cmd) {
        // Find the matched command text in the original transcription
        const matchedText = this.findMatchedCommandText(originalText, cmd);
        return { type: 'app_command', app: activeApp, command: cmd.trigger, confidence: 0.8, matchedText };
      }
    }
    
    return { type: 'none', confidence: 0 };
  }

  private async detectSemantic(transcription: string, activeApp: string): Promise<DetectedCommand> {
    const candidateText = this.extractCommandCandidate(transcription);
    if (!candidateText) {
      logger.debug('[CommandDetector] No lexical candidate for semantic command detection');
      return { type: 'none', confidence: 0 };
    }

    const scopedIntents = this.intentEmbeddings.getIntentsForScope(activeApp);
    const candidateIntents = scopedIntents.filter(intent => this.hasCandidateSignal(candidateText, intent));
    if (candidateIntents.length === 0) {
      logger.debug('[CommandDetector] No scoped intents passed semantic candidate filtering');
      return { type: 'none', confidence: 0 };
    }

    const match = await this.intentEmbeddings.findBestMatch(candidateText, candidateIntents);
    if (!match) {
      logger.debug('[CommandDetector] Semantic embedding match unavailable');
      return { type: 'none', confidence: 0 };
    }

    logger.debug(
      `[CommandDetector] Semantic score=${match.score.toFixed(3)}, threshold=${this.semanticThreshold}, intent=${match.intent.id}`
    );

    if (match.score < this.semanticThreshold) {
      return { type: 'none', confidence: match.score };
    }

    if (match.intent.type === 'open_app') {
      return {
        type: 'open_app',
        app: match.intent.app,
        confidence: match.score,
        matchedText: candidateText,
      };
    }

    return {
      type: 'app_command',
      app: match.intent.app,
      command: match.intent.command,
      confidence: match.score,
      matchedText: candidateText,
    };
  }

  private extractCommandCandidate(transcription: string): string | null {
    const trimmed = transcription.trim();
    if (!trimmed) {
      return null;
    }

    const commandLikeMatch = trimmed.match(
      /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:open|launch|start|run|switch to|bring up|execute|trigger|do|make|create|new|close|save|search|find)\b[\w\s'’-]*/i
    );

    if (!commandLikeMatch) {
      return null;
    }

    return commandLikeMatch[0]
      .replace(/\b(?:and then|then|after that)\b.*$/i, '')
      .replace(/[.,!?;:]+$/g, '')
      .trim();
  }

  private hasCandidateSignal(candidateText: string, intent: CommandIntent): boolean {
    const normalizedCandidate = this.normalize(candidateText);

    if (intent.type === 'open_app') {
      return /\b(open|launch|start|run|switch to|bring up)\b/.test(normalizedCandidate);
    }

    const phraseTokens = this.contentTokens(intent.phrase);
    if (phraseTokens.length === 0) {
      return false;
    }

    const matchingTokens = phraseTokens.filter(token => this.hasToken(normalizedCandidate, token));
    const hasCommandVerb = /\b(execute|trigger|do|make|create|new|open|close|save|search|find|switch|run)\b/.test(normalizedCandidate);

    return matchingTokens.length > 0 && (hasCommandVerb || matchingTokens.length >= Math.min(2, phraseTokens.length));
  }
  
  private findMatchedCommandText(transcription: string, command: AppCommand): string {
    const normalized = transcription.toLowerCase();
    const triggerLower = command.trigger.toLowerCase();
    
    // Try exact match on trigger (with word boundaries)
    const triggerRegex = new RegExp(`\\b${this.escapeRegex(triggerLower)}\\b`, 'i');
    const triggerMatch = transcription.match(triggerRegex);
    if (triggerMatch) {
      return triggerMatch[0];
    }
    
    // Try simple contains match on trigger
    if (normalized.includes(triggerLower)) {
      const index = normalized.indexOf(triggerLower);
      // Try to find word boundaries
      let start = index;
      let end = index + command.trigger.length;
      
      // Extend to include trailing punctuation
      while (end < transcription.length && /[.,!?;:\s]/.test(transcription.charAt(end))) {
        end++;
      }
      
      return transcription.substring(start, end).trim();
    }
    
    // Try aliases with word boundaries
    for (const alias of command.aliases) {
      const aliasLower = alias.toLowerCase();
      const aliasRegex = new RegExp(`\\b${this.escapeRegex(aliasLower)}\\b`, 'i');
      const aliasMatch = transcription.match(aliasRegex);
      if (aliasMatch) {
        return aliasMatch[0];
      }
      
      // Fallback to simple contains
      if (normalized.includes(aliasLower)) {
        const index = normalized.indexOf(aliasLower);
        let start = index;
        let end = index + alias.length;
        
        // Extend to include trailing punctuation
        while (end < transcription.length && /[.,!?;:\s]/.test(transcription.charAt(end))) {
          end++;
        }
        
        return transcription.substring(start, end).trim();
      }
    }
    
    // Fallback to trigger
    return command.trigger;
  }
  
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalize(text: string): string {
    return text.toLowerCase().trim().replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ');
  }

  private contentTokens(text: string): string[] {
    const stopWords = new Set(['a', 'an', 'the', 'to', 'this', 'that', 'please', 'can', 'you']);
    return this.normalize(text)
      .split(' ')
      .filter(token => token.length > 1 && !stopWords.has(token));
  }

  private hasToken(text: string, token: string): boolean {
    return new RegExp(`\\b${this.escapeRegex(token)}\\b`, 'i').test(text);
  }
  
  private detectUrl(text: string): string | null {
    // Handle "go to X" or "open X" where X looks like a URL.
    const goToMatch = text.match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:go to|goto|open|visit)\s+([^\s,\.!?;:]+(?:\s+[^\s,\.!?;:]+)*?)(?:\s|[,\.!?;:]|$)/i);
    if (goToMatch) {
      const target = (goToMatch[1] ?? '').trim();
      
      // Check if it looks like a domain (e.g., "claude.ai", "google.com")
      if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(target)) {
        return `https://${target}`;
      }
      
      // Handle "claude dot ai" → "claude.ai"
      if (/^[a-z0-9-]+\s+dot\s+[a-z]+$/i.test(target)) {
        const normalized = target.replace(/\s+dot\s+/gi, '.');
        return `https://${normalized}`;
      }
      
      // Handle "www.claude.ai" or already has protocol
      if (/^(https?:\/\/|www\.)/i.test(target)) {
        if (target.startsWith('www.')) {
          return `https://${target}`;
        }
        return target;
      }
    }
    return null;
  }
  
  private findAppByAlias(alias: string): AppConfig | null {
    const normalizedAlias = alias.toLowerCase().trim();
    
    // First try exact match on name
    for (const app of this.apps) {
      if (!app.enabled) continue;
      if (app.name.toLowerCase() === normalizedAlias) {
        return app;
      }
    }
    
    // Then try aliases
    for (const app of this.apps) {
      if (!app.enabled) continue;
      for (const appAlias of app.aliases) {
        if (appAlias.toLowerCase() === normalizedAlias) {
          return app;
        }
      }
    }
    
    // Try fuzzy matching (contains)
    for (const app of this.apps) {
      if (!app.enabled) continue;
      if (app.name.toLowerCase().includes(normalizedAlias) || 
          normalizedAlias.includes(app.name.toLowerCase())) {
        return app;
      }
      for (const appAlias of app.aliases) {
        if (appAlias.toLowerCase().includes(normalizedAlias) ||
            normalizedAlias.includes(appAlias.toLowerCase())) {
          return app;
        }
      }
    }
    
    return null;
  }
  
  private findAppByName(name: string): AppConfig | null {
    if (!name) return null;
    const normalizedName = name.toLowerCase();
    
    for (const app of this.apps) {
      if (!app.enabled) continue;
      if (app.name.toLowerCase() === normalizedName) {
        return app;
      }
    }
    
    return null;
  }
  
  private findCommand(text: string, commands: AppCommand[]): AppCommand | null {
    const normalizedText = text.toLowerCase().trim();
    const commandText = this.stripCommandPrefix(normalizedText);
    
    for (const cmd of commands) {
      const trigger = cmd.trigger.toLowerCase();
      // Check trigger
      if (trigger === commandText) {
        return cmd;
      }
      
      // Check aliases
      for (const alias of cmd.aliases) {
        if (alias.toLowerCase() === commandText) {
          return cmd;
        }
      }
      
      // Allow commands with trailing dictated text only when the command starts the utterance.
      if (this.startsWithPhrase(commandText, trigger)) {
        return cmd;
      }
      
      for (const alias of cmd.aliases) {
        if (this.startsWithPhrase(commandText, alias.toLowerCase())) {
          return cmd;
        }
      }
    }
    
    return null;
  }

  private stripCommandPrefix(text: string): string {
    return text
      .replace(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?/, '')
      .trim();
  }

  private startsWithPhrase(text: string, phrase: string): boolean {
    if (!phrase) {
      return false;
    }

    return text === phrase || text.startsWith(`${phrase} `);
  }
}
