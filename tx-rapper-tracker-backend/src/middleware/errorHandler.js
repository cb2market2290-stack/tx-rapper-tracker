// src/middleware/errorHandler.js
// Central error handler. Never leak stack traces to the client in production.

import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, code, message, cause) {
    super(message);
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.status ?? 500;
  const code = err.code ?? (status >= 500 ? 'internal_error' : 'bad_request');

  // Log everything we know; the PII scrubber in the logger will redact secrets.
  logger.error(
    {
      err,
      reqId: req.id,
      method: req.method,
      path: req.path,
      status,
    },
    err.message
  );

  const body = {
    error: code,
    message: status < 500 ? err.message : 'Something went wrong on our side.',
  };

  // Only expose stack in non-production, for developer ergonomics.
  if (config.env !== 'production' && status >= 500) {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'not_found',
    message: `No route for ${req.method} ${req.path}`,
  });
}
