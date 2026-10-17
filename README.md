# Sổ Khoản Vay

Web quản lý khoản vay chạy hoàn toàn trên GitHub (GitHub Pages + GitHub Actions), không cần server riêng.

## Tính năng

- **Đọc thông tin từ ảnh chụp màn hình**: tải lên không giới hạn số ảnh một lần (chọn file, kéo thả, hoặc dán Ctrl+V). Web tự đọc số tiền vay, dư nợ, số tiền trả mỗi kỳ, ngày đến hạn, lãi suất, kỳ hạn, số hợp đồng, bên cho vay rồi đưa ra để bạn **xác nhận / sửa** trước khi lưu.
  - *OCR miễn phí*: Tesseract.js chạy ngay trong trình duyệt, ảnh không rời khỏi máy. Hỗ trợ ảnh nền tối.
  - *AI Claude* (tuỳ chọn): chính xác hơn, đọc được nhiều khoản vay trong một ảnh. Cần API key Anthropic của bạn.
  - Phát hiện khoản trùng (cùng số hợp đồng hoặc cùng bên cho vay + số tiền) và gợi ý cập nhật vào khoản đã có thay vì tạo mới.
- **Thêm / sửa / xoá** khoản vay, tìm kiếm, lọc, sắp xếp.
- **Tổng hợp**: tổng dư nợ, tổng tiền gốc, số phải trả tháng này, tổng đã trả, dư nợ theo bên cho vay, lịch trả 6 tháng tới.
- **Ghi nhận thanh toán**: trừ dư nợ, tự chuyển hạn sang kỳ sau, lưu lịch sử, tự đánh dấu tất toán khi hết nợ.
- **Nhắc hạn trả nợ qua email** mỗi sáng (GitHub Actions + Python), nhắc trước N ngày và nhắc hằng ngày khi quá hạn.
- Cảnh báo trên web và thông báo trình duyệt khi có khoản sắp đến hạn / quá hạn.
- Xuất CSV (mở bằng Excel), xuất lịch `.ics` (nhập vào Google Calendar / lịch điện thoại), sao lưu / khôi phục JSON.

## Cài đặt (làm một lần)

### 1. Bật GitHub Pages

Repo → **Settings → Pages** → *Build and deployment*: Source = **Deploy from a branch**, Branch = **main**, thư mục **/ (root)** → Save.
Sau 1-2 phút web có tại `https://<tên-github>.github.io/<tên-repo>/`.

Chỉ đến đây là đã dùng được: đọc ảnh, quản lý, tính tổng. Dữ liệu lưu trong trình duyệt của bạn.

### 2. Bật nhắc nợ qua email (tuỳ chọn)

Vì GitHub Pages chỉ là web tĩnh, việc gửi mail do GitHub Actions đảm nhận. Web mã hoá dữ liệu bằng mật khẩu của bạn (AES-256-GCM) rồi ghi vào `data/loans.enc.json`; mỗi sáng script `reminder/send_reminders.py` giải mã và gửi mail. Người xem repo công khai chỉ thấy dữ liệu đã mã hoá.

**a. Tạo mật khẩu ứng dụng Gmail** (nếu gửi bằng Gmail): bật xác minh 2 bước cho tài khoản Google, sau đó tạo *App password* tại https://myaccount.google.com/apppasswords.

**b. Thêm secrets**: Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Giá trị |
|---|---|
| `SYNC_PASSPHRASE` | Mật khẩu mã hoá do bạn tự đặt (nhập giống hệt trên web) |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | địa chỉ Gmail dùng để gửi |
| `SMTP_PASS` | App password ở bước a |
| `MAIL_TO` | (tuỳ chọn) email nhận, nếu muốn ghi đè email nhập trên web |

**c. Tạo token để web ghi dữ liệu vào repo**: https://github.com/settings/personal-access-tokens/new → *Fine-grained token* → Repository access: **Only select repositories** (chọn repo này) → Permissions → **Contents: Read and write** → Generate.

**d. Trên web, tab Cài đặt**: nhập email nhận, số ngày nhắc trước, owner/repo (tự điền khi chạy trên github.io), token, mật khẩu mã hoá → **Lưu cài đặt** → **Đồng bộ ngay**.

**e. Gửi thử**: Repo → **Actions → Nhắc hạn trả nợ → Run workflow** (để tick "Gửi email thử") → kiểm tra hộp thư.

Lịch chạy: 01:00 UTC (8 giờ sáng giờ Việt Nam). GitHub có thể chạy trễ một chút. Với repo công khai, GitHub tự tắt lịch chạy nếu repo không có hoạt động trong 60 ngày; mỗi lần đồng bộ từ web là một commit nên vẫn tính là có hoạt động.

### 3. Dùng AI Claude (tuỳ chọn)

Tạo API key tại https://console.anthropic.com, dán vào tab Cài đặt, chọn chế độ **AI Claude** ở tab Thêm từ ảnh. Key chỉ lưu trong trình duyệt và được gửi thẳng tới `api.anthropic.com`. Chi phí tính theo tài khoản Anthropic của bạn; có thể chọn model rẻ hơn trong Cài đặt.

## Lưu ý bảo mật

- Dữ liệu chính nằm trong `localStorage` của trình duyệt. Xoá dữ liệu trình duyệt hoặc đổi máy sẽ không thấy dữ liệu: hãy **Xuất JSON** định kỳ để sao lưu.
- Token GitHub và Claude API key được lưu trong trình duyệt. Chỉ dùng trên máy cá nhân, và dùng token fine-grained giới hạn đúng một repo.
- Kết quả đọc ảnh có thể sai, luôn kiểm tra trước khi bấm Lưu.

## Cấu trúc

```
index.html, styles.css     giao diện
js/app.js                  logic giao diện, tính toán, hàng đợi ảnh
js/extract.js              OCR (Tesseract.js) và AI (Claude)
js/parse.js                bóc tách khoản vay từ chữ OCR
js/store.js                lưu trữ trình duyệt, đồng bộ GitHub
js/crypto.js               mã hoá AES-GCM
reminder/send_reminders.py script gửi email nhắc nợ
.github/workflows/         lịch gửi email, kiểm thử
tests/                     kiểm thử bộ bóc tách và mã hoá
```

Chạy kiểm thử: `node tests/parse.test.mjs` và `pip install -r reminder/requirements.txt && python tests/test_crypto_compat.py`.
