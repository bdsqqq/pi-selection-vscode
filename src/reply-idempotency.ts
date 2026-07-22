export class PendingReplyIds<Key extends object> {
  private readonly pending = new WeakMap<Key, { text: string; requestId: string }>();

  requestId(key: Key, text: string, create: () => string): string {
    const current = this.pending.get(key);
    if (current?.text === text) return current.requestId;
    const requestId = create();
    this.pending.set(key, { text, requestId });
    return requestId;
  }

  confirm(key: Key, text: string, requestId: string): void {
    const current = this.pending.get(key);
    if (current?.text === text && current.requestId === requestId) this.pending.delete(key);
  }
}
