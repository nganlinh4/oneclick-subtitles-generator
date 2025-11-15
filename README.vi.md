# Phần Mềm Tạo Phụ Đề Tự Động

Phần mềm web giúp auto-sub cho video, audio, dịch SRT, thuyết minh, tạo hình nền, render video phù hợp với người dùng phổ thông.

## Hướng Dẫn Cài Đặt Nhanh

### Cài Đặt Trên Windows

- Vào mục [Releases](https://github.com/nganlinh4/oneclick-subtitles-generator/releases) tải về OSG_installer_Windows.bat phiên bản mới nhất.

- Mở file .bat vừa tải và làm theo hướng dẫn (kích thước app sẽ lớn nếu cài với tính năng clone giọng)

### Cài Đặt Trên macOS và Ubuntu

- Clone repo này về máy + chạy file OSG_installer.sh:
  ```bash
  git clone https://github.com/nganlinh4/oneclick-subtitles-generator.git
  cd oneclick-subtitles-generator
  chmod +x OSG_installer.sh
  ./OSG_installer.sh
  ```

- Làm theo hướng dẫn trên màn hình (kích thước app sẽ lớn nếu cài với tính năng clone giọng)

### Cập Nhật hoặc Chạy Ứng Dụng

#### Windows
- Mở OSG_installer_Windows.bat và làm theo hướng dẫn.

#### macOS và Ubuntu
- Mở Terminal và chạy lại file OSG_installer.sh:
  ```bash
  ./OSG_installer.sh
  ```

- Trình duyệt sẽ tự động mở tại http://localhost:3030

## So Sánh Các Tùy Chọn Cài Đặt

Chọn phiên bản phù hợp với nhu cầu của bạn:

| Tính Năng | OSG Lite | OSG Full | OSG Vercel |
|---------|----------|------------|------------|
| **Tạo Phụ Đề AI** | ✅ Gemini AI transcription | ✅ Gemini + Parakeet AI transcription | ✅ Gemini AI transcription |
| **Nguồn Video** | ✅ YouTube, Douyin/TikTok, 1000+ nền tảng + Tải lên | ✅ YouTube, Douyin/TikTok, 1000+ nền tảng + Tải lên | Chỉ tải lên |
| **Trình Chỉnh Sửa Phụ Đề** | ✅ Timeline trực quan, sóng âm, xem trước thực tế | ✅ Timeline trực quan, sóng âm, xem trước thực tế | ✅ Timeline trực quan, sóng âm, xem trước thực tế |
| **Dịch Thuật** | ✅ Đa ngôn ngữ với nhận thức ngữ cảnh | ✅ Đa ngôn ngữ với nhận thức ngữ cảnh | ✅ Đa ngôn ngữ với nhận thức ngữ cảnh |
| **Render Video** | ✅ GPU-accelerated với Remotion | ✅ GPU-accelerated với Remotion | ❌ Không có sẵn |
| **Tạo Nhạc Nền** | ✅ Nhạc AI với Lyria | ✅ Nhạc AI với Lyria | ✅ Nhạc AI với Lyria |
| **TTS Cơ Bản** | ✅ Gemini Live API, Edge TTS, Google TTS | ✅ Gemini Live API, Edge TTS, Google TTS | ❌ Không có sẵn |
| **Clone Giọng** | ❌ Không bao gồm | ✅ F5-TTS, Chatterbox | ❌ Không có sẵn |
| **Kích Thước Thư Mục Dự Án** | ~2-3 GB | ~8-12 GB | N/A (hosted) |
| **Yêu Cầu GPU** | Bất kỳ GPU nào để render video | GPU accelerated voice cloning (CPU fallback có sẵn) | Không (không có render) |

### 💡 **Khuyến Nghị:**
- **Chọn OSG Lite** nếu bạn cần tạo phụ đề nhanh và render video mà không cần clone giọng
- **Chọn OSG (Full)** nếu bạn cần các tính năng clone giọng nâng cao và thuyết minh
