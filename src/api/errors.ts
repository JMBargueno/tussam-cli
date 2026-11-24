export class TussamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TussamError';
  }
}

export class TussamApiError extends TussamError {
  readonly statusCode?: number;
  readonly url?: string;

  constructor(message: string, statusCode?: number, url?: string) {
    super(message);
    this.name = 'TussamApiError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

export class TussamValidationError extends TussamError {
  constructor(message: string) {
    super(message);
    this.name = 'TussamValidationError';
  }
}
