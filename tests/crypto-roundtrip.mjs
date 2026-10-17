// Mã hoá bằng js/crypto.js (giống trình duyệt) rồi ghi file để Python giải mã.
import { writeFileSync } from "node:fs";
import { encryptJson, decryptJson } from "../js/crypto.js";
const pad = (d) => d.toISOString().slice(0, 10);
const now = new Date(Date.now() + 7 * 3600e3);
const plus = (n) => pad(new Date(now.getTime() + n * 86400e3));
const payload = {
  version: 1, settings: { email: "test@example.com", remindDays: [3, 1, 0], remindOverdue: true },
  loans: [
    { id: "a", name: "Vay Home Credit", lender: "Home Credit", contractNo: "380123", remaining: 9250000, monthlyPayment: 1350000, dueDate: plus(3), status: "active", cycle: "monthly" },
    { id: "b", name: "SPayLater", lender: "SPayLater", contractNo: "", remaining: 850000, monthlyPayment: 0, dueDate: plus(-2), status: "active", cycle: "once" },
    { id: "c", name: "Không nhắc", lender: "MoMo", remaining: 500000, monthlyPayment: 500000, dueDate: plus(10), status: "active", cycle: "monthly" },
    { id: "d", name: "Tiếng Việt có dấu đ ơ ư", lender: "", remaining: 1, monthlyPayment: 1, dueDate: plus(0), status: "active", cycle: "monthly" },
  ],
};
const env = await encryptJson(payload, "mật khẩu thử");
const back = await decryptJson(env, "mật khẩu thử");
if (back.loans.length !== 4) throw new Error("roundtrip JS failed");
writeFileSync(process.argv[2], JSON.stringify(env));
console.log("JS ok");
