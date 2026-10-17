// Lưu dữ liệu trong trình duyệt và đồng bộ bản mã hoá lên repo GitHub để GitHub Actions gửi mail nhắc nợ.
import { encryptJson } from "./crypto.js";

const LOANS_KEY = "skv.loans";
const SETTINGS_KEY = "skv.settings";
export const SYNC_PATH = "data/loans.enc.json";

export const DEFAULT_SETTINGS = {
  email: "",
  remindDays: [3, 1, 0],
  remindOverdue: true,
  engine: "ocr",
  claudeKey: "",
  claudeModel: "claude-opus-5-5",
  ghOwner: "",
  ghRepo: "",
  ghToken: "",
  passphrase: "",
  autoSync: true,
  lastSync: "",
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const loadLoans = () => read(LOANS_KEY, []);
export const saveLoans = (loans) => write(LOANS_KEY, loans);

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
  // Trang chạy trên <owner>.github.io/<repo>: tự điền repo đích.
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m) {
    s.ghOwner ||= m[1];
    s.ghRepo ||= location.pathname.split("/").filter(Boolean)[0] || "";
  }
  return s;
}
export const saveSettings = (s) => write(SETTINGS_KEY, s);

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

export function syncConfigured(s) {
  return Boolean(s.ghOwner && s.ghRepo && s.ghToken && s.passphrase && s.email);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Ghi file mã hoá vào repo qua GitHub Contents API. Chỉ gửi những gì script nhắc nợ cần.
export async function pushEncrypted(loans, s) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { email: s.email, remindDays: s.remindDays, remindOverdue: s.remindOverdue },
    loans: loans.map(({ id, name, lender, contractNo, remaining, monthlyPayment, dueDate, status, cycle }) =>
      ({ id, name, lender, contractNo, remaining, monthlyPayment, dueDate, status, cycle })),
  };
  const envelope = await encryptJson(payload, s.passphrase);
  const api = `https://api.github.com/repos/${s.ghOwner}/${s.ghRepo}/contents/${SYNC_PATH}`;
  const headers = {
    Authorization: `Bearer ${s.ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let sha;
  const cur = await fetch(api, { headers, cache: "no-store" });
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw new Error(await describe(cur));

  const res = await fetch(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Cập nhật dữ liệu nhắc nợ (đã mã hoá)",
      content: utf8ToB64(JSON.stringify(envelope, null, 2) + "\n"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(await describe(res));
}

async function describe(res) {
  let msg = "";
  try { msg = (await res.json()).message; } catch { /* không có nội dung */ }
  if (res.status === 401) return "Token GitHub không hợp lệ hoặc đã hết hạn";
  if (res.status === 403 || res.status === 404) {
    return `GitHub từ chối (${res.status}): kiểm tra token có quyền Contents: Read and write cho repo này. ${msg}`;
  }
  return `Lỗi GitHub ${res.status}: ${msg}`;
}
