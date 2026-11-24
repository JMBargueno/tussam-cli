export class TussamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TussamError';
  }
}

export class TussamApiError extends TussamError {
  readonly statusCode?: number;
  readonly url?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, statusCode?: number, url?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TussamApiError';
    this.statusCode = statusCode;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export class TussamValidationError extends TussamError {
  constructor(message: string) {
    super(message);
    this.name = 'TussamValidationError';
  }
}
