import { ApplicationError } from "./application-error.js";
import { invalidInput, objectInput, uuidInput } from "./input-validation.js";
import { identifierInput, idempotencyKeyInput } from "./wager-input.js";

export function sqsWagerInput(body: string, messageGroupId: string | undefined) {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; }
  catch { return invalidInput("Expected a JSON message body"); }
  const envelope = objectInput(parsed, ["messageId", "type", "occurredAt", "data"]);
  const messageId = identifierInput(envelope.messageId);
  if (envelope.type !== "WagerTransactionRequested") return invalidInput("Unsupported message type");
  const occurredAt = envelope.occurredAt;
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))
    || new Date(occurredAt).toISOString() !== occurredAt) {
    return invalidInput("occurredAt must be an ISO UTC timestamp with milliseconds");
  }
  const data = objectInput(envelope.data, [
    "providerId", "externalTransactionId", "idempotencyKey", "playerId", "walletId", "roundId", "gameId", "kind", "money", "referenceExternalTransactionId",
  ]);
  const { idempotencyKey, ...request } = data;
  const walletId = uuidInput(request.walletId);
  if (messageGroupId !== walletId) {
    throw new ApplicationError("INVALID_MESSAGE_GROUP", "MessageGroupId must match the canonical wallet UUID");
  }
  // The financial use case performs the same business validation used for HTTP.
  return { messageId, body: request, idempotencyKey: idempotencyKeyInput(idempotencyKey), walletId };
}
