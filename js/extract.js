// Hai cách đọc ảnh: OCR miễn phí chạy ngay trong trình duyệt (Tesseract.js) hoặc AI Claude (cần API key riêng).
import { parseLoanText } from "./parse.js";

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const ANTHROPIC_SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.130.0/+esm";

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

// Ảnh chụp màn hình điện thoại thường nhỏ chữ: phóng to ảnh hẹp và chuyển xám để OCR đọc tốt hơn.
async function prepareForOcr(file) {
  const img = await loadImage(file);
  const scale = img.width < 1100 ? 2 : 1;
  const c = document.createElement("canvas");
  c.width = img.width * scale;
  c.height = img.height * scale;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const px = ctx.getImageData(0, 0, c.width, c.height);
  const d = px.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  // Giao diện nền tối (dark mode): đảo màu để chữ thành tối trên nền sáng.
  if (sum / (d.length / 4) < 110) {
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
  }
  ctx.putImageData(px, 0, 0);
  return c;
}

let workerPromise = null;

function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript(TESSERACT_URL);
      return window.Tesseract.createWorker(["vie", "eng"], 1, {
        logger: (m) => onProgress?.(m),
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

export async function extractWithOcr(file, onProgress) {
  const worker = await getWorker(onProgress);
  const canvas = await prepareForOcr(file);
  const { data } = await worker.recognize(canvas);
  const { loan, detected } = parseLoanText(data.text);
  return [{ loan, detected, rawText: data.text }];
}

// ---------- AI (Claude) ----------

const LOAN_SCHEMA = {
  type: "object",
  properties: {
    loans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Tên ngắn gọn cho khoản vay" },
          lender: { type: "string", description: "Tên ngân hàng / công ty / ví cho vay" },
          contractNo: { type: "string" },
          principal: { type: "number", description: "Số tiền vay gốc ban đầu, VND" },
          remaining: { type: "number", description: "Dư nợ còn lại, VND" },
          monthlyPayment: { type: "number", description: "Số tiền phải trả kỳ tới, VND" },
          interestRate: { type: "number", description: "Lãi suất, đơn vị %" },
          interestPeriod: { type: "string", enum: ["year", "month"] },
          termMonths: { type: "number", description: "Tổng số kỳ/tháng vay" },
          startDate: { type: "string", description: "YYYY-MM-DD hoặc rỗng" },
          dueDate: { type: "string", description: "Ngày đến hạn kỳ tới, YYYY-MM-DD hoặc rỗng" },
          note: { type: "string" },
        },
        required: [
          "name", "lender", "contractNo", "principal", "remaining", "monthlyPayment",
          "interestRate", "interestPeriod", "termMonths", "startDate", "dueDate", "note",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["loans"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `Bạn đọc ảnh chụp màn hình ứng dụng ngân hàng, ví điện tử, công ty tài chính hoặc tin nhắn về khoản vay và trích xuất thông tin khoản vay.
Quy tắc:
- Chỉ ghi những gì thấy trong ảnh. Trường nào không có trong ảnh: chuỗi rỗng "" hoặc số 0. Không suy đoán.
- Số tiền quy về VND dạng số nguyên (ví dụ "1,5 triệu" -> 1500000, "5.000.000đ" -> 5000000).
- Ngày quy về YYYY-MM-DD. Ảnh ở Việt Nam dùng dạng ngày/tháng/năm.
- Nếu ảnh liệt kê nhiều khoản vay, trả về mỗi khoản một phần tử. Nếu ảnh không chứa khoản vay nào, trả về mảng rỗng.
- "note": ghi ngắn các thông tin đáng chú ý khác (phí trễ hạn, số kỳ đã trả...), hoặc rỗng.`;

// Thu nhỏ ảnh trước khi gửi để tiết kiệm token; cạnh dài tối đa 1568px.
async function toBase64Jpeg(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9).split(",")[1];
}

let sdkPromise = null;

export async function extractWithClaude(file, { apiKey, model }) {
  if (!apiKey) throw new Error("Chưa nhập Claude API key trong phần Cài đặt");
  sdkPromise ??= import(ANTHROPIC_SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const data = await toBase64Jpeg(file);

  const response = await client.beta.messages.create({
    model: model || "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    output_config: { effort: "low", format: { type: "json_schema", schema: LOAN_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
        { type: "text", text: "Trích xuất các khoản vay trong ảnh này." },
      ],
    }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("AI từ chối xử lý ảnh này, hãy thử chế độ OCR");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Phản hồi AI bị cắt ngang, hãy thử lại");
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);
  const all = Object.fromEntries(LOAN_SCHEMA.properties.loans.items.required.map((k) => [k, true]));
  return parsed.loans.map((loan) => ({
    loan,
    detected: Object.fromEntries(Object.keys(all).map((k) => [k, Boolean(loan[k])])),
    rawText: "",
  }));
}
