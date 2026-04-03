import { postJson, postBinary } from "./httpClient.js";
import { parseChartResponse } from "./chartParser.js";
import { TOKEN_MAX_AGE_MS, ENSURE_TOKEN_TIMEOUT_MS } from "./constants.js";
import { errorMessage, withTimeout, buildCredentialChallenges, buildArgon2Challenge } from "./utils.js";

const BASE_URL = "https://neapi.hoymiles.com";
const EU_WEATHER_URL = "https://euapi.hoymiles.com/tpa/api/0/weather/get";

/**
 * Validate that API response data is a non-null object.
 *
 * @param data - Raw API response data
 * @param label - Context label for error messages
 */
function assertData<T>(data: unknown, label: string): T {
	if (data == null || typeof data !== "object") {
		throw new Error(`${label}: expected object, got ${typeof data}`);
	}
	return data as T;
}

interface CloudApiResponse<T = Record<string, unknown>> {
	status: string;
	message?: string;
	data?: T;
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
	plant_tree: string;
	data_time: string;
	last_data_time?: string;
	capacitor: string;
	clp: number;
	is_balance?: boolean;
	is_reflux?: boolean;
	[key: string]: unknown;
}

interface CloudStationDetails {
	name: string;
	capacitor: string;
	address: string;
	electricity_price: number;
	money_unit: string;
	latitude: string;
	longitude: string;
	status: number;
	config: {
		power_limit: string;
		module_max_power: number;
		[key: string]: unknown;
	};
	warn_data: {
		s_uoff: boolean;
		s_ustable: boolean;
		s_uid: boolean;
		l3_warn: boolean;
		g_warn: boolean;
		me_warn: boolean;
		pw_off: boolean;
		[key: string]: unknown;
	};
	create_at: string;
	timezone: { tz_name: string; offset: number };
	local_time: string;
	[key: string]: unknown;
}

interface CloudDeviceNode {
	sn: string;
	id: number;
	dtu_sn: string;
	type: number;
	model_no: string;
	soft_ver: string;
	hard_ver: string;
	warn_data: { connect: boolean; warn: boolean; [key: string]: unknown };
	children: CloudDeviceNode[];
	[key: string]: unknown;
}

interface WeatherData {
	icon: string;
	temp: number;
	sunrise: number;
	sunset: number;
}

interface FirmwareStatus {
	upgrade: number;
	done: number;
	tid: string;
}

/** Hoymiles S-Miles Cloud API client for station data and device management. */
class CloudConnection {
	public token: string | null;

	private readonly user: string;
	/** Pre-computed credential challenges for password-only login (no salt). */
	private readonly credentials: string[];
	/** Raw credential input for Argon2 login (when server provides salt). */
	private readonly credentialInput: Buffer;
	private readonly log: (msg: string) => void;
	private tokenTime: number;
	private tokenRefreshPromise: Promise<void> | null;

	private assertStationId(stationId: number): void {
		if (!stationId || stationId <= 0) {
			throw new Error("Invalid stationId");
		}
	}

	/**
	 * @param user - Hoymiles account email
	 * @param password - Hoymiles account password
	 * @param log - Debug log callback
	 */
	constructor(user: string, password: string, log?: (msg: string) => void) {
		this.user = user;
		const input = Buffer.from(password);
		this.credentials = buildCredentialChallenges(input);
		this.credentialInput = input;
		this.log = log || (() => {});
		this.token = null;
		this.tokenTime = 0;
		this.tokenRefreshPromise = null;
	}

	// --- Auth ---

	/** Authenticate with the Hoymiles cloud and obtain a session token. */
	async login(): Promise<string> {
		for (const challenge of this.credentials) {
			try {
				const token = await this.tryLogin(challenge);
				if (token) {
					this.token = token;
					this.tokenTime = Date.now();
					return this.token;
				}
			} catch {
				// Strategy failed (e.g. pre-inspect rejected), try next
			}
		}

		throw new Error("Login failed: all authentication strategies rejected");
	}

	/**
	 * Attempt a single login flow: pre-inspect to get nonce, then login with the given credential hash.
	 *
	 * @param challenge - The credential hash to use for authentication
	 * @returns The session token if successful, or null if the strategy was rejected
	 */
	private async tryLogin(challenge: string): Promise<string | null> {
		const preInsp = await this._post("/iam/pub/3/auth/pre-insp", { u: this.user });

		if (preInsp.status !== "0") {
			throw new Error(`Pre-inspect failed: ${preInsp.message}`);
		}

		const preData = assertData<PreInspectData>(preInsp.data, "Pre-inspect");
		const { n: nonce, a: salt } = preData;

		const ch = salt ? await buildArgon2Challenge(this.credentialInput, salt) : challenge;

		const result = await this._post<{ token?: string }>("/iam/pub/3/auth/login", {
			u: this.user,
			ch,
			n: nonce,
		});

		return result.status === "0" && result.data?.token ? result.data.token : null;
	}

	/** Re-login if the current token is older than 1 hour. */
	async ensureToken(): Promise<void> {
		if (this.tokenRefreshPromise) {
			return this.tokenRefreshPromise;
		}
		if (!this.token || Date.now() - this.tokenTime > TOKEN_MAX_AGE_MS) {
			this.tokenRefreshPromise = withTimeout(this.login(), ENSURE_TOKEN_TIMEOUT_MS, "ensureToken")
				.then(() => {})
				.catch(err => {
					this.token = null;
					throw err;
				})
				.finally(() => {
					this.tokenRefreshPromise = null;
				});
			return this.tokenRefreshPromise;
		}
	}

	/** Clear the current session token. */
	disconnect(): void {
		this.token = null;
	}

	// --- Data endpoints ---

	/** Fetch the list of stations (plants) for this account. */
	async getStationList(): Promise<CloudStation[]> {
		await this.ensureToken();
		const result = await this._post<{ list?: CloudStation[] }>("/pvm/api/0/station/select_by_page", {
			page: 1,
			page_size: 100,
		});
		if (result.status !== "0") {
			throw new Error(`Station list failed: ${result.message}`);
		}
		return result.data?.list || [];
	}

	/** @param stationId - Station ID to query */
	async getStationDetails(stationId: number): Promise<CloudStationDetails> {
		this.assertStationId(stationId);
		await this.ensureToken();
		const result = await this._post("/pvm/api/0/station/find", { id: stationId });
		if (result.status !== "0") {
			throw new Error(`Station details failed: ${result.message}`);
		}
		return assertData<CloudStationDetails>(result.data, "Station details");
	}

	/** @param stationId - Station ID to query */
	async getDeviceTree(stationId: number): Promise<CloudDeviceNode[]> {
		this.assertStationId(stationId);
		await this.ensureToken();
		const result = await this._post("/pvm/api/0/station/select_device_of_tree", {
			id: stationId,
		});
		if (result.status !== "0") {
			throw new Error(`Device tree failed: ${result.message}`);
		}
		return assertData<CloudDeviceNode[]>(result.data ?? [], "Device tree");
	}

	/**
	 * Get micro-inverter realtime data from daily chart (Protobuf response).
	 * Endpoint: /pvm-data/api/0/micro/data/count_by_day
	 * From app DeviceDetailActivity.F2(): T0(sid, date, mi_list, quota)
	 * Response is Protobuf LineChart with Float32 time series per quota.
	 *
	 * @param stationId - Cloud station ID
	 * @param microIds - Array of micro-inverter IDs (from device tree child.id)
	 * @param date - Date string YYYY-MM-DD
	 * @param quotas - Array of quota names (e.g. ["MI_POWER", "MI_TEMPERATURE"])
	 * @returns Map of quota name to last non-zero value
	 */
	async getMicroRealtimeData(
		stationId: number,
		microIds: number[],
		date: string,
		quotas: string[],
	): Promise<Record<string, number> | null> {
		this.assertStationId(stationId);
		await this.ensureToken();
		try {
			const rawBuf = await this._postBinary("/pvm-data/api/0/micro/data/count_by_day", {
				sid: stationId,
				date,
				mi_list: microIds,
				quota: quotas,
			});
			return await parseChartResponse(rawBuf, this.log);
		} catch (err) {
			this.log(`Micro chart error: ${err instanceof Error ? err.stack || err.message : errorMessage(err)}`);
			return null;
		}
	}

	private _postBinary(apiPath: string, body: Record<string, unknown>): Promise<Buffer> {
		return postBinary(new URL(apiPath, BASE_URL).href, body, { token: this.token });
	}

	/**
	 * Get per-PV-port daily chart data (Protobuf response).
	 * Endpoint: /pvm-data/api/0/module/data/count_by_day
	 * From app DeviceDetailActivity.H2(): U0(sid, date, mi_list, quota, port)
	 *
	 * @param stationId - Cloud station ID
	 * @param microId - Micro-inverter ID
	 * @param port - Port number (1-based)
	 * @param date - Date string YYYY-MM-DD
	 * @param quotas - Array of quota names (e.g. ["MODULE_POWER", "MODULE_V", "MODULE_I"])
	 * @returns Map of quota name to last value
	 */
	async getModuleRealtimeData(
		stationId: number,
		microId: number,
		port: number,
		date: string,
		quotas: string[],
	): Promise<Record<string, number> | null> {
		this.assertStationId(stationId);
		await this.ensureToken();
		try {
			const rawBuf = await this._postBinary("/pvm-data/api/0/module/data/count_by_day", {
				sid: stationId,
				date,
				mi_list: [{ id: microId, port }],
				quota: quotas,
			});
			return await parseChartResponse(rawBuf, this.log);
		} catch (err) {
			this.log(`Module chart error: ${errorMessage(err)}`);
			return null;
		}
	}

	/** @param stationId - Station ID to query */
	async getStationRealtime(stationId: number): Promise<CloudRealtimeData> {
		this.assertStationId(stationId);
		await this.ensureToken();
		const result = await this._post<CloudRealtimeData>("/pvm-data/api/0/station/data/count_station_real_data", {
			sid: stationId,
		});
		if (result.status !== "0") {
			throw new Error(`Realtime data failed: ${result.message}`);
		}
		return assertData<CloudRealtimeData>(result.data, "Realtime data");
	}

	/**
	 * Get weather data for station coordinates.
	 * Uses EU API server (euapi.hoymiles.com) which hosts the weather endpoint.
	 *
	 * @param lat - Station latitude
	 * @param lon - Station longitude
	 */
	async getWeather(lat: number, lon: number): Promise<WeatherData> {
		const result = await postJson<CloudApiResponse<WeatherData>>(
			EU_WEATHER_URL,
			{ lat, lon },
			{
				token: this.token,
			},
		);
		if (result.status !== "0") {
			throw new Error(`Weather request failed: ${result.message}`);
		}
		return assertData<WeatherData>(result.data, "Weather");
	}

	/**
	 * Check if firmware updates are available for a DTU.
	 *
	 * @param stationId - Station ID
	 * @param dtuSn - DTU serial number
	 */
	async checkFirmwareUpdate(stationId: number, dtuSn: string): Promise<FirmwareStatus> {
		this.assertStationId(stationId);
		if (!dtuSn) {
			throw new Error("Invalid dtuSn");
		}
		await this.ensureToken();
		const result = await this._post("/pvm/api/0/upgrade/compare", {
			sid: stationId,
			dtu_sn: dtuSn,
		});
		if (result.status !== "0") {
			throw new Error(`Firmware check failed: ${result.message}`);
		}
		return assertData<FirmwareStatus>(result.data ?? { upgrade: 0, done: 0, tid: "" }, "Firmware status");
	}

	// --- HTTP helpers ---

	private _post<T = Record<string, unknown>>(
		apiPath: string,
		body: Record<string, unknown>,
	): Promise<CloudApiResponse<T>> {
		return postJson<CloudApiResponse<T>>(new URL(apiPath, BASE_URL).href, body, { token: this.token });
	}
}

export default CloudConnection;
