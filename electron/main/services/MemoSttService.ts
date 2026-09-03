import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { loadSettings, store } from './SettingsService';
import { isWhisperModelInstalled, whisperModelPath } from './AsrModelService';
import { resolveTranscriptionText } from '../../shared/transcription';
import { normalizeTranscriptionText } from './textProcessing';

export interface AppContext {
  appName: string;
  windowTitle: string;
  bundleId?: string;
}

export interface CapturedAudio {
  wavBuffer: Buffer;
  duration?: number;
}

export interface TranscriptionData {
  rawTranscript: string;
  processedText: string;
  wasProcessedByLLM: boolean;
  appContext?: AppContext;
  audioCapture?: CapturedAudio;
}

export type MemoSttStatus = 'stopped' | 'running' | 'error';

let nextInstanceId = 0;

export class MemoSttService extends EventEmitter {
  private process: ChildProcess | null = null;
  private stdinClosed: boolean = false;
  private status: MemoSttStatus = 'stopped';
  private buffer: string = '';
  private hotkey: string = 'function';
  private restartAttempts: number = 0;
  private restartTimeout: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private readyPromise: Promise<void> | null = null;
  private suspended = false;
  private readonly MAX_RESTART_ATTEMPTS = 5;
  private readonly RESTART_DELAY_BASE = 2000;
  // A WAV line is base64 encoded by the trusted native recorder. Allow long
  // dictations while still putting a hard ceiling on malformed output.
  private readonly MAX_BUFFER_SIZE = 64 * 1024 * 1024;
  private readonly instanceId: number;
  private pendingAudioData: { wavBuffer?: Buffer; duration?: number } | null = null;
  /** Timestamp (ms) when the current process was spawned — used to detect quick-exit device errors */
  private processStartedAt: number | null = null;
  private hotkeyPermissionFailed = false;
  /** Quick-exit threshold: if process exits within this many ms with non-zero code, assume audio device error */
  private readonly QUICK_EXIT_THRESHOLD_MS = 4000;
  constructor() {
    super();
    this.instanceId = ++nextInstanceId;
    logger.info(`[MemoSttService] Creating instance #${this.instanceId}`);

    // Load initial vocabulary from settings
    this.updateVocabulary();
  }

  setHotkey(hotkey: string): void {
    this.hotkey = hotkey;
  }

  /**
   * Send a command to the owned dictation process via stdin.
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

    logger.error(`[MemoSttService #${this.instanceId}] dictation stdin error:`, error);
  }

  /** Update native speech-recognition vocabulary. */
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

    const vocab = { boostWords, voiceCommandsEnabled: false };
    logger.info(`[MemoSttService] Updated vocabulary: ${boostWords.length} boost words`);

    if (this.status === 'running') {
      this.sendCommand(`VOCAB:${JSON.stringify(vocab)}`);
    } else {
      logger.debug(`[MemoSttService #${this.instanceId}] Vocabulary staged until dictation starts`);
    }
  }

  async start(): Promise<void> {
    if (this.suspended) return;
    if (this.stopPromise) {
      logger.debug(`[MemoSttService #${this.instanceId}] Waiting for the previous process to exit`);
      await this.stopPromise;
    }
    if (this.suspended) return;
    if (this.process && !this.process.killed) {
      logger.info(`[MemoSttService #${this.instanceId}] dictation process already running`);
      await this.readyPromise;
      return;
    }
    
    logger.info(`[MemoSttService #${this.instanceId}] Starting dictation service`);
    this.hotkeyPermissionFailed = false;

    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }


    try {
      // Spawn the same owned binary in development and production.
      const isDev = process.env.NODE_ENV === 'development' || 
                    (typeof process.env.npm_lifecycle_event !== 'undefined' && 
                     process.env.npm_lifecycle_event.includes('dev')) ||
                    !app.isPackaged;
      
      let command: string;
      let args: string[];
      
      if (isDev) {
        // Development uses the same staged binary that release builds package.
        command = path.join(process.cwd(), '.build', 'dictation', 'memo-dictation');
        if (!fs.existsSync(command)) {
          throw new Error(`Memo dictation binary not found at ${command}. Run npm run build:dictation first.`);
        }
        args = ['--hotkey', this.hotkey];
      } else {
        // Production: use bundled binary
        const prodPath = path.join(process.resourcesPath, 'dictation', 'memo-dictation');
        
        // Fallback paths if binary not found in expected location
        const alternatives = [
          prodPath,
          path.join(app.getAppPath(), '..', '..', 'Resources', 'dictation', 'memo-dictation'),
          path.join(process.resourcesPath, 'memo-dictation'),
        ];
        
        let binaryPath = prodPath;
        for (const altPath of alternatives) {
          if (fs.existsSync(altPath)) {
            binaryPath = altPath;
            logger.info(`[MemoSttService #${this.instanceId}] Found dictation binary at: ${binaryPath}`);
            break;
          }
        }
        
        if (!fs.existsSync(binaryPath)) {
          const errorMsg = `Memo dictation binary not found in any expected location. Tried: ${alternatives.join(', ')}. resourcesPath: ${process.resourcesPath}, appPath: ${app.getAppPath()}`;
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
            logger.warn(`[MemoSttService #${this.instanceId}] Memo dictation sidecar is not signed: ${details || result.error?.message || 'unknown error'}`);
          }
        }
        
        command = binaryPath;
        args = ['--hotkey', this.hotkey];
      }

      const settings = loadSettings();
      const handsFreeMode = settings.handsFreeMode ?? false;

      logger.info(`[MemoSttService #${this.instanceId}] Starting dictation: ${command} ${args.join(' ')}`);
      logger.info(`[MemoSttService #${this.instanceId}] Hands-free VAD: ${handsFreeMode}`);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MEMO_EMIT_AUDIO: settings.saveAudio ? '1' : '0',
        MEMO_HANDS_FREE: handsFreeMode ? '1' : '0',
      };
      const requestedAsrModel = settings.asrModel;
      const asrModel = requestedAsrModel === 'whisper' && isWhisperModelInstalled()
        ? 'whisper'
        : 'conomo';
      if (requestedAsrModel === 'whisper' && asrModel === 'conomo') {
        logger.warn('[MemoSttService] Selected Whisper model is missing; falling back to conomo');
      }
      env.MEMO_ASR_BACKEND = asrModel;

      if (asrModel === 'whisper') {
        env.MEMO_WHISPER_MODEL_PATH = whisperModelPath();
        logger.info(
          `[MemoSttService #${this.instanceId}] ASR model: Whisper ` +
          `(model=${env.MEMO_WHISPER_MODEL_PATH})`,
        );
      } else {
        const conomoRoot = isDev
          ? path.join(process.cwd(), '.build', 'conomo')
          : path.join(process.resourcesPath, 'conomo');
        const bundledWorker = path.join(conomoRoot, 'conomo');
        const contextualWorker = path.join(process.cwd(), 'scripts', 'shell', 'run-contextual-granite.sh');

        // Development can use an explicitly supplied worker. Packaged apps
        // always use the signed conomo executable in their resources.
        env.MEMO_ASR_WORKER = isDev && process.env.MEMO_ASR_WORKER
          ? process.env.MEMO_ASR_WORKER
          : isDev
            ? contextualWorker
            : bundledWorker;
        if (isDev && env.MEMO_ASR_WORKER === contextualWorker) {
          env.MEMO_CONTEXTUAL_VOCAB = '1';
        }

        const requiredResources = [['worker', env.MEMO_ASR_WORKER]] as const;
        for (const [label, resourcePath] of requiredResources) {
          if (!resourcePath || !fs.existsSync(resourcePath)) {
            throw new Error(
              `Bundled conomo ${label} not found at ${resourcePath || '(unset)'}. ` +
              'Run npm run build:conomo first.',
            );
          }
        }
        logger.info(
          `[MemoSttService #${this.instanceId}] ASR model: ${env.MEMO_CONTEXTUAL_VOCAB === '1' ? 'Contextual Granite prototype' : 'conomo'} ` +
          `(worker=${env.MEMO_ASR_WORKER})`,
        );
      }
      // An explicit system microphone is strict. The native process must either
      // open this device or fail; it must never substitute the macOS default.
      const micLabel = store.get('selectedSystemMicName');
      if (typeof micLabel === 'string' && micLabel.trim()) {
        env.MEMO_SYSTEM_INPUT_DEVICE = micLabel.trim().slice(0, 200);
        logger.info(`[MemoSttService] MEMO_SYSTEM_INPUT_DEVICE=${env.MEMO_SYSTEM_INPUT_DEVICE}`);
      }
      
      const child = spawn(command, args, {
        cwd: isDev ? process.cwd() : undefined,
        stdio: ['pipe', 'pipe', 'pipe'], // Changed to 'pipe' for stdin to send commands
        env: env,
        detached: process.platform !== 'win32',
      });
      this.process = child;
      this.stdinClosed = false;
      this.processStartedAt = Date.now();

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        this.handleStdinError(error);
      });

      child.stdin?.on('close', () => {
        this.stdinClosed = true;
        logger.debug(`[MemoSttService #${this.instanceId}] dictation stdin closed`);
      });

      child.stdout?.on('data', (data: Buffer) => {
        this.handleStdout(data);
        // Connection state is managed entirely by Rust's CONNECTED:/DISCONNECTED: messages
        // No need for activity timeouts - Rust handles connection monitoring
      });

      child.stderr?.on('data', (data: Buffer) => {
        // Log stderr but do not treat it as an error channel; the sidecar uses it for status messages.
        const message = data.toString();
        // Log at info level so we can see what's happening in production
        logger.info(`[memo-dictation stderr] ${message.trim()}`);
        
        
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

      child.on('error', (error: NodeJS.ErrnoException) => {
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
          userFriendlyError = `Memo dictation binary not found. The app may not have been built correctly. Path: ${command}`;
        } else if (error.code === 'EACCES') {
          userFriendlyError = `Memo dictation binary is not executable. Please check file permissions. Path: ${command}`;
        }
        
        this.status = 'error';
        this.emit('status', 'error');
        this.emit('error', new Error(userFriendlyError));
      });

      child.on('exit', (code: number | null, signal: string | null) => {
        logger.info(`[MemoSttService #${this.instanceId}] memo-stt process exited with code ${code}, signal ${signal}`);
        if (this.process !== child) return;
        
        // Clean up process references
        const wasRunning = this.process !== null;
        this.process = null;
        this.stdinClosed = true;
        this.status = 'stopped';
        this.emit('status', 'stopped');
        
        // Attempt to restart if it wasn't manually stopped and we haven't exceeded max attempts
        if (
          !this.hotkeyPermissionFailed &&
          code !== 0 &&
          code !== null &&
          wasRunning &&
          this.restartAttempts < this.MAX_RESTART_ATTEMPTS
        ) {
          // Quick-exit heuristic: if the process died within QUICK_EXIT_THRESHOLD_MS of starting
          // with a non-zero code, it almost certainly failed to open the
          // audio device. Let main verify the selected input before scheduling a retry.
          const uptime = this.processStartedAt ? Date.now() - this.processStartedAt : Infinity;
          if (uptime < this.QUICK_EXIT_THRESHOLD_MS) {
            logger.warn(`[MemoSttService] Process exited quickly (${uptime}ms) in system mode — treating as audio device error`);
            this.processStartedAt = null;
            this.emit('micDeviceError', `process exited after ${uptime}ms`);
            return; // Let main restart only when the selected input is available
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

      // The native command-reader thread has no ready event. Keep its existing
      // stabilization window, but make it an awaited ownership boundary.
      const ready = new Promise<void>((resolve) => setTimeout(resolve, 500));
      this.readyPromise = ready;
      await ready;
      if (this.readyPromise === ready) this.readyPromise = null;
      if (this.process === child && !child.killed && child.stdin) {
        this.updateVocabulary();
      }
    } catch (error) {
      logger.error(`[MemoSttService #${this.instanceId}] Error starting memo-stt:`, error);
      this.status = 'error';
      this.emit('status', 'error');
      this.emit('error', error);
    }
  }
  
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }


    // Reset restart attempts on manual stop
    this.restartAttempts = 0;

    const processToKill = this.process;
    this.process = null;
    this.status = 'stopped';
    this.emit('status', 'stopped');

    if (processToKill && processToKill.exitCode === null && processToKill.signalCode === null) {
      logger.info(`[MemoSttService #${this.instanceId}] Stopping memo-stt process...`);
      this.stdinClosed = true;
      this.stopPromise = new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(forceKillTimeout);
          logger.info(`[MemoSttService #${this.instanceId}] memo-stt process exited`);
          resolve();
        };
        const forceKillTimeout = setTimeout(() => {
          if (processToKill.exitCode === null && processToKill.signalCode === null) {
            logger.warn('Process did not exit gracefully, forcing its process group to stop');
            this.signalProcessGroup(processToKill, 'SIGKILL');
          }
        }, 2_000);
        processToKill.once('exit', finish);
        this.signalProcessGroup(processToKill, 'SIGTERM');
      }).finally(() => {
        this.stopPromise = null;
      });
    }

    // Clear buffer on stop
    this.buffer = '';
    await this.stopPromise;
  }

  async suspend(): Promise<void> {
    this.suspended = true;
    await this.stop();
  }

  resume(): void {
    this.suspended = false;
  }

  getStatus(): MemoSttStatus {
    return this.status;
  }

  /**
   * Restart the memo-stt service
   */
  async restart(): Promise<void> {
    logger.info(`[MemoSttService #${this.instanceId}] Restarting memo-stt service...`);
    await this.stop();
    await this.start();
  }

  private signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(`[MemoSttService] Could not send ${signal}:`, error);
      }
    }
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
    if (line === 'HOTKEY_READY') {
      logger.info('[MemoSttService] Hotkey listener authorized');
      return;
    }

    if (line === 'HOTKEY_PERMISSION_REQUIRED' || line.startsWith('HOTKEY_ERROR:')) {
      this.hotkeyPermissionFailed = true;
      const error = new Error(
        line === 'HOTKEY_PERMISSION_REQUIRED'
          ? 'Input Monitoring permission is required. Enable Memo in System Settings → Privacy & Security → Input Monitoring, then restart Memo.'
          : `The dictation hotkey listener failed: ${line.slice('HOTKEY_ERROR:'.length).trim()}`,
      );
      logger.error(`[MemoSttService] ${error.message}`);
      this.status = 'error';
      this.emit('status', 'error');
      this.emit('error', error);
      return;
    }

    if (line.startsWith('MIC_INFO:')) {
      const rest = line.slice('MIC_INFO:'.length);
      const tabIdx = rest.indexOf('\t');
      if (tabIdx > 0) {
        const name = rest.slice(0, tabIdx).trim();
        const rateStr = rest.slice(tabIdx + 1).trim();
        const rate = parseInt(rateStr, 10);
        const selectedName = store.get('selectedSystemMicName')?.trim();
        if (selectedName && name.toLocaleLowerCase() !== selectedName.toLocaleLowerCase()) {
          logger.error(
            `[MemoSttService] Selected microphone mismatch: requested ${selectedName}, opened ${name}`,
          );
          this.emit('micDeviceError', `requested ${selectedName}, opened ${name}`);
          return;
        }
        try {
          store.set('lastSystemMicDevice', name || null);
          store.set('lastSystemMicSampleRate', Number.isFinite(rate) ? rate : null);
        } catch (e) {
          logger.debug('[MemoSttService] Could not persist MIC_INFO:', e);
        }
        logger.info(`[MemoSttService] Active microphone: ${name} (${rate} Hz)`);
        this.emit('micInfoUpdated');
      }
      return;
    }

    if (line === 'MIC_READY') {
      logger.info('[MemoSttService] Selected microphone stream is ready');
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

    // memo-stt emits both OPUS and WAV. WAV is the only retained format because
    // browsers decode it reliably without another codec dependency.
    if (line.startsWith('AUDIO_DATA:')) {
      if (loadSettings().saveAudio) this.pendingAudioData = {};
      return;
    }

    if (line.startsWith('AUDIO_DURATION:')) {
      if (!loadSettings().saveAudio) return;
      const duration = Number.parseFloat(line.slice('AUDIO_DURATION:'.length));
      if (Number.isFinite(duration) && duration >= 0) {
        this.pendingAudioData ??= {};
        this.pendingAudioData.duration = duration;
      }
      return;
    }

    if (line.startsWith('AUDIO_WAV:')) {
      if (!loadSettings().saveAudio) return;
      const wavBuffer = Buffer.from(line.slice('AUDIO_WAV:'.length), 'base64');
      if (wavBuffer.length < 44 || wavBuffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
        logger.warn('[MemoSttService] Ignored invalid WAV data from recorder');
        return;
      }
      this.pendingAudioData ??= {};
      this.pendingAudioData.wavBuffer = wavBuffer;
      return;
    }
    
    // Detect recording start - memo-stt outputs "🎤 Recording..." when recording starts
    if (line.includes('🎤 Recording...') || line.includes('Recording...')) {
      logger.debug('[MemoSttService] Recording started');
      this.pendingAudioData = null;
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
      this.pendingAudioData = null;
      this.emit('processingCompleted');
      return;
    }
    
    // No need for additional detection here
    
    // Detect error messages that indicate transcription failure
    // These can appear in stdout as well (though usually in stderr)
    if (line.includes('❌ Error:') || line.includes('Error: Audio too short')) {
      logger.debug('[MemoSttService] Transcription error detected in stdout, clearing processing state');
      this.pendingAudioData = null;
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

      // An explicitly empty processed value means native cleanup intentionally
      // suppressed an all-artifact transcript. Do not revive its raw text.
      const text = normalizeTranscriptionText(resolveTranscriptionText(transcription));
      
      if (!text) {
        logger.warn('Received empty or punctuation-only transcription text, skipping');
        this.pendingAudioData = null;
        this.emit('processingCompleted');
        return;
      }

      // Emit transcription event (normal flow)
      const audioCapture = this.takePendingAudio();
      this.emit('transcription', {
        ...transcription,
        processedText: text,
        ...(audioCapture ? { audioCapture } : {}),
      });
      
      this.emit('processingCompleted');
    } catch (error) {
      logger.error('Failed to parse FINAL: JSON:', error);
      logger.error('Line was:', line);
      this.emit('processingFailed');
    }
  }

  private takePendingAudio(): CapturedAudio | undefined {
    if (!loadSettings().saveAudio) {
      this.pendingAudioData = null;
      return undefined;
    }

    const pending = this.pendingAudioData;
    this.pendingAudioData = null;
    return pending?.wavBuffer
      ? { wavBuffer: pending.wavBuffer, ...(pending.duration !== undefined ? { duration: pending.duration } : {}) }
      : undefined;
  }

}
