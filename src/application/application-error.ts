export class ApplicationError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "UNSUPPORTED_CURRENCY" | "WALLET_ALREADY_EXISTS" | "WALLET_NOT_FOUND"
      | "IDEMPOTENCY_CONFLICT" | "EXTERNAL_TRANSACTION_CONFLICT" | "TRANSACTION_NOT_FOUND"
      | "INBOX_PAYLOAD_CONFLICT" | "INVALID_MESSAGE_GROUP",
    message: string,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
