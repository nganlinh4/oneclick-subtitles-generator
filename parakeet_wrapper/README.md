# Parakeet TDT 0.6B V3 Speech Transcription API

A Windows-compatible speech transcription API using NVIDIA's Parakeet TDT 0.6B V3 model, powered by onnx-asr for GPU-accelerated inference via DirectML.

## Features

- **Multilingual Transcription**: Supports 25 European languages (bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu, it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru, uk)
- **GPU Acceleration**: Uses DirectML for GPU inference on Windows (no CUDA required)
- **Automatic Punctuation and Capitalization**: Produces clean, readable transcripts
- **Subtitle Segmentation**: Automatically splits transcription into subtitle-sized segments (3-4 seconds each)
- **Word-level Timestamps**: Provides accurate timestamps for each subtitle segment
- **Long Audio Support**: Handles audio up to 24 minutes
- **REST API**: FastAPI-based REST API for programmatic access

## Requirements

- Python 3.8+
- Windows 10/11 with GPU support
- Virtual environment (uv recommended)

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/parakeet-wrapper.git
cd parakeet-wrapper
```

2. Create and activate virtual environment:
```bash
uv venv
uv run --python .venv python -c "import urllib.request; urllib.request.urlretrieve('https://bootstrap.pypa.io/get-pip.py', 'get-pip.py')"
.venv\Scripts\python.exe get-pip.py
```

3. Install dependencies:
```bash
.venv\Scripts\pip install -r requirements.txt
```

## Usage

Run the API server:
```bash
uv run python app.py
```

The API will be available at `http://localhost:8000`.

### API Endpoints

- `GET /`: Health check endpoint
- `POST /transcribe`: Transcribe an audio file

### Transcribe Audio

Upload an audio file via POST request to `/transcribe`:

```bash
curl -X POST "http://localhost:8000/transcribe" \
     -H "accept: application/json" \
     -H "Content-Type: multipart/form-data" \
     -F "file=@your_audio_file.mp3"
```

Response format:
```json
{
  "transcription": "Full text transcription",
  "segments": [
    {
      "start": 0.0,
      "end": 3.7,
      "segment": "First subtitle segment"
    },
    {
      "start": 3.7,
      "end": 7.4,
      "segment": "Second subtitle segment"
    }
  ],
  "csv_data": [
    ["Start (s)", "End (s)", "Segment"],
    ["0.00", "3.70", "First subtitle segment"],
    ["3.70", "7.40", "Second subtitle segment"]
  ],
  "srt_content": "1\n00:00:00,000 --> 00:00:03,700\nFirst subtitle segment\n\n2\n00:00:03,700 --> 00:00:07,400\nSecond subtitle segment\n\n",
  "duration": 103.8
}
```

## Supported Audio Formats

- MP3, WAV, FLAC, OGG
- Automatically resampled to 16kHz mono if needed

## Model

Uses the ONNX-converted Parakeet TDT 0.6B V3 model from [istupakov/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx).

## License

CC BY 4.0 (same as original model)

## Credits

- Original model: NVIDIA Parakeet TDT 0.6B V3
- ONNX conversion: [istupakov](https://huggingface.co/istupakov)
- Inference: [onnx-asr](https://github.com/alphacep/onnx-asr)
