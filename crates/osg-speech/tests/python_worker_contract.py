import base64
import importlib.util
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker" / "osg_speech_worker.py"
_WORKER_MODULE = None


def load_worker():
    global _WORKER_MODULE
    if _WORKER_MODULE is not None:
        return _WORKER_MODULE
    spec = importlib.util.spec_from_file_location("osg_speech_worker", WORKER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    _WORKER_MODULE = module
    return _WORKER_MODULE


def encode(value):
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(payload)) + payload


def receive(stream):
    length = struct.unpack(">I", stream.read(4))[0]
    return json.loads(stream.read(length))


def conditionals_contract(worker, payload):
    return mock.patch.multiple(
        worker,
        CHATTERBOX_CONDITIONALS_BYTES=len(payload),
        CHATTERBOX_CONDITIONALS_SHA256=worker.hashlib.sha256(payload).hexdigest(),
    )


class WorkerContractTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        del cls
        global _WORKER_MODULE
        if _WORKER_MODULE is not None:
            _WORKER_MODULE._PROTOCOL_OUT.close()
            _WORKER_MODULE = None

    def test_handshake_and_errors_are_framed_and_redacted(self):
        with subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-B",
                "-u",
                "-X",
                "utf8",
                str(WORKER),
                "--stdio-worker",
                "--protocol-version",
                "1",
                "--backend",
                "edge_tts",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            self.assertEqual(receive(process.stdout)["type"], "hello")
            process.stdin.write(encode({
                "protocol": 1,
                "request_id": 7,
                "command": "C:/private/narration.txt",
            }))
            process.stdin.flush()
            error = receive(process.stdout)
            self.assertEqual(error["code"], "invalid_request")
            self.assertNotIn("private", json.dumps(error))
            process.stdin.write(encode({"protocol": 1, "request_id": 8, "command": "shutdown"}))
            process.stdin.flush()
            self.assertEqual(process.wait(timeout=5), 0)
            self.assertEqual(process.stderr.read(), b"")

    def test_mp3_metadata_is_measured_from_frames(self):
        worker = load_worker()
        # MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417-byte frames.
        frame = bytes.fromhex("fffb9064") + bytes(413)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.mp3"
            path.write_bytes(frame * 3)
            duration, rate, channels = worker._mp3_metadata(path)
        self.assertEqual(rate, 44_100)
        self.assertEqual(channels, 2)
        self.assertEqual(duration, round(3 * 1_152 * 1_000_000 / 44_100))

    def test_gemini_catalog_is_closed_and_matches_the_app_catalog(self):
        worker = load_worker()
        self.assertEqual(worker.GEMINI_MODELS, {
            "gemini-3.1-flash-live-preview",
            "gemini-2.5-flash-native-audio-preview-12-2025",
        })
        self.assertEqual(len(worker.GEMINI_VOICES), 30)
        self.assertEqual(len(set(worker.GEMINI_VOICES)), 30)
        self.assertEqual(set(worker.GEMINI_VOICE_GENDERS), set(worker.GEMINI_VOICES))
        self.assertEqual(set(worker.GEMINI_VOICE_GENDERS.values()), {"female", "male"})
        self.assertEqual(worker.GEMINI_VOICE_GENDERS["Aoede"], "female")
        self.assertEqual(worker.GEMINI_VOICE_GENDERS["Puck"], "male")

    def test_output_capability_rejects_existing_and_wrong_extension(self):
        worker = load_worker()
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            existing = directory / "existing.wav"
            existing.write_bytes(b"fixture")
            extensionless_input = directory / "managed-artifact"
            extensionless_input.write_bytes(b"fixture")
            self.assertEqual(
                worker._require_path(str(extensionless_input), {"wav"}, must_exist=True),
                extensionless_input,
            )
            with self.assertRaises(worker.WorkerFailure):
                worker._require_path(str(existing), {"wav"}, must_exist=False)
            with self.assertRaises(worker.WorkerFailure):
                worker._require_path(str(directory / "output.exe"), {"wav"}, must_exist=False)

    def test_installed_package_signature_drift_fails_closed(self):
        worker = load_worker()

        def exact(text, voice):
            del text, voice

        def extensible(**kwargs):
            del kwargs

        worker._require_keywords(exact, {"text", "voice"})
        worker._require_keywords(extensible, {"text", "voice"})
        with self.assertRaisesRegex(worker.WorkerFailure, "model_unavailable"):
            worker._require_keywords(exact, {"text", "voice", "rate"})

    def test_invalid_chatterbox_language_never_loads_a_model(self):
        worker = load_worker()
        settings = {
            "language": "en-US",
            "exaggeration_milli": 1_000,
            "cfg_weight_milli": 500,
        }
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            reference = directory / "reference.wav"
            reference.write_bytes(b"not-decoded-before-validation")
            request = {
                "protocol": 1,
                "request_id": 1,
                "command": "synthesize",
                "backend": "chatterbox",
                "segment_id": "segment-1",
                "text": "Hello",
                "settings": {"backend": "chatterbox", "settings": settings},
                "reference_path": str(reference),
                "output_path": str(directory / "output.wav"),
                "output_format": "wav",
            }
            with mock.patch.object(worker, "_emit_progress"), \
                    mock.patch.object(worker, "_load_chatterbox") as load_model:
                with self.assertRaisesRegex(worker.WorkerFailure, "invalid_request"):
                    worker._synthesize(1, request, "chatterbox")
            load_model.assert_not_called()

    def test_f5_reference_trim_decodes_only_the_bounded_frame_range(self):
        worker = load_worker()
        rate = 44_100
        self.assertEqual(
            worker._reference_frame_range(rate, rate * 60, (0, 12_000_000)),
            (0, rate * 12),
        )
        self.assertEqual(
            worker._reference_frame_range(rate, rate * 5, (0, 12_000_000)),
            (0, rate * 5),
        )
        with self.assertRaisesRegex(worker.WorkerFailure, "invalid_request"):
            worker._reference_frame_range(rate, rate * 60, (0, 12_000_001))
        with self.assertRaisesRegex(worker.WorkerFailure, "reference_rejected"):
            worker._reference_frame_range(rate, rate * 60, (61_000_000, 62_000_000))

    def test_managed_model_capability_is_absolute_bounded_and_fail_closed(self):
        worker = load_worker()
        old_value = worker._MODEL_ROOT_VALUE
        old_root = worker._MODEL_ROOT
        try:
            with tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                root = directory / "models"
                root.mkdir()
                inside = root / "model.bin"
                inside.write_bytes(b"verified")
                outside = directory / "outside.bin"
                outside.write_bytes(b"not-capable")

                worker._MODEL_ROOT_VALUE = str(root)
                worker._MODEL_ROOT = None
                self.assertEqual(worker._managed_model_root(), root.resolve())
                self.assertEqual(worker._managed_model_file(root, "model.bin"), inside)
                with self.assertRaisesRegex(worker.WorkerFailure, "model_unavailable"):
                    worker._managed_model_file(root, "../outside.bin")

                worker._MODEL_ROOT_VALUE = "relative/models"
                worker._MODEL_ROOT = None
                with self.assertRaisesRegex(worker.WorkerFailure, "model_unavailable"):
                    worker._managed_model_root()
        finally:
            worker._MODEL_ROOT_VALUE = old_value
            worker._MODEL_ROOT = old_root

    def test_managed_f5_uses_only_pinned_local_model_files(self):
        worker = load_worker()
        old_value = worker._MODEL_ROOT_VALUE
        old_root = worker._MODEL_ROOT
        old_model = worker._F5_MODEL
        observed = {}

        class FakeF5:
            def __init__(self, *, device, ckpt_file=None, vocab_file=None,
                         vocoder_local_path=None):
                observed.update({
                    "device": device,
                    "checkpoint": ckpt_file,
                    "vocabulary": vocab_file,
                    "vocoder": vocoder_local_path,
                })

            def infer(self, *, ref_file, ref_text, gen_text, file_wave,
                      remove_silence, speed, nfe_step, sway_sampling_coef,
                      cfg_strength, seed):
                del ref_file, ref_text, gen_text, file_wave, remove_silence
                del speed, nfe_step, sway_sampling_coef, cfg_strength, seed

        package = ModuleType("f5_tts")
        api = ModuleType("f5_tts.api")
        api.F5TTS = FakeF5
        package.api = api
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                checkpoint = root / "F5TTS_v1_Base" / "model_1250000.safetensors"
                vocabulary = root / "F5TTS_v1_Base" / "vocab.txt"
                vocoder_config = root / "vocos" / "config.yaml"
                vocoder_weights = root / "vocos" / "pytorch_model.bin"
                for path in (checkpoint, vocabulary, vocoder_config, vocoder_weights):
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"verified")

                worker._MODEL_ROOT_VALUE = str(root)
                worker._MODEL_ROOT = None
                worker._F5_MODEL = None
                with mock.patch.dict(sys.modules, {
                    "f5_tts": package,
                    "f5_tts.api": api,
                }), mock.patch.object(worker, "_device", return_value="cpu"):
                    self.assertIsInstance(worker._load_f5(), FakeF5)

                self.assertEqual(observed, {
                    "device": "cpu",
                    "checkpoint": str(checkpoint),
                    "vocabulary": str(vocabulary),
                    "vocoder": str(root / "vocos"),
                })
        finally:
            worker._MODEL_ROOT_VALUE = old_value
            worker._MODEL_ROOT = old_root
            worker._F5_MODEL = old_model

    def test_managed_chatterbox_never_calls_download_capable_constructors(self):
        worker = load_worker()
        old_value = worker._MODEL_ROOT_VALUE
        old_root = worker._MODEL_ROOT
        old_models = (worker._CHATTERBOX_EN, worker._CHATTERBOX_MULTI, worker._CHATTERBOX_VC)
        observed = []

        class FakeEnglish:
            @classmethod
            def from_local(cls, ckpt_dir, device):
                observed.append(("english", Path(ckpt_dir), device))
                return cls()

            @classmethod
            def from_pretrained(cls, device):
                del device
                raise AssertionError("managed workers must not download models")

            def generate(self, *, text, audio_prompt_path, exaggeration,
                         cfg_weight, temperature):
                del text, audio_prompt_path, exaggeration, cfg_weight, temperature

        class FakeMultilingual:
            @classmethod
            def from_local(cls, ckpt_dir, device):
                observed.append(("multilingual", Path(ckpt_dir), device))
                return cls()

            @classmethod
            def from_pretrained(cls, device):
                del device
                raise AssertionError("managed workers must not download models")

            def generate(self, *, text, language_id, audio_prompt_path,
                         exaggeration, cfg_weight, temperature):
                del text, language_id, audio_prompt_path
                del exaggeration, cfg_weight, temperature

        package = ModuleType("chatterbox")
        package.ChatterboxTTS = FakeEnglish
        package.ChatterboxMultilingualTTS = FakeMultilingual
        vc = ModuleType("chatterbox.vc")
        safe_loads = []

        class FakeS3Gen:
            def __init__(self):
                self.state = None
                self.strict = None
                self.device = None
                self.evaluated = False

            def load_state_dict(self, state, *, strict):
                self.state = state
                self.strict = strict

            def to(self, device):
                self.device = device
                return self

            def eval(self):
                self.evaluated = True
                return self

        def safe_load(source, map_location=None, *, weights_only=None):
            safe_loads.append((source.read(), map_location, weights_only))
            return {"gen": {"voice": "verified"}}

        def safe_load_file(path):
            return {"path": Path(path)}

        vc.Path = Path
        vc.S3Gen = FakeS3Gen
        vc.load_file = safe_load_file
        vc.torch = SimpleNamespace(load=safe_load, device=lambda value: value)
        exec("""
class ChatterboxVC:
    def __init__(self, s3gen, device, ref_dict=None):
        self.s3gen = s3gen
        self.device = device
        self.ref_dict = ref_dict

    @classmethod
    def from_local(cls, ckpt_dir, device):
        ckpt_dir = Path(ckpt_dir)
        if device in ["cpu", "mps"]:
            map_location = torch.device("cpu")
        else:
            map_location = None

        ref_dict = None
        if (builtin_voice := ckpt_dir / "conds.pt").exists():
            states = torch.load(builtin_voice, map_location=map_location)
            ref_dict = states["gen"]
        s3gen = S3Gen()
        s3gen.load_state_dict(
            load_file(ckpt_dir / "s3gen.safetensors"), strict=False
        )
        s3gen.to(device).eval()
        return cls(s3gen, device, ref_dict=ref_dict)

    @classmethod
    def from_pretrained(cls, device):
        del device
        raise AssertionError("managed workers must not download models")

    def generate(self, *, audio, target_voice_path):
        del audio, target_voice_path
""", vc.__dict__)
        FakeConversion = vc.ChatterboxVC
        vc.ChatterboxVC = FakeConversion
        package.vc = vc
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = b"verified conditionals"
                (root / "conds.pt").write_bytes(payload)
                (root / "s3gen.safetensors").write_bytes(b"verified")
                worker._MODEL_ROOT_VALUE = str(root)
                worker._MODEL_ROOT = None
                worker._CHATTERBOX_EN = None
                worker._CHATTERBOX_MULTI = None
                worker._CHATTERBOX_VC = None
                with mock.patch.dict(sys.modules, {
                    "chatterbox": package,
                    "chatterbox.vc": vc,
                }), mock.patch.object(
                    worker, "_device", return_value="cpu"
                ), conditionals_contract(worker, payload):
                    self.assertIsInstance(worker._load_chatterbox(False), FakeEnglish)
                    self.assertIsInstance(worker._load_chatterbox(True), FakeMultilingual)
                    conversion = worker._load_chatterbox_vc()
                    self.assertIsInstance(conversion, FakeConversion)
                    self.assertEqual(conversion.device, "cpu")
                    self.assertEqual(conversion.ref_dict, {"voice": "verified"})
                    self.assertEqual(
                        conversion.s3gen.state,
                        {"path": root / "s3gen.safetensors"},
                    )
                    self.assertFalse(conversion.s3gen.strict)
                    self.assertEqual(conversion.s3gen.device, "cpu")
                    self.assertTrue(conversion.s3gen.evaluated)

                self.assertEqual(observed, [
                    ("english", root.resolve(), "cpu"),
                    ("multilingual", root.resolve(), "cpu"),
                ])
                self.assertEqual(safe_loads, [
                    (payload, "cpu", True),
                ])
                self.assertIs(vc.torch.load, safe_load)
        finally:
            worker._MODEL_ROOT_VALUE = old_value
            worker._MODEL_ROOT = old_root
            (worker._CHATTERBOX_EN,
              worker._CHATTERBOX_MULTI,
              worker._CHATTERBOX_VC) = old_models

    def test_chatterbox_vc_rejects_unsafe_weights_request_before_torch_load(self):
        worker = load_worker()
        unsafe_loads = []

        def unsafe_load(source, map_location=None, *, weights_only=None):
            unsafe_loads.append((source, map_location, weights_only))
            raise AssertionError("unsafe torch.load must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            vc = ModuleType("hostile_chatterbox_vc")
            vc.Path = Path
            vc.torch = SimpleNamespace(load=unsafe_load)
            exec("""
class HostileConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        del device
        torch.load(Path(ckpt_dir) / "conds.pt", weights_only=False)
        return cls()
""", vc.__dict__)

            with conditionals_contract(worker, payload):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._guarded_chatterbox_vc_from_local(
                        vc.HostileConversion,
                        root,
                        "cpu",
                    )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(unsafe_loads, [])
            self.assertIs(vc.torch.load, unsafe_load)

    def test_chatterbox_vc_rejects_custom_pickle_module_before_torch_load(self):
        worker = load_worker()
        unsafe_loads = []

        def unsafe_load(
            source,
            map_location=None,
            pickle_module=None,
            *,
            weights_only=None,
        ):
            unsafe_loads.append(
                (source, map_location, pickle_module, weights_only),
            )
            raise AssertionError("custom pickle module must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            vc = ModuleType("pickle_chatterbox_vc")
            vc.Path = Path
            vc.torch = SimpleNamespace(load=unsafe_load)
            exec("""
class PickleConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        del device
        torch.load(Path(ckpt_dir) / "conds.pt", pickle_module=object())
        return cls()
""", vc.__dict__)

            with conditionals_contract(worker, payload):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._guarded_chatterbox_vc_from_local(
                        vc.PickleConversion,
                        root,
                        "cpu",
                    )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(unsafe_loads, [])
            self.assertIs(vc.torch.load, unsafe_load)

    def test_chatterbox_vc_rejects_default_load_alias_before_invocation(self):
        worker = load_worker()
        unsafe_loads = []

        def unsafe_load(source):
            unsafe_loads.append(source)
            raise AssertionError("retained torch.load alias must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            vc = ModuleType("default_alias_chatterbox_vc")
            vc.Path = Path
            vc.torch = SimpleNamespace(load=unsafe_load)
            vc.unsafe_load = unsafe_load
            exec("""
class DefaultAliasConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device, retained_load=unsafe_load):
        del device
        retained_load(Path(ckpt_dir) / "conds.pt")
        torch.load(Path(ckpt_dir) / "conds.pt")
        return cls()
""", vc.__dict__)

            with conditionals_contract(worker, payload):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._guarded_chatterbox_vc_from_local(
                        vc.DefaultAliasConversion,
                        root,
                        "cpu",
                    )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(unsafe_loads, [])
            self.assertIs(vc.torch.load, unsafe_load)

    def test_chatterbox_vc_rejects_torch_global_rebinding_before_invocation(self):
        worker = load_worker()
        unsafe_loads = []

        def compatible_load(source, map_location=None, *, weights_only=None):
            unsafe_loads.append((source, map_location, weights_only))
            raise AssertionError("rebound torch.load must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            vc = ModuleType("rebound_torch_chatterbox_vc")
            original_torch = SimpleNamespace(load=compatible_load)
            vc.Path = Path
            vc.torch = original_torch
            vc.bypass = SimpleNamespace(load=compatible_load)
            exec("""
class ReboundTorchConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        global torch
        del device
        torch = bypass
        torch.load(Path(ckpt_dir) / "conds.pt")
        return cls()
""", vc.__dict__)

            with conditionals_contract(worker, payload):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._guarded_chatterbox_vc_from_local(
                        vc.ReboundTorchConversion,
                        root,
                        "cpu",
                    )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(unsafe_loads, [])
            self.assertIs(vc.torch, original_torch)

    def test_chatterbox_vc_rejects_torch_load_mutation_before_invocation(self):
        worker = load_worker()
        unsafe_loads = []

        def compatible_load(source, map_location=None, *, weights_only=None):
            unsafe_loads.append((source, map_location, weights_only))
            raise AssertionError("mutated torch.load must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            vc = ModuleType("mutated_torch_chatterbox_vc")
            original_torch = SimpleNamespace(load=compatible_load)
            vc.Path = Path
            vc.torch = original_torch
            vc.load_file = compatible_load
            exec("""
class MutatedTorchConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        del device
        torch.load = load_file
        torch.load(Path(ckpt_dir) / "conds.pt")
        return cls()
""", vc.__dict__)

            with conditionals_contract(worker, payload):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._guarded_chatterbox_vc_from_local(
                        vc.MutatedTorchConversion,
                        root,
                        "cpu",
                    )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(unsafe_loads, [])
            self.assertIs(vc.torch, original_torch)

    def test_chatterbox_vc_rejects_unguardable_loader_before_invocation(self):
        worker = load_worker()
        loader_entries = []
        unsafe_loads = []

        def unsafe_load(source):
            unsafe_loads.append(source)
            raise AssertionError("unguarded loader must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            vc = ModuleType("aliased_chatterbox_vc")
            vc.loader_entries = loader_entries
            vc.unsafe_load = unsafe_load
            exec("""
class AliasedConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        loader_entries.append((ckpt_dir, device))
        unsafe_load(ckpt_dir)
        return cls()
""", vc.__dict__)

            with self.assertRaises(worker.WorkerFailure) as raised:
                worker._guarded_chatterbox_vc_from_local(
                    vc.AliasedConversion,
                    root,
                    "cpu",
                )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(loader_entries, [])
            self.assertEqual(unsafe_loads, [])

    def test_chatterbox_vc_rejects_wrong_conditioning_path_before_torch_load(self):
        worker = load_worker()
        unsafe_loads = []

        def unsafe_load(source, *, weights_only=None):
            unsafe_loads.append((source, weights_only))
            raise AssertionError("unreviewed model file must not be deserialized")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            payload = b"verified conditionals"
            (root / "conds.pt").write_bytes(payload)
            (root / "other.pt").write_bytes(b"unreviewed")
            vc = ModuleType("wrong_path_chatterbox_vc")
            vc.Path = Path
            vc.torch = SimpleNamespace(load=unsafe_load)
            exec("""
class WrongPathConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        del device
        torch.load(Path(ckpt_dir) / "other.pt")
        return cls()
""", vc.__dict__)

            with conditionals_contract(worker, payload):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._guarded_chatterbox_vc_from_local(
                        vc.WrongPathConversion,
                        root,
                        "cpu",
                    )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(unsafe_loads, [])
            self.assertIs(vc.torch.load, unsafe_load)

    def test_chatterbox_vc_rejects_tampered_conditionals_before_loader(self):
        worker = load_worker()
        loader_entries = []
        unsafe_loads = []

        def unsafe_load(source, *, weights_only=None):
            unsafe_loads.append((source, weights_only))
            raise AssertionError("tampered model file must not be deserialized")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "conds.pt").write_bytes(
                b"\x00" * worker.CHATTERBOX_CONDITIONALS_BYTES,
            )
            vc = ModuleType("tampered_chatterbox_vc")
            vc.Path = Path
            vc.loader_entries = loader_entries
            vc.torch = SimpleNamespace(load=unsafe_load)
            exec("""
class TamperedConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        loader_entries.append((ckpt_dir, device))
        torch.load(Path(ckpt_dir) / "conds.pt")
        return cls()
""", vc.__dict__)

            with self.assertRaises(worker.WorkerFailure) as raised:
                worker._guarded_chatterbox_vc_from_local(
                    vc.TamperedConversion,
                    root,
                    "cpu",
                )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(loader_entries, [])
            self.assertEqual(unsafe_loads, [])

    def test_chatterbox_conditionals_contract_matches_reviewed_inventory(self):
        worker = load_worker()
        upstreams = json.loads(
            (ROOT / "delivery" / "speech-upstreams.lock.json").read_text(
                encoding="utf-8",
            ),
        )
        conditionals = next(
            file for file in upstreams["models"]["chatterbox"]["files"]
            if file["path"] == "conds.pt"
        )
        self.assertEqual(
            conditionals,
            {
                "path": "conds.pt",
                "sizeBytes": worker.CHATTERBOX_CONDITIONALS_BYTES,
                "sha256": worker.CHATTERBOX_CONDITIONALS_SHA256,
            },
        )

    def test_chatterbox_vc_requires_explicit_weights_only_torch_api(self):
        worker = load_worker()
        loader_entries = []
        unsafe_loads = []

        def incompatible_load(source):
            unsafe_loads.append(source)
            raise AssertionError("incompatible torch.load must not run")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "conds.pt").write_bytes(b"verified conditionals")
            vc = ModuleType("incompatible_torch_chatterbox_vc")
            vc.Path = Path
            vc.loader_entries = loader_entries
            vc.torch = SimpleNamespace(load=incompatible_load)
            exec("""
class IncompatibleTorchConversion:
    @classmethod
    def from_local(cls, ckpt_dir, device):
        loader_entries.append((ckpt_dir, device))
        torch.load(Path(ckpt_dir) / "conds.pt")
        return cls()
""", vc.__dict__)

            with self.assertRaises(worker.WorkerFailure) as raised:
                worker._guarded_chatterbox_vc_from_local(
                    vc.IncompatibleTorchConversion,
                    root,
                    "cpu",
                )

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(loader_entries, [])
            self.assertEqual(unsafe_loads, [])

    def test_chatterbox_vc_never_uses_download_loader_without_managed_models(self):
        worker = load_worker()
        old_value = worker._MODEL_ROOT_VALUE
        old_root = worker._MODEL_ROOT
        old_model = worker._CHATTERBOX_VC
        calls = []

        class FakeConversion:
            @classmethod
            def from_local(cls, ckpt_dir, device):
                calls.append(("local", ckpt_dir, device))
                return cls()

            @classmethod
            def from_pretrained(cls, device):
                calls.append(("download", device))
                return cls()

            def generate(self, *, audio, target_voice_path):
                del audio, target_voice_path

        package = ModuleType("chatterbox")
        vc = ModuleType("chatterbox.vc")
        vc.ChatterboxVC = FakeConversion
        package.vc = vc
        try:
            worker._MODEL_ROOT_VALUE = ""
            worker._MODEL_ROOT = None
            worker._CHATTERBOX_VC = None
            with mock.patch.dict(sys.modules, {
                "chatterbox": package,
                "chatterbox.vc": vc,
            }), mock.patch.object(worker, "_device", return_value="cpu"):
                with self.assertRaises(worker.WorkerFailure) as raised:
                    worker._load_chatterbox_vc()

            self.assertEqual(raised.exception.code, "model_unavailable")
            self.assertEqual(calls, [])
        finally:
            worker._MODEL_ROOT_VALUE = old_value
            worker._MODEL_ROOT = old_root
            worker._CHATTERBOX_VC = old_model

    def test_managed_f5_rejects_implicit_whisper_download(self):
        worker = load_worker()
        old_value = worker._MODEL_ROOT_VALUE
        old_root = worker._MODEL_ROOT
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                worker._MODEL_ROOT_VALUE = str(root)
                worker._MODEL_ROOT = None
                settings = {
                    "reference_text": None,
                    "model": "f5tts-v1-base",
                    "speech_rate_milli": 1_000,
                    "nfe_steps": 32,
                    "sway_milli": -1_000,
                    "guidance_milli": 2_000,
                    "seed": None,
                    "remove_silence": False,
                }
                with self.assertRaisesRegex(worker.WorkerFailure, "model_unavailable"):
                    worker._synthesize_f5(
                        "Narration", settings, root / "reference.wav", root / "output.wav",
                    )
        finally:
            worker._MODEL_ROOT_VALUE = old_value
            worker._MODEL_ROOT = old_root

    def test_gemini_pcm_chunks_require_the_declared_24khz_contract(self):
        worker = load_worker()
        encoded = base64.b64encode(b"\x00\x00").decode("ascii")
        self.assertEqual(
            worker._decode_pcm_inline(SimpleNamespace(
                data=encoded,
                mime_type="audio/pcm;rate=24000",
            )),
            b"\x00\x00",
        )
        with self.assertRaisesRegex(worker.WorkerFailure, "encoding_failed"):
            worker._decode_pcm_inline(SimpleNamespace(
                data=encoded,
                mime_type="audio/mpeg",
            ))
        with self.assertRaisesRegex(worker.WorkerFailure, "encoding_failed"):
            worker._decode_pcm_inline(SimpleNamespace(
                data="not base64!",
                mime_type="audio/pcm;rate=24000",
            ))


if __name__ == "__main__":
    unittest.main()
