"""
Registry management for F5-TTS models.
"""
import os
import json
from .constants import MODELS_REGISTRY_FILE, logger

try:
    from huggingFaceCache import list_huggingface_cache_models
except ImportError:
    # Provide dummy function if the import fails, to avoid crashing
    logger.warning("huggingFaceCache module not found. Cache operations might be limited.")
    def list_huggingface_cache_models(): return []


def initialize_registry():
    """Initialize the models registry if it doesn't exist."""
    max_retries = 3
    retry_delay = 1  # seconds
    default_registry = {
        "active_model": None,
        "models": [],
        "downloads": {}
    }

    # Create registry file if it doesn't exist
    if not os.path.exists(MODELS_REGISTRY_FILE):
        for attempt in range(max_retries):
            try:
                with open(MODELS_REGISTRY_FILE, 'w') as f:
                    json.dump(default_registry, f, indent=2)
                break
            except PermissionError as e:
                logger.warning(f"Permission error creating registry (attempt {attempt+1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    import time
                    time.sleep(retry_delay)
                else:
                    logger.error(f"Failed to create registry file after {max_retries} attempts")
                    return
            except Exception as e:
                logger.error(f"Error creating registry file: {e}")
                return

    # Ensure the registry is valid
    registry = None
    for attempt in range(max_retries):
        try:
            with open(MODELS_REGISTRY_FILE, 'r') as f:
                registry = json.load(f)
            break
        except PermissionError as e:
            logger.warning(f"Permission error reading registry (attempt {attempt+1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                import time
                time.sleep(retry_delay)
            else:
                logger.error(f"Failed to read registry file after {max_retries} attempts")
                return
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.error(f"Error parsing registry file: {e}. Will reset registry.")
            registry = default_registry
            break
        except Exception as e:
            logger.error(f"Unexpected error reading registry: {e}")
            return

    if registry is None:
        logger.error("Failed to read registry after retries")
        return

    try:
        # Check if registry has required fields
        if "active_model" not in registry or "models" not in registry:
            logger.warning("Registry missing 'active_model' or 'models' field. Resetting.")
            registry = default_registry.copy()

        # Add downloads field if it doesn't exist
        if "downloads" not in registry:
            registry["downloads"] = {}
            save_registry(registry)

        # Check if F5-TTS v1 Base model is in the registry
        f5tts_base_exists = False
        for model in registry.get("models", []): # Use .get for safety
            if model.get("id") == "f5tts-v1-base":
                f5tts_base_exists = True
                # Ensure default model has correct structure (add missing fields if needed)
                if "languages" not in model: model["languages"] = ["en", "zh"]
                if "language" not in model: model["language"] = "en"
                if "is_symlink" not in model: model["is_symlink"] = False
                if "original_model_file" not in model: model["original_model_file"] = None
                if "original_vocab_file" not in model: model["original_vocab_file"] = None
                if "source" not in model: model["source"] = "default"
                break

        # Add F5-TTS v1 Base model if it's not in the registry
        if not f5tts_base_exists:
            registry.setdefault("models", []).append({ # Use setdefault for safety
                "id": "f5tts-v1-base",
                "name": "F5-TTS v1 Base",
                "repo_id": "SWivid/F5-TTS",
                "model_path": "default",
                "vocab_path": "default",
                "config": {
                    "dim": 1024,
                    "depth": 22,
                    "heads": 16,
                    "ff_mult": 2,
                    "text_dim": 512,
                    "conv_layers": 4
                },
                "source": "default",
                "language": "en",
                "languages": ["en", "zh"],
                "is_symlink": False,
                "original_model_file": None,
                "original_vocab_file": None
            })

            # If no active model is set, set this as active
            if registry.get("active_model") is None: # Use .get for safety
                registry["active_model"] = "f5tts-v1-base"

            # Save the updated registry using our improved save_registry function
            save_registry(registry)

    except (ValueError, TypeError, KeyError) as e:
        logger.error(f"Error validating registry: {e}. Resetting registry.")
        # Reset registry if invalid
        save_registry(default_registry)


def get_registry():
    """Get the current models registry."""
    initialize_registry() # Ensure it's initialized and valid before reading

    max_retries = 3
    retry_delay = 1  # seconds

    for attempt in range(max_retries):
        try:
            with open(MODELS_REGISTRY_FILE, 'r') as f:
                return json.load(f)
        except PermissionError as e:
            logger.warning(f"Permission error reading registry (attempt {attempt+1}/{max_retries}): {e}")
            # Wait before retrying
            import time
            time.sleep(retry_delay)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            logger.error(f"Error reading registry file: {e}. Returning default empty registry.")
            # Return a default structure in case of error
            return {"active_model": None, "models": [], "downloads": {}}
        except Exception as e:
            logger.error(f"Unexpected error reading registry: {e}")
            return {"active_model": None, "models": [], "downloads": {}}

    # If we've exhausted all retries
    logger.error(f"Failed to read registry after {max_retries} attempts. Returning default empty registry.")
    return {"active_model": None, "models": [], "downloads": {}}


def save_registry(registry):
    """Save the models registry."""
    temp_file_path = MODELS_REGISTRY_FILE + ".tmp"
    max_retries = 3
    retry_delay = 1  # seconds

    for attempt in range(max_retries):
        try:
            # Direct write approach - try this first if we've had issues with atomic replace
            if attempt > 0:
                logger.info(f"Retry {attempt}: Attempting direct write to registry file")
                with open(MODELS_REGISTRY_FILE, 'w') as f:
                    json.dump(registry, f, indent=2)
                logger.debug(f"Registry saved successfully via direct write to {MODELS_REGISTRY_FILE}")
                return True

            # Atomic approach with temporary file (first attempt)
            # Write to the temporary file
            with open(temp_file_path, 'w') as f:
                json.dump(registry, f, indent=2)

            # Ensure file is fully written and closed before proceeding
            import time
            time.sleep(0.1)

            # Atomically replace the original file with the temporary file
            # On Windows, os.replace might fail if the target exists, so remove first.
            if os.path.exists(MODELS_REGISTRY_FILE):
                try:
                    os.remove(MODELS_REGISTRY_FILE)
                except PermissionError:
                    logger.warning(f"Permission denied when removing original registry file. Trying direct write.")
                    # If we can't remove the original, try direct write
                    with open(MODELS_REGISTRY_FILE, 'w') as f:
                        json.dump(registry, f, indent=2)
                    # Clean up temp file
                    if os.path.exists(temp_file_path):
                        try:
                            os.remove(temp_file_path)
                        except:
                            pass
                    return True

            os.replace(temp_file_path, MODELS_REGISTRY_FILE)  # Atomic on POSIX, near-atomic on Windows

            logger.debug(f"Registry saved successfully to {MODELS_REGISTRY_FILE}")
            return True

        except PermissionError as e:
            logger.warning(f"Permission error saving registry (attempt {attempt+1}/{max_retries}): {e}")
            # Wait before retrying
            import time
            time.sleep(retry_delay)

        except Exception as e:
            logger.error(f"Error saving registry: {e}")
            break

        finally:
            # Clean up temp file if it exists
            if os.path.exists(temp_file_path):
                try:
                    os.remove(temp_file_path)
                except OSError as rm_err:
                    logger.warning(f"Error removing temporary registry file {temp_file_path}: {rm_err}")

    logger.error(f"Failed to save registry after {max_retries} attempts")
    return False


def scan_models_directory():
    """Scan the models/f5_tts directory for existing models and add them to registry."""
    from .constants import MODELS_DIR

    if not os.path.exists(MODELS_DIR):
        logger.error(f"Models directory does not exist: {MODELS_DIR}")
        return False, f"Models directory not found: {MODELS_DIR}"

    registry = get_registry()
    existing_model_ids = {model.get("id") for model in registry.get("models", [])}
    new_models_found = 0

    logger.info(f"Existing models in registry: {existing_model_ids}")

    try:
        # List all items in the models directory
        items = os.listdir(MODELS_DIR)
        logger.info(f"Found items in models directory: {items}")

        # Scan each subdirectory in models/f5_tts
        for item in items:
            item_path = os.path.join(MODELS_DIR, item)
            logger.info(f"Checking item: {item} at path: {item_path}")

            # Skip files, only process directories
            if not os.path.isdir(item_path):
                logger.info(f"Skipping {item} - not a directory")
                continue

            # Skip if already in registry
            if item in existing_model_ids:
                logger.info(f"Skipping {item} - already in registry")
                continue

            # Look for model files in the directory
            model_file = None
            vocab_file = None

            try:
                files = os.listdir(item_path)
                logger.info(f"Files in {item}: {files}")

                for file in files:
                    file_path = os.path.join(item_path, file)
                    if os.path.isfile(file_path):
                        if file.endswith(('.safetensors', '.pt', '.pth')):
                            model_file = file_path
                            logger.info(f"Found model file: {file_path}")
                        elif file == 'vocab.txt':
                            vocab_file = file_path
                            logger.info(f"Found vocab file: {file_path}")
            except Exception as e:
                logger.error(f"Error reading directory {item_path}: {e}")
                continue

            # Only add if we found both model and vocab files
            if model_file and vocab_file:
                # Create model entry
                model_info = {
                    "id": item,
                    "name": item.replace('-', ' ').replace('_', ' ').title(),
                    "repo_id": f"local/{item}",
                    "model_path": model_file,
                    "vocab_path": vocab_file,
                    "config": {},
                    "source": "local",
                    "language": "en",  # Default language
                    "languages": ["en"],  # Default languages
                    "is_symlink": False,
                    "original_model_file": None,
                    "original_vocab_file": None
                }

                # Add to registry
                registry.setdefault("models", []).append(model_info)
                new_models_found += 1
            else:
                pass  # Skipping model - missing files

        # Save updated registry
        if new_models_found > 0:
            if save_registry(registry):
                message = f"Found and added {new_models_found} new models"
                return True, message
            else:
                logger.error("Failed to save registry after scanning")
                return False, "Failed to save registry after scanning"
        else:
            message = "No new models found"
            return True, message

    except Exception as e:
        logger.error(f"Error scanning models directory: {e}")
        import traceback
        traceback.print_exc()
        return False, f"Error scanning directory: {str(e)}"


def get_models(include_cache=False):
    """Get list of available models."""
    registry = get_registry()
    # Ensure downloads is present
    if "downloads" not in registry:
        registry["downloads"] = {}

    result = {
        "active_model": registry.get("active_model"), # Use .get for safety
        "models": registry.get("models", []),       # Use .get for safety
        "downloads": registry.get("downloads", {})   # Use .get for safety
    }

    if include_cache:
        result["cache_models"] = list_huggingface_cache_models()

    return result
