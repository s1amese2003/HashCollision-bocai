import type { WebSocket } from 'ws';

export type HubEvent =
  /** priceYes is null for fixed-odds markets. */
  | { type: 'market'; marketId: number; priceYes: number | null; status: string; volume: number }
  | { type: 'halt'; halted: boolean }
  | { type: 'trade'; marketId: number; username: string; outcome: string; side: string; amount: number; priceAfter: number }
  | { type: 'bet'; marketId: number; username: string; label: string; stake: number; odds: number };

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
