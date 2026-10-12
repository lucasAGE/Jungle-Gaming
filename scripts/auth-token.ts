import { authConfiguration } from "../src/infrastructure/auth/auth-configuration.js";

const clientId = process.argv[2] ?? "provider-a";
const localClients = ["wallet-operator", "provider-a", "provider-b"];
if (!localClients.includes(clientId)) throw new Error(`Choose one of: ${localClients.join(", ")}`);
const { issuer } = authConfiguration();
const local = new URL(issuer).hostname === "127.0.0.1";
const secret = process.env.AUTH_CLIENT_SECRET ?? (local ? `${clientId}_local` : undefined);
if (!secret) throw new Error("Set AUTH_CLIENT_SECRET for an external identity provider");
const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`The identity provider rejected the token request with HTTP ${response.status}`);
const result = await response.json() as { access_token?: unknown };
if (typeof result.access_token !== "string") throw new Error("The identity provider did not return an access token");
console.log(result.access_token);
