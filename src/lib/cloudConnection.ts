import * as crypto from "crypto";
import * as https from "https";
import { EventEmitter } from "events";

const BASE_URL = "https://neapi.hoymiles.com";

interface CloudApiResponse {
	status: string;
	message?: string;
	data?: Record<string, unknown>;
}

interface PreInspectData {
	n: string;
	a?: string;
}

interface CloudStation {
	id: number;
	name: string;
	[key: string]: unknown;
}

interface CloudRealtimeData {
	today_eq: string;
	month_eq: string;
	year_eq: string;
	total_eq: string;
	real_power: string;
	co2_emission_reduction: string;
	data_time: string;
	[key: string]: unknown;
}

class CloudConnection extends EventEmitter {
	public token: string | null;

	private readonly user: string;
	private readonly password: string;
	private tokenTime: number;
	private stationId: number | null;
	private destroyed: boolean;

	constructor(user: string, password: string) {
		super();
		this.user = user;
		this.password = password;
		this.token = null;
		this.tokenTime = 0;
		this.stationId = null;
		this.destroyed = false;
	}

	// --- Auth ---

	async login(): Promise<string> {
		// Step 1: Pre-inspect to get nonce and salt
		const preInsp = (await this._post("/iam/pub/3/auth/pre-insp", { u: this.user })) as CloudApiResponse & {
			data: PreInspectData;
		};

		if (preInsp.status !== "0") {
			throw new Error(`Pre-inspect failed: ${preInsp.message}`);
		}

		const { n: nonce, a: salt } = preInsp.data;

		// Step 2: Compute credential hash
		let ch: string;
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
		const loginResult = (await this._post("/iam/pub/3/auth/login", {
			u: this.user,
			ch: ch,
			n: nonce,
		})) as CloudApiResponse & { data?: { token?: string } };

		if (loginResult.status !== "0" || !loginResult.data || !loginResult.data.token) {
			// Retry with sha256 hex only (candidate 2)
			const preInsp2 = (await this._post("/iam/pub/3/auth/pre-insp", { u: this.user })) as CloudApiResponse & {
				data: PreInspectData;
			};
			const nonce2 = preInsp2.data.n;
			const sha256Hex = crypto.createHash("sha256").update(this.password).digest("hex");

			const loginResult2 = (await this._post("/iam/pub/3/auth/login", {
				u: this.user,
				ch: sha256Hex,
				n: nonce2,
			})) as CloudApiResponse & { data?: { token?: string } };

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

	async ensureToken(): Promise<void> {
		// Re-login if token is older than 1 hour
		if (!this.token || Date.now() - this.tokenTime > 3600000) {
			await this.login();
		}
	}

	disconnect(): void {
		this.destroyed = true;
		this.token = null;
		this.emit("disconnected");
	}

	// --- Data endpoints ---

	async getStationList(): Promise<CloudStation[]> {
		await this.ensureToken();
		const result = (await this._post("/pvm/api/0/station/select_by_page", {
			page: 1,
			page_size: 100,
		})) as CloudApiResponse & { data: { list?: CloudStation[] } };
		if (result.status !== "0") {
			throw new Error(`Station list failed: ${result.message}`);
		}
		return result.data.list || [];
	}

	async getStationDetails(stationId: number): Promise<Record<string, unknown>> {
		await this.ensureToken();
		const result = await this._post("/pvm/api/0/station/find", { id: stationId });
		if (result.status !== "0") {
			throw new Error(`Station details failed: ${result.message}`);
		}
		return result.data || {};
	}

	async getDeviceTree(stationId: number): Promise<Record<string, unknown>> {
		await this.ensureToken();
		const result = await this._post("/pvm/api/0/station/select_device_of_tree", {
			id: stationId,
		});
		if (result.status !== "0") {
			throw new Error(`Device tree failed: ${result.message}`);
		}
		return result.data || {};
	}

	async getStationRealtime(stationId: number): Promise<CloudRealtimeData> {
		await this.ensureToken();
		const result = await this._post("/pvm-data/api/0/station/data/count_station_real_data", {
			sid: stationId,
		});
		if (result.status !== "0") {
			throw new Error(`Realtime data failed: ${result.message}`);
		}
		return result.data as unknown as CloudRealtimeData;
	}

	async getDailyPowerCurve(stationId: number, date: string): Promise<Buffer> {
		await this.ensureToken();
		// Returns protobuf-encoded binary data
		const result = await this._postRaw("/pvm-data/api/0/station/data/count_playback_power_by_day", {
			sid: stationId,
			date: date,
		});
		return result;
	}

	async getDailyEnergyCurve(stationId: number, date: string): Promise<Buffer> {
		await this.ensureToken();
		// Returns protobuf-encoded binary data
		const result = await this._postRaw("/pvm-data/api/0/station/data/count_eq_by_day", {
			sid: stationId,
			date: date,
		});
		return result;
	}

	// --- HTTP helpers ---

	private _post(path: string, body: Record<string, unknown>): Promise<CloudApiResponse> {
		return new Promise((resolve, reject) => {
			const data = JSON.stringify(body);
			const url = new URL(path, BASE_URL);

			const options: https.RequestOptions = {
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
				(options.headers as Record<string, string | number>).Authorization = this.token;
			}

			const req = https.request(options, res => {
				let responseBody = "";
				res.on("data", (chunk: string) => (responseBody += chunk));
				res.on("end", () => {
					try {
						resolve(JSON.parse(responseBody) as CloudApiResponse);
					} catch {
						reject(new Error(`Invalid JSON response from ${path}: ${responseBody.substring(0, 200)}`));
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

	private _postRaw(path: string, body: Record<string, unknown>): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const data = JSON.stringify(body);
			const url = new URL(path, BASE_URL);

			const options: https.RequestOptions = {
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
				(options.headers as Record<string, string | number>).Authorization = this.token;
			}

			const req = https.request(options, res => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
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

export = CloudConnection;
