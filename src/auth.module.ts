import { Module } from "@nestjs/common";
import { ChallengeAuthGuard } from "./http/challenge-auth.guard.js";
import { AccessTokenVerifier } from "./infrastructure/auth/access-token-verifier.js";

@Module({
  providers: [{ provide: AccessTokenVerifier, useFactory: () => new AccessTokenVerifier() }, ChallengeAuthGuard],
  exports: [AccessTokenVerifier, ChallengeAuthGuard],
})
export class AuthModule {}
