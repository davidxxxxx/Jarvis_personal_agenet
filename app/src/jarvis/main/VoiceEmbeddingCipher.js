const MAGIC = Buffer.from("JVE1", "ascii");

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class VoiceEmbeddingCipher {
  constructor({ secretCrypto } = {}) {
    if (
      !secretCrypto ||
      typeof secretCrypto.isAvailable !== "function" ||
      typeof secretCrypto.encrypt !== "function" ||
      typeof secretCrypto.decrypt !== "function"
    ) {
      throw new TypeError("secretCrypto encryption backend is required");
    }
    this.secretCrypto = secretCrypto;
  }

  isEncrypted(value) {
    return (
      (Buffer.isBuffer(value) || value instanceof Uint8Array) &&
      value.byteLength > MAGIC.length &&
      Buffer.from(value.buffer, value.byteOffset, MAGIC.length).equals(MAGIC)
    );
  }

  encryptBuffer(value) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError("voice embedding plaintext must be binary");
    }
    if (!this.secretCrypto.isAvailable()) {
      throw codedError(
        "VOICE_EMBEDDING_ENCRYPTION_UNAVAILABLE",
        "voice embedding encryption is unavailable"
      );
    }
    const privateCopy = Buffer.from(value);
    try {
      const encrypted = this.secretCrypto.encrypt(privateCopy.toString("base64"));
      if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) {
        throw new Error("encryption backend returned invalid data");
      }
      return Buffer.concat([MAGIC, Buffer.from(encrypted)]);
    } finally {
      privateCopy.fill(0);
    }
  }

  decryptBuffer(value) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw new TypeError("stored voice embedding must be binary");
    }
    if (!this.isEncrypted(value)) return Buffer.from(value);
    try {
      const encrypted = Buffer.from(
        value.buffer,
        value.byteOffset + MAGIC.length,
        value.byteLength - MAGIC.length
      );
      const decrypted = this.secretCrypto.decrypt(encrypted)?.value;
      if (typeof decrypted !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(decrypted)) {
        throw new Error("decrypted voice embedding is invalid");
      }
      const plaintext = Buffer.from(decrypted, "base64");
      if (plaintext.length === 0 || plaintext.length % Float32Array.BYTES_PER_ELEMENT !== 0) {
        plaintext.fill(0);
        throw new Error("decrypted voice embedding length is invalid");
      }
      return plaintext;
    } catch {
      throw codedError(
        "VOICE_EMBEDDING_DECRYPTION_FAILED",
        "voice embedding decryption failed"
      );
    }
  }
}

module.exports = VoiceEmbeddingCipher;
module.exports.VOICE_EMBEDDING_MAGIC = MAGIC;
