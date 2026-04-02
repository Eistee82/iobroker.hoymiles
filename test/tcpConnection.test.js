import assert from "node:assert";
import TcpConnection from "../build/lib/tcpConnection.js";

// Minimal concrete subclass for testing the abstract base class
class TestTcpConnection extends TcpConnection {
	constructor(host = "127.0.0.1", port = 10081, minDelay = 1000, maxDelay = 30000) {
		super(host, port, minDelay, maxDelay);
	}

	_configureSocket() {}
	_onConnected() {}
	_stopSessionTimers() {}
}

// ============================================================
// TcpConnection (abstract base class)
// ============================================================
describe("TcpConnection", function () {
	let conn;

	afterEach(function () {
		if (conn) {
			conn.disconnect();
			conn = null;
		}
	});

	// --- Constructor state ---

	it("initial state: not connected, not destroyed", function () {
		conn = new TestTcpConnection();
		assert.strictEqual(conn.connected, false);
		assert.strictEqual(conn.destroyed, false);
	});

	it("stores host and port", function () {
		conn = new TestTcpConnection("10.0.0.1", 9999);
		assert.strictEqual(conn.host, "10.0.0.1");
		assert.strictEqual(conn.port, 9999);
	});

	it("initial reconnectDelay equals min delay", function () {
		conn = new TestTcpConnection("127.0.0.1", 10081, 500, 10000);
		assert.strictEqual(conn.reconnectDelay, 500);
	});

	// --- disconnect() ---

	it("disconnect sets destroyed=true and connected=false", function () {
		conn = new TestTcpConnection();
		conn.disconnect();
		assert.strictEqual(conn.destroyed, true);
		assert.strictEqual(conn.connected, false);
	});

	it("disconnect is idempotent", function () {
		conn = new TestTcpConnection();
		conn.disconnect();
		conn.disconnect();
		assert.strictEqual(conn.destroyed, true);
	});

	// --- connect() after destroy ---

	it("connect after destroy is a no-op", function () {
		conn = new TestTcpConnection();
		conn.disconnect();
		conn.connect(); // should not throw or create socket
		assert.strictEqual(conn.destroyed, true);
	});

	// --- EventEmitter ---

	it("is an EventEmitter", function () {
		conn = new TestTcpConnection();
		assert.strictEqual(typeof conn.on, "function");
		assert.strictEqual(typeof conn.emit, "function");
	});

	// --- _handleDisconnect ---

	it("_handleDisconnect emits 'disconnected' when was connected", function (done) {
		conn = new TestTcpConnection("127.0.0.1", 10081, 100, 200);
		conn.connected = true;
		conn.on("disconnected", () => {
			assert.strictEqual(conn.connected, false);
			done();
		});
		conn._handleDisconnect(null);
	});

	it("_handleDisconnect emits 'error' when error is provided", function (done) {
		conn = new TestTcpConnection("127.0.0.1", 10081, 100, 200);
		conn.on("error", err => {
			assert.strictEqual(err.message, "test error");
			done();
		});
		conn._handleDisconnect(new Error("test error"));
	});

	it("reconnect delay doubles after disconnect, capped at max", function () {
		conn = new TestTcpConnection("127.0.0.1", 10081, 1000, 4000);
		// First disconnect doubles delay and schedules reconnect timer
		conn._handleDisconnect(null);
		assert.strictEqual(conn.reconnectDelay, 2000);
		// Clear reconnect timer so next disconnect can schedule again
		conn._stopAllTimers();
		conn._handleDisconnect(null);
		assert.strictEqual(conn.reconnectDelay, 4000);
		conn._stopAllTimers();
		conn._handleDisconnect(null);
		assert.strictEqual(conn.reconnectDelay, 4000, "should be capped at max");
	});

	// --- _shouldReconnect ---

	it("_shouldReconnect returns true by default", function () {
		conn = new TestTcpConnection();
		assert.strictEqual(conn._shouldReconnect(), true);
	});
});
