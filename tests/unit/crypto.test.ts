import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../src/crypto/credentials";

const KEY = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="; // 32 bytes

describe("credential encryption (AES-256-GCM)", () => {
  it("round-trips a secret", async () => {
    const ct = await encryptSecret(KEY, "espn_s2-super-secret-value%2Fwith%2Fescapes");
    expect(ct).not.toContain("secret");
    expect(await decryptSecret(KEY, ct)).toBe("espn_s2-super-secret-value%2Fwith%2Fescapes");
  });

  it("produces distinct ciphertexts per call (random IV)", async () => {
    const a = await encryptSecret(KEY, "same-input");
    const b = await encryptSecret(KEY, "same-input");
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext", async () => {
    const ct = await encryptSecret(KEY, "value");
    const bytes = atob(ct).split("");
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === "A" ? "B" : "A";
    const tampered = btoa(bytes.join(""));
    await expect(decryptSecret(KEY, tampered)).rejects.toThrow();
  });

  it("rejects a wrong-size key", async () => {
    await expect(encryptSecret(btoa("short"), "value")).rejects.toThrow(/32 bytes/);
  });
});
