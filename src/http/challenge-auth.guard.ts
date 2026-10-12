import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AccessTokenVerifier } from "../infrastructure/auth/access-token-verifier.js";
import type { ProviderIdentity } from "./authentication.js";

@Injectable()
export class ChallengeAuthGuard implements CanActivate {
  constructor(@Inject(AccessTokenVerifier) private readonly verifier: AccessTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: unknown }; identity: ProviderIdentity }>();
    request.identity = await this.verifier.verify(request.headers.authorization);
    return true;
  }
}
