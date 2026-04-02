import * as crypto from "node:crypto";
const SALT_BUF = Buffer.from("123456", "utf-8");
class Encryption {
    encRand;
    msgIdBuf;
    seqBuf;
    constructor(encRand) {
        if (typeof encRand === "string") {
            this.encRand = Buffer.from(encRand, "base64");
        }
        else {
            this.encRand = encRand;
        }
        this.msgIdBuf = Buffer.alloc(2);
        this.seqBuf = Buffer.alloc(2);
    }
    static isRequired(dfs) {
        if (!dfs) {
            return false;
        }
        return ((Number(dfs) >> 25) & 1) === 1;
    }
    static tripleSha256(data) {
        let hash = crypto.createHash("sha256").update(data).digest();
        hash = crypto.createHash("sha256").update(hash).digest();
        hash = crypto.createHash("sha256").update(hash).digest();
        return hash.subarray(0, 16);
    }
    prepareMsgBuffers(msgId, seqNum) {
        this.msgIdBuf.writeUInt16BE(msgId & 0xffff);
        this.seqBuf.writeUInt16BE(seqNum & 0xffff);
    }
    deriveKey() {
        return Encryption.tripleSha256(Buffer.concat([this.encRand, this.msgIdBuf, this.seqBuf]));
    }
    deriveIv() {
        return Encryption.tripleSha256(Buffer.concat([this.encRand, SALT_BUF, this.msgIdBuf, this.seqBuf]));
    }
    encrypt(payload, msgId, seqNum) {
        this.prepareMsgBuffers(msgId, seqNum);
        const key = this.deriveKey();
        const iv = this.deriveIv();
        const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
        cipher.setAutoPadding(true);
        return Buffer.concat([cipher.update(payload), cipher.final()]);
    }
    decrypt(payload, msgId, seqNum) {
        this.prepareMsgBuffers(msgId, seqNum);
        const key = this.deriveKey();
        const iv = this.deriveIv();
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        return Buffer.concat([decipher.update(payload), decipher.final()]);
    }
}
export default Encryption;
//# sourceMappingURL=encryption.js.map