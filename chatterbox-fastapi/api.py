"""
FastAPI wrapper for Chatterbox TTS with simplified controls.
Only exposes the 2 primary controls: exaggeration and cfg_weight.
"""

import io
import sys
import tempfile
from pathlib import Path
import torch
import torchaudio as ta
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from typing import Optional
import uvicorn

# Add the server directory to the path to import the CORS config
sys.path.append(str(Path(__file__).parent.parent / "server"))
from config.cors_config import get_fastapi_cors_config

from chatterbox import ChatterboxMultilingualTTS, ChatterboxTTS
from chatterbox.vc import ChatterboxVC


# Initialize FastAPI app
app = FastAPI(
    title="Chatterbox TTS API",
    description="Simple API for Chatterbox Text-to-Speech with primary controls only",
    version="1.0.0"
)

# Add CORS middleware using centralized configuration
fastapi_cors_config = get_fastapi_cors_config()
app.add_middleware(
    CORSMiddleware,
    **fastapi_cors_config
)

# Global model instances (loaded once on startup)
tts_model_multi = None  # ChatterboxMultilingualTTS
tts_model_en = None     # Legacy ChatterboxTTS (English only)
vc_model = None

# Automatically detect the best available device
if torch.cuda.is_available():
    DEVICE = "cuda"
elif torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"


# Pydantic models for request/response
class TTSRequest(BaseModel):
    text: str = Field(..., description="Text to synthesize", max_length=300)
    exaggeration: float = Field(0.5, description="Emotional intensity (0.25-2.0, neutral=0.5)", ge=0.25, le=2.0)
    cfg_weight: float = Field(0.5, description="CFG/Pace control (0.0-1.0)", ge=0.0, le=1.0)


class TTSResponse(BaseModel):
    message: str
    sample_rate: int


class HealthResponse(BaseModel):
    status: str
    device: str
    models_loaded: dict


@app.on_event("startup")
async def startup_event():
    """Initialize service without loading models - models will be loaded on first wake-up call"""
    global tts_model_multi, tts_model_en, vc_model

    print(f"Chatterbox API service starting on device: {DEVICE}")
    print("Models will be loaded on first wake-up call for faster startup")

    # Don't load models on startup - let them be loaded on demand via wake-up endpoint
    tts_model_multi = None
    tts_model_en = None
    vc_model = None

    print("Service ready - call /wake-up to load models")


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    tts_loaded = (tts_model_multi is not None) or (tts_model_en is not None)
    return HealthResponse(
        status="healthy" if tts_loaded else "degraded",
        device=DEVICE,
        models_loaded={
            "tts": tts_loaded,
            "tts_multi": tts_model_multi is not None,
            "tts_en": tts_model_en is not None,
            "vc": vc_model is not None
        }
    )


@app.post("/wake-up")
async def wake_up_service():
    """
    Wake up the service by ensuring models are loaded.
    This endpoint can be called to initialize the service on first use.
    """
    global tts_model_multi, tts_model_en, vc_model

    try:
        # If models are already loaded, return success immediately
        if tts_model_multi is not None and vc_model is not None:
            return {
                "status": "already_awake",
                "message": "Service is already running and models are loaded",
                "device": DEVICE,
                "models_loaded": {
                    "tts": True,
                    "tts_multi": True,
                    "tts_en": tts_model_en is not None,
                    "vc": True
                }
            }

        # Load models if not already loaded
        print(f"Wake-up request received, loading models on device: {DEVICE}")

        if tts_model_multi is None:
            print("Loading Multilingual TTS model...")
            tts_model_multi = ChatterboxMultilingualTTS.from_pretrained(DEVICE)
            print("Multilingual TTS model loaded successfully")

        if vc_model is None:
            print("Loading VC model...")
            vc_model = ChatterboxVC.from_pretrained(DEVICE)
            print("VC model loaded successfully")

        return {
            "status": "awakened",
            "message": "Service has been awakened and models are loaded",
            "device": DEVICE,
            "models_loaded": {
                "tts": (tts_model_multi is not None) or (tts_model_en is not None),
                "tts_multi": tts_model_multi is not None,
                "tts_en": tts_model_en is not None,
                "vc": vc_model is not None
            }
        }

    except Exception as e:
        print(f"Error during wake-up: {e}")
        return {
            "status": "error",
            "message": f"Failed to wake up service: {str(e)}",
            "device": DEVICE,
            "models_loaded": {
                "tts": (tts_model_multi is not None) or (tts_model_en is not None),
                "tts_multi": tts_model_multi is not None,
                "tts_en": tts_model_en is not None,
                "vc": vc_model is not None
            }
        }


@app.post("/tts/generate")
async def generate_speech(
    text: str = Form(..., description="Text to synthesize", max_length=300),
    language_id: str = Form(..., description="Language code (e.g., en, es, zh)"),
    exaggeration: float = Form(0.5, description="Emotional intensity (0.25-2.0)", ge=0.25, le=2.0),
    cfg_weight: float = Form(0.5, description="CFG/Pace control (0.0-1.0)", ge=0.0, le=1.0),
    voice_file: UploadFile = File(..., description="Reference voice audio file")
):
    """
    Generate speech with reference voice audio.
    Reference audio is required for all speech generation.
    Only exposes the 2 primary controls: exaggeration and cfg_weight.
    """
    global tts_model_en, tts_model_multi


    # Validate audio file
    if not voice_file.content_type.startswith('audio/'):
        raise HTTPException(status_code=400, detail="Voice file must be an audio file")

    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_file:
            content = await voice_file.read()
            temp_file.write(content)
            temp_voice_path = temp_file.name

        # Choose model: legacy English-only or multilingual
        use_english = (language_id or "").lower().startswith("en")
        if use_english:
            if tts_model_en is None:
                print("Loading legacy English ChatterboxTTS model...")
                tts_model_en = ChatterboxTTS.from_pretrained(DEVICE)
            model = tts_model_en
            wav = model.generate(
                text=text,
                audio_prompt_path=temp_voice_path,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
                temperature=0.8,
            )
        else:
            if tts_model_multi is None:
                print("Loading Multilingual TTS model (on-demand)...")
                tts_model_multi = ChatterboxMultilingualTTS.from_pretrained(DEVICE)
            model = tts_model_multi
            wav = model.generate(
                text=text,
                language_id=language_id,
                audio_prompt_path=temp_voice_path,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
                temperature=0.8,
            )

        # Convert to bytes
        buffer = io.BytesIO()
        ta.save(buffer, wav, model.sr, format="wav")
        buffer.seek(0)

        return Response(
            content=buffer.getvalue(),
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=generated_speech.wav",
                "X-Sample-Rate": str(model.sr)
            }
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")
    finally:
        # Clean up temp file
        try:
            import os
            os.unlink(temp_voice_path)
        except:
            pass


@app.post("/vc/convert")
async def convert_voice(
    input_audio: UploadFile = File(..., description="Input audio to convert"),
    target_voice: UploadFile = File(..., description="Target voice reference")
):
    """
    Convert voice using Chatterbox VC.
    No additional controls exposed - uses optimal defaults.
    """
    if vc_model is None:
        raise HTTPException(status_code=503, detail="VC model not loaded")

    # Validate audio files
    if not input_audio.content_type.startswith('audio/'):
        raise HTTPException(status_code=400, detail="Input audio must be an audio file")
    if not target_voice.content_type.startswith('audio/'):
        raise HTTPException(status_code=400, detail="Target voice must be an audio file")

    try:
        # Save uploaded files temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_input:
            content = await input_audio.read()
            temp_input.write(content)
            temp_input_path = temp_input.name

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_target:
            content = await target_voice.read()
            temp_target.write(content)
            temp_target_path = temp_target.name

        # Convert voice
        wav = vc_model.generate(
            audio=temp_input_path,
            target_voice_path=temp_target_path
        )

        # Convert to bytes
        buffer = io.BytesIO()
        ta.save(buffer, wav, vc_model.sr, format="wav")
        buffer.seek(0)

        return Response(
            content=buffer.getvalue(),
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=converted_voice.wav",
                "X-Sample-Rate": str(vc_model.sr)
            }
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Voice conversion failed: {str(e)}")
    finally:
        # Clean up temp files
        try:
            import os
            os.unlink(temp_input_path)
            os.unlink(temp_target_path)
        except:
            pass


if __name__ == "__main__":
    uvicorn.run(
        "api:app",
        host="0.0.0.0",
        port=3011,
        reload=True,
        log_level="info"
    )
