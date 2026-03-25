"use strict";

const crypto = require("crypto");
const https = require("https");
const EventEmitter = require("events");

const BASE_URL = "https://neapi.hoymiles.com";

class CloudConnection extends EventEmitter {
    constructor(user, password) {
        super();
        this.user = user;
        this.password = password;
        this.token = null;
        this.tokenTime = 0;
        this.stationId = null;
        this.destroyed = false;
    }

    // --- Auth ---

    async login() {
        // Step 1: Pre-inspect to get nonce and salt
        const preInsp = await this._post("/iam/pub/3/auth/pre-insp", { u: this.user });

        if (preInsp.status !== "0") {
            throw new Error(`Pre-inspect failed: ${preInsp.message}`);
        }

        const { n: nonce, a: salt } = preInsp.data;

        // Step 2: Compute credential hash
        let ch;
        if (salt) {
            // Argon2 would be needed here - not implemented yet
            throw new Error("Argon2 authentication not supported yet (salt is set). Please report this.");
        } else {
            // No salt: use md5.sha256_base64 format
            const md5Hex = crypto.createHash("md5").update(this.password).digest("hex");
            const sha256B64 = crypto.createHash("sha256").update(this.password).digest("base64");
            ch = `${md5Hex}.${sha256B64}`;
        }

        // Step 3: Login
        const loginResult = await this._post("/iam/pub/3/auth/login", {
            u: this.user,
            ch: ch,
            n: nonce,
        });

        if (loginResult.status !== "0" || !loginResult.data || !loginResult.data.token) {
            // Retry with sha256 hex only (candidate 2)
            const preInsp2 = await this._post("/iam/pub/3/auth/pre-insp", { u: this.user });
            const nonce2 = preInsp2.data.n;
            const sha256Hex = crypto.createHash("sha256").update(this.password).digest("hex");

            const loginResult2 = await this._post("/iam/pub/3/auth/login", {
                u: this.user,
                ch: sha256Hex,
                n: nonce2,
            });

            if (loginResult2.status !== "0" || !loginResult2.data || !loginResult2.data.token) {
                throw new Error(`Login failed: ${loginResult2.message || "unknown error"}`);
            }

            this.token = loginResult2.data.token;
        } else {
            this.token = loginResult.data.token;
        }

        this.tokenTime = Date.now();
        this.emit("connected");
        return this.token;
    }

    async ensureToken() {
        // Re-login if token is older than 1 hour
        if (!this.token || Date.now() - this.tokenTime > 3600000) {
            await this.login();
        }
    }

    disconnect() {
        this.destroyed = true;
        this.token = null;
        this.emit("disconnected");
    }

    // --- Data endpoints ---

    async getStationList() {
        await this.ensureToken();
        const result = await this._post("/pvm/api/0/station/select_by_page", {
            page: 1,
            page_size: 100,
        });
        if (result.status !== "0") throw new Error(`Station list failed: ${result.message}`);
        return result.data.list || [];
    }

    async getStationDetails(stationId) {
        await this.ensureToken();
        const result = await this._post("/pvm/api/0/station/find", { id: stationId });
        if (result.status !== "0") throw new Error(`Station details failed: ${result.message}`);
        return result.data;
    }

    async getDeviceTree(stationId) {
        await this.ensureToken();
        const result = await this._post("/pvm/api/0/station/select_device_of_tree", { id: stationId });
        if (result.status !== "0") throw new Error(`Device tree failed: ${result.message}`);
        return result.data;
    }

    async getStationRealtime(stationId) {
        await this.ensureToken();
        const result = await this._post("/pvm-data/api/0/station/data/count_station_real_data", {
            sid: stationId,
        });
        if (result.status !== "0") throw new Error(`Realtime data failed: ${result.message}`);
        return result.data;
    }

    async getDailyPowerCurve(stationId, date) {
        await this.ensureToken();
        // Returns protobuf-encoded binary data
        const result = await this._postRaw("/pvm-data/api/0/station/data/count_playback_power_by_day", {
            sid: stationId,
            date: date,
        });
        return result;
    }

    async getDailyEnergyCurve(stationId, date) {
        await this.ensureToken();
        // Returns protobuf-encoded binary data
        const result = await this._postRaw("/pvm-data/api/0/station/data/count_eq_by_day", {
            sid: stationId,
            date: date,
        });
        return result;
    }

    // --- HTTP helpers ---

    _post(path, body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const url = new URL(path, BASE_URL);

            const options = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            };

            if (this.token) {
                options.headers["Authorization"] = this.token;
            }

            const req = https.request(options, (res) => {
                let body = "";
                res.on("data", (chunk) => (body += chunk));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error(`Invalid JSON response from ${path}: ${body.substring(0, 200)}`));
                    }
                });
            });

            req.on("error", reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error(`Timeout on ${path}`));
            });
            req.write(data);
            req.end();
        });
    }

    _postRaw(path, body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const url = new URL(path, BASE_URL);

            const options = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            };

            if (this.token) {
                options.headers["Authorization"] = this.token;
            }

            const req = https.request(options, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks)));
            });

            req.on("error", reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error(`Timeout on ${path}`));
            });
            req.write(data);
            req.end();
        });
    }
}

module.exports = CloudConnection;
