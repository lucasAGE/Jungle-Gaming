import { ApplicationError } from "./application-error.js";
import { uuidInput } from "./input-validation.js";
import { identifierInput } from "./wager-input.js";
import type { StoredWager, WageringStore } from "./wagering-store.js";

export class ReadWager {
  constructor(private readonly store: WageringStore) {}

  async byId(id: unknown) {
    return this.response(await this.store.findById(uuidInput(id)));
  }

  async byExternal(providerId: unknown, externalId: unknown) {
    return this.response(await this.store.findByExternal(identifierInput(providerId), identifierInput(externalId)));
  }

  private response(wager: StoredWager | null) {
    if (!wager) throw new ApplicationError("TRANSACTION_NOT_FOUND", "Transaction was not found");
    const { idempotencyKey: _key, payloadHash: _hash, ...fields } = wager;
    return {
      ...fields, money: wager.money.toJSON(), balance: wager.balance.toJSON(),
      createdAt: wager.createdAt.toISOString(), processedAt: wager.processedAt?.toISOString() ?? null,
      ...(wager.nextReferenceAttemptAt ? { nextReferenceAttemptAt: wager.nextReferenceAttemptAt.toISOString() } : {}),
    };
  }
}
