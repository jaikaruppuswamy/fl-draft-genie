// AES-256-GCM encryption for the ESPN cookie pair (constitution: security constraints).
// Ciphertext format: base64(iv[12] || ciphertext+tag).

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64decode(keyB64);
  if (raw.byteLength !== 32) {
    throw new Error("CREDENTIAL_KEY must decode to exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  const joined = new Uint8Array(12 + ct.byteLength);
  joined.set(iv, 0);
  joined.set(new Uint8Array(ct), 12);
  return b64encode(joined);
}

export async function decryptSecret(keyB64: string, payloadB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const joined = b64decode(payloadB64);
  const iv = joined.slice(0, 12);
  const ct = joined.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}
