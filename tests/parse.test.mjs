import assert from "node:assert/strict";
import { parseLoanText, findAmounts, normalize } from "../js/parse.js";

const sample1 = `Home Credit
Hợp đồng số: 3801234567
Số tiền vay 15.000.000 đ
Dư nợ còn lại
9.250.000đ
Số tiền cần thanh toán
1.350.000 đ
Ngày đến hạn: 05/11/2026
Lãi suất 2,5%/tháng
Kỳ hạn 12 tháng
Ngày giải ngân 05/12/2025`;
const r1 = parseLoanText(sample1);
assert.equal(r1.loan.lender, "Home Credit");
assert.equal(r1.loan.principal, 15000000);
assert.equal(r1.loan.remaining, 9250000);
assert.equal(r1.loan.monthlyPayment, 1350000);
assert.equal(r1.loan.dueDate, "2026-11-05");
assert.equal(r1.loan.startDate, "2025-12-05");
assert.equal(r1.loan.interestRate, 2.5);
assert.equal(r1.loan.interestPeriod, "month");
assert.equal(r1.loan.termMonths, 12);
assert.equal(r1.loan.contractNo, "3801234567");

// OCR không dấu, đơn vị "triệu"
const sample2 = `SPayLater
Tong du no 2,5 trieu
Han thanh toan 10-11-2026
Can thanh toan: 850,000 VND`;
const r2 = parseLoanText(sample2);
assert.equal(r2.loan.remaining, 2500000);
assert.equal(r2.loan.monthlyPayment, 850000);
assert.equal(r2.loan.dueDate, "2026-11-10");

assert.deepEqual(findAmounts(normalize("Ngày 15/10/2026 mã 0912345678")), []);
console.log("OK");
