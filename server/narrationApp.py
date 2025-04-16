import os
import sys
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

# Add the current directory to the path so we can import narrationService
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from narrationService import narration_bp

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)
CORS(app)

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
    # Try a range of ports starting from the specified port
    base_port = int(os.environ.get('NARRATION_PORT', 3006))

    # Try ports in this range
    port_range = [base_port, base_port + 1, base_port + 2, base_port + 3, base_port + 4]

    # Also try these specific ports which are less likely to be in use
    alternative_ports = [8080, 8081, 8082, 9090, 9091, 9092]

    # Combine all ports to try
    ports_to_try = port_range + alternative_ports

    # Try each port
    for port in ports_to_try:
        try:
            logger.info(f"Attempting to start server on port {port}")
            # Write the port to a file so the main server can find it
            port_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'narration_port.txt')
            with open(port_file, 'w') as f:
                f.write(str(port))

            # Try to run on this port with localhost only (more reliable on Windows)
            app.run(host='127.0.0.1', port=port, debug=True)
            break  # If we get here, the server started successfully
        except OSError as e:
            logger.error(f"Error starting server on port {port}: {e}")
    else:
        # If we get here, all ports failed
        logger.error("Failed to start server on any port")
        sys.exit(1)
