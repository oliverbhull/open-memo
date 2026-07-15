import { AppConfig, AppCommand } from './SettingsService';
import { logger } from '../utils/logger';

export interface DetectedCommand {
  type: 'open_app' | 'app_command' | 'url' | 'none';
  app?: string;
  command?: string;
  url?: string;
  confidence: number;
  matchedText?: string; // The text that matched the command pattern
}

export interface DetectedCommandSequence {
  commands: DetectedCommand[];
  remainingText: string;
}

interface DetectionOptions {
  allowBareUrl?: boolean;
}

interface CommandSegment {
  text: string;
  start: number;
  end: number;
}

interface UrlMatch {
  url: string;
  matchedText: string;
}

export class CommandDetector {
  private apps: AppConfig[];
  private globalCommands: AppCommand[];
  private readonly maxCommandChainLength = 5;
  
  constructor(apps: AppConfig[] = [], globalCommands: AppCommand[] = []) {
    this.apps = apps;
    this.globalCommands = globalCommands;
  }

  updateApps(apps: AppConfig[]): void {
    this.apps = apps;
  }

  updateGlobalCommands(globalCommands: AppCommand[]): void {
    this.globalCommands = globalCommands;
  }

  detectSequence(transcription: string, activeApp: string): DetectedCommandSequence {
    const trimmed = transcription.trim();
    if (!trimmed) {
      return { commands: [], remainingText: '' };
    }

    const segments = this.splitCommandSegments(transcription);
    const commands: DetectedCommand[] = [];
    let currentApp = activeApp;
    let lastConsumedEnd = 0;
    let segmentIndex = 0;

    while (segmentIndex < segments.length) {
      if (commands.length >= this.maxCommandChainLength) {
        break;
      }

      const segment = segments[segmentIndex];
      if (!segment) {
        segmentIndex++;
        continue;
      }

      const detected = this.detectLexical(segment.text, currentApp, {
        allowBareUrl: commands.length > 0,
      });
      if (detected.type !== 'none') {
        logger.debug(`[CommandDetector] Command match: type=${detected.type}, confidence=${detected.confidence}`);
      }

      if (detected.type === 'none' || detected.confidence <= 0.7) {
        if (commands.length === 0) {
          return { commands: [], remainingText: trimmed };
        }

        return {
          commands,
          remainingText: this.cleanRemainingText(transcription.slice(segment.start)),
        };
      }

      commands.push(detected);
      lastConsumedEnd = this.segmentConsumedEnd(transcription, segment, detected);

      if (detected.type === 'open_app' && detected.app) {
        currentApp = detected.app;
      }

      if (lastConsumedEnd < segment.end) {
        const remainder = this.trimCommandSegment(transcription, lastConsumedEnd, segment.end);
        if (remainder) {
          segments.splice(segmentIndex + 1, 0, remainder);
        }
      }

      segmentIndex++;
    }

    if (commands.length === 0) {
      return { commands: [], remainingText: trimmed };
    }

    return {
      commands,
      remainingText: this.cleanRemainingText(transcription.slice(lastConsumedEnd)),
    };
  }

  private detectLexical(
    transcription: string,
    activeApp: string,
    options: DetectionOptions = {}
  ): DetectedCommand {
    const text = transcription.toLowerCase().trim();
    const originalText = transcription.trim(); // Keep original case for matching
    
    // 1. Check for command-shaped "open <app>" pattern (highest priority).
    // Require the command to start the utterance so examples like
    // "I could say open Safari" stay on the dictation path.
    const openAppMatch = this.detectOpenApp(originalText);
    if (openAppMatch) {
      return openAppMatch;
    }
    
    // 2. Check for URL pattern. Keep URL execution regex-first and command-shaped.
    const urlMatch = this.detectUrl(originalText, options);
    if (urlMatch) {
      return { type: 'url', url: urlMatch.url, confidence: 0.85, matchedText: urlMatch.matchedText };
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

  private detectOpenApp(originalText: string): DetectedCommand | null {
    const openMatch = originalText.match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:open|launch|start|run)\s+(.+)$/i);
    if (!openMatch) {
      return null;
    }

    const commandPrefix = openMatch[0].slice(0, openMatch[0].length - (openMatch[1] ?? '').length);
    const targetText = (openMatch[1] ?? '').trim();
    const configuredPhrases = this.apps
      .filter(app => app.enabled)
      .flatMap(app => [app.name, ...app.aliases].map(phrase => ({ app, phrase: phrase.trim() })))
      .filter(({ phrase }) => phrase.length > 0)
      .sort((a, b) => b.phrase.length - a.phrase.length);

    for (const { app, phrase } of configuredPhrases) {
      const phraseMatch = targetText.match(new RegExp(`^${this.escapeRegex(phrase)}(?=$|[\\s,\\.!?;:])`, 'i'));
      if (phraseMatch) {
        const matchedText = `${commandPrefix}${phraseMatch[0]}`.trim();
        return { type: 'open_app', app: app.name, confidence: 0.9, matchedText };
      }
    }

    const fallbackMatch = targetText.match(/^([^\s,\.!?;:]+(?:\s+[^\s,\.!?;:]+)*?)(?:\s|[,\.!?;:]|$)/i);
    if (!fallbackMatch) {
      return null;
    }

    const appName = (fallbackMatch[1] ?? '').replace(/[.,!?;:]+$/, '').trim();
    const app = this.findAppByAlias(appName);
    if (!app) {
      return null;
    }

    const matchedText = `${commandPrefix}${fallbackMatch[0]}`.trim();
    return { type: 'open_app', app: app.name, confidence: 0.9, matchedText };
  }
  
  private detectUrl(text: string, options: DetectionOptions = {}): UrlMatch | null {
    // Handle "go to X" or "open X" where X looks like a URL.
    const commandMatch = text.match(/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:go to|goto|open|visit)\s+(.+)$/i);
    if (commandMatch) {
      const commandPrefix = commandMatch[0].slice(0, commandMatch[0].length - (commandMatch[1] ?? '').length);
      const parsed = this.parseUrlTarget(commandMatch[1] ?? '');
      if (parsed) {
        return {
          url: parsed.url,
          matchedText: `${commandPrefix}${parsed.matchedText}`.trim(),
        };
      }
    }

    if (!options.allowBareUrl) {
      return null;
    }

    return this.parseUrlTarget(text);
  }

  private parseUrlTarget(rawTarget: string): UrlMatch | null {
    const target = rawTarget.trim().replace(/[.,!?;:]+$/g, '');
    if (!target) {
      return null;
    }

    const explicitMatch = target.match(/^(https?:\/\/[^\s,!?;:]+|www\.[^\s,!?;:]+)/i);
    if (explicitMatch) {
      const matchedText = (explicitMatch[1] ?? '').replace(/[.,!?;:]+$/g, '');
      if (!matchedText) {
        return null;
      }

      return {
        url: matchedText.toLowerCase().startsWith('www.') ? `https://${matchedText}` : matchedText,
        matchedText,
      };
    }

    const writtenDomainMatch = target.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\b|$)/i);
    if (writtenDomainMatch) {
      const domain = (writtenDomainMatch[1] ?? '').replace(/[.,!?;:]+$/g, '');
      if (this.isDomainLike(domain)) {
        return {
          url: `https://${domain}`,
          matchedText: domain,
        };
      }
    }

    const spokenDotMatch = target.match(/^([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)(?:\b|$)/i);
    if (spokenDotMatch) {
      const spoken = (spokenDotMatch[1] ?? '').trim();
      const domain = spoken.replace(/\s+dot\s+/gi, '.');
      if (this.isDomainLike(domain)) {
        return {
          url: `https://${domain}`,
          matchedText: spoken,
        };
      }
    }

    return null;
  }

  private isDomainLike(domain: string): boolean {
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain) && /\.[a-z]{2,}$/i.test(domain);
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

  private splitCommandSegments(transcription: string): CommandSegment[] {
    const segments: CommandSegment[] = [];
    const separatorRegex = /[,;\n]+|\b(?:and then|then|after that)\b|\band\b(?=\s+(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:open|launch|start|run|go to|goto|visit|new|close|save|search|find|switch to|bring up|execute|trigger|do|make|create)\b)/gi;
    let start = 0;
    let match: RegExpExecArray | null;

    while ((match = separatorRegex.exec(transcription)) !== null) {
      const segment = this.trimCommandSegment(transcription, start, match.index);
      if (segment) {
        segments.push(segment);
      }
      start = match.index + match[0].length;
    }

    const finalSegment = this.trimCommandSegment(transcription, start, transcription.length);
    if (finalSegment) {
      segments.push(finalSegment);
    }

    return segments;
  }

  private trimCommandSegment(source: string, rawStart: number, rawEnd: number): CommandSegment | null {
    let start = rawStart;
    let end = rawEnd;

    while (start < end && /[\s,;:]/.test(source.charAt(start))) {
      start++;
    }

    while (end > start && /[\s,;:]/.test(source.charAt(end - 1))) {
      end--;
    }

    while (end > start && /[.!?]/.test(source.charAt(end - 1))) {
      end--;
    }

    const text = source.slice(start, end).trim();
    if (!text) {
      return null;
    }

    return { text, start, end };
  }

  private segmentConsumedEnd(source: string, segment: CommandSegment, detected: DetectedCommand): number {
    if (!detected.matchedText) {
      return segment.end;
    }

    const segmentText = source.slice(segment.start, segment.end);
    const segmentLower = segmentText.toLowerCase();
    const matchedLower = detected.matchedText.toLowerCase().trim();
    const matchIndex = segmentLower.indexOf(matchedLower);

    if (matchIndex === -1) {
      return segment.end;
    }

    let end = segment.start + matchIndex + detected.matchedText.length;
    while (end < source.length && /[\s,;:]/.test(source.charAt(end))) {
      end++;
    }

    return end;
  }

  private cleanRemainingText(text: string): string {
    return text
      .replace(/^[\s,;:]+/, '')
      .replace(/^(?:and then|then|after that|and)\b[\s,;:]*/i, '')
      .trim();
  }
}
