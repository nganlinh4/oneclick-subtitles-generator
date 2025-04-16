"""
Test script for the narration service
"""

import os
import uuid
import logging
import struct
import array
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)
CORS(app)

# Create directories
NARRATION_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'narration')
REFERENCE_AUDIO_DIR = os.path.join(NARRATION_DIR, 'reference')
OUTPUT_AUDIO_DIR = os.path.join(NARRATION_DIR, 'output')

os.makedirs(NARRATION_DIR, exist_ok=True)
os.makedirs(REFERENCE_AUDIO_DIR, exist_ok=True)
os.makedirs(OUTPUT_AUDIO_DIR, exist_ok=True)

# Function to generate a simple WAV file
def generate_wav_file(filepath, duration_ms=1000):
    """Generate a simple sine wave WAV file"""
    # WAV parameters
    sample_rate = 44100  # Hz
    num_channels = 1     # Mono
    sample_width = 2     # 16-bit

    # Calculate number of samples
    num_samples = int(sample_rate * duration_ms / 1000)

    # Generate simple audio data
    samples = array.array('h')
    amplitude = 32767 // 2  # Half of max amplitude for 16-bit

    for _ in range(num_samples):
        sample = int(amplitude * 0.5)  # Constant value for simplicity
        samples.append(sample)

    # Write WAV file
    with open(filepath, 'wb') as f:
        # Write WAV header
        f.write(b'RIFF')                                # ChunkID
        f.write(struct.pack('<I', 36 + len(samples) * sample_width))  # ChunkSize
        f.write(b'WAVE')                                # Format
        f.write(b'fmt ')                                # Subchunk1ID
        f.write(struct.pack('<I', 16))                  # Subchunk1Size
        f.write(struct.pack('<H', 1))                   # AudioFormat (PCM)
        f.write(struct.pack('<H', num_channels))        # NumChannels
        f.write(struct.pack('<I', sample_rate))         # SampleRate
        f.write(struct.pack('<I', sample_rate * num_channels * sample_width))  # ByteRate
        f.write(struct.pack('<H', num_channels * sample_width))  # BlockAlign
        f.write(struct.pack('<H', 8 * sample_width))    # BitsPerSample
        f.write(b'data')                                # Subchunk2ID
        f.write(struct.pack('<I', len(samples) * sample_width))  # Subchunk2Size

        # Write audio data
        samples.tofile(f)

    logger.info(f'Generated WAV file: {filepath}')

# Default route
@app.route('/')
def index():
    return jsonify({
        'status': 'ok',
        'message': 'Test Narration Service is running'
    })

# Status route
@app.route('/api/narration/status')
def status():
    return jsonify({
        'available': True,
        'device': 'cpu',
        'error': None
    })

# Upload reference audio
@app.route('/api/narration/upload-reference', methods=['POST'])
def upload_reference():
    logger.info('Received upload-reference request')

    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    # Generate a unique filename
    unique_id = str(uuid.uuid4())
    filename = f"uploaded_{unique_id}.wav"
    filepath = os.path.join(REFERENCE_AUDIO_DIR, filename)

    # Save the file
    file.save(filepath)

    # Get reference text if provided
    reference_text = request.form.get('reference_text', 'This is a test reference text')

    return jsonify({
        'success': True,
        'filepath': filepath,
        'filename': filename,
        'reference_text': reference_text
    })

# Record reference audio
@app.route('/api/narration/record-reference', methods=['POST'])
def record_reference():
    logger.info('Received record-reference request')

    if 'audio_data' not in request.files:
        return jsonify({'error': 'No audio data'}), 400

    audio_file = request.files['audio_data']

    # Generate a unique filename
    unique_id = str(uuid.uuid4())
    filename = f"recorded_{unique_id}.wav"
    filepath = os.path.join(REFERENCE_AUDIO_DIR, filename)

    # Save the file
    audio_file.save(filepath)

    # Get reference text if provided
    reference_text = request.form.get('reference_text', 'This is a test reference text')

    return jsonify({
        'success': True,
        'filepath': filepath,
        'filename': filename,
        'reference_text': reference_text
    })

# Extract audio segment
@app.route('/api/narration/extract-segment', methods=['POST'])
def extract_segment():
    logger.info('Received extract-segment request')
    data = request.json
    logger.info(f'Request data: {data}')

    # Generate a unique filename
    unique_id = str(uuid.uuid4())
    filename = f"segment_{unique_id}.wav"
    filepath = os.path.join(REFERENCE_AUDIO_DIR, filename)

    # Generate a WAV file
    generate_wav_file(filepath, duration_ms=2000)

    return jsonify({
        'success': True,
        'filepath': filepath,
        'filename': filename,
        'reference_text': 'This is a test segment text'
    })

# Generate narration
@app.route('/api/narration/generate', methods=['POST'])
def generate_narration():
    logger.info('Received generate request')
    data = request.json
    logger.info(f'Request data: {data}')

    subtitles = data.get('subtitles', [])
    reference_audio = data.get('reference_audio')
    reference_text = data.get('reference_text', '')

    logger.info(f'Generating narration for {len(subtitles)} subtitles')
    logger.info(f'Reference audio: {reference_audio}')
    logger.info(f'Reference text: {reference_text}')

    results = []

    for subtitle in subtitles:
        subtitle_id = subtitle.get('id')
        text = subtitle.get('text', '')

        if not text:
            continue

        # Generate a unique filename
        unique_id = str(uuid.uuid4())
        filename = f"narration_{subtitle_id}_{unique_id}.wav"
        filepath = os.path.join(OUTPUT_AUDIO_DIR, filename)

        # Generate a WAV file
        generate_wav_file(filepath, duration_ms=3000)

        results.append({
            'subtitle_id': subtitle_id,
            'text': text,
            'audio_path': filepath,
            'filename': filename,
            'success': True
        })

    return jsonify({
        'success': True,
        'results': results
    })

# Serve audio files
@app.route('/api/narration/audio/<path:filename>', methods=['GET'])
def get_audio_file(filename):
    logger.info(f'Received request for audio file: {filename}')

    # Check if the file is in the reference directory
    reference_path = os.path.join(REFERENCE_AUDIO_DIR, filename)
    if os.path.exists(reference_path):
        return send_file(reference_path, mimetype='audio/wav')

    # Check if the file is in the output directory
    output_path = os.path.join(OUTPUT_AUDIO_DIR, filename)
    if os.path.exists(output_path):
        return send_file(output_path, mimetype='audio/wav')

    # If file doesn't exist, create a dummy WAV file
    dummy_path = os.path.join(OUTPUT_AUDIO_DIR, 'dummy.wav')
    generate_wav_file(dummy_path, duration_ms=1000)

    return send_file(dummy_path, mimetype='audio/wav')

if __name__ == '__main__':
    port = int(os.environ.get('NARRATION_PORT', 3006))
    logger.info(f"Starting test narration service on port {port}")
    app.run(host='0.0.0.0', port=port, debug=True)
