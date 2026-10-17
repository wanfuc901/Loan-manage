// Mô hình dữ liệu khoản vay: chuẩn hoá, tự suy ra các trường còn thiếu, kiểm tra thông tin bắt buộc.

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

const intOrNull = (v) => (v === "" || v == null || v === -1 || Number.isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));

export function normalizeLoan(l) {
  return {
    id: l.id || newId(),
    name: String(l.name || "").trim(),
    lender: String(l.lender || "").trim(),
    contractNo: String(l.contractNo || "").trim(),
    principal: Number(l.principal) || 0,
    remaining: Number(l.remaining) || 0,
    monthlyPayment: Number(l.monthlyPayment) || 0,
    interestRate: Number(l.interestRate) || 0,
    interestPeriod: l.interestPeriod === "month" ? "month" : "year",
    termMonths: Number(l.termMonths) || 0,
    paidPeriods: intOrNull(l.paidPeriods),
    dueDay: Math.min(31, Math.max(0, Math.round(Number(l.dueDay) || 0))),
    startDate: ISO_RE.test(l.startDate) ? l.startDate : "",
    dueDate: ISO_RE.test(l.dueDate) ? l.dueDate : "",
    cycle: l.cycle === "once" ? "once" : "monthly",
    status: l.status === "paid" ? "paid" : "active",
    note: String(l.note || ""),
    payments: Array.isArray(l.payments) ? l.payments : [],
    source: l.source || "manual",
    createdAt: l.createdAt || new Date().toISOString(),
    updatedAt: l.updatedAt || new Date().toISOString(),
  };
}

// ---------- Ngày tháng ----------

export function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseISO(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Cộng tháng, giữ ngày trong tháng (31/01 + 1 tháng -> 28/02 hoặc 29/02).
export function addMonths(isoDate, n) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function dayInMonth(year, monthIdx, day) {
  const last = new Date(year, monthIdx + 1, 0).getDate();
  return new Date(year, monthIdx, Math.min(day, last));
}

// Ngày trả thứ n (n >= 1) theo "ngày X hằng tháng", bắt đầu sau ngày giải ngân ít nhất 15 ngày.
function nthDueDate(startISO, dueDay, n) {
  const start = parseISO(startISO);
  let d = dayInMonth(start.getFullYear(), start.getMonth(), dueDay);
  while ((d - start) / 86400000 < 15) d = dayInMonth(d.getFullYear(), d.getMonth() + 1, dueDay);
  return dayInMonth(d.getFullYear(), d.getMonth() + n - 1, dueDay);
}

function nextOccurrence(dueDay, today) {
  let d = dayInMonth(today.getFullYear(), today.getMonth(), dueDay);
  if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
    d = dayInMonth(today.getFullYear(), today.getMonth() + 1, dueDay);
  }
  return d;
}

// Số kỳ lẽ ra đã đến hạn tính đến hôm nay.
function periodsElapsed(l, today) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let n = 0;
  while (n < 600) {
    const due = l.dueDay ? nthDueDate(l.startDate, l.dueDay, n + 1) : parseISO(addMonths(l.startDate, n + 1));
    if (due >= t) break;
    n++;
  }
  return n;
}

// Hạn kỳ sau: cộng 1 tháng, giữ đúng "ngày trả hằng tháng" (tránh 31 -> 28 -> 28...).
export function advanceDue(l) {
  if (!l.dueDate) return "";
  const next = addMonths(l.dueDate, 1);
  if (!l.dueDay) return next;
  const [y, m] = next.split("-").map(Number);
  return toISO(dayInMonth(y, m - 1, l.dueDay));
}

// ---------- Suy ra trường thiếu ----------

export function annuityPayment(principal, ratePct, period, n) {
  if (!principal || !n) return 0;
  const r = ratePct ? ratePct / 100 / (period === "month" ? 1 : 12) : 0;
  const pay = r > 0 ? (principal * r) / (1 - Math.pow(1 + r, -n)) : principal / n;
  return Math.ceil(pay / 1000) * 1000;
}

export function remainingPeriods(l) {
  return l.termMonths && l.paidPeriods != null ? Math.max(0, l.termMonths - l.paidPeriods) : null;
}

// Điền các trường còn trống bằng giá trị suy ra được; trả về danh sách trường là ước tính.
export function deriveLoan(input, today = new Date()) {
  const l = { ...input };
  const estimated = [];

  if (!l.dueDay && l.dueDate) l.dueDay = Number(l.dueDate.slice(8, 10));

  if (l.paidPeriods == null && l.startDate && l.cycle === "monthly") {
    let n = periodsElapsed(l, today);
    if (l.termMonths) n = Math.min(n, l.termMonths);
    l.paidPeriods = n;
    estimated.push("paidPeriods");
  }

  if (!l.dueDate) {
    let d = null;
    if (l.startDate && l.paidPeriods != null) {
      d = l.dueDay ? toISO(nthDueDate(l.startDate, l.dueDay, l.paidPeriods + 1)) : addMonths(l.startDate, l.paidPeriods + 1);
    } else if (l.dueDay) {
      d = toISO(nextOccurrence(l.dueDay, today));
    }
    if (d) {
      l.dueDate = d;
      if (!l.dueDay) l.dueDay = Number(d.slice(8, 10));
      estimated.push("dueDate");
    }
  }

  if (!l.monthlyPayment && l.principal && l.termMonths) {
    l.monthlyPayment = annuityPayment(l.principal, l.interestRate, l.interestPeriod, l.termMonths);
    estimated.push("monthlyPayment");
  }

  const left = remainingPeriods(l);
  if (!l.remaining && l.monthlyPayment && left != null) {
    l.remaining = l.monthlyPayment * left;
    estimated.push("remaining");
  }

  if (!l.name) {
    const amount = l.principal ? `${new Intl.NumberFormat("vi-VN").format(l.principal)}đ` : "";
    const date = l.startDate ? ` (${l.startDate.split("-").reverse().join("/")})` : "";
    l.name = [l.lender || "Khoản vay", amount].filter(Boolean).join(" ") + date;
  }
  return { loan: l, estimated };
}

// ---------- Thông tin bắt buộc ----------

export const REQUIRED = {
  remaining: "Tổng nợ còn lại",
  monthlyPayment: "Số tiền trả mỗi tháng",
  paidPeriods: "Số kỳ đã trả",
  termMonths: "Tổng số kỳ",
  dueDate: "Ngày trả",
};

export function missingRequired(l) {
  const miss = [];
  if (l.status === "paid") return miss;
  if (!(l.remaining > 0)) miss.push("remaining");
  if (!(l.monthlyPayment > 0)) miss.push("monthlyPayment");
  if (l.paidPeriods == null) miss.push("paidPeriods");
  if (!(l.termMonths > 0)) miss.push("termMonths");
  if (!l.dueDate) miss.push("dueDate");
  return miss;
}
