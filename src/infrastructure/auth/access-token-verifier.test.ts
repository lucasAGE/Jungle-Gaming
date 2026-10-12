import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { AccessTokenVerifier } from "./access-token-verifier.js";
import { authConfiguration } from "./auth-configuration.js";
import { mayReadProvider, requireOperator, requireProvider } from "../../http/authentication.js";

const configuration = authConfiguration();
let privateKey: CryptoKey;
let publicKey: CryptoKey;
let verifier: AccessTokenVerifier;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256"));
  verifier = new AccessTokenVerifier(configuration, async () => publicKey);
});

async function token(overrides: JWTPayload = {}, key = privateKey) {
  return new SignJWT({ typ: "Bearer", provider_id: "provider-a",
    resource_access: { "wagering-api": { roles: ["provider"] } }, ...overrides })
    .setProtectedHeader({ alg: "RS256" }).setSubject("provider-service")
    .setIssuer(configuration.issuer).setAudience(configuration.audience)
    .setIssuedAt().setExpirationTime("5m").sign(key);
}

describe("external access tokens and HTTP permissions", () => {
  test("authentication is on by default and can only be bypassed explicitly in isolated tests", () => {
    expect(authConfiguration({}).enabled).toBe(true);
    expect(authConfiguration({ AUTH_ENABLED: "false", NODE_ENV: "test" }).enabled).toBe(false);
    expect(() => authConfiguration({ AUTH_ENABLED: "false" })).toThrow();
    expect(() => authConfiguration({ AUTH_ENABLED: "sometimes" })).toThrow();
    expect(() => authConfiguration({ AUTH_AUDIENCE: "" })).toThrow();
    expect(() => authConfiguration({ AUTH_ISSUER: "http://user:password@localhost/realm" })).toThrow();
  });

  test("verifies the signature and binds the provider independently of operator permissions", async () => {
    const identity = await verifier.verify(`Bearer ${await token()}`);
    expect(identity).toEqual({ subject: "provider-service", operator: false, providerId: "provider-a", bypass: false });
    expect(() => requireProvider(identity, "provider-a")).not.toThrow();
    expect(() => requireProvider(identity, "provider-b")).toThrow();
    expect(() => requireOperator(identity)).toThrow();
    expect(mayReadProvider(identity, "provider-a")).toBe(true);
    expect(mayReadProvider(identity, "provider-b")).toBe(false);
  });

  test("operator access does not impersonate providers while a presenter can hold both roles", async () => {
    const operator = await verifier.verify(`Bearer ${await token({ resource_access: { "wagering-api": { roles: ["operator"] } } })}`);
    expect(() => requireOperator(operator)).not.toThrow();
    expect(mayReadProvider(operator, "provider-b")).toBe(true);
    expect(() => requireProvider(operator, "provider-a")).toThrow();
    const presenter = await verifier.verify(`Bearer ${await token({ resource_access: { "wagering-api": { roles: ["operator", "provider"] } } })}`);
    expect(() => requireProvider(presenter, "provider-a")).not.toThrow();
    expect(() => requireOperator(presenter)).not.toThrow();
  });

  test("missing, malformed and oversized authorization headers are rejected", async () => {
    for (const header of [undefined, "", "Basic abc", "Bearer a b", `Bearer ${"a".repeat(16_384)}`]) {
      await expect(verifier.verify(header)).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    }
  });

  test("rejects forged signatures, expired tokens, wrong issuer and wrong audience", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await token({}, other.privateKey);
    const now = Math.floor(Date.now() / 1_000);
    const signed = async (claims: JWTPayload) => new SignJWT({ typ: "Bearer", sub: "subject", iat: now,
      exp: now + 300, iss: configuration.issuer, aud: configuration.audience, ...claims })
      .setProtectedHeader({ alg: "RS256" }).sign(privateKey);
    for (const invalid of [forged, await signed({ exp: now - 10 }), await signed({ iss: "https://other.invalid" }),
      await signed({ aud: "other-service" }), await signed({ typ: "ID" }),
      await new SignJWT({ sub: "subject", iat: now, iss: configuration.issuer, aud: configuration.audience })
        .setProtectedHeader({ alg: "RS256" }).sign(privateKey)]) {
      await expect(verifier.verify(`Bearer ${invalid}`)).rejects.toMatchObject({ code: "INVALID_ACCESS_TOKEN" });
    }
  });

  test("a claim without the provider role grants no provider permission", async () => {
    const identity = await verifier.verify(`Bearer ${await token({ resource_access: null })}`);
    expect(identity.providerId).toBeNull();
    expect(identity.operator).toBe(false);
  });

  test("does not accept symmetric tokens or bypass signature verification for supplied roles", async () => {
    const forged = await new SignJWT({ typ: "Bearer", resource_access: { "wagering-api": { roles: ["operator"] } } })
      .setProtectedHeader({ alg: "HS256" }).setSubject("forged").setIssuer(configuration.issuer)
      .setAudience(configuration.audience).setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode("a local attacker does not know the signing private key"));
    await expect(verifier.verify(`Bearer ${forged}`)).rejects.toMatchObject({ code: "INVALID_ACCESS_TOKEN" });
  });

  test("key discovery outages are distinct from an invalid credential", async () => {
    const unavailable = new AccessTokenVerifier(configuration, async () => { throw new TypeError("fetch failed with private network details"); });
    await expect(unavailable.verify(`Bearer ${await token()}`)).rejects.toMatchObject({ code: "IDENTITY_PROVIDER_UNAVAILABLE" });
  });
});
