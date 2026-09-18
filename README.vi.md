# OSG — Phần mềm tạo phụ đề

[English](README.md)

Ứng dụng Windows để tạo, chỉnh sửa và dịch phụ đề, thêm thuyết minh và xuất video có phụ đề.

## Tải OSG

**[Tải OSG 1.0.0 cho Windows x64](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v1.0.0/OSG-1.0.0-windows-x64-setup.exe).**
Windows có thể cảnh báo nhà phát hành chưa được ký xác thực. Bản native dùng kênh cập nhật riêng
có chữ ký. OSG 1.0.0 là bản phát hành hiện tại; mã nguồn native nằm trên `rewrite/tauri-rust`.
Nhánh `main` tạm giữ mã nguồn ứng dụng cũ để người dùng tệp batch tiếp tục sử dụng.

[OSG 1.0.0](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v1.0.0) ·
[Kiểm tra trước phát hành](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/release/WINDOWS-1.0-VALIDATION.md)

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
Xem [hướng dẫn chuyển dữ liệu](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/DEVELOPMENT.md#data-and-migration).

### Ứng dụng cũ

Nếu cần bản cũ, dùng [bản v2.6.1](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v2.6.1)
và [trình cài đặt batch cho Windows](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v2.6.1/OSG_installer_Windows.bat).
Không dùng đường dẫn Latest để tải trình cài đặt cũ; Latest hiện chỉ bản OSG native.

## Phát triển

Cài toolchain và thành phần hệ thống theo [hướng dẫn phát triển](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/DEVELOPMENT.md), rồi chạy:

```powershell
git fetch origin
git switch rewrite/tauri-rust
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Không mở riêng executable debug: lệnh trên khởi động cả Vite và ứng dụng.
Build và bằng chứng kiểm thử dùng [bộ nhớ đệm ngoài có giới hạn](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/rewrite/DEVELOPMENT_CACHE.md).
Giao diện Material 3 Expressive đã duyệt trên nhánh hiện tại là chuẩn giao diện.

[Báo lỗi](https://github.com/nganlinh4/oneclick-subtitles-generator/issues) · [Bảo mật](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/SECURITY.md)

## Giấy phép

Mã nguồn OSG dùng [MIT](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/LICENSE). Model, runtime, font và thư viện có điều khoản riêng:
[xem thông báo bên thứ ba](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/THIRD_PARTY_NOTICES.md).
