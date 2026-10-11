import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig, SttCorrection } from '../config.js';
import type { Logger } from '../logger.js';
import { assistantContentForHistory, describeApiError, isAbortError } from '../llm/ClaudeBrain.js';
import { referenceNote, type KnowledgeLibrary } from '../llm/library.js';
import { callContextNote } from '../llm/prompt.js';
import { CALL_CONTROL_TOOLS, invalidInputResult, runTool, TAKE_MESSAGE, TRANSFER_CALL, validateToolInput } from '../llm/tools.js';
import { ModelRequestError, type Brain, type ContentBlockParam, type Message, type MessageParam, type ToolResultBlockParam, type ToolUseBlock } from '../llm/types.js';
import { CallRecord, saveCallRecord, type CallInfo, type MessageStore } from '../records.js';
import type { SpeechToText, SttFactory, TurnEvent } from '../stt/types.js';
import { SentenceChunker } from '../text/SentenceChunker.js';
import { isBackchannel, isMutualFarewell, isSpokenEndCall, productCodes, toSpeakableText } from '../text/speechText.js';
import { AudioCache } from '../tts/index.js';
import type { TextToSpeech } from '../tts/types.js';
import { Conversation } from './Conversation.js';
import type { Transport } from './MediaStream.js';
import { PlaybackTracker } from './PlaybackTracker.js';
import { SpeechPipeline, type AudioOutput } from './SpeechPipeline.js';

export type EndAction = { type: 'hangup' } | { type: 'transfer'; to: string };

/** Fixed lines for when the model or speech recognition fails. Translate them if your agent doesn't speak English. */
export const PHRASES = {
  modelError: "Sorry, I'm having a little trouble on my end. Could you say that again?",
  modelDown: "I'm sorry, I'm having technical difficulties right now. Please call back in a little while. Goodbye.",
  modelDownTransfer: "I'm sorry, I'm having technical difficulties right now. Let me connect you with someone from our team.",
  cantHear: "I'm sorry, I'm having trouble hearing you on this line. Please call back in a little while. Goodbye.",
  cantHearTransfer: "I'm sorry, I'm having trouble hearing you on this line. Let me connect you with someone from our team.",
  refusal: "Sorry, I can't help with that. Is there anything else I can do for you?",
  /** Said instead of a reply that named a product the agent's files don't mention. */
  unknownProduct: "Sorry, I don't have reliable details on that, and I don't want to guess. I can have our team check it and call you back.",
  /** Said only if the agent hangs up or transfers without having said anything first. */
  goodbye: 'Thanks for calling. Goodbye!',
  connecting: 'One moment while I connect you.',
};

/** Model calls allowed in one agent turn (bounds the tool loop). */
const MAX_RESPONSES_PER_TURN = 6;
const MAX_CONSECUTIVE_ERRORS = 3;
const DTMF_IDLE_MS = 2000;
/** Pause after the last audio before hanging up or transferring, so the final word isn't clipped. */
const ACTION_DELAY_MS = 400;
/** How long the agent may keep talking after the call-length limit before the line is closed. */
const CALL_LIMIT_GRACE_MS = 45_000;
/**
 * How often an idle local model gets a tiny request during a call. A laptop GPU
 * left idle for 20 seconds took 1.3 s to answer the next request; one used
 * within the last 1 to 2 seconds answers in about 50 ms.
 */
const MODEL_KEEP_WARM_MS = 1500;

export interface CallSessionDeps {
  config: AppConfig;
  brain: Brain;
  tts: TextToSpeech;
  createStt: SttFactory;
  audioCache: AudioCache;
  voiceKey: string;
  messages: MessageStore;
  log: Logger;
  /**
   * The product codes the agent's files mention ("SG5.0RS"). When set, a reply
   * that names any other code is stopped before it's spoken, because small
   * local models invent products and their specs.
   */
  knownProductCodes?: ReadonlySet<string>;
  /** The agent's knowledge library: matching sections are added to the caller's message as reference notes. */
  library?: KnowledgeLibrary;
  /** Called once when the call ends, with what should happen to the phone line next. */
  onEnd?: (action: EndAction, session: CallSession) => void;
}

/** Lets a call continue with the agent after a transfer that nobody answered. */
export interface ResumeState {
  messages: MessageParam[];
  record: CallRecord;
  note: string;
}

type TurnKind = 'greeting' | 'caller' | 'note' | 'keypad' | 'notice';

/** Errors that retrying can't fix (bad key, unknown model, invalid request). */
function isPermanentModelError(err: unknown): boolean {
  if (err instanceof ModelRequestError) return err.permanent;
  return (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.BadRequestError
  );
}

/**
 * The caller's words as the model sees them: square brackets are reserved for
 * system notes, and words the recognizer keeps getting wrong are corrected.
 */
function cleanCallerText(transcript: string, corrections: readonly SttCorrection[] = []): string {
  let text = transcript.replace(/[[\]]/g, '').trim();
  for (const { pattern, replacement } of corrections) text = text.replace(pattern, replacement);
  return text;
}

interface ResponseState {
  index: number;
  /** Text queued for speech so far. */
  spokenText: string;
  segments: number;
  /** The model's full reply was appended to the history verbatim. */
  committed: boolean;
}

interface PendingAction {
  turnId: number;
  action: EndAction;
  reason: string;
  /** The tool call that requested it (absent for actions the session takes itself). */
  toolUseId?: string;
}

/** One agent reply: a user message, up to a few model responses (tool loop), and their speech. */
class AgentTurn {
  readonly abort = new AbortController();
  readonly responses: ResponseState[] = [];
  readonly confirmedSignal: Promise<void>;
  readonly cancelledSignal: Promise<void>;
  speech!: SpeechPipeline;
  userMessage: MessageParam | null = null;
  /** How many pending notes / tool results the user message consumed. */
  consumed = { notes: 0, toolResults: 0 };
  /** Knowledge library sections added to the user message. */
  references: number[] = [];
  confirmRequested = false;
  /** A response that failed to parse was already retried once. */
  retried = false;
  confirmed = false;
  cancelled = false;
  llmDone = false;
  speechDone = false;
  finished = false;
  endOfTurnAt?: number;
  firstAudioAt?: number;
  private resolveConfirmed!: () => void;
  private resolveCancelled!: () => void;

  constructor(
    readonly id: number,
    readonly kind: TurnKind,
    /** The caller's words, or the system note, this turn answers. */
    readonly input: string,
  ) {
    this.confirmedSignal = new Promise((resolve) => (this.resolveConfirmed = resolve));
    this.cancelledSignal = new Promise((resolve) => (this.resolveCancelled = resolve));
  }

  markConfirmed(): void {
    this.confirmed = true;
    this.resolveConfirmed();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abort.abort();
    this.speech?.cancel();
    this.resolveCancelled();
  }

  addResponse(): ResponseState {
    const response: ResponseState = { index: this.responses.length, spokenText: '', segments: 0, committed: false };
    this.responses.push(response);
    return response;
  }
}

/**
 * Runs one phone call: listens to the caller through the speech recognizer,
 * decides when to answer or stop talking, gets replies from Claude, speaks
 * them, and carries out call actions (hang up, transfer).
 */
export class CallSession {
  readonly record: CallRecord;
  private readonly history: Conversation;
  private readonly playback = new PlaybackTracker();
  private readonly log: Logger;
  private stt: SpeechToText | null = null;
  private turn: AgentTurn | null = null;
  private turnSeq = 0;
  private segmentSeq = 0;
  /** The caller's current turn, while they are speaking. */
  private caller: { index: number; interrupted: boolean } | null = null;
  private pendingNotes: string[] = [];
  private pendingToolResults: ToolResultBlockParam[] = [];
  private pendingAction: PendingAction | null = null;
  /** Resolves once tool results from the latest tool calls are recorded. */
  private toolBarrier: Promise<void> = Promise.resolve();
  private silenceTimer?: NodeJS.Timeout;
  private silencePrompts = 0;
  private limitTimer?: NodeJS.Timeout;
  private warmTimer?: NodeJS.Timeout;
  private modelWarmTimer?: NodeJS.Timeout;
  private hardStopTimer?: NodeJS.Timeout;
  private dtmfDigits = '';
  private dtmfTimer?: NodeJS.Timeout;
  private consecutiveErrors = 0;
  /** A take_message call succeeded during this call. */
  private messageTaken = false;
  /** Library sections already in the history; each is added at most once per call. */
  private readonly usedReferences = new Set<number>();
  private ended = false;

  constructor(
    readonly info: CallInfo,
    private readonly transport: Transport,
    private readonly deps: CallSessionDeps,
    private readonly resume?: ResumeState,
  ) {
    this.log = deps.log;
    this.record = resume?.record ?? new CallRecord(info);
    this.history = new Conversation(resume?.messages);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The conversation so far (for saving, or resuming after a failed transfer). */
  get messages(): MessageParam[] {
    return this.history.snapshot();
  }

  start(): void {
    const { config, brain } = this.deps;
    this.stt = this.deps.createStt({ onTurn: (event) => this.onTurnEvent(event), onFatal: (err) => this.onSttFatal(err) }, this.log);
    this.stt.start().catch(() => {
      // transient failures are retried by the recognizer; permanent ones arrive via onFatal
    });
    // Call timers never keep the process alive on their own (the HTTP server does that).
    this.limitTimer = setTimeout(() => this.onCallLimit(), config.call.maxDurationMs).unref();
    // Keep a connection to the voice service open for the whole call: opening one costs ~0.5-1 s
    // on long routes, and idle connections are dropped after a few seconds.
    if (this.deps.tts.warmUp) {
      this.deps.tts.warmUp();
      this.warmTimer = setInterval(() => this.deps.tts.warmUp?.(), 3000).unref();
    }

    if (this.resume) {
      this.record.add('system', 'Back with the agent after an unanswered transfer');
      this.startAgentTurn('note', this.resume.note, false);
      return;
    }
    // Write the prompt cache while the greeting plays, so the first reply is fast.
    brain.prewarm().catch((err: unknown) => this.log.debug(`Prompt cache prewarm skipped: ${describeApiError(err)}`));
    this.history.append({ role: 'user', content: callContextNote({ callerNumber: this.info.from, timezone: config.agent.timezone }) });
    this.speakGreeting(config.agent.greeting);
    if (brain.keepWarm) this.modelWarmTimer = setInterval(() => this.keepModelWarm(), MODEL_KEEP_WARM_MS).unref();
  }

  /** Between replies, keeps a local model's GPU awake (and its prompt cache on this conversation). */
  private keepModelWarm(): void {
    const turn = this.turn;
    if (this.ended || (turn && !turn.llmDone && !turn.cancelled)) return;
    this.deps.brain.keepWarm?.(this.history.snapshot());
  }

  // ── Events from the phone line ───────────────────────────────────────────

  onAudio(chunk: Buffer): void {
    if (!this.ended) this.stt?.sendAudio(chunk);
  }

  onMark(name: string): void {
    if (!this.playback.ack(name)) return;
    if (this.turn) this.checkTurnFinished(this.turn);
  }

  onDtmf(digit: string): void {
    if (this.ended || !/^[0-9*#]$/.test(digit)) return;
    this.dtmfDigits += digit;
    clearTimeout(this.dtmfTimer);
    const submit = () => {
      const digits = this.dtmfDigits;
      this.dtmfDigits = '';
      if (digits && !this.ended) {
        this.startAgentTurn('keypad', `[The caller pressed these keys on their keypad: ${digits.split('').join(' ')}]`, false);
      }
    };
    if (digit === '#') submit();
    else this.dtmfTimer = setTimeout(submit, DTMF_IDLE_MS);
  }

  /** The phone line closed (the caller hung up). */
  onStreamClosed(): void {
    this.end({ type: 'hangup' }, 'caller hung up');
  }

  // ── Caller turns (from Deepgram Flux) ────────────────────────────────────

  private onTurnEvent(event: TurnEvent): void {
    if (this.ended) return;
    if (event.type !== 'Update') this.log.debug(`Flux ${event.type}: "${event.transcript}"`);
    switch (event.type) {
      case 'StartOfTurn':
      case 'Update':
        this.onCallerSpeaking(event);
        return;
      case 'EagerEndOfTurn':
        this.onCallerSpeaking(event);
        this.onEagerEndOfTurn(event);
        return;
      case 'TurnResumed':
        this.onTurnResumed();
        return;
      case 'EndOfTurn':
        this.onEndOfTurn(event);
        return;
    }
  }

  private onCallerSpeaking(event: TurnEvent): void {
    // Right after each EndOfTurn, Flux sends an empty Update for the next turn. Only a
    // StartOfTurn or actual words mean the caller is talking; otherwise the session would
    // wait for a caller who is silent (no silence check-ins, no hang-up after goodbyes).
    if (event.type !== 'StartOfTurn' && !event.transcript.trim()) return;
    if (!this.caller || this.caller.index !== event.turnIndex) {
      this.caller = { index: event.turnIndex, interrupted: false };
      this.clearSilenceTimer();
      this.silencePrompts = 0;
    }
    if (event.transcript) this.transport.sendEvent({ type: 'caller_partial', text: event.transcript });
    this.maybeBargeIn(event.transcript);
  }

  /** Stops the agent when the caller starts talking over it, unless it's just "mm-hmm". */
  private maybeBargeIn(transcript: string): void {
    const turn = this.turn;
    if (!this.caller || this.caller.interrupted || !turn || turn.finished || turn.cancelled) return;
    // An unconfirmed reply is a speculative answer to this very turn, not something to interrupt.
    if (!turn.confirmed) return;
    if (isBackchannel(transcript)) return;
    this.caller.interrupted = true;
    this.interrupt(`caller said "${transcript}"`);
  }

  /** Flux thinks the caller is probably done: start preparing the reply, but hold its audio until EndOfTurn. */
  private onEagerEndOfTurn(event: TurnEvent): void {
    const text = cleanCallerText(event.transcript, this.deps.config.stt.corrections);
    if (!text || this.ended) return;
    if (this.agentBusy() && this.turn?.confirmed && isBackchannel(text)) return;
    this.startAgentTurn('caller', text, true);
  }

  private onTurnResumed(): void {
    const turn = this.turn;
    if (turn && !turn.confirmed && !turn.cancelled) this.discardTurn(turn);
  }

  private onEndOfTurn(event: TurnEvent): void {
    const caller = this.caller;
    this.caller = null;
    const text = cleanCallerText(event.transcript, this.deps.config.stt.corrections);
    const turn = this.turn;
    if (!text) {
      if (turn && !turn.confirmed) this.discardTurn(turn);
      if (!this.agentBusy()) this.armSilenceTimer();
      return;
    }
    // An acknowledgement while the agent keeps talking: let it finish.
    if (!caller?.interrupted && turn?.confirmed && this.agentBusy() && isBackchannel(text)) {
      this.log.debug(`Ignoring acknowledgement "${text}" while speaking`);
      this.record.add('caller', `${text} (while the agent was speaking)`);
      return;
    }
    if (turn && !turn.confirmed && !turn.cancelled && turn.kind === 'caller' && turn.input === text) {
      turn.endOfTurnAt = Date.now();
      this.confirmTurn(turn);
      return;
    }
    this.startAgentTurn('caller', text, false);
  }

  // ── Agent turns ──────────────────────────────────────────────────────────

  private agentBusy(): boolean {
    const turn = this.turn;
    return Boolean(turn && !turn.cancelled && !turn.finished);
  }

  private createTurn(kind: TurnKind, input: string): AgentTurn {
    const turn = new AgentTurn(++this.turnSeq, kind, input);
    turn.speech = new SpeechPipeline(this.deps.tts, this.audioOutput, {
      gate: turn.confirmedSignal,
      cache: this.deps.audioCache,
      log: this.log,
    });
    void turn.speech.done.then(() => {
      turn.speechDone = true;
      this.checkTurnFinished(turn);
    });
    this.turn = turn;
    this.playback.prune(turn.id - 2);
    return turn;
  }

  /**
   * Starts answering `input`. A speculative turn prepares its reply but plays
   * nothing until `confirmTurn` (when the caller's turn really ends).
   */
  private startAgentTurn(kind: TurnKind, input: string, speculative: boolean): void {
    const current = this.turn;
    if (current && !current.finished && !current.cancelled) {
      if (current.confirmed) this.interrupt('a new turn started');
      else this.discardTurn(current);
    }
    this.clearSilenceTimer();
    const turn = this.createTurn(kind, input);
    if (!speculative) {
      turn.endOfTurnAt = Date.now();
      turn.confirmRequested = true;
    }
    void this.runAgentTurn(turn);
  }

  private confirmTurn(turn: AgentTurn): void {
    turn.confirmRequested = true;
    if (turn.userMessage) this.commitUserMessage(turn);
  }

  /** Appends the turn's user message to the history; from here on the reply may play. */
  private commitUserMessage(turn: AgentTurn): void {
    if (turn.confirmed || turn.cancelled || !turn.userMessage) return;
    this.history.append(turn.userMessage);
    for (const id of turn.references) this.usedReferences.add(id);
    this.pendingNotes.splice(0, turn.consumed.notes);
    this.pendingToolResults.splice(0, turn.consumed.toolResults);
    if (turn.kind === 'caller') {
      this.log.info(`Caller: ${turn.input}`);
      this.record.add('caller', turn.input);
      this.transport.sendEvent({ type: 'caller', text: turn.input });
    } else {
      this.record.add('system', turn.input);
    }
    turn.markConfirmed();
  }

  /** Drops a reply nobody has heard yet. */
  private discardTurn(turn: AgentTurn): void {
    turn.cancel();
    if (this.turn === turn) this.turn = null;
  }

  private async runAgentTurn(turn: AgentTurn): Promise<void> {
    try {
      // Results of tool calls from an interrupted turn must be recorded before the next user message.
      await this.toolBarrier;
      if (turn.cancelled) return;
      const content: ContentBlockParam[] = [...this.pendingToolResults];
      const found = turn.kind === 'caller' && this.deps.library ? this.deps.library.search(turn.input, { exclude: this.usedReferences }) : [];
      turn.references = found.map((section) => section.id);
      if (found.length) this.log.debug(`Knowledge library: ${found.map((section) => section.title).join('; ')}`);
      const reference = found.length ? [referenceNote(found)] : [];
      content.push({ type: 'text', text: [...this.pendingNotes, ...reference, turn.input].join('\n') });
      turn.userMessage = { role: 'user', content };
      turn.consumed = { notes: this.pendingNotes.length, toolResults: this.pendingToolResults.length };
      if (turn.confirmRequested) this.commitUserMessage(turn);

      for (let i = 0; i < MAX_RESPONSES_PER_TURN && !turn.cancelled; i++) {
        if ((await this.runResponse(turn)) === 'stop') break;
      }
    } catch (err) {
      this.log.error('Agent turn failed', err);
    } finally {
      turn.llmDone = true;
      turn.speech.end();
      this.checkTurnFinished(turn);
    }
  }

  /** One streamed model response: speaks it as it arrives, then records it and runs any tools. */
  private async runResponse(turn: AgentTurn): Promise<'continue' | 'stop'> {
    const response = turn.addResponse();
    const chunker = new SentenceChunker();
    const messages = turn.confirmed ? this.history.snapshot() : [...this.history.snapshot(), turn.userMessage!];
    const startedAt = Date.now();
    let firstTextAt = 0;
    // Small models occasionally get stuck repeating a phrase, or describe a product
    // they know nothing about; stop the reply when that happens.
    const seen = new Map<string, number>();
    let looping = false;
    let unknownCode = undefined as string | undefined;
    // Small models sometimes write "End call." instead of calling end_call: never say it, but honor it.
    let wroteEndCall = false;
    const stream = this.deps.brain.stream(messages, turn.abort.signal);
    stream.on('text', (delta) => {
      if (turn.cancelled || looping || unknownCode) return;
      if (!firstTextAt) firstTextAt = Date.now();
      for (const chunk of chunker.push(delta)) {
        if (isSpokenEndCall(chunk)) {
          wroteEndCall = true;
          continue;
        }
        const key = chunk.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count >= 3) {
          looping = true;
          stream.abort();
          return;
        }
        unknownCode = this.unknownProductCode(chunk);
        if (unknownCode) {
          stream.abort();
          return;
        }
        this.queueSpeech(turn, response, chunk);
      }
    });

    let message: Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (looping && !turn.cancelled) {
        this.log.warn('Stopped a reply that kept repeating itself');
        return this.stopReply(turn, response);
      }
      if (unknownCode && !turn.cancelled) {
        this.log.warn(`Stopped a reply that named ${unknownCode}, which the agent's files don't mention`);
        return this.stopReply(turn, response, PHRASES.unknownProduct);
      }
      if (turn.cancelled || isAbortError(err)) return 'stop';
      // The Anthropic SDK already retries its own transient errors; other failures (a streamed tool
      // input that wasn't valid JSON, a local model hiccup) get one quiet retry.
      if (!(err instanceof Anthropic.APIError) && !isPermanentModelError(err) && !response.spokenText && !turn.retried) {
        turn.retried = true;
        this.log.warn(`Could not read the model's reply (${describeApiError(err)}); retrying`);
        return 'continue';
      }
      return this.onModelError(turn, response, err);
    }
    if (turn.cancelled) return 'stop';
    for (const chunk of chunker.flush()) {
      if (isSpokenEndCall(chunk)) {
        wroteEndCall = true;
        continue;
      }
      unknownCode ??= this.unknownProductCode(chunk);
      if (!unknownCode) this.queueSpeech(turn, response, chunk);
    }
    this.consecutiveErrors = 0;
    this.record.addUsage(message.usage);
    const { usage } = message;
    this.log.debug(
      `Model: first text ${firstTextAt ? firstTextAt - startedAt : '-'} ms, total ${Date.now() - startedAt} ms, ` +
        `stop=${message.stop_reason}, tokens in=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens ?? 0} ` +
        `cache_write=${usage.cache_creation_input_tokens ?? 0} out=${usage.output_tokens}`,
    );
    if (unknownCode) {
      this.log.warn(`Stopped a reply that named ${unknownCode}, which the agent's files don't mention`);
      return this.stopReply(turn, response, PHRASES.unknownProduct);
    }

    // A speculative reply can finish before the caller's turn is confirmed.
    if (!turn.confirmed) {
      await Promise.race([turn.confirmedSignal, turn.cancelledSignal]);
      if (turn.cancelled) return 'stop';
    }

    const { content, toolUses } = assistantContentForHistory(message.content);
    if (message.stop_reason === 'refusal' || (message.stop_reason === 'max_tokens' && toolUses.length > 0)) {
      // Never run tool calls from a cut-off or declined reply; keep only what was said.
      if (message.stop_reason === 'refusal') {
        this.log.warn(`Model declined to answer (${message.stop_details?.category ?? 'no category'})`);
        if (!response.spokenText) this.queueSpeech(turn, response, PHRASES.refusal);
      }
      this.commitSpokenText(response);
      return 'stop';
    }
    if (!content.some((block) => block.type === 'text' || block.type === 'tool_use')) return 'stop';
    this.history.append({ role: 'assistant', content });
    response.committed = true;
    if (response.spokenText) {
      this.log.info(`Agent: ${response.spokenText}`);
      this.record.add('agent', response.spokenText);
    }
    if (toolUses.length === 0) {
      if (wroteEndCall) {
        this.log.info('The model wrote "End call." instead of using the end_call tool; hanging up after the goodbye');
        if (turn.responses.every((r) => !r.spokenText)) this.queueSpeech(turn, response, PHRASES.goodbye);
        this.pendingAction = { turnId: turn.id, action: { type: 'hangup' }, reason: 'goodbye' };
      }
      return 'stop';
    }
    return this.handleToolCalls(turn, toolUses);
  }

  private async handleToolCalls(turn: AgentTurn, toolUses: ToolUseBlock[]): Promise<'continue' | 'stop'> {
    let release!: () => void;
    this.toolBarrier = new Promise<void>((resolve) => (release = resolve));
    try {
      const results: ToolResultBlockParam[] = [];
      let control: PendingAction | null = null;
      for (const use of toolUses) {
        this.log.info(`Tool call: ${use.name} ${JSON.stringify(use.input)}`);
        this.record.add('tool', `${use.name} ${JSON.stringify(use.input)}`);
        this.transport.sendEvent({ type: 'tool', name: use.name, input: use.input });
        if (!CALL_CONTROL_TOOLS.has(use.name)) {
          const result = await runTool(use, { callSid: this.info.callSid, callerId: this.info.from, messages: this.deps.messages, log: this.log });
          if (use.name === TAKE_MESSAGE && !result.is_error) this.messageTaken = true;
          results.push(result);
          continue;
        }
        const input = validateToolInput(use.name, use.input);
        const transferTo = this.deps.config.agent.transferNumber;
        if (!input) {
          results.push(invalidInputResult(use));
        } else if (control) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Only one call action can run at a time.' });
        } else if (use.name === TRANSFER_CALL && !transferTo) {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Transfers are not available. Offer to take a message instead.' });
        } else {
          const action: EndAction = use.name === TRANSFER_CALL ? { type: 'transfer', to: transferTo! } : { type: 'hangup' };
          control = { turnId: turn.id, action, reason: input.reason, toolUseId: use.id };
        }
      }

      if (control) {
        // The hang-up or transfer runs once the goodbye has played; its tool result is added then.
        this.pendingToolResults.push(...results);
        if (turn.cancelled) {
          this.pendingToolResults.push(this.cancelledActionResult(control));
        } else {
          this.pendingAction = control;
          if (turn.responses.every((r) => !r.spokenText)) {
            // Never drop the line silently.
            const line = control.action.type === 'transfer' ? PHRASES.connecting : PHRASES.goodbye;
            this.queueSpeech(turn, turn.responses[turn.responses.length - 1], line);
            this.record.add('agent', line);
          }
        }
        return 'stop';
      }
      if (turn.cancelled) {
        this.pendingToolResults.push(...results);
        return 'stop';
      }
      this.history.append({ role: 'user', content: results });
      return 'continue';
    } finally {
      release();
    }
  }

  private async onModelError(turn: AgentTurn, response: ResponseState, err: unknown): Promise<'stop'> {
    this.consecutiveErrors++;
    this.log.error(`Model request failed: ${describeApiError(err)}`);
    const giveUp = isPermanentModelError(err) || this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
    const transferTo = this.deps.config.agent.transferNumber;
    const line = !giveUp ? PHRASES.modelError : transferTo ? PHRASES.modelDownTransfer : PHRASES.modelDown;
    this.queueSpeech(turn, response, line);
    if (!turn.confirmed) {
      await Promise.race([turn.confirmedSignal, turn.cancelledSignal]);
      if (turn.cancelled) return 'stop';
    }
    this.commitSpokenText(response);
    if (giveUp) {
      this.pendingAction = {
        turnId: turn.id,
        action: transferTo ? { type: 'transfer', to: transferTo } : { type: 'hangup' },
        reason: 'model unavailable',
      };
    }
    return 'stop';
  }

  /** A product code in `text` that the agent's files don't mention, if the check is on. */
  private unknownProductCode(text: string): string | undefined {
    const known = this.deps.knownProductCodes;
    if (!known) return undefined;
    // "SG10RT" stands for the listed "SG10RT-P2", and "RT-P2" for the series.
    return productCodes(text).find((code) => !known.has(code) && ![...known].some((k) => k.includes(code)));
  }

  /** Ends a reply the session cut short: adds `line`, then records what was said once the turn is confirmed. */
  private async stopReply(turn: AgentTurn, response: ResponseState, line?: string): Promise<'stop'> {
    if (line) this.queueSpeech(turn, response, line);
    if (!turn.confirmed) {
      await Promise.race([turn.confirmedSignal, turn.cancelledSignal]);
      if (turn.cancelled) return 'stop';
    }
    this.commitSpokenText(response);
    return 'stop';
  }

  /** Records what was actually said for a reply that isn't kept verbatim. */
  private commitSpokenText(response: ResponseState): void {
    if (!response.spokenText) return;
    this.history.append({ role: 'assistant', content: response.spokenText });
    response.committed = true;
    this.record.add('agent', response.spokenText);
  }

  /**
   * Stops the agent mid-reply: drops unplayed audio, cancels generation, and
   * notes in the history what the caller actually heard.
   */
  private interrupt(reason: string): void {
    const turn = this.turn;
    if (!turn || turn.cancelled || turn.finished) return;
    if (!turn.confirmed) {
      this.discardTurn(turn);
      return;
    }
    const heard = this.playback.heard(turn.id);
    if (this.playback.hasPending(turn.id)) this.transport.clearAudio();
    this.playback.clearTurn(turn.id);
    turn.cancel();
    this.turn = null;
    this.log.info(`Interrupted: ${reason}`);
    this.transport.sendEvent({ type: 'interrupted' });

    for (const response of turn.responses) {
      const h = heard.get(response.index);
      const heardText = h?.heard ?? '';
      if (response.segments === 0 || (h?.playedSegments ?? 0) >= response.segments) continue;
      if (response.committed) {
        // The full reply is in the history; tell the model how much of it got through.
        this.pendingNotes.push(
          heardText
            ? `[The caller interrupted you. They only heard: "${heardText}"]`
            : '[The caller interrupted you before hearing your last reply.]',
        );
        this.record.add('system', heardText ? `Interrupted after: "${heardText}"` : 'Interrupted before the reply played');
      } else if (heardText) {
        // The reply was still being written: keep exactly the part that was spoken.
        this.history.append({ role: 'assistant', content: heardText });
        this.pendingNotes.push('[The caller interrupted you.]');
        this.record.add('agent', `${heardText} (interrupted)`);
      } else if (h) {
        // Audio had started, but not even a word got through.
        this.pendingNotes.push('[The caller interrupted you as you started to reply.]');
        this.record.add('system', 'Interrupted as the reply started');
      }
    }

    if (this.pendingAction?.turnId === turn.id) {
      const action = this.pendingAction;
      this.pendingAction = null;
      if (action.toolUseId) this.pendingToolResults.push(this.cancelledActionResult(action));
    }
  }

  private cancelledActionResult(action: PendingAction): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: action.toolUseId!,
      content:
        action.action.type === 'transfer'
          ? 'Not transferred: the caller started talking before the transfer began.'
          : 'The call was not ended: the caller started talking again.',
    };
  }

  private checkTurnFinished(turn: AgentTurn): void {
    if (turn !== this.turn || turn.finished || turn.cancelled || !turn.confirmed) return;
    if (!turn.llmDone || !turn.speechDone || this.playback.hasPending(turn.id)) return;
    turn.finished = true;
    if (this.pendingAction?.turnId === turn.id) {
      void this.runPendingAction();
      return;
    }
    // The caller said bye and the agent answered with a farewell, but the model didn't hang up.
    const said = turn.responses.map((r) => r.spokenText).join(' ');
    if (turn.kind === 'caller' && !this.caller && isMutualFarewell(turn.input, said)) {
      this.pendingAction = { turnId: turn.id, action: { type: 'hangup' }, reason: 'goodbye' };
      void this.runPendingAction();
      return;
    }
    if (!this.caller) this.armSilenceTimer();
  }

  private async runPendingAction(): Promise<void> {
    const pending = this.pendingAction;
    if (!pending || this.ended) return;
    this.pendingAction = null;
    if (pending.toolUseId) {
      const result =
        pending.action.type === 'transfer' ? `Transferring the caller to ${pending.action.to}.` : 'The call has been ended.';
      this.history.append({
        role: 'user',
        content: [...this.pendingToolResults, { type: 'tool_result', tool_use_id: pending.toolUseId, content: result }],
      });
      this.pendingToolResults = [];
    }
    await new Promise((resolve) => setTimeout(resolve, ACTION_DELAY_MS));
    this.end(pending.action, pending.reason);
  }

  // ── Speaking ─────────────────────────────────────────────────────────────

  private speakGreeting(text: string): void {
    const turn = this.createTurn('greeting', '');
    turn.markConfirmed();
    const response = turn.addResponse();
    this.history.append({ role: 'assistant', content: text });
    response.committed = true;
    this.record.add('agent', text);
    for (const sentence of SentenceChunker.sentences(text)) this.queueSpeech(turn, response, sentence, true);
    turn.llmDone = true;
    turn.speech.end();
  }

  /** Says a fixed line, then hangs up or transfers. */
  private speakAndEnd(text: string, action: EndAction, reason: string): void {
    if (this.agentBusy()) this.interrupt(reason);
    const turn = this.createTurn('notice', '');
    turn.markConfirmed();
    const response = turn.addResponse();
    this.queueSpeech(turn, response, text);
    this.record.add('agent', text);
    this.pendingAction = { turnId: turn.id, action, reason };
    turn.llmDone = true;
    turn.speech.end();
  }

  private queueSpeech(turn: AgentTurn, response: ResponseState, text: string, cacheable = false): void {
    if (turn.cancelled) return;
    const spoken = toSpeakableText(text);
    if (!spoken) return;
    response.spokenText = response.spokenText ? `${response.spokenText} ${spoken}` : spoken;
    response.segments++;
    turn.speech.push({
      id: ++this.segmentSeq,
      turnId: turn.id,
      responseIndex: response.index,
      text: spoken,
      cacheKey: cacheable ? AudioCache.key(this.deps.voiceKey, spoken) : undefined,
    });
  }

  private readonly audioOutput: AudioOutput = {
    beginSegment: (segment) => {
      this.playback.begin(segment);
      const turn = this.turn;
      if (turn && turn.id === segment.turnId && turn.firstAudioAt === undefined) {
        turn.firstAudioAt = Date.now();
        if (turn.endOfTurnAt !== undefined && turn.kind === 'caller') {
          const latency = turn.firstAudioAt - turn.endOfTurnAt;
          this.record.responseLatenciesMs.push(latency);
          this.log.debug(`Reply started ${latency} ms after the caller finished`);
          this.transport.sendEvent({ type: 'latency', ms: latency });
        }
      }
      this.transport.sendEvent({ type: 'agent', text: segment.text });
    },
    writeAudio: (segment, chunk) => {
      this.transport.sendAudio(chunk);
      this.playback.wrote(segment, chunk.length);
    },
    endSegment: (segment) => {
      const mark = `seg-${segment.id}`;
      this.playback.marked(segment, mark);
      this.transport.sendMark(mark);
    },
  };

  // ── Timers and failures ──────────────────────────────────────────────────

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    if (this.ended) return;
    this.silenceTimer = setTimeout(() => this.onSilence(), this.deps.config.call.silenceTimeoutMs).unref();
  }

  private clearSilenceTimer(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private onSilence(): void {
    if (this.ended || this.caller || this.agentBusy()) return;
    const { silenceTimeoutMs, maxSilencePrompts } = this.deps.config.call;
    this.silencePrompts++;
    if (this.silencePrompts > maxSilencePrompts) {
      this.log.info('The caller stayed silent; hanging up');
      this.end({ type: 'hangup' }, 'caller silent');
      return;
    }
    const seconds = Math.round((this.silencePrompts * silenceTimeoutMs) / 1000);
    this.startAgentTurn('note', `[No response from the caller for about ${seconds} seconds.]`, false);
  }

  private onCallLimit(): void {
    if (this.ended) return;
    const minutes = Math.round(this.deps.config.call.maxDurationMs / 60_000);
    const note = `[This call has reached its ${minutes}-minute limit. Wrap up politely now: say goodbye and end the call.]`;
    if (!this.agentBusy() && !this.caller) this.startAgentTurn('note', note, false);
    else this.pendingNotes.push(note);
    this.hardStopTimer = setTimeout(() => this.end({ type: 'hangup' }, 'call time limit'), CALL_LIMIT_GRACE_MS).unref();
  }

  private onSttFatal(err: Error): void {
    if (this.ended) return;
    this.log.error(`Speech recognition failed: ${err.message}`);
    const transferTo = this.deps.config.agent.transferNumber;
    if (transferTo) this.speakAndEnd(PHRASES.cantHearTransfer, { type: 'transfer', to: transferTo }, 'speech recognition unavailable');
    else this.speakAndEnd(PHRASES.cantHear, { type: 'hangup' }, 'speech recognition unavailable');
  }

  /**
   * For models with unreliable tool calls: if the call ended without a saved
   * message, check the transcript for a callback or booking request.
   */
  private async reviewForFollowUp(): Promise<void> {
    const { brain, messages } = this.deps;
    if (!brain.findFollowUp || this.messageTaken || !this.record.transcript.some((e) => e.role === 'caller')) return;
    const transcript = this.record.transcript
      .filter((e) => e.role === 'caller' || e.role === 'agent')
      .map((e) => `${e.role === 'caller' ? 'Caller' : 'Assistant'}: ${e.text}`)
      .join('\n');
    try {
      const followUp = await brain.findFollowUp(transcript, this.info.from);
      if (!followUp) return;
      await messages.save({ callSid: this.info.callSid, callerId: this.info.from, ...followUp, source: 'after-call review' });
      this.log.info(`Saved a follow-up found in the transcript: ${followUp.callerName} (${followUp.callbackNumber}): ${followUp.message}`);
    } catch (err) {
      this.log.warn('After-call review failed', err);
    }
  }

  /** Ends the call; the phone line hangs up or transfers according to `action`. */
  end(action: EndAction, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearSilenceTimer();
    clearTimeout(this.limitTimer);
    clearInterval(this.warmTimer);
    clearInterval(this.modelWarmTimer);
    clearTimeout(this.hardStopTimer);
    clearTimeout(this.dtmfTimer);
    this.turn?.cancel();
    this.stt?.close();
    this.record.endReason = reason;
    this.log.info(`Call ended: ${reason}${action.type === 'transfer' ? ` (transferring to ${action.to})` : ''}`);
    this.deps.onEnd?.(action, this);
    this.transport.close(action.type === 'transfer' ? `transfer:${action.to}` : `hangup:${reason}`);
    if (action.type === 'hangup') void this.reviewForFollowUp();
    saveCallRecord(this.deps.config.dataDir, this.record, this.history.snapshot())
      .then((file) => this.log.info(`Saved call record: ${file}`))
      .catch((err: unknown) => this.log.error('Could not save the call record', err));
  }
}
