import assert from "node:assert";
import { toKwh, round1, whToKwh } from "../build/lib/convert.js";

// ============================================================
// toKwh — Wh string to kWh number
// ============================================================
describe("toKwh", function () {
	it("converts 1000 Wh to 1.00 kWh", function () {
		assert.strictEqual(toKwh("1000"), 1.0);
	});

	it("converts 0 Wh to 0", function () {
		assert.strictEqual(toKwh("0"), 0);
	});

	it("rounds to 2 decimal places (1234 Wh = 1.23 kWh)", function () {
		assert.strictEqual(toKwh("1234"), 1.23);
	});

	it("rounds up correctly (1005 Wh = 1.01 kWh)", function () {
		// 1005 / 10 = 100.5 → Math.round = 101 → 101 / 100 = 1.01
		assert.strictEqual(toKwh("1005"), 1.01);
	});

	it("rounds down correctly (1004 Wh = 1.00 kWh)", function () {
		// 1004 / 10 = 100.4 → Math.round = 100 → 100 / 100 = 1.00
		assert.strictEqual(toKwh("1004"), 1.0);
	});

	it("handles negative values", function () {
		assert.strictEqual(toKwh("-1000"), -1.0);
	});

	it("returns 0 for non-numeric string", function () {
		assert.strictEqual(toKwh("abc"), 0);
	});

	it("returns 0 for empty string", function () {
		assert.strictEqual(toKwh(""), 0);
	});

	it("handles whitespace-padded strings", function () {
		assert.strictEqual(toKwh(" 1000 "), 1.0);
	});

	it("handles very large values without overflow", function () {
		const result = toKwh("99999999");
		assert.strictEqual(typeof result, "number");
		assert.ok(Number.isFinite(result));
		assert.strictEqual(result, 100000.0);
	});
});

// ============================================================
// round1 — round to 1 decimal place
// ============================================================
describe("round1", function () {
	it("rounds 1.24 to 1.2", function () {
		assert.strictEqual(round1(1.24), 1.2);
	});

	it("rounds 1.25 to 1.3", function () {
		assert.strictEqual(round1(1.25), 1.3);
	});

	it("rounds 0 to 0", function () {
		assert.strictEqual(round1(0), 0);
	});

	it("rounds negative values", function () {
		assert.strictEqual(round1(-1.26), -1.3);
	});
});

// ============================================================
// whToKwh — Wh number to kWh number
// ============================================================
describe("whToKwh", function () {
	it("converts 1000 Wh to 1 kWh", function () {
		assert.strictEqual(whToKwh(1000), 1);
	});

	it("converts 0 to 0", function () {
		assert.strictEqual(whToKwh(0), 0);
	});

	it("rounds fractional Wh before dividing (1234.9 → 1.235)", function () {
		assert.strictEqual(whToKwh(1234.9), 1.235);
	});

	it("handles small values (1 Wh = 0.001 kWh)", function () {
		assert.strictEqual(whToKwh(1), 0.001);
	});
});
