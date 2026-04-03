import assert from "node:assert";
import * as path from "node:path";
import protobuf from "protobufjs";
import { parseChartResponse } from "../build/lib/chartParser.js";

// ============================================================
// chartParser
// ============================================================
describe("chartParser", function () {
	it("returns empty object for null buffer", async function () {
		const result = await parseChartResponse(null);
		assert.deepStrictEqual(result, {});
	});

	it("returns empty object for empty buffer", async function () {
		const result = await parseChartResponse(Buffer.alloc(0));
		assert.deepStrictEqual(result, {});
	});

	it("returns empty object for buffer shorter than 50 bytes", async function () {
		const result = await parseChartResponse(Buffer.alloc(49, 0xff));
		assert.deepStrictEqual(result, {});
	});

	it("returns empty object for invalid protobuf data", async function () {
		const result = await parseChartResponse(Buffer.alloc(100, 0xff));
		assert.deepStrictEqual(result, {});
	});

	it("calls log callback on parse failure", async function () {
		let logged = false;
		await parseChartResponse(Buffer.alloc(100, 0xff), () => {
			logged = true;
		});
		assert.ok(logged, "Log callback should have been called");
	});

	it("parses valid LineChart protobuf data", async function () {
		const protoDir = path.join(import.meta.dirname, "..", "build", "lib", "proto");
		const root = await protobuf.load(path.join(protoDir, "Chart.proto"));
		const LineChart = root.lookupType("LineChart");

		const chart = LineChart.create({
			series: [
				{ type: "MI_POWER", data: [0, 0, 100.5, 200.3, 0] },
				{ type: "MI_TEMPERATURE", data: [0, 25.7, 30.2] },
			],
		});
		const buf = Buffer.from(LineChart.encode(chart).finish());

		const result = await parseChartResponse(buf);
		assert.strictEqual(result.MI_POWER, 200.3);
		assert.strictEqual(result.MI_TEMPERATURE, 30.2);
	});

	it("parses LineChart with all-zero series", async function () {
		const protoDir = path.join(import.meta.dirname, "..", "build", "lib", "proto");
		const root = await protobuf.load(path.join(protoDir, "Chart.proto"));
		const LineChart = root.lookupType("LineChart");

		const chart = LineChart.create({
			series: [{ type: "MI_POWER", data: [0, 0, 0] }],
		});
		const buf = Buffer.from(LineChart.encode(chart).finish());

		const result = await parseChartResponse(buf);
		assert.strictEqual(result.MI_POWER, undefined);
	});
});
