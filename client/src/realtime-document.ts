import type { SharedNode, SharedOperation } from '../types/realtime';

// Replicated growable array. Identifiers sort by Lamport clock before actor,
// so later insertions precede an already known successor at the same anchor.
export class SharedDocument {
  private nodes = new Map<string, SharedNode>();
  clock = 0;
  private counter = 0;
  constructor(readonly actor: string, nodes: SharedNode[] = []) {
    this.apply({ insert: nodes, delete: [] });
  }
  apply(operation: SharedOperation): void {
    for (const node of operation.insert || []) {
      this.clock = Math.max(this.clock, Number(node.id.split(':')[0]) || 0);
      if (!this.nodes.has(node.id)) this.nodes.set(node.id, { ...node });
      else if (node.deleted) this.nodes.get(node.id)!.deleted = true;
    }
    for (const id of operation.delete || []) {
      const node = this.nodes.get(id);
      if (node) node.deleted = true;
    }
  }
  snapshot(): SharedNode[] { return Array.from(this.nodes.values(), node => ({ ...node })); }
  visible(): SharedNode[] {
    const children = new Map<string, SharedNode[]>();
    for (const node of this.nodes.values()) {
      const list = children.get(node.after) || [];
      list.push(node); children.set(node.after, list);
    }
    for (const list of children.values()) list.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const result: SharedNode[] = [];
    const stack = [...(children.get('') || [])].reverse();
    while (stack.length) {
      const node = stack.pop()!;
      if (!node.deleted) result.push(node);
      const list = children.get(node.id) || [];
      for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]!);
    }
    return result;
  }
  text(): string { return this.visible().map(node => node.value).join(''); }
  makeInsert(after: string, text: string): SharedNode[] {
    return Array.from(text, value => {
      const id = String(++this.clock).padStart(16, '0') + ':' + this.actor + ':' + String(++this.counter).padStart(8, '0');
      const node = { id, after, value };
      after = id;
      return node;
    });
  }
  change(changes: readonly { rangeOffset: number; rangeLength: number; text: string }[]): SharedOperation {
    const visible = this.visible();
    const offsets = [0];
    for (const node of visible) offsets.push(offsets[offsets.length - 1]! + node.value.length);
    const operation: SharedOperation = { insert: [], delete: [] };
    for (const change of changes) {
      const start = offsets.indexOf(change.rangeOffset), end = offsets.indexOf(change.rangeOffset + change.rangeLength);
      if (start < 0 || end < 0) throw new Error('Edit splits a Unicode character');
      operation.delete.push(...visible.slice(start, end).map(node => node.id));
      operation.insert.push(...this.makeInsert(start ? visible[start - 1]!.id : '', change.text));
    }
    return operation;
  }
  anchor(offset: number): string {
    let position = 0, anchor = '';
    for (const node of this.visible()) {
      if (position + node.value.length > offset) break;
      position += node.value.length; anchor = node.id;
    }
    return anchor;
  }
  offset(anchor: string): number {
    if (!anchor) return 0;
    // Deleted anchors still identify a position among their surviving children.
    const original = this.nodes.get(anchor);
    if (!original) return 0;
    let offset = 0;
    const restored = original.deleted;
    original.deleted = false;
    for (const node of this.visible()) {
      if (node.id === anchor) { if (!restored) offset += node.value.length; break; }
      offset += node.value.length;
    }
    original.deleted = restored;
    return offset;
  }
  inverse(operation: SharedOperation): SharedOperation {
    const visible = this.visible(), byId = new Map(visible.map((node, i) => [node.id, i]));
    const inverse: SharedOperation = { insert: [], delete: operation.insert.map(node => node.id) };
    for (const id of operation.delete) {
      const index = byId.get(id);
      if (index === undefined) continue;
      const node = visible[index]!;
      inverse.insert.push(...this.makeInsert(index ? visible[index - 1]!.id : '', node.value));
    }
    return inverse;
  }
  reidentify(operation: SharedOperation): SharedOperation {
    const mapping = new Map<string, string>();
    const insert = operation.insert.flatMap(node => {
      const fresh = this.makeInsert(mapping.get(node.after) || node.after, node.value);
      mapping.set(node.id, fresh[0]!.id);
      return fresh;
    });
    return { insert, delete: [...operation.delete] };
  }
}
