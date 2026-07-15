import { spawn, spawnSync, ChildProcess } from 'child_process';
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
  private isBleConnected = false;
  private commandDetector: CommandDetector;
  private commandExecutor: CommandExecutor;
  private audioSourceManager: AudioSourceManager | null = null;
  /** Timestamp (ms) when the current process was spawned — used to detect quick-exit device errors */
  private processStartedAt: number | null = null;
  /** Quick-exit threshold: if process exits within this many ms with non-zero code, assume audio device error */
  private readonly QUICK_EXIT_THRESHOLD_MS = 4000;
  constructor(audioSourceManager?: AudioSourceManager) {
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
      this.audioSourceManager.on('commandSetInputSource', (source: string) => {
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
      } catch (error) {
        // Handle EPIPE and other write errors gracefully
        // EPIPE means the process has closed stdin (likely exiting)
        const streamError = error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
        this.handleStdinError(streamError, command);
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
    const vocab: {
      boostWords: string[];
      voiceCommandsEnabled: boolean;
      appNames?: string[];
      appCommands?: Record<string, string[]>;
      globalCommands?: string[];
    } = {
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
      // while commands are keyed per app for runtime command detection.
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

    if (this.status === 'running') {
      this.sendCommand(`VOCAB:${JSON.stringify(vocab)}`);
    } else {
      logger.debug(`[MemoSttService #${this.instanceId}] Vocabulary staged until memo-stt starts`);
    }
  }

  /**
   * Execute a detected command
   */
  private async executeCommand(detectedCommand: DetectedCommand, apps: AppConfig[]): Promise<boolean> {
    try {
      if (detectedCommand.type === 'open_app') {
        const app = apps.find(a => a.name === detectedCommand.app);
        if (app) {
          const success = await this.commandExecutor.openApp(app);
          if (success) {
            this.emit('commandExecuted', { type: 'open_app', app: app.name });
            logger.info(`[MemoSttService] Executed: opened ${app.name}`);
          }
          return success;
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
            return success;
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
              return success;
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
          return success;
        }
      }
    } catch (error) {
      logger.error('[MemoSttService] Error executing command:', error);
    }
    return false;
  }

  private async executeCommandSequence(commands: DetectedCommand[], apps: AppConfig[]): Promise<void> {
    for (const command of commands) {
      const success = await this.executeCommand(command, apps);
      if (!success) {
        logger.warn(`[MemoSttService] Stopping command sequence after failed command: ${command.type}`);
        return;
      }

      if (command.type === 'open_app') {
        await this.delay(450);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        // Development uses the same staged binary that release builds package.
        command = path.join(process.cwd(), '.build', 'stt', 'memo-stt');
        if (!fs.existsSync(command)) {
          throw new Error(`memo-stt binary not found at ${command}. Run npm run build:stt:release first.`);
        }
        args = ['--hotkey', this.hotkey, '--no-inject'];
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
          const result = spawnSync('codesign', ['-dv', binaryPath], { encoding: 'utf8' });
          const details = (result.stderr || result.stdout || '').trim();
          if (result.status === 0) {
            logger.info(`[MemoSttService #${this.instanceId}] Code signing check: ${details}`);
          } else {
            logger.warn(`[MemoSttService #${this.instanceId}] memo-stt is not signed: ${details || result.error?.message || 'unknown error'}`);
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
      const nemotronRoot = isDev
        ? path.join(process.cwd(), '.build', 'nemotron')
        : path.join(process.resourcesPath, 'nemotron');
      const bundledPython = path.join(nemotronRoot, 'runtime', 'bin', 'python3.12');
      const bundledWorker = path.join(nemotronRoot, 'memo_nemotron.py');
      const bundledModel = path.join(nemotronRoot, 'model');

      // Development overrides make backend work easier without weakening the
      // release contract: packaged apps always use their signed resources.
      env.MEMO_ASR_PYTHON = isDev && process.env.MEMO_ASR_PYTHON
        ? process.env.MEMO_ASR_PYTHON
        : bundledPython;
      env.MEMO_ASR_SCRIPT = isDev && process.env.MEMO_ASR_SCRIPT
        ? process.env.MEMO_ASR_SCRIPT
        : bundledWorker;
      env.MEMO_ASR_MODEL_PATH = isDev && process.env.MEMO_ASR_MODEL_PATH
        ? process.env.MEMO_ASR_MODEL_PATH
        : bundledModel;
      env.PYTHONNOUSERSITE = '1';

      const requiredResources = [
        ['Python runtime', env.MEMO_ASR_PYTHON],
        ['worker', env.MEMO_ASR_SCRIPT],
        ['model', env.MEMO_ASR_MODEL_PATH],
      ] as const;
      for (const [label, resourcePath] of requiredResources) {
        if (!resourcePath || !fs.existsSync(resourcePath)) {
          throw new Error(
            `Bundled Nemotron ${label} not found at ${resourcePath || '(unset)'}. ` +
            'Run npm run build:nemotron first.',
          );
        }
      }
      logger.info(
        `[MemoSttService #${this.instanceId}] ASR model: Nemotron ` +
        `(runtime=${env.MEMO_ASR_PYTHON}, model=${env.MEMO_ASR_MODEL_PATH})`,
      );
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
      this.processStartedAt = Date.now();

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

        // Detect audio device unavailability errors from cpal/CoreAudio
        const isDeviceError = (
          message.includes('DeviceNotAvailable') ||
          message.includes('Device not available') ||
          message.includes('no input device') ||
          message.includes('No input device') ||
          message.includes('failed to open audio') ||
          message.includes('Failed to open audio') ||
          (message.toLowerCase().includes('audio') && message.toLowerCase().includes('device') && message.toLowerCase().includes('error'))
        );
        if (isDeviceError) {
          logger.warn('[MemoSttService] Audio device error detected in stderr, emitting micDeviceError');
          this.emit('micDeviceError', message.trim());
        }
      });

      this.process.on('error', (error: NodeJS.ErrnoException) => {
        const errorDetails = {
          message: error.message,
          name: error.name,
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          path: error.path,
          command: command,
          args: args,
        };
        logger.error(`[MemoSttService #${this.instanceId}] Failed to start memo-stt:`, errorDetails);
        
        // Provide helpful error message for common issues
        let userFriendlyError = error.message;
        if (error.code === 'ENOENT') {
          userFriendlyError = `memo-stt binary not found. The app may not have been built correctly. Path: ${command}`;
        } else if (error.code === 'EACCES') {
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
          this.emit('bleDisconnected');
          this.audioSourceManager.handleBleDisconnect();
          return; // Do not schedule generic restart - main will restart via bleDisconnectRestartRequested
        }
        
        // Attempt to restart if it wasn't manually stopped and we haven't exceeded max attempts
        if (code !== 0 && code !== null && wasRunning && this.restartAttempts < this.MAX_RESTART_ATTEMPTS) {
          // Quick-exit heuristic: if the process died within QUICK_EXIT_THRESHOLD_MS of starting
          // with a non-zero code (and we weren't on BLE), it almost certainly failed to open the
          // audio device.  Let main handle the fallback before scheduling a blind retry.
          const uptime = this.processStartedAt ? Date.now() - this.processStartedAt : Infinity;
          const settings = loadSettings();
          if (uptime < this.QUICK_EXIT_THRESHOLD_MS && settings.inputSource === 'system') {
            logger.warn(`[MemoSttService] Process exited quickly (${uptime}ms) in system mode — treating as audio device error`);
            this.processStartedAt = null;
            this.emit('micDeviceError', `process exited after ${uptime}ms`);
            return; // Let main decide whether to restart (it will clear label and retry)
          }

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

  stop(): void {
    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    this.isBleConnected = false;

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
    if (line.startsWith('CONNECTED:')) {
      // Format: CONNECTED:<device_name>
      // Device name can be: "Zephyr [memo_C9AA6]" or "memo_C9AA6"
      const fullDeviceName = line.slice('CONNECTED:'.length).trim();
      
      // Extract memo_XXXXX pattern if present (for UID extraction)
      const memoMatch = fullDeviceName.match(/(memo_[a-zA-Z0-9_]+)/i);
      const deviceName = memoMatch ? memoMatch[1] : fullDeviceName;
      
      logger.info(`[MemoSttService] BLE device connected: ${fullDeviceName} (extracted: ${deviceName})`);
      
      // Update state
      this.isBleConnected = true;
      
      // Emit event for BleManager (use extracted memo_ name for consistency)
      this.emit('bleConnected', deviceName);
      
      // Handle audio source switching
      if (this.audioSourceManager) {
        this.audioSourceManager.handleBleReconnect(fullDeviceName);
      }
      return;
    }

    if (line.startsWith('BLE_PRESS_ENTER')) {
      this.emit('blePressEnter');
      return;
    }

    if (line.startsWith('DISCONNECTED:')) {
      // Format: DISCONNECTED:<reason>
      const reason = line.slice('DISCONNECTED:'.length).trim();
      logger.info(`[MemoSttService] BLE device disconnected: ${reason}`);

      // Update state
      this.isBleConnected = false;
      
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
      logger.debug('[MemoSttService] No speech detected (ASR finished)');
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
        const detectedSequence = this.commandDetector.detectSequence(text, activeApp);
        const detectedCommand = detectedSequence.commands[0] ?? { type: 'none' as const, confidence: 0 };
        
        logger.debug(`[MemoSttService] Command detection: text="${text}", activeApp="${activeApp}", commands=${detectedSequence.commands.length}, first=${detectedCommand.type}, confidence=${detectedCommand.confidence}`);
        
        if (detectedSequence.commands.length > 0) {
          const remainingText = detectedSequence.remainingText;
          logger.info(`[MemoSttService] Command sequence detected (${detectedSequence.commands.length}), executing...`);

          this.executeCommandSequence(detectedSequence.commands, settings.voiceCommands.apps).catch((error) => {
            logger.error('[MemoSttService] Failed to execute command sequence:', error);
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
      
      this.emit('processingCompleted');
    } catch (error) {
      logger.error('Failed to parse FINAL: JSON:', error);
      logger.error('Line was:', line);
      this.emit('processingFailed');
    }
  }

}
