import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * Turns Prisma errors into sensible HTTP responses.
 *
 * Without this, a unique-constraint violation or a deadlock reaches the client
 * as a bare 500 "Internal server error" — which tells the user nothing, tells
 * the frontend nothing it can act on, and (worse) can echo table and column
 * names back to whoever is poking at the API.
 *
 * The deadlock case is the interesting one: it is genuinely transient, so the
 * honest answer is 409 with "try again", not 500. A client can retry a 409.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError,
    host: ArgumentsHost,
  ) {
    const response = host.switchToHttp().getResponse<Response>();

    // Postgres SQLSTATE 40P01 (deadlock) and 40001 (serialization failure)
    // arrive wrapped in a Prisma error rather than as a distinct code.
    const message = exception.message ?? '';
    if (message.includes('40P01') || message.includes('deadlock detected')) {
      this.logger.warn(`Deadlock — asking the client to retry: ${message.split('\n')[0]}`);
      return response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'That request collided with another one. Please try again.',
        retryable: true,
      });
    }
    if (message.includes('40001')) {
      return response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'Too much happening at once. Please try again.',
        retryable: true,
      });
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return response.status(HttpStatus.CONFLICT).json({
            statusCode: HttpStatus.CONFLICT,
            error: 'Conflict',
            message: 'That already exists.',
          });
        case 'P2025':
          return response.status(HttpStatus.NOT_FOUND).json({
            statusCode: HttpStatus.NOT_FOUND,
            error: 'Not Found',
            message: 'Record not found.',
          });
        case 'P2003':
          return response.status(HttpStatus.BAD_REQUEST).json({
            statusCode: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'That references something which does not exist.',
          });
        case 'P2034':
          return response.status(HttpStatus.CONFLICT).json({
            statusCode: HttpStatus.CONFLICT,
            error: 'Conflict',
            message: 'Write conflict. Please try again.',
            retryable: true,
          });
      }
    }

    // Anything unrecognised: log it in full for us, say nothing specific to
    // the client. Database internals are not the caller's business.
    this.logger.error(`Unhandled Prisma error: ${message}`);
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Something went wrong.',
    });
  }
}
