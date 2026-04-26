// src/lib/logger.js
// Pino logger with a PII scrubber. Use this for everything — never console.log.
// The scrubber redacts common sensitive fields BEFORE they get serialized.

import pino from 'pino';
import { config } from '../config.js';

// Regex heuristics to mask secrets that slip through as free text.
const PATTERNS = [
  // Obvious API key patterns. Keep the first 4 chars so we can eyeball which key.
  { re: /\b(AIza[0-9A-Za-z_-]{20,})\b/g, repl: (_, m) => `${m.slice(0, 4)}…redacted` }, // Google
  { re: /\bsk_(live|test)_[0-9A-Za-z]{20,}\b/g, repl: 'sk_…redacted' }, // Stripe
  { re: /\bBearer\s+[A-Za-z0-9._-]+\b/g, repl: 'Bearer …redacted' },
  // Anything that looks like an email. Keep domain for debuggability.
  {
    re: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    repl: (_, first, domain) => `${first}***@${domain}`,
  },
];

function scrubString(s) {
  let out = s;
  for (const { re, repl } of PATTERNS) out = out.replace(re, repl);
  return out;
}

export const logger = pino({
  level: config.logLevel,
  base: { service: 'tx-rapper-tracker-backend' },
  redact: {
    paths: [
      // Obvious secret-bearing fields — never let these through.
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      'password',
      'token',
      'apiKey',
      'api_key',
      'youtubeApiKey',
    ],
    remove: true,
  },
  formatters: {
    log(obj) {
      // Second line of defense: walk string values and run regex scrubbers.
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') obj[k] = scrubString(v);
      }
      return obj;
    },
  },
  // JSON logs everywhere. If you want pretty output locally, install
  // pino-pretty as a devDependency and pipe:  npm start | npx pino-pretty
});

export function childLogger(bindings) {
  return logger.child(bindings);
}
