// ed25519 验签 —— 用 Workers 原生 WebCrypto（无需 nodejs_compat）。

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 验证 message(UTF-8) 是否由 pubKey(base64 raw 32B) 对应私钥签名（sig base64）。 */
export async function verifyEd25519(
  pubKeyB64: string,
  message: string,
  sigB64: string,
): Promise<boolean> {
  if (!pubKeyB64 || !sigB64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(pubKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64ToBytes(sigB64),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/** 生成 URL-safe 随机串（令牌 / bearer）。 */
export function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
