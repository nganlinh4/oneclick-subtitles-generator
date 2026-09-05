import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'ami_benchmark', Path(__file__).with_name('prepare-ami-video-benchmark.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProvenanceTests(unittest.TestCase):
    def test_matching_receipt(self):
        module.validate_reuse({'sha256': 'clip', 'camera': 'C', 'cues': 9},
                              {'sha256': 'clip', 'camera': 'C'})

    def test_each_changed_input_refuses_reuse(self):
        expected = {'sha256': 'clip', 'videoSourceSha256': 'video',
                    'audioExcerptSha256': 'audio', 'sourceRange': [60, 120],
                    'camera': 'C', 'durationSeconds': 60, 'file': 'clip.mp4', 'id': 'meeting'}
        for key in expected:
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.validate_reuse({**expected, key: None}, expected)

    def test_missing_receipt_refuses_reuse(self):
        with self.assertRaises(ValueError):
            module.validate_reuse(None, {'sha256': 'clip'})


if __name__ == '__main__':
    unittest.main()
