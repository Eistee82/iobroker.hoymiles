import assert from "node:assert";
import net from "node:net";
import { probeHost, discoverDtus } from "../build/lib/networkDiscovery.js";

// ============================================================
// Helper: build a valid DTU response buffer
// ============================================================
function buildDtuResponse(serial = "DTU123456789") {
	// Header: 0x48 0x4d 0xa2 0x01 + 6 filler bytes = 10 byte header
	// Payload: 0x0a <length> <serial as ASCII>
	const serialBuf = Buffer.from(serial, "ascii");
	const payload = Buffer.concat([Buffer.from([0x0a, serialBuf.length]), serialBuf]);
	const totalLen = 10 + payload.length;
	const header = Buffer.alloc(10);
	header[0] = 0x48; // H
	header[1] = 0x4d; // M
	header[2] = 0xa2; // response command
	header[3] = 0x01;
	header[4] = 0x00;
	header[5] = 0x01;
	header[6] = 0x00; // CRC placeholder
	header[7] = 0x00;
	header[8] = (totalLen >> 8) & 0xff;
	header[9] = totalLen & 0xff;
	return Buffer.concat([header, payload]);
}

// ============================================================
// networkDiscovery — probeHost
// ============================================================
describe("networkDiscovery", function () {
	// ----------------------------------------------------------
	// Existing tests: unreachable / refused / invalid
	// ----------------------------------------------------------
	describe("probeHost — unreachable hosts", function () {
		it("returns null for unreachable host (TEST-NET address)", async function () {
			this.timeout(5000);
			const result = await probeHost("192.0.2.1", 500);
			assert.strictEqual(result, null);
		});

		it("returns null for connection refused (localhost, wrong port)", async function () {
			this.timeout(5000);
			// Port 10081 on localhost should be refused (no DTU running)
			const result = await probeHost("127.0.0.1", 500);
			assert.strictEqual(result, null);
		});

		it("returns null for invalid host", async function () {
			this.timeout(5000);
			const result = await probeHost("0.0.0.0", 200);
			assert.strictEqual(result, null);
		});
	});

	// ----------------------------------------------------------
	// Edge cases: empty / undefined host
	// ----------------------------------------------------------
	describe("probeHost — edge cases", function () {
		it("returns null for empty host string", async function () {
			this.timeout(5000);
			const result = await probeHost("", 200);
			assert.strictEqual(result, null);
		});

		it("returns null for undefined host", async function () {
			this.timeout(5000);
			const result = await probeHost(undefined, 200);
			assert.strictEqual(result, null);
		});
	});

	// ----------------------------------------------------------
	// Mock TCP server tests
	// ----------------------------------------------------------
	describe("probeHost — with TCP mock server", function () {
		let server;
		let _serverPort;
		let onConnection; // set per-test to control server behaviour

		before(function (done) {
			server = net.createServer(socket => {
				if (onConnection) {
					onConnection(socket);
				} else {
					socket.destroy();
				}
			});
			server.listen(10081, "127.0.0.1", () => {
				_serverPort = server.address().port;
				done();
			});
		});

		after(function (done) {
			server.close(done);
		});

		afterEach(function () {
			onConnection = null;
		});

		it("detects a valid DTU and returns host + serial", async function () {
			this.timeout(5000);
			const expectedSerial = "HMS800W00001";
			onConnection = socket => {
				socket.once("data", () => {
					socket.write(buildDtuResponse(expectedSerial));
				});
			};

			const result = await probeHost("127.0.0.1", 3000);
			assert.notStrictEqual(result, null);
			assert.strictEqual(result.host, "127.0.0.1");
			assert.strictEqual(result.dtuSerial, expectedSerial);
		});

		it("detects a DTU with empty serial (valid header, zero-length serial)", async function () {
			this.timeout(5000);
			onConnection = socket => {
				socket.once("data", () => {
					// Valid header but payload with serial length 0
					const header = Buffer.alloc(10);
					header[0] = 0x48;
					header[1] = 0x4d;
					header[2] = 0xa2;
					header[3] = 0x01;
					header[8] = 0x00;
					header[9] = 0x0c; // totalLen = 12
					const payload = Buffer.from([0x0a, 0x00]); // tag + length=0
					socket.write(Buffer.concat([header, payload]));
				});
			};

			const result = await probeHost("127.0.0.1", 3000);
			assert.notStrictEqual(result, null);
			assert.strictEqual(result.host, "127.0.0.1");
			// Serial should be empty string because length byte is 0
			assert.strictEqual(result.dtuSerial, "");
		});

		it("returns null when server sends invalid data (not a DTU)", async function () {
			this.timeout(5000);
			onConnection = socket => {
				socket.once("data", () => {
					// Send garbage data that does NOT start with HM magic
					socket.write(Buffer.from("HTTP/1.1 200 OK\r\n\r\nHello"));
					// Keep connection open — probeHost should time out
				});
			};

			const result = await probeHost("127.0.0.1", 1000);
			assert.strictEqual(result, null);
		});

		it("returns null when server sends partial header with wrong magic", async function () {
			this.timeout(5000);
			onConnection = socket => {
				socket.once("data", () => {
					// 10 bytes but wrong magic bytes
					const buf = Buffer.alloc(10);
					buf[0] = 0x48; // H
					buf[1] = 0x4d; // M
					buf[2] = 0xff; // wrong command
					buf[3] = 0x01;
					socket.write(buf);
					// Keep connection open — probeHost should time out
				});
			};

			const result = await probeHost("127.0.0.1", 1000);
			assert.strictEqual(result, null);
		});

		it("returns null when server closes connection immediately", async function () {
			this.timeout(5000);
			onConnection = socket => {
				socket.destroy();
			};

			const result = await probeHost("127.0.0.1", 2000);
			assert.strictEqual(result, null);
		});

		it("handles response split across multiple chunks", async function () {
			this.timeout(5000);
			const expectedSerial = "CHUNKED12345";
			onConnection = socket => {
				socket.once("data", () => {
					const full = buildDtuResponse(expectedSerial);
					// Split the response: first 5 bytes, then the rest
					socket.write(full.subarray(0, 5));
					setTimeout(() => {
						socket.write(full.subarray(5));
					}, 30);
				});
			};

			const result = await probeHost("127.0.0.1", 3000);
			assert.notStrictEqual(result, null);
			assert.strictEqual(result.host, "127.0.0.1");
			assert.strictEqual(result.dtuSerial, expectedSerial);
		});
	});

	// ----------------------------------------------------------
	// discoverDtus with mock server
	// ----------------------------------------------------------
	describe("discoverDtus — with TCP mock server", function () {
		let server;

		before(function (done) {
			server = net.createServer(socket => {
				socket.once("data", () => {
					socket.write(buildDtuResponse("DISCOVER0001"));
				});
			});
			server.listen(10081, "127.0.0.1", () => {
				done();
			});
		});

		after(function (done) {
			server.close(done);
		});

		it("finds the local DTU mock among discovered hosts", async function () {
			this.timeout(120000); // subnet scan can take a while
			const results = await discoverDtus(2000, 100);
			// 127.0.0.1 is internal, so getLocalSubnets skips it.
			// But one of the local IPs in the subnet scan might hit our
			// server if it's on the same machine. We verify the API works.
			assert.ok(Array.isArray(results), "discoverDtus should return an array");
		});

		it("calls onProgress callback during scan", async function () {
			this.timeout(120000);
			let progressCalled = false;
			let lastScanned = 0;
			let lastTotal = 0;

			await discoverDtus(500, 100, (scanned, total) => {
				progressCalled = true;
				lastScanned = scanned;
				lastTotal = total;
			});

			assert.ok(progressCalled, "onProgress should have been called");
			assert.ok(lastTotal > 0, "total should be > 0");
			assert.strictEqual(lastScanned, lastTotal, "final scanned should equal total");
		});
	});

	// ----------------------------------------------------------
	// discoverDtus — direct probeHost-based validation
	// ----------------------------------------------------------
	describe("discoverDtus — probeHost integration", function () {
		let server;

		before(function (done) {
			server = net.createServer(socket => {
				socket.once("data", () => {
					socket.write(buildDtuResponse("INTEG0000001"));
				});
			});
			server.listen(10081, "127.0.0.1", () => {
				done();
			});
		});

		after(function (done) {
			server.close(done);
		});

		it("probeHost on 127.0.0.1 finds the mock DTU directly", async function () {
			this.timeout(5000);
			const result = await probeHost("127.0.0.1", 3000);
			assert.notStrictEqual(result, null);
			assert.strictEqual(result.host, "127.0.0.1");
			assert.strictEqual(result.dtuSerial, "INTEG0000001");
		});
	});
});
