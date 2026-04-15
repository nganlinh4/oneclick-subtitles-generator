import os
import logging
from flask import Blueprint, send_file, jsonify
from .narration_config import REFERENCE_AUDIO_DIR, OUTPUT_AUDIO_DIR
from .narration_models import models_bp
from .narration_audio import audio_bp
from .narration_generation import generation_bp
from .narration_edge_gtts import edge_gtts_bp
from .narration_camb import camb_bp

logger = logging.getLogger(__name__)

# Create main narration blueprint
narration_bp = Blueprint('narration', __name__)

# Register sub-blueprints
narration_bp.register_blueprint(models_bp, url_prefix='')
narration_bp.register_blueprint(audio_bp, url_prefix='')
narration_bp.register_blueprint(generation_bp, url_prefix='')
narration_bp.register_blueprint(edge_gtts_bp, url_prefix='')
narration_bp.register_blueprint(camb_bp, url_prefix='')

# Add routes for serving audio files
@narration_bp.route('/audio/<path:filename>', methods=['GET'])
def get_audio_file(filename):
    """Serve audio files from reference or output directories"""
    # Prevent directory traversal attacks
    if '..' in filename or filename.startswith('/'):
        return jsonify({'error': 'Invalid filename'}), 400

    logger.debug(f"Serving audio file: {filename}")

    # Check if this is our new directory structure (subtitle_ID/number.wav)
    parts = filename.split('/')
    if len(parts) == 2 and parts[0].startswith('subtitle_'):
        subtitle_dir = parts[0]
        audio_file = parts[1]

        # Build the path to the audio file
        output_path = os.path.join(OUTPUT_AUDIO_DIR, subtitle_dir, audio_file)
        safe_output_path = os.path.abspath(output_path)

        logger.debug(f"Checking new structure path: {safe_output_path}")

        if safe_output_path.startswith(os.path.abspath(OUTPUT_AUDIO_DIR)) and os.path.exists(safe_output_path):
            logger.debug(f"Found file at new structure path: {safe_output_path}")
            return send_file(safe_output_path, mimetype='audio/wav')
        else:
            logger.debug(f"File not found at new structure path: {safe_output_path}")

    # Check reference directory first
    reference_path = os.path.join(REFERENCE_AUDIO_DIR, filename)
    # Use safe join and check existence within the intended directory
    safe_ref_path = os.path.abspath(reference_path)
    if safe_ref_path.startswith(os.path.abspath(REFERENCE_AUDIO_DIR)) and os.path.exists(safe_ref_path):
        logger.debug(f"Serving reference audio: {safe_ref_path}")
        return send_file(safe_ref_path, mimetype='audio/wav') # Assume WAV, adjust if needed

    # Check output directory - handle legacy structure
    output_path = os.path.join(OUTPUT_AUDIO_DIR, filename)
    safe_output_path = os.path.abspath(output_path)
    if safe_output_path.startswith(os.path.abspath(OUTPUT_AUDIO_DIR)) and os.path.exists(safe_output_path):
        logger.debug(f"Serving output audio: {safe_output_path}")
        return send_file(safe_output_path, mimetype='audio/wav') # Assume WAV

    # If file not found, log directory contents for debugging
    logger.warning(f"Audio file not found in reference or output dirs: {filename}")
    try:
        logger.debug(f"Contents of OUTPUT_AUDIO_DIR: {os.listdir(OUTPUT_AUDIO_DIR)}")

        # Check if there are any subtitle directories
        subtitle_dirs = [d for d in os.listdir(OUTPUT_AUDIO_DIR)
                        if d.startswith('subtitle_') and
                        os.path.isdir(os.path.join(OUTPUT_AUDIO_DIR, d))]

        if subtitle_dirs:
            logger.debug(f"Found subtitle directories: {', '.join(subtitle_dirs)}")

            # Check the contents of the first few subtitle directories
            for i, dir_name in enumerate(subtitle_dirs[:3]):
                dir_path = os.path.join(OUTPUT_AUDIO_DIR, dir_name)
                logger.debug(f"Contents of {dir_path}: {os.listdir(dir_path)}")
    except Exception as e:
        logger.error(f"Error listing directory contents: {str(e)}")

    return jsonify({'error': 'File not found'}), 404
