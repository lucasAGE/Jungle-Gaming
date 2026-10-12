import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ApiErrorFilter } from "./http/api-error.filter.js";
import { correlationMiddleware } from "./http/correlation.middleware.js";
import { StructuredLogger } from "./infrastructure/observability/structured-logger.js";
import { initializeTracing } from "./infrastructure/observability/tracing.js";

initializeTracing();
const logger = new StructuredLogger();
const app = await NestFactory.create(AppModule, { logger });
app.use(correlationMiddleware);
app.useGlobalFilters(new ApiErrorFilter());
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? "3000"), "127.0.0.1");
const address = app.getHttpServer().address() as { port: number };
logger.log({ event: "application_listening", port: address.port });
