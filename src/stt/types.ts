import type { Logger } from '../logger.js';

export type TurnEventType = 'StartOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';

/** A caller turn-state update from the speech recognizer. */
export interface TurnEvent {
  type: TurnEventType;
  turnIndex: number;
  transcript: string;
  endOfTurnConfidence: number;
}

export interface SttHandlers {
  onTurn(event: TurnEvent): void;
  /** The recognizer is gone for good (bad API key, repeated connection failures). */
  onFatal(error: Error): void;
}

export interface SpeechToText {
  /** Connects to the recognizer. Audio sent before it resolves is buffered. */
  start(): Promise<void>;
  /** Raw 8 kHz μ-law audio from the caller. */
  sendAudio(chunk: Buffer): void;
  close(): void;
}

export type SttFactory = (handlers: SttHandlers, log: Logger) => SpeechToText;
