"""Gửi email nhắc hạn trả nợ từ file dữ liệu đã mã hoá data/loans.enc.json.

Chạy bởi GitHub Actions mỗi ngày. Biến môi trường:
  SYNC_PASSPHRASE  mật khẩu mã hoá (trùng với mật khẩu nhập trên web)
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS  thông tin máy chủ gửi mail
  MAIL_FROM        (tuỳ chọn) địa chỉ người gửi, mặc định = SMTP_USER
  MAIL_TO          (tuỳ chọn) ghi đè email nhận trong dữ liệu
  FORCE_SEND=1     gửi bản tổng hợp kể cả khi không có khoản nào đến hạn (để thử)
  DRY_RUN=1        chỉ in nội dung, không gửi
"""

import base64
import datetime as dt
import html
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "loans.enc.json"
TZ = ZoneInfo("Asia/Ho_Chi_Minh")


def decrypt(envelope: dict, passphrase: str) -> dict:
    if envelope.get("format") != "skv-aesgcm-v1":
        raise ValueError(f"Định dạng không hỗ trợ: {envelope.get('format')}")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=base64.b64decode(envelope["salt"]),
        iterations=int(envelope["iterations"]),
    )
    key = kdf.derive(passphrase.encode("utf-8"))
    plain = AESGCM(key).decrypt(base64.b64decode(envelope["iv"]), base64.b64decode(envelope["data"]), None)
    return json.loads(plain.decode("utf-8"))


def money(n) -> str:
    return f"{int(round(n or 0)):,}".replace(",", ".") + " đ"


def fmt_date(d: dt.date) -> str:
    return d.strftime("%d/%m/%Y")


def amount_due(loan: dict) -> float:
    remaining = loan.get("remaining") or 0
    monthly = loan.get("monthlyPayment") or 0
    if loan.get("cycle") == "once" or not monthly:
        return remaining
    return min(monthly, remaining) if remaining else monthly


def pick_due(data: dict, today: dt.date) -> list[tuple[dict, dt.date, int]]:
    settings = data.get("settings", {})
    remind_days = set(settings.get("remindDays") or [3, 1, 0])
    remind_overdue = settings.get("remindOverdue", True)
    out = []
    for loan in data.get("loans", []):
        if loan.get("status") != "active" or not loan.get("dueDate"):
            continue
        try:
            due = dt.date.fromisoformat(loan["dueDate"])
        except ValueError:
            continue
        days = (due - today).days
        if days in remind_days or (days < 0 and remind_overdue):
            out.append((loan, due, days))
    out.sort(key=lambda x: x[1])
    return out


def status_text(days: int) -> str:
    if days < 0:
        return f"Quá hạn {-days} ngày"
    if days == 0:
        return "Hạn hôm nay"
    return f"Còn {days} ngày"


def build_email(items, data: dict, today: dt.date) -> tuple[str, str, str]:
    active = [l for l in data.get("loans", []) if l.get("status") == "active"]
    total_remaining = sum(l.get("remaining") or 0 for l in active)
    overdue = sum(1 for _, _, d in items if d < 0)

    if items:
        subject = f"[Nhắc nợ] {len(items)} khoản cần trả"
        if overdue:
            subject += f" ({overdue} quá hạn)"
        subject += f" - {fmt_date(today)}"
    else:
        subject = f"[Sổ Khoản Vay] Không có khoản nào đến hạn - {fmt_date(today)}"

    lines = [f"Tổng dư nợ đang vay: {money(total_remaining)}", ""]
    rows = []
    for loan, due, days in items:
        name = loan.get("name") or loan.get("lender") or "Khoản vay"
        lines.append(f"- {name}: {money(amount_due(loan))}, hạn {fmt_date(due)} ({status_text(days)})")
        color = "#b42318" if days <= 0 else "#b45309" if days <= 3 else "#16191d"
        rows.append(
            "<tr>"
            f"<td style='padding:8px;border-bottom:1px solid #e5e7eb'><b>{html.escape(name)}</b>"
            f"<br><span style='color:#5d6670;font-size:13px'>{html.escape(loan.get('lender') or '')}"
            f"{' · HĐ ' + html.escape(loan['contractNo']) if loan.get('contractNo') else ''}</span></td>"
            f"<td style='padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap'>{money(amount_due(loan))}</td>"
            f"<td style='padding:8px;border-bottom:1px solid #e5e7eb;white-space:nowrap'>{fmt_date(due)}"
            f"<br><span style='color:{color};font-size:13px'>{status_text(days)}</span></td>"
            "</tr>"
        )
    if not items:
        lines.append("Hôm nay không có khoản nào đến hạn.")

    body_html = f"""<div style="font-family:Arial,sans-serif;color:#16191d;max-width:620px">
<h2 style="margin:0 0 4px">Nhắc hạn trả nợ</h2>
<p style="color:#5d6670;margin:0 0 16px">{fmt_date(today)} · Tổng dư nợ: <b>{money(total_remaining)}</b></p>
{"<table style='border-collapse:collapse;width:100%'><tr><th style='text-align:left;padding:8px'>Khoản vay</th><th style='text-align:right;padding:8px'>Cần trả</th><th style='text-align:left;padding:8px'>Hạn</th></tr>" + "".join(rows) + "</table>" if rows else "<p>Hôm nay không có khoản nào đến hạn.</p>"}
<p style="color:#5d6670;font-size:12px;margin-top:20px">Sau khi trả, hãy mở web và bấm "Ghi nhận trả" để dừng nhắc cho kỳ này.</p>
</div>"""
    return subject, "\n".join(lines), body_html


def send(subject: str, text: str, body_html: str, to_addr: str) -> None:
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT") or 465)
    user = os.environ["SMTP_USER"]
    password = os.environ["SMTP_PASS"]
    sender = os.environ.get("MAIL_FROM") or user

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to_addr
    msg.set_content(text)
    msg.add_alternative(body_html, subtype="html")

    ctx = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as s:
            s.login(user, password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls(context=ctx)
            s.login(user, password)
            s.send_message(msg)


def main() -> int:
    if not DATA_FILE.exists():
        print("Chưa có data/loans.enc.json: hãy cấu hình đồng bộ trên web trước.")
        return 0
    passphrase = os.environ.get("SYNC_PASSPHRASE")
    if not passphrase:
        print("Thiếu secret SYNC_PASSPHRASE", file=sys.stderr)
        return 1
    try:
        data = decrypt(json.loads(DATA_FILE.read_text("utf-8")), passphrase)
    except Exception as e:  # sai mật khẩu -> InvalidTag
        print(f"Không giải mã được dữ liệu (sai SYNC_PASSPHRASE?): {type(e).__name__}", file=sys.stderr)
        return 1

    today = dt.datetime.now(TZ).date()
    items = pick_due(data, today)
    force = os.environ.get("FORCE_SEND") == "1"
    print(f"Hôm nay {today}: {len(items)} khoản cần nhắc")
    if not items and not force:
        return 0

    to_addr = os.environ.get("MAIL_TO") or data.get("settings", {}).get("email")
    if not to_addr:
        print("Chưa có email nhận (nhập trên web hoặc đặt secret MAIL_TO)", file=sys.stderr)
        return 1

    subject, text, body_html = build_email(items, data, today)
    if os.environ.get("DRY_RUN") == "1":
        print(subject)
        print(text)
        return 0
    missing = [k for k in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS") if not os.environ.get(k)]
    if missing:
        print(f"Thiếu secret: {', '.join(missing)}", file=sys.stderr)
        return 1
    send(subject, text, body_html, to_addr)
    print("Đã gửi email nhắc nợ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
