import { shell } from 'electron';
import { execSync } from 'child_process';
import { AppConfig, CommandAction } from './SettingsService';
import { logger } from '../utils/logger';

export class CommandExecutor {
  async openApp(appConfig: AppConfig): Promise<boolean> {
    try {
      if (appConfig.bundleId) {
        // Use open -b for bundle ID (more reliable)
        execSync(`open -b ${appConfig.bundleId}`, { stdio: 'ignore' });
        logger.info(`[CommandExecutor] Opened app via bundle ID: ${appConfig.bundleId}`);
        return true;
      } else if (appConfig.path) {
        await shell.openPath(appConfig.path);
        logger.info(`[CommandExecutor] Opened app via path: ${appConfig.path}`);
        return true;
      } else if (appConfig.name) {
        // Fallback: use open -a with app name
        execSync(`open -a "${appConfig.name}"`, { stdio: 'ignore' });
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
        return this.openUrl(action.template);
    }
  }
  
  private sendKeystroke(keys: string): boolean {
    // Convert "cmd+t" to AppleScript
    const script = this.keysToAppleScript(keys);
    return this.runAppleScript(script);
  }
  
  private runAppleScript(script: string): boolean {
    try {
      // Escape single quotes in the script
      const escapedScript = script.replace(/'/g, "'\"'\"'");
      execSync(`osascript -e '${escapedScript}'`, { stdio: 'ignore' });
      logger.debug(`[CommandExecutor] Executed AppleScript: ${script}`);
      return true;
    } catch (error) {
      logger.error(`[CommandExecutor] Failed to execute AppleScript:`, error);
      return false;
    }
  }
  
  private keysToAppleScript(keys: string): string {
    // "cmd+t" → tell application "System Events" to keystroke "t" using command down
    const parts = keys.toLowerCase().split('+').map(p => p.trim());
    const key = parts.pop();
    if (!key) {
      logger.warn(`[CommandExecutor] Invalid keystroke format: ${keys}`);
      return '';
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
          return '';
      }
    }).filter(Boolean);
    
    if (modifiers.length > 0) {
      return `tell application "System Events" to keystroke "${key}" using {${modifiers.join(', ')}}`;
    } else {
      return `tell application "System Events" to keystroke "${key}"`;
    }
  }
  
  private openUrl(url: string): boolean {
    try {
      shell.openExternal(url);
      logger.info(`[CommandExecutor] Opened URL: ${url}`);
      return true;
    } catch (error) {
      logger.error(`[CommandExecutor] Failed to open URL ${url}:`, error);
      return false;
    }
  }
}
