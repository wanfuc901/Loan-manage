// Kiểm thử bộ bóc tách với văn bản giống đầu ra OCR thực tế (số liệu đã thay đổi, không phải dữ liệu thật).
import assert from "node:assert/strict";
import { parseLoans, parseLoanText, findAmounts, findDate, normalize } from "../js/parse.js";
import { deriveLoan, normalizeLoan, missingRequired, advanceDue } from "../js/loan.js";

const TODAY = new Date(2026, 9, 18); // 18/10/2026
const derive = (r) => deriveLoan(normalizeLoan(r.loan), TODAY);

// 1. Màn hình chi tiết đơn giản
{
  const r = parseLoanText(`Home Credit
Hợp đồng số: 3801234567
Số tiền vay 15.000.000 đ
Dư nợ còn lại
9.250.000đ
Số tiền cần thanh toán
1.350.000 đ
Ngày đến hạn: 05/11/2026
Lãi suất 2,5%/tháng
Kỳ hạn 12 tháng
Ngày giải ngân 05/12/2025`);
  assert.equal(r.loan.lender, "Home Credit");
  assert.equal(r.loan.principal, 15000000);
  assert.equal(r.loan.remaining, 9250000);
  assert.equal(r.loan.monthlyPayment, 1350000);
  assert.equal(r.loan.dueDate, "2026-11-05");
  assert.equal(r.loan.startDate, "2025-12-05");
  assert.equal(r.loan.interestRate, 2.5);
  assert.equal(r.loan.interestPeriod, "month");
  assert.equal(r.loan.termMonths, 12);
  assert.equal(r.loan.contractNo, "3801234567");
}

// 2. Ảnh danh sách nhiều khoản vay (kiểu SEasy), chữ "x/y đã thanh toán" nằm chung dòng với năm
{
  const list = parseLoans(`04:54 & 5e Œ2
< SEasy Vay Tiền Nhanh © 4
đ3.000.000
Giải ngần vào ngày 12 Th04
2026 6/12 đã thanh toán >
đ310.500 đến hạn vào ngày
12 mỗi tháng
đ1.500.000
Giải ngân vào ngày 31 Th05
2026 4/6 đã thanh toán >
đ288.000 đến hạn vào ngày 1
mỗi tháng`);
  assert.equal(list.length, 2);
  const [a, b] = list.map(derive);
  assert.equal(a.loan.lender, "SEasy");
  assert.equal(a.loan.principal, 3000000);
  assert.equal(a.loan.monthlyPayment, 310500);
  assert.equal(a.loan.paidPeriods, 6);
  assert.equal(a.loan.termMonths, 12);
  assert.equal(a.loan.dueDay, 12);
  assert.equal(a.loan.startDate, "2026-04-12");
  assert.equal(a.loan.dueDate, "2026-11-12");
  assert.equal(a.loan.remaining, 310500 * 6);
  assert.deepEqual(a.estimated.sort(), ["dueDate", "remaining"]);
  assert.deepEqual(missingRequired(a.loan), []);
  // Giải ngân 31/05, trả ngày 1 hằng tháng: kỳ đầu 01/07, đã trả 4 kỳ => kỳ tới 01/11
  assert.equal(b.loan.dueDay, 1);
  assert.equal(b.loan.dueDate, "2026-11-01");
  assert.equal(b.loan.remaining, 288000 * 2);
}

// 3. Màn hình chi tiết, nhãn và giá trị bị OCR tách dòng, "Kỳ thanh toán 3/24" = đang ở kỳ 3
{
  const [r] = parseLoans(`04:53 ¢ 0! 56 &D
¬ Vay nhanh &
Số tiên cần thanh 2.150.000đ
toán
Mã hợp đồng 1234509876
Mã thanh toán AB12CD
Ngày đến hạn thanh 15/11/2026
toán
Trạng thái khoản vay Đang hoạt động
Tổng số tiền giải 30.000.000 đ
ngân
Bảo hiểm khoản vay Có
Thời hạn vay phê 15/08/2026
duyệt
Lãi suất/năm 45%
Số tiền thanh toán/ 2.150.000đ
tháng
Kỳ thanh toán 3/24`);
  const { loan } = derive(r);
  assert.equal(loan.contractNo, "1234509876");
  assert.equal(loan.principal, 30000000);
  assert.equal(loan.monthlyPayment, 2150000);
  assert.equal(loan.dueDate, "2026-11-15");
  assert.equal(loan.startDate, "2026-08-15");
  assert.equal(loan.interestRate, 45);
  assert.equal(loan.interestPeriod, "year");
  assert.equal(loan.paidPeriods, 2);
  assert.equal(loan.termMonths, 24);
  assert.equal(loan.remaining, 2150000 * 22);
  assert.deepEqual(missingRequired(loan), []);
}

// 4. Văn bản hợp đồng PDF
{
  const [r] = parseLoans(`ĐỀ NGHỊ VAY KIÊM HỢP ĐỒNG TÍN DỤNG
Số hợp đồng: AB12345678901
Ngày 05 tháng 10 năm 2026
Họ và tên: Nguyễn Văn A Ngày/tháng/năm sinh: 01-01-2000
Lương/thu nhập chính (nguồn trả nợ) hàng tháng: 12,000,000 VNĐ/tháng
Tôi đề nghị Công ty Tài chính Tổng hợp Cổ phần Ví Dụ (“VIDU”) xem xét hồ sơ
3. Số tiền đề nghị vay: 6,000,000 VND (Bằng chữ: Sáu triệu đồng)
4. Thời hạn vay: 6 tháng
6. Lãi suất vay: Theo quy định của VIDU
ĐIỀU 1: NỘI DUNG KHOẢN CẤP TÍN DỤNG
3. Số tiền cho vay: 6,000,000 VND (Bằng chữ: Sáu triệu đồng)
6. Thời hạn cho vay: 6 tháng kể từ ngày tiếp theo của Ngày giải ngân
7. Lãi suất, phí áp dụng với khoản vay của Khách hàng:
a. Lãi suất cho vay trong hạn: 36%/năm theo phương thức dư nợ giảm dần.
TIN VAY giải ngân vào Ví điện tử MOMO của Khách hàng`, { document: true });
  const { loan, estimated } = derive(r);
  assert.equal(loan.lender, "VIDU");
  assert.equal(loan.contractNo, "AB12345678901");
  assert.equal(loan.principal, 6000000);
  assert.equal(loan.termMonths, 6);
  assert.equal(loan.interestRate, 36);
  assert.equal(loan.startDate, "2026-10-05");
  assert.equal(loan.paidPeriods, 0);
  assert.equal(loan.dueDate, "2026-11-05");
  // Trả góp đều 6 kỳ, lãi 3%/tháng, làm tròn lên nghìn đồng
  assert.equal(loan.monthlyPayment, 1108000);
  assert.equal(loan.remaining, 1108000 * 6);
  assert.deepEqual(estimated.sort(), ["dueDate", "monthlyPayment", "paidPeriods", "remaining"]);
}

// 5. OCR không dấu, đơn vị "triệu"
{
  const r = parseLoanText(`SPayLater
Tong du no 2,5 trieu
Han thanh toan 10-11-2026
Can thanh toan: 850,000 VND`);
  assert.equal(r.loan.remaining, 2500000);
  assert.equal(r.loan.monthlyPayment, 850000);
  assert.equal(r.loan.dueDate, "2026-11-10");
}

// Tiện ích
assert.deepEqual(findAmounts(normalize("Ngày 15/10/2026 mã 0912345678")), []);
assert.deepEqual(findAmounts(normalize("đ230.985 đến hạn")), [230985]);
assert.equal(findDate(normalize("Giải ngân vào ngày 20 Th04 2026")), "2026-04-20");
assert.equal(findDate(normalize("Ngày 11 tháng 10 năm 2026")), "2026-10-11");
assert.equal(advanceDue({ dueDate: "2026-02-28", dueDay: 31 }), "2026-03-31");
assert.deepEqual(missingRequired(normalizeLoan({ remaining: 1, monthlyPayment: 1, termMonths: 2, dueDate: "2026-11-01" })), ["paidPeriods"]);

console.log("OK");
