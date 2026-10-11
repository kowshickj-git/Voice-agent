import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { CallSession, type EndAction, type ResumeState } from './call/CallSession.js';
import { MediaStream, type StreamStart } from './call/MediaStream.js';
import type { AppConfig } from './config.js';
import { createBrain, describeLlm } from './llm/index.js';
import { KnowledgeLibrary } from './llm/library.js';
import { buildSystemPrompt, knownProductCodes } from './llm/prompt.js';
import { buildTools } from './llm/tools.js';
import type { Brain, Tool } from './llm/types.js';
import type { Logger } from './logger.js';
import type { CallRecord, MessageStore } from './records.js';
import { FluxStt } from './stt/FluxStt.js';
import type { SttFactory } from './stt/types.js';
import { voiceKey, type AudioCache } from './tts/index.js';
import type { TextToSpeech } from './tts/types.js';
import { validateTwilioSignature, type WebhookParams } from './twilio/signature.js';
import { StreamTokens } from './twilio/StreamTokens.js';
import { connectStreamTwiml, dialTwiml, hangupTwiml, sayAndHangupTwiml } from './twilio/twiml.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export interface ServerDeps {
  config: AppConfig;
  log: Logger;
  tts: TextToSpeech;
  audioCache: AudioCache;
  messages: MessageStore;
  anthropic?: Anthropic;
  /** Overrides for tests. */
  createBrain?: (systemPrompt: string, tools: Tool[]) => Brain;
  createStt?: SttFactory;
}

/** A map whose entries disappear after a while. */
class ExpiringMap<V> {
  private readonly items = new Map<string, { value: V; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}
  set(key: string, value: V): void {
    const now = Date.now();
    for (const [k, item] of this.items) if (item.expiresAt < now) this.items.delete(k);
    this.items.set(key, { value, expiresAt: now + this.ttlMs });
  }
  take(key: string): V | undefined {
    const item = this.items.get(key);
    this.items.delete(key);
    return item && item.expiresAt >= Date.now() ? item.value : undefined;
  }
}

/** True for requests made on this machine (not forwarded through a tunnel such as ngrok). */
export function isLocalRequest(req: http.IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const h = req.headers;
  const proxied = Boolean(h['x-forwarded-for'] || h['forwarded'] || h['x-real-ip'] || h['cf-connecting-ip'] || h['x-forwarded-host']);
  return loopback && !proxied;
}

export function createServer(deps: ServerDeps) {
  const { config, log } = deps;
  const app = express();
  app.disable('x-powered-by');
  const form = express.urlencoded({ extended: false });
  const tokens = new StreamTokens();
  const endActions = new ExpiringMap<EndAction>(10 * 60_000);
  const transferred = new ExpiringMap<{ messages: ResumeState['messages']; record: CallRecord; from?: string; to?: string }>(10 * 60_000);
  const sessions = new Map<string, CallSession>();

  const baseUrl = (req: Request): string => {
    if (config.publicUrl) return config.publicUrl;
    const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
    const host = (req.get('x-forwarded-host') ?? req.get('host') ?? `localhost:${config.port}`).split(',')[0].trim();
    return `${proto}://${host}`;
  };
  const streamUrl = (req: Request) => `${baseUrl(req).replace(/^http/, 'ws')}/stream`;

  const verifyTwilio = (req: Request, res: Response, next: NextFunction) => {
    if (!config.twilioAuthToken) return next();
    const signature = req.get('x-twilio-signature');
    const url = baseUrl(req) + req.originalUrl;
    if (signature && validateTwilioSignature(config.twilioAuthToken, signature, url, (req.body ?? {}) as WebhookParams)) return next();
    log.warn(`Rejected a webhook with an invalid Twilio signature (${url}). If this is your Twilio number, check TWILIO_AUTH_TOKEN and PUBLIC_URL.`);
    res.status(403).type('text/plain').send('Invalid Twilio signature');
  };

  const localOnly = (req: Request, res: Response, next: NextFunction) => {
    if (isLocalRequest(req)) return next();
    res.status(404).type('text/plain').send('Not found');
  };

  const field = (req: Request, name: string): string | undefined => {
    const value = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' && value ? value : undefined;
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, activeCalls: sessions.size });
  });

  // Twilio: "A call comes in" webhook.
  app.post('/twilio/voice', form, verifyTwilio, (req, res) => {
    const callSid = field(req, 'CallSid');
    if (!callSid) {
      res.status(400).type('text/plain').send('Missing CallSid');
      return;
    }
    const from = field(req, 'From');
    log.info(`Incoming call ${callSid} from ${from ?? 'an unknown number'}`);
    const token = tokens.issue({ callSid, from, to: field(req, 'To'), mode: 'twilio' });
    res.type('text/xml').send(connectStreamTwiml(streamUrl(req), token, `${baseUrl(req)}/twilio/after-stream`));
  });

  // Twilio continues here after we close the media stream: hang up or transfer.
  app.post('/twilio/after-stream', form, verifyTwilio, (req, res) => {
    const callSid = field(req, 'CallSid') ?? '';
    const action = endActions.take(callSid);
    res.type('text/xml');
    if (!action) {
      log.warn(`Call ${callSid} left the agent unexpectedly`);
      res.send(sayAndHangupTwiml("Sorry, something went wrong on our end. Please call back in a few minutes. Goodbye."));
    } else if (action.type === 'transfer') {
      log.info(`Transferring call ${callSid} to ${action.to}`);
      res.send(dialTwiml(action.to, `${baseUrl(req)}/twilio/dial-status`));
    } else {
      res.send(hangupTwiml());
    }
  });

  // Result of a transfer. If nobody answered, the caller goes back to the agent.
  app.post('/twilio/dial-status', form, verifyTwilio, (req, res) => {
    const callSid = field(req, 'CallSid') ?? '';
    const status = field(req, 'DialCallStatus') ?? 'unknown';
    res.type('text/xml');
    if (status === 'completed' || status === 'answered') {
      res.send(hangupTwiml());
      return;
    }
    const state = transferred.take(callSid);
    if (!state) {
      res.send(sayAndHangupTwiml("Sorry, no one is available to take your call right now. Please try again later. Goodbye."));
      return;
    }
    const reason = status === 'busy' ? 'the line was busy' : status === 'no-answer' ? 'nobody answered' : 'the call could not be connected';
    log.info(`Transfer of ${callSid} failed (${status}); returning the caller to the agent`);
    const token = tokens.issue({
      callSid,
      from: state.from,
      to: state.to,
      mode: 'twilio',
      resume: {
        messages: state.messages,
        record: state.record,
        note: `[The transfer didn't go through because ${reason}. The caller is back on the line with you. Let them know, and offer to take a message.]`,
      },
    });
    res.send(connectStreamTwiml(streamUrl(req), token, `${baseUrl(req)}/twilio/after-stream`));
  });

  // Browser test phone (only from this machine).
  app.get('/', (req, res) => {
    if (isLocalRequest(req)) res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    else res.type('text/plain').send('Voice agent is running.');
  });
  app.get('/web/info', localOnly, (_req, res) => {
    res.json({
      agentName: config.agent.name,
      company: config.agent.company,
      model: describeLlm(config.llm),
      stt: config.stt.model,
      voice: voiceKey(config),
      transfer: Boolean(config.agent.transferNumber),
    });
  });
  app.post('/web/session', localOnly, (_req, res) => {
    const callSid = `WEB${crypto.randomBytes(12).toString('hex')}`;
    const token = tokens.issue({ callSid, from: undefined, to: undefined, mode: 'web' });
    res.json({ callSid, streamSid: `MZ${crypto.randomBytes(12).toString('hex')}`, token });
  });
  app.use(localOnly, express.static(PUBLIC_DIR, { index: false }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/stream') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleStream(ws));
  });

  function handleStream(ws: WebSocket): void {
    const media = new MediaStream(ws, log);
    const noStart = setTimeout(() => media.close('no start message'), 15_000);
    media.once('start', (start: StreamStart) => {
      clearTimeout(noStart);
      const grant = tokens.consume(start.customParameters.token, start.callSid);
      if (!grant) {
        log.warn(`Rejected a media stream for ${start.callSid || 'an unknown call'}: missing, invalid, or expired token`);
        media.close('unauthorized');
        return;
      }
      if (grant.mode === 'web') media.enableDebugEvents();
      const callSid = grant.callSid;
      const callLog = log.child(callSid.slice(-6));
      const tools = buildTools({ transferEnabled: Boolean(config.agent.transferNumber) });
      const systemPrompt = buildSystemPrompt(config.agent, config.llm.provider);
      const brain = deps.createBrain
        ? deps.createBrain(systemPrompt, tools)
        : createBrain(config.llm, systemPrompt, tools, deps.anthropic);
      const createStt: SttFactory =
        deps.createStt ?? ((handlers, sttLog) => new FluxStt({ ...config.stt, apiKey: config.deepgramApiKey }, handlers, sttLog));

      const session = new CallSession(
        { callSid, from: grant.from, to: grant.to, mode: grant.mode },
        media,
        {
          config,
          brain,
          tts: deps.tts,
          createStt,
          audioCache: deps.audioCache,
          voiceKey: voiceKey(config),
          messages: deps.messages,
          log: callLog,
          // Small local models invent products and specs; Claude also knows real models the files don't list.
          knownProductCodes: config.llm.provider === 'ollama' ? knownProductCodes(config.agent) : undefined,
          library: KnowledgeLibrary.load(config.agent.libraryFile),
          onEnd: (action, ended) => {
            endActions.set(callSid, action);
            if (action.type === 'transfer') {
              transferred.set(callSid, { messages: ended.messages, record: ended.record, from: grant.from, to: grant.to });
            }
          },
        },
        grant.resume,
      );
      sessions.set(callSid, session);
      media.on('media', (chunk: Buffer) => session.onAudio(chunk));
      media.on('mark', (name: string) => session.onMark(name));
      media.on('dtmf', (digit: string) => session.onDtmf(digit));
      media.on('stop', () => session.onStreamClosed());
      media.on('close', () => {
        session.onStreamClosed();
        if (sessions.get(callSid) === session) sessions.delete(callSid);
      });
      callLog.info(`Call connected (${grant.mode === 'web' ? 'browser test' : `from ${grant.from ?? 'unknown'}`})`);
      session.start();
    });
  }

  /** Ends all calls and stops the server. */
  async function shutdown(): Promise<void> {
    const active = [...sessions.values()];
    for (const session of active) session.end({ type: 'hangup' }, 'server shutting down');
    // Give Twilio a moment to fetch the hang-up instructions.
    if (active.length > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const client of wss.clients) client.terminate();
    wss.close();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  return { app, server, shutdown };
}
