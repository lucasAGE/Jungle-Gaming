import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ApplicationError } from "../application/application-error.js";
import { ProcessingError } from "../application/processing-error.js";
import { MoneyError } from "../domain/money.js";
import { isDatabaseError, isTransientDatabaseError } from "../infrastructure/database/database-errors.js";
import { StructuredLogger } from "../infrastructure/observability/structured-logger.js";
import { AuthenticationError } from "./authentication.js";

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: { code: string; message: string }): void;
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new StructuredLogger();

  catch(error: unknown, host: ArgumentsHost): void {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "An unexpected error occurred";
    if (error instanceof ApplicationError) {
      status = ["WALLET_ALREADY_EXISTS", "IDEMPOTENCY_CONFLICT", "EXTERNAL_TRANSACTION_CONFLICT"].includes(error.code)
        ? 409 : ["WALLET_NOT_FOUND", "TRANSACTION_NOT_FOUND"].includes(error.code) ? 404 : 400;
      ({ code, message } = error);
    } else if (error instanceof MoneyError) {
      status = 400;
      ({ code, message } = error);
    } else if (error instanceof AuthenticationError) {
      status = error.getStatus();
      code = error.code;
      message = (error.getResponse() as { message: string }).message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 400 ? "INVALID_INPUT" : "HTTP_ERROR";
      message = error.message;
    } else if (error instanceof ProcessingError || isDatabaseError(error)) {
      const retryable = error instanceof ProcessingError ? error.retryable : isTransientDatabaseError(error);
      status = retryable ? 503 : 500;
      code = error instanceof ProcessingError ? error.code : retryable ? "DATABASE_UNAVAILABLE" : "DATABASE_OPERATION_FAILED";
      message = "The database operation could not be completed";
    }
    if (status >= 500) {
      // Driver messages can contain SQL parameters, including complete financial payloads.
      this.logger.error({ event: "request_failed", code });
    }
    host.switchToHttp().getResponse<HttpResponse>().status(status).json({ code, message });
  }
}
