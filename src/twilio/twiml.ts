function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);
}

function response(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
}

/**
 * Connects the call to our WebSocket as a bidirectional media stream. When
 * the server closes the stream, Twilio continues with the <Redirect>, which
 * asks us what to do next (hang up or transfer).
 */
export function connectStreamTwiml(streamUrl: string, token: string, afterStreamUrl: string): string {
  return response(
    `<Connect><Stream url="${escapeXml(streamUrl)}"><Parameter name="token" value="${escapeXml(token)}"/></Stream></Connect>` +
      `<Redirect method="POST">${escapeXml(afterStreamUrl)}</Redirect>`,
  );
}

export function hangupTwiml(): string {
  return response('<Hangup/>');
}

/** Dials a person; Twilio reports the outcome to `actionUrl`. */
export function dialTwiml(to: string, actionUrl: string, timeoutSeconds = 25): string {
  const target = to.startsWith('sip:') ? `<Sip>${escapeXml(to)}</Sip>` : `<Number>${escapeXml(to)}</Number>`;
  return response(`<Dial action="${escapeXml(actionUrl)}" method="POST" timeout="${timeoutSeconds}">${target}</Dial>`);
}

export function sayAndHangupTwiml(message: string): string {
  return response(`<Say>${escapeXml(message)}</Say><Hangup/>`);
}
