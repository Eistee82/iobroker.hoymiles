import * as net from "node:net";
import { EventEmitter } from "node:events";
import { clearTimer } from "./utils.js";

/**
 * Abstract base class for persistent TCP connections with reconnect logic.
 * Shared by DtuConnection (local DTU) and CloudRelay (cloud server).
 *
 * Uses native timers (not adapter-managed) because this class has no adapter
 * dependency. Callers must ensure disconnect() is called on adapter unload
 * to clean up all timers.
 */
abstract class TcpConnection extends EventEmitter {
	public connected: boolean;

	protected socket: net.Socket | null;
	protected destroyed: boolean;
	protected reconnectDelay: number;

	protected readonly host: string;
	protected readonly port: number;

	private reconnectTimer: ReturnType<typeof setTimeout> | null;
	private readonly reconnectDelayMin: number;
	private readonly reconnectDelayMax: number;

	/**
	 * @param host - Remote host address
	 * @param port - Remote port
	 * @param reconnectDelayMin - Initial reconnect delay in ms
	 * @param reconnectDelayMax - Maximum reconnect delay in ms
	 */
	constructor(host: string, port: number, reconnectDelayMin: number, reconnectDelayMax: number) {
		super();
		this.host = host;
		this.port = port;
		this.socket = null;
		this.connected = false;
		this.destroyed = false;
		this.reconnectTimer = null;
		this.reconnectDelay = reconnectDelayMin;
		this.reconnectDelayMin = reconnectDelayMin;
		this.reconnectDelayMax = reconnectDelayMax;
	}

	/** Open TCP connection. Cleans up any existing socket first. */
	connect(): void {
		if (this.destroyed) {
			return;
		}

		// Cancel pending reconnect — we are connecting now
		this.reconnectTimer = clearTimer(this.reconnectTimer);

		// Clean up old socket: remove listeners to prevent stale events after destroy
		this._cleanupSocket();

		this.connected = false;
		this.socket = new net.Socket();

		this._configureSocket(this.socket);

		this.socket.connect(this.port, this.host, () => {
			this.connected = true;
			this.reconnectDelay = this.reconnectDelayMin;
			this._onConnected();
		});

		this.socket.on("error", (err: Error) => this._handleDisconnect(err));
		this.socket.on("close", () => this._handleDisconnect(null));
	}

	/** Close the connection permanently and stop all timers. */
	disconnect(): void {
		this.destroyed = true;
		this._stopAllTimers();
		this._cleanupSocket();
		this.connected = false;
	}

	/**
	 * Handle socket disconnect: emit events and schedule reconnect.
	 *
	 * @param err - The error that caused the disconnect, or null for clean close
	 */
	protected _handleDisconnect(err: Error | null): void {
		const wasConnected = this.connected;
		this.connected = false;
		this._stopSessionTimers();

		if (this.destroyed) {
			if (wasConnected) {
				this.emit("disconnected");
			}
			return;
		}

		if (err) {
			this.emit("error", err);
		}
		if (wasConnected) {
			this.emit("disconnected");
		}

		// Schedule reconnect unless subclass says no (e.g. paused) or already scheduled
		if (this._shouldReconnect() && !this.reconnectTimer) {
			const delay = this.reconnectDelay;
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectDelayMax);
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				if (!this.destroyed && this._shouldReconnect()) {
					this.connect();
				}
			}, delay);
		}
	}

	/** Stop all timers including reconnect. */
	protected _stopAllTimers(): void {
		this._stopSessionTimers();
		this.reconnectTimer = clearTimer(this.reconnectTimer);
	}

	/** Remove all listeners from socket and destroy it. */
	private _cleanupSocket(): void {
		if (this.socket) {
			const old = this.socket;
			this.socket = null;
			old.removeAllListeners();
			old.on("error", () => {}); // Prevent uncaught exception from post-destroy error
			old.destroy();
		}
	}

	/** Configure the socket (keepAlive, timeout) and add data handlers. Called after socket creation. */
	protected abstract _configureSocket(socket: net.Socket): void;

	/** Run logic after TCP connect callback fires. */
	protected abstract _onConnected(): void;

	/** Stop session-specific timers. Subclasses override to stop their own timers. */
	protected abstract _stopSessionTimers(): void;

	/** Whether reconnect should be attempted. Override to add conditions like pause state. */
	protected _shouldReconnect(): boolean {
		return true;
	}
}

export default TcpConnection;
