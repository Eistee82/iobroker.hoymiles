import assert from "node:assert";
import Encryption from "../build/lib/encryption.js";

// ============================================================
// encryption
// ============================================================
describe("encryption", function () {
	it("Encryption.isRequired returns false for 0", function () {
		assert.strictEqual(Encryption.isRequired(0), false);
	});

	it("Encryption.isRequired returns true for (1 << 25)", function () {
		assert.strictEqual(Encryption.isRequired(1 << 25), true);
	});

	it("Encryption.isRequired returns true for value with bit 25 set among others", function () {
		assert.strictEqual(Encryption.isRequired((1 << 25) | 0xff), true);
	});

	it("Encryption.isRequired returns false for null/undefined", function () {
		assert.strictEqual(Encryption.isRequired(null), false);
		assert.strictEqual(Encryption.isRequired(undefined), false);
	});

	it("encrypt and decrypt round-trip produces original data", function () {
		const enc = new Encryption("0123456789abcdef");
		const original = Buffer.from("Hello, Hoymiles!");
		const encrypted = enc.encrypt(original, 0xa311, 42);
		const decrypted = enc.decrypt(encrypted, 0xa311, 42);
		assert.ok(Buffer.compare(original, decrypted) === 0);
	});

	it("different msgId/seqNum produces different ciphertext", function () {
		const enc = new Encryption("0123456789abcdef");
		const original = Buffer.from("Hello, Hoymiles!");
		const encrypted1 = enc.encrypt(original, 0xa311, 1);
		const encrypted2 = enc.encrypt(original, 0xa311, 2);
		assert.ok(Buffer.compare(encrypted1, encrypted2) !== 0);
	});

	it("encrypt produces data for any encRand length", function () {
		const enc = new Encryption("short");
		const encrypted = enc.encrypt(Buffer.from("test data here!!"), 0xa311, 1);
		assert.ok(encrypted.length > 0);
	});
});

// ============================================================
// encryption – additional edge cases
// ============================================================
describe("encryption – edge cases", function () {
	it("constructor accepts Buffer as encRand", function () {
		const enc = new Encryption(Buffer.from([0x01, 0x02, 0x03, 0x04]));
		const encrypted = enc.encrypt(Buffer.from("test"), 0xa311, 1);
		assert.ok(encrypted.length > 0);
	});

	it("encrypt/decrypt works with empty buffer", function () {
		const enc = new Encryption("testkey123");
		const encrypted = enc.encrypt(Buffer.alloc(0), 0xa311, 1);
		const decrypted = enc.decrypt(encrypted, 0xa311, 1);
		assert.strictEqual(decrypted.length, 0);
	});

	it("encrypt/decrypt works with large payload", function () {
		const enc = new Encryption("testkey123");
		const original = Buffer.alloc(4096, 0xab);
		const encrypted = enc.encrypt(original, 0xa311, 1);
		const decrypted = enc.decrypt(encrypted, 0xa311, 1);
		assert.ok(Buffer.compare(original, decrypted) === 0);
	});

	it("encrypt/decrypt with msgId=0 and seqNum=0", function () {
		const enc = new Encryption("testkey123");
		const original = Buffer.from("boundary test");
		const encrypted = enc.encrypt(original, 0, 0);
		const decrypted = enc.decrypt(encrypted, 0, 0);
		assert.ok(Buffer.compare(original, decrypted) === 0);
	});

	it("isRequired returns false for values without bit 25", function () {
		assert.strictEqual(Encryption.isRequired(1), false);
		assert.strictEqual(Encryption.isRequired(0xffffff), false); // 24 bits set, bit 25 not
		assert.strictEqual(Encryption.isRequired(1 << 24), false);
	});

	it("isRequired returns true for large values with bit 25", function () {
		assert.strictEqual(Encryption.isRequired((1 << 25) | (1 << 30)), true);
	});
});
