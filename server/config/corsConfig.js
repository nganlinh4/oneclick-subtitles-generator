/**
 * Unified CORS Configuration for All Services
 * This ensures consistent CORS settings across all microservices
 * All ports are sourced from the centralized config only
 */

const { PORTS } = require('../config');

/**
 * Generate allowed origins for CORS based on unified port configuration
 * Includes both localhost and 127.0.0.1 for maximum compatibility
 */
function getAllowedOrigins() {
  const origins = [];
  
  // Add all service ports with both localhost and 127.0.0.1
  Object.values(PORTS).forEach(port => {
    origins.push(`http://localhost:${port}`);
    origins.push(`http://127.0.0.1:${port}`);
  });
  
  return origins;
}

/**
 * Standard CORS configuration for Express.js services
 */
const EXPRESS_CORS_CONFIG = {
  origin: getAllowedOrigins(),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma', 'Expires', 'X-Run-Id'],
  credentials: true
};

/**
 * Standard CORS configuration for FastAPI services (Python)
 */
const FASTAPI_CORS_CONFIG = {
  allow_origins: getAllowedOrigins(),
  allow_credentials: true,
  allow_methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allow_headers: ['*']
};

/**
 * Standard CORS configuration for Flask services (Python)
 */
const FLASK_CORS_CONFIG = {
  origins: getAllowedOrigins(),
  supports_credentials: true,
  allow_headers: ['Content-Type', 'Authorization', 'Accept']
};

/**
 * CORS headers for manual implementation
 */
function getCorsHeaders(requestOrigin) {
  const allowedOrigins = getAllowedOrigins();
  
  // Check if the request origin is in our allowed list
  if (allowedOrigins.includes(requestOrigin)) {
    return {
      'Access-Control-Allow-Origin': requestOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Pragma, Expires, X-Run-Id',
      'Access-Control-Allow-Credentials': 'true'
    };
  }
  
  // Default to frontend origin if request origin is not in allowed list
  return {
    'Access-Control-Allow-Origin': `http://localhost:${PORTS.FRONTEND}`,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cache-Control, Pragma, Expires, X-Run-Id',
    'Access-Control-Allow-Credentials': 'true'
  };
}

module.exports = {
  getAllowedOrigins,
  EXPRESS_CORS_CONFIG,
  FASTAPI_CORS_CONFIG,
  FLASK_CORS_CONFIG,
  getCorsHeaders
};
