import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApplicationError } from "../application/application-error.js";
import { identifierInput } from "../application/wager-input.js";
import { ProcessWager } from "../application/process-wager.js";
import { ReadWager } from "../application/read-wager.js";
import { ChallengeAuthGuard } from "./challenge-auth.guard.js";
import { mayReadProvider, requireProvider, type AuthenticatedRequest } from "./authentication.js";

@Controller()
@UseGuards(ChallengeAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWager) private readonly processWager: ProcessWager,
    @Inject(ReadWager) private readonly readWager: ReadWager,
  ) {}

  @Post("wagering/transactions")
  async process(
    @Body() body: unknown,
    @Headers("idempotency-key") key: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
    @Req() request: AuthenticatedRequest,
  ) {
    const providerId = body && typeof body === "object" ? (body as Record<string, unknown>).providerId : undefined;
    requireProvider(request.identity, identifierInput(providerId));
    const result = await this.processWager.execute(body, key);
    response.status(result.status === "PENDING_REFERENCE" ? 202 : result.status === "REJECTED" ? 422 : result.status === "FAILED" ? 500 : 200);
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") id: string, @Req() request: AuthenticatedRequest) {
    const result = await this.readWager.byId(id);
    if (!mayReadProvider(request.identity, result.providerId)) {
      throw new ApplicationError("TRANSACTION_NOT_FOUND", "Transaction was not found");
    }
    return result;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternal(@Param("providerId") provider: string, @Param("externalTransactionId") external: string,
    @Req() request: AuthenticatedRequest) {
    if (!mayReadProvider(request.identity, provider)) {
      throw new ApplicationError("TRANSACTION_NOT_FOUND", "Transaction was not found");
    }
    return this.readWager.byExternal(provider, external);
  }
}
