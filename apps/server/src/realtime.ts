import type { WebSocket } from 'ws';
import type { ServerEvent } from '@barc/shared';

/** Tracks which members are connected so a node can push ride events to them. */
export class Hub {
  private sockets = new Map<string, Set<WebSocket>>();

  add(userId: string, ws: WebSocket): void {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(ws);
  }

  remove(userId: string, ws: WebSocket): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.sockets.delete(userId);
  }

  isConnected(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  send(userId: string, event: ServerEvent): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  sendMany(userIds: Iterable<string>, event: ServerEvent): void {
    for (const id of new Set(userIds)) this.send(id, event);
  }

  broadcast(event: ServerEvent): void {
    this.sendMany(this.sockets.keys(), event);
  }
}
