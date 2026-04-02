import * as path from "node:path";
import protobuf from "protobufjs";
import { round1 } from "./convert.js";
import { errorMessage } from "./utils.js";
function lastPositive(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] > 0) {
            return round1(arr[i]);
        }
    }
    return undefined;
}
let chartRoot = null;
async function ensureChartProto() {
    if (!chartRoot) {
        const protoDir = path.join(import.meta.dirname, "proto");
        chartRoot = await protobuf.load(path.join(protoDir, "Chart.proto"));
    }
    return chartRoot;
}
async function parseChartResponse(rawBuf, log) {
    const result = {};
    if (!rawBuf || rawBuf.length < 50) {
        return result;
    }
    let root;
    try {
        root = await ensureChartProto();
    }
    catch (err) {
        log?.(`Failed to load Chart proto: ${err instanceof Error ? err.message : String(err)}`);
        return result;
    }
    try {
        const LineChart = root.lookupType("LineChart");
        const decoded = LineChart.decode(rawBuf);
        const chart = LineChart.toObject(decoded, { longs: Number, defaults: true });
        const series = (chart.series || []);
        for (const s of series) {
            if (s.data && s.data.length > 0) {
                const val = lastPositive(s.data);
                if (val !== undefined) {
                    result[s.type] = val;
                }
            }
        }
        return result;
    }
    catch (err) {
        log?.(`LineChart parse failed, trying ChartV2: ${errorMessage(err)}`);
    }
    try {
        const ChartV2 = root.lookupType("ChartV2");
        const decoded = ChartV2.decode(rawBuf);
        const obj = ChartV2.toObject(decoded, { longs: Number, defaults: true });
        const dataArr = (obj.data || []);
        const quota = (obj.quota || "");
        if (dataArr.length > 0 && quota) {
            const val = lastPositive(dataArr);
            if (val !== undefined) {
                result[quota] = val;
            }
        }
    }
    catch (err2) {
        log?.(`ChartV2 parse also failed: ${errorMessage(err2)}`);
    }
    return result;
}
export { parseChartResponse };
//# sourceMappingURL=chartParser.js.map