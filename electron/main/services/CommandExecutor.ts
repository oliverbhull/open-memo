import { shell } from 'electron';
import { execFileSync } from 'child_process';
import type { AppConfig, CommandAction } from './SettingsService';
import { logger } from '../utils/logger';

export class CommandExecutor {
  async openApp(appConfig: AppConfig): Promise<boolean> {
    try {
      if (appConfig.bundleId) {
        // Use open -b for bundle ID (more reliable)
        execFileSync('open', ['-b', appConfig.bundleId], { stdio: 'ignore' });
        logger.info(`[CommandExecutor] Opened app via bundle ID: ${appConfig.bundleId}`);
        return true;
      } else if (appConfig.path) {
        const error = await shell.openPath(appConfig.path);
        if (error) throw new Error(error);
        logger.info(`[CommandExecutor] Opened app via path: ${appConfig.path}`);
        return true;
      } else if (appConfig.name) {
        // Fallback: use open -a with app name
        execFileSync('open', ['-a', appConfig.name], { stdio: 'ignore' });
        logger.info(`[CommandExecutor] Opened app via name: ${appConfig.name}`);
        return true;
      } else {
        logger.warn(`[CommandExecutor] No bundle ID, path, or name for app: ${appConfig.name}`);
        return false;
      }
    } catch (error) {
      logger.error(`[CommandExecutor] Failed to open app ${appConfig.name}:`, error);
      return false;
    }
  }
  
  async executeCommand(action: CommandAction): Promise<boolean> {
    switch (action.type) {
      case 'keystroke':
        return this.sendKeystroke(action.keys);
      case 'applescript':
        return this.runAppleScript(action.script);
      case 'url':
        return await this.openUrl(action.template);
    }
  }
  
  private sendKeystroke(keys: string): boolean {
    // Convert "cmd+t" to AppleScript
    const script = this.keysToAppleScript(keys);
    if (!script) return false;
    return this.runAppleScript(script);
  }
  
  private runAppleScript(script: string): boolean {
    try {
      execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
      logger.debug(`[CommandExecutor] Executed AppleScript: ${script}`);
      return true;
    } catch (error) {
      logger.error(`[CommandExecutor] Failed to execute AppleScript:`, error);
      return false;
    }
  }
  
  private keysToAppleScript(keys: string): string | null {
    // "cmd+t" → tell application "System Events" to keystroke "t" using command down
    const parts = keys.toLowerCase().split('+').map(p => p.trim());
    const key = parts.pop();
    if (!key) {
      logger.warn(`[CommandExecutor] Invalid keystroke format: ${keys}`);
      return null;
    }

    const modifiers = parts.map(m => {
      switch (m) {
        case 'cmd':
        case 'command':
          return 'command down';
        case 'shift':
          return 'shift down';
        case 'alt':
        case 'option':
          return 'option down';
        case 'ctrl':
        case 'control':
          return 'control down';
        default:
          return null;
      }
    });
    if (modifiers.some((modifier) => modifier === null)) {
      logger.warn(`[CommandExecutor] Invalid keystroke modifiers: ${keys}`);
      return null;
    }
    
    const escapedKey = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (modifiers.length > 0) {
      return `tell application "System Events" to keystroke "${escapedKey}" using {${modifiers.join(', ')}}`;
    } else {
      return `tell application "System Events" to keystroke "${escapedKey}"`;
    }
  }
  
  private async openUrl(url: string): Promise<boolean> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        logger.warn(`[CommandExecutor] Refused unsupported URL scheme: ${parsed.protocol}`);
        return false;
      }
      await shell.openExternal(parsed.toString());
      logger.info(`[CommandExecutor] Opened URL: ${url}`);
      return true;
    } catch (error) {
      logger.error(`[CommandExecutor] Failed to open URL ${url}:`, error);
      return false;
    }
  }
}
