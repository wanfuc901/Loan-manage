// Bóc tách thông tin khoản vay từ văn bản OCR (tiếng Việt/Anh) bằng từ khoá + biểu thức chính quy.
// Kết quả chỉ là gợi ý: người dùng luôn xác nhận lại trước khi lưu.

export function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

const LENDERS = [
  "Home Credit", "FE Credit", "HD Saison", "Mcredit", "Shinhan Finance", "Mirae Asset",
  "Lotte Finance", "VietCredit", "Easy Credit", "Toyota Financial", "Tima", "Doctor Dong",
  "MoMo", "ZaloPay", "ShopeePay", "SPayLater", "Lazada", "Kredivo", "Fundiin", "Atome",
  "Home PayLater", "Cake", "Timo", "TNEX", "Vietcombank", "Techcombank", "VPBank", "TPBank",
  "MB Bank", "BIDV", "Agribank", "VietinBank", "ACB", "Sacombank", "SHB", "HDBank", "VIB",
  "OCB", "SeABank", "MSB", "Eximbank", "LPBank", "Nam A Bank", "Bac A Bank", "PVcomBank",
  "Shinhan Bank", "HSBC", "Standard Chartered", "UOB", "Citibank",
];

const KEYWORDS = {
  remaining: [
    "du no con lai", "du no hien tai", "du no", "no goc con lai", "so tien con lai", "con lai",
    "tong du no", "tong no", "outstanding", "remaining balance", "current balance",
  ],
  monthlyPayment: [
    "so tien can thanh toan", "so tien thanh toan", "so tien phai tra", "can thanh toan",
    "phai thanh toan", "tien gop", "gop hang thang", "tra hang thang", "khoan tra hang thang",
    "thanh toan ky nay", "so tien ky nay", "ky nay", "thanh toan toi thieu", "amount due",
    "minimum payment", "monthly payment", "installment",
  ],
  principal: [
    "so tien vay", "so tien giai ngan", "khoan vay", "tien vay", "han muc", "goc vay",
    "tong tien vay", "loan amount", "principal", "credit limit",
  ],
  dueDate: [
    "ngay den han", "han thanh toan", "ngay thanh toan", "han tra", "ngay tra", "den han",
    "han chot", "due date", "payment date", "pay by",
  ],
  startDate: ["ngay giai ngan", "ngay vay", "ngay bat dau", "ngay ky", "disbursement date", "start date"],
  interest: ["lai suat", "interest rate", "interest", "lai"],
  term: ["ky han", "thoi han vay", "thoi han", "so ky", "tenor", "term"],
  contractNo: ["so hop dong", "ma hop dong", "hop dong so", "ma khoan vay", "so hd", "contract no", "contract number", "loan id"],
};

// Ưu tiên khớp từ khoá dài trước để "du no con lai" không bị "con lai" chiếm.
for (const k of Object.keys(KEYWORDS)) KEYWORDS[k].sort((a, b) => b.length - a.length);

const MONEY_RE =
  /(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(trieu|tr\b|nghin|ngan|k\b|ty\b)?\s*(vnd|vnđ|đ|d\b|₫|dong)?/gi;

// Trả về danh sách số tiền (VND) tìm thấy trong chuỗi đã chuẩn hoá.
export function findAmounts(normLine) {
  const out = [];
  for (const m of normLine.matchAll(MONEY_RE)) {
    const [, numRaw, unit, currency] = m;
    const grouped = /[.,\s]\d{3}$/.test(numRaw) && /^\d{1,3}([.,\s]\d{3})+$/.test(numRaw);
    let value;
    if (grouped && !unit) {
      value = Number(numRaw.replace(/[.,\s]/g, ""));
    } else {
      value = Number(numRaw.replace(",", "."));
      if (unit) {
        const u = unit.toLowerCase();
        if (u === "trieu" || u === "tr") value *= 1e6;
        else if (u === "ty") value *= 1e9;
        else value *= 1e3;
      } else if (!currency) {
        continue; // số trần không đơn vị: dễ là ngày tháng, mã số, số điện thoại
      }
    }
    if (!Number.isFinite(value) || value < 1000) continue;
    // Bỏ các số nằm trong ngày tháng kiểu 15/10/2026
    const before = normLine[m.index - 1];
    const after = normLine[m.index + numRaw.length];
    if (before === "/" || after === "/") continue;
    out.push(Math.round(value));
  }
  return out;
}

export function findDate(normLine) {
  let m = normLine.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})\b/);
  if (!m) m = normLine.match(/ngay\s*(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/);
  if (!m) return null;
  let [, d, mo, y] = m.map(Number);
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function findPercent(normLine) {
  const m = normLine.match(/(\d{1,2}(?:[.,]\d{1,3})?)\s*%/);
  if (!m) return null;
  const rate = Number(m[1].replace(",", "."));
  const period = /thang|month/.test(normLine) && !/nam|year/.test(normLine) ? "month" : "year";
  return { rate, period };
}

function findTerm(normLine) {
  const m = normLine.match(/(\d{1,3})\s*(thang|ky|months?)\b/);
  return m ? Number(m[1]) : null;
}

function findContract(rawLine) {
  const m = rawLine.match(/[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{5,})\s*$/i);
  return m && /\d/.test(m[1]) ? m[1] : null;
}

const EXTRACTORS = {
  remaining: (n) => findAmounts(n)[0] ?? null,
  monthlyPayment: (n) => findAmounts(n)[0] ?? null,
  principal: (n) => findAmounts(n)[0] ?? null,
  dueDate: findDate,
  startDate: findDate,
  interest: findPercent,
  term: findTerm,
  contractNo: (n, raw) => findContract(raw),
};

// Một dòng giá trị (số tiền / ngày) chỉ được gán cho một trường cùng loại.
const FIELD_KIND = {
  remaining: "amount", monthlyPayment: "amount", principal: "amount",
  dueDate: "date", startDate: "date",
};

// Tìm từ khoá trong dòng i; giá trị lấy ở phần sau từ khoá, nếu không có thì xem 2 dòng kế tiếp.
function searchField(field, normLines, rawLines, used) {
  for (const kw of KEYWORDS[field]) {
    for (let i = 0; i < normLines.length; i++) {
      const pos = normLines[i].indexOf(kw);
      if (pos === -1) continue;
      if (field === "interest" && kw === "lai" && !/%/.test(normLines[i])) continue;
      const restNorm = normLines[i].slice(pos + kw.length);
      const restRaw = rawLines[i].slice(Math.min(rawLines[i].length, pos + kw.length));
      const candidates = [[restNorm, restRaw, i]];
      for (let j = 1; j <= 2 && i + j < normLines.length; j++) {
        candidates.push([normLines[i + j], rawLines[i + j], i + j]);
      }
      const kind = FIELD_KIND[field] ?? field;
      for (const [n, raw, lineNo] of candidates) {
        const key = `${kind}:${lineNo}`;
        if (used.has(key) && lineNo !== i) continue;
        const v = EXTRACTORS[field](n, raw);
        if (v != null) {
          used.add(key);
          return v;
        }
      }
    }
  }
  return null;
}

export function detectLender(text) {
  const n = normalize(text);
  for (const name of LENDERS) {
    const key = normalize(name).replace(/\s+/g, "\\s*");
    if (new RegExp(`\\b${key}\\b`).test(n)) return name;
  }
  return "";
}

export function parseLoanText(text) {
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const normLines = rawLines.map(normalize);
  const used = new Set();
  const found = {};

  // Thứ tự quan trọng: các nhãn cụ thể hơn được dò trước.
  for (const f of ["remaining", "monthlyPayment", "principal", "dueDate", "startDate", "interest", "term", "contractNo"]) {
    found[f] = searchField(f, normLines, rawLines, used);
  }

  if (found.principal == null && found.remaining == null) {
    const all = normLines.flatMap(findAmounts);
    if (all.length) found.principal = Math.max(...all);
  }
  if (found.dueDate == null) {
    found.dueDate = normLines.map(findDate).find(Boolean) ?? null;
  }

  const lender = detectLender(text);
  const loan = {
    name: lender ? `Khoản vay ${lender}` : "",
    lender,
    contractNo: found.contractNo || "",
    principal: found.principal ?? found.remaining ?? 0,
    remaining: found.remaining ?? found.principal ?? 0,
    monthlyPayment: found.monthlyPayment ?? 0,
    interestRate: found.interest?.rate ?? 0,
    interestPeriod: found.interest?.period ?? "year",
    termMonths: found.term ?? 0,
    startDate: found.startDate || "",
    dueDate: found.dueDate || "",
    note: "",
  };
  // Đánh dấu trường nào thực sự đọc được để giao diện tô màu các trường cần kiểm tra.
  const detected = Object.fromEntries(
    Object.entries({
      lender: lender || null, contractNo: found.contractNo, principal: found.principal,
      remaining: found.remaining, monthlyPayment: found.monthlyPayment,
      interestRate: found.interest, termMonths: found.term, startDate: found.startDate,
      dueDate: found.dueDate,
    }).map(([k, v]) => [k, v != null])
  );
  return { loan, detected };
}
