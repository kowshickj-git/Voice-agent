import type Anthropic from '@anthropic-ai/sdk';
import type { LlmConfig } from '../config.js';
import { ClaudeBrain, createAnthropicClient } from './ClaudeBrain.js';
import { OllamaBrain } from './OllamaBrain.js';
import type { Brain, Tool } from './types.js';

/** The model for one call: Claude, or a free local model in Ollama. */
export function createBrain(llm: LlmConfig, systemPrompt: string, tools: Tool[], anthropic?: Anthropic): Brain {
  if (llm.provider === 'ollama') return new OllamaBrain(llm, systemPrompt, tools);
  return new ClaudeBrain(anthropic ?? createAnthropicClient(), llm, systemPrompt, tools);
}

/** A short description of the model in use, for logs and the test page. */
export function describeLlm(llm: LlmConfig): string {
  if (llm.provider === 'ollama') return `${llm.model} (local, Ollama)`;
  return `${llm.model}${llm.effort ? ` (effort ${llm.effort})` : ''}`;
}
