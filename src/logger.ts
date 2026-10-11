export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : 'info';
}

function formatDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (detail instanceof Error) {
    const level = resolveLevel();
    return ' ' + (level === 'debug' && detail.stack ? detail.stack : `${detail.name}: ${detail.message}`);
  }
  if (typeof detail === 'string') return ' ' + detail;
  try {
    return ' ' + JSON.stringify(detail);
  } catch {
    return ' ' + String(detail);
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function createLogger(scope = ''): Logger {
  const level = resolveLevel();
  const prefix = scope ? `[${scope}] ` : '';
  const write = (lvl: LogLevel, message: string, detail?: unknown) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = `${timestamp()} ${lvl.toUpperCase().padEnd(5)} ${prefix}${message}${formatDetail(detail)}`;
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (child) => createLogger(scope ? `${scope}:${child}` : child),
  };
}

/** A logger that discards everything — handy in tests. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
