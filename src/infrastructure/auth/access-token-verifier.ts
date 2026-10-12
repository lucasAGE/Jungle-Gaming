import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AuthenticationError, type ProviderIdentity } from "../../http/authentication.js";
import { authConfiguration, type AuthConfiguration } from "./auth-configuration.js";

@Injectable()
export class AccessTokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly configuration: AuthConfiguration = authConfiguration(), keys?: JWTVerifyGetKey) {
    this.keys = keys ?? createRemoteJWKSet(configuration.jwksUrl, { timeoutDuration: 3_000 });
  }

  async verify(header: unknown): Promise<ProviderIdentity> {
    if (!this.configuration.enabled) return { subject: "isolated-test", operator: true, providerId: null, bypass: true };
    if (typeof header !== "string" || !/^Bearer [^\s]+$/i.test(header) || header.length > 16_384) {
      throw new AuthenticationError("AUTHENTICATION_REQUIRED", 401);
    }
    try {
      const { payload } = await jwtVerify(header.slice(7), this.keys, {
        issuer: this.configuration.issuer, audience: this.configuration.audience,
        algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
      });
      // Keycloak access tokens carry Bearer; ID and refresh tokens are not API credentials.
      if (payload.typ !== "Bearer" || typeof payload.sub !== "string" || !payload.sub) {
        throw new AuthenticationError("INVALID_ACCESS_TOKEN", 401);
      }
      const resource = payload.resource_access as Record<string, unknown> | undefined;
      const access = resource?.[this.configuration.audience] as { roles?: unknown } | undefined;
      const roles = Array.isArray(access?.roles) ? access.roles.filter((role): role is string => typeof role === "string") : [];
      const providerId = roles.includes("provider") && typeof payload.provider_id === "string"
        && /^[!-~]{1,255}(?![\s\S])/.test(payload.provider_id) ? payload.provider_id : null;
      return { subject: payload.sub, operator: roles.includes("operator"), providerId, bypass: false };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof errors.JOSEError
        && !["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"].includes(error.code)) {
        throw new AuthenticationError("INVALID_ACCESS_TOKEN", 401);
      }
      throw new AuthenticationError("IDENTITY_PROVIDER_UNAVAILABLE", 503);
    }
  }
}
