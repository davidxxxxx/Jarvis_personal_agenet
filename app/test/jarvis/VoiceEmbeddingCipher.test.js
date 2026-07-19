const assert = require("node:assert/strict");
const test = require("node:test");

const VoiceEmbeddingCipher = require("../../src/jarvis/main/VoiceEmbeddingCipher");

function fakeSecretCrypto() {
  return {
    isAvailable: () => true,
    encrypt(value) {
      return Buffer.from(`protected:${Buffer.from(value, "utf8").toString("base64")}`, "utf8");
    },
    decrypt(value) {
      const text = Buffer.from(value).toString("utf8");
      if (!text.startsWith("protected:")) throw new Error("authentication failed");
      return {
        value: Buffer.from(text.slice("protected:".length), "base64").toString("utf8"),
        needsReencrypt: false,
      };
    },
  };
}

test("voice embedding cipher encrypts binary vectors and round-trips without plaintext bytes", () => {
  const cipher = new VoiceEmbeddingCipher({ secretCrypto: fakeSecretCrypto() });
  const plaintext = Buffer.from(new Float32Array([1, 0.5, -0.25]).buffer);

  const encrypted = cipher.encryptBuffer(plaintext);

  assert.equal(cipher.isEncrypted(encrypted), true);
  assert.equal(encrypted.includes(plaintext), false);
  assert.deepEqual(cipher.decryptBuffer(encrypted), plaintext);
  assert.deepEqual(cipher.decryptBuffer(plaintext), plaintext);
});

test("voice embedding cipher fails closed when encryption is unavailable or ciphertext is corrupt", () => {
  const unavailable = new VoiceEmbeddingCipher({
    secretCrypto: {
      isAvailable: () => false,
      encrypt() {
        throw new Error("unavailable");
      },
      decrypt() {
        throw new Error("unavailable");
      },
    },
  });
  assert.throws(
    () => unavailable.encryptBuffer(Buffer.from("private-vector")),
    (error) => error.code === "VOICE_EMBEDDING_ENCRYPTION_UNAVAILABLE"
  );

  const cipher = new VoiceEmbeddingCipher({ secretCrypto: fakeSecretCrypto() });
  const encrypted = cipher.encryptBuffer(Buffer.from("private-vector"));
  encrypted[encrypted.length - 1] ^= 0xff;
  assert.throws(
    () => cipher.decryptBuffer(encrypted),
    (error) => error.code === "VOICE_EMBEDDING_DECRYPTION_FAILED"
  );
});
