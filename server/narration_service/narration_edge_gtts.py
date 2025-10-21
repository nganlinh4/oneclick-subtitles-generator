import os
import uuid
import logging
import json
import asyncio
import tempfile
from flask import Blueprint, request, jsonify, Response
from .narration_config import OUTPUT_AUDIO_DIR
from .directory_utils import ensure_subtitle_directory, get_next_file_number

logger = logging.getLogger(__name__)

# Create blueprint for edge-tts and gtts routes
edge_gtts_bp = Blueprint('narration_edge_gtts', __name__)

# Check if edge-tts and gtts are available
try:
    import edge_tts
    HAS_EDGE_TTS = True
    logger.info("edge-tts library is available")
except ImportError:
    HAS_EDGE_TTS = False
    logger.warning("edge-tts library is not available")

try:
    from gtts import gTTS
    HAS_GTTS = True
    logger.info("gtts library is available")
except ImportError:
    HAS_GTTS = False
    logger.warning("gtts library is not available")

@edge_gtts_bp.route('/edge-tts/generate', methods=['POST'])
def generate_edge_tts():
    """Generate narration using Microsoft Edge TTS"""
    if not HAS_EDGE_TTS:
        return jsonify({'error': 'edge-tts library is not available'}), 503
    
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No JSON data received'}), 400
        
        subtitles = data.get('subtitles', [])
        settings = data.get('settings', {})
        
        # Edge TTS settings
        voice = settings.get('voice', 'en-US-AriaNeural')
        rate = settings.get('rate', '+0%')
        volume = settings.get('volume', '+0%')
        pitch = settings.get('pitch', '+0Hz')
        
        logger.info(f"Generating Edge TTS with voice: {voice}, rate: {rate}, volume: {volume}, pitch: {pitch}")
        
        def generate():
            try:
                yield f"data: {json.dumps({'status': 'started', 'total': len(subtitles)})}\n\n"
            except Exception as e:
                logger.info("Client disconnected during Edge TTS generation start")
                return

            results = []
            for i, subtitle in enumerate(subtitles):
                try:
                    # Generate audio using edge-tts
                    audio_data = asyncio.run(generate_edge_tts_audio(
                        subtitle['text'], voice, rate, volume, pitch
                    ))

                    # Save audio file
                    subtitle_id = subtitle.get('id', i)
                    filename = save_audio_file(audio_data, subtitle_id, 'edge-tts')

                    result = {
                        'subtitle_id': subtitle_id,
                        'text': subtitle['text'],
                        'start_time': subtitle.get('start', 0),
                        'end_time': subtitle.get('end', 0),
                        'filename': filename,
                        'success': True,
                        'method': 'edge-tts'
                    }
                    results.append(result)

                    # Send progress update
                    progress_data = {
                        'status': 'progress',
                        'current': i + 1,
                        'total': len(subtitles),
                        'result': result
                    }
                    try:
                        yield f"data: {json.dumps(progress_data)}\n\n"
                    except Exception as e:
                        logger.info(f"Client disconnected during Edge TTS generation at subtitle {i+1}")
                        return

                except Exception as e:
                    logger.error(f"Error generating Edge TTS for subtitle {i}: {str(e)}")
                    error_result = {
                        'subtitle_id': subtitle.get('id', i),
                        'text': subtitle['text'],
                        'success': False,
                        'error': str(e),
                        'method': 'edge-tts'
                    }
                    results.append(error_result)

                    error_data = {
                        'status': 'error',
                        'current': i + 1,
                        'total': len(subtitles),
                        'result': error_result
                    }
                    try:
                        yield f"data: {json.dumps(error_data)}\n\n"
                    except Exception as e:
                        logger.info(f"Client disconnected during Edge TTS error reporting at subtitle {i+1}")
                        return

            # Send completion
            completion_data = {
                'status': 'completed',
                'results': results
            }
            try:
                yield f"data: {json.dumps(completion_data)}\n\n"
            except Exception as e:
                logger.info("Client disconnected during Edge TTS completion")
                return
        
        return Response(generate(), mimetype='text/event-stream')
        
    except Exception as e:
        logger.error(f"Error in Edge TTS generation: {str(e)}")
        return jsonify({'error': str(e)}), 500

@edge_gtts_bp.route('/gtts/generate', methods=['POST'])
def generate_gtts():
    """Generate narration using Google Text-to-Speech"""
    if not HAS_GTTS:
        return jsonify({'error': 'gtts library is not available'}), 503
    
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No JSON data received'}), 400
        
        subtitles = data.get('subtitles', [])
        settings = data.get('settings', {})
        
        # gTTS settings
        lang = settings.get('lang', 'en')
        tld = settings.get('tld', 'com')
        slow = settings.get('slow', False)
        
        logger.info(f"Generating gTTS with lang: {lang}, tld: {tld}, slow: {slow}")
        
        def generate():
            try:
                yield f"data: {json.dumps({'status': 'started', 'total': len(subtitles)})}\n\n"
            except Exception as e:
                logger.info("Client disconnected during gTTS generation start")
                return

            results = []
            for i, subtitle in enumerate(subtitles):
                try:
                    # Generate audio using gTTS
                    audio_data = generate_gtts_audio(subtitle['text'], lang, tld, slow)

                    # Save audio file
                    subtitle_id = subtitle.get('id', i)
                    filename = save_audio_file(audio_data, subtitle_id, 'gtts')

                    result = {
                        'subtitle_id': subtitle_id,
                        'text': subtitle['text'],
                        'start_time': subtitle.get('start', 0),
                        'end_time': subtitle.get('end', 0),
                        'filename': filename,
                        'success': True,
                        'method': 'gtts'
                    }
                    results.append(result)

                    # Send progress update
                    progress_data = {
                        'status': 'progress',
                        'current': i + 1,
                        'total': len(subtitles),
                        'result': result
                    }
                    try:
                        yield f"data: {json.dumps(progress_data)}\n\n"
                    except Exception as e:
                        logger.info(f"Client disconnected during gTTS generation at subtitle {i+1}")
                        return

                except Exception as e:
                    logger.error(f"Error generating gTTS for subtitle {i}: {str(e)}")
                    error_result = {
                        'subtitle_id': subtitle.get('id', i),
                        'text': subtitle['text'],
                        'success': False,
                        'error': str(e),
                        'method': 'gtts'
                    }
                    results.append(error_result)

                    error_data = {
                        'status': 'error',
                        'current': i + 1,
                        'total': len(subtitles),
                        'result': error_result
                    }
                    try:
                        yield f"data: {json.dumps(error_data)}\n\n"
                    except Exception as e:
                        logger.info(f"Client disconnected during gTTS error reporting at subtitle {i+1}")
                        return

            # Send completion
            completion_data = {
                'status': 'completed',
                'results': results
            }
            try:
                yield f"data: {json.dumps(completion_data)}\n\n"
            except Exception as e:
                logger.info("Client disconnected during gTTS completion")
                return
        
        return Response(generate(), mimetype='text/event-stream')
        
    except Exception as e:
        logger.error(f"Error in gTTS generation: {str(e)}")
        return jsonify({'error': str(e)}), 500

async def generate_edge_tts_audio(text, voice, rate, volume, pitch):
    """Generate audio using Edge TTS"""
    # Create SSML with voice settings
    ssml = f"""
    <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
        <voice name="{voice}">
            <prosody rate="{rate}" volume="{volume}" pitch="{pitch}">
                {text}
            </prosody>
        </voice>
    </speak>
    """
    
    communicate = edge_tts.Communicate(ssml, voice)
    audio_data = b""
    
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data += chunk["data"]
    
    return audio_data

def generate_gtts_audio(text, lang, tld, slow):
    """Generate audio using gTTS"""
    tts = gTTS(text=text, lang=lang, tld=tld, slow=slow)

    # Save to temporary file and read the data
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.mp3')
    try:
        tts.save(temp_file.name)
        temp_file.close()  # Close the file handle before reading

        with open(temp_file.name, 'rb') as f:
            audio_data = f.read()

        return audio_data
    finally:
        # Clean up temporary file
        try:
            os.unlink(temp_file.name)
        except OSError:
            pass  # Ignore if file is already deleted

def save_audio_file(audio_data, subtitle_id, method):
    """Save audio data to file and return filename"""
    try:
        # Ensure output directory exists (create if needed)
        os.makedirs(OUTPUT_AUDIO_DIR, exist_ok=True)

        # Generate unique filename with timestamp to avoid conflicts
        import time
        timestamp = int(time.time() * 1000)  # milliseconds
        filename = f"{method}_{timestamp}_{subtitle_id}.mp3"
        filepath = os.path.join(OUTPUT_AUDIO_DIR, filename)

        # Write audio data
        with open(filepath, 'wb') as f:
            f.write(audio_data)

        logger.info(f"Saved {method} audio: {filename}")
        return filename

    except Exception as e:
        logger.error(f"Error saving {method} audio file: {str(e)}")
        raise

@edge_gtts_bp.route('/edge-tts/voices', methods=['GET'])
def get_edge_tts_voices():
    """Get available Edge TTS voices"""
    if not HAS_EDGE_TTS:
        return jsonify({'error': 'edge-tts library is not available'}), 503
    
    try:
        voices = asyncio.run(edge_tts.list_voices())
        # Format voices for frontend
        formatted_voices = []
        for voice in voices:
            formatted_voices.append({
                'name': voice['Name'],
                'short_name': voice['ShortName'],
                'gender': voice['Gender'],
                'locale': voice['Locale'],
                'language': voice['Locale'].split('-')[0],
                'display_name': f"{voice['FriendlyName']} ({voice['Locale']})"
            })
        
        return jsonify({'voices': formatted_voices})
        
    except Exception as e:
        logger.error(f"Error getting Edge TTS voices: {str(e)}")
        return jsonify({'error': str(e)}), 500

@edge_gtts_bp.route('/gtts/languages', methods=['GET'])
def get_gtts_languages():
    """Get available gTTS languages"""
    if not HAS_GTTS:
        return jsonify({'error': 'gtts library is not available'}), 503
    
    try:
        from gtts.lang import tts_langs
        languages = tts_langs()
        
        # Format languages for frontend
        formatted_languages = []
        for code, name in languages.items():
            formatted_languages.append({
                'code': code,
                'name': name,
                'display_name': f"{name} ({code})"
            })
        
        return jsonify({'languages': formatted_languages})
        
    except Exception as e:
        logger.error(f"Error getting gTTS languages: {str(e)}")
        return jsonify({'error': str(e)}), 500
