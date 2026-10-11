import crypto from 'node:crypto';

export type WebhookParams = Record<string, string | string[] | undefined>;

/**
 * Twilio's X-Twilio-Signature: base64 HMAC-SHA1 (keyed by the auth token) of
 * the full webhook URL followed by every POST parameter as name+value, sorted by name.
 */
export function computeTwilioSignature(authToken: string, url: string, params: WebhookParams): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of [...value].sort()) data += key + item;
    } else {
      data += key + value;
    }
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/** The URL as given, plus the same URL with the default port added or removed (Twilio may sign either). */
function urlVariants(url: string): string[] {
  const match = /^(https?):\/\/([^/:?#]+)(:\d+)?(.*)$/i.exec(url);
  if (!match) return [url];
  const [, scheme, host, port, rest] = match;
  const defaultPort = scheme.toLowerCase() === 'https' ? ':443' : ':80';
  if (!port) return [url, `${scheme}://${host}${defaultPort}${rest}`];
  if (port === defaultPort) return [url, `${scheme}://${host}${rest}`];
  return [url];
}

export function validateTwilioSignature(authToken: string, signature: string, url: string, params: WebhookParams): boolean {
  const given = Buffer.from(signature);
  return urlVariants(url).some((candidate) => {
    const expected = Buffer.from(computeTwilioSignature(authToken, candidate, params));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}
