import * as net from "node:net";
import { EventEmitter } from "node:events";
import { clearTimer } from "./utils.js";
class TcpConnection extends EventEmitter {
    connected;
    socket;
    destroyed;
    reconnectDelay;
    host;
    port;
    reconnectTimer;
    reconnectDelayMin;
    reconnectDelayMax;
    constructor(host, port, reconnectDelayMin, reconnectDelayMax) {
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
    connect() {
        if (this.destroyed) {
            return;
        }
        this.reconnectTimer = clearTimer(this.reconnectTimer);
        this._cleanupSocket();
        this.connected = false;
        this.socket = new net.Socket();
        this._configureSocket(this.socket);
        this.socket.connect(this.port, this.host, () => {
            this.connected = true;
            this.reconnectDelay = this.reconnectDelayMin;
            this._onConnected();
        });
        this.socket.on("error", (err) => this._handleDisconnect(err));
        this.socket.on("close", () => this._handleDisconnect(null));
    }
    disconnect() {
        this.destroyed = true;
        this._stopAllTimers();
        this._cleanupSocket();
        this.connected = false;
    }
    _handleDisconnect(err) {
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
    _stopAllTimers() {
        this._stopSessionTimers();
        this.reconnectTimer = clearTimer(this.reconnectTimer);
    }
    _cleanupSocket() {
        if (this.socket) {
            const old = this.socket;
            this.socket = null;
            old.removeAllListeners();
            old.on("error", () => { });
            old.destroy();
        }
    }
    _shouldReconnect() {
        return true;
    }
}
export default TcpConnection;
//# sourceMappingURL=tcpConnection.js.map