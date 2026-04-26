// src/lib/mailer.js
// Pluggable email transport. Two providers in the box:
//
//   ConsoleMailer  — dev/test. Logs the email to stdout + writes the
//                    last sent message to /tmp/last-reset-email.txt so
//                    scripts can grep the reset link without needing a
//                    real SMTP provider.
//
//   ResendMailer   — production. Activates automatically when RESEND_API_KEY
//                    is set in env. Uses the Resend HTTPS API (no SMTP).
//
// Callers invoke `mailer.send({ to, subject, text, html })` and don't care
// which transport is underneath. Failures throw; the caller decides whether
// that's fatal (forgot-password: we want to know) or best-effort (receipts).
//
// Why build our own abstraction vs. nodemailer? We only send one kind of
// email right now (password reset) and don't want a huge dep tree for that.
// When we start sending other mail we can swap this out.

import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from './logger.js';

// ---- ConsoleMailer -------------------------------------------------------

const LAST_EMAIL_FILE = '/tmp/last-reset-email.txt';

function renderForLog({ to, subject, text, html }) {
  const hr = '-'.repeat(60);
  return [
    hr,
    `To:      ${to}`,
    `Subject: ${subject}`,
    hr,
    text || '(no text part)',
    '',
    html ? '[html part present; length=' + html.length + ']' : '[no html part]',
    hr,
  ].join('\n');
}

class ConsoleMailer {
  constructor({ from }) {
    this.from = from;
  }
  get kind() { return 'console'; }
  async send({ to, subject, text, html }) {
    const rendered = renderForLog({ to, subject, text, html });
    logger.info({ mailer: 'console', from: this.from, to, subject }, 'mailer.send');
    // Print the body at info so dev can copy the reset URL out of the logs.
    logger.info(`\n${rendered}`);
    // Also persist to a file so test scripts don't have to parse logs.
    try {
      await writeFile(LAST_EMAIL_FILE, rendered + '\n', { mode: 0o600 });
    } catch (err) {
      // Non-fatal — the email "succeeded" from the caller's POV because we
      // logged it. Only complain in debug.
      logger.debug({ err }, 'mailer: failed to write last-email file');
    }
  }
}

// ---- ResendMailer --------------------------------------------------------
// Resend has a minimal REST API:
//   POST https://api.resend.com/emails
//   Authorization: Bearer <api-key>
//   { from, to, subject, text, html }
// Docs: https://resend.com/docs/api-reference/emails/send-email

class ResendMailer {
  constructor({ apiKey, from }) {
    this.apiKey = apiKey;
    this.from = from;
  }
  get kind() { return 'resend'; }
  async send({ to, subject, text, html }) {
    const body = { from: this.from, to, subject };
    if (text) body.text = text;
    if (html) body.html = html;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      throw new Error(`resend send failed: HTTP ${r.status}: ${bodyText.slice(0, 200)}`);
    }
    logger.info({ mailer: 'resend', to, subject, status: r.status }, 'mailer.send');
  }
}

// ---- Factory -------------------------------------------------------------

function createMailer() {
  const from = config.mail.from;
  if (config.mail.resendApiKey) {
    logger.info({ from, kind: 'resend' }, 'mailer: using Resend');
    return new ResendMailer({ apiKey: config.mail.resendApiKey, from });
  }
  logger.info({ from, kind: 'console', logFile: LAST_EMAIL_FILE }, 'mailer: using console');
  return new ConsoleMailer({ from });
}

export const mailer = createMailer();
export { LAST_EMAIL_FILE };
