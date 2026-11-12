import { CLIENT_LIMITS, getWsBaseUrl } from '@cloak/config';
import type { WsClientMessage, WsServerMessage } from '@cloak/protocol';

export type WsConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class CloakWsClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private roomIds: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closedManually = false;

  constructor(
    private readonly onMessage: (msg: WsServerMessage) => void,
    private readonly onStatus: (status: WsConnectionStatus) => void,
  ) {}

  connect(accessToken: string, roomIds: string[]): void {
    this.token = accessToken;
    this.roomIds = [...roomIds];
    this.closedManually = false;
    this.openSocket();
  }

  updateRooms(roomIds: string[]): void {
    this.roomIds = [...roomIds];
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', roomIds: this.roomIds });
    }
  }

  sendTyping(roomId: string, channelId: string, isTyping: boolean): void {
    this.send({ type: 'typing', roomId, channelId, isTyping });
  }

  sendPresence(status: 'online' | 'idle' | 'dnd'): void {
    this.send({ type: 'presence', status });
  }

  disconnect(): void {
    this.closedManually = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this.onStatus('disconnected');
  }

  private send(msg: WsClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private openSocket(): void {
    if (this.closedManually || !this.token) return;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const base = getWsBaseUrl().replace(/\/$/, '');
    this.onStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const socket = new WebSocket(`${base}/api/v1/ws`);
    this.ws = socket;

    socket.onopen = () => {
      if (!this.token) return;
      this.send({ type: 'auth', accessToken: this.token });
    };

    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as WsServerMessage;
        if (parsed.type === 'authenticated') {
          this.reconnectAttempts = 0;
          this.onStatus('connected');
          if (this.roomIds.length > 0) {
            this.send({ type: 'subscribe', roomIds: this.roomIds });
          }
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = setInterval(() => {
            this.send({ type: 'ping', ts: Date.now() });
          }, CLIENT_LIMITS.wsHeartbeatIntervalMs);
        }
        this.onMessage(parsed);
      } catch {
        // Ignore malformed WS frame
      }
    };

    socket.onclose = () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.closedManually) {
        this.onStatus('disconnected');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose handles reconnect cleanly
    };
  }

  private scheduleReconnect(): void {
    if (this.closedManually) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.onStatus('reconnecting');
    const delay = Math.min(
      CLIENT_LIMITS.wsMaxReconnectDelayMs,
      800 * Math.pow(1.6, this.reconnectAttempts),
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }
}

