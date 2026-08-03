# Discord Love Bot

Bot tình yêu dùng prefix `.`, toàn bộ phản hồi là Discord embed và GIF anime ngẫu nhiên.

## Chạy bot

```bash
npm install
cp .env.example .env
npm start
```

Bot cần bật **Message Content Intent** và **Server Members Intent** trong Discord Developer Portal.

Cấu hình PostgreSQL trong `.env` hoặc biến môi trường của Render/Railway:

```env
DATABASE_URL=postgresql://user:password@host/database
```

Bot tự tạo bảng `love_bot_state`. Nếu bảng chưa có dữ liệu, bot tự nhập `couples.json`, `intimacy.json` và `love-data.json`; sau đó mọi thay đổi được ghi vào PostgreSQL. Không đưa URL thật vào `.env.example` hoặc GitHub.

## Quan hệ và cấp độ

- `.cauhon @user`: bắt đầu hoặc nâng cấp quan hệ bằng nút đồng ý/từ chối.
- Trạng thái: **Đang tìm hiểu → Đang yêu (30 điểm) → Đính hôn (150 điểm) → Kết hôn (300 điểm)**.
- `.chiatay`: hiện nút xác nhận, có GIF; dữ liệu cũ được lưu vào nhật ký gần nhất.
- `.profile`, `.anniversary`, `.thanmat`, `.nhatky`, `.tuongtac`, `.toplove`.

## Tương tác

`.hon`, `.om`, `.auyem`, `.xoa`, `.namtay`, `.honmuah`, `.qhtd`, `.henho [bien/cafe/rapphim/cong vien]`

Các lệnh tự dùng người yêu đã lưu, không cần mention. Tối đa 20 điểm thân mật mỗi ngày theo giờ Việt Nam.

## Coin và quà

- `.daily`: nhận 60–100 coin mỗi ngày và điểm thân mật nếu đang có đôi.
- `.cuahang`: xem quà.
- `.tangqua hoa|gau|socola|nhan`: mua và tặng quà.

## Tiện ích cặp đôi

- `.bietdanh <tên>`
- `.ky-niem`
- `.lovequote`
- `.checklove @user` hoặc `.checklove ID`

## Drama

- `.ngoaitinh @user`, `.doithu`, `.ghen`
- `.tha-thu`, `.khong-tha-thu`
- `.camdoan [1-30 ngày]`: hoàn thành nhận coin và điểm; phá cam đoan bị trừ điểm.

Dùng `.help` trong Discord để xem danh sách rút gọn.

Nguồn GIF chính: [nekos.best API](https://docs.nekos.best/getting-started/api-reference.html).
Dữ liệu chính được lưu trong PostgreSQL. Ba file JSON chỉ còn là nguồn nhập dữ liệu cũ hoặc fallback khi chưa cấu hình `DATABASE_URL`.