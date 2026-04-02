import assert from "node:assert";
import { crc16 } from "../build/lib/crc16.js";

// ============================================================
// CRC-16/MODBUS
// ============================================================
describe("crc16", function () {
	it("standard test vector '123456789' produces 0x4B37", function () {
		const data = new TextEncoder().encode("123456789");
		assert.strictEqual(crc16(data), 0x4b37);
	});

	it("empty input returns 0xFFFF (initial value)", function () {
		assert.strictEqual(crc16(new Uint8Array(0)), 0xffff);
	});

	it("single zero byte", function () {
		const result = crc16(new Uint8Array([0x00]));
		assert.strictEqual(typeof result, "number");
		assert.ok(result >= 0 && result <= 0xffff);
		assert.notStrictEqual(result, 0xffff, "should differ from initial value");
	});

	it("works with Node.js Buffer (Uint8Array subclass)", function () {
		const buf = Buffer.from("123456789", "ascii");
		assert.strictEqual(crc16(buf), 0x4b37);
	});

	it("all-zero buffer", function () {
		const data = new Uint8Array(16);
		const result = crc16(data);
		assert.strictEqual(typeof result, "number");
		assert.ok(result >= 0 && result <= 0xffff);
	});

	it("all-0xFF buffer", function () {
		const data = new Uint8Array(16).fill(0xff);
		const result = crc16(data);
		assert.strictEqual(typeof result, "number");
		assert.ok(result >= 0 && result <= 0xffff);
	});

	it("consistent results on repeated calls", function () {
		const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
		const first = crc16(data);
		const second = crc16(data);
		assert.strictEqual(first, second);
	});

	it("different data produces different CRCs", function () {
		const a = crc16(Buffer.from([0x01, 0x02]));
		const b = crc16(Buffer.from([0x02, 0x01]));
		assert.notStrictEqual(a, b);
	});
});
