import {
  loadLoans, saveLoans, loadSettings, saveSettings, newId, syncConfigured, pushEncrypted,
} from "./store.js";
import { extractWithOcr, extractWithClaude } from "./extract.js";
import { normalize } from "./parse.js";

// ---------- Tiện ích ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const nf = new Intl.NumberFormat("vi-VN");
const money = (n) => `${nf.format(Math.round(n || 0))} đ`;
const parseMoney = (s) => Number(String(s ?? "").replace(/[^\d]/g, "")) || 0;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysUntil(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}

// Cộng tháng, giữ ngày trong tháng (31/01 + 1 tháng -> 28/02 hoặc 29/02).
function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

const fmtDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "chưa có");

function dueBadge(loan) {
  if (loan.status === "paid") return `<span class="badge ok">Đã tất toán</span>`;
  const n = daysUntil(loan.dueDate);
  if (n == null) return `<span class="badge">Chưa có hạn</span>`;
  if (n < 0) return `<span class="badge danger">Quá hạn ${-n} ngày</span>`;
  if (n === 0) return `<span class="badge danger">Hạn hôm nay</span>`;
  if (n <= 3) return `<span class="badge warn">Còn ${n} ngày</span>`;
  return `<span class="badge">Còn ${n} ngày</span>`;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// ---------- Trạng thái ----------

let loans = loadLoans().map(normalizeLoan);
let settings = loadSettings();

function normalizeLoan(l) {
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
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(l.startDate) ? l.startDate : "",
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(l.dueDate) ? l.dueDate : "",
    cycle: l.cycle === "once" ? "once" : "monthly",
    status: l.status === "paid" ? "paid" : "active",
    note: String(l.note || ""),
    payments: Array.isArray(l.payments) ? l.payments : [],
    source: l.source || "manual",
    createdAt: l.createdAt || new Date().toISOString(),
    updatedAt: l.updatedAt || new Date().toISOString(),
  };
}

function commit() {
  if (!saveLoans(loans)) toast("Không lưu được vào trình duyệt (bộ nhớ đầy hoặc bị chặn)");
  renderAll();
  scheduleSync();
}

// ---------- Tab ----------

function showTab(name) {
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  try { sessionStorage.setItem("skv.tab", name); } catch { /* bỏ qua */ }
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- Tổng quan ----------

function monthKey(iso) { return iso.slice(0, 7); }

function renderDashboard() {
  const active = loans.filter((l) => l.status === "active");
  const thisMonth = monthKey(todayISO());
  const dueNow = active.filter((l) => l.dueDate && (monthKey(l.dueDate) <= thisMonth));
  const overdue = active.filter((l) => (daysUntil(l.dueDate) ?? 1) < 0);
  const amountDue = (l) => (l.cycle === "once" || !l.monthlyPayment ? l.remaining : Math.min(l.monthlyPayment, l.remaining || l.monthlyPayment));
  const paidAll = loans.flatMap((l) => l.payments);

  $("#st-remaining").textContent = money(active.reduce((s, l) => s + l.remaining, 0));
  $("#st-remaining-sub").textContent = `${active.length} khoản đang vay`;
  $("#st-month").textContent = money(dueNow.reduce((s, l) => s + amountDue(l), 0));
  $("#st-month-sub").textContent = `${dueNow.length} khoản${overdue.length ? `, ${overdue.length} quá hạn` : ""}`;
  $("#st-principal").textContent = money(active.reduce((s, l) => s + l.principal, 0));
  $("#st-principal-sub").textContent = "của các khoản đang vay";
  $("#st-paid").textContent = money(paidAll.reduce((s, p) => s + p.amount, 0));
  $("#st-paid-sub").textContent = `${paidAll.length} lần thanh toán đã ghi nhận`;

  const upcoming = active.filter((l) => l.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8);
  $("#due-list").innerHTML = upcoming.length
    ? upcoming.map((l) => `
      <li>
        <div><div><b>${esc(l.name)}</b></div><div class="small muted">${fmtDate(l.dueDate)} ${dueBadge(l)}</div></div>
        <div style="text-align:right"><div class="amt">${money(amountDue(l))}</div>
          <button class="btn sm ghost" data-act="pay" data-id="${l.id}">Đã trả</button></div>
      </li>`).join("")
    : `<li class="muted">Chưa có khoản vay nào có ngày đến hạn.</li>`;

  const byLender = {};
  for (const l of active) byLender[l.lender || "Khác"] = (byLender[l.lender || "Khác"] || 0) + l.remaining;
  const rows = Object.entries(byLender).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  $("#by-lender").innerHTML = rows.length
    ? rows.map(([name, v]) => `
      <div class="bar-row"><span class="label" title="${esc(name)}">${esc(name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(v / max) * 100}%"></div></div>
        <span class="val">${money(v)}</span></div>`).join("")
    : `<p class="muted">Chưa có dữ liệu.</p>`;

  renderForecast(active);
}

function renderForecast(active) {
  const start = monthKey(todayISO());
  const months = Array.from({ length: 6 }, (_, i) => monthKey(addMonths(`${start}-01`, i)));
  const totals = Object.fromEntries(months.map((m) => [m, 0]));
  for (const l of active) {
    if (!l.dueDate) continue;
    if (l.cycle === "once" || !l.monthlyPayment) {
      const m = monthKey(l.dueDate) < start ? start : monthKey(l.dueDate);
      if (m in totals) totals[m] += l.remaining;
      continue;
    }
    let rem = l.remaining || l.monthlyPayment * (l.termMonths || 1);
    let due = l.dueDate;
    for (let guard = 0; rem > 0 && guard < 240; guard++) {
      const m = monthKey(due) < start ? start : monthKey(due);
      if (!(m in totals)) break;
      const pay = Math.min(l.monthlyPayment, rem);
      totals[m] += pay;
      rem -= pay;
      due = addMonths(due, 1);
    }
  }
  const max = Math.max(1, ...Object.values(totals));
  $("#forecast").innerHTML = months.map((m) => {
    const [y, mo] = m.split("-");
    return `<div class="fc-col">
      <span class="fc-val">${totals[m] ? nf.format(Math.round(totals[m] / 1000)) + "k" : "0"}</span>
      <div class="fc-bar" style="height:${(totals[m] / max) * 120}px" title="${money(totals[m])}"></div>
      <span>T${Number(mo)}/${y.slice(2)}</span></div>`;
  }).join("");
}

function renderAlerts() {
  const active = loans.filter((l) => l.status === "active" && l.dueDate);
  const overdue = active.filter((l) => daysUntil(l.dueDate) < 0);
  const soon = active.filter((l) => { const n = daysUntil(l.dueDate); return n >= 0 && n <= 3; });
  let html = "";
  if (overdue.length) {
    html += `<div class="alert danger">Có ${overdue.length} khoản quá hạn: ${overdue.map((l) => esc(l.name)).join(", ")}.</div>`;
  }
  if (soon.length) {
    html += `<div class="alert">Sắp đến hạn trong 3 ngày: ${soon.map((l) => `${esc(l.name)} (${fmtDate(l.dueDate)})`).join(", ")}.</div>`;
  }
  $("#alerts").innerHTML = html;
}

// Thông báo trình duyệt tối đa 1 lần/ngày khi mở web.
function browserNotify() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const key = "skv.notified";
  try { if (localStorage.getItem(key) === todayISO()) return; } catch { return; }
  const due = loans.filter((l) => l.status === "active" && l.dueDate && daysUntil(l.dueDate) <= (Math.max(...settings.remindDays, 0)));
  if (!due.length) return;
  new Notification("Sổ Khoản Vay", { body: due.map((l) => `${l.name}: ${fmtDate(l.dueDate)}`).join("\n") });
  try { localStorage.setItem(key, todayISO()); } catch { /* bỏ qua */ }
}

// ---------- Danh sách khoản vay ----------

function renderList() {
  const q = normalize($("#q").value.trim());
  const status = $("#f-status").value;
  const sort = $("#f-sort").value;
  let list = loans.filter((l) => status === "all" || l.status === status);
  if (q) list = list.filter((l) => normalize(`${l.name} ${l.lender} ${l.contractNo} ${l.note}`).includes(q));
  const cmp = {
    due: (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"),
    remaining: (a, b) => b.remaining - a.remaining,
    name: (a, b) => a.name.localeCompare(b.name, "vi"),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
  }[sort];
  list.sort(cmp);
  $("#list-count").textContent = `${list.length} khoản`;

  if (!loans.length) {
    $("#loan-list").innerHTML = `<div class="empty card">Chưa có khoản vay nào. Vào tab <b>Thêm từ ảnh</b> để tải ảnh chụp màn hình, hoặc bấm <b>Thêm thủ công</b>.</div>`;
    return;
  }
  $("#loan-list").innerHTML = list.map((l) => {
    const paidPct = l.principal ? Math.min(100, Math.max(0, ((l.principal - l.remaining) / l.principal) * 100)) : 0;
    const meta = [l.lender, l.contractNo && `HĐ ${l.contractNo}`, l.interestRate && `Lãi ${l.interestRate}%/${l.interestPeriod === "month" ? "tháng" : "năm"}`,
      l.termMonths && `${l.termMonths} tháng`].filter(Boolean).map(esc).join(" · ");
    return `<article class="loan">
      <div>
        <div class="loan-title">${esc(l.name)} ${dueBadge(l)}</div>
        <div class="loan-meta">${meta || "&nbsp;"}</div>
      </div>
      <div class="loan-actions">
        ${l.status === "active" ? `<button class="btn sm" data-act="pay" data-id="${l.id}">Ghi nhận trả</button>` : ""}
        <button class="btn sm ghost" data-act="edit" data-id="${l.id}">Sửa</button>
        <button class="btn sm ghost danger" data-act="delete" data-id="${l.id}">Xoá</button>
      </div>
      <div class="loan-nums">
        <span>Dư nợ: <b>${money(l.remaining)}</b></span>
        <span>Gốc: <b>${money(l.principal)}</b></span>
        <span>Mỗi kỳ: <b>${money(l.monthlyPayment)}</b></span>
        <span>Hạn tới: <b>${fmtDate(l.dueDate)}</b></span>
      </div>
      ${l.principal ? `<div class="progress-mini" title="Đã trả ${paidPct.toFixed(0)}% gốc"><span style="width:${paidPct}%"></span></div>` : ""}
      ${l.note ? `<div class="loan-meta" style="grid-column:1/-1">${esc(l.note)}</div>` : ""}
    </article>`;
  }).join("") || `<div class="empty card">Không có khoản vay khớp bộ lọc.</div>`;
}

["#q", "#f-status", "#f-sort"].forEach((s) => $(s).addEventListener("input", renderList));

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const loan = loans.find((l) => l.id === btn.dataset.id);
  if (btn.dataset.act === "edit" && loan) openLoanDialog(loan);
  if (btn.dataset.act === "pay" && loan) openPayDialog(loan);
  if (btn.dataset.act === "delete" && loan && confirm(`Xoá khoản vay "${loan.name}"?`)) {
    loans = loans.filter((l) => l.id !== loan.id);
    commit();
    toast("Đã xoá");
  }
});

// ---------- Form khoản vay (dùng chung cho hộp thoại và thẻ xác nhận) ----------

const FIELDS = [
  { k: "name", label: "Tên khoản vay", type: "text", required: true },
  { k: "lender", label: "Bên cho vay", type: "text" },
  { k: "contractNo", label: "Số hợp đồng", type: "text" },
  { k: "principal", label: "Số tiền vay gốc", type: "money" },
  { k: "remaining", label: "Dư nợ còn lại", type: "money" },
  { k: "monthlyPayment", label: "Số tiền trả mỗi kỳ", type: "money" },
  { k: "dueDate", label: "Ngày đến hạn kỳ tới", type: "date" },
  { k: "cycle", label: "Chu kỳ trả", type: "select", options: [["monthly", "Hàng tháng"], ["once", "Trả một lần"]] },
  { k: "interestRate", label: "Lãi suất (%)", type: "number" },
  { k: "interestPeriod", label: "Lãi tính theo", type: "select", options: [["year", "Năm"], ["month", "Tháng"]] },
  { k: "termMonths", label: "Kỳ hạn (tháng)", type: "number" },
  { k: "startDate", label: "Ngày giải ngân", type: "date" },
  { k: "status", label: "Trạng thái", type: "select", options: [["active", "Đang vay"], ["paid", "Đã tất toán"]] },
  { k: "note", label: "Ghi chú", type: "textarea", full: true },
];
const CHECK_FIELDS = new Set(["lender", "principal", "remaining", "monthlyPayment", "dueDate"]);

function fieldsHtml(loan, detected) {
  return FIELDS.map((f) => {
    const v = loan[f.k] ?? "";
    const warn = detected && CHECK_FIELDS.has(f.k) && !detected[f.k] ? " needs-check" : "";
    let input;
    if (f.type === "select") {
      input = `<select name="${f.k}">${f.options.map(([val, txt]) => `<option value="${val}"${v === val ? " selected" : ""}>${txt}</option>`).join("")}</select>`;
    } else if (f.type === "textarea") {
      input = `<textarea name="${f.k}" rows="2">${esc(v)}</textarea>`;
    } else if (f.type === "money") {
      input = `<input type="text" inputmode="numeric" data-money name="${f.k}" value="${v ? nf.format(v) : ""}">`;
    } else if (f.type === "number") {
      input = `<input type="number" step="any" min="0" name="${f.k}" value="${v || ""}">`;
    } else {
      input = `<input type="${f.type}" name="${f.k}" value="${esc(v)}"${f.required ? " required" : ""}>`;
    }
    return `<label class="${f.full ? "full" : ""}${warn}">${f.label}${input}</label>`;
  }).join("");
}

function readFields(root) {
  const out = {};
  for (const f of FIELDS) {
    const el = root.querySelector(`[name="${f.k}"]`);
    if (!el) continue;
    out[f.k] = f.type === "money" ? parseMoney(el.value) : f.type === "number" ? Number(el.value) || 0 : el.value.trim();
  }
  return out;
}

// Tự thêm dấu chấm phân cách hàng nghìn khi gõ số tiền.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.matches?.("[data-money]")) return;
  const n = parseMoney(el.value);
  el.value = n ? nf.format(n) : "";
  el.closest(".needs-check")?.classList.remove("needs-check");
});
document.addEventListener("change", (e) => e.target.closest?.(".needs-check")?.classList.remove("needs-check"));

let editingId = null;
function openLoanDialog(loan) {
  editingId = loan?.id ?? null;
  $("#loan-dialog-title").textContent = loan ? "Sửa khoản vay" : "Thêm khoản vay";
  $("#loan-fields").innerHTML = fieldsHtml(loan ?? normalizeLoan({ dueDate: "" }));
  $("#loan-dialog").showModal();
}
$("#btn-add").addEventListener("click", () => openLoanDialog(null));
$("#loan-dialog").addEventListener("close", () => {
  if ($("#loan-dialog").returnValue !== "ok") return;
  const data = readFields($("#loan-form"));
  if (editingId) {
    const i = loans.findIndex((l) => l.id === editingId);
    loans[i] = normalizeLoan({ ...loans[i], ...data, updatedAt: new Date().toISOString() });
    toast("Đã cập nhật");
  } else {
    loans.push(normalizeLoan({ ...data, source: "manual" }));
    toast("Đã thêm khoản vay");
  }
  commit();
});

// ---------- Ghi nhận thanh toán ----------

let payingId = null;
function openPayDialog(loan) {
  payingId = loan.id;
  const f = $("#pay-form");
  $("#pay-desc").textContent = `${loan.name} · Dư nợ ${money(loan.remaining)} · Hạn ${fmtDate(loan.dueDate)}`;
  f.amount.value = nf.format(loan.cycle === "once" || !loan.monthlyPayment ? loan.remaining : Math.min(loan.monthlyPayment, loan.remaining || loan.monthlyPayment));
  f.date.value = todayISO();
  f.advance.checked = loan.cycle === "monthly";
  renderPayHistory(loan);
  $("#pay-dialog").showModal();
}

function renderPayHistory(loan) {
  $("#pay-history").innerHTML = loan.payments.length
    ? `<div class="pay-history"><b>Lịch sử thanh toán</b><table>${loan.payments.map((p, i) => `
        <tr><td>${fmtDate(p.date)}</td><td>${money(p.amount)}</td>
        <td style="text-align:right"><button type="button" class="btn sm ghost danger" data-undo="${i}">Huỷ</button></td></tr>`).join("")}</table></div>`
    : "";
}

$("#pay-history").addEventListener("click", (e) => {
  const b = e.target.closest("[data-undo]");
  if (!b) return;
  const loan = loans.find((l) => l.id === payingId);
  const [p] = loan.payments.splice(Number(b.dataset.undo), 1);
  loan.remaining += p.amount;
  loan.status = "active";
  renderPayHistory(loan);
  commit();
});

$("#pay-dialog").addEventListener("close", () => {
  if ($("#pay-dialog").returnValue !== "ok") return;
  const f = $("#pay-form");
  const loan = loans.find((l) => l.id === payingId);
  const amount = parseMoney(f.amount.value);
  if (!loan || !amount) return;
  loan.payments.push({ date: f.date.value || todayISO(), amount });
  loan.remaining = Math.max(0, loan.remaining - amount);
  if (f.advance.checked && loan.cycle === "monthly" && loan.dueDate) loan.dueDate = addMonths(loan.dueDate, 1);
  if (loan.remaining === 0) loan.status = "paid";
  loan.updatedAt = new Date().toISOString();
  commit();
  toast(loan.status === "paid" ? "Khoản vay đã được tất toán" : `Đã ghi nhận ${money(amount)}`);
});

// ---------- Thêm từ ảnh: hàng đợi + xác nhận ----------

const images = []; // { id, file, url, status, candidates, error, engine }
let processing = false;

function setEngineRadio() {
  $$('input[name="engine"]').forEach((r) => (r.checked = r.value === settings.engine));
}
$$('input[name="engine"]').forEach((r) => r.addEventListener("change", () => {
  settings.engine = r.value;
  saveSettings(settings);
}));

function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;
  for (const file of list) {
    images.push({ id: newId(), file, url: URL.createObjectURL(file), status: "pending", candidates: [], engine: settings.engine });
  }
  showTab("upload");
  renderReviewShell();
  for (const img of images.slice(-list.length)) renderImageCard(img);
  processQueue();
}

const dz = $("#dropzone");
$("#file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); addFiles(e.dataTransfer.files); });
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files); }
});

function setProgress(done, total, text) {
  $("#progress").hidden = total === 0 || done >= total;
  $("#progress-fill").style.width = `${total ? (done / total) * 100 : 0}%`;
  $("#progress-text").textContent = text;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    let img;
    while ((img = images.find((i) => i.status === "pending"))) {
      const batch = images.filter((i) => i.status !== "removed");
      const done = batch.filter((i) => !["pending", "processing"].includes(i.status)).length;
      img.status = "processing";
      renderImageCard(img);
      setProgress(done, batch.length, `Đang đọc ảnh ${done + 1}/${batch.length}...`);
      try {
        const results = img.engine === "ai"
          ? await extractWithClaude(img.file, { apiKey: settings.claudeKey, model: settings.claudeModel })
          : await extractWithOcr(img.file, (m) => {
            if (m.status === "recognizing text") setProgress(done + m.progress, batch.length, `Đang đọc ảnh ${done + 1}/${batch.length}: ${Math.round(m.progress * 100)}%`);
            else if (m.status) setProgress(done, batch.length, `Đang chuẩn bị OCR (${m.status})...`);
          });
        img.candidates = results.map((r) => prepareCandidate(r, img.engine));
        img.status = "ready";
      } catch (err) {
        console.error(err);
        img.status = "error";
        img.error = err?.message || String(err);
      }
      renderImageCard(img);
      renderReviewShell();
    }
  } finally {
    processing = false;
    setProgress(1, 1, "");
  }
}

function findDuplicate(loan) {
  const norm = (s) => normalize(s || "").replace(/\s+/g, "");
  return loans.find((l) =>
    (loan.contractNo && norm(l.contractNo) === norm(loan.contractNo)) ||
    (loan.lender && norm(l.lender) === norm(loan.lender) && loan.principal && l.principal === loan.principal && l.status === "active"));
}

function prepareCandidate({ loan, detected, rawText }, engine) {
  const l = normalizeLoan({ ...loan, source: engine });
  if (!l.name) l.name = l.lender ? `Khoản vay ${l.lender}` : "";
  const dup = findDuplicate(l);
  return { cid: newId(), loan: l, detected, rawText, include: true, mergeInto: dup?.id ?? "", dupName: dup?.name ?? "" };
}

function renderReviewShell() {
  const ready = images.flatMap((i) => (i.status === "ready" ? i.candidates : []));
  const visible = images.filter((i) => i.status !== "removed");
  $("#review-head").hidden = visible.length === 0;
  $("#review-hint").hidden = visible.length === 0;
  const pending = visible.filter((i) => ["pending", "processing"].includes(i.status)).length;
  $("#review-count").textContent = `(${ready.length} khoản từ ${visible.length} ảnh${pending ? `, còn ${pending} ảnh đang đọc` : ""})`;
}

function mergeOptions(selected) {
  const active = loans.filter((l) => l.status === "active");
  return `<option value="">Thêm thành khoản vay mới</option>` +
    active.map((l) => `<option value="${l.id}"${selected === l.id ? " selected" : ""}>Cập nhật vào: ${esc(l.name)}</option>`).join("");
}

function renderImageCard(img) {
  const list = $("#review-list");
  let el = document.getElementById(`img-${img.id}`);
  if (img.status === "removed") { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = `img-${img.id}`;
    el.className = "review-group";
    el.style.display = "contents";
    list.appendChild(el);
  }
  const thumb = `<div class="review-thumb"><img src="${img.url}" alt="${esc(img.file.name)}" data-zoom="${img.url}"><div class="small muted">${esc(img.file.name)}</div></div>`;

  if (img.status === "pending" || img.status === "processing") {
    el.innerHTML = `<div class="review">${thumb}<div class="muted">${img.status === "pending" ? "Đang chờ..." : "Đang đọc ảnh..."}</div></div>`;
    return;
  }
  if (img.status === "error") {
    el.innerHTML = `<div class="review error">${thumb}<div>
      <b>Không đọc được ảnh</b><p class="small">${esc(img.error)}</p>
      <div class="row">
        <button class="btn sm" data-img="${img.id}" data-do="retry-ocr">Thử lại bằng OCR</button>
        <button class="btn sm" data-img="${img.id}" data-do="retry-ai">Thử lại bằng AI</button>
        <button class="btn sm" data-img="${img.id}" data-do="manual">Nhập tay</button>
        <button class="btn sm ghost" data-img="${img.id}" data-do="remove">Bỏ ảnh</button>
      </div></div></div>`;
    return;
  }
  if (!img.candidates.length) {
    el.innerHTML = `<div class="review">${thumb}<div>
      <b>Không tìm thấy khoản vay trong ảnh</b>
      <div class="row" style="margin-top:8px">
        <button class="btn sm" data-img="${img.id}" data-do="manual">Nhập tay</button>
        <button class="btn sm ghost" data-img="${img.id}" data-do="remove">Bỏ ảnh</button>
      </div></div></div>`;
    return;
  }
  el.innerHTML = img.candidates.map((c) => `
    <div class="review${c.include ? "" : " skipped"}" data-cid="${c.cid}">
      ${thumb}
      <div>
        <div class="review-top">
          <label class="check"><input type="checkbox" data-include${c.include ? " checked" : ""}> Lưu mục này</label>
          <select data-merge style="width:auto;max-width:100%">${mergeOptions(c.mergeInto)}</select>
        </div>
        ${c.dupName ? `<div class="dup">Có vẻ trùng với khoản "${esc(c.dupName)}" đã có. Mặc định sẽ cập nhật vào khoản đó.</div>` : ""}
        <div class="form-grid">${fieldsHtml(c.loan, c.detected)}</div>
        <div class="row end">
          <button class="btn sm ghost" data-do="skip">Bỏ qua</button>
          <button class="btn sm primary" data-do="save-one">Lưu</button>
        </div>
        ${c.rawText ? `<details><summary class="small muted">Xem chữ OCR đọc được</summary><pre>${esc(c.rawText)}</pre></details>` : ""}
      </div>
    </div>`).join("");
}

function findCandidate(cid) {
  for (const img of images) {
    const c = img.candidates.find((x) => x.cid === cid);
    if (c) return [img, c];
  }
  return [];
}

// Lưu chỉnh sửa vào trạng thái ngay khi gõ, để ảnh khác đọc xong không làm mất dữ liệu đang sửa.
$("#review-list").addEventListener("input", (e) => {
  const card = e.target.closest("[data-cid]");
  if (!card) return;
  const [, c] = findCandidate(card.dataset.cid);
  if (!c) return;
  if (e.target.matches("[data-include]")) {
    c.include = e.target.checked;
    card.classList.toggle("skipped", !c.include);
  } else if (e.target.matches("[data-merge]")) {
    c.mergeInto = e.target.value;
  } else {
    Object.assign(c.loan, readFields(card));
  }
});

$("#review-list").addEventListener("click", (e) => {
  const zoom = e.target.closest("[data-zoom]");
  if (zoom) { $("#image-full").src = zoom.dataset.zoom; $("#image-dialog").showModal(); return; }
  const b = e.target.closest("[data-do]");
  if (!b) return;
  const card = b.closest("[data-cid]");
  if (card) {
    const [img, c] = findCandidate(card.dataset.cid);
    if (b.dataset.do === "skip") removeCandidate(img, c);
    if (b.dataset.do === "save-one") {
      Object.assign(c.loan, readFields(card));
      saveCandidates([[img, c]]);
    }
    return;
  }
  const img = images.find((i) => i.id === b.dataset.img);
  if (!img) return;
  if (b.dataset.do === "retry-ocr" || b.dataset.do === "retry-ai") {
    img.engine = b.dataset.do === "retry-ai" ? "ai" : "ocr";
    img.status = "pending";
    renderImageCard(img);
    processQueue();
  } else if (b.dataset.do === "manual") {
    img.status = "ready";
    img.candidates = [prepareCandidate({ loan: {}, detected: {}, rawText: "" }, "manual")];
    renderImageCard(img);
  } else if (b.dataset.do === "remove") {
    img.status = "removed";
    URL.revokeObjectURL(img.url);
    renderImageCard(img);
  }
  renderReviewShell();
});

function removeCandidate(img, c) {
  img.candidates = img.candidates.filter((x) => x !== c);
  if (!img.candidates.length) { img.status = "removed"; URL.revokeObjectURL(img.url); }
  renderImageCard(img);
  renderReviewShell();
}

function saveCandidates(pairs) {
  let created = 0, updated = 0;
  for (const [img, c] of pairs) {
    const data = { ...c.loan };
    if (!data.name) data.name = data.lender ? `Khoản vay ${data.lender}` : "Khoản vay chưa đặt tên";
    const target = c.mergeInto && loans.find((l) => l.id === c.mergeInto);
    if (target) {
      // Chỉ ghi đè các trường có giá trị, giữ lại lịch sử trả nợ của khoản cũ.
      for (const [k, v] of Object.entries(data)) {
        if (["id", "payments", "createdAt", "source"].includes(k)) continue;
        if (v !== "" && v !== 0 && v != null) target[k] = v;
      }
      target.updatedAt = new Date().toISOString();
      updated++;
    } else {
      loans.push(normalizeLoan({ ...data, id: newId(), createdAt: new Date().toISOString() }));
      created++;
    }
    removeCandidate(img, c);
  }
  if (created || updated) {
    commit();
    toast(`Đã lưu: ${created} khoản mới${updated ? `, cập nhật ${updated} khoản` : ""}`);
  }
}

$("#btn-save-all").addEventListener("click", () => {
  const pairs = images.flatMap((img) => (img.status === "ready" ? img.candidates.filter((c) => c.include).map((c) => [img, c]) : []));
  if (!pairs.length) { toast("Chưa có mục nào được chọn để lưu"); return; }
  saveCandidates(pairs);
});

$("#btn-discard-all").addEventListener("click", () => {
  if (!confirm("Bỏ toàn bộ ảnh và kết quả đang chờ xác nhận?")) return;
  for (const img of images) {
    if (img.status === "processing") continue;
    img.status = "removed";
    URL.revokeObjectURL(img.url);
    renderImageCard(img);
  }
  renderReviewShell();
});

// ---------- Xuất dữ liệu ----------

function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("#btn-csv").addEventListener("click", () => {
  const cols = [["name", "Tên"], ["lender", "Bên cho vay"], ["contractNo", "Số HĐ"], ["principal", "Gốc"], ["remaining", "Dư nợ"],
    ["monthlyPayment", "Mỗi kỳ"], ["dueDate", "Hạn tới"], ["interestRate", "Lãi suất %"], ["termMonths", "Kỳ hạn"], ["status", "Trạng thái"], ["note", "Ghi chú"]];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map((c) => q(c[1])).join(","), ...loans.map((l) => cols.map(([k]) => q(l[k])).join(","))].join("\r\n");
  download(`khoan-vay-${todayISO()}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
});

$("#btn-ics").addEventListener("click", () => {
  const active = loans.filter((l) => l.status === "active" && l.dueDate);
  if (!active.length) { toast("Không có khoản vay nào có ngày đến hạn"); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const icsText = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const events = active.map((l) => {
    const count = l.cycle === "monthly" && l.monthlyPayment ? Math.max(1, Math.ceil(l.remaining / l.monthlyPayment)) : 1;
    const day = l.dueDate.replace(/-/g, "");
    return [
      "BEGIN:VEVENT",
      `UID:${l.id}@so-khoan-vay`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      count > 1 ? `RRULE:FREQ=MONTHLY;COUNT=${count}` : "",
      `SUMMARY:${icsText(`Trả nợ ${l.name}: ${money(l.monthlyPayment || l.remaining)}`)}`,
      `DESCRIPTION:${icsText(`${l.lender} ${l.contractNo ? "HĐ " + l.contractNo : ""}\nDư nợ: ${money(l.remaining)}`)}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Sắp đến hạn trả nợ", "TRIGGER:-P1D", "END:VALARM",
      "END:VEVENT",
    ].filter(Boolean).join("\r\n");
  });
  download("lich-tra-no.ics", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//So Khoan Vay//VI", ...events, "END:VCALENDAR"].join("\r\n"), "text/calendar");
});

$("#btn-export").addEventListener("click", () => {
  const { ghToken, claudeKey, passphrase, ...safeSettings } = settings;
  download(`so-khoan-vay-${todayISO()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), settings: safeSettings, loans }, null, 2), "application/json");
});

$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.loans || []).map(normalizeLoan);
    const byId = new Map(loans.map((l) => [l.id, l]));
    for (const l of incoming) byId.set(l.id, l);
    loans = [...byId.values()];
    commit();
    toast(`Đã nhập ${incoming.length} khoản vay`);
  } catch {
    toast("File không đúng định dạng JSON");
  }
});

$("#btn-wipe").addEventListener("click", () => {
  if (!confirm("Xoá toàn bộ khoản vay trong trình duyệt này? Không thể hoàn tác.")) return;
  loans = [];
  commit();
});

// ---------- Cài đặt ----------

function fillSettingsForm() {
  const f = $("#settings-form");
  for (const k of ["email", "ghOwner", "ghRepo", "ghToken", "passphrase", "claudeKey", "claudeModel"]) f[k].value = settings[k] || "";
  f.remindDays.value = settings.remindDays.join(", ");
  f.remindOverdue.checked = settings.remindOverdue;
  f.autoSync.checked = settings.autoSync;
  $("#sync-status").textContent = settings.lastSync ? `Lần đồng bộ gần nhất: ${new Date(settings.lastSync).toLocaleString("vi-VN")}` : "";
}

function readSettingsForm() {
  const f = $("#settings-form");
  const days = f.remindDays.value.split(/[,;\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60);
  settings = {
    ...settings,
    email: f.email.value.trim(),
    remindDays: days.length ? [...new Set(days)].sort((a, b) => b - a) : [3, 1, 0],
    remindOverdue: f.remindOverdue.checked,
    ghOwner: f.ghOwner.value.trim(),
    ghRepo: f.ghRepo.value.trim(),
    ghToken: f.ghToken.value.trim(),
    passphrase: f.passphrase.value,
    autoSync: f.autoSync.checked,
    claudeKey: f.claudeKey.value.trim(),
    claudeModel: f.claudeModel.value,
  };
  saveSettings(settings);
}

$("#settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  readSettingsForm();
  fillSettingsForm();
  $("#settings-status").textContent = "Đã lưu cài đặt";
  scheduleSync();
});

$("#btn-notify").addEventListener("click", async () => {
  if (!("Notification" in window)) { toast("Trình duyệt không hỗ trợ thông báo"); return; }
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Đã bật thông báo trình duyệt" : "Thông báo bị từ chối");
  browserNotify();
});

let syncTimer;
function scheduleSync() {
  if (!settings.autoSync || !syncConfigured(settings)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(false), 1500);
}

async function runSync(manual) {
  const status = $("#sync-status");
  if (!syncConfigured(settings)) {
    if (manual) toast("Cần nhập đủ email, owner, repo, token và mật khẩu mã hoá");
    return;
  }
  status.textContent = "Đang đồng bộ...";
  try {
    await pushEncrypted(loans, settings);
    settings.lastSync = new Date().toISOString();
    saveSettings(settings);
    status.textContent = `Lần đồng bộ gần nhất: ${new Date(settings.lastSync).toLocaleString("vi-VN")}`;
    if (manual) toast("Đồng bộ thành công");
  } catch (err) {
    status.textContent = `Lỗi đồng bộ: ${err.message}`;
    if (manual) toast("Đồng bộ thất bại");
  }
}

$("#btn-sync").addEventListener("click", () => { readSettingsForm(); runSync(true); });

$("#image-dialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- Khởi động ----------

function renderAll() {
  renderDashboard();
  renderList();
  renderAlerts();
}

setEngineRadio();
fillSettingsForm();
renderAll();
let startTab = "dashboard";
try { startTab = sessionStorage.getItem("skv.tab") || (loans.length ? "dashboard" : "upload"); } catch { /* bỏ qua */ }
showTab(startTab);
browserNotify();
