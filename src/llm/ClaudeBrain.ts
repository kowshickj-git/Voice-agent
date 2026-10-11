import Anthropic from '@anthropic-ai/sdk';
import type { LlmConfig } from '../config.js';
import type { Brain, ContentBlock, ContentBlockParam, MessageParam, ResponseStream, Tool, ToolUseBlock } from './types.js';

/** Beta header for `fallbacks: "default"`: if a safety classifier declines, another model answers in the same call. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createAnthropicClient(): Anthropic {
  // Short timeout: on a phone call a stuck request is worse than a quick retry.
  return new Anthropic({ maxRetries: 2, timeout: 20_000 });
}

/** Claude, configured for one call: frozen system prompt and tools, streaming replies. */
export class ClaudeBrain implements Brain {
  private readonly system: Anthropic.Beta.BetaTextBlockParam[];

  constructor(
    private readonly client: Anthropic,
    private readonly config: LlmConfig,
    systemPrompt: string,
    private readonly tools: Tool[],
  ) {
    // Explicit breakpoint after the static prefix (tools + system): shared across calls.
    this.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }

  private get effortParams() {
    return this.config.effort ? { output_config: { effort: this.config.effort } } : {};
  }

  stream(messages: MessageParam[], signal: AbortSignal): ResponseStream {
    return this.client.beta.messages.stream(
      {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: this.system,
        tools: this.tools,
        messages,
        ...this.effortParams,
        // Automatic caching keeps a second breakpoint at the end of the growing conversation.
        cache_control: { type: 'ephemeral' },
        ...(this.config.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      },
      { signal },
    );
  }

  async prewarm(): Promise<void> {
    // max_tokens 0 runs prefill only: it writes the cache for tools + system and returns no output.
    await this.client.beta.messages.create({
      model: this.config.model,
      max_tokens: 0,
      system: this.system,
      tools: this.tools,
      ...this.effortParams,
      messages: [{ role: 'user', content: 'warmup' }],
    });
  }
}

/**
 * The assistant content to keep in the conversation history, plus the tool
 * calls to run. After a mid-response fallback (a classifier declined and
 * another model continued), only text is kept from before the switch point;
 * the declined model's thinking and tool calls must not be echoed back.
 */
export function assistantContentForHistory(content: ContentBlock[]): { content: ContentBlockParam[]; toolUses: ToolUseBlock[] } {
  let boundary = -1;
  content.forEach((block, i) => {
    if (block.type === 'fallback') boundary = i;
  });
  const kept = boundary < 0 ? content : content.filter((block, i) => i >= boundary || block.type === 'text');
  const toolUses = kept.filter((block): block is ToolUseBlock => block.type === 'tool_use');
  return { content: kept as ContentBlockParam[], toolUses };
}

/** A one-line description of an API error for logs. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key (check ANTHROPIC_API_KEY)';
  if (err instanceof Anthropic.PermissionDeniedError) return `Anthropic denied access: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Anthropic returned 404 (check LLM_MODEL): ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached';
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'Anthropic request timed out';
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach Anthropic: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === 'AbortError');
}
