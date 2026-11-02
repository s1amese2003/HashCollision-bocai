import type { WebSocket } from 'ws';

export type HubEvent =
  | { type: 'market'; marketId: number; priceYes: number; status: string; volume: number }
  | { type: 'trade'; marketId: number; username: string; outcome: string; side: string; amount: number; priceAfter: number };

/** Fan-out of server events to connected WebSocket clients. */
export class Hub {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  get size(): number {
    return this.clients.size;
  }

  broadcast(event: HubEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  closeAll(): void {
    for (const ws of this.clients) ws.close(1001, 'server shutting down');
    this.clients.clear();
  }
}
