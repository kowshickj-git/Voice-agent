import type { Logger } from '../logger.js';
import type { MessageStore } from '../records.js';
import { estimateSolar, parseAmount, type Connection, type Site, type YesNo } from './solarEstimate.js';
import type { Tool, ToolResultBlockParam, ToolUseBlock } from './types.js';

export const END_CALL = 'end_call';
export const TRANSFER_CALL = 'transfer_call';
export const TAKE_MESSAGE = 'take_message';
export const SOLAR_ESTIMATE = 'solar_estimate';

/** Tools that end the call's conversation with the agent; they run after the agent finishes speaking. */
export const CALL_CONTROL_TOOLS = new Set([END_CALL, TRANSFER_CALL]);

const URGENCY = ['low', 'normal', 'high'] as const;
const CONNECTIONS = ['single_phase', 'three_phase', 'unknown'] as const;
const YES_NO = ['yes', 'no', 'unknown'] as const;
const SITES = ['home', 'business', 'unknown'] as const;

interface FieldSpec {
  description: string;
  enum?: readonly string[];
  /** Used when the model leaves this field out or gives an invalid value (small local models sometimes do). */
  fallback?: string;
}

function tool(name: string, description: string, fields: Record<string, FieldSpec>): Tool {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    properties[key] = { type: 'string', description: spec.description, ...(spec.enum ? { enum: [...spec.enum] } : {}) };
  }
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties,
      required: Object.keys(fields),
      additionalProperties: false,
    },
    strict: true,
    // Requests are streamed: inputs arrive unbuffered, so they're validated here before running.
    eager_input_streaming: true,
  };
}

const TOOL_FIELDS: Record<string, Record<string, FieldSpec>> = {
  [END_CALL]: {
    reason: { description: "Short reason for ending the call, for the call log (e.g. \"caller's question answered\").", fallback: 'not given' },
  },
  [TRANSFER_CALL]: {
    reason: { description: 'Why the caller is being transferred, for the call log.', fallback: 'not given' },
  },
  [TAKE_MESSAGE]: {
    caller_name: { description: "The caller's name, as they gave it." },
    callback_number: {
      description:
        'Best number to call the caller back on, as digits (with country code if they gave one). Use the caller ID from the call details if they say to use the number they are calling from.',
    },
    message: { description: 'The message for the team, written clearly and completely so a staff member can act on it.' },
    urgency: { description: 'How urgent the request is.', enum: URGENCY, fallback: 'normal' },
  },
  [SOLAR_ESTIMATE]: {
    monthly_units: {
      description:
        'Average electricity units (kWh) the caller uses per month, as a number, or "unknown". Tamil Nadu bills cover two months: halve a two-month figure.',
      fallback: 'unknown',
    },
    system_kw: { description: 'The panel size in kW the caller has in mind, as a number, or "unknown".', fallback: 'unknown' },
    connection: { description: "The caller's electricity connection.", enum: CONNECTIONS, fallback: 'unknown' },
    backup: { description: 'Whether they want battery backup during power cuts.', enum: YES_NO, fallback: 'unknown' },
    site: { description: 'A home, or a business such as a shop, office, school, or factory.', enum: SITES, fallback: 'unknown' },
    backup_load_watts: {
      description: 'Total watts of what must run during a power cut (e.g. fans, lights, fridge, TV), as a number, or "unknown".',
      fallback: 'unknown',
    },
    backup_hours: { description: 'Hours of backup they want, as a number, or "unknown".', fallback: 'unknown' },
  },
};

/** The agent's tools, sorted by name so the request prefix (and prompt cache) is stable. */
export function buildTools({ transferEnabled, solarEstimator = false }: { transferEnabled: boolean; solarEstimator?: boolean }): Tool[] {
  const tools: Tool[] = [
    tool(
      END_CALL,
      'Hang up the phone call. Use it when the conversation is finished: the caller said goodbye, their request is handled, or they asked to end the call. In the same reply, say a short goodbye first; the line disconnects right after your goodbye finishes playing.',
      TOOL_FIELDS[END_CALL],
    ),
    tool(
      TAKE_MESSAGE,
      "Save a message or callback request for the team. Use it when the caller wants to leave a message, asks to be called back, wants to book, change, or cancel an appointment, or needs something you can't resolve yourself. First collect their name, the best callback number, and what they need, and confirm those details with them.",
      TOOL_FIELDS[TAKE_MESSAGE],
    ),
  ];
  if (solarEstimator) {
    tools.push(
      tool(
        SOLAR_ESTIMATE,
        'Work out a rooftop solar estimate: system size in kW, daily, monthly, and yearly generation, number of panels and roof area, the matching Sungrow inverter and battery models, and the home subsidy. Use it whenever a caller asks what size system they need, how much it will generate, how many panels, how big a battery, or which model suits them, once you know their monthly units or the kW they want. Fill in what you know and "unknown" for the rest. Never do this arithmetic yourself. Then explain the result in one or two short spoken sentences, and never turn it into a price.',
        TOOL_FIELDS[SOLAR_ESTIMATE],
      ),
    );
  }
  if (transferEnabled) {
    tools.push(
      tool(
        TRANSFER_CALL,
        "Transfer the caller to a person on the team. Use it when the caller asks for a person, or when they need help you can't give. In the same reply, first tell them you're connecting them (for example, \"Sure, let me connect you with someone from our team. One moment.\"); the transfer starts right after that finishes playing.",
        TOOL_FIELDS[TRANSFER_CALL],
      ),
    );
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Checks a tool input against the tool's schema. Streamed (eager) tool inputs
 * are not validated by the API, so this runs before every tool call. Minor
 * fields fall back to a default; essential ones must be present. Unknown
 * fields are ignored.
 */
export function validateToolInput(name: string, input: unknown): Record<string, string> | null {
  const fields = TOOL_FIELDS[name];
  if (!fields || typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const raw = record[key];
    const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    const valid = value !== '' && (!spec.enum || spec.enum.includes(value));
    if (valid) out[key] = value;
    else if (spec.fallback !== undefined) out[key] = spec.fallback;
    else return null;
  }
  return out;
}

export function invalidInputResult(use: ToolUseBlock): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: use.id,
    is_error: true,
    content: JSON.stringify({ INVALID_JSON: JSON.stringify(use.input) }),
  };
}

/** Stand-ins small models write in caller_name instead of asking the caller ("caller", "unknown"). */
const PLACEHOLDER_NAME = /^(the )?(caller|customer|client|user|unknown|anonymous|n\/?a|none|null|name|placeholder|tbd|-+|\?+)$/i;

export interface ToolContext {
  callSid: string;
  callerId?: string;
  messages: MessageStore;
  log: Logger;
}

/** Runs a tool that answers immediately (everything except the call-control tools). */
export async function runTool(use: ToolUseBlock, ctx: ToolContext): Promise<ToolResultBlockParam> {
  const input = validateToolInput(use.name, use.input);
  if (!input) return invalidInputResult(use);
  switch (use.name) {
    case TAKE_MESSAGE: {
      if (PLACEHOLDER_NAME.test(input.caller_name)) {
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content:
            "Not saved: caller_name isn't a real name. Ask the caller for their name and confirm their callback number, then call take_message again. If they don't want to give a name, use \"name not given\".",
        };
      }
      try {
        await ctx.messages.save({
          callSid: ctx.callSid,
          callerId: ctx.callerId,
          callerName: input.caller_name,
          callbackNumber: input.callback_number,
          message: input.message,
          urgency: input.urgency,
        });
        ctx.log.info(`Message taken from ${input.caller_name} (${input.callback_number}): ${input.message}`);
        return { type: 'tool_result', tool_use_id: use.id, content: 'Message saved. The team will see it and follow up.' };
      } catch (err) {
        ctx.log.error('Saving a message failed', err);
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'The message could not be saved because of a technical problem.' };
      }
    }
    case SOLAR_ESTIMATE: {
      const content = estimateSolar({
        monthlyUnits: parseAmount(input.monthly_units),
        systemKw: parseAmount(input.system_kw),
        connection: input.connection as Connection,
        backup: input.backup as YesNo,
        site: input.site as Site,
        backupLoadWatts: parseAmount(input.backup_load_watts),
        backupHours: parseAmount(input.backup_hours),
      });
      return { type: 'tool_result', tool_use_id: use.id, content };
    }
    default:
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool: ${use.name}` };
  }
}
