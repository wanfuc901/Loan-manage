// Mã hoá dữ liệu trước khi đồng bộ lên GitHub (AES-256-GCM, khoá sinh từ mật khẩu bằng PBKDF2-SHA256).
// Định dạng này được reminder/send_reminders.py giải mã lại, hai bên phải khớp nhau.

const ITERATIONS = 250000;

function toB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(obj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return {
    format: "skv-aesgcm-v1",
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    data: toB64(cipher),
  };
}

export async function decryptJson(envelope, passphrase) {
  const key = await deriveKey(passphrase, fromB64(envelope.salt), envelope.iterations);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(envelope.iv) }, key, fromB64(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
