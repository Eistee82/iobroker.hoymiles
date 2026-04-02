import * as net from "node:net";
import * as os from "node:os";
import { DTU_TIME_OFFSET, HM_MAGIC_0, HM_MAGIC_1 } from "./constants.js";
import { crc16 } from "./crc16.js";
import { unixSeconds } from "./utils.js";
function encodeVarint(value) {
    const bytes = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
}
function buildInfoRequest() {
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
    header[3] = 0x01;
    header[4] = 0x00;
    header[5] = 0x01;
    header[6] = (crc >> 8) & 0xff;
    header[7] = crc & 0xff;
    header[8] = (totalLen >> 8) & 0xff;
    header[9] = totalLen & 0xff;
    return Buffer.concat([header, payload]);
}
function probeHost(host, timeoutMs) {
    return new Promise(resolve => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        let resolved = false;
        const done = (result) => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(result);
            }
        };
        socket.on("connect", () => {
            socket.write(buildInfoRequest());
        });
        const chunks = [];
        let totalLength = 0;
        socket.on("data", (chunk) => {
            chunks.push(chunk);
            totalLength += chunk.length;
            if (totalLength < 10) {
                return;
            }
            const buffer = Buffer.concat(chunks, totalLength);
            if (buffer[0] === HM_MAGIC_0 && buffer[1] === HM_MAGIC_1 && buffer[2] === 0xa2 && buffer[3] === 0x01) {
                let dtuSerial = "";
                try {
                    const payload = buffer.subarray(10);
                    if (payload.length >= 2 &&
                        payload[0] === 0x0a &&
                        payload[1] > 0 &&
                        payload.length >= 2 + payload[1]) {
                        dtuSerial = payload.subarray(2, 2 + payload[1]).toString("ascii");
                    }
                }
                catch {
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
function getLocalSubnets() {
    const subnets = new Set();
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
async function discoverDtus(timeoutMs = 1500, concurrency = 50, onProgress) {
    const subnets = getLocalSubnets();
    if (subnets.length === 0) {
        return [];
    }
    const hosts = [];
    for (const subnet of subnets) {
        for (let i = 1; i <= 254; i++) {
            hosts.push(`${subnet}${i}`);
        }
    }
    const results = [];
    let scanned = 0;
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
//# sourceMappingURL=networkDiscovery.js.map