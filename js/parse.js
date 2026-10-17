// Bóc tách thông tin khoản vay từ văn bản OCR / PDF (tiếng Việt, có hoặc không dấu) bằng từ khoá + biểu thức chính quy.
// Kết quả chỉ là gợi ý: người dùng luôn xác nhận lại trước khi lưu.

export function normalize(s) {
  return s
    .normalize("NFC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

const LENDERS = [
  "Home Credit", "FE Credit", "HD Saison", "Mcredit", "Shinhan Finance", "Mirae Asset",
  "Lotte Finance", "VietCredit", "Easy Credit", "Toyota Financial", "Tima", "Doctor Dong",
  "SEasy", "MoMo", "ZaloPay", "ShopeePay", "SPayLater", "Lazada", "Kredivo", "Fundiin", "Atome",
  "Home PayLater", "Cake", "Timo", "TNEX", "Vietcombank", "Techcombank", "VPBank", "TPBank",
  "MB Bank", "BIDV", "Agribank", "VietinBank", "ACB", "Sacombank", "SHB", "HDBank", "VIB",
  "OCB", "SeABank", "MSB", "Eximbank", "LPBank", "Nam A Bank", "Bac A Bank", "PVcomBank",
  "Shinhan Bank", "HSBC", "Standard Chartered", "UOB", "Citibank",
];

const KEYWORDS = {
  remaining: [
    "du no con lai", "du no hien tai", "du no", "no goc con lai", "so tien con lai",
    "tong du no", "tong no con lai", "tong so tien con phai tra", "outstanding", "remaining balance",
    "current balance",
  ],
  monthlyPayment: [
    "so tien thanh toan/thang", "so tien thanh toan / thang", "so tien thanh toan hang thang",
    "so tien tra hang thang", "so tien tra no hang ky", "so tien moi ky", "tien gop hang thang",
    "gop hang thang", "tra hang thang", "so tien can thanh toan", "so tien can thanh", "so tien phai tra",
    "can thanh toan", "phai thanh toan", "thanh toan ky nay", "so tien ky nay", "thanh toan toi thieu",
    "amount due", "minimum payment", "monthly payment", "installment",
  ],
  principal: [
    "tong so tien giai ngan", "tong so tien giai", "so tien giai ngan", "so tien cho vay",
    "so tien de nghi vay", "so tien vay", "khoan vay", "tien vay", "han muc", "goc vay",
    "tong tien vay", "loan amount", "principal", "credit limit",
  ],
  dueDate: [
    "ngay den han thanh toan", "ngay den han thanh", "ngay den han", "han thanh toan", "ngay thanh toan",
    "han tra", "ngay tra", "han chot", "due date", "payment date", "pay by",
  ],
  startDate: [
    "giai ngan vao ngay", "ngay giai ngan", "thoi han vay phe duyet", "thoi han vay phe", "ngay phe duyet",
    "ngay nhan no", "ngay vay", "ngay bat dau", "ngay ky", "disbursement date", "start date",
  ],
  interest: ["lai suat cho vay trong han", "lai suat", "interest rate", "interest"],
  term: ["thoi han cho vay", "thoi han vay", "ky han", "so ky", "tenor", "term"],
  contractNo: [
    "so hop dong", "ma hop dong", "hop dong so", "ma khoan vay", "so hd", "contract no",
    "contract number", "loan id",
  ],
};

// Ưu tiên khớp từ khoá dài trước để "du no con lai" không bị "du no" chiếm.
for (const k of Object.keys(KEYWORDS)) KEYWORDS[k].sort((a, b) => b.length - a.length);

const MONEY_RE =
  /(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(trieu|tr\b|nghin|ngan|k\b|ty\b)?\s*(vnd|vnđ|đ|d\b|₫|dong)?/gi;

// Trả về danh sách số tiền (VND) kèm vị trí, tìm thấy trong chuỗi đã chuẩn hoá.
function amountMatches(normLine) {
  const out = [];
  for (const m of normLine.matchAll(MONEY_RE)) {
    const [whole, numRaw, unit, currency] = m;
    const grouped = /^\d{1,3}([.,\s]\d{3})+$/.test(numRaw);
    // Tiền tố "đ" kiểu đ2.000.000 (đã chuẩn hoá thành "d")
    const prefixed = /(^|[^a-z])d\s?$/.test(normLine.slice(Math.max(0, m.index - 2), m.index));
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
      } else if (!currency && !prefixed) {
        continue; // số trần không đơn vị: dễ là ngày tháng, mã số, số điện thoại
      }
    }
    if (!Number.isFinite(value) || value < 1000) continue;
    const before = normLine[m.index - 1];
    const after = normLine[m.index + numRaw.length];
    if (before === "/" || after === "/" || before === ":" || after === ":") continue;
    out.push({ value: Math.round(value), index: m.index, end: m.index + whole.length });
  }
  return out;
}

export function findAmounts(normLine) {
  return amountMatches(normLine).map((a) => a.value);
}

// Năm bị thiếu (vd "20 Th04"): lấy năm hiện tại, nếu ra ngày quá xa trong tương lai thì lùi 1 năm.
function inferYear(d, mo) {
  const now = new Date();
  let y = now.getFullYear();
  if (new Date(y, mo - 1, d) - now > 60 * 86400000) y -= 1;
  return y;
}

function iso(y, mo, d) {
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function findDate(normLine) {
  let m = normLine.match(/(?<![\d/])(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4}|\d{2})(?![\d/])/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  // "ngay 11 thang 10 nam 2026", "20 Th04 2026", "20 thg 4, 2026", "20 tháng 4"
  m = normLine.match(/(?<!\d)(\d{1,2})\s*(?:th|thg|thang)\.?\s*0?(\d{1,2})(?!\d)(?:[\s,\/.-]*(?:nam\s*)?(\d{4}))?/);
  if (m) return iso(m[3] ? +m[3] : inferYear(+m[1], +m[2]), +m[2], +m[1]);
  return null;
}

function findPercent(normLine) {
  const m = normLine.match(/(\d{1,3}(?:[.,]\d{1,3})?)\s*%/);
  if (!m) return null;
  const rate = Number(m[1].replace(",", "."));
  const period = /thang|month/.test(normLine) && !/nam|year/.test(normLine) ? "month" : "year";
  return { rate, period };
}

function findTerm(normLine) {
  const m = normLine.match(/(?<!ngay\s{0,2})(?<![\d/])(\d{1,3})\s*(thang|ky|months?)\b/);
  return m ? Number(m[1]) : null;
}

function findContract(rawLine) {
  const m = rawLine.match(/[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{5,})\s*$/i) || rawLine.match(/\b([A-Z]{0,4}\d{6,}[A-Z0-9]*)\b/i);
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
// Ngày tháng còn được thử trên phần sau từ khoá nối với dòng kế (OCR hay tách "20 Th04" / "2026").
function searchField(field, normLines, rawLines, used) {
  const kind = FIELD_KIND[field] ?? field;
  for (const kw of KEYWORDS[field]) {
    for (let i = 0; i < normLines.length; i++) {
      const pos = normLines[i].indexOf(kw);
      if (pos === -1) continue;
      const restNorm = normLines[i].slice(pos + kw.length);
      const restRaw = rawLines[i].slice(Math.min(rawLines[i].length, pos + kw.length));
      const candidates = [];
      if (kind === "date" && i + 1 < normLines.length) candidates.push([`${restNorm} ${normLines[i + 1]}`, restRaw, i]);
      candidates.push([restNorm, restRaw, i]);
      for (let j = 1; j <= 2 && i + j < normLines.length; j++) {
        candidates.push([normLines[i + j], rawLines[i + j], i + j]);
      }
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

// Các mẫu câu hay gặp trên app vay, tìm trên toàn khối văn bản (đã nối dòng).
function findPatterns(joined) {
  const out = {};
  let m;
  // "6/12 đã thanh toán", "đã trả 6/12 kỳ"
  if ((m = joined.match(/(\d{1,3})\s*\/\s*(\d{1,3})\s*(?:ky\s*)?da\s*(?:thanh\s*toan|tra)/)) ||
      (m = joined.match(/da\s*(?:thanh\s*toan|tra)\s*:?\s*(\d{1,3})\s*\/\s*(\d{1,3})/))) {
    out.paidPeriods = +m[1];
    out.termMonths = +m[2];
  } else if ((m = joined.match(/\bky\s*(?:thanh\s*toan|tra\s*no|hien\s*tai)?\s*:?\s*(?:thu\s*)?(\d{1,3})\s*\/\s*(\d{1,3})(?!\s*[\/\d])/)) && +m[1] <= +m[2]) {
    // "Kỳ thanh toán 3/24": đang ở kỳ 3 => đã trả 2 kỳ
    out.paidPeriods = Math.max(0, +m[1] - 1);
    out.termMonths = +m[2];
  } else if ((m = joined.match(/da\s*(?:thanh\s*toan|tra)\s*:?\s*(\d{1,3})\s*ky/))) {
    out.paidPeriods = +m[1];
  }
  if ((m = joined.match(/con\s*(?:lai\s*)?:?\s*(\d{1,3})\s*ky/))) out.remainingPeriods = +m[1];

  // "đ230.985 đến hạn vào ngày 20 mỗi tháng"
  const dueDayRe = /(?:den\s*han|phai\s*tra|can\s*tra|thanh\s*toan|tra)\s*(?:vao\s*)?ngay\s*(\d{1,2})\s*(?:hang|moi)\s*thang/;
  if ((m = joined.match(dueDayRe))) {
    out.dueDay = +m[1];
    const amounts = amountMatches(joined.slice(Math.max(0, m.index - 40), m.index + 1));
    if (amounts.length) out.monthlyPayment = amounts[amounts.length - 1].value;
  } else if ((m = joined.match(/ngay\s*(\d{1,2})\s*(?:hang|moi)\s*thang/))) {
    out.dueDay = +m[1];
  }
  return out;
}

export function detectLender(text) {
  // Hợp đồng ghi rõ bên cho vay: Công ty Tài chính ... (“TIN VAY”), hoặc dòng sau "BÊN CHO VAY:".
  // Ưu tiên trước danh sách tên vì hợp đồng hay nhắc tên ví/ngân hàng nhận giải ngân.
  let m = text.match(/C[ôo]ng ty[^\n]{0,120}?\(\s*[“"']([^”"'\n]{2,30})[”"']\s*\)/i);
  if (m) return m[1].trim();
  m = text.match(/B[ÊE]N CHO VAY\s*:?\s*\n\s*([^\n]{4,90})/i);
  if (m) return m[1].trim();
  const n = normalize(text);
  for (const name of LENDERS) {
    const key = normalize(name).replace(/\s+/g, "\\s*");
    if (new RegExp(`\\b${key}\\b`).test(n)) return name;
  }
  return "";
}

// Dòng chỉ gồm một số tiền (vd "đ2.000.000"): đầu mục của một khoản vay trong danh sách.
function isAmountHeader(norm) {
  const a = amountMatches(norm);
  if (a.length !== 1) return false;
  const rest = (norm.slice(0, a[0].index) + norm.slice(a[0].end)).replace(/[^a-z]/g, "");
  return rest.length <= 2;
}

const LIST_SIGNAL = /moi thang|hang thang|da thanh toan|giai ngan|den han/;

// Ảnh danh sách nhiều khoản vay: tách thành từng khối, mỗi khối bắt đầu bằng một dòng số tiền.
function splitBlocks(rawLines, normLines) {
  const heads = normLines.map((n, i) => (isAmountHeader(n) ? i : -1)).filter((i) => i >= 0);
  if (heads.length < 2) return null;
  const blocks = heads.map((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : normLines.length;
    return { raw: rawLines.slice(h, end), norm: normLines.slice(h, end) };
  });
  const withSignal = blocks.filter((b) => LIST_SIGNAL.test(b.norm.join(" ")));
  if (withSignal.length < 2 || withSignal.length < blocks.length - 1) return null;
  return { prefix: rawLines.slice(0, heads[0]).join("\n"), blocks: withSignal };
}

function parseBlock(rawLines, normLines, { document = false, header = false, lenderHint = "" } = {}) {
  const used = new Set();
  const found = {};
  const joined = normLines.join(" ");
  const pat = findPatterns(joined);

  for (const f of ["remaining", "monthlyPayment", "principal", "dueDate", "startDate", "interest", "term", "contractNo"]) {
    if (f === "monthlyPayment" && pat.monthlyPayment) continue;
    found[f] = searchField(f, normLines, rawLines, used);
  }
  if (found.startDate && found.dueDate === found.startDate) found.dueDate = null;
  // Khối trong danh sách: dòng đầu là số tiền vay.
  if (header && found.principal == null) found.principal = findAmounts(normLines[0])[0] ?? null;
  if (document && found.startDate == null) found.startDate = normLines.slice(0, 12).map(findDate).find(Boolean) ?? null;
  if (found.dueDate == null && pat.dueDay == null && !document) {
    found.dueDate = normLines.map(findDate).find((d) => d && d !== found.startDate) ?? null;
  }
  if (!header && found.principal == null && found.remaining == null && !document) {
    const all = normLines.flatMap(findAmounts).filter((v) => v !== (pat.monthlyPayment ?? found.monthlyPayment));
    if (all.length) found.principal = Math.max(...all);
  }

  const lender = lenderHint || detectLender(rawLines.join("\n"));
  const loan = {
    name: "",
    lender,
    contractNo: found.contractNo || "",
    principal: found.principal ?? 0,
    remaining: found.remaining ?? 0,
    monthlyPayment: pat.monthlyPayment ?? found.monthlyPayment ?? 0,
    interestRate: found.interest?.rate ?? 0,
    interestPeriod: found.interest?.period ?? "year",
    termMonths: pat.termMonths ?? found.term ?? (pat.remainingPeriods != null && pat.paidPeriods != null ? pat.paidPeriods + pat.remainingPeriods : 0),
    paidPeriods: pat.paidPeriods ?? (pat.remainingPeriods != null && found.term ? found.term - pat.remainingPeriods : null),
    dueDay: pat.dueDay ?? 0,
    startDate: found.startDate || "",
    dueDate: found.dueDate || "",
    note: "",
  };
  // Đánh dấu trường nào thực sự đọc được để giao diện tô màu các trường cần kiểm tra.
  const detected = {
    lender: Boolean(lender), contractNo: Boolean(loan.contractNo), principal: Boolean(loan.principal),
    remaining: Boolean(loan.remaining), monthlyPayment: Boolean(loan.monthlyPayment),
    interestRate: Boolean(loan.interestRate), termMonths: Boolean(loan.termMonths),
    paidPeriods: loan.paidPeriods != null, dueDay: Boolean(loan.dueDay),
    startDate: Boolean(loan.startDate), dueDate: Boolean(loan.dueDate),
  };
  return { loan, detected, rawText: rawLines.join("\n") };
}

// Trả về danh sách khoản vay (1 hoặc nhiều nếu ảnh là danh sách).
// document=true: văn bản hợp đồng PDF, luôn coi là một khoản vay.
export function parseLoans(text, { document = false } = {}) {
  const rawLines = text.normalize("NFC").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const normLines = rawLines.map(normalize);
  if (!document) {
    const split = splitBlocks(rawLines, normLines);
    if (split) {
      const lenderHint = detectLender(split.prefix);
      return split.blocks.map((b) => parseBlock(b.raw, b.norm, { header: true, lenderHint }));
    }
  }
  return [parseBlock(rawLines, normLines, { document })];
}

// Giữ tương thích: phân tích như một khoản vay duy nhất.
export function parseLoanText(text) {
  return parseLoans(text)[0];
}
