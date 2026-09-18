# OSG — Phần mềm tạo phụ đề

[English](README.md)

Tạo phụ đề, chỉnh thời gian, dịch và xuất video có phụ đề.
Ứng dụng Windows với trình chỉnh sửa timeline, công cụ thuyết minh và bộ render video bằng Rust.

**[Tải OSG 1.0.0 cho Windows x64](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v1.0.0/OSG-1.0.0-windows-x64-setup.exe)** · [Bản phát hành](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v1.0.0) · [Báo lỗi](https://github.com/nganlinh4/oneclick-subtitles-generator/issues)

![Trình chỉnh sửa OSG với video, timeline và nội dung phụ đề](docs/images/readme/editor.png)

*[NASA Explorers: Artemis Generation](https://www.youtube.com/watch?v=2eFHWuNuDSA), với phụ đề từ YouTube được tải và hiển thị trong OSG. Video: NASA's Goddard Space Flight Center. [Chi tiết ảnh chụp](docs/images/readme/README.md).*

## Từ video đến phụ đề

Mở tệp video, âm thanh hoặc dán liên kết video được hỗ trợ. Tạo phụ đề bằng Gemini hay engine
nhận dạng giọng nói cục bộ; nếu đã có tệp phụ đề, bạn có thể nhập vào để chỉnh sửa ngay.

- **Chỉnh sửa ngay trên video.** Sửa nội dung và thời gian trên timeline có sóng âm, thao tác trên
  phạm vi đã chọn và hoàn tác thay đổi.
- **Dịch và kiểm tra.** Dịch phụ đề ngay trong trình chỉnh sửa, rồi lưu tệp phụ đề hoặc xuất video.
- **Tùy chỉnh cách hiển thị.** Chọn font, vị trí, màu sắc và hiệu ứng với bản xem trước video.
- **Thêm thuyết minh.** Tạo giọng đọc bằng nhà cung cấp hoặc engine cục bộ bạn chọn.

![Các tùy chỉnh phụ đề bên cạnh bản xem trước video](docs/images/readme/subtitle-styling.png)

## Trước khi sử dụng

- **Dành cho Windows x64.** Không cần Node.js hay máy chủ phát triển. Xuất video cần GPU và driver
  Direct3D tương thích; máy ảo chỉ có bộ dựng hình phần mềm không hỗ trợ xuất video native.
- **Gemini cần khóa API của bạn.** Hạn mức, chi phí và khả năng sử dụng tùy nhà cung cấp.
  Engine nhận dạng cục bộ là tùy chọn, tải riêng và có thể cần nhiều GB dung lượng cùng phần cứng phù hợp.
- **Công cụ được cài khi cần.** Không cần tự thiết lập FFmpeg, yt-dlp hay Deno.
- **Windows có thể cảnh báo nhà phát hành chưa xác thực.** Trình cài đặt chưa có chữ ký Authenticode;
  bản cập nhật trong ứng dụng được kiểm tra bằng chữ ký riêng.

Dự án và cài đặt được lưu trên máy. Khóa API dùng kho thông tin xác thực của hệ điều hành.
Chức năng đám mây gửi media hoặc văn bản cần thiết đến nhà cung cấp đã chọn;
không phải mọi chức năng đều chạy ngoại tuyến.

<details>
<summary>Bạn đang dùng bản cũ cài bằng tệp batch?</summary>

OSG 1.0.0 là ứng dụng native mới, không phải bản tự động hạ cấp từ 2.x.
Chuyển dữ liệu cần thực hiện thủ công; giữ dữ liệu cũ đến khi đã kiểm tra nhập thành công.
Xem [hướng dẫn chuyển dữ liệu](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/DEVELOPMENT.md#data-and-migration).

[Bản v2.6.1](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/tag/v2.6.1)
và [trình cài đặt batch cho Windows](https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/v2.6.1/OSG_installer_Windows.bat)
vẫn còn. Đường dẫn Latest hiện trỏ đến bản OSG native.

</details>

<details>
<summary>Chạy từ mã nguồn</summary>

Mã nguồn native nằm trên **`rewrite/tauri-rust`**. Nhánh `main` tạm giữ mã ứng dụng cũ
để không làm gián đoạn người dùng tệp batch.

Cài các thành phần trong [hướng dẫn phát triển](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/DEVELOPMENT.md), rồi chạy:

```powershell
git fetch origin
git switch rewrite/tauri-rust
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Dùng lệnh trên thay vì mở riêng executable debug: lệnh này khởi động cả máy chủ phát triển.

[Kiến trúc](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/ARCHITECTURE.md) ·
[Bộ nhớ đệm phát triển](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/rewrite/DEVELOPMENT_CACHE.md) ·
[Quy chuẩn giao diện](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/rewrite/DESIGN.md) ·
[Kiểm tra bản phát hành](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/docs/release/WINDOWS-1.0-VALIDATION.md)

</details>

## Giấy phép

OSG dùng giấy phép [MIT](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/LICENSE).
Model, font và thư viện có điều khoản riêng:
[thông báo bên thứ ba](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/THIRD_PARTY_NOTICES.md).
Thông tin báo cáo bảo mật nằm trong [SECURITY.md](https://github.com/nganlinh4/oneclick-subtitles-generator/blob/rewrite/tauri-rust/SECURITY.md).
