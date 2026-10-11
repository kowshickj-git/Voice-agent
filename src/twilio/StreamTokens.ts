import crypto from 'node:crypto';
import type { ResumeState } from '../call/CallSession.js';

export interface StreamGrant {
  callSid: string;
  from?: string;
  to?: string;
  mode: 'twilio' | 'web';
  /** Set when the caller comes back to the agent after an unanswered transfer. */
  resume?: ResumeState;
}

/**
 * One-time tokens that authorize a media stream. The (signature-checked)
 * Twilio webhook issues one per call and passes it to the stream as a
 * <Parameter>, so random clients can't open streams and run up API bills.
 */
export class StreamTokens {
  private readonly grants = new Map<string, StreamGrant & { expiresAt: number }>();

  constructor(private readonly ttlMs = 60_000) {}

  issue(grant: StreamGrant): string {
    this.prune();
    const token = crypto.randomBytes(24).toString('base64url');
    this.grants.set(token, { ...grant, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  /** Returns the grant if the token is valid for this call, and invalidates it. */
  consume(token: string | undefined, callSid: string): StreamGrant | null {
    if (!token) return null;
    const grant = this.grants.get(token);
    this.grants.delete(token);
    if (!grant || grant.expiresAt < Date.now() || grant.callSid !== callSid) return null;
    const { expiresAt: _, ...rest } = grant;
    return rest;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt < now) this.grants.delete(token);
  }
}
