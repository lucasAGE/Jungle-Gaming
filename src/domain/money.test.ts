import { describe, expect, test } from "bun:test";
import { Decimal } from "decimal.js";
import { Money, MoneyError } from "./money.js";

const maximumAmount = "999999999999999999.99";

function brl(amount: string): Money {
  return Money.from({ amount, currency: "BRL" });
}

function expectMoneyError(
  operation: () => unknown,
  code: MoneyError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyError);
    if (!(error instanceof MoneyError)) throw error;
    expect(error.code).toBe(code);
    return;
  }

  throw new Error(`Expected MoneyError with code ${code}`);
}

describe("Money input and serialization", () => {
  test.each(["0.00", "0.01", "25.00", maximumAmount])(
    "preserves the exact decimal string %s",
    (amount) => {
      const money = brl(amount);

      expect(money.toString()).toBe(amount);
      expect(money.toJSON()).toEqual({ amount, currency: "BRL" });
      expect(JSON.stringify(money)).toBe(
        JSON.stringify({ amount, currency: "BRL" }),
      );
    },
  );

  test.each([
    "",
    " ",
    "1",
    "1.0",
    "1.000",
    "1.001",
    ".01",
    "1.",
    "01.00",
    "00.00",
    "+1.00",
    "-1.00",
    "-0.00",
    " 1.00",
    "1.00 ",
    "1.00\n",
    "NaN",
    "Infinity",
    "-Infinity",
    "1e2",
    "1E+2",
    "0x10",
    "1,00",
    "1_000.00",
    "١.٠٠",
  ])("rejects a noncanonical decimal string %j", (amount) => {
    expectMoneyError(() => brl(amount), "INVALID_MONEY_AMOUNT");
  });

  test.each([
    ["zero number", 0],
    ["integer number", 1],
    ["fractional number", 0.1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
    ["array", []],
  ] as const)(
    "rejects a non-string amount (%s) at runtime",
    (_label, amount) => {
      expectMoneyError(
        () => brl(amount as unknown as string),
        "INVALID_MONEY_AMOUNT",
      );
    },
  );

  test.each(["1000000000000000000.00", "999999999999999999999999.99"])(
    "rejects an amount beyond the supported range: %s",
    (amount) => {
      expectMoneyError(() => brl(amount), "MONEY_OUT_OF_RANGE");
    },
  );

  test("serializes internal negative values as fixed-scale decimal strings", () => {
    const money = brl("1.00").subtract(brl("1.01"));

    expect(money.toString()).toBe("-0.01");
    expect(money.toJSON()).toEqual({ amount: "-0.01", currency: "BRL" });
  });

  test("creates zero in the requested currency", () => {
    expect(Money.zero("BRL").toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
    expect(Money.zero("USD").toJSON()).toEqual({
      amount: "0.00",
      currency: "USD",
    });
  });
});

describe("Money arithmetic", () => {
  test("adds decimal fractions exactly", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("carries cents into the integer part without rounding", () => {
    expect(brl("999.99").add(brl("0.01")).toString()).toBe("1000.00");
  });

  test("preserves cents above Number.MAX_SAFE_INTEGER", () => {
    expect(brl("9007199254740993.01").add(brl("0.02")).toString()).toBe(
      "9007199254740993.03",
    );
    expect(brl(maximumAmount).subtract(brl("0.01")).toString()).toBe(
      "999999999999999999.98",
    );
  });

  test("subtracts to positive, zero, and negative results", () => {
    const amount = brl("25.00");

    expect(amount.subtract(brl("0.01")).toString()).toBe("24.99");
    expect(amount.subtract(amount).toString()).toBe("0.00");
    expect(amount.subtract(brl("25.01")).toString()).toBe("-0.01");
  });

  test("supports signed arithmetic inside the domain", () => {
    const negative = brl("25.00").negate();

    expect(negative.add(brl("0.01")).toString()).toBe("-24.99");
    expect(negative.subtract(brl("0.01")).toString()).toBe("-25.01");
    expect(negative.negate().toString()).toBe("25.00");
    expect(brl("1.00").subtract(negative).toString()).toBe("26.00");
  });

  test("normalizes negative zero and cancellation to unsigned zero", () => {
    expect(Money.zero("BRL").negate().toString()).toBe("0.00");
    expect(brl("1.00").add(brl("1.00").negate()).toJSON()).toEqual({
      amount: "0.00",
      currency: "BRL",
    });
  });

  test("accepts both signed range limits exactly", () => {
    const maximum = brl(maximumAmount);
    const minimum = maximum.negate();

    expect(maximum.add(Money.zero("BRL")).toString()).toBe(maximumAmount);
    expect(minimum.toString()).toBe(`-${maximumAmount}`);
    expect(minimum.negate().toString()).toBe(maximumAmount);
    expect(maximum.add(minimum).toString()).toBe("0.00");
  });

  test("rejects positive overflow instead of rounding or truncating", () => {
    expectMoneyError(
      () => brl(maximumAmount).add(brl("0.01")),
      "MONEY_OUT_OF_RANGE",
    );
  });

  test("rejects negative overflow instead of rounding or truncating", () => {
    expectMoneyError(
      () => brl(maximumAmount).negate().subtract(brl("0.01")),
      "MONEY_OUT_OF_RANGE",
    );
  });

  test("is independent of changes to the global Decimal configuration", () => {
    const previousPrecision = Decimal.precision;
    const previousRounding = Decimal.rounding;

    try {
      Decimal.set({ precision: 2, rounding: Decimal.ROUND_DOWN });

      expect(brl(maximumAmount).subtract(brl("0.01")).toString()).toBe(
        "999999999999999999.98",
      );
      expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    } finally {
      Decimal.set({
        precision: previousPrecision,
        rounding: previousRounding,
      });
    }
  });
});

describe("Money comparisons", () => {
  test("classifies zero without treating it as positive or negative", () => {
    const zero = Money.zero("BRL").negate();

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test("classifies positive and negative values", () => {
    const positive = brl("0.01");
    const negative = positive.negate();

    expect(positive.isZero()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isNegative()).toBe(false);
    expect(negative.isZero()).toBe(false);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isNegative()).toBe(true);
  });

  test("compares values rather than object identity", () => {
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
    expect(brl("1.00").equals(brl("1.01"))).toBe(false);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("0.01").negate().isLessThan(Money.zero("BRL"))).toBe(true);
    expect(brl(maximumAmount).isLessThan(brl(maximumAmount))).toBe(false);
  });
});

describe("Money currency boundaries", () => {
  test.each(["", "brl", "Brl", "BR", "BRLL", " BRL", "BRL ", "BRL\n", "B1L", "BŔL"])(
    "rejects invalid currency %j in both factories",
    (currency) => {
      expectMoneyError(
        () => Money.from({ amount: "1.00", currency }),
        "INVALID_MONEY_CURRENCY",
      );
      expectMoneyError(() => Money.zero(currency), "INVALID_MONEY_CURRENCY");
    },
  );

  test.each([null, undefined, 123])(
    "rejects a non-string currency %j at runtime",
    (currency) => {
      expectMoneyError(
        () => Money.zero(currency as unknown as string),
        "INVALID_MONEY_CURRENCY",
      );
    },
  );

  test("preserves currency through arithmetic", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });

    expect(usd.add(usd).toJSON()).toEqual({ amount: "2.00", currency: "USD" });
    expect(usd.subtract(usd).currency).toBe("USD");
    expect(usd.negate().currency).toBe("USD");
  });

  test.each(["add", "subtract", "isLessThan", "equals"] as const)(
    "%s rejects different currencies even when both amounts are zero",
    (operation) => {
      expectMoneyError(
        () => Money.zero("BRL")[operation](Money.zero("USD")),
        "MONEY_CURRENCY_MISMATCH",
      );
    },
  );
});

describe("Money immutability", () => {
  test("does not change either operand and returns fresh values", () => {
    const original = brl("25.00");
    const other = brl("0.01");

    expect(original.add(other)).not.toBe(original);
    expect(original.subtract(other)).not.toBe(original);
    expect(original.negate()).not.toBe(original);
    expect(original.add(Money.zero("BRL"))).not.toBe(original);
    expect(original.toString()).toBe("25.00");
    expect(other.toString()).toBe("0.01");
  });

  test("does not retain mutable input or serialization objects", () => {
    const input = { amount: "25.00", currency: "BRL" };
    const money = Money.from(input);
    input.amount = "99.00";
    input.currency = "USD";

    const first = money.toJSON();
    const second = money.toJSON();

    expect(first).not.toBe(second);
    expect(second).toEqual({ amount: "25.00", currency: "BRL" });
  });
});
