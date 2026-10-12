export interface AuthConfiguration {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwksUrl: URL;
}

export function authConfiguration(environment: Record<string, string | undefined> = process.env): AuthConfiguration {
  const enabled = environment.AUTH_ENABLED ?? "true";
  if (!["true", "false"].includes(enabled)) throw new Error("AUTH_ENABLED must be true or false");
  if (enabled === "false" && environment.NODE_ENV !== "test") {
    throw new Error("Authentication can only be disabled for isolated tests with NODE_ENV=test");
  }
  const issuer = environment.AUTH_ISSUER ?? "http://127.0.0.1:58080/realms/wagering";
  const issuerUrl = new URL(issuer);
  if (!/^https?:$/.test(issuerUrl.protocol) || issuerUrl.username || issuerUrl.password
    || issuerUrl.search || issuerUrl.hash || issuer.endsWith("/")) {
    throw new Error("AUTH_ISSUER must be an HTTP(S) issuer URL without credentials, query, fragment or trailing slash");
  }
  const audience = environment.AUTH_AUDIENCE ?? "wagering-api";
  if (!audience.trim()) throw new Error("AUTH_AUDIENCE must not be empty");
  const jwksUrl = new URL(environment.AUTH_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`);
  if (!/^https?:$/.test(jwksUrl.protocol) || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
    throw new Error("AUTH_JWKS_URL must be an HTTP(S) URL without credentials or fragment");
  }
  return { enabled: enabled === "true", issuer, audience, jwksUrl };
}
