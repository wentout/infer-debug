/**
 * Minimal Chrome DevTools Protocol client over the Node.js >= 22 built-in
 * WebSocket. Just enough for the e2e: connect, send commands, wait for events.
 * No dependencies — do not add any.
 */

type TWebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(event: string, cb: (ev: { data?: unknown; message?: string }) => void): void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TCdpParams = any;
type TPending = { resolve: (v: TCdpParams) => void; reject: (e: Error) => void };
type TEventHandler = (params: TCdpParams) => void;

export class CdpClient {
  private seq = 0;
  private readonly pending = new Map<number, TPending>();
  private readonly eventHandlers = new Map<string, TEventHandler[]>();

  private constructor(private readonly ws: TWebSocketLike) {
    ws.addEventListener('message', (ev) => this.handleMessage(ev.data));
  }

  static connect(url: string, timeoutMs = 10000): Promise<CdpClient> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WebSocketImpl = (globalThis as any).WebSocket;
    if (!WebSocketImpl) {
      return Promise.reject(new Error('Global WebSocket not found — Node.js >= 22 is required'));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(url) as TWebSocketLike;
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${url}`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed (${url}): ${ev?.message ?? 'unknown'}`));
      });
    });
  }

  send<T = TCdpParams>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: TEventHandler): void {
    const list = this.eventHandlers.get(method) ?? [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  off(method: string, handler: TEventHandler): void {
    const list = this.eventHandlers.get(method) ?? [];
    this.eventHandlers.set(
      method,
      list.filter((h) => h !== handler),
    );
  }

  waitForEvent<T = TCdpParams>(method: string, timeoutMs = 20000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handler: TEventHandler = (params) => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`Timeout waiting for CDP event ${method}`));
      }, timeoutMs);
      this.on(method, handler);
    });
  }

  close(): void {
    this.ws.close();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(`CDP error: ${JSON.stringify(message.error)}`));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }
    const handlers = this.eventHandlers.get(message.method) ?? [];
    for (const handler of handlers) {
      handler(message.params);
    }
  }
}
