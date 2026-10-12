import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { OpenWallet } from "../application/open-wallet.js";
import { ReadWallet, walletResponse } from "../application/read-wallet.js";
import { ReconcileWallet } from "../application/reconcile-wallet.js";
import { ChallengeAuthGuard } from "./challenge-auth.guard.js";
import { requireOperator, type AuthenticatedRequest } from "./authentication.js";

@Controller("wallets")
@UseGuards(ChallengeAuthGuard)
export class WalletController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(ReadWallet) private readonly readWallet: ReadWallet,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  async open(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    requireOperator(request.identity);
    return walletResponse(await this.openWallet.execute(body));
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string, @Req() request: AuthenticatedRequest) {
    requireOperator(request.identity);
    return walletResponse(await this.readWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query() query: unknown, @Req() request: AuthenticatedRequest) {
    requireOperator(request.identity);
    return this.readWallet.ledger(walletId, query);
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string, @Req() request: AuthenticatedRequest) {
    requireOperator(request.identity);
    return this.reconcileWallet.execute(walletId);
  }

  @Get(":walletId/journal")
  async journal(@Param("walletId") walletId: string, @Query() query: unknown, @Req() request: AuthenticatedRequest) {
    requireOperator(request.identity);
    return this.readWallet.accounting(walletId, query);
  }
}
