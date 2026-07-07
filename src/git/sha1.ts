/**
 * SHA-1 hashing using Web Crypto API (crypto.subtle).
 * Used for standard git object ID computation.
 */

/** Convert a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert a hex string to a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export async function sha1(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-1", toBufferSource(data));
  return hexFromBuffer(hashBuffer);
}

export function hexFromBuffer(buffer: ArrayBuffer): string {
  return bytesToHex(new Uint8Array(buffer));
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
