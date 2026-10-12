import { Decimal } from "decimal.js";

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

type MoneyErrorCode =
  | "INVALID_MONEY_AMOUNT"
  | "INVALID_MONEY_CURRENCY"
  | "MONEY_CURRENCY_MISMATCH"
  | "MONEY_OUT_OF_RANGE";

export class MoneyError extends Error {
  constructor(
    public readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

const MAX_AMOUNT = "999999999999999999.99";
// One extra digit preserves a carry before the numeric(20, 2) range check.
// A private constructor configuration isolates money from other Decimal users.
const MoneyDecimal = Decimal.clone({ defaults: true, precision: 21 });
// The final assertion also rejects trailing line breaks, which `$` would allow.
const AMOUNT_PATTERN = /^(?:0|[1-9][0-9]*)\.[0-9]{2}(?![\s\S])/;
const CURRENCY_PATTERN = /^[A-Z]{3}(?![\s\S])/;

export class Money {
  readonly #value: Decimal;

  private constructor(
    value: Decimal,
    public readonly currency: string,
  ) {
    if (value.abs().greaterThan(MAX_AMOUNT)) {
      throw new MoneyError("MONEY_OUT_OF_RANGE", "Amount exceeds the supported range");
    }

    this.#value = value.isZero() ? new MoneyDecimal("0.00") : value;
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new MoneyError(
        "INVALID_MONEY_AMOUNT",
        "Amount must be a non-negative decimal string with exactly two decimal places and no leading zeroes",
      );
    }

    // Bound input size before Decimal parses it; canonical strings need no normalization.
    if (amount.length > MAX_AMOUNT.length) {
      throw new MoneyError("MONEY_OUT_OF_RANGE", "Amount exceeds the supported range");
    }

    Money.assertCurrency(currency);
    return new Money(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.plus(other.#value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#value.minus(other.#value), this.currency);
  }

  negate(): Money {
    return new Money(this.#value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isPositive(): boolean {
    return this.#value.greaterThan("0.00");
  }

  isNegative(): boolean {
    return this.#value.lessThan("0.00");
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.lessThan(other.#value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#value.equals(other.#value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.#value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError("MONEY_CURRENCY_MISMATCH", "Money currencies must match");
    }
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new MoneyError("INVALID_MONEY_CURRENCY", "Currency must be three uppercase ASCII letters");
    }
  }
}
