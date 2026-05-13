import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { loadSettings, store, AppConfig } from './SettingsService';
import { CommandDetector, DetectedCommand } from './CommandDetector';
import { CommandExecutor } from './CommandExecutor';
import { AudioSourceManager } from './AudioSourceManager';

export interface AppContext {
  appName: string;
  windowTitle: string;
}

export interface TranscriptionData {
  rawTranscript: string;
  processedText: string;
  wasProcessedByLLM: boolean;
  appContext?: AppContext;
}

export type MemoSttStatus = 'stopped' | 'running' | 'error';

// Track instances for debugging
let instanceCount = 0;

export interface AudioData {
  opusBuffer: Buffer;
  wavBuffer?: Buffer; // WAV data for playback
  duration: number;
  timestamp: number;
}

export class MemoSttService extends EventEmitter {
  private process: ChildProcess | null = null;
  private stdinClosed: boolean = false;
  private status: MemoSttStatus = 'stopped';
  private buffer: string = '';
  private hotkey: string = 'function';
  private restartAttempts: number = 0;
  private restartTimeout: NodeJS.Timeout | null = null;
  private readonly MAX_RESTART_ATTEMPTS = 5;
  private readonly RESTART_DELAY_BASE = 2000;
  private readonly MAX_BUFFER_SIZE = 1024 * 1024; // 1MB max buffer size
  private readonly instanceId: number;
  private pendingAudioData: AudioData | null = null; // Buffer audio data until transcription arrives
  private commandDetector: CommandDetector;
  private commandExecutor: CommandExecutor;
  private audioSourceManager: AudioSourceManager | null = null;
  /** Timer for BLE inactivity: if no CONNECTED:/audio for this long, infer disconnect (safety net when Rust never sends DISCONNECTED:) */
  private bleActivityTimeoutHandle: NodeJS.Timeout | null = null;
  private readonly BLE_INACTIVITY_TIMEOUT_MS = 28000;

  constructor(bleStateManager: null, audioSourceManager?: AudioSourceManager) {
    super();
    instanceCount++;
    this.instanceId = instanceCount;
    logger.info(`[MemoSttService] Creating instance #${this.instanceId} (total instances: ${instanceCount})`);

    if (instanceCount > 1) {
      logger.warn(`[MemoSttService] WARNING: Multiple instances detected! Current: #${this.instanceId}, Total: ${instanceCount}`);
    }

    // Store references to state managers
    this.audioSourceManager = audioSourceManager || null;

    // Wire up AudioSourceManager commands
    if (this.audioSourceManager) {
      this.audioSourceManager.on('commandSetInputSource', (source: string, micId?: string) => {
        if (source === 'ble') {
          this.sendCommand('INPUT_SOURCE:ble');
        } else {
          this.sendCommand(`INPUT_SOURCE:system`);
        }
      });
    }

    // Initialize command detector and executor
    this.commandDetector = new CommandDetector([]);
    this.commandExecutor = new CommandExecutor();

    // Load initial vocabulary from settings
    this.updateVocabulary();
  }

  setHotkey(hotkey: string): void {
    this.hotkey = hotkey;
  }

  /**
   * Send command to memo-stt process via stdin
   * Used for settings like "Press Enter After Paste"
   */
  sendCommand(command: string): void {
    const childProcess = this.process;
    const stdin = childProcess?.stdin;

    if (
      childProcess &&
      stdin &&
      !childProcess.killed &&
      !this.stdinClosed &&
      !stdin.destroyed &&
      !stdin.writableEnded &&
      !stdin.writableFinished
    ) {
      try {
        const success = stdin.write(command + '\n');
        logger.debug(`[MemoSttService #${this.instanceId}] Sent command: ${command}`);
        
        // If write returns false, the stream buffer is full - wait for drain
        if (!success) {
          stdin.once('drain', () => {
            logger.debug(`[MemoSttService #${this.instanceId}] stdin drained after sending: ${command}`);
          });
        }
      } catch (error: any) {
        // Handle EPIPE and other write errors gracefully
        // EPIPE means the process has closed stdin (likely exiting)
        this.handleStdinError(error, command);
      }
    } else {
      logger.warn(`[MemoSttService #${this.instanceId}] Cannot send command: process not running or stdin not available: ${command}`);
    }
  }

  private handleStdinError(error: NodeJS.ErrnoException, command?: string): void {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED' || error.code === 'ERR_STREAM_WRITE_AFTER_END') {
      this.stdinClosed = true;
      const commandSuffix = command ? ` while sending: ${command}` : '';
      logger.debug(`[MemoSttService #${this.instanceId}] Process stdin closed (${error.code})${commandSuffix}`);
      return;
    }

    logger.error(`[MemoSttService #${this.instanceId}] memo-stt stdin error:`, error);
  }

  /**
   * Set whether to press Enter after pasting
   */
  setPressEnterAfterPaste(enabled: boolean): void {
    this.sendCommand(`ENTER:${enabled ? '1' : '0'}`);
  }

  /**
   * Set Memo device button policy: hold-to-talk when enabled, tap-to-toggle when disabled.
   */
  setPushToTalkMode(enabled: boolean): void {
    this.sendCommand(`PTT:${enabled ? '1' : '0'}`);
  }

  /**
   * Update vocabulary for voice commands
   */
  updateVocabulary(): void {
    const settings = loadSettings();
    const boostWordsRaw = Array.isArray(settings.vocabWords) ? settings.vocabWords : [];
    const boostWords = Array.from(
      new Set(
        boostWordsRaw
          .map(w => (typeof w === 'string' ? w.trim() : ''))
          .filter(Boolean)
      )
    );

    const voiceCommandsEnabled = !!settings.voiceCommands?.enabled;
    const vocab: any = {
      boostWords,
      voiceCommandsEnabled,
    };

    if (voiceCommandsEnabled) {
      const apps = settings.voiceCommands?.apps || [];
      const enabledApps = apps.filter(a => a.enabled);
      const globalCommands = settings.voiceCommands?.globalCommands || [];

      // Update command detector with current apps and global commands
      this.commandDetector.updateApps(enabledApps);
      this.commandDetector.updateGlobalCommands(globalCommands);

      // Build structured vocabulary: app names stay global (for "open X"),
      // but commands are keyed per-app so memo-stt only injects the active app's
      // commands into the Whisper prompt, preventing hallucination of irrelevant triggers.
      const appNames = enabledApps.flatMap(a => [a.name, ...a.aliases]);
      const appCommandMap: Record<string, string[]> = {};
      for (const app of enabledApps) {
        const key = app.name.toLowerCase();
        appCommandMap[key] = app.commands.flatMap(c => [c.trigger, ...c.aliases]);
      }
      const globalCommandNames = globalCommands.flatMap(c => [c.trigger, ...c.aliases]);

      vocab.appNames = appNames;
      vocab.appCommands = appCommandMap;
      vocab.globalCommands = globalCommandNames;

      logger.info(
        `[MemoSttService] Updated vocabulary: ${boostWords.length} boost words, ${appNames.length} app names, ${Object.keys(appCommandMap).length} apps with commands, ${globalCommandNames.length} global commands`
      );
    } else {
      // Keep detector empty when voice commands disabled
      this.commandDetector.updateApps([]);
      this.commandDetector.updateGlobalCommands([]);
      logger.info(`[MemoSttService] Updated vocabulary: ${boostWords.length} boost words (voice commands disabled)`);
    }

    this.sendCommand(`VOCAB:${JSON.stringify(vocab)}`);
  }

  /**
   * Execute a detected command
   */
  private async executeCommand(detectedCommand: DetectedCommand, apps: AppConfig[]): Promise<void> {
    try {
      if (detectedCommand.type === 'open_app') {
        const app = apps.find(a => a.name === detectedCommand.app);
        if (app) {
          const success = await this.commandExecutor.openApp(app);
          if (success) {
            this.emit('commandExecuted', { type: 'open_app', app: app.name });
            logger.info(`[MemoSttService] Executed: opened ${app.name}`);
          }
        }
      } else if (detectedCommand.type === 'app_command') {
        // Check if it's a global command
        if (detectedCommand.app === 'Global') {
          const settings = loadSettings();
          const globalCommands = settings.voiceCommands?.globalCommands || [];
          const cmd = globalCommands.find(c => c.trigger === detectedCommand.command);
          if (cmd) {
            const success = await this.commandExecutor.executeCommand(cmd.action);
            if (success) {
              this.emit('commandExecuted', { 
                type: 'app_command', 
                app: 'Global', 
                command: cmd.trigger 
              });
              logger.info(`[MemoSttService] Executed global command: ${cmd.trigger}`);
            }
          }
        } else {
          // App-specific command
          const app = apps.find(a => a.name === detectedCommand.app);
          if (app && detectedCommand.command) {
            const cmd = app.commands.find(c => c.trigger === detectedCommand.command);
            if (cmd) {
              const success = await this.commandExecutor.executeCommand(cmd.action);
              if (success) {
                this.emit('commandExecuted', { 
                  type: 'app_command', 
                  app: app.name, 
                  command: cmd.trigger 
                });
                logger.info(`[MemoSttService] Executed: ${cmd.trigger} in ${app.name}`);
              }
            }
          }
        }
      } else if (detectedCommand.type === 'url') {
        if (detectedCommand.url) {
          const success = await this.commandExecutor.executeCommand({ 
            type: 'url', 
            template: detectedCommand.url 
          });
          if (success) {
            this.emit('commandExecuted', { type: 'url', url: detectedCommand.url });
            logger.info(`[MemoSttService] Executed: opened ${detectedCommand.url}`);
          }
        }
      }
    } catch (error) {
      logger.error('[MemoSttService] Error executing command:', error);
    }
  }

  start(): void {
    if (this.process && !this.process.killed) {
      logger.info(`[MemoSttService #${this.instanceId}] memo-stt process already running`);
      return;
    }
    
    logger.info(`[MemoSttService #${this.instanceId}] Starting memo-stt service`);

    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    // Clear BLE activity timeout and reset state
    this.clearBleActivityTimeout();
    this.isBleConnected = false;

    // Reset restart attempts on manual start
    this.restartAttempts = 0;

    try {
      // Spawn memo-stt process
      // In dev mode, use cargo run. In production, use bundled binary.
      const isDev = process.env.NODE_ENV === 'development' || 
                    (typeof process.env.npm_lifecycle_event !== 'undefined' && 
                     process.env.npm_lifecycle_event.includes('dev')) ||
                    !app.isPackaged;
      
      let command: string;
      let args: string[];
      
      if (isDev) {
        // Development: use cargo run
        command = 'cargo';
        const sttManifestPath = process.env.MEMO_STT_PATH
          ? path.join(process.env.MEMO_STT_PATH, 'Cargo.toml')
          : path.join(process.cwd(), '..', 'memo-stt', 'Cargo.toml');
        args = ['run', '--manifest-path', sttManifestPath, '--bin', 'memo-stt', '--features', 'binary', '--', '--hotkey', this.hotkey, '--no-inject'];
      } else {
        // Production: use bundled binary
        const prodPath = path.join(process.resourcesPath, 'sttbin', 'memo-stt');
        
        // Fallback paths if binary not found in expected location
        const alternatives = [
          prodPath,
          path.join(app.getAppPath(), '..', '..', 'Resources', 'sttbin', 'memo-stt'),
          path.join(process.resourcesPath, 'memo-stt'),
        ];
        
        let binaryPath = prodPath;
        for (const altPath of alternatives) {
          if (fs.existsSync(altPath)) {
            binaryPath = altPath;
            logger.info(`[MemoSttService #${this.instanceId}] Found memo-stt binary at: ${binaryPath}`);
            break;
          }
        }
        
        if (!fs.existsSync(binaryPath)) {
          const errorMsg = `memo-stt binary not found in any expected location. Tried: ${alternatives.join(', ')}. resourcesPath: ${process.resourcesPath}, appPath: ${app.getAppPath()}`;
          logger.error(`[MemoSttService #${this.instanceId}] ${errorMsg}`);
          throw new Error(errorMsg);
        }
        
        // Verify binary is executable
        try {
          const stats = fs.statSync(binaryPath);
          const isExecutable = (stats.mode & parseInt('111', 8)) !== 0;
          logger.info(`[MemoSttService #${this.instanceId}] Binary stats: mode=${stats.mode.toString(8)}, executable=${isExecutable}, size=${stats.size}`);
          
          if (!isExecutable) {
            logger.warn(`[MemoSttService #${this.instanceId}] Binary is not executable, attempting to fix...`);
            fs.chmodSync(binaryPath, 0o755);
            logger.info(`[MemoSttService #${this.instanceId}] Set binary permissions to 755`);
          }
        } catch (statError) {
          logger.error(`[MemoSttService #${this.instanceId}] Failed to check binary stats:`, statError);
        }
        
        // Verify code signing (if on macOS)
        if (process.platform === 'darwin') {
          try {
            const { execSync } = require('child_process');
            const codesignCheck = execSync(`codesign -dv "${binaryPath}" 2>&1 || echo "NOT_SIGNED"`, { encoding: 'utf8' });
            logger.info(`[MemoSttService #${this.instanceId}] Code signing check: ${codesignCheck.trim()}`);
          } catch (signError) {
            logger.warn(`[MemoSttService #${this.instanceId}] Could not verify code signing:`, signError);
          }
        }
        
        command = binaryPath;
        args = ['--hotkey', this.hotkey, '--no-inject'];
      }

      // Get input source from settings
      const settings = loadSettings();
      const isDevAutoConnect = isDev && !!process.env.MEMO_DEV_AUTO_CONNECT_UID;
      const inputSource = isDevAutoConnect
        ? 'ble'
        : (settings.inputSource || 'system');
      const handsFreeMode = settings.handsFreeMode ?? false;

      logger.info(`[MemoSttService #${this.instanceId}] Starting memo-stt: ${command} ${args.join(' ')}`);
      logger.info(`[MemoSttService #${this.instanceId}] Input source: ${inputSource}`);
      logger.info(`[MemoSttService #${this.instanceId}] Hands-free VAD: ${handsFreeMode}`);

      // Set environment variables
      // NOTE: We do NOT set MEMO_DEVICE_NAME - Electron handles all connections via CONNECT_UID command
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        INPUT_SOURCE: inputSource,
        MEMO_HANDS_FREE: handsFreeMode ? '1' : '0',
      };
      // Radio mode: use External Microphone (headphone jack) like memo-RF
      if (inputSource === 'radio') {
        env.MEMO_RADIO_INPUT_DEVICE = env.MEMO_RADIO_INPUT_DEVICE || 'External Microphone';
      }
      // System mic: optional substring to match CoreAudio device name (e.g. "AirPods")
      if (inputSource === 'system') {
        const micLabel = store.get('fallbackMicLabel');
        if (typeof micLabel === 'string' && micLabel.trim()) {
          env.MEMO_SYSTEM_INPUT_DEVICE = micLabel.trim();
          logger.info(`[MemoSttService] MEMO_SYSTEM_INPUT_DEVICE=${env.MEMO_SYSTEM_INPUT_DEVICE}`);
        }
      }
      
      this.process = spawn(command, args, {
        cwd: isDev ? process.cwd() : undefined,
        stdio: ['pipe', 'pipe', 'pipe'], // Changed to 'pipe' for stdin to send commands
        env: env,
      });
      this.stdinClosed = false;

      this.process.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        this.handleStdinError(error);
      });

      this.process.stdin?.on('close', () => {
        this.stdinClosed = true;
        logger.debug(`[MemoSttService #${this.instanceId}] memo-stt stdin closed`);
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleStdout(data);
        // Connection state is managed entirely by Rust's CONNECTED:/DISCONNECTED: messages
        // No need for activity timeouts - Rust handles connection monitoring
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        // Log stderr but don't treat as errors (memo-stt uses stderr for status messages)
        const message = data.toString();
        // Log at info level so we can see what's happening in production
        logger.info(`[memo-stt stderr] ${message.trim()}`);
        
        // BLE connection/disconnection is handled via stdout CONNECTED:/DISCONNECTED: protocol messages
        // Stderr is just for logging - no need to parse it for connection state
        
        // Check for error messages that indicate transcription failure
        // These should clear the processing state
        if (message.includes('❌ Error:') || message.includes('Error: Audio too short')) {
          logger.debug('[MemoSttService] Transcription error detected in stderr, clearing processing state');
          this.emit('processingFailed');
        }
      });

      this.process.on('error', (error: Error) => {
        const errorDetails = {
          message: error.message,
          name: error.name,
          code: (error as any).code,
          errno: (error as any).errno,
          syscall: (error as any).syscall,
          path: (error as any).path,
          command: command,
          args: args,
        };
        logger.error(`[MemoSttService #${this.instanceId}] Failed to start memo-stt:`, errorDetails);
        
        // Provide helpful error message for common issues
        let userFriendlyError = error.message;
        if ((error as any).code === 'ENOENT') {
          userFriendlyError = `memo-stt binary not found. The app may not have been built correctly. Path: ${command}`;
        } else if ((error as any).code === 'EACCES') {
          userFriendlyError = `memo-stt binary is not executable. Please check file permissions. Path: ${command}`;
        }
        
        this.status = 'error';
        this.emit('status', 'error');
        this.emit('error', new Error(userFriendlyError));
      });

      this.process.on('exit', (code: number | null, signal: string | null) => {
        logger.info(`[MemoSttService #${this.instanceId}] memo-stt process exited with code ${code}, signal ${signal}`);
        
        // Clean up process references
        const wasRunning = this.process !== null;
        const wasBleConnected = this.isBleConnected;
        this.process = null;
        this.stdinClosed = true;
        this.status = 'stopped';
        this.emit('status', 'stopped');
        
        // If we were on BLE, treat process exit as disconnect: update state and run same flow as DISCONNECTED:
        // (BleManager + tray disconnected, restart). Main's bleDisconnectRestartRequested listener will restart.
        if (wasBleConnected && this.audioSourceManager) {
          this.isBleConnected = false;
          this.connectedDeviceName = null;
          this.emit('bleDisconnected');
          this.audioSourceManager.handleBleDisconnect();
          return; // Do not schedule generic restart - main will restart via bleDisconnectRestartRequested
        }
        
        // Attempt to restart if it wasn't manually stopped and we haven't exceeded max attempts
        if (code !== 0 && code !== null && wasRunning && this.restartAttempts < this.MAX_RESTART_ATTEMPTS) {
          const delay = this.RESTART_DELAY_BASE * Math.pow(2, this.restartAttempts);
          this.restartAttempts++;
          logger.info(`Attempting to restart memo-stt in ${delay}ms (attempt ${this.restartAttempts}/${this.MAX_RESTART_ATTEMPTS})...`);
          
          this.restartTimeout = setTimeout(() => {
            if (this.status === 'stopped') {
              this.start();
            }
          }, delay);
        } else if (this.restartAttempts >= this.MAX_RESTART_ATTEMPTS) {
          logger.error('Max restart attempts reached. Stopping auto-restart.');
          this.emit('error', new Error('Max restart attempts reached'));
        }
      });

      this.status = 'running';
      this.emit('status', 'running');
      
      // Send initial settings after a short delay to ensure stdin is ready
      // This ensures the memo-stt process has time to set up its stdin reader thread
      setTimeout(() => {
        if (this.process && !this.process.killed && this.process.stdin) {
          // Send postEnter setting if it was set before process started
          const settings = loadSettings();
          const postEnter = settings.postEnter || false;
          this.setPressEnterAfterPaste(postEnter);
          logger.info(`[MemoSttService #${this.instanceId}] Sent initial postEnter setting: ${postEnter}`);

          const pushToTalkMode = settings.pushToTalkMode || false;
          this.setPushToTalkMode(pushToTalkMode);
          logger.info(`[MemoSttService #${this.instanceId}] Sent initial push-to-talk mode: ${pushToTalkMode}`);
          
          // Send vocabulary for voice commands
          this.updateVocabulary();
        }
      }, 500); // 500ms delay to ensure process is ready
    } catch (error) {
      logger.error(`[MemoSttService #${this.instanceId}] Error starting memo-stt:`, error);
      this.status = 'error';
      this.emit('status', 'error');
      this.emit('error', error);
    }
  }
  
  // Cleanup method to track instance destruction
  private cleanup(): void {
    instanceCount--;
    logger.info(`[MemoSttService #${this.instanceId}] Instance destroyed (remaining instances: ${instanceCount})`);
  }

  /**
   * Reset the BLE activity timeout (disabled).
   *
   * We intentionally allow BLE to remain connected-but-idle with no traffic.
   * Disconnect detection while idle is handled by Rust (memo-stt) using light central polling,
   * which avoids spurious disconnects and minimizes peripheral power draw.
   */
  private resetBleActivityTimeout(): void {
    // No-op
  }

  /**
   * Clear the BLE activity timeout (disabled).
   */
  private clearBleActivityTimeout(): void {
    // No-op
  }

  stop(): void {
    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    // Clear BLE activity timeout
    this.clearBleActivityTimeout();
    this.isBleConnected = false;
    this.connectedDeviceName = null;
    this.lastSeenDeviceName = null;

    // Reset restart attempts on manual stop
    this.restartAttempts = 0;

    if (this.process && !this.process.killed) {
      logger.info(`[MemoSttService #${this.instanceId}] Stopping memo-stt process...`);
      
      const processToKill = this.process;
      this.stdinClosed = true;
      
      // Remove event listeners to prevent memory leaks
      processToKill.removeAllListeners('error');
      processToKill.stdin?.removeAllListeners('error');
      processToKill.stdin?.removeAllListeners('close');
      processToKill.stdout?.removeAllListeners('data');
      processToKill.stderr?.removeAllListeners('data');
      
      // Try graceful shutdown first (SIGTERM)
      processToKill.kill('SIGTERM');
      
      // Force kill after timeout if process doesn't exit
      const forceKillTimeout = setTimeout(() => {
        if (processToKill && !processToKill.killed) {
          logger.warn('Process did not exit gracefully, forcing kill...');
          try {
            processToKill.kill('SIGKILL');
          } catch (error) {
            logger.error('Error force killing process:', error);
          }
        }
      }, 2000); // 2 second timeout
      
      // Clear timeout if process exits before timeout
      processToKill.once('exit', () => {
        clearTimeout(forceKillTimeout);
        logger.info(`[MemoSttService #${this.instanceId}] memo-stt process exited successfully`);
      });
      
      this.process = null;
      this.status = 'stopped';
      this.emit('status', 'stopped');
    }

    // Clear buffer on stop
    this.buffer = '';
    
    // Cleanup tracking
    this.cleanup();
  }

  getStatus(): MemoSttStatus {
    return this.status;
  }

  /**
   * Restart the memo-stt service
   */
  restart(): void {
    logger.info(`[MemoSttService #${this.instanceId}] Restarting memo-stt service...`);
    this.stop();
    setTimeout(() => {
      this.start();
    }, 500);
  }

  private handleStdout(data: Buffer): void {
    const text = data.toString();
    
    // Prevent unbounded buffer growth
    if (this.buffer.length + text.length > this.MAX_BUFFER_SIZE) {
      logger.warn('Buffer size exceeded, clearing buffer');
      this.buffer = '';
      // Still try to process the new data
      this.buffer = text;
    } else {
      this.buffer += text;
    }

    // Process complete lines
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line.trim()).catch(error => {
        logger.error('[MemoSttService] Failed to process stdout line:', error);
        this.emit('processingFailed');
      });
    }
  }

  private async processLine(line: string): Promise<void> {
    if (line.startsWith('MIC_INFO:')) {
      const rest = line.slice('MIC_INFO:'.length);
      const tabIdx = rest.indexOf('\t');
      if (tabIdx > 0) {
        const name = rest.slice(0, tabIdx).trim();
        const rateStr = rest.slice(tabIdx + 1).trim();
        const rate = parseInt(rateStr, 10);
        try {
          store.set('lastSystemMicDevice', name || null);
          store.set('lastSystemMicSampleRate', Number.isFinite(rate) ? rate : null);
        } catch (e) {
          logger.debug('[MemoSttService] Could not persist MIC_INFO:', e);
        }
        this.emit('micInfoUpdated');
      }
      return;
    }

    // Handle BLE protocol messages
    if (line.startsWith('DEVICE_FOUND:')) {
      // Format: DEVICE_FOUND:<name>:<uid>:<rssi>
      const parts = line.slice('DEVICE_FOUND:'.length).split(':');
      if (parts.length >= 3) {
        const [name, uid, rssi] = parts;
        const device = {
          name: name.trim(),
          uid: uid.trim(),
          rssi: parseInt(rssi.trim()) || 0,
        };
        logger.info(`[MemoSttService] Device discovered: ${device.name} (UID: ${device.uid}, RSSI: ${device.rssi})`);
        // Device discovery events are now handled by BleManager
      }
      return;
    }

    if (line.startsWith('SCAN_COMPLETE')) {
      logger.info('[MemoSttService] BLE scan completed');
      // Scan completion is now handled by BleManager
      return;
    }

    if (line.startsWith('CONNECTED:')) {
      // Format: CONNECTED:<device_name>
      // Device name can be: "Zephyr [memo_C9AA6]" or "memo_C9AA6"
      const fullDeviceName = line.slice('CONNECTED:'.length).trim();
      
      // Extract memo_XXXXX pattern if present (for UID extraction)
      const memoMatch = fullDeviceName.match(/(memo_[a-zA-Z0-9_]+)/i);
      const deviceName = memoMatch ? memoMatch[1] : fullDeviceName;
      
      logger.info(`[MemoSttService] BLE device connected: ${fullDeviceName} (extracted: ${deviceName})`);
      
      // Clear any stale activity timeout, then start inactivity timer (safety net if Rust never sends DISCONNECTED:)
      this.clearBleActivityTimeout();
      
      // Update state
      this.isBleConnected = true;
      this.connectedDeviceName = deviceName;
      this.lastSeenDeviceName = deviceName;
      
      // Emit event for BleManager (use extracted memo_ name for consistency)
      this.emit('bleConnected', deviceName);
      
      // Handle audio source switching
      if (this.audioSourceManager) {
        this.audioSourceManager.handleBleReconnect(fullDeviceName);
      }
      this.resetBleActivityTimeout();
      return;
    }

    if (line.startsWith('BLE_PRESS_ENTER')) {
      this.resetBleActivityTimeout();
      this.emit('blePressEnter');
      return;
    }

    if (line.startsWith('DISCONNECTED:')) {
      // Format: DISCONNECTED:<reason>
      const reason = line.slice('DISCONNECTED:'.length).trim();
      logger.info(`[MemoSttService] BLE device disconnected: ${reason}`);

      // Clear activity timeout - connection state comes from Rust only
      this.clearBleActivityTimeout();
      
      // Update state
      this.isBleConnected = false;
      this.connectedDeviceName = null;
      
      // Emit event for BleManager
      this.emit('bleDisconnected');
      
      // Handle audio source switching
      if (this.audioSourceManager) {
        this.audioSourceManager.handleBleDisconnect();
      }
      return;
    }

    if (line.startsWith('BATTERY_LEVEL:')) {
      const rawLevel = line.slice('BATTERY_LEVEL:'.length).trim();
      const level = Number.parseInt(rawLevel, 10);
      if (Number.isFinite(level)) {
        const clamped = Math.max(0, Math.min(100, level));
        logger.info(`[MemoSttService] Battery level: ${clamped}%`);
        this.emit('batteryLevelChanged', clamped);
      }
      return;
    }

    // Handle AUDIO_LEVELS: lines (if memo-stt outputs them)
    if (line.startsWith('AUDIO_LEVELS:')) {
      this.resetBleActivityTimeout();
      const jsonStr = line.slice('AUDIO_LEVELS:'.length);
      try {
        const levels = JSON.parse(jsonStr);
        if (Array.isArray(levels)) {
          this.emit('audioLevels', levels);
        }
      } catch (error) {
        logger.debug('Failed to parse AUDIO_LEVELS:', error);
      }
      return;
    }
    
    // Handle AUDIO_DATA: lines - base64 encoded OPUS audio
    if (line.startsWith('AUDIO_DATA:')) {
      this.resetBleActivityTimeout();
      const base64Data = line.slice('AUDIO_DATA:'.length);
      try {
        const opusBuffer = Buffer.from(base64Data, 'base64');
        // Store in pendingAudioData, will be matched with transcription
        this.pendingAudioData = {
          opusBuffer,
          duration: 0, // Will be set by AUDIO_DURATION line
          timestamp: Date.now(),
        };
        logger.debug('[MemoSttService] Received audio data, size:', opusBuffer.length);
      } catch (error) {
        logger.error('Failed to decode AUDIO_DATA base64:', error);
      }
      return;
    }
    
    // Handle AUDIO_WAV: lines - base64 encoded WAV audio (for playback)
    if (line.startsWith('AUDIO_WAV:')) {
      const base64Data = line.slice('AUDIO_WAV:'.length);
      try {
        const wavBuffer = Buffer.from(base64Data, 'base64');
        if (this.pendingAudioData) {
          this.pendingAudioData.wavBuffer = wavBuffer;
          logger.debug('[MemoSttService] Received WAV audio data, size:', wavBuffer.length);
        }
      } catch (error) {
        logger.error('Failed to decode AUDIO_WAV base64:', error);
      }
      return;
    }
    
    // Handle AUDIO_DURATION: lines
    if (line.startsWith('AUDIO_DURATION:')) {
      this.resetBleActivityTimeout();
      const durationStr = line.slice('AUDIO_DURATION:'.length);
      try {
        const duration = parseFloat(durationStr);
        if (this.pendingAudioData) {
          this.pendingAudioData.duration = duration;
          logger.debug('[MemoSttService] Audio duration set:', duration);
        }
      } catch (error) {
        logger.error('Failed to parse AUDIO_DURATION:', error);
      }
      return;
    }
    
    // Detect recording start - memo-stt outputs "🎤 Recording..." when recording starts
    if (line.includes('🎤 Recording...') || line.includes('Recording...')) {
      logger.debug('[MemoSttService] Recording started');
      this.emit('recordingStarted');
      return;
    }
    
    // Detect recording stop - memo-stt outputs "⏹️  Stopped" when recording stops
    if (line.includes('⏹️  Stopped') || line.includes('Stopped (')) {
      logger.debug('[MemoSttService] Recording stopped');
      this.emit('recordingStopped');
      return;
    }
    
    // Detect processing state - memo-stt outputs "🔄 Transcribing..." when processing
    if (line.includes('🔄 Transcribing...') || line.includes('Transcribing...')) {
      logger.debug('[MemoSttService] Processing started');
      this.emit('processingStarted');
      return;
    }

    // No-speech path: memo-stt does not print FINAL — unblock UI and restore system output mute
    if (line.includes('📝 (no speech detected)')) {
      logger.debug('[MemoSttService] No speech detected (Whisper finished)');
      this.emit('processingCompleted');
      return;
    }
    
    // BLE connection/disconnection is handled via CONNECTED:/DISCONNECTED: protocol messages above
    // No need for additional detection here
    
    // Detect error messages that indicate transcription failure
    // These can appear in stdout as well (though usually in stderr)
    if (line.includes('❌ Error:') || line.includes('Error: Audio too short')) {
      logger.debug('[MemoSttService] Transcription error detected in stdout, clearing processing state');
      this.emit('processingFailed');
      return;
    }
    
    if (!line.startsWith('FINAL:')) {
      return;
    }

    try {
      const jsonStr = line.slice(6).trim(); // Remove "FINAL:" prefix
      const transcription: TranscriptionData = JSON.parse(jsonStr);

      // Validate transcription data
      if (!transcription.rawTranscript && !transcription.processedText) {
        logger.warn('Received empty transcription, skipping');
        this.emit('processingCompleted');
        return;
      }

      // Use processedText if available, otherwise rawTranscript
      const text = transcription.processedText || transcription.rawTranscript;
      
      if (!text || text.trim().length === 0) {
        logger.warn('Received empty transcription text, skipping');
        this.emit('processingCompleted');
        return;
      }

      // Check if voice commands are enabled and detect commands
      const settings = loadSettings();
      if (settings.voiceCommands?.enabled) {
        const activeApp = transcription.appContext?.appName || '';
        const detectedCommand = await this.commandDetector.detectWithIntent(text, activeApp);
        
        logger.debug(`[MemoSttService] Command detection: text="${text}", activeApp="${activeApp}", detected=${detectedCommand.type}, confidence=${detectedCommand.confidence}`);
        
        if (detectedCommand.type !== 'none' && detectedCommand.confidence > 0.7) {
          logger.info(`[MemoSttService] Command detected: ${detectedCommand.type}, executing...`);
          
          // Strip command text from transcription
          let remainingText = text;
          if (detectedCommand.matchedText) {
            // Remove the matched command text from the transcription
            // Use case-insensitive matching and handle word boundaries
            const matchedLower = detectedCommand.matchedText.toLowerCase().trim();
            const textLower = text.toLowerCase();
            
            // Try to find the match, handling variations in spacing and punctuation
            let matchIndex = textLower.indexOf(matchedLower);
            
            // If exact match not found, try with word boundaries
            if (matchIndex === -1) {
              // Try matching with word boundary regex
              const regex = new RegExp(`\\b${this.escapeRegex(matchedLower)}\\b`, 'i');
              const regexMatch = text.match(regex);
              if (regexMatch) {
                matchIndex = regexMatch.index || -1;
              }
            }
            
            // If still not found, try fuzzy match (remove punctuation)
            if (matchIndex === -1) {
              const matchedClean = matchedLower.replace(/[.,!?;:]/g, '');
              const textClean = textLower.replace(/[.,!?;:]/g, '');
              matchIndex = textClean.indexOf(matchedClean);
              if (matchIndex !== -1) {
                // Adjust index to account for removed punctuation
                const beforeClean = textClean.substring(0, matchIndex);
                matchIndex = beforeClean.length === 0 ? 0 : textLower.indexOf(beforeClean);
              }
            }
            
            if (matchIndex !== -1) {
              // Find the actual end of the match in original text
              const matchedLength = detectedCommand.matchedText.length;
              let endIndex = matchIndex + matchedLength;
              
              // Extend to include trailing punctuation if present
              while (endIndex < text.length && /[.,!?;:\s]/.test(text.charAt(endIndex))) {
                endIndex++;
              }
              
              // Remove the matched text and clean up surrounding whitespace
              const before = text.substring(0, matchIndex).trim();
              const after = text.substring(endIndex).trim();
              
              // Combine remaining text, handling cases where command is at start/end/middle
              if (before && after) {
                remainingText = `${before} ${after}`.trim();
              } else if (before) {
                remainingText = before;
              } else if (after) {
                remainingText = after;
              } else {
                remainingText = '';
              }
              
              // Clean up multiple spaces
              remainingText = remainingText.replace(/\s+/g, ' ').trim();
            }
          }
          
          // Execute command
          this.executeCommand(detectedCommand, settings.voiceCommands.apps).catch((error) => {
            logger.error('[MemoSttService] Failed to execute command:', error);
          });
          
          // If there's remaining text after stripping the command, inject it
          if (remainingText.trim().length > 0) {
            logger.debug(`[MemoSttService] Injecting remaining text after command: "${remainingText}"`);
            this.emit('transcription', {
              ...transcription,
              processedText: remainingText,
            });
            this.emit('processingCompleted');
          } else {
            // No remaining text, just emit processing completed
            this.emit('processingCompleted');
          }
          return;
        } else if (detectedCommand.type !== 'none') {
          logger.debug(`[MemoSttService] Command detected but confidence too low: ${detectedCommand.confidence}`);
        }
      } else {
        logger.debug(`[MemoSttService] Voice commands disabled, skipping command detection`);
      }

      // Emit transcription event (normal flow)
      this.emit('transcription', {
        ...transcription,
        processedText: text,
      });
      
      // If we have pending audio data, emit it with the transcription
      // Audio data is matched to transcription by timestamp proximity
      if (this.pendingAudioData) {
        const audioData = this.pendingAudioData;
        this.pendingAudioData = null; // Clear after emitting
        this.emit('audioData', audioData);
        logger.debug('[MemoSttService] Emitted audio data with transcription');
      }

      this.emit('processingCompleted');
    } catch (error) {
      logger.error('Failed to parse FINAL: JSON:', error);
      logger.error('Line was:', line);
      this.emit('processingFailed');
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get current BLE connection state
   */
  getBleConnectionState(): { connected: boolean; deviceName: string | null } {
    return {
      connected: this.isBleConnected,
      deviceName: this.connectedDeviceName,
    };
  }

  /**
   * Disconnect from BLE device
   */
  disconnectBle(): void {
    if (this.isBleConnected) {
      logger.info('[MemoSttService] Disconnecting from BLE device');
      // Stop the memo-stt process to disconnect
      this.stop();
      this.isBleConnected = false;
      this.connectedDeviceName = null;
      this.emit('bleDisconnected');
      // Restart with system mic instead
      setTimeout(() => {
        const settings = loadSettings();
        settings.inputSource = 'system';
        saveSettings(settings);
        this.start();
      }, 500);
    }
  }
}


