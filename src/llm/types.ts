import type Anthropic from '@anthropic-ai/sdk';

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Message = Anthropic.Beta.BetaMessage;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;
export type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
export type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
export type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
export type Tool = Anthropic.Beta.BetaTool;

/** The slice of the SDK's message stream the call logic depends on (easy to fake in tests). */
export interface ResponseStream {
  on(event: 'text', listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Message>;
  abort(): void;
}

/** A failed model request (for providers other than the Anthropic SDK, which has its own error classes). */
export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Retrying can't help (bad key, unknown model, ...). */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

/** What the team needs to do after a call, read from its transcript. */
export interface FollowUp {
  callerName: string;
  callbackNumber: string;
  message: string;
  urgency: 'low' | 'normal' | 'high';
}

/** The conversational model for one call. */
export interface Brain {
  /** Streams one model response for the conversation so far. */
  stream(messages: MessageParam[], signal: AbortSignal): ResponseStream;
  /** Writes the prompt cache for this call's system prompt and tools ahead of the first reply. */
  prewarm(): Promise<void>;
  /** Local models: a tiny request on the conversation so far that keeps the GPU awake between turns. */
  keepWarm?(messages: readonly MessageParam[]): void;
  /**
   * Optional after-call check for models whose tool calls are unreliable: reads
   * the transcript and returns a message for the team if the caller needs a
   * follow-up (callback, booking, unanswered question), or null.
   */
  findFollowUp?(transcript: string, callerId: string | undefined): Promise<FollowUp | null>;
}
