import { decodeToFloat32, encodeFloat32 } from './mulaw.js';

const PHONE_RATE = 8000;
const $ = (id) => document.getElementById(id);
const els = {
  title: $('title'),
  subtitle: $('subtitle'),
  call: $('call'),
  callLabel: $('call-label'),
  status: $('status'),
  timer: $('timer'),
  transcript: $('transcript'),
  empty: $('empty'),
  micMeter: $('mic-meter'),
  outMeter: $('out-meter'),
};

let call = null;

/** Averages input samples down to a lower rate (a simple anti-aliasing filter). */
class Downsampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.sum = 0;
    this.count = 0;
    this.pos = 0;
  }
  process(input) {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.step) {
        out.push(this.sum / this.count);
        this.sum = 0;
        this.count = 0;
        this.pos -= this.step;
      }
    }
    return Float32Array.from(out);
  }
}

/** Linear interpolation up to a higher rate, continuous across chunks. */
class Upsampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.pos = 0;
    this.prev = 0;
  }
  process(input) {
    const n = input.length;
    const out = new Float32Array(Math.ceil((n - this.pos) / this.step) + 1);
    let k = 0;
    let pos = this.pos;
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      out[k++] = a + (input[i] - a) * frac;
      pos += this.step;
    }
    this.pos = pos - n;
    if (n > 0) this.prev = input[n - 1];
    return out.subarray(0, k).slice();
  }
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function setStatus(text, tone = '') {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function setCallButton(mode) {
  els.call.dataset.mode = mode;
  els.callLabel.textContent = mode === 'idle' ? 'Start call' : mode === 'connecting' ? 'Connecting…' : 'Hang up';
  els.call.disabled = mode === 'connecting';
}

// ── Transcript ──────────────────────────────────────────────────────────────

let partialBubble = null;
let agentBubble = null;

function addBubble(role, text) {
  els.empty.hidden = true;
  const row = document.createElement('div');
  row.className = `row ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  els.transcript.appendChild(row);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return bubble;
}

function addNote(text) {
  const note = addBubble('note', text);
  agentBubble = null;
  return note;
}

function onDebug(msg) {
  switch (msg.type) {
    case 'caller_partial':
      if (!partialBubble) partialBubble = addBubble('caller partial', msg.text);
      else partialBubble.textContent = msg.text;
      break;
    case 'caller':
      if (partialBubble) {
        partialBubble.textContent = msg.text;
        partialBubble.parentElement.classList.remove('partial');
      } else {
        addBubble('caller', msg.text);
      }
      partialBubble = null;
      agentBubble = null;
      break;
    case 'agent':
      if (partialBubble && partialBubble.parentElement.classList.contains('partial')) {
        // A caller "partial" that never became a turn (e.g. "mm-hmm" while the agent talked).
        partialBubble.parentElement.remove();
        partialBubble = null;
      }
      if (!agentBubble) agentBubble = addBubble('agent', msg.text);
      else agentBubble.textContent += ` ${msg.text}`;
      els.transcript.scrollTop = els.transcript.scrollHeight;
      break;
    case 'interrupted':
      if (agentBubble) agentBubble.parentElement.classList.add('interrupted');
      agentBubble = null;
      break;
    case 'latency':
      if (agentBubble) agentBubble.dataset.latency = `${msg.ms} ms`;
      break;
    case 'tool':
      addNote(`Tool: ${msg.name} ${JSON.stringify(msg.input)}`);
      break;
  }
}

// ── Call ────────────────────────────────────────────────────────────────────

async function startCall() {
  setCallButton('connecting');
  setStatus('Asking for microphone access…');
  // Create the audio context during the click, so autoplay rules don't suspend it.
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    await ctx.close().catch(() => {});
    setCallButton('idle');
    setStatus(`Microphone unavailable: ${err.message}`, 'error');
    return;
  }

  await ctx.resume().catch(() => {});
  await ctx.audioWorklet.addModule('audio-processor.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'phone-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  source.connect(node);
  node.connect(ctx.destination);

  setStatus('Connecting to the agent…');
  let session;
  try {
    const res = await fetch('/web/session', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    session = await res.json();
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    setCallButton('idle');
    setStatus(`Could not start a call: ${err.message}`, 'error');
    return;
  }

  const { callSid, streamSid, token } = session;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`);
  const down = new Downsampler(ctx.sampleRate, PHONE_RATE);
  const up = new Upsampler(PHONE_RATE, ctx.sampleRate);
  const startedAt = performance.now();
  let chunk = 0;

  call = { ws, ctx, stream, node, callSid, streamSid, timer: null, closing: false };
  els.transcript.querySelectorAll('.row').forEach((row) => row.remove());
  els.empty.hidden = false;
  partialBubble = null;
  agentBubble = null;

  ws.onopen = () => {
    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    ws.send(
      JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid,
        start: {
          streamSid,
          callSid,
          accountSid: 'browser',
          tracks: ['inbound'],
          customParameters: { token },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: PHONE_RATE, channels: 1 },
        },
      }),
    );
    setCallButton('active');
    setStatus('Connected — say something!', 'live');
    call.timer = setInterval(() => {
      const s = Math.floor((performance.now() - startedAt) / 1000);
      els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  };

  node.port.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'mic') {
      const samples = down.process(msg.samples);
      if (samples.length === 0 || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { track: 'inbound', chunk: String(++chunk), timestamp: String(Math.round(performance.now() - startedAt)), payload: toBase64(encodeFloat32(samples)) },
        }),
      );
    } else if (msg.type === 'mark') {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: msg.name } }));
    } else if (msg.type === 'level') {
      els.micMeter.style.setProperty('--level', Math.min(1, msg.mic * 2.5).toFixed(2));
      els.outMeter.style.setProperty('--level', Math.min(1, msg.out * 2.5).toFixed(2));
    }
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.event === 'media') {
      const samples = up.process(decodeToFloat32(fromBase64(msg.media.payload)));
      node.port.postMessage({ type: 'play', samples }, [samples.buffer]);
    } else if (msg.event === 'mark') {
      node.port.postMessage({ type: 'mark', name: msg.mark.name });
    } else if (msg.event === 'clear') {
      node.port.postMessage({ type: 'clear' });
    } else if (msg.event === 'debug') {
      onDebug(msg);
    }
  };

  ws.onclose = (event) => finishCall(event.reason);
  ws.onerror = () => setStatus('Connection error', 'error');
}

function describeEnd(reason) {
  if (!reason) return 'Call ended.';
  if (reason.startsWith('transfer:')) return `The agent transferred the call to ${reason.slice(9)}. (On a real call, the caller would be connected now.)`;
  if (reason.startsWith('hangup:')) {
    const why = reason.slice(7);
    return why === 'caller hung up' ? 'Call ended.' : `The agent ended the call (${why}).`;
  }
  if (reason === 'unauthorized') return 'The server rejected the call. Reload the page and try again.';
  return `Call ended (${reason}).`;
}

function finishCall(reason) {
  if (!call) return;
  const { ws, ctx, stream, timer } = call;
  call = null;
  clearInterval(timer);
  // Let the last words play before closing the audio.
  setTimeout(() => {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  }, 1500);
  if (ws.readyState === WebSocket.OPEN) ws.close();
  els.micMeter.style.setProperty('--level', '0');
  els.outMeter.style.setProperty('--level', '0');
  setCallButton('idle');
  setStatus(describeEnd(reason), reason && reason.startsWith('transfer:') ? 'live' : '');
}

function hangUp() {
  if (!call) return;
  const { ws, streamSid, callSid } = call;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: 'stop', streamSid, stop: { callSid } }));
  }
  finishCall('hangup:caller hung up');
}

els.call.addEventListener('click', () => {
  if (els.call.dataset.mode === 'active') hangUp();
  else if (els.call.dataset.mode === 'idle') startCall().catch((err) => {
    setCallButton('idle');
    setStatus(`Could not start the call: ${err.message}`, 'error');
  });
});

fetch('/web/info')
  .then((res) => res.json())
  .then((info) => {
    els.title.textContent = `${info.agentName} · ${info.company}`;
    els.subtitle.textContent = `${info.model} · ${info.stt} · ${info.voice}`;
    document.title = `Call ${info.agentName}`;
  })
  .catch(() => {});
