import { describe, expect, test } from "bun:test";
import { AccessTokenVerifier } from "../../src/infrastructure/auth/access-token-verifier.js";
import { authConfiguration } from "../../src/infrastructure/auth/auth-configuration.js";
import { requireOperator, requireProvider } from "../../src/http/authentication.js";
import { presenterTokens } from "./keycloak-login.js";

const integration = process.env.RUN_AUTH_INTEGRATION === "1" ? describe : describe.skip;
integration("presenter authorization code flow with real Keycloak and PKCE", () => {
  test("the public client receives a verifiable subject and both authorized presentation roles", async () => {
    const issuer = "http://127.0.0.1:58081/realms/wagering";
    const tokens = await presenterTokens(issuer);
    const verifier = new AccessTokenVerifier(authConfiguration({ AUTH_ISSUER: issuer }));
    const identity = await verifier.verify(`Bearer ${tokens.access_token}`);
    expect(identity.subject).not.toBe("");
    expect(identity.bypass).toBe(false);
    expect(identity.operator).toBe(true);
    expect(identity.providerId).toBe("provider-a");
    expect(() => requireOperator(identity)).not.toThrow();
    expect(() => requireProvider(identity, "provider-a")).not.toThrow();
    expect(() => requireProvider(identity, "provider-b")).toThrow();
    await expect(verifier.verify(`Bearer ${tokens.id_token}`)).rejects.toMatchObject({ code: "INVALID_ACCESS_TOKEN" });

    const refresh = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "demo-ui", refresh_token: tokens.refresh_token }),
      signal: AbortSignal.timeout(10_000) });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as { access_token: string };
    expect(await verifier.verify(`Bearer ${refreshed.access_token}`)).toEqual(identity);
  });
});
