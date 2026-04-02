import { postJson, postBinary } from "./httpClient.js";
import { parseChartResponse } from "./chartParser.js";
import { TOKEN_MAX_AGE_MS, ENSURE_TOKEN_TIMEOUT_MS } from "./constants.js";
import { errorMessage, withTimeout, buildCredentialChallenges, buildArgon2Challenge } from "./utils.js";
const BASE_URL = "https://neapi.hoymiles.com";
const EU_WEATHER_URL = "https://euapi.hoymiles.com/tpa/api/0/weather/get";
function assertData(data, label) {
    if (data == null || typeof data !== "object") {
        throw new Error(`${label}: expected object, got ${typeof data}`);
    }
    return data;
}
class CloudConnection {
    token;
    user;
    credentials;
    credentialInput;
    log;
    tokenTime;
    tokenRefreshPromise;
    assertStationId(stationId) {
        if (!stationId || stationId <= 0) {
            throw new Error("Invalid stationId");
        }
    }
    constructor(user, password, log) {
        this.user = user;
        const input = Buffer.from(password);
        this.credentials = buildCredentialChallenges(input);
        this.credentialInput = input;
        this.log = log || (() => { });
        this.token = null;
        this.tokenTime = 0;
        this.tokenRefreshPromise = null;
    }
    async login() {
        for (const challenge of this.credentials) {
            try {
                const token = await this.tryLogin(challenge);
                if (token) {
                    this.token = token;
                    this.tokenTime = Date.now();
                    return this.token;
                }
            }
            catch {
            }
        }
        throw new Error("Login failed: all authentication strategies rejected");
    }
    async tryLogin(challenge) {
        const preInsp = await this._post("/iam/pub/3/auth/pre-insp", { u: this.user });
        if (preInsp.status !== "0") {
            throw new Error(`Pre-inspect failed: ${preInsp.message}`);
        }
        const preData = assertData(preInsp.data, "Pre-inspect");
        const { n: nonce, a: salt } = preData;
        const ch = salt ? await buildArgon2Challenge(this.credentialInput, salt) : challenge;
        const result = await this._post("/iam/pub/3/auth/login", {
            u: this.user,
            ch,
            n: nonce,
        });
        return result.status === "0" && result.data?.token ? result.data.token : null;
    }
    async ensureToken() {
        if (this.tokenRefreshPromise) {
            return this.tokenRefreshPromise;
        }
        if (!this.token || Date.now() - this.tokenTime > TOKEN_MAX_AGE_MS) {
            this.tokenRefreshPromise = withTimeout(this.login(), ENSURE_TOKEN_TIMEOUT_MS, "ensureToken")
                .then(() => { })
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
    disconnect() {
        this.token = null;
    }
    async getStationList() {
        await this.ensureToken();
        const result = await this._post("/pvm/api/0/station/select_by_page", {
            page: 1,
            page_size: 100,
        });
        if (result.status !== "0") {
            throw new Error(`Station list failed: ${result.message}`);
        }
        return result.data?.list || [];
    }
    async getStationDetails(stationId) {
        this.assertStationId(stationId);
        await this.ensureToken();
        const result = await this._post("/pvm/api/0/station/find", { id: stationId });
        if (result.status !== "0") {
            throw new Error(`Station details failed: ${result.message}`);
        }
        return assertData(result.data, "Station details");
    }
    async getDeviceTree(stationId) {
        this.assertStationId(stationId);
        await this.ensureToken();
        const result = await this._post("/pvm/api/0/station/select_device_of_tree", {
            id: stationId,
        });
        if (result.status !== "0") {
            throw new Error(`Device tree failed: ${result.message}`);
        }
        return assertData(result.data ?? [], "Device tree");
    }
    async getMicroRealtimeData(stationId, microIds, date, quotas) {
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
        }
        catch (err) {
            this.log(`Micro chart error: ${err instanceof Error ? err.stack || err.message : errorMessage(err)}`);
            return null;
        }
    }
    _postBinary(apiPath, body) {
        return postBinary(new URL(apiPath, BASE_URL).href, body, { token: this.token });
    }
    async getModuleRealtimeData(stationId, microId, port, date, quotas) {
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
        }
        catch (err) {
            this.log(`Module chart error: ${errorMessage(err)}`);
            return null;
        }
    }
    async getStationRealtime(stationId) {
        this.assertStationId(stationId);
        await this.ensureToken();
        const result = await this._post("/pvm-data/api/0/station/data/count_station_real_data", {
            sid: stationId,
        });
        if (result.status !== "0") {
            throw new Error(`Realtime data failed: ${result.message}`);
        }
        return assertData(result.data, "Realtime data");
    }
    async getWeather(lat, lon) {
        const result = await postJson(EU_WEATHER_URL, { lat, lon }, {
            token: this.token,
        });
        if (result.status !== "0") {
            throw new Error(`Weather request failed: ${result.message}`);
        }
        return assertData(result.data, "Weather");
    }
    async checkFirmwareUpdate(stationId, dtuSn) {
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
        return assertData(result.data ?? { upgrade: 0, done: 0, tid: "" }, "Firmware status");
    }
    _post(apiPath, body) {
        return postJson(new URL(apiPath, BASE_URL).href, body, { token: this.token });
    }
}
export default CloudConnection;
//# sourceMappingURL=cloudConnection.js.map