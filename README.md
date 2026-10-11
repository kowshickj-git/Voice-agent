# Voice Agent: an AI receptionist that answers phone calls

A phone agent that picks up calls on your Twilio number and holds a natural conversation: it answers questions from your knowledge base, takes messages, transfers callers to a person, and hangs up politely. A browser "test phone" lets you talk to it before you connect a real number.

**It can run for free:** the AI model runs on your own computer with [Ollama](https://ollama.com), and speech uses Deepgram's free sign-up credit. For the best conversation quality, switch the model to Claude with one setting.

**How a call flows**

```
Caller ─ phone network ─ Twilio ─ WebSocket (8 kHz audio) ─┐
                                                            ▼
                         ┌───────────── this server ─────────────┐
   caller's voice ─────► │ Deepgram Flux     speech → text       │
                         │                   + turn detection    │
                         │ Local model       decides what to say │
                         │ (or Claude)       and which tools     │
   agent's voice ◄────── │ Deepgram Aura or  text → speech       │
                         │ ElevenLabs        (streamed)          │
                         └───────────────────────────────────────┘
```

## What makes it feel natural

- **Fast replies.** Speech recognition, the model, and text-to-speech all stream. The agent starts speaking as soon as the first sentence is ready, starts preparing a reply *while you're finishing your sentence* (Flux's early end-of-turn signal; that draft only plays if you really stopped talking), and opens the connection to the voice service the moment a reply starts, which saves about half a second per reply on long network routes.
- **Real turn-taking.** It waits until you've finished (a model-based end-of-turn detector, not just silence), and you can **interrupt it mid-sentence**: it stops instantly and knows exactly how much you heard.
- **Ignores "mm-hmm".** Acknowledgements like "okay", "uh-huh", and "right" don't cut the agent off.
- **Phone manners.** It reads back names and numbers, asks one question at a time, checks in when you go quiet, and says goodbye before hanging up.
- **Keypad input.** Digits pressed on the phone reach the agent (e.g. "press 1").
- **Transfers with a safety net.** If nobody answers a transfer, the caller comes back to the agent, which offers to take a message.
- **Messages.** Callback requests are saved as JSON files and can be posted to Slack, Zapier, Make, or any webhook.
- **Call records.** Every call's transcript, timings, and token usage are saved to `data/calls/`.
- **Secure by default.** Twilio webhook signatures are verified, and media streams need a one-time token, so nobody else can use your API keys through the server.

## Quick start: free, in your browser

You need **Node.js 20.6 or newer**, **[Ollama](https://ollama.com)** (free; runs the AI model on your computer, fastest with an NVIDIA GPU of 6 GB or more), and one free key:

| Key | Used for | Cost |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Speech recognition and the voice | Free sign-up credit, no card: https://console.deepgram.com |

```bash
ollama pull qwen3:4b-instruct   # the local model, 2.5 GB, one time
npm install
# Put DEEPGRAM_API_KEY in .env (a copy of .env.example is already there)
npm run doctor                  # checks Ollama, the model, and your key
npm start
```

Open **http://localhost:8080**, click **Start call**, and allow the microphone. Use headphones, so the agent doesn't hear itself through your speakers. Audio is downsampled to 8 kHz phone quality, so it sounds like a real call.

## What it costs

| Part | Free option | Limits |
| --- | --- | --- |
| The AI that talks | Local model in Ollama (`qwen3:4b-instruct`) | Free forever, no account. Needs a decent GPU for fast replies |
| Speech recognition and voice | Deepgram's sign-up credit | No card needed; enough for many thousands of call minutes, then pay as you go |
| Browser test phone | Built in | Free, unlimited |
| A real phone number | Twilio free trial | 75 voice minutes over 30 days, and only numbers you've verified can call it. After that, a monthly number fee plus per-minute charges |
| Public address for Twilio | Cloudflare quick tunnel or ngrok's free plan | Free |

Everything can be free except a permanent phone number: phone networks charge for numbers and minutes. Check each provider's pricing page for current numbers.

## How fast is it?

Measured with real speech on a laptop with a 6 GB RTX 3050 in India, using `qwen3:4b-instruct` and Deepgram:

| Step | Time |
| --- | --- |
| Deepgram Flux decides the caller has finished | 0.15–0.4 s after they stop |
| Local model writes its first words | 0.1–0.4 s |
| Deepgram voice returns the first audio | 0.33–0.45 s (over a warm connection) |
| **Caller stops talking → agent starts speaking** | **about 0.9 s on typical turns** |

What keeps it fast: connections to the voice service are kept warm for the whole call (opening a new one costs about 1 s from India), the agent starts speaking at the first comma ("Sure, ..."), the local model is loaded at startup and kept in memory, Ollama reuses its cache of the conversation between turns, and replies are prepared while the caller finishes their sentence.

During a call, the local model also gets a tiny request every 1.5 seconds while the caller talks or listens. A laptop GPU left idle for 20 seconds took 1.3 s to answer its next request; kept busy, it answers in about 0.05 s. On the Sunbridger agent this cut the reply start from 1.2–2.2 s to about 0.6–1 s.

For the lowest latency, keep the laptop plugged in and set Windows to the *Best performance* power mode: on battery the GPU is power-limited and slower. On a server, put it close to Deepgram and Twilio, in the US.

## Connect a real phone number (Twilio)

1. **Get a Twilio number** with voice capability (Twilio Console → Phone Numbers → Buy a number). Some countries require address or business verification first.
2. **Give your server a public HTTPS address.** For local testing, run a tunnel in a second terminal:
   ```bash
   ngrok http 8080
   # or, without an account: cloudflared tunnel --url http://localhost:8080
   ```
   Copy the `https://…` address it prints.
3. **Edit `.env`:**
   ```ini
   PUBLIC_URL=https://your-address.ngrok-free.app
   TWILIO_AUTH_TOKEN=your-auth-token   # Twilio Console → Account info
   ```
   Then restart with `npm start`.
4. **Point the number at the agent:** Twilio Console → Phone Numbers → Active numbers → your number → *Voice configuration* → **A call comes in**: Webhook, `https://your-address/twilio/voice`, **HTTP POST**. Save.
5. **Call your number.**

If your tunnel's address changes after a restart, update `PUBLIC_URL` and the Twilio webhook (ngrok's free plan includes one fixed domain you can use instead).

## Make it yours

| What | Where |
| --- | --- |
| The agent's role and rules ("you're the receptionist for…") | `agent/instructions.md` |
| Facts it can share: hours, prices, address, FAQ | `agent/knowledge.md` |
| Name, company, greeting, time zone, transfer number | `.env` |
| Voice and language | `.env` (see below) |

Edits to `agent/*.md` take effect on the **next call**, with no restart needed. The agent only states facts that are in these files; for anything else it offers to take a message, so make the knowledge base complete. The included files describe a fictional dental clinic as an example; replace them with your own business.

**Transfers:** set `TRANSFER_NUMBER=+14155550123` (E.164 format) and the agent gains a `transfer_call` tool. Without it, the agent offers to take a message instead.

**Messages to Slack or email:** set `MESSAGE_WEBHOOK_URL` to a Slack incoming webhook, or a Zapier or Make hook that forwards email. Each message is also saved in `data/messages/`.

**Voices:** `DEEPGRAM_VOICE` picks a Deepgram Aura-2 voice: `aura-2-thalia-en` (default), `aura-2-andromeda-en`, `aura-2-helena-en`, `aura-2-arcas-en` (male), `aura-2-orpheus-en` (male), and others. For more voices and languages, use ElevenLabs:

```ini
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...          # from the ElevenLabs voice library
ELEVENLABS_MODEL=eleven_flash_v2_5
```

**Other languages:** speech recognition supports English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, and Dutch. For example, Hindi with Hindi–English mixing:

```ini
STT_MODEL=flux-general-multi
STT_LANGUAGE_HINTS=hi,en
AGENT_LANGUAGE=auto              # reply in the caller's language
TTS_PROVIDER=elevenlabs          # Deepgram's voices don't speak Hindi
GREETING=Namaste, ... (your greeting)
```

Also translate the few fixed fallback lines (`PHRASES` at the top of `src/call/CallSession.ts`) used when a service is down.

**Better recognition of names:** list product names, people, and places in `STT_KEYTERMS`, for example `STT_KEYTERMS=Sunrise Dental,Okafor,Invisalign`. Use single words or names; in testing, phrases like "Sungrow inverter" made recognition worse than "Sungrow" alone.

## Run more than one agent

Each extra agent lives in its own folder under `agents/`, with its own settings, role, knowledge base, port, and records, and shares the keys and model settings in `.env`. This project includes a second agent: **Ava, the phone assistant for Sunbridger**, Sungrow's distributor and channel partner for Tamil Nadu. It answers questions about Sungrow (the company, its inverters, batteries, battery energy storage systems such as PowerTitan, technologies such as AFCI and grid-forming, and the 2026 launches) and about solar in India and Tamil Nadu (sizing, TNPDCL net metering, the central and state subsidies, ALMM rules, maintenance, batteries), helps callers choose a model, and takes quote and service requests.

```bash
npm run start:sungrow      # http://localhost:8081 (the dental agent stays on 8080)
npm run doctor:sungrow     # check its settings and services
```

| File | What it holds |
| --- | --- |
| `agents/sungrow/agent.env` | Name, company, greeting, port 8081, voice (`aura-2-thalia-en`), keyterms, `AGENT_EXPERTISE` |
| `agents/sungrow/instructions.md` | Its role: Sunbridger's assistant, how to recommend models and take requests |
| `agents/sungrow/knowledge.md` | The facts every call needs: Sunbridger, Sungrow, how to choose, home inverter and battery specs, subsidy summary, the complete model list |
| `agents/sungrow/library.md` | The knowledge library: 44 deeper sections (storage, technologies, business and plant inverters, solar basics, Tamil Nadu rules) looked up per question |

- **Add Sunbridger's own details** (address, phone, hours, services) under "About Sunbridger" in `knowledge.md`. Until then the agent says it doesn't have them and offers a callback.
- Settings in `agent.env` win for that agent, and it never takes the main agent's port, name, greeting, prompts, records folder, transfer number, webhook, or keyterms from `.env`. Its records go to `data/sungrow/`.
- To add another agent, copy `agents/sungrow` to `agents/<name>`, edit the three files (give it its own `PORT`), and start it with `npm start -- --agent=<name>`.
- `AGENT_EXPERTISE` lets an agent answer general questions on a subject from the model's own knowledge (here, solar power). Facts about the business and product specs still come only from its knowledge base.
- Model codes are spelled out for the voice: written "SH10RT" is read as "S H one zero R T", so the agent sends "S H 10 R T" and the caller hears "S H ten R T".
- Both agents share one loaded copy of the local model, so keep `LLM_CONTEXT_TOKENS` the same for both (it's in `.env`). The Sungrow prompt is about 6,000 tokens and library notes add more during a call, so this setup uses 16,384. On a 6 GB GPU that only fits with Ollama's 8-bit cache: set the user environment variables `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, then restart Ollama.
- For the most reliable answers to unusual questions, give just this agent Claude: put `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `agents/sungrow/agent.env`.

In testing with the local model, it answered over 60 typical questions about the brand, products, storage, technologies, subsidies, net metering, and sizing correctly. On live test calls, replies started about 0.6–1 s after the caller finished (slower on battery power), and about 3–4 s on turns where it saved a message. It still sometimes guesses yes-or-no answers about Sunbridger itself (for example "Are you open on Sunday?") until those details are in the knowledge base.

### Knowledge library: more facts than fit in a prompt

Any agent can have a `library.md` next to its `knowledge.md` (or set `AGENT_LIBRARY_FILE`). For each thing the caller says, the server finds the one or two best-matching library sections and adds them to the conversation as reference notes, so the model sees exactly the facts for that question. That keeps the always-on prompt small, which makes a small local model faster and more accurate, and the library can grow as large as you like. Each section is used at most once per call.

```markdown
## PowerTitan 3.0 (utility storage)
Keywords: powertitan, power titan, bess, container, grid storage
- Launched in June 2025. Three container sizes: 3.45, 6.9, and 12.5 MWh.
```

Write one topic per `##` section. The optional `Keywords:` line adds search words: synonyms, local words, and words speech recognition hears instead. Matching joins words split by speech recognition ("power titan") and spelled-out acronyms ("B E S S"), and ignores small talk. Edits apply to the next call. `npm run doctor` shows how many sections were found.

## Choosing the model

**Free and local (the default in `.env`): `LLM_PROVIDER=ollama`.** The agent uses `qwen3:4b-instruct` running in Ollama on your own GPU. In testing on a 6 GB laptop GPU, replies started 0.2–0.5 s after the caller stopped talking. It answered knowledge-base questions correctly, and for anything not in the knowledge base it said it didn't have that information and offered to take a message. Small models are less reliable at taking actions, so for local models the agent adds:

- firmer, simpler instructions at the end of its prompt;
- a goodbye check: when the caller says bye and the agent replies with a farewell, the call ends even if the model forgot to hang up. If the model writes "End call." instead of using the tool, that line isn't spoken and the call ends after the goodbye;
- a product check: if the knowledge base lists product codes and a reply names a code that isn't there (a small model may invent an "SH8.0RS" with made-up specs), the reply is stopped before it's spoken, and the agent says it doesn't have reliable details and offers a callback;
- a name check: `take_message` refuses stand-in names like "caller" and tells the model to ask for the caller's name;
- an after-call review: if the call ends without a saved message, the model re-reads the transcript (with a strict JSON format) and saves a follow-up for any callback or booking request it missed. These messages are marked `"source": "after-call review"`.

The server loads the model at startup and keeps it loaded while it runs. If your GPU has more memory, a bigger model is smarter: `LLM_MODEL=qwen3:8b` (run `ollama pull qwen3:8b` first) needs about 8 GB of VRAM.

**Best quality: `LLM_PROVIDER=anthropic`.** Claude (`claude-opus-5-5` by default, a paid API) follows instructions and uses its tools reliably, and handles unusual requests better than a small local model. Set `ANTHROPIC_API_KEY` and leave `LLM_MODEL` empty. `LLM_EFFORT=low` keeps Claude's thinking short so replies start quickly; raise it to `medium` for complex requests, at the cost of slower replies. For lower cost per call, try `LLM_MODEL=claude-sonnet-5-5` or `claude-haiku-5-5`, and check that quality holds on your own test calls.

With Claude, server-side **refusal fallbacks** are on (`fallbacks: "default"`): if a safety classifier declines a request, another Claude model answers within the same request, so a false positive doesn't stall the call. Set `LLM_FALLBACKS=off` to disable them. The static system prompt and tools are prompt-cached, and the cache is warmed while the greeting plays, so after the first reply each turn mostly re-reads cached tokens.

Run with `LOG_LEVEL=debug` to see per-reply timings and token usage.

## What happens on a call

1. Twilio requests `/twilio/voice`. The server checks the signature and answers with TwiML that opens a media stream carrying a one-time token.
2. The greeting plays. It's synthesized once at startup, so it starts instantly.
3. The caller's audio streams to Deepgram Flux. When Flux thinks they're probably done, the model starts on a reply. When Flux confirms the turn ended, the audio plays. If they kept talking, the draft is discarded.
4. Replies stream sentence by sentence into text-to-speech and out to the call. Twilio "marks" report what has actually played.
5. If the caller talks over the agent, the queued audio is cleared and the next message tells the model exactly what the caller heard. The conversation history is append-only, which keeps prompt caches (and Claude's earlier reasoning) valid.
6. `end_call` or `transfer_call` runs after the goodbye has finished playing. The server closes the stream, and Twilio follows the `<Redirect>` to `/twilio/after-stream` to hang up or `<Dial>` the transfer number.
7. If the caller is silent, the agent checks in (`SILENCE_TIMEOUT_SECONDS`, `MAX_SILENCE_PROMPTS`). Calls are capped at `MAX_CALL_MINUTES`.

## Settings

All settings live in `.env`; `.env.example` documents each one. Values in `.env` take priority over variables set in your shell (empty lines like `KEY=` don't erase a value set elsewhere). An agent started with `--agent=<name>` (or `AGENT_PROFILE=<name>`) also reads `agents/<name>/agent.env`, whose values win for that agent.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | (required) | Speech recognition and the voice |
| `LLM_PROVIDER` | `ollama` in `.env` | `ollama` (free, local) or `anthropic` (Claude) |
| `LLM_MODEL` | `qwen3:4b-instruct` / `claude-opus-5-5` | Model to use; empty picks the provider's default |
| `ANTHROPIC_API_KEY` | (none) | Needed for `LLM_PROVIDER=anthropic` |
| `LLM_EFFORT` | `low` | Claude's thinking effort |
| `OLLAMA_URL`, `LLM_CONTEXT_TOKENS`, `LLM_TEMPERATURE` | `http://localhost:11434`, `8192` (`16384` in this setup), `0.2` | Local model: server address, context window, and randomness (low keeps it factual). The server warns when the prompt leaves too little room for the conversation |
| `TWILIO_AUTH_TOKEN` | (none) | Enables webhook signature checks (set this before going live) |
| `PUBLIC_URL` | detected per request | Your public https address |
| `PORT` | `8080` | HTTP port |
| `AGENT_NAME`, `COMPANY_NAME`, `GREETING` | `Ava`, example clinic | Identity and first words |
| `AGENT_LANGUAGE` | `English` | Language to speak, or `auto` |
| `AGENT_EXPERTISE` | (none) | A subject the agent may also explain from general knowledge, e.g. `solar power`. Unset: only the knowledge base |
| `AGENT_PROFILE` | (none) | Run the agent in `agents/<name>/`; same as `--agent=<name>` |
| `AGENT_LIBRARY_FILE` | `library.md` next to the knowledge base | Knowledge library looked up per question (optional) |
| `TIMEZONE` | server's zone | So the agent knows the local date and time |
| `TRANSFER_NUMBER` | (none) | Enables transfers to a person |
| `MESSAGE_WEBHOOK_URL` | (none) | Where to POST taken messages |
| `STT_MODEL` | `flux-general-en` | `flux-general-multi` for other languages |
| `STT_KEYTERMS`, `STT_CORRECTIONS` | (none) | Words to expect, and known mishearings to fix (`wrong\|other=Right; ...`) |
| `STT_EOT_THRESHOLD` | `0.7` | Higher waits longer before replying |
| `STT_EAGER_EOT_THRESHOLD` | `0.5` | Early reply preparation (empty disables it) |
| `TTS_PROVIDER` | `deepgram` | `deepgram` or `elevenlabs` |
| `SILENCE_TIMEOUT_SECONDS`, `MAX_SILENCE_PROMPTS` | `10`, `2` | Check-ins when the caller goes quiet |
| `MAX_CALL_MINUTES` | `20` | Maximum call length |

## Deploying

Run it on any host that supports long-lived WebSockets over HTTPS: a VPS, Render, Railway, Fly.io, and so on. Set the same variables in the host's environment (including `PUBLIC_URL`), run `npm install && npm start`, and point the Twilio webhook at `https://your-domain/twilio/voice`. One server handles many simultaneous calls. Keep the `data/` folder on persistent storage if you want the records.

## Troubleshooting

- **Run `npm run doctor` first.** It tests each key and service, and names the setting to fix.
- **"Can't reach Ollama".** Start the Ollama app (or run `ollama serve`).
- **"model not found".** Download it: `ollama pull qwen3:4b-instruct`.
- **Ollama fills up drive C:.** Models are large. In the Ollama app, open Settings and set *Model location* to a folder on a drive with space, then download the model again.
- **The first reply after starting is slow.** The model is loading; the server preloads it at startup, so wait for "Local model ... is loaded" in the log.
- **Twilio says "an application error has occurred".** The webhook URL is wrong or the server isn't reachable. Check that `https://your-address/health` loads in a browser.
- **Log shows "invalid Twilio signature".** `TWILIO_AUTH_TOKEN` is wrong, or `PUBLIC_URL` doesn't exactly match the URL in the Twilio console.
- **The agent interrupts itself in the browser test.** Use headphones; the microphone is picking up the speakers.
- **The agent cuts in too early.** Raise `STT_EOT_THRESHOLD` (e.g. `0.8`). If replies feel slow, lower it or lower `LLM_EFFORT`.
- **It mishears names.** Add them to `STT_KEYTERMS`. If a name still comes out wrong the same way, list the wrong versions in `STT_CORRECTIONS`, for example `STT_CORRECTIONS=sunburo|sun grown=Sungrow`, and they're fixed before the agent reads them.
- **Replies got slow after raising `LLM_CONTEXT_TOKENS`.** The model no longer fits on the GPU. Run `ollama ps`: the PROCESSOR column should say `100% GPU`. Turn on Ollama's 8-bit cache (`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0` as user environment variables, then restart Ollama) or lower the context.
- **The first reply is slow after switching between two agents.** Each agent must use the same `LLM_CONTEXT_TOKENS`, or Ollama reloads the model every time the other agent answers.

## Project layout

```
agent/               the main agent's role and knowledge (edit these)
agents/<name>/       extra agents: agent.env, instructions.md, knowledge.md, library.md (agents/sungrow: Sunbridger)
public/              browser test phone (served only to this computer)
src/index.ts         starts the server
src/server.ts        Twilio webhooks, media stream WebSocket, browser test endpoints
src/call/            the call engine: turn-taking, barge-in, playback tracking, speech queue
src/llm/             the model: system prompt, tools, knowledge library, Claude and Ollama clients
src/stt/             Deepgram Flux speech recognition
src/tts/             Deepgram Aura and ElevenLabs voices
src/twilio/          signature checks, TwiML, stream tokens
src/doctor.ts        configuration and API key checker
test/                tests (fake Twilio, Claude, Ollama, and Deepgram; no keys needed)
```

To add a tool (for example, checking appointment availability in your calendar), define it in `src/llm/tools.ts`, handle it in `runTool`, and mention when to use it in `agent/instructions.md`.

## Development

```bash
npm run dev         # restart on code changes
npm test            # 93 tests: turn-taking, barge-in, tools, safety nets, agent profiles, knowledge library, Ollama, the Twilio protocol
npm run typecheck
```
