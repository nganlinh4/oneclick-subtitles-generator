import os
import sys
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

# Add the current directory to the path so we can import narration_service and config
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from narration_service import narration_bp
from config.cors_config import get_flask_cors_config, get_cors_headers, get_ports

# Set up logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# Suppress Werkzeug request logging
logging.getLogger('werkzeug').setLevel(logging.WARNING)

# Create Flask app
app = Flask(__name__)
# Configure CORS using centralized configuration
flask_cors_config = get_flask_cors_config()
CORS(app, resources={r"/*": flask_cors_config}, allow_headers=flask_cors_config['allow_headers'])

# Add CORS headers to all responses using centralized configuration
@app.after_request
def add_cors_headers(response):
    # Get CORS headers from centralized config
    request_origin = request.headers.get('Origin')
    cors_headers = get_cors_headers(request_origin)

    for header, value in cors_headers.items():
        response.headers.add(header, value)

    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    response.headers.add('Access-Control-Allow-Credentials', 'true')

    # Preserve any existing exposed headers and add our custom headers
    existing_exposed = response.headers.get('Access-Control-Expose-Headers', '')
    custom_headers = 'Content-Disposition,X-Duration-Difference,X-Expected-Duration,X-Actual-Duration'

    if existing_exposed:
        # Combine existing and custom headers, avoiding duplicates
        all_headers = set(existing_exposed.split(',') + custom_headers.split(','))
        response.headers['Access-Control-Expose-Headers'] = ','.join(all_headers)
    else:
        response.headers['Access-Control-Expose-Headers'] = custom_headers

    return response

# Register blueprints
app.register_blueprint(narration_bp, url_prefix='/api/narration')

# Default route
@app.route('/')
def index():
    # Get GPU info if available
    gpu_info = {}
    try:
        import torch
        if torch.cuda.is_available():
            gpu_info = {
                'cuda_available': True,
                'device_name': torch.cuda.get_device_name(0),
                'device_count': torch.cuda.device_count(),
                'current_device': torch.cuda.current_device(),
                'memory_allocated': f"{torch.cuda.memory_allocated(0) / 1024**2:.2f} MB",
                'memory_reserved': f"{torch.cuda.memory_reserved(0) / 1024**2:.2f} MB"
            }
        else:
            gpu_info = {'cuda_available': False}
    except ImportError:
        gpu_info = {'cuda_available': False, 'error': 'torch not installed'}
    except Exception as e:
        gpu_info = {'cuda_available': False, 'error': str(e)}

    return jsonify({
        'status': 'ok',
        'message': 'F5-TTS Narration Service is running',
        'gpu_info': gpu_info
    })

if __name__ == '__main__':
    # Use centralized port configuration
    ports = get_ports()
    port = int(os.environ.get('NARRATION_PORT', ports['NARRATION']))

    try:
        logger.info(f"Starting F5-TTS Narration Service on port {port}")

        # Start the server on the specified port
        app.run(host='0.0.0.0', port=port, debug=False)

    except OSError as e:
        logger.error(f"Failed to start server on port {port}: {e}")
        logger.error("Make sure the port is not already in use")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Unexpected error in narration service: {e}", exc_info=True)
        sys.exit(1)
