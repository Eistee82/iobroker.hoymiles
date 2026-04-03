import * as crypto from "node:crypto";

// Protocol-defined salt for AES key derivation — NOT a secret.
// Hardcoded in Hoymiles DTU firmware and S-Miles app.
const SALT_BUF = Buffer.from("123456", "utf-8");

/**
 * AES-128-CBC encryption for DTU communication (SHA256³ key derivation).
 *
 * **Cryptographic note:** Key and IV are derived deterministically from encRand,
 * msgId, and seqNum. If msgId/seqNum repeat after a reconnect, the same key/IV
 * pair will be reused. This is inherent to the Hoymiles protocol design and
 * cannot be changed without breaking compatibility with DTU firmware.
 */
class Encryption {
	private readonly encRand: Buffer;
	private readonly msgIdBuf: Buffer;
	private readonly seqBuf: Buffer;

	/** @param encRand - Random seed from DTU used for key derivation */
	constructor(encRand: Buffer | string) {
		if (typeof encRand === "string") {
			this.encRand = Buffer.from(encRand, "base64");
		} else {
			this.encRand = encRand;
		}
		this.msgIdBuf = Buffer.alloc(2);
		this.seqBuf = Buffer.alloc(2);
	}

	/**
	 * Check if encryption is required (bit 25 of dfs field).
	 *
	 * @param dfs - Device feature flags from DTU info response
	 */
	static isRequired(dfs: number | null | undefined): boolean {
		if (!dfs) {
			return false;
		}
		return ((Number(dfs) >> 25) & 1) === 1;
	}

	/**
	 * Apply SHA-256 three times to derive a 16-byte key/IV.
	 *
	 * @param data - Input buffer to hash
	 */
	private static tripleSha256(data: Buffer): Buffer {
		let hash = crypto.createHash("sha256").update(data).digest();
		hash = crypto.createHash("sha256").update(hash).digest();
		hash = crypto.createHash("sha256").update(hash).digest();
		return hash.subarray(0, 16);
	}

	/**
	 * Prepare the key material buffers with current msgId and seqNum.
	 *
	 * @param msgId - Message identifier
	 * @param seqNum - Sequence number
	 */
	private prepareMsgBuffers(msgId: number, seqNum: number): void {
		this.msgIdBuf.writeUInt16BE(msgId & 0xffff);
		this.seqBuf.writeUInt16BE(seqNum & 0xffff);
	}

	/** Derive AES-128 key from encRand + msgId + seqNum. */
	private deriveKey(): Buffer {
		return Encryption.tripleSha256(Buffer.concat([this.encRand, this.msgIdBuf, this.seqBuf]));
	}

	/** Derive IV from encRand + salt + msgId + seqNum. */
	private deriveIv(): Buffer {
		return Encryption.tripleSha256(Buffer.concat([this.encRand, SALT_BUF, this.msgIdBuf, this.seqBuf]));
	}

	/**
	 * Encrypt payload with AES-128-CBC (PKCS7 padding).
	 *
	 * @param payload - Data to encrypt
	 * @param msgId - Message ID for key derivation
	 * @param seqNum - Sequence number for key derivation
	 */
	encrypt(payload: Buffer, msgId: number, seqNum: number): Buffer {
		this.prepareMsgBuffers(msgId, seqNum);
		const key = this.deriveKey();
		const iv = this.deriveIv();
		const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
		cipher.setAutoPadding(true);
		return Buffer.concat([cipher.update(payload), cipher.final()]);
	}

	/**
	 * Decrypt payload with AES-128-CBC (PKCS7 unpadding).
	 *
	 * @param payload - Data to decrypt
	 * @param msgId - Message ID for key derivation
	 * @param seqNum - Sequence number for key derivation
	 * @throws {Error} If decryption fails (wrong key, corrupted data, invalid padding)
	 */
	decrypt(payload: Buffer, msgId: number, seqNum: number): Buffer {
		this.prepareMsgBuffers(msgId, seqNum);
		const key = this.deriveKey();
		const iv = this.deriveIv();
		const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
		decipher.setAutoPadding(true);
		return Buffer.concat([decipher.update(payload), decipher.final()]);
	}
}

export default Encryption;
