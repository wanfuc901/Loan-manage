"""Kiểm tra dữ liệu mã hoá bởi js/crypto.js giải mã được bằng reminder/send_reminders.py."""
import datetime as dt
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "reminder"))
import send_reminders as sr  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "loans.enc.json"
    subprocess.run(["node", str(ROOT / "tests" / "crypto-roundtrip.mjs"), str(out)], check=True)
    data = sr.decrypt(json.loads(out.read_text("utf-8")), "mật khẩu thử")

today = dt.datetime.now(sr.TZ).date()
names = [loan["name"] for loan, _, _ in sr.pick_due(data, today)]
assert names == ["SPayLater", "Tiếng Việt có dấu đ ơ ư", "Vay Home Credit"], names
subject, text, body = sr.build_email(sr.pick_due(data, today), data, today)
assert "1 quá hạn" in subject, subject
print("OK")
