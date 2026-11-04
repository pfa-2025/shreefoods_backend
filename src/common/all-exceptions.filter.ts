import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';

function isHttpError(e: unknown): e is { status?: number; statusCode?: number; type?: string } {
  const x = e as { status?: unknown; statusCode?: unknown } | null;
  const code = typeof x?.status === 'number' ? x.status : typeof x?.statusCode === 'number' ? x.statusCode : 0;
  return code >= 400 && code < 500 && e instanceof Error;
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
  path: string;
  timestamp: string;
  /** Quote this when reporting a problem; it matches the server log line. */
  requestId?: string;
}

/** One consistent error shape; never leaks stack traces or internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Validation failed';
      details = exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const b = body as { message?: string | string[]; details?: unknown };
        message = b.message?.toString() ?? exception.message;
        details = b.details;
      }
      // Nest wraps body-parser's SyntaxError; its wording ("Unexpected token } in JSON at position 12") is parser internals.
      const cause = (exception as { cause?: { type?: string } }).cause;
      if (status === 400 && (cause?.type === 'entity.parse.failed' || /JSON/.test(message) && /Unexpected|position|end of/.test(message))) message = 'Malformed JSON';
    } else if (isHttpError(exception)) {
      // Errors raised by Express middleware (body too large, malformed JSON) are not Nest exceptions.
      status = exception.status ?? exception.statusCode ?? 400;
      message = exception.type === 'entity.too.large' ? 'Request body too large' : exception.type === 'entity.parse.failed' ? 'Malformed JSON' : 'Bad request';
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        message = 'A record with those values already exists';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found';
      }
    }

    if (status >= 500) {
      this.logger.error(`[${(req as Request & { id?: string }).id ?? '-'}] ${req.method} ${req.url}`, exception instanceof Error ? exception.stack : String(exception));
    }

    const payload: ApiError = {
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      details,
      path: req.url,
      timestamp: new Date().toISOString(),
      requestId: (req as Request & { id?: string }).id,
    };
    res.status(status).json(payload);
  }
}
