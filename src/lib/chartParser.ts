import * as path from "node:path";
import protobuf from "protobufjs";
import { round1 } from "./convert.js";
import { errorMessage } from "./utils.js";

/**
 * Find the last positive value in an array, rounded to one decimal place.
 *
 * @param arr - Array of numeric values
 */
function lastPositive(arr: number[]): number | undefined {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i] > 0) {
			return round1(arr[i]);
		}
	}
	return undefined;
}

let chartRoot: protobuf.Root | null = null;

/**
 * Load the Chart.proto definition (cached after first load).
 */
async function ensureChartProto(): Promise<protobuf.Root> {
	if (!chartRoot) {
		const protoDir = path.join(import.meta.dirname, "proto");
		chartRoot = await protobuf.load(path.join(protoDir, "Chart.proto"));
	}
	return chartRoot;
}

/**
 * Parse a Protobuf chart response (LineChart or ChartV2 format).
 * Extracts the last non-zero value per quota/series type.
 *
 * @param rawBuf - Raw Protobuf response buffer
 * @param log - Debug log callback
 * @returns Map of quota name to last non-zero value
 */
async function parseChartResponse(rawBuf: Buffer, log?: (msg: string) => void): Promise<Record<string, number>> {
	const result: Record<string, number> = {};
	if (!rawBuf || rawBuf.length < 50) {
		return result;
	}

	let root: protobuf.Root;
	try {
		root = await ensureChartProto();
	} catch (err) {
		log?.(`Failed to load Chart proto: ${err instanceof Error ? err.message : String(err)}`);
		return result;
	}

	// Try LineChart format first (used by the app: ChartPB.LineChart.parseFrom)
	// LineChart has: x_axis (strings), series (LineSeries[]), type
	// LineSeries has: type (string), data (float[]), did, port
	try {
		const LineChart = root.lookupType("LineChart");
		const decoded = LineChart.decode(rawBuf);
		const chart = LineChart.toObject(decoded, { longs: Number, defaults: true });
		const series = (chart.series || []) as Array<{ type: string; data: number[] }>;
		for (const s of series) {
			if (s.data && s.data.length > 0) {
				const val = lastPositive(s.data);
				if (val !== undefined) {
					result[s.type] = val;
				}
			}
		}
		return result;
	} catch (err) {
		log?.(`LineChart parse failed, trying ChartV2: ${errorMessage(err)}`);
	}

	// Fallback: try ChartV2 format
	try {
		const ChartV2 = root.lookupType("ChartV2");
		const decoded = ChartV2.decode(rawBuf);
		const obj = ChartV2.toObject(decoded, { longs: Number, defaults: true });
		const dataArr = (obj.data || []) as number[];
		const quota = (obj.quota || "") as string;
		if (dataArr.length > 0 && quota) {
			const val = lastPositive(dataArr);
			if (val !== undefined) {
				result[quota] = val;
			}
		}
	} catch (err2) {
		log?.(`ChartV2 parse also failed: ${errorMessage(err2)}`);
	}

	return result;
}

export { parseChartResponse };
