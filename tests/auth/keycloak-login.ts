import { createHash, randomBytes } from "node:crypto";

export async function presenterTokens(issuer: string): Promise<{ access_token: string; refresh_token: string; id_token: string }> {
  const redirectUri = "http://127.0.0.1:3100/demo";
  const verifier = randomBytes(32).toString("base64url");
  const state = crypto.randomUUID();
  const authorization = new URL(`${issuer}/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({ client_id: "demo-ui", redirect_uri: redirectUri,
    response_type: "code", scope: "openid", state, nonce: crypto.randomUUID(),
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  const page = await fetch(authorization, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (page.status !== 200) throw new Error(`Expected the Keycloak login form, received HTTP ${page.status}`);
  const html = await page.text();
  const action = /<form[^>]*\bid="kc-form-login"[^>]*\baction="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  if (!action || new URL(action).origin !== new URL(issuer).origin) throw new Error("Expected the trusted Keycloak login form action");
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  const login = await fetch(action, { method: "POST", redirect: "manual", headers: { Cookie: cookies },
    body: new URLSearchParams({ username: "presenter", password: "presenter_local", credentialId: "" }),
    signal: AbortSignal.timeout(10_000) });
  const location = login.headers.get("location");
  if (login.status !== 302 || !location) throw new Error(`Expected the authorization code callback, received HTTP ${login.status}`);
  const callback = new URL(location);
  if (`${callback.origin}${callback.pathname}` !== redirectUri || callback.searchParams.get("state") !== state) {
    throw new Error("The Keycloak callback did not match the requested redirect and state");
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("The Keycloak callback did not include an authorization code");
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: "demo-ui", code,
      redirect_uri: redirectUri, code_verifier: verifier }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The PKCE code exchange failed with HTTP ${response.status}`);
  return response.json() as Promise<{ access_token: string; refresh_token: string; id_token: string }>;
}
