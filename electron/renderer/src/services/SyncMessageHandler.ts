/**
 * Sync Message Handler - processes incoming WebSocket messages in renderer
 */

import { syncProtocol, SyncMessage } from './SyncProtocol';
import { logger } from '../utils/logger';

declare global {
  interface Window {
    electronAPI: {
      sync: {
        onIncomingMessage: (callback: (message: SyncMessage) => void) => () => void;
        sendOutgoingMessage: (message: SyncMessage) => void;
      };
    };
  }
}

export class SyncMessageHandler {
  private unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.unsubscribe) {
      return; // Already started
    }

    if (!window.electronAPI?.sync) {
      logger.error('[SyncMessageHandler] electronAPI.sync not available, cannot start');
      return;
    }

    logger.info('[SyncMessageHandler] Starting message handler');
    this.unsubscribe = window.electronAPI.sync.onIncomingMessage(async (message: SyncMessage) => {
      logger.info('[SyncMessageHandler] Processing message:', message.type);
      try {
        await syncProtocol.handleMessage(message, (response) => {
          logger.info('[SyncMessageHandler] Sending response:', response.type);
          window.electronAPI.sync.sendOutgoingMessage(response);
        });
      } catch (error) {
        logger.error('[SyncMessageHandler] Error processing message:', error);
      }
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

export const syncMessageHandler = new SyncMessageHandler();

