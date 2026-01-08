// ============================================
// Error Handling Utilities
// ============================================

/**
 * Custom error classes for better error handling
 */

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    // captureStackTrace is only available in Node.js, not in all environments
    if ('captureStackTrace' in Error && typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, this.constructor);
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, public errors: string[] = []) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, public originalError?: Error) {
    super(message, 500);
    this.name = 'DatabaseError';
  }
}

export class ExternalAPIError extends AppError {
  constructor(
    message: string,
    public service: string,
    public originalError?: Error
  ) {
    super(message, 502);
    this.name = 'ExternalAPIError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Error response formatter
 */
export function formatErrorResponse(error: Error) {
  // If it's our custom error, use its properties
  if (error instanceof AppError) {
    return {
      success: false,
      error: error.message,
      statusCode: error.statusCode,
      details: error instanceof ValidationError ? error.errors : undefined,
    };
  }

  // For unknown errors, return generic message
  console.error('Unhandled error:', error);
  return {
    success: false,
    error: 'An unexpected error occurred',
    statusCode: 500,
  };
}

/**
 * Async error wrapper for route handlers
 * Catches errors and formats response automatically
 */
export function asyncHandler(
  handler: (request: Request, env: any, ctx: any) => Promise<Response>
) {
  return async (request: Request, env: any, ctx: any): Promise<Response> => {
    try {
      return await handler(request, env, ctx);
    } catch (error) {
      const errorResponse = formatErrorResponse(error as Error);
      
      return new Response(JSON.stringify(errorResponse), {
        status: errorResponse.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
    shouldRetry?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 100,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    shouldRetry = () => true,
  } = options;

  let lastError: Error;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry this error
      if (!shouldRetry(lastError)) {
        throw lastError;
      }

      // If this was the last attempt, throw
      if (attempt === maxAttempts) {
        throw lastError;
      }

      // Log retry attempt
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`, {
        error: lastError.message,
      });

      // Wait before retrying
      await sleep(delay);

      // Increase delay for next attempt (exponential backoff)
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError!;
}

/**
 * Sleep utility
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe JSON parse that returns null on error
 */
export function safeJsonParse<T = any>(str: string): T | null {
  try {
    return JSON.parse(str);
  } catch (error) {
    console.error('Failed to parse JSON:', error);
    return null;
  }
}

/**
 * Log error with context
 */
export function logError(
  error: Error,
  context: {
    operation?: string;
    userId?: string;
    additionalInfo?: Record<string, any>;
  } = {}
) {
  console.error('Error occurred:', {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...context,
  });
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: Error): boolean {
  // Network errors are usually retryable
  if (error.message.includes('fetch failed')) return true;
  if (error.message.includes('timeout')) return true;
  if (error.message.includes('network')) return true;

  // Server errors (5xx) are retryable
  if (error instanceof ExternalAPIError) {
    return true;
  }

  // Database connection errors are retryable
  if (error instanceof DatabaseError) {
    return error.message.includes('connection') || error.message.includes('timeout');
  }

  // Client errors (4xx) are usually not retryable
  return false;
}

/**
 * Create a timeout promise
 */
export function createTimeoutPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new AppError(timeoutMessage, 408)), timeoutMs)
    ),
  ]);
}

/**
 * Safely execute async function with error handling
 */
export async function tryCatch<T>(
  operation: () => Promise<T>,
  errorMessage: string = 'Operation failed'
): Promise<[T | null, Error | null]> {
  try {
    const result = await operation();
    return [result, null];
  } catch (error) {
    console.error(errorMessage, error);
    return [null, error as Error];
  }
}
