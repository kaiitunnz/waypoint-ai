import { isRecord } from "../domain/connections";

export interface Envelope {
  type: string;
  payload: Record<string, unknown>;
}
export type StreamStatus = "connecting" | "live" | "reconnecting" | "auth-error";
export interface SocketHandlers {
  message: (data: unknown) => void;
  close: (code: number) => void;
  error: () => void;
}
export type SocketFactory = (url: string, handlers: SocketHandlers) => { close: () => void };
export interface Scheduler {
  set: (callback: () => void, delay: number) => unknown;
  clear: (timer: unknown) => void;
}

export const nativeSocket: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => handlers.message(event.data));
  socket.addEventListener("close", (event) => handlers.close(event.code));
  socket.addEventListener("error", handlers.error);
  return { close: () => socket.close() };
};
export const timers: Scheduler = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function socketUrl(apiUrl: string, token: string, sessionId?: string): string {
  const url = new URL(`${apiUrl}/ws/sessions${sessionId !== undefined ? `/${encodeURIComponent(sessionId)}` : ""}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

export class LiveSocket {
  private socket?: { close: () => void };
  private timer?: unknown;
  private generation = 0;
  private stopped = true;
  private failures = 0;
  constructor(
    private readonly url: string,
    private readonly initialType: string,
    private readonly onMessage: (message: Envelope, initial: boolean) => void,
    private readonly onStatus: (status: StreamStatus) => void,
    private readonly factory = nativeSocket,
    private readonly scheduler = timers,
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.generation++;
    this.scheduler.clear(this.timer);
    this.timer = undefined;
    try {
      this.socket?.close();
    } catch {
      /* A connecting socket may already be closed. */
    }
    this.socket = undefined;
  }
  retry() {
    this.stop();
    this.failures = 0;
    this.start();
  }

  private connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    let ready = false;
    const current = () => !this.stopped && this.generation === generation;
    this.onStatus(this.failures ? "reconnecting" : "connecting");
    const closeSocket = () => {
      try {
        this.socket?.close();
      } catch {
        /* No active transport remains. */
      }
    };
    const disconnect = (auth = false) => {
      if (!current()) return;
      this.generation++;
      this.scheduler.clear(this.timer);
      closeSocket();
      if (auth) {
        this.stopped = true;
        this.timer = undefined;
        this.onStatus("auth-error");
        return;
      }
      this.onStatus("reconnecting");
      const delay = Math.min(1000 * 2 ** Math.min(this.failures++, 4), 15000);
      this.timer = this.scheduler.set(() => this.connect(), delay);
    };
    this.timer = this.scheduler.set(() => disconnect(), 10000);
    try {
      this.socket = this.factory(this.url, {
        message: (data) => {
          if (!current()) return;
          try {
            if (typeof data !== "string") throw new Error("Invalid socket frame");
            const message: unknown = JSON.parse(data);
            if (!isRecord(message) || typeof message.type !== "string" || !isRecord(message.payload))
              throw new Error("Invalid socket envelope");
            if (message.type === "auth_revoked") {
              disconnect(true);
              return;
            }
            const initial = !ready && message.type === this.initialType;
            if (initial) {
              ready = true;
              this.failures = 0;
              this.scheduler.clear(this.timer);
              this.timer = undefined;
              this.onStatus("live");
            }
            this.onMessage({ type: message.type, payload: message.payload }, initial);
          } catch {
            disconnect();
          }
        },
        close: (code) => disconnect(code === 4401),
        error: () => disconnect(),
      });
    } catch {
      disconnect();
    }
  }
}
