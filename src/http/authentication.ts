import { HttpException } from "@nestjs/common";

export interface ProviderIdentity {
  subject: string;
  operator: boolean;
  providerId: string | null;
  bypass: boolean;
}

export interface AuthenticatedRequest { identity: ProviderIdentity }

export class AuthenticationError extends HttpException {
  constructor(public readonly code: string, status: 401 | 403 | 503) {
    super({ code, message: status === 401 ? "A valid access token is required"
      : status === 403 ? "This identity cannot access the requested operation"
      : "The identity provider could not be reached" }, status);
  }
}

export function requireOperator(identity: ProviderIdentity): void {
  if (!identity.bypass && !identity.operator) throw new AuthenticationError("FORBIDDEN", 403);
}

export function requireProvider(identity: ProviderIdentity, providerId: unknown): void {
  if (!identity.bypass && (!identity.providerId || identity.providerId !== providerId)) {
    throw new AuthenticationError("PROVIDER_FORBIDDEN", 403);
  }
}

export function mayReadProvider(identity: ProviderIdentity, providerId: string | null): boolean {
  return identity.bypass || identity.operator || providerId !== null && identity.providerId === providerId;
}
