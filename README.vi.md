# OSG — Phần mềm tạo phụ đề

[English](README.md)

Ứng dụng Windows để tạo, chỉnh sửa và dịch phụ đề, thêm thuyết minh và xuất video có phụ đề.

## Tải OSG

**[Tải OSG 1.0.0 cho Windows x64](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v1.0.0/OSG-1.0.0-windows-x64-setup.exe).**
Windows có thể cảnh báo nhà phát hành chưa được ký xác thực. Bản native dùng kênh cập nhật riêng
có chữ ký. Nhánh `rewrite/tauri-rust` là ứng dụng chính thức; GitHub Latest (`v2.6.1`) vẫn là
ứng dụng cũ, không phải bản native này.

[OSG 1.0.0](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v1.0.0) ·
[Kiểm tra trước phát hành](docs/release/WINDOWS-1.0-VALIDATION.md)

Phiên bản 1.0.0 dành cho **Windows x64**, sử dụng Tauri, WebView2 và Rust.
Bản đóng gói không cần Node.js hay máy chủ phát triển. Chưa hỗ trợ phát hành cho Linux/macOS.
Xuất video native cần GPU và driver Direct3D tương thích; máy ảo Windows chỉ có bộ dựng hình
phần mềm không cung cấp đường xử lý video cần thiết.

## Chức năng

- Mở media trên máy hoặc tải video từ các trang được hỗ trợ.
- Tạo phụ đề bằng Gemini hoặc engine nhận dạng giọng nói cục bộ.
- Sửa nội dung, thời gian, người nói; dịch và lưu tệp phụ đề.
- Tùy chỉnh phụ đề và xuất video bằng bộ render native.
- Tạo thuyết minh bằng engine tải theo nhu cầu.
- Công cụ hỗ trợ phân tích video, tài liệu, hình ảnh và âm nhạc.

Gemini cần khóa API riêng và kết nối mạng. Hạn mức, chi phí và khả năng sử dụng phụ thuộc
tài khoản nhà cung cấp. Engine cục bộ có thể cần nhiều GB dung lượng; yêu cầu phần cứng
tùy engine. Công cụ runtime cần thiết được cài tự động khi sử dụng.

## Dữ liệu và chuyển phiên bản

Dự án và cài đặt được lưu trên máy. Khóa API được lưu trong kho thông tin xác thực của hệ điều hành.
Chức năng đám mây gửi media hoặc văn bản cần thiết đến nhà cung cấp đã chọn;
không phải mọi chức năng đều chạy ngoại tuyến.

Chuyển từ ứng dụng cũ 2.x sang native 1.0.0 cần **chuyển dữ liệu thủ công**.
Giữ dữ liệu cũ đến khi kiểm tra nhập thành công.
Xem [hướng dẫn chuyển dữ liệu](docs/DEVELOPMENT.md#data-and-migration).

## Phát triển

Cài toolchain và thành phần hệ thống theo [hướng dẫn phát triển](docs/DEVELOPMENT.md), rồi chạy:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Không mở riêng executable debug: lệnh trên khởi động cả Vite và ứng dụng.
Build và bằng chứng kiểm thử dùng [bộ nhớ đệm ngoài có giới hạn](docs/rewrite/DEVELOPMENT_CACHE.md).
Giao diện Material 3 Expressive đã duyệt trên nhánh hiện tại là chuẩn giao diện.

[Báo lỗi](https://github.com/nganlinh4/oneclick-subtitles-generator/issues) · [Bảo mật](SECURITY.md)

## Giấy phép

Mã nguồn OSG dùng [MIT](LICENSE). Model, runtime, font và thư viện có điều khoản riêng:
[xem thông báo bên thứ ba](THIRD_PARTY_NOTICES.md).
