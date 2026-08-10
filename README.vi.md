# Phần Mềm Tạo Phụ Đề Tự Động

Read the [English version](README.md). Xem [ảnh chụp giao diện](README.md#screenshots).

One-Click Subtitles Generator (OSG) là ứng dụng desktop local-first để tạo, chỉnh sửa và dịch phụ
đề; tạo thuyết minh và media hỗ trợ; sau đó render video có phụ đề. Bản rewrite hiện tại giữ nguyên
giao diện cũ, đồng thời thay Electron và hệ thống nhiều server bằng Tauri 2 cùng core Rust.

> **Trạng thái rewrite:** Windows x64 có catalog runtime tải theo nhu cầu và cấu hình installer đã
> ký đủ điều kiện phát hành. Catalog Linux/macOS vẫn để trống cho đến khi có build đúng target và
> test thiết bị thật. Không dùng script cài cũ đã xóa và không có bản hosted/Vercel.

## Phần đã chuyển sang native

| Khu vực | Trạng thái hiện tại |
| --- | --- |
| Project và chỉnh sửa | Chọn/thả media bằng native, project và revision trong SQLite, undo/redo, job bền vững, settings, cache, nhập phụ đề và export native. |
| Gemini | Rust quản lý transcription, translation, phân tích phụ đề, tạo ảnh, key rotation/cooldown và upload có giới hạn. Mọi model thông thường được công khai đều nhận audio hoặc video. |
| Provider và âm nhạc | Genius, metadata/OAuth YouTube và phiên Lyria RealTime chạy qua native; secret nằm trong kho credential của hệ điều hành. |
| Media và download | Pipeline typed cho probe, compatibility, extract, waveform, download và cancel. Bản đóng gói vẫn cần tool đã được review cho từng target. |
| ASR local | Windows x64 có thể tải và gỡ hoàn toàn Parakeet, Faster-Whisper Turbo/Large-v3 và Qwen3-ASR 0.6B/1.7B đã xác minh. Catalog Linux/macOS vẫn để trống. |
| Thuyết minh | Windows x64 có thể tải và gỡ hoàn toàn F5-TTS và Chatterbox; Edge TTS, gTTS và Gemini dùng chung worker runtime được quản lý. Trọng số F5 ghi rõ `CC-BY-NC-4.0`. |
| Render | Windows x64 có thể tải và gỡ hoàn toàn runtime Node/Chrome-for-Testing/Remotion; payload 625 MB không bị nhúng vào installer. |
| Cập nhật | Public key và cấu hình artifact đã ký đã có; private signing key nằm ngoài repository. |

Có command native không đồng nghĩa runtime tương ứng đã cài được. Khi thiếu tool/model, OSG báo
không khả dụng; ứng dụng không tự tải binary chưa review và không quay lại các localhost service cũ.

### Policy model Gemini

`src/config/geminiModelCatalog.json` là catalog model frontend duy nhất và ghi nhận
`screen-goated-toolbox/catalog/model_catalog.json` là nguồn đồng bộ. Catalog hiện công khai
`gemini-3.5-flash-lite` (mặc định hằng ngày/transcription), `gemini-3.6-flash`,
`gemini-3.5-flash` và `gemini-3.1-flash-lite` cho tác vụ multimodal thông thường; cả bốn đều nhận
audio và video. Tạo ảnh dùng `gemini-3.1-flash-image`, model này nhận video; live audio dùng
`gemini-3.1-flash-live-preview` và `gemini-2.5-flash-native-audio-preview-12-2025`.
`npm run test:gemini-catalog` từ chối mọi model công khai không nhận cả audio lẫn video, đồng thời
giữ ID cũ làm migration alias thay vì model có thể chọn.

## Trạng thái nền tảng

| Target | Trạng thái |
| --- | --- |
| Windows x64 | Máy phát triển và test thủ công hiện tại; source build đã được dùng, nhưng đóng gói release vẫn bị gate chặn. |
| macOS Apple Silicon / Intel | Đã cấu hình target trong build matrix; chưa xác minh runtime, media, signing và installer trên máy thật. |
| Linux x64 | Đã cấu hình target trong build matrix; chưa xác minh runtime, media, desktop integration và package trên máy thật. |

Mục tiêu sản phẩm là đa nền tảng, nhưng hiện chưa thể tuyên bố macOS và Linux là bản release được
hỗ trợ.

## Chạy từ mã nguồn

Toolchain được pin ở Node.js 24.19.0, npm 11.17.0, Python 3.12.10, Rust 1.97.1 và
Tauri CLI 2.11.4. Cài
[prerequisite hệ thống của Tauri](https://v2.tauri.app/start/prerequisites/) cho hệ điều hành, rồi
chạy tại thư mục gốc repo:

```powershell
npm ci
npm --prefix apps/desktop ci
npm run tauri:dev
```

Tauri tự khởi động Vite. `npm run dev:vite` chỉ phù hợp để kiểm tra frontend; chế độ browser không
chạy được native command và không thay thế ứng dụng desktop.

Compile mà không tạo bộ cài:

```powershell
npm run build:frontend
cargo check --workspace --all-features --locked
npm run tauri -- build --no-bundle --ci -- --locked
```

## Kiểm tra

```powershell
npm audit --omit=dev --audit-level=high
npm run check:dependencies
npm run lint
npm test
npm run check:i18n
npm run test:gemini-catalog
npm run test:frontend-env
npm run test:python-workers
npm run test:frozen-css
npm run test:production-transport
npm run check:versions
npm run test:version-consistency
npm run check:tauri-contract
npm run check:visual-freeze
npm run test:visual-contract
npm run test:render-worker
npm run build:frontend
npm run check:frozen-css-output
npm run check:production-transport
node scripts/check-release-readiness.js --profile compile
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
```

Profile `compile` kiểm tra source và invariant của repo. Profile `runtime-package` nghiêm ngặt theo
từng target được dự kiến sẽ fail cho đến khi có đủ runtime đang bị giữ lại, updater key và policy
license/notice được chủ repo phê duyệt; bỏ qua gate này không tạo ra một release hợp lệ.

Ví dụ gate release cho Windows là:

```powershell
node scripts/check-release-readiness.js --profile runtime-package --target x86_64-pc-windows-msvc
```

Ba target còn lại trong matrix là `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin` và
`x86_64-apple-darwin`.

## Trạng thái phân phối runtime

| Runtime | Trạng thái phân phối |
| --- | --- |
| yt-dlp | Release direct `2026.07.04` đã review là baseline cho bốn nhóm target. Lần kiểm tra URL đầu tiên sẽ xin xác nhận và cài với tiến trình có thể hủy. Nếu tiến trình yt-dlp đã cài bị lỗi, host chỉ thực hiện một lần kiểm tra release immutable có giới hạn; phiên bản mới được xác minh sẽ được cài song song với binary đang có lease và chỉ kích hoạt sau khi khởi động lại. Ứng dụng không chạy `yt-dlp -U`, không ghi đè binary đang chạy và không tự lặp lại thao tác media đã lỗi. |
| Deno | Catalog có release direct-upstream `2.9.5`, content-addressed đã review cho bốn nhóm target. Preflight kiểm tra URL dùng cùng bước xác nhận, tiến trình có thể hủy và dừng để yêu cầu khởi động lại trước khi kích hoạt; binary không được bundle hay tải lúc khởi động. |
| FFmpeg / ffprobe | Windows x64 tải trực tiếp archive vendor `8.1.2` đã khóa hash, chỉ cài hai executable cùng license/build notice và yêu cầu khởi động lại. Linux/macOS vẫn fail-closed cho đến khi có delivery tương đương đã review. |
| Parakeet / Faster-Whisper / Qwen3-ASR | Windows x64 có manifest runtime/model content-addressed, ưu tiên nguồn model chính thức rồi mới dùng bundle pool đã review. Cả năm engine đều cài, chạy với lease và gỡ qua job native typed. |
| F5-TTS / Chatterbox / Edge TTS / gTTS / Gemini TTS worker | Windows x64 có runtime/model đã xác minh. F5 và Chatterbox tải/gỡ độc lập; các mode provider dùng chung worker runtime. License model F5 là `CC-BY-NC-4.0`. |
| Remotion runtime | Windows x64 tải archive bundle pool content-addressed 265 MB gồm Node 24.19, Chrome for Testing 149, Remotion 4.0.507, bundle OSG, font Inter đã review và notice; cài khoảng 625 MB và gỡ hoàn toàn được. |
| Updater ứng dụng | Public key đã cấu hình; artifact updater được ký bằng private key nằm ngoài repository. |

Phần trợ giúp YouTube hiện mô tả đúng OAuth client loại **Desktop app** và callback loopback tạm
thời; production bundle không chứa callback trình duyệt cũ.

Nội dung trợ giúp API key ghi đúng kho credential của hệ điều hành; giá trị browser cũ chỉ được
import một lần rồi xóa.

Phân phối speech Windows gồm runtime, thư viện bắc cầu, model, notice và kiểm tra worker offline đã
review. Model F5TTS v1 base vẫn dùng `CC-BY-NC-4.0` và được ghi rõ trong UI.

Capability `manage-native-tools` công khai command typed cho
catalog/status/install/remove/cancel; path executable và URL upstream vẫn ở native. OSG sẽ báo khi
activation hoặc deferred removal phải chờ restart vì consumer đang giữ tool lease. Flow người dùng
hiện tại gọi catalog/status/install/cancel từ thao tác media có sẵn; tab Tools compact cho phép gỡ
đã xác nhận mọi runtime được quản lý. Một
lần xác nhận duy nhất nêu rõ đúng package cần thiết và license trước khi tải. Tiến trình cài dùng
toast hiện có với nút hủy rõ ràng; sau khi cài xong, flow không thử lại trên runtime cũ mà yêu cầu
khởi động lại. FFmpeg/ffprobe chỉ được đề nghị trên Windows x64 từ catalog đã review.

Build debug có thể tìm tool trong source tree hoặc hệ thống đã được cho phép rõ ràng. Build release
không phụ thuộc vào `PATH` hay bản cài cục bộ tùy ý.

## Dữ liệu và migration

Ứng dụng native lưu project, revision, trạng thái job, settings và metadata artifact trong SQLite.
Credential nằm trong Windows Credential Manager, macOS Keychain hoặc Linux Secret Service; UI chỉ
nhận opaque reference và status an toàn.

Legacy import chỉ chạy sau khi người dùng tự chọn thư mục dữ liệu cũ. Nó có thể copy artifact được
hỗ trợ, preference an toàn và credential được hỗ trợ; từ chối link hoặc source bị thay đổi; retry
an toàn; không xóa thư mục nguồn; và bỏ qua cache tạm, path, URL cùng provider handle đã lỗi thời.

## Cam kết không đổi giao diện

Rewrite giữ nguyên JSX, CSS, asset, font, theme, locale, responsive behavior, thứ tự workflow,
PromptDJ và composition Remotion. Native adapter được nối phía sau interaction hiện hữu. Mọi thay
đổi product design có chủ ý cần được duyệt riêng và cập nhật baseline qua review riêng.

Ba bộ locale được duy trì là tiếng Anh, tiếng Việt và tiếng Hàn. `npm run check:i18n` bắt buộc mọi
translation key tĩnh phải có bản tiếng Việt và tiếng Hàn, đồng thời từ chối user-facing string đã
được audit nhưng bỏ qua i18n.

## Tài liệu

- [Kiến trúc và ranh giới crate](ARCHITECTURE.md)
- [Mô hình bảo mật và trust boundary](SECURITY.md)
- [Quy tắc visual freeze](docs/rewrite/DESIGN.md)
- [Tauri desktop host](apps/desktop/README.md)
- [Native render worker](video-renderer/README.md)

## Giấy phép

Repo chưa chọn giấy phép chung ở thư mục gốc. Chủ repo cần quyết định, thêm `LICENSE` và policy
notice/corresponding source cho toàn dự án trước khi phân phối; release gate cũng yêu cầu
`THIRD_PARTY_NOTICES.md`. License của dependency hoặc từng crate không tự động trở thành license
của toàn bộ repo.
