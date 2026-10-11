/** Emoji, including skin-tone modifiers, flags, and joined sequences (but not joiners used by other scripts). */
const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})(?:\p{Emoji_Modifier}|️|⃣|‍(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}))*/gu;

/**
 * Turns model output into text that sounds right when spoken: strips Markdown
 * syntax, emojis, and bracketed stage directions such as "[pause]".
 */
export function toSpeakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*•]|\d{1,2}[.)])[ \t]+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*/g, '')
    .replace(EMOJI, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Model and part codes such as "SG5.0RS", "SH10RT", "SG125CX-P2" or "IP66": capitals mixed with digits. */
const PRODUCT_CODE = /\b(?=[A-Z][A-Z0-9.-]*\d)[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*\b/g;

const codeParts = (code: string): string[] => code.match(/[A-Z]+|\d+(?:\.\d+)?/g) ?? [];
/** Runs of five or more capitals are words or acronyms ("COVID-19"), not model codes. */
const isCode = (parts: string[]): boolean => !parts.some((part) => /^[A-Z]{5,}$/.test(part));

/** The model and part codes in a text, as written ("SG5.0RS", "IP66"). */
export function productCodes(text: string): string[] {
  return (text.match(PRODUCT_CODE) ?? []).filter((code) => isCode(codeParts(code)));
}

/**
 * Spaces out the letters of product codes for the voice: read as written,
 * "SH10RT" comes out as "S H one zero R T", but "S H 10 R T" is read as
 * "S H ten R T".
 */
export function spellOutCodes(text: string): string {
  return text.replace(PRODUCT_CODE, (code) => {
    const parts = codeParts(code);
    if (!isCode(parts)) return code;
    return parts.map((part) => (/^[A-Z]/.test(part) ? part.split('').join(' ') : part)).join(' ');
  });
}

/** A sentence that only names the hang-up ("End call."), which small models sometimes write instead of calling end_call. */
const SPOKEN_END_CALL = /^\s*[*_(]*\s*(?:end(?:s|ing)?(?: the)? call|end_call|hang(?:s|ing)? up(?: the call)?|call ended)\s*[*_).!]*\s*$/i;

/** True when a chunk of the reply is just the model naming the hang-up rather than saying something. */
export function isSpokenEndCall(text: string): boolean {
  return SPOKEN_END_CALL.test(text);
}

const CALLER_FAREWELL =
  /\b(good ?bye|bye(-bye)?|nothing else|that['’]?s (everything|it for (now|today))|that is (everything|it for (now|today))|that['’]?s all[,.!]?\s*thank(s| you)|that is all[,.!]?\s*thank(s| you)|thanks?,? (good ?)?bye|that['’]?s all i need(ed)?)\b/i;
const AGENT_FAREWELL = /\b(good ?bye|bye)\b|\bhave an? (good|great|nice|wonderful|lovely) (day|night|evening|weekend|afternoon|one)\b/i;

/**
 * True when the caller is signing off and the agent has answered with a
 * farewell — the call is over even if the model forgot to hang up.
 */
/** A whole utterance that just closes the conversation: "That's all.", "No, that's it." */
const CALLER_CLOSING = /^\s*(ok(ay)?[,.]?\s*|no[,.]?\s*)*that['’]?s (all|it)[.!]?\s*$/i;

export function isMutualFarewell(callerText: string, agentText: string): boolean {
  return (CALLER_FAREWELL.test(callerText) || CALLER_CLOSING.test(callerText)) && AGENT_FAREWELL.test(agentText);
}

const BACKCHANNELS = new Set([
  'mm-hmm', 'mmhmm', 'mhm', 'mm', 'mmm', 'hmm', 'hm', 'uh-huh', 'uhhuh', 'uh', 'um', 'umm', 'uhm', 'er', 'ah', 'oh',
  'ok', 'okay', 'k', 'yeah', 'yep', 'yup', 'ya', 'right', 'sure', 'alright', 'all', 'got', 'it', 'i', 'see',
  'cool', 'great', 'nice', 'gotcha', 'wow',
]);

/**
 * True when an utterance is only acknowledgement sounds ("mm-hmm", "okay",
 * "yeah, right") — the kind of thing people say while someone else is talking,
 * which should not interrupt the agent.
 */
export function isBackchannel(transcript: string): boolean {
  const words = transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > 4) return false;
  return words.every((w) => BACKCHANNELS.has(w));
}
