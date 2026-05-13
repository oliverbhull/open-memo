/**
 * Connection Service - WebSocket-based sync connection
 * Uses QR code for pairing, WebSocket for communication
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { networkInterfaces } from 'os';
import { SyncMessage } from './SyncProtocol';
import { logger } from '../utils/logger';
import { BrowserWindow } from 'electron';

export interface ConnectionInfo {
  ip: string;
  port: number;
  token: string;
}

export class ConnectionService extends EventEmitter {
  private server: WebSocketServer | null = null;
  private connectedClient: WebSocket | null = null;
  private port: number = 0;
  private token: string = '';
  private isListening = false;
  private mainWindow: BrowserWindow | null = null;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Get local IP address
   */
  private getLocalIP(): string {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const nets = interfaces[name];
      if (!nets) continue;
      
      for (const net of nets) {
        // Skip internal (i.e. 127.0.0.1) and non-IPv4 addresses
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }

  /**
   * Generate random token for pairing
   */
  private generateToken(): string {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }

  /**
   * Start listening for connections
   */
  startListening(): ConnectionInfo {
    if (this.isListening && this.server) {
      return {
        ip: this.getLocalIP(),
        port: this.port,
        token: this.token,
      };
    }

    // Find available port
    this.port = 8765; // Default port, could be made configurable
    this.token = this.generateToken();

    this.server = new WebSocketServer({ 
      port: this.port,
      perMessageDeflate: false,
    });

    this.server.on('connection', (ws: WebSocket, req) => {
      logger.info('New WebSocket connection attempt');
      // Verify token from query string
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const clientToken = url.searchParams.get('token');
      
      logger.info('Client token:', clientToken ? 'PRESENT' : 'MISSING');
      logger.info('Expected token:', this.token);

      if (clientToken !== this.token) {
        logger.warn('Connection rejected: invalid token. Expected:', this.token, 'Got:', clientToken);
        ws.close(1008, 'Invalid token');
        return;
      }

      logger.info('Token verified, accepting connection');
      
      // Close any existing connection
      if (this.connectedClient) {
        logger.info('Closing existing connection');
        this.connectedClient.close();
      }

      this.connectedClient = ws;
      logger.info('Client connected successfully');
      this.emit('connected', { peerId: 'mobile' });

      ws.on('message', async (data: Buffer) => {
        try {
          logger.info('Received message from client');
          const message: SyncMessage = JSON.parse(data.toString());
          logger.info('Message type:', message.type);
          
          // Forward to renderer for processing
          // The renderer will process and send response via IPC, which will be handled by ipcMain.on('sync:outgoing-message')
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            logger.info('Forwarding message to renderer');
            this.mainWindow.webContents.send('sync:incoming-message', message);
          } else {
            logger.warn('Main window not available, cannot forward message');
          }
        } catch (error) {
          logger.error('Error handling message:', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        logger.info('WebSocket client closed. Code:', code, 'Reason:', reason.toString() || 'No reason');
        if (this.connectedClient === ws) {
          this.connectedClient = null;
          this.emit('disconnected');
        }
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        this.emit('error', error);
      });
    });

    this.server.on('error', (error) => {
      logger.error('WebSocket server error:', error);
      this.emit('error', error);
    });

    this.isListening = true;
    logger.info(`Connection service listening on port ${this.port}`);

    return {
      ip: this.getLocalIP(),
      port: this.port,
      token: this.token,
    };
  }

  /**
   * Stop listening
   */
  stopListening(): void {
    if (this.connectedClient) {
      this.connectedClient.close();
      this.connectedClient = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.isListening = false;
    this.emit('stopped');
  }

  /**
   * Send message to connected client
   */
  sendMessage(message: SyncMessage): void {
    if (!this.connectedClient || this.connectedClient.readyState !== WebSocket.OPEN) {
      logger.warn('Cannot send message: no connected client or connection not open');
      throw new Error('No connected client');
    }
    logger.info('Sending message to client:', message.type);
    this.connectedClient.send(JSON.stringify(message));
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectedClient !== null && 
           this.connectedClient.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection info for QR code
   */
  getConnectionInfo(): ConnectionInfo | null {
    if (!this.isListening) {
      return null;
    }
    return {
      ip: this.getLocalIP(),
      port: this.port,
      token: this.token,
    };
  }
}

export const connectionService = new ConnectionService();

