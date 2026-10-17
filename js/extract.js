// Đọc ảnh chụp màn hình / PDF hợp đồng và trích xuất khoản vay bằng một trong ba cách:
// OCR miễn phí trong trình duyệt (Tesseract.js), AI Claude, hoặc AI Groq (cần API key riêng).
import { parseLoans } from "./parse.js";

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const ANTHROPIC_SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.130.0/+esm";
const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const GROQ_API = "https://api.groq.com/openai/v1";
export const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";

// Hợp đồng dài chục trang nhưng thông tin khoản vay nằm ở vài trang đầu.
const PDF_MAX_PAGES = 6;
const PDF_MAX_CHARS = 20000;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Không tải được ${src}`));
    document.head.appendChild(s);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Ảnh không hợp lệ")); };
    img.src = url;
  });
}

function toCanvas(source, scale = 1) {
  const c = document.createElement("canvas");
  c.width = Math.round(source.width * scale);
  c.height = Math.round(source.height * scale);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

export const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// ---------- Đọc đầu vào ----------

let pdfjsPromise = null;

async function readPdf(file) {
  pdfjsPromise ??= import(PDFJS_URL).then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return m;
  });
  const pdfjs = await pdfjsPromise;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;

  let text = "";
  for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES) && text.length < PDF_MAX_CHARS; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("") + "\n";
  }

  const render = async (i) => {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas");
    c.width = viewport.width;
    c.height = viewport.height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return c;
  };

  const first = await render(1);
  if (text.replace(/\s/g, "").length >= 200) {
    return { kind: "text", text: text.slice(0, PDF_MAX_CHARS), images: [first], document: true };
  }
  // PDF dạng ảnh scan: dùng ảnh các trang đầu.
  const images = [first];
  for (let i = 2; i <= Math.min(doc.numPages, 3); i++) images.push(await render(i));
  return { kind: "images", images, document: true };
}

export async function readInput(file) {
  if (isPdf(file)) return readPdf(file);
  return { kind: "images", images: [toCanvas(await loadImage(file))], document: false };
}

// ---------- OCR ----------

// Chuẩn bị ảnh cho OCR: phóng to ảnh hẹp, chuyển xám, đảo màu ảnh nền tối, rồi kéo giãn tương phản
// để chữ xám nhạt (vd "6/12 đã thanh toán") vẫn đọc được.
function prepareForOcr(source) {
  // Ảnh hẹp phóng to cho chữ rõ; ảnh chụp bằng camera rất lớn thì thu nhỏ để OCR nhanh, đỡ tốn bộ nhớ trên điện thoại.
  const longSide = Math.max(source.width, source.height);
  const scale = source.width < 1100 ? Math.min(2, 3000 / longSide) : Math.min(1, 3000 / longSide);
  const c = toCanvas(source, scale);
  const ctx = c.getContext("2d");
  const px = ctx.getImageData(0, 0, c.width, c.height);
  const d = px.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = g;
    hist[g]++;
  }
  const total = d.length / 4;
  const median = (() => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total / 2) return v; } return 255; })();
  const invert = median < 110;
  const bg = invert ? 255 - median : median;
  const stretch = bg >= 180;
  const lo = bg - 105, hi = bg - 20;
  for (let i = 0; i < d.length; i += 4) {
    let g = invert ? 255 - d[i] : d[i];
    if (stretch) g = Math.max(0, Math.min(255, ((g - lo) * 255) / (hi - lo)));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(px, 0, 0);
  return c;
}

let workerPromise = null;
let progressHandler = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker(["vie", "eng"], 1, {
        logger: (m) => progressHandler?.(m),
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Tải sẵn Tesseract + dữ liệu tiếng Việt khi người dùng mở tab Thêm, để lần đọc đầu tiên nhanh hơn.
export function warmUpOcr() {
  const start = () => getWorker().catch(() => { /* thử lại khi đọc thật */ });
  if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 2000 });
  else setTimeout(start, 800);
}

async function ocrImages(images, onProgress) {
  progressHandler = onProgress;
  const worker = await getWorker();
  const texts = [];
  for (const img of images) texts.push((await worker.recognize(prepareForOcr(img))).data.text);
  return texts.join("\n");
}

// ---------- AI (Claude / Groq) ----------

const FIELD_DOC = `Mỗi khoản vay là một object có đúng các khoá:
- name (string): tên ngắn gọn, rỗng nếu không rõ
- lender (string): tên ngân hàng / công ty tài chính / app cho vay (không phải ví hay ngân hàng nhận tiền giải ngân)
- contractNo (string): số / mã hợp đồng
- principal (number): số tiền vay / giải ngân ban đầu, VND
- remaining (number): dư nợ hoặc tổng số tiền còn phải trả NẾU được ghi rõ, ngược lại 0
- monthlyPayment (number): số tiền phải trả mỗi kỳ (mỗi tháng), VND
- interestRate (number): lãi suất, đơn vị %
- interestPeriod ("year" | "month"): lãi suất tính theo năm hay theo tháng
- termMonths (number): tổng số kỳ / số tháng vay
- paidPeriods (number): số kỳ đã thanh toán, -1 nếu không rõ
- dueDay (number): ngày trả hằng tháng (1-31), 0 nếu không rõ
- startDate (string): ngày giải ngân / ngày ký hợp đồng, YYYY-MM-DD hoặc rỗng
- dueDate (string): ngày đến hạn kỳ tới, YYYY-MM-DD hoặc rỗng
- note (string): thông tin đáng chú ý khác (phí trễ hạn, bảo hiểm, phí trả trước hạn...), hoặc rỗng`;

function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `Bạn đọc ảnh chụp màn hình ứng dụng vay tiền / ngân hàng / ví điện tử, hoặc văn bản hợp đồng tín dụng, và trích xuất các khoản vay.
Hôm nay là ${today}.
Quy tắc:
- Chỉ ghi những gì có trong ảnh / văn bản. Trường không có: chuỗi rỗng, số 0, riêng paidPeriods là -1. Không bịa.
- Số tiền quy về VND dạng số nguyên ("1,5 triệu" -> 1500000, "đ2.000.000" -> 2000000, "3,000,000 VND" -> 3000000).
- Ngày quy về YYYY-MM-DD; ở Việt Nam ngày viết dạng ngày/tháng/năm; "20 Th04 2026" là 2026-04-20.
- "6/12 đã thanh toán" nghĩa là đã trả 6 kỳ trên tổng 12 kỳ: paidPeriods=6, termMonths=12.
- "Kỳ thanh toán 3/24" nghĩa là đang ở kỳ thứ 3 trên 24: paidPeriods=2, termMonths=24.
- "đến hạn vào ngày 20 mỗi tháng" nghĩa là dueDay=20; số tiền đứng trước câu đó là monthlyPayment.
- "Số tiền cần thanh toán" là số tiền kỳ hiện tại; dùng làm monthlyPayment nếu không có số tiền trả hằng tháng riêng.
- Hợp đồng: principal là số tiền cho vay; termMonths là thời hạn vay theo tháng; startDate là ngày ký / giải ngân.
- Ảnh có danh sách nhiều khoản vay: mỗi khoản một phần tử. Không có khoản vay nào: mảng rỗng.
${FIELD_DOC}`;
}

const LOAN_KEYS = ["name", "lender", "contractNo", "principal", "remaining", "monthlyPayment", "interestRate",
  "interestPeriod", "termMonths", "paidPeriods", "dueDay", "startDate", "dueDate", "note"];
const NUMBER_KEYS = new Set(["principal", "remaining", "monthlyPayment", "interestRate", "termMonths", "paidPeriods", "dueDay"]);

const LOAN_SCHEMA = {
  type: "object",
  properties: {
    loans: {
      type: "array",
      items: {
        type: "object",
        properties: Object.fromEntries(LOAN_KEYS.map((k) => [k,
          k === "interestPeriod" ? { type: "string", enum: ["year", "month"] } : { type: NUMBER_KEYS.has(k) ? "number" : "string" }])),
        required: LOAN_KEYS,
        additionalProperties: false,
      },
    },
  },
  required: ["loans"],
  additionalProperties: false,
};

function toResults(parsed) {
  const loans = Array.isArray(parsed?.loans) ? parsed.loans : [];
  return loans.map((raw) => {
    const loan = {};
    for (const k of LOAN_KEYS) {
      const v = raw?.[k];
      loan[k] = NUMBER_KEYS.has(k) ? (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0) : String(v ?? "");
    }
    if (loan.paidPeriods < 0) loan.paidPeriods = null;
    const detected = Object.fromEntries(LOAN_KEYS.map((k) => [k, k === "paidPeriods" ? loan.paidPeriods != null : Boolean(loan[k])]));
    return { loan, detected, rawText: "" };
  });
}

// Ảnh gửi cho AI: cạnh dài tối đa 1568px, JPEG.
function toJpegBase64(canvas) {
  const scale = Math.min(1, 1568 / Math.max(canvas.width, canvas.height));
  return toCanvas(canvas, scale).toDataURL("image/jpeg", 0.9).split(",")[1];
}

const USER_ASK = "Trích xuất các khoản vay và trả về JSON dạng {\"loans\": [...]}.";

let sdkPromise = null;

async function extractWithClaude(input, { apiKey, model }) {
  if (!apiKey) throw new Error("Chưa nhập Claude API key trong phần Cài đặt");
  sdkPromise ??= import(ANTHROPIC_SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = input.kind === "text"
    ? [{ type: "text", text: `Nội dung văn bản:\n\n${input.text}` }]
    : input.images.map((c) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: toJpegBase64(c) } }));
  content.push({ type: "text", text: USER_ASK });

  const response = await client.beta.messages.create({
    model: model || "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPrompt(),
    output_config: { effort: "low", format: { type: "json_schema", schema: LOAN_SCHEMA } },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") throw new Error("AI từ chối xử lý tệp này, hãy thử chế độ khác");
  if (response.stop_reason === "max_tokens") throw new Error("Phản hồi AI bị cắt ngang, hãy thử lại");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return toResults(JSON.parse(text));
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("AI không trả về JSON hợp lệ");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function groqError(res) {
  let msg = "";
  try { msg = (await res.json()).error?.message || ""; } catch { /* không có nội dung */ }
  if (res.status === 401) return "Groq API key không hợp lệ";
  if (res.status === 429) return `Groq báo vượt giới hạn của gói hiện tại, đợi một lúc rồi thử lại. ${msg}`;
  if (res.status === 404) return `Không tìm thấy model trên Groq, kiểm tra lại tên model trong Cài đặt. ${msg}`;
  return `Lỗi Groq ${res.status}: ${msg}`;
}

// Gói miễn phí của Groq giới hạn số token đầu ra mỗi phút (vd 1000 với qwen/qwen3.8-27b),
// nên với Groq yêu cầu AI trả JSON rút gọn: khoá ngắn, bỏ khoá không có dữ liệu.
const GROQ_KEYS = {
  l: "lender", c: "contractNo", p: "principal", r: "remaining", m: "monthlyPayment", i: "interestRate",
  ip: "interestPeriod", t: "termMonths", pd: "paidPeriods", d: "dueDay", s: "startDate", due: "dueDate",
};
const GROQ_FORMAT = `Trả về JSON rút gọn, không xuống dòng, không giải thích: {"loans":[{...},...]}.
Mỗi khoản vay chỉ ghi các khoá CÓ dữ liệu trong ảnh / văn bản (bỏ hẳn khoá không có, không ghi 0 hay ""):
l=bên cho vay (ngân hàng / công ty tài chính / app, không phải ví nhận tiền), c=số hợp đồng,
p=số tiền vay ban đầu, r=dư nợ hoặc tổng tiền còn phải trả (chỉ khi ghi rõ), m=số tiền trả mỗi kỳ / tháng,
i=lãi suất %, ip="y" nếu lãi theo năm hoặc "m" nếu theo tháng, t=tổng số kỳ, pd=số kỳ đã trả,
d=ngày trả hằng tháng (1-31), s=ngày giải ngân / ký hợp đồng (YYYY-MM-DD), due=ngày đến hạn kỳ tới (YYYY-MM-DD).
Ví dụ: {"loans":[{"l":"SEasy","p":2000000,"m":310500,"t":12,"pd":6,"d":12,"s":"2026-04-12"}]}`;

function groqSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `Bạn đọc ảnh chụp màn hình ứng dụng vay tiền / ngân hàng / ví điện tử, hoặc văn bản hợp đồng tín dụng, và trích xuất các khoản vay.
Hôm nay là ${today}. Chỉ ghi những gì có trong ảnh / văn bản, không bịa.
- Số tiền là số nguyên VND ("1,5 triệu" -> 1500000, "đ2.000.000" -> 2000000, "3,000,000 VND" -> 3000000).
- Ngày viết dạng ngày/tháng/năm; "20 Th04 2026" là 2026-04-20.
- "6/12 đã thanh toán": pd=6, t=12. "Kỳ thanh toán 3/24" (đang ở kỳ 3): pd=2, t=24.
- "đ230.000 đến hạn vào ngày 20 mỗi tháng": m=230000, d=20.
- "Số tiền cần thanh toán" dùng làm m nếu không có số tiền trả hằng tháng riêng.
- Ảnh có nhiều khoản vay: mỗi khoản một phần tử. Không có khoản vay: {"loans":[]}.
${GROQ_FORMAT}`;
}

function expandGroqLoans(parsed) {
  const loans = Array.isArray(parsed?.loans) ? parsed.loans : [];
  return {
    loans: loans.map((short) => {
      const loan = { paidPeriods: -1 };
      for (const [k, v] of Object.entries(short || {})) {
        const full = GROQ_KEYS[k] || (LOAN_KEYS.includes(k) ? k : null);
        if (full) loan[full] = v;
      }
      if (loan.interestPeriod === "m") loan.interestPeriod = "month";
      else if (loan.interestPeriod !== "month") loan.interestPeriod = "year";
      return loan;
    }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractWithGroq(input, { apiKey, model }, onProgress) {
  if (!apiKey) throw new Error("Chưa nhập Groq API key trong phần Cài đặt");
  const userContent = input.kind === "text"
    ? `Nội dung văn bản:\n\n${input.text}\n\n${USER_ASK}`
    : [
      ...input.images.slice(0, 5).map((c) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${toJpegBase64(c)}` } })),
      { type: "text", text: USER_ASK },
    ];
  const body = {
    model: model || DEFAULT_GROQ_MODEL,
    messages: [{ role: "system", content: groqSystemPrompt() }, { role: "user", content: userContent }],
    response_format: { type: "json_object" },
    temperature: 0,
    max_completion_tokens: 800,
    reasoning_effort: "none",
  };
  const call = () => fetch(`${GROQ_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await call();
    if (res.ok) break;
    const msg = (await res.clone().json().catch(() => ({}))).error?.message || "";
    if (res.status === 400 && /reasoning/i.test(msg) && "reasoning_effort" in body) {
      // Model khác có thể không nhận reasoning_effort: thử lại không có tham số này.
      delete body.reasoning_effort;
      continue;
    }
    if (/request too large/i.test(msg)) {
      // Yêu cầu vượt hạn mức token/phút của gói: hạ giới hạn đầu ra xuống dưới hạn mức rồi thử lại.
      const limit = Number(msg.match(/Limit\s+(\d+)/i)?.[1]);
      const next = Math.min(limit ? Math.floor(limit * 0.8) : Infinity, Math.floor(body.max_completion_tokens * 0.6));
      if (next < 200) break;
      body.max_completion_tokens = next;
      continue;
    }
    if (res.status === 429) {
      // Đã dùng hết hạn mức của phút này: đợi theo retry-after rồi gửi lại.
      const wait = Number(res.headers.get("retry-after")) || Number(msg.match(/try again in ([\d.]+)s/i)?.[1]) || 20;
      if (wait > 90) break;
      for (let left = Math.ceil(wait); left > 0; left--) {
        onProgress?.({ status: `Groq giới hạn số lượt mỗi phút, đợi ${left} giây` });
        await sleep(1000);
      }
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(await groqError(res));
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("Kết quả của Groq bị cắt do giới hạn token của gói miễn phí. Thử ảnh ít khoản vay hơn (cắt ảnh) hoặc dùng OCR.");
  }
  return toResults(expandGroqLoans(parseJsonLoose(choice?.message?.content || "")));
}

export async function listGroqModels(apiKey) {
  const res = await fetch(`${GROQ_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(await groqError(res));
  return (await res.json()).data.map((m) => m.id).sort();
}

// ---------- Điểm vào ----------

// Trả về { results: [{loan, detected, rawText}], thumb } cho một tệp ảnh hoặc PDF.
export async function extractLoans(file, engine, settings, onProgress) {
  onProgress?.({ status: "đọc tệp" });
  const input = await readInput(file);
  const thumb = input.images[0] ? toCanvas(input.images[0], Math.min(1, 480 / input.images[0].width)).toDataURL("image/jpeg", 0.8) : "";

  let results;
  if (engine === "claude") {
    results = await extractWithClaude(input, { apiKey: settings.claudeKey, model: settings.claudeModel });
  } else if (engine === "groq") {
    results = await extractWithGroq(input, { apiKey: settings.groqKey, model: settings.groqModel }, onProgress);
  } else {
    const text = input.kind === "text" ? input.text : await ocrImages(input.images, onProgress);
    results = parseLoans(text, { document: input.document });
  }
  return { results, thumb };
}
