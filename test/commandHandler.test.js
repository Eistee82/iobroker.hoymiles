import assert from "node:assert";
import { COMMANDS, executeCommand } from "../build/lib/commandHandler.js";
import { ProtobufHandler } from "../build/lib/protobufHandler.js";

// ============================================================
// commandHandler — COMMANDS lookup table
// ============================================================
describe("commandHandler – COMMANDS", function () {
	const EXPECTED_COMMANDS = [
		"inverter.powerLimit",
		"inverter.active",
		"inverter.reboot",
		"dtu.reboot",
		"inverter.powerFactorLimit",
		"inverter.reactivePowerLimit",
		"inverter.cleanWarnings",
		"inverter.cleanGroundingFault",
		"inverter.lock",
		"config.zeroExportEnable",
		"config.serverSendTime",
	];

	it("contains all expected command keys", function () {
		for (const key of EXPECTED_COMMANDS) {
			assert.ok(COMMANDS[key], `Missing command: ${key}`);
		}
	});

	it("has exactly 11 commands", function () {
		assert.strictEqual(Object.keys(COMMANDS).length, 11);
	});

	it("all commands have encode and log functions", function () {
		for (const [key, cmd] of Object.entries(COMMANDS)) {
			assert.strictEqual(typeof cmd.encode, "function", `${key} missing encode`);
			assert.strictEqual(typeof cmd.log, "function", `${key} missing log`);
		}
	});

	it("button commands are flagged correctly", function () {
		const buttons = ["inverter.reboot", "dtu.reboot", "inverter.cleanWarnings", "inverter.cleanGroundingFault"];
		for (const key of buttons) {
			assert.strictEqual(COMMANDS[key].button, true, `${key} should be a button`);
		}
		const nonButtons = ["inverter.powerLimit", "inverter.active", "inverter.lock", "config.zeroExportEnable"];
		for (const key of nonButtons) {
			assert.ok(!COMMANDS[key].button, `${key} should not be a button`);
		}
	});

	it("powerLimit validate rejects out of range", function () {
		const v = COMMANDS["inverter.powerLimit"].validate;
		assert.ok(v);
		assert.ok(v(1) !== null, "1 should be rejected");
		assert.ok(v(101) !== null, "101 should be rejected");
		assert.strictEqual(v(2), null, "2 should be valid");
		assert.strictEqual(v(100), null, "100 should be valid");
		assert.strictEqual(v(50), null, "50 should be valid");
	});

	it("powerFactorLimit validate rejects invalid ranges", function () {
		const v = COMMANDS["inverter.powerFactorLimit"].validate;
		assert.ok(v);
		assert.ok(v(0) !== null, "0 should be rejected");
		assert.ok(v(0.5) !== null, "0.5 should be rejected");
		assert.strictEqual(v(0.9), null, "0.9 should be valid");
		assert.strictEqual(v(-0.9), null, "-0.9 should be valid");
		assert.strictEqual(v(1), null, "1 should be valid");
		assert.strictEqual(v(-1), null, "-1 should be valid");
	});

	it("reactivePowerLimit validate rejects out of range", function () {
		const v = COMMANDS["inverter.reactivePowerLimit"].validate;
		assert.ok(v);
		assert.ok(v(-51) !== null, "-51 should be rejected");
		assert.ok(v(51) !== null, "51 should be rejected");
		assert.strictEqual(v(0), null, "0 should be valid");
		assert.strictEqual(v(-50), null, "-50 should be valid");
		assert.strictEqual(v(50), null, "50 should be valid");
	});

	it("serverSendTime validate rejects invalid values", function () {
		const v = COMMANDS["config.serverSendTime"].validate;
		assert.ok(v);
		assert.ok(v(0) !== null, "0 should be rejected");
		assert.ok(v(-1) !== null, "-1 should be rejected");
		assert.strictEqual(v(1), null, "1 should be valid");
		assert.strictEqual(v(5), null, "5 should be valid");
	});

	it("log functions return strings", function () {
		for (const [key, cmd] of Object.entries(COMMANDS)) {
			const result = cmd.log(42);
			assert.strictEqual(typeof result, "string", `${key}.log() should return string`);
			assert.ok(result.length > 0, `${key}.log() should return non-empty string`);
		}
	});
});

// ============================================================
// commandHandler – executeCommand
// ============================================================
describe("commandHandler – executeCommand", function () {
	let handler;

	before(async function () {
		this.timeout(10000);
		handler = new ProtobufHandler();
		await handler.loadProtos();
	});

	function createMockContext(handler) {
		const sent = [];
		const states = {};
		const resetButtons = [];
		return {
			ctx: {
				connection: {
					send: async buf => {
						sent.push(buf);
						return true;
					},
				},
				protobuf: handler,
				deviceId: "TEST123",
				log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
				setState: async (id, val, ack) => {
					states[id] = { val, ack };
				},
				resetButton: id => {
					resetButtons.push(id);
				},
			},
			sent,
			states,
			resetButtons,
		};
	}

	it("sends power limit command", async function () {
		const { ctx, sent } = createMockContext(handler);
		await executeCommand("inverter.powerLimit", { val: 50, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 1);
		assert.ok(Buffer.isBuffer(sent[0]));
	});

	it("rejects invalid power limit", async function () {
		const { ctx, sent } = createMockContext(handler);
		await executeCommand("inverter.powerLimit", { val: 150, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 0);
	});

	it("sends inverter on/off command", async function () {
		const { ctx, sent } = createMockContext(handler);
		await executeCommand("inverter.active", { val: true, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 1);
		await executeCommand("inverter.active", { val: false, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 2);
	});

	it("sends reboot and resets button", async function () {
		const { ctx, sent, resetButtons } = createMockContext(handler);
		await executeCommand("inverter.reboot", { val: true, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(resetButtons.length, 1);
		assert.strictEqual(resetButtons[0], "inverter.reboot");
	});

	it("ignores button command with false value", async function () {
		const { ctx, sent } = createMockContext(handler);
		await executeCommand("inverter.reboot", { val: false, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 0);
	});

	it("ignores unknown state ID", async function () {
		const { ctx, sent } = createMockContext(handler);
		await executeCommand("unknown.state", { val: 42, ack: false, ts: 0, lc: 0, from: "", q: 0 }, ctx);
		assert.strictEqual(sent.length, 0);
	});
});
