"""
F5-TTS patch to support custom model configurations.
This patch allows loading F5-TTS models with custom architecture configs
instead of being limited to the predefined yaml configs.
"""

import os
import sys
import re
from importlib.resources import files
from omegaconf import OmegaConf
from hydra.utils import get_class

import torch
import numpy as np

# Add F5-TTS to path if not already there
f5tts_path = os.path.join(os.path.dirname(__file__), '..', '..', 'F5-TTS', 'src')
if f5tts_path not in sys.path:
    sys.path.insert(0, f5tts_path)

from f5_tts.infer.utils_infer import load_model, load_vocoder
from f5_tts.model.utils import seed_everything


class PatchedF5TTS:
    """
    Patched version of F5TTS that supports custom config_dict parameter.
    This allows loading models with architecture configs different from the yaml defaults.
    """

    def __init__(
        self,
        model="F5TTS_v1_Base",
        ckpt_file="",
        vocab_file="",
        ode_method="euler",
        use_ema=True,
        vocoder_local_path=None,
        device=None,
        hf_cache_dir=None,
        config_dict=None,
    ):
        # Import here to avoid circular imports
        from f5_tts.api import F5TTS

        if config_dict is not None:
            # Use provided config dict - create a temporary instance with custom config
            self._init_with_custom_config(
                config_dict, ckpt_file, vocab_file, ode_method, use_ema,
                vocoder_local_path, device, hf_cache_dir
            )
        else:
            # Use original F5TTS behavior
            self._original_f5tts = F5TTS(
                model=model,
                ckpt_file=ckpt_file,
                vocab_file=vocab_file,
                ode_method=ode_method,
                use_ema=use_ema,
                vocoder_local_path=vocoder_local_path,
                device=device,
                hf_cache_dir=hf_cache_dir,
            )
            # Copy attributes from original
            self.mel_spec_type = self._original_f5tts.mel_spec_type
            self.target_sample_rate = self._original_f5tts.target_sample_rate
            self.ode_method = self._original_f5tts.ode_method
            self.use_ema = self._original_f5tts.use_ema
            self.ema_model = self._original_f5tts.ema_model
            self.device = self._original_f5tts.device

    def _init_with_custom_config(
        self, config_dict, ckpt_file, vocab_file, ode_method, use_ema,
        vocoder_local_path, device, hf_cache_dir
    ):
        """Initialize with custom config dictionary."""
        # Structure config to match yaml format
        model_cfg = OmegaConf.create({"model": config_dict})
        model_cls = get_class(f"f5_tts.model.{model_cfg.model.backbone}")
        model_arc = model_cfg.model.arch

        self.mel_spec_type = model_cfg.model.mel_spec.mel_spec_type
        self.target_sample_rate = model_cfg.model.mel_spec.target_sample_rate

        self.ode_method = ode_method
        self.use_ema = use_ema

        if device is not None:
            self.device = device
        else:
            import torch
            self.device = (
                "cuda"
                if torch.cuda.is_available()
                else "xpu"
                if torch.xpu.is_available()
                else "mps"
                if torch.backends.mps.is_available()
                else "cpu"
            )

        # Load vocoder
        self.vocoder = load_vocoder(
            self.mel_spec_type, vocoder_local_path is not None, vocoder_local_path, self.device, hf_cache_dir
        )

        # Load model
        self.ema_model = load_model(
            model_cls, model_arc, ckpt_file, self.mel_spec_type, vocab_file, self.ode_method, self.use_ema, self.device
        )

    def transcribe(self, ref_audio, language=None):
        from f5_tts.api import F5TTS
        # Delegate to original method
        return F5TTS.transcribe(self, ref_audio, language)

    def export_wav(self, wav, file_wave, remove_silence=False):
        from f5_tts.api import F5TTS
        # Delegate to original method
        return F5TTS.export_wav(self, wav, file_wave, remove_silence)

    def export_spectrogram(self, spec, file_spec):
        from f5_tts.api import F5TTS
        # Delegate to original method
        return F5TTS.export_spectrogram(self, spec, file_spec)

    def infer(
        self,
        ref_file,
        ref_text,
        gen_text,
        show_info=print,
        progress=None,
        target_rms=0.1,
        cross_fade_duration=0.15,
        sway_sampling_coef=-1,
        cfg_strength=2,
        nfe_step=32,
        speed=1.0,
        fix_duration=None,
        remove_silence=False,
        file_wave=None,
        file_spec=None,
        seed=None,
    ):
        from f5_tts.api import F5TTS
        # Delegate to original method
        return F5TTS.infer(
            self, ref_file, ref_text, gen_text, show_info, progress, target_rms,
            cross_fade_duration, sway_sampling_coef, cfg_strength, nfe_step, speed,
            fix_duration, remove_silence, file_wave, file_spec, seed
        )


# Monkey patch the original F5TTS to support config_dict
def patch_f5tts():
    """Apply monkey patch to F5TTS to support config_dict parameter."""
    import f5_tts.api
    original_init = f5_tts.api.F5TTS.__init__

    def patched_init(
        self,
        model="F5TTS_v1_Base",
        ckpt_file="",
        vocab_file="",
        ode_method="euler",
        use_ema=True,
        vocoder_local_path=None,
        device=None,
        hf_cache_dir=None,
        config_dict=None,
    ):
        if config_dict is not None:
            # Use patched initialization
            patched_instance = PatchedF5TTS(
                model=model,
                ckpt_file=ckpt_file,
                vocab_file=vocab_file,
                ode_method=ode_method,
                use_ema=use_ema,
                vocoder_local_path=vocoder_local_path,
                device=device,
                hf_cache_dir=hf_cache_dir,
                config_dict=config_dict,
            )
            # Copy all attributes to self
            self.__dict__.update(patched_instance.__dict__)
        else:
            # Use original initialization
            original_init(
                self, model, ckpt_file, vocab_file, ode_method, use_ema,
                vocoder_local_path, device, hf_cache_dir
            )

    # Apply the patch
    f5_tts.api.F5TTS.__init__ = patched_init


# Apply patch when module is imported
patch_f5tts()


# Patch utils_infer functions for better duration calculation
def patch_utils_infer():
    """Apply patches to utils_infer functions for improved text processing."""
    import f5_tts.infer.utils_infer as utils_infer

    # Store original functions
    original_infer_process = utils_infer.infer_process
    original_chunk_text = utils_infer.chunk_text

    # Patched chunk_text using character length instead of byte length
    def patched_chunk_text(text, max_chars=135):
        """
        Splits the input text into chunks, each with a maximum number of characters.

        Args:
            text (str): The text to be split.
            max_chars (int): The maximum number of characters per chunk.

        Returns:
            List[str]: A list of text chunks.
        """
        chunks = []
        current_chunk = ""
        # Split the text into sentences based on punctuation followed by whitespace
        sentences = re.split(r"(?<=[;:,.!?])\s+|(?<=[；：，。！？])", text)

        for sentence in sentences:
            if len(current_chunk) + len(sentence) <= max_chars:
                current_chunk += sentence + " " if sentence and len(sentence[-1]) == 1 else sentence
            else:
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = sentence + " " if sentence and len(sentence[-1]) == 1 else sentence

        if current_chunk:
            chunks.append(current_chunk.strip())

        return chunks

    # Patched infer_process with modified duration calculation
    def patched_infer_process(
        ref_audio,
        ref_text,
        gen_text,
        model_obj,
        vocoder,
        mel_spec_type=utils_infer.mel_spec_type,
        show_info=print,
        progress=utils_infer.tqdm,
        target_rms=utils_infer.target_rms,
        cross_fade_duration=utils_infer.cross_fade_duration,
        nfe_step=utils_infer.nfe_step,
        cfg_strength=utils_infer.cfg_strength,
        sway_sampling_coef=utils_infer.sway_sampling_coef,
        speed=utils_infer.speed,
        fix_duration=utils_infer.fix_duration,
        device=utils_infer.device,
    ):
        # Split the input text into batches
        audio, sr = utils_infer.torchaudio.load(ref_audio)
        max_chars = int(len(ref_text) / (audio.shape[-1] / sr) * (22 - audio.shape[-1] / sr) * speed)
        gen_text_batches = patched_chunk_text(gen_text, max_chars=max_chars)
        for i, gen_text in enumerate(gen_text_batches):
            print(f"gen_text {i}", gen_text)
        print("\n")

        show_info(f"Generating audio in {len(gen_text_batches)} batches...")
        return next(
            patched_infer_batch_process(
                (audio, sr),
                ref_text,
                gen_text_batches,
                model_obj,
                vocoder,
                mel_spec_type=mel_spec_type,
                progress=progress,
                target_rms=target_rms,
                cross_fade_duration=cross_fade_duration,
                nfe_step=nfe_step,
                cfg_strength=cfg_strength,
                sway_sampling_coef=sway_sampling_coef,
                speed=speed,
                fix_duration=fix_duration,
                device=device,
            )
        )

    # Patched infer_batch_process with modified duration calculation
    def patched_infer_batch_process(
        ref_audio,
        ref_text,
        gen_text_batches,
        model_obj,
        vocoder,
        mel_spec_type="vocos",
        progress=utils_infer.tqdm,
        target_rms=0.1,
        cross_fade_duration=0.15,
        nfe_step=32,
        cfg_strength=2.0,
        sway_sampling_coef=-1,
        speed=1,
        fix_duration=None,
        device=None,
        streaming=False,
        chunk_size=2048,
    ):
        audio, sr = ref_audio
        if audio.shape[0] > 1:
            audio = torch.mean(audio, dim=0, keepdim=True)

        rms = torch.sqrt(torch.mean(torch.square(audio)))
        if rms < target_rms:
            audio = audio * target_rms / rms
        if sr != utils_infer.target_sample_rate:
            resampler = utils_infer.torchaudio.transforms.Resample(sr, utils_infer.target_sample_rate)
            audio = resampler(audio)
        audio = audio.to(device)

        generated_waves = []
        spectrograms = []

        if len(ref_text[-1].encode("utf-8")) == 1:
            ref_text = ref_text + " "

        def process_batch(gen_text):
            local_speed = speed
            if len(gen_text.encode("utf-8")) < 10:
                local_speed = 0.3

            # Prepare the text
            text_list = [ref_text + gen_text]
            final_text_list = utils_infer.convert_char_to_pinyin(text_list)

            ref_audio_len = audio.shape[-1] // utils_infer.hop_length
            if fix_duration is not None:
                duration = int(fix_duration * utils_infer.target_sample_rate / utils_infer.hop_length)
            else:
                # Calculate duration using character length instead of byte length
                ref_text_len = len(ref_text)
                gen_text_len = len(gen_text)
                duration = ref_audio_len + int(ref_audio_len / ref_text_len * gen_text_len / local_speed * 1.5)

            # inference
            with torch.inference_mode():
                generated, _ = model_obj.sample(
                    cond=audio,
                    text=final_text_list,
                    duration=duration,
                    steps=nfe_step,
                    cfg_strength=cfg_strength,
                    sway_sampling_coef=sway_sampling_coef,
                )
                del _

                generated = generated.to(torch.float32)  # generated mel spectrogram
                generated = generated[:, ref_audio_len:, :]
                generated = generated.permute(0, 2, 1)
                if mel_spec_type == "vocos":
                    generated_wave = vocoder.decode(generated)
                elif mel_spec_type == "bigvgan":
                    generated_wave = vocoder(generated)
                if rms < target_rms:
                    generated_wave = generated_wave * rms / target_rms

                # wav -> numpy
                generated_wave = generated_wave.squeeze().cpu().numpy()

                if streaming:
                    for j in range(0, len(generated_wave), chunk_size):
                        yield generated_wave[j : j + chunk_size], utils_infer.target_sample_rate
                else:
                    generated_cpu = generated[0].cpu().numpy()
                    del generated
                    yield generated_wave, generated_cpu

        if streaming:
            for gen_text in progress.tqdm(gen_text_batches) if progress is not None else gen_text_batches:
                for chunk in process_batch(gen_text):
                    yield chunk
        else:
            with utils_infer.ThreadPoolExecutor() as executor:
                futures = [executor.submit(process_batch, gen_text) for gen_text in gen_text_batches]
                for future in progress.tqdm(futures) if progress is not None else futures:
                    result = future.result()
                    if result:
                        generated_wave, generated_mel_spec = next(result)
                        generated_waves.append(generated_wave)
                        spectrograms.append(generated_mel_spec)

            if generated_waves:
                if cross_fade_duration <= 0:
                    # Simply concatenate
                    final_wave = np.concatenate(generated_waves)
                else:
                    # Combine all generated waves with cross-fading
                    final_wave = generated_waves[0]
                    for i in range(1, len(generated_waves)):
                        prev_wave = final_wave
                        next_wave = generated_waves[i]

                        # Calculate cross-fade samples, ensuring it does not exceed wave lengths
                        cross_fade_samples = int(cross_fade_duration * utils_infer.target_sample_rate)
                        cross_fade_samples = min(cross_fade_samples, len(prev_wave), len(next_wave))

                        if cross_fade_samples <= 0:
                            # No overlap possible, concatenate
                            final_wave = np.concatenate([prev_wave, next_wave])
                            continue

                        # Overlapping parts
                        prev_overlap = prev_wave[-cross_fade_samples:]
                        next_overlap = next_wave[:cross_fade_samples]

                        # Fade out and fade in
                        fade_out = np.linspace(1, 0, cross_fade_samples)
                        fade_in = np.linspace(0, 1, cross_fade_samples)

                        # Cross-faded overlap
                        cross_faded_overlap = prev_overlap * fade_out + next_overlap * fade_in

                        # Combine
                        new_wave = np.concatenate(
                            [prev_wave[:-cross_fade_samples], cross_faded_overlap, next_wave[cross_fade_samples:]]
                        )

                        final_wave = new_wave

                # Create a combined spectrogram
                combined_spectrogram = np.concatenate(spectrograms, axis=1)

                yield final_wave, utils_infer.target_sample_rate, combined_spectrogram

            else:
                yield None, utils_infer.target_sample_rate, None

    # Apply patches
    utils_infer.chunk_text = patched_chunk_text
    utils_infer.infer_process = patched_infer_process
    utils_infer.infer_batch_process = patched_infer_batch_process


# Apply utils_infer patches
patch_utils_infer()