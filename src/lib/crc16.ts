/** Pre-computed CRC-16/MODBUS lookup table (polynomial 0xA001). */
const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
	let crc = i;
	for (let j = 0; j < 8; j++) {
		crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
	}
	CRC16_TABLE[i] = crc;
}

/**
 * CRC-16/MODBUS, table-driven.
 *
 * @param data - Buffer to calculate CRC over
 */
export function crc16(data: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of data) {
		crc = (crc >> 8) ^ CRC16_TABLE[(crc ^ byte) & 0xff];
	}
	return crc;
}
