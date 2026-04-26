// src/auth/policy.js
// Password policy checks. Two-layer:
//   1. zxcvbn (local, offline) — estimates entropy and catches "Summer2026!"
//      style weak passwords that pass length-only rules.
//   2. HaveIBeenPwned (network) — k-anonymity lookup: hash with sha1, send the
//      first 5 hex chars to pwnedpasswords.com/range/{prefix}, scan the
//      returned suffix list for ours. If it appears more than
//      HIBP_REJECT_THRESHOLD times across breach corpora, reject.
//
// Both calls run on every signup and change-password. Login is exempt
// because we don't want to punish users whose password was fine when they
// signed up — we trust the stored hash.
//
// Fail-open on HIBP network errors: we log a warning and let the password
// through. Breach lookup is best-effort, not a hard dependency.

import { createHash } from 'node:crypto';
import { zxcvbnAsync, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Configure zxcvbn once at module load. This pulls in English wordlists +
// common-password dictionaries so "ilovemusic2026" gets flagged as weak.
zxcvbnOptions.setOptions({
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnEnPackage.translations,
});

// Bounded user-inputs list: names, emails, etc. — zxcvbn penalizes passwords
// derived from these ("meganStallion2026" for a Megan Stallion signup).
function buildUserInputs({ email, displayName } = {}) {
  const parts = new Set();
  const add = (s) => {
    if (!s) return;
    parts.add(String(s));
    // Also add the local-part of an email so "paul@x.com" contributes "paul".
    const at = String(s).indexOf('@');
    if (at > 0) parts.add(String(s).slice(0, at));
  };
  add(email);
  add(displayName);
  return Array.from(parts);
}

/**
 * Score a password locally. Returns { score, feedback } where score is 0..4.
 * Does not throw — always returns a result.
 */
export async function scorePassword(password, userCtx = {}) {
  const result = await zxcvbnAsync(password, buildUserInputs(userCtx));
  return {
    score: result.score, // 0 (worst) .. 4 (best)
    feedback: result.feedback, // { warning, suggestions[] }
    crackTimeDisplay:
      result.crackTimesDisplay?.offlineSlowHashing1e4PerSecond ?? null,
  };
}

/**
 * Query HaveIBeenPwned range API via k-anonymity. Returns the number of
 * times this password appears across known breaches (0 if not found).
 * On network error returns null (caller should treat as "unknown / allow").
 */
export async function pwnedCount(password) {
  const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }, // padded responses hide the exact prefix length
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'hibp: non-200 from pwnedpasswords');
      return null;
    }
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const [suf, count] = line.split(':');
      if (suf && suf.trim().toUpperCase() === suffix) {
        const n = Number(count);
        return Number.isFinite(n) ? n : 0;
      }
    }
    return 0;
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err) }, 'hibp: network error, failing open');
    return null;
  }
}

/**
 * Full policy check. Returns { ok: true } or { ok: false, code, message }.
 * Called from /signup and /change-password — NOT from /login.
 *
 *   code='weak_password'     — zxcvbn score below threshold
 *   code='pwned_password'    — HIBP count exceeds threshold
 */
export async function checkPasswordPolicy(password, userCtx = {}) {
  const minScore = config.passwordPolicy.zxcvbnMinScore;
  const { score, feedback } = await scorePassword(password, userCtx);
  if (score < minScore) {
    const suggestions = (feedback?.suggestions ?? []).join(' ');
    const warning = feedback?.warning ?? '';
    const msg = [
      `password is too weak (strength ${score}/4, need ${minScore}/4)`,
      warning,
      suggestions,
    ]
      .filter(Boolean)
      .join(' — ');
    return { ok: false, code: 'weak_password', message: msg, score };
  }

  const threshold = config.passwordPolicy.hibpRejectThreshold;
  if (threshold > 0) {
    const count = await pwnedCount(password);
    // count === null → network error → fail open
    if (count !== null && count > threshold) {
      return {
        ok: false,
        code: 'pwned_password',
        message:
          `this password has appeared in ${count.toLocaleString()} known data breaches — ` +
          'please choose a different one. See haveibeenpwned.com/Passwords',
        count,
      };
    }
  }

  return { ok: true, score };
}
