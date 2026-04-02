const CRC16_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
    CRC16_TABLE[i] = crc;
}
export function crc16(data) {
    let crc = 0xffff;
    for (const byte of data) {
        crc = (crc >> 8) ^ CRC16_TABLE[(crc ^ byte) & 0xff];
    }
    return crc;
}
//# sourceMappingURL=crc16.js.map