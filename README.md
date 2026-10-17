# Sổ Khoản Vay

Web quản lý khoản vay chạy hoàn toàn trên GitHub (GitHub Pages + GitHub Actions), không cần server riêng.

## Tính năng

- **Đọc ảnh chụp màn hình và PDF hợp đồng**: tải lên không giới hạn số tệp một lần (chọn file, kéo thả, hoặc dán Ctrl+V). Một ảnh danh sách có nhiều khoản vay (vd màn hình SEasy) được tách thành từng khoản. Web đưa kết quả ra để bạn **xác nhận / sửa** trước khi lưu.
  - *OCR miễn phí*: Tesseract.js chạy ngay trong trình duyệt, tệp không rời khỏi máy. Tự tăng tương phản để đọc được chữ xám nhạt, hỗ trợ ảnh nền tối. PDF dạng chữ được đọc trực tiếp, PDF scan được OCR từng trang.
  - *AI Groq* (tuỳ chọn): dùng Groq API key (có gói miễn phí giới hạn lượt), mặc định model đọc ảnh `qwen/qwen3.8-27b`, có nút lấy danh sách model.
  - *AI Claude* (tuỳ chọn): cần API key Anthropic (tính phí riêng, gói Claude Pro không bao gồm API).
- **Thông tin tối thiểu bắt buộc** cho mỗi khoản vay: tổng nợ còn lại, số tiền trả mỗi tháng, đã trả bao nhiêu kỳ, tổng số kỳ (từ đó biết còn bao nhiêu kỳ) và ngày trả. Thiếu thì không lưu được, ô thiếu tô đỏ.
- **Tự suy ra trường còn thiếu** (tô vàng, ghi là ước tính): tổng nợ = tiền mỗi tháng x số kỳ còn lại; ngày đến hạn kỳ tới từ ngày giải ngân + số kỳ đã trả + ngày trả hằng tháng; tiền trả mỗi tháng từ số tiền vay, lãi suất và số kỳ (trả góp đều). Sửa một ô thì các ô ước tính tự tính lại.
  - Hiểu các cách ghi: "6/12 đã thanh toán" (đã trả 6/12 kỳ), "Kỳ thanh toán 3/24" (đang ở kỳ 3, đã trả 2), "đến hạn vào ngày 20 mỗi tháng", "Giải ngân vào ngày 20 Th04 2026", "3,000,000 VND", "1,5 triệu"...
  - Phát hiện khoản trùng (cùng số hợp đồng hoặc cùng bên cho vay + số tiền + ngày giải ngân) và gợi ý cập nhật vào khoản đã có.
- **Thêm / sửa / xoá** khoản vay, tìm kiếm, lọc, sắp xếp.
- **Tổng hợp**: tổng nợ còn lại, số phải trả tháng này, tổng phải trả mỗi tháng, tổng tiền gốc, dư nợ theo bên cho vay, lịch trả 6 tháng tới.
- **Ghi nhận thanh toán**: trừ tổng nợ, tăng số kỳ đã trả, chuyển hạn sang kỳ sau, lưu lịch sử, tự tất toán khi trả đủ.
- **Nhắc hạn trả nợ qua email** mỗi sáng (GitHub Actions + Python), nhắc trước N ngày và nhắc hằng ngày khi quá hạn.
- Cảnh báo trên web và thông báo trình duyệt khi có khoản sắp đến hạn / quá hạn / thiếu thông tin.
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

### 3. Dùng AI Groq hoặc Claude (tuỳ chọn)

- **Groq**: tạo key tại https://console.groq.com/keys, dán vào tab Cài đặt, bấm "Lấy danh sách model" nếu muốn đổi model (phải là model đọc được ảnh). Chọn chế độ **AI Groq** ở tab Thêm từ ảnh.
- **Claude**: tạo API key tại https://console.anthropic.com (tính phí theo lượng dùng, tách biệt với gói Claude Pro), dán vào tab Cài đặt, chọn chế độ **AI Claude**.

Key chỉ lưu trong trình duyệt và được gửi thẳng tới `api.groq.com` / `api.anthropic.com`. Nếu một cách đọc sai, mỗi tệp có nút đọc lại bằng cách khác.

## Dùng trên iPhone như một app

Mở web bằng Safari, bấm nút Chia sẻ, chọn **Thêm vào MH chính**. Web sẽ có biểu tượng riêng, mở toàn màn hình, thanh điều hướng ở đáy, mở nhanh hơn nhờ lưu sẵn giao diện và thư viện trên máy.

Lưu ý: dữ liệu của app trên màn hình chính và của tab Safari là hai nơi lưu riêng trên iOS. Nếu đã nhập dữ liệu trong Safari, hãy Xuất JSON rồi Nhập JSON trong app.

## Lưu ý bảo mật

- Dữ liệu chính nằm trong `localStorage` của trình duyệt. Xoá dữ liệu trình duyệt hoặc đổi máy sẽ không thấy dữ liệu: hãy **Xuất JSON** định kỳ để sao lưu.
- Token GitHub và Claude API key được lưu trong trình duyệt. Chỉ dùng trên máy cá nhân, và dùng token fine-grained giới hạn đúng một repo.
- Kết quả đọc ảnh có thể sai, luôn kiểm tra trước khi bấm Lưu.

## Cấu trúc

```
index.html, styles.css     giao diện
js/app.js                  logic giao diện, tính toán, hàng đợi ảnh
js/extract.js              đọc ảnh/PDF, OCR (Tesseract.js), AI (Groq, Claude)
js/parse.js                bóc tách khoản vay từ chữ OCR / PDF
js/loan.js                 chuẩn hoá, tự suy ra trường thiếu, kiểm tra thông tin bắt buộc
js/store.js                lưu trữ trình duyệt, đồng bộ GitHub
js/crypto.js               mã hoá AES-GCM
reminder/send_reminders.py script gửi email nhắc nợ
.github/workflows/         lịch gửi email, kiểm thử
tests/                     kiểm thử bộ bóc tách và mã hoá
```

Chạy kiểm thử: `node tests/parse.test.mjs` và `pip install -r reminder/requirements.txt && python tests/test_crypto_compat.py`.
