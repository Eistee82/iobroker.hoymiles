import * as net from "node:net";
import * as os from "node:os";
import { DTU_TIME_OFFSET, HM_MAGIC_0, HM_MAGIC_1 } from "./constants.js";
import { crc16 } from "./crc16.js";
import { unixSeconds } from "./utils.js";

interface DiscoveredDevice {
	host: string;
	dtuSerial: string;
}

/**
 * Encode a protobuf varint.
 *
 * @param value - Integer value to encode
 */
function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	while (value > 0x7f) {
		bytes.push((value & 0x7f) | 0x80);
		value >>>= 7;
	}
	bytes.push(value & 0x7f);
	return Buffer.from(bytes);
}

/** Build a minimal HM-framed InfoRequest to identify a DTU. */
function buildInfoRequest(): Buffer {
	const payload = Buffer.concat([
		Buffer.from([0x10]),
		encodeVarint(DTU_TIME_OFFSET),
		Buffer.from([0x28]),
		encodeVarint(unixSeconds()),
	]);
	const crc = crc16(payload);
	const totalLen = 10 + payload.length;
	const header = Buffer.alloc(10);
	header[0] = HM_MAGIC_0;
	header[1] = HM_MAGIC_1;
	header[2] = 0xa3;
	header[3] = 0x01; // InfoData request
	header[4] = 0x00;
	header[5] = 0x01; // seq
	header[6] = (crc >> 8) & 0xff;
	header[7] = crc & 0xff;
	header[8] = (totalLen >> 8) & 0xff;
	header[9] = totalLen & 0xff;
	return Buffer.concat([header, payload]);
}

/**
 * Try to connect to a single host on port 10081 and identify it as a Hoymiles DTU.
 *
 * @param host - IP address to probe
 * @param timeoutMs - Connection timeout in milliseconds
 * @returns Discovered device or null
 */
function probeHost(host: string, timeoutMs: number): Promise<DiscoveredDevice | null> {
	return new Promise(resolve => {
		const socket = new net.Socket();
		socket.setTimeout(timeoutMs);
		let resolved = false;

		const done = (result: DiscoveredDevice | null): void => {
			if (!resolved) {
				resolved = true;
				socket.destroy();
				resolve(result);
			}
		};

		socket.on("connect", () => {
			socket.write(buildInfoRequest());
		});

		const chunks: Buffer[] = [];
		let totalLength = 0;
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			totalLength += chunk.length;
			// Need at least 10 bytes for a valid HM header
			if (totalLength < 10) {
				return;
			}
			const buffer = Buffer.concat(chunks, totalLength);
			if (buffer[0] === HM_MAGIC_0 && buffer[1] === HM_MAGIC_1 && buffer[2] === 0xa2 && buffer[3] === 0x01) {
				let dtuSerial = "";
				try {
					const payload = buffer.subarray(10);
					// Field 1 (tag 0x0a) = length-delimited string = DTU serial
					if (
						payload.length >= 2 &&
						payload[0] === 0x0a &&
						payload[1] > 0 &&
						payload.length >= 2 + payload[1]
					) {
						dtuSerial = payload.subarray(2, 2 + payload[1]).toString("ascii");
					}
				} catch {
					// Parse errors are expected for non-Hoymiles devices — serial stays empty
				}
				done({ host, dtuSerial });
			}
		});

		socket.on("timeout", () => done(null));
		socket.on("error", () => done(null));
		socket.on("close", () => done(null));

		socket.connect(10081, host);
	});
}

/**
 * Get all local IPv4 /24 subnet base addresses.
 *
 * @returns Array of subnet base addresses (e.g. "192.168.1.")
 */
function getLocalSubnets(): string[] {
	const subnets = new Set<string>();
	const interfaces = os.networkInterfaces();
	for (const iface of Object.values(interfaces)) {
		if (!iface) {
			continue;
		}
		for (const addr of iface) {
			if (addr.family === "IPv4" && !addr.internal) {
				const parts = addr.address.split(".");
				if (parts.length === 4) {
					subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.`);
				}
			}
		}
	}
	return [...subnets];
}

/**
 * Scan all local /24 subnets for Hoymiles DTUs on port 10081.
 *
 * @param timeoutMs - Per-host timeout in milliseconds (default 1500)
 * @param concurrency - Max parallel connections (default 50)
 * @param onProgress - Optional callback for progress updates
 * @returns Array of discovered devices
 */
async function discoverDtus(
	timeoutMs = 1500,
	concurrency = 50,
	onProgress?: (scanned: number, total: number) => void,
): Promise<DiscoveredDevice[]> {
	const subnets = getLocalSubnets();
	if (subnets.length === 0) {
		return [];
	}

	// Build list of all IPs to scan
	const hosts: string[] = [];
	for (const subnet of subnets) {
		for (let i = 1; i <= 254; i++) {
			hosts.push(`${subnet}${i}`);
		}
	}

	const results: DiscoveredDevice[] = [];
	let scanned = 0;

	// Scan with limited concurrency
	for (let i = 0; i < hosts.length; i += concurrency) {
		const batch = hosts.slice(i, i + concurrency);
		const batchResults = await Promise.all(batch.map(host => probeHost(host, timeoutMs)));
		for (const result of batchResults) {
			if (result) {
				results.push(result);
			}
		}
		scanned += batch.length;
		if (onProgress) {
			onProgress(scanned, hosts.length);
		}
	}

	return results;
}

export { discoverDtus, probeHost };
export type { DiscoveredDevice };
