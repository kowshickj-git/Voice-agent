import type { MessageParam } from '../llm/types.js';

/**
 * The conversation sent to Claude. It is append-only: earlier messages are
 * never edited, which keeps the prompt cache warm and keeps Claude's earlier
 * thinking valid (editing history would invalidate it).
 */
export class Conversation {
  private readonly items: MessageParam[];

  constructor(initial: readonly MessageParam[] = []) {
    this.items = [...initial];
  }

  get length(): number {
    return this.items.length;
  }

  append(message: MessageParam): void {
    const { content } = message;
    if (typeof content === 'string' ? content.trim() === '' : content.length === 0) return;
    this.items.push(message);
  }

  snapshot(): MessageParam[] {
    return [...this.items];
  }
}
