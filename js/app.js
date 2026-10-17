import { loadLoans, saveLoans, loadSettings, saveSettings, syncConfigured, pushEncrypted } from "./store.js";
import { extractLoans, isPdf, listGroqModels, warmUpOcr } from "./extract.js";
import { normalize } from "./parse.js";
import {
  newId, normalizeLoan, deriveLoan, missingRequired, REQUIRED, remainingPeriods, addMonths, advanceDue, toISO,
} from "./loan.js";

// ---------- Tiện ích ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const nf = new Intl.NumberFormat("vi-VN");
const money = (n) => `${nf.format(Math.round(n || 0))} đ`;
const parseMoney = (s) => Number(String(s ?? "").replace(/[^\d]/g, "")) || 0;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayISO = () => toISO(new Date());

function daysUntil(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
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

function periodsText(l) {
  if (l.paidPeriods == null || !l.termMonths) return "";
  return `Đã trả ${l.paidPeriods}/${l.termMonths} kỳ, còn ${remainingPeriods(l)} kỳ`;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

// ---------- Trạng thái ----------

let loans = loadLoans().map(normalizeLoan);
let settings = loadSettings();
if (settings.engine === "ai") settings.engine = "claude";

function commit() {
  if (!saveLoans(loans)) toast("Không lưu được vào trình duyệt (bộ nhớ đầy hoặc bị chặn)");
  renderAll();
  scheduleSync();
}

// ---------- Tab ----------

let currentTab = "";
function showTab(name) {
  if (name !== currentTab) window.scrollTo(0, 0);
  currentTab = name;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  try { sessionStorage.setItem("skv.tab", name); } catch { /* bỏ qua */ }
  if (name === "upload" && settings.engine === "ocr") warmUpOcr();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- Tổng quan ----------

const monthKey = (iso) => iso.slice(0, 7);
const amountDue = (l) => (l.cycle === "once" || !l.monthlyPayment ? l.remaining : Math.min(l.monthlyPayment, l.remaining || l.monthlyPayment));

function renderDashboard() {
  const active = loans.filter((l) => l.status === "active");
  const thisMonth = monthKey(todayISO());
  const dueNow = active.filter((l) => l.dueDate && monthKey(l.dueDate) <= thisMonth);
  const overdue = active.filter((l) => (daysUntil(l.dueDate) ?? 1) < 0);
  const paidAll = loans.flatMap((l) => l.payments);
  const monthlyTotal = active.reduce((s, l) => s + (l.cycle === "monthly" ? l.monthlyPayment : 0), 0);

  $("#st-remaining").textContent = money(active.reduce((s, l) => s + l.remaining, 0));
  const principalTotal = active.reduce((s, l) => s + l.principal, 0);
  $("#st-remaining-sub").textContent = `${active.length} khoản · mỗi tháng ${money(monthlyTotal)}${principalTotal ? ` · gốc vay ${money(principalTotal)}` : ""}`;
  $("#st-month").textContent = money(dueNow.reduce((s, l) => s + amountDue(l), 0));
  $("#st-month-sub").textContent = `${dueNow.length} khoản${overdue.length ? `, ${overdue.length} quá hạn` : ""}`;
  $("#st-principal").textContent = money(principalTotal);
  $("#st-principal-sub").textContent = "các khoản đang vay";
  $("#st-paid").textContent = money(paidAll.reduce((s, p) => s + p.amount, 0));
  $("#st-paid-sub").textContent = `${paidAll.length} lần ghi nhận`;

  const upcoming = active.filter((l) => l.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8);
  $("#due-list").innerHTML = upcoming.length
    ? upcoming.map((l) => `
      <li>
        <div class="info"><div class="name">${esc(l.name)}</div>
          <div class="small muted">${fmtDate(l.dueDate)} ${dueBadge(l)}</div></div>
        <div class="side"><div class="amt">${money(amountDue(l))}</div>
          <button class="btn sm" data-act="pay" data-id="${l.id}">Đã trả</button></div>
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
    let rem = l.remaining || l.monthlyPayment * (remainingPeriods(l) ?? 1);
    let left = remainingPeriods(l) ?? Infinity;
    let due = l.dueDate;
    for (let guard = 0; rem > 0 && left > 0 && guard < 240; guard++) {
      const m = monthKey(due) < start ? start : monthKey(due);
      if (!(m in totals)) break;
      const pay = Math.min(l.monthlyPayment, rem);
      totals[m] += pay;
      rem -= pay;
      left--;
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
  const incomplete = loans.filter((l) => missingRequired(l).length);
  let html = "";
  if (overdue.length) {
    html += `<button type="button" class="alert danger" data-goto="loans">Có ${overdue.length} khoản quá hạn: ${overdue.map((l) => esc(l.name)).join(", ")}</button>`;
  }
  if (soon.length) {
    html += `<button type="button" class="alert" data-goto="loans">Sắp đến hạn trong 3 ngày: ${soon.map((l) => `${esc(l.name)} (${fmtDate(l.dueDate)})`).join(", ")}</button>`;
  }
  if (incomplete.length) {
    html += `<button type="button" class="alert" data-goto="loans">${incomplete.length} khoản vay còn thiếu thông tin bắt buộc, chạm vào khoản đó để bổ sung</button>`;
  }
  $("#alerts").innerHTML = html;
}
$("#alerts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-goto]");
  if (b) showTab(b.dataset.goto);
});

// Thông báo trình duyệt tối đa 1 lần/ngày khi mở web.
function browserNotify() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const key = "skv.notified";
  try { if (localStorage.getItem(key) === todayISO()) return; } catch { return; }
  const due = loans.filter((l) => l.status === "active" && l.dueDate && daysUntil(l.dueDate) <= Math.max(...settings.remindDays, 0));
  if (!due.length) return;
  new Notification("Sổ Khoản Vay", { body: due.map((l) => `${l.name}: ${fmtDate(l.dueDate)}`).join("\n") });
  try { localStorage.setItem(key, todayISO()); } catch { /* bỏ qua */ }
}

// ---------- Danh sách khoản vay ----------

function renderList() {
  const q = normalize($("#q").value.trim());
  const status = $('input[name="f-status"]:checked').value;
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
  $("#list-count").textContent = list.length ? `${list.length} khoản · chạm để sửa` : "";

  if (!loans.length) {
    $("#loan-list").innerHTML = `<div class="empty card">Chưa có khoản vay nào.<br>Bấm <b>Thêm</b> ở thanh dưới để chọn ảnh chụp màn hình, PDF hợp đồng hoặc nhập tay.</div>`;
    return;
  }
  $("#loan-list").innerHTML = list.map((l) => {
    const pct = l.termMonths && l.paidPeriods != null
      ? Math.min(100, (l.paidPeriods / l.termMonths) * 100)
      : l.principal ? Math.min(100, Math.max(0, ((l.principal - l.remaining) / l.principal) * 100)) : 0;
    const meta = [l.lender, l.contractNo && `HĐ ${l.contractNo}`, l.interestRate && `Lãi ${l.interestRate}%/${l.interestPeriod === "month" ? "tháng" : "năm"}`]
      .filter(Boolean).map(esc).join(" · ");
    const miss = missingRequired(l);
    const left = remainingPeriods(l);
    return `<article class="loan" data-act="edit" data-id="${l.id}">
      <div class="loan-top">
        <div class="loan-title">${esc(l.name)}</div>
        ${dueBadge(l)}
      </div>
      ${meta ? `<div class="loan-meta">${meta}</div>` : ""}
      ${miss.length ? `<div class="missing" style="margin:8px 0 0">Thiếu: ${miss.map((k) => REQUIRED[k]).join(", ")}</div>` : ""}
      <div class="loan-amount">${money(l.remaining)} <small>còn nợ</small></div>
      <div class="loan-facts">
        <span>Mỗi tháng <b>${money(l.monthlyPayment)}</b></span>
        <span>Kỳ <b>${l.paidPeriods ?? "?"}/${l.termMonths || "?"}</b>${left != null ? ` (còn ${left})` : ""}</span>
        <span>Hạn <b>${fmtDate(l.dueDate)}</b></span>
      </div>
      ${pct ? `<div class="progress-mini" title="Đã trả ${pct.toFixed(0)}%"><span style="width:${pct}%"></span></div>` : ""}
      ${l.status === "active" ? `<div class="loan-actions"><button class="btn sm" data-act="pay" data-id="${l.id}">Ghi nhận đã trả ${money(amountDue(l))}</button></div>` : ""}
    </article>`;
  }).join("") || `<div class="empty card">Không có khoản vay khớp bộ lọc.</div>`;
}

["#q", "#f-sort"].forEach((sel) => $(sel).addEventListener("input", renderList));
$$('input[name="f-status"]').forEach((r) => r.addEventListener("change", renderList));

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const loan = loans.find((l) => l.id === btn.dataset.id);
  if (btn.dataset.act === "edit" && loan) openLoanDialog(loan);
  if (btn.dataset.act === "pay" && loan) openPayDialog(loan);
});

// ---------- Form khoản vay (dùng chung cho hộp thoại và thẻ xác nhận) ----------

// main: hiện ngay; còn lại nằm trong mục "Chi tiết khác" để form gọn trên điện thoại.
const FIELDS = [
  { k: "name", label: "Tên khoản vay", type: "text", main: true, wide: true },
  { k: "lender", label: "Bên cho vay", type: "text", main: true, wide: true },
  { k: "remaining", label: "Tổng nợ còn lại", type: "money", main: true },
  { k: "monthlyPayment", label: "Trả mỗi tháng", type: "money", main: true },
  { k: "paidPeriods", label: "Đã trả (kỳ)", type: "int", main: true },
  { k: "termMonths", label: "Tổng số kỳ", type: "int", main: true },
  { k: "dueDay", label: "Trả ngày (hằng tháng)", type: "int", max: 31, main: true },
  { k: "dueDate", label: "Hạn kỳ tới", type: "date", main: true },
  { k: "principal", label: "Số tiền vay gốc", type: "money" },
  { k: "contractNo", label: "Số hợp đồng", type: "text" },
  { k: "interestRate", label: "Lãi suất (%)", type: "number" },
  { k: "interestPeriod", label: "Lãi tính theo", type: "select", options: [["year", "Năm"], ["month", "Tháng"]] },
  { k: "startDate", label: "Ngày giải ngân", type: "date" },
  { k: "cycle", label: "Chu kỳ trả", type: "select", options: [["monthly", "Hàng tháng"], ["once", "Trả một lần"]] },
  { k: "status", label: "Trạng thái", type: "select", options: [["active", "Đang vay"], ["paid", "Đã tất toán"]] },
  { k: "note", label: "Ghi chú", type: "textarea", wide: true },
];
const CHECK_FIELDS = new Set(["lender", "principal", "remaining", "monthlyPayment", "paidPeriods", "termMonths", "dueDate"]);

function fieldClass(k, { detected, estimated, missing }) {
  if (missing?.includes(k)) return " needs-fill";
  if (estimated?.has(k)) return " needs-check estimated";
  if (detected && CHECK_FIELDS.has(k) && !detected[k]) return " needs-check";
  return "";
}

function inputHtml(f, v) {
  if (f.type === "select") {
    return `<select name="${f.k}">${f.options.map(([val, txt]) => `<option value="${val}"${v === val ? " selected" : ""}>${txt}</option>`).join("")}</select>`;
  }
  if (f.type === "textarea") return `<textarea name="${f.k}" rows="2">${esc(v)}</textarea>`;
  if (f.type === "text") return `<input type="text" name="${f.k}" value="${esc(v)}" autocomplete="off">`;
  if (f.type === "money") return `<input type="text" inputmode="numeric" data-money name="${f.k}" value="${v ? nf.format(v) : ""}">`;
  if (f.type === "int") return `<input type="number" inputmode="numeric" pattern="[0-9]*" step="1" min="0"${f.max ? ` max="${f.max}"` : ""} name="${f.k}" value="${v === null || v === undefined || (v === 0 && f.k !== "paidPeriods") ? "" : v}">`;
  if (f.type === "number") return `<input type="number" inputmode="decimal" step="any" min="0" name="${f.k}" value="${v || ""}">`;
  return `<input type="${f.type}" name="${f.k}" value="${esc(v)}">`;
}

function fieldHtml(f, loan, state) {
  const cls = fieldClass(f.k, state);
  const req = REQUIRED[f.k] ? ' <span class="req">*</span>' : "";
  const tip = state.estimated?.has(f.k) ? ' title="Giá trị ước tính, hãy kiểm tra lại"' : "";
  return `<label data-field="${f.k}" class="${f.wide ? "wide" : ""}${cls}"${tip}><span>${f.label}${req}</span>${inputHtml(f, loan[f.k] ?? "")}</label>`;
}

function fieldsHtml(loan, state = {}) {
  const main = FIELDS.filter((f) => f.main).map((f) => fieldHtml(f, loan, state)).join("");
  const more = FIELDS.filter((f) => !f.main).map((f) => fieldHtml(f, loan, state)).join("");
  return `<div class="form-grid">${main}<div class="periods-left" data-left>${esc(periodsText(loan))}</div></div>
    <details class="more"><summary>Chi tiết khác (gốc vay, hợp đồng, lãi suất...)</summary><div class="form-grid">${more}</div></details>`;
}

function readFields(root) {
  const out = {};
  for (const f of FIELDS) {
    const el = root.querySelector(`[name="${f.k}"]`);
    if (!el) continue;
    if (f.type === "money") out[f.k] = parseMoney(el.value);
    else if (f.type === "int") out[f.k] = el.value === "" ? (f.k === "paidPeriods" ? null : 0) : Math.max(0, Math.round(Number(el.value)));
    else if (f.type === "number") out[f.k] = Number(el.value) || 0;
    else out[f.k] = el.value.trim();
  }
  return out;
}

function writeField(root, k, v) {
  const f = FIELDS.find((x) => x.k === k);
  const el = root.querySelector(`[name="${k}"]`);
  if (!f || !el) return;
  if (f.type === "money") el.value = v ? nf.format(v) : "";
  else if (f.type === "int") el.value = v == null ? "" : v;
  else el.value = v ?? "";
}

// Cập nhật màu các ô + dòng "còn N kỳ" + thông báo thiếu thông tin.
function paintState(root, loan, state) {
  for (const label of $$("label[data-field]", root)) {
    const k = label.dataset.field;
    label.classList.remove("needs-fill", "needs-check", "estimated");
    const cls = fieldClass(k, state).trim();
    if (cls) label.classList.add(...cls.split(" "));
    label.title = state.estimated?.has(k) ? "Giá trị ước tính, hãy kiểm tra lại" : "";
  }
  const left = $("[data-left]", root);
  if (left) left.textContent = periodsText(loan);
  const warn = $("[data-missing]", root);
  if (warn) {
    warn.hidden = !state.missing?.length;
    warn.textContent = state.missing?.length ? `Thiếu thông tin bắt buộc: ${state.missing.map((k) => REQUIRED[k]).join(", ")}` : "";
  }
}

// Tính lại các trường ước tính sau khi người dùng sửa một trường khác.
function rederive(loan, estimated) {
  const base = { ...loan };
  for (const k of estimated) base[k] = k === "paidPeriods" ? null : ["dueDate", "startDate"].includes(k) ? "" : 0;
  const { loan: out, estimated: est } = deriveLoan(base);
  return { loan: { ...loan, ...Object.fromEntries(est.map((k) => [k, out[k]])) }, estimated: new Set(est) };
}

// Tự thêm dấu chấm phân cách hàng nghìn khi gõ số tiền.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.matches?.("[data-money]")) return;
  const n = parseMoney(el.value);
  el.value = n ? nf.format(n) : "";
});

let editingId = null;
let dialogEstimated = new Set();

function openLoanDialog(loan) {
  editingId = loan?.id ?? null;
  dialogEstimated = new Set();
  const data = loan ?? normalizeLoan({});
  $("#loan-dialog-title").textContent = loan ? "Khoản vay" : "Thêm khoản vay";
  $("#loan-fields").innerHTML = fieldsHtml(data, { missing: loan ? missingRequired(loan) : [] });
  paintState($("#loan-form"), data, { missing: loan ? missingRequired(loan) : [] });
  $("#btn-delete").hidden = !loan;
  $("#loan-dialog").showModal();
  $(".sheet-body", $("#loan-dialog")).scrollTop = 0;
}
$("#btn-add").addEventListener("click", () => openLoanDialog(null));
$("#btn-delete").addEventListener("click", () => {
  const loan = loans.find((l) => l.id === editingId);
  if (!loan || !confirm(`Xoá khoản vay "${loan.name}"?`)) return;
  loans = loans.filter((l) => l.id !== loan.id);
  $("#loan-dialog").close("cancel");
  commit();
  toast("Đã xoá");
});

$("#loan-form").addEventListener("input", (e) => {
  const form = $("#loan-form");
  const k = e.target.name;
  if (!k) return;
  dialogEstimated.delete(k);
  const r = rederive(normalizeLoan(readFields(form)), dialogEstimated);
  dialogEstimated = r.estimated;
  for (const f of dialogEstimated) writeField(form, f, r.loan[f]);
  paintState(form, r.loan, { estimated: dialogEstimated, missing: missingRequired(r.loan) });
});

$("#loan-form").addEventListener("submit", (e) => {
  if (e.submitter?.value !== "ok") return;
  const { loan } = deriveLoan(normalizeLoan(readFields($("#loan-form"))));
  const miss = missingRequired(loan);
  if (miss.length) {
    e.preventDefault();
    paintState($("#loan-form"), loan, { estimated: dialogEstimated, missing: miss });
    toast(`Thiếu: ${miss.map((k) => REQUIRED[k]).join(", ")}`);
  }
});

$("#loan-dialog").addEventListener("close", () => {
  if ($("#loan-dialog").returnValue !== "ok") return;
  const { loan: data } = deriveLoan(normalizeLoan(readFields($("#loan-form"))));
  if (editingId) {
    const i = loans.findIndex((l) => l.id === editingId);
    const { id, payments, createdAt, source, ...fields } = data;
    loans[i] = normalizeLoan({ ...loans[i], ...fields, updatedAt: new Date().toISOString() });
    toast("Đã cập nhật");
  } else {
    loans.push(normalizeLoan({ ...data, id: newId(), source: "manual", createdAt: new Date().toISOString() }));
    toast("Đã thêm khoản vay");
  }
  commit();
});

// ---------- Ghi nhận thanh toán ----------

let payingId = null;
function openPayDialog(loan) {
  payingId = loan.id;
  const f = $("#pay-form");
  $("#pay-desc").textContent = `${loan.name} · Tổng nợ ${money(loan.remaining)} · Hạn ${fmtDate(loan.dueDate)}${loan.termMonths ? ` · Kỳ ${(loan.paidPeriods ?? 0) + 1}/${loan.termMonths}` : ""}`;
  f.amount.value = nf.format(amountDue(loan));
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
  if (p.advanced && loan.paidPeriods) loan.paidPeriods -= 1;
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
  const advanced = f.advance.checked && loan.cycle === "monthly";
  loan.payments.push({ date: f.date.value || todayISO(), amount, advanced });
  loan.remaining = Math.max(0, loan.remaining - amount);
  if (advanced) {
    if (loan.dueDate) loan.dueDate = advanceDue(loan);
    if (loan.paidPeriods != null) loan.paidPeriods += 1;
  }
  if (loan.remaining === 0 || (loan.termMonths && loan.paidPeriods >= loan.termMonths)) loan.status = "paid";
  loan.updatedAt = new Date().toISOString();
  commit();
  toast(loan.status === "paid" ? "Khoản vay đã được tất toán" : `Đã ghi nhận ${money(amount)}`);
});

// ---------- Thêm từ ảnh / PDF: hàng đợi + xác nhận ----------

const images = []; // { id, file, url, thumb, status, candidates, error, engine }
let processing = false;

const ENGINE_NOTES = {
  ocr: () => "Đọc ngay trên máy, miễn phí, không giới hạn. Phù hợp ảnh chụp màn hình rõ nét.",
  groq: () => (settings.groqKey ? "Gửi ảnh tới Groq để đọc. Gói miễn phí xử lý khoảng 1-2 ảnh mỗi phút." : "Chưa có Groq API key: nhập trong Cài đặt > AI Groq."),
  claude: () => (settings.claudeKey ? "Gửi ảnh tới Claude để đọc, tính phí theo tài khoản Anthropic." : "Chưa có Claude API key: nhập trong Cài đặt > AI Claude."),
};

function setEngineRadio() {
  $$('input[name="engine"]').forEach((r) => (r.checked = r.value === settings.engine));
  $("#engine-note").textContent = ENGINE_NOTES[settings.engine]?.() ?? "";
}
$$('input[name="engine"]').forEach((r) => r.addEventListener("change", () => {
  settings.engine = r.value;
  saveSettings(settings);
  setEngineRadio();
  if (r.value === "ocr") warmUpOcr();
}));

function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/") || isPdf(f));
  if (!list.length) { toast("Chỉ nhận ảnh hoặc file PDF"); return; }
  const added = list.map((file) => ({
    id: newId(), file, url: isPdf(file) ? "" : URL.createObjectURL(file), thumb: "",
    status: "pending", candidates: [], engine: settings.engine,
  }));
  images.push(...added);
  showTab("upload");
  renderReviewShell();
  added.forEach(renderImageCard);
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
      const label = `Đang đọc tệp ${done + 1}/${batch.length}`;
      img.status = "processing";
      renderImageCard(img);
      setProgress(done, batch.length, `${label}...`);
      try {
        const { results, thumb } = await extractLoans(img.file, img.engine, settings, (m) => {
          if (m.status === "recognizing text") setProgress(done + m.progress, batch.length, `${label}: ${Math.round(m.progress * 100)}%`);
          else if (m.status) setProgress(done, batch.length, `${label} (${m.status})...`);
        });
        img.thumb = thumb;
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
  return loans.find((l) => l.status === "active" && (
    (loan.contractNo && norm(l.contractNo) === norm(loan.contractNo)) ||
    (loan.lender && norm(l.lender) === norm(loan.lender) && loan.principal && l.principal === loan.principal &&
      (!loan.startDate || !l.startDate || l.startDate === loan.startDate))));
}

function prepareCandidate({ loan, detected, rawText }, engine) {
  const { loan: l, estimated } = deriveLoan(normalizeLoan({ ...loan, source: engine }));
  const dup = findDuplicate(l);
  return {
    cid: newId(), loan: l, detected, estimated: new Set(estimated), rawText,
    include: true, mergeInto: dup?.id ?? "", dupName: dup?.name ?? "",
  };
}

function renderReviewShell() {
  const ready = images.flatMap((i) => (i.status === "ready" ? i.candidates : []));
  const visible = images.filter((i) => i.status !== "removed");
  const pending = visible.filter((i) => ["pending", "processing"].includes(i.status)).length;
  const chosen = ready.filter((c) => c.include).length;
  $("#review-head").hidden = visible.length === 0;
  $("#review-count").textContent = `(${ready.length} khoản từ ${visible.length} tệp${pending ? `, còn ${pending} tệp đang đọc` : ""})`;
  $("#review-bar").hidden = visible.length === 0;
  $("#btn-save-all").textContent = chosen ? `Lưu ${chosen} khoản đã chọn` : "Lưu";
  $("#btn-save-all").disabled = !chosen;
}

function mergeOptions(selected) {
  const active = loans.filter((l) => l.status === "active");
  return `<option value="">Thêm thành khoản vay mới</option>` +
    active.map((l) => `<option value="${l.id}"${selected === l.id ? " selected" : ""}>Cập nhật vào: ${esc(l.name)}</option>`).join("");
}

function thumbHtml(img) {
  const src = img.thumb || img.url;
  return src
    ? `<div class="review-thumb"><img src="${src}" alt="" loading="lazy" decoding="async" data-zoom="${src}"></div>`
    : `<div class="review-thumb"><div class="pdf-thumb">PDF</div></div>`;
}

function retryButtons(img) {
  return `<div class="retry-row">
    <button class="btn sm" data-img="${img.id}" data-do="retry-ocr">OCR</button>
    <button class="btn sm" data-img="${img.id}" data-do="retry-groq">Groq</button>
    <button class="btn sm" data-img="${img.id}" data-do="retry-claude">Claude</button>
    <button class="btn sm" data-img="${img.id}" data-do="manual">Nhập tay</button>
    <button class="btn sm ghost danger" data-img="${img.id}" data-do="remove">Bỏ tệp</button>
  </div>`;
}

function renderImageCard(img) {
  const list = $("#review-list");
  let el = document.getElementById(`img-${img.id}`);
  if (img.status === "removed") { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = `img-${img.id}`;
    el.style.display = "contents";
    list.appendChild(el);
  }
  const thumb = thumbHtml(img);
  const file = `<div class="file">${esc(img.file.name)}</div>`;

  if (img.status === "pending" || img.status === "processing") {
    el.innerHTML = `<div class="review"><div class="review-top">${thumb}<div class="review-title">${file}
      <div class="muted">${img.status === "pending" ? "Đang chờ..." : "Đang đọc..."}</div></div></div></div>`;
    return;
  }
  if (img.status === "error" || !img.candidates.length) {
    const msg = img.status === "error"
      ? `<b>Không đọc được tệp</b><p class="small" style="margin:4px 0 0">${esc(img.error)}</p>`
      : "<b>Không tìm thấy khoản vay trong tệp</b>";
    el.innerHTML = `<div class="review${img.status === "error" ? " error" : ""}"><div class="review-top">${thumb}
      <div class="review-title">${file}${msg}</div></div>
      <div class="small muted">Thử đọc lại bằng cách khác:</div>${retryButtons(img)}</div>`;
    return;
  }
  el.innerHTML = img.candidates.map((c, idx) => {
    const missing = missingRequired(c.loan);
    return `
    <div class="review${c.include ? "" : " skipped"}" data-cid="${c.cid}">
      <div class="review-top">
        ${thumb}
        <div class="review-title">
          ${file}${img.candidates.length > 1 ? `<div class="small muted">Khoản ${idx + 1}/${img.candidates.length}</div>` : ""}
          <label class="check" style="display:flex;align-items:center;gap:.5rem"><input type="checkbox" data-include${c.include ? " checked" : ""}> Lưu khoản này</label>
          <select data-merge aria-label="Lưu thành">${mergeOptions(c.mergeInto)}</select>
        </div>
      </div>
      ${c.dupName ? `<div class="dup">Có vẻ trùng với khoản "${esc(c.dupName)}" đã có, mặc định sẽ cập nhật vào khoản đó.</div>` : ""}
      <div class="missing" data-missing${missing.length ? "" : " hidden"}>${missing.length ? `Thiếu thông tin bắt buộc: ${missing.map((k) => REQUIRED[k]).join(", ")}` : ""}</div>
      ${fieldsHtml(c.loan, { detected: c.detected, estimated: c.estimated, missing })}
      <div class="review-actions">
        <button class="btn sm ghost" data-do="skip">Bỏ qua</button>
        <button class="btn sm primary" data-do="save-one">Lưu khoản này</button>
      </div>
      ${idx === img.candidates.length - 1 ? `<details><summary class="small muted">Đọc sai? Đọc lại tệp này</summary>${retryButtons(img)}</details>` : ""}
      ${c.rawText ? `<details><summary class="small muted">Xem chữ máy đọc được</summary><pre>${esc(c.rawText)}</pre></details>` : ""}
    </div>`;
  }).join("");
}

function findCandidate(cid) {
  for (const img of images) {
    const c = img.candidates.find((x) => x.cid === cid);
    if (c) return [img, c];
  }
  return [];
}

// Lưu chỉnh sửa vào trạng thái ngay khi gõ, để tệp khác đọc xong không làm mất dữ liệu đang sửa.
$("#review-list").addEventListener("input", (e) => {
  const card = e.target.closest("[data-cid]");
  if (!card) return;
  const [, c] = findCandidate(card.dataset.cid);
  if (!c) return;
  if (e.target.matches("[data-include]")) {
    c.include = e.target.checked;
    card.classList.toggle("skipped", !c.include);
    renderReviewShell();
    return;
  }
  if (e.target.matches("[data-merge]")) {
    c.mergeInto = e.target.value;
    return;
  }
  const k = e.target.name;
  if (c.detected) c.detected[k] = true;
  c.estimated.delete(k);
  const r = rederive({ ...c.loan, ...readFields(card) }, c.estimated);
  c.loan = r.loan;
  c.estimated = r.estimated;
  for (const f of c.estimated) writeField(card, f, c.loan[f]);
  paintState(card, c.loan, { detected: c.detected, estimated: c.estimated, missing: missingRequired(c.loan) });
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
    if (b.dataset.do === "save-one") saveCandidates([[img, c]]);
    return;
  }
  const img = images.find((i) => i.id === b.dataset.img);
  if (!img) return;
  const retry = { "retry-ocr": "ocr", "retry-groq": "groq", "retry-claude": "claude" }[b.dataset.do];
  if (retry) {
    img.engine = retry;
    img.status = "pending";
    img.candidates = [];
    renderImageCard(img);
    processQueue();
  } else if (b.dataset.do === "manual") {
    img.status = "ready";
    img.candidates = [prepareCandidate({ loan: {}, detected: {}, rawText: "" }, "manual")];
    renderImageCard(img);
  } else if (b.dataset.do === "remove") {
    img.status = "removed";
    if (img.url) URL.revokeObjectURL(img.url);
    renderImageCard(img);
  }
  renderReviewShell();
});

function removeCandidate(img, c) {
  img.candidates = img.candidates.filter((x) => x !== c);
  if (!img.candidates.length) { img.status = "removed"; if (img.url) URL.revokeObjectURL(img.url); }
  renderImageCard(img);
  renderReviewShell();
}

// Lưu các mục đủ thông tin; mục thiếu được giữ lại và tô đỏ.
function saveCandidates(pairs) {
  let created = 0, updated = 0, blocked = 0;
  for (const [img, c] of pairs) {
    const { loan: data } = deriveLoan(c.loan);
    const target = c.mergeInto && loans.find((l) => l.id === c.mergeInto);
    const merged = target ? { ...target } : null;
    if (merged) {
      // Chỉ ghi đè các trường có giá trị, giữ lại lịch sử trả nợ của khoản cũ.
      for (const [k, v] of Object.entries(data)) {
        if (["id", "payments", "createdAt", "source", "name"].includes(k)) continue;
        if (v !== "" && v !== 0 && v != null) merged[k] = v;
      }
    }
    const missing = missingRequired(merged ?? data);
    if (missing.length) {
      blocked++;
      const card = document.querySelector(`[data-cid="${c.cid}"]`);
      if (card) paintState(card, c.loan, { detected: c.detected, estimated: c.estimated, missing });
      continue;
    }
    if (merged) {
      Object.assign(target, merged, { updatedAt: new Date().toISOString() });
      updated++;
    } else {
      loans.push(normalizeLoan({ ...data, id: newId(), createdAt: new Date().toISOString() }));
      created++;
    }
    removeCandidate(img, c);
  }
  if (created || updated) commit();
  const parts = [];
  if (created || updated) parts.push(`Đã lưu ${created} khoản mới${updated ? `, cập nhật ${updated} khoản` : ""}`);
  if (blocked) parts.push(`${blocked} mục còn thiếu thông tin bắt buộc (ô đỏ)`);
  if (parts.length) toast(parts.join(". "));
}

$("#btn-save-all").addEventListener("click", () => {
  const pairs = images.flatMap((img) => (img.status === "ready" ? img.candidates.filter((c) => c.include).map((c) => [img, c]) : []));
  if (!pairs.length) { toast("Chưa có mục nào được chọn để lưu"); return; }
  saveCandidates(pairs);
});

$("#btn-discard-all").addEventListener("click", () => {
  if (!confirm("Bỏ toàn bộ tệp và kết quả đang chờ xác nhận?")) return;
  for (const img of images) {
    if (img.status === "processing") continue;
    img.status = "removed";
    if (img.url) URL.revokeObjectURL(img.url);
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
  const cols = [["name", "Tên"], ["lender", "Bên cho vay"], ["contractNo", "Số HĐ"], ["principal", "Gốc vay"], ["remaining", "Tổng nợ còn lại"],
    ["monthlyPayment", "Mỗi tháng"], ["paidPeriods", "Đã trả (kỳ)"], ["termMonths", "Tổng số kỳ"], ["dueDay", "Ngày trả hằng tháng"],
    ["dueDate", "Hạn tới"], ["interestRate", "Lãi suất %"], ["status", "Trạng thái"], ["note", "Ghi chú"]];
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
    const count = l.cycle === "monthly"
      ? remainingPeriods(l) ?? (l.monthlyPayment ? Math.max(1, Math.ceil(l.remaining / l.monthlyPayment)) : 1)
      : 1;
    const day = l.dueDate.replace(/-/g, "");
    return [
      "BEGIN:VEVENT",
      `UID:${l.id}@so-khoan-vay`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      count > 1 ? `RRULE:FREQ=MONTHLY;COUNT=${count}` : "",
      `SUMMARY:${icsText(`Trả nợ ${l.name}: ${money(amountDue(l))}`)}`,
      `DESCRIPTION:${icsText(`${l.lender} ${l.contractNo ? "HĐ " + l.contractNo : ""}\nTổng nợ còn lại: ${money(l.remaining)}`)}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Sắp đến hạn trả nợ", "TRIGGER:-P1D", "END:VALARM",
      "END:VEVENT",
    ].filter(Boolean).join("\r\n");
  });
  download("lich-tra-no.ics", ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//So Khoan Vay//VI", ...events, "END:VCALENDAR"].join("\r\n"), "text/calendar");
});

$("#btn-export").addEventListener("click", () => {
  const { ghToken, claudeKey, groqKey, passphrase, ...safeSettings } = settings;
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

const SETTING_TEXT_KEYS = ["email", "ghOwner", "ghRepo", "ghToken", "passphrase", "claudeKey", "claudeModel", "groqKey", "groqModel"];

function fillSettingsForm() {
  const f = $("#settings-form");
  for (const k of SETTING_TEXT_KEYS) f[k].value = settings[k] || "";
  f.remindDays.value = settings.remindDays.join(", ");
  f.remindOverdue.checked = settings.remindOverdue;
  f.autoSync.checked = settings.autoSync;
  $("#sync-status").textContent = settings.lastSync ? `Lần đồng bộ gần nhất: ${new Date(settings.lastSync).toLocaleString("vi-VN")}` : "";
  paintSettingStates();
}

// Trạng thái ngắn bên phải tiêu đề mỗi mục cài đặt.
function paintSettingStates() {
  const states = {
    email: settings.email ? ["Đã bật", true] : ["Chưa bật", false],
    sync: syncConfigured(settings) ? ["Đã cấu hình", true] : ["Chưa cấu hình", false],
    groq: settings.groqKey ? ["Đã có key", true] : ["Chưa có key", false],
    claude: settings.claudeKey ? ["Đã có key", true] : ["Chưa có key", false],
  };
  for (const [k, [text, on]] of Object.entries(states)) {
    const el = $(`[data-state="${k}"]`);
    el.textContent = text;
    el.classList.toggle("on", on);
  }
}

function readSettingsForm() {
  const f = $("#settings-form");
  const days = f.remindDays.value.split(/[,;\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60);
  settings = {
    ...settings,
    ...Object.fromEntries(SETTING_TEXT_KEYS.map((k) => [k, k === "passphrase" ? f[k].value : f[k].value.trim()])),
    remindDays: days.length ? [...new Set(days)].sort((a, b) => b - a) : [3, 1, 0],
    remindOverdue: f.remindOverdue.checked,
    autoSync: f.autoSync.checked,
  };
  saveSettings(settings);
}

// Cài đặt tự lưu sau khi ngừng gõ, không cần nút Lưu.
let settingsTimer;
$("#settings-form").addEventListener("submit", (e) => e.preventDefault());
$("#settings-form").addEventListener("input", (e) => {
  if (e.target.id === "import-input") return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    readSettingsForm();
    paintSettingStates();
    setEngineRadio();
    $("#settings-status").textContent = `Đã lưu lúc ${new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    scheduleSync();
  }, 500);
});

$("#btn-groq-models").addEventListener("click", async () => {
  const key = $("#settings-form").groqKey.value.trim();
  if (!key) { toast("Nhập Groq API key trước"); return; }
  try {
    const ids = await listGroqModels(key);
    $("#groq-models").innerHTML = ids.map((id) => `<option value="${esc(id)}"></option>`).join("");
    toast(`Tìm thấy ${ids.length} model. Bấm vào ô Model để chọn.`);
  } catch (err) {
    toast(err.message);
  }
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

// Lưu sẵn giao diện và thư viện để mở nhanh, dùng được khi mạng yếu.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Không đăng ký được service worker", err));
}
