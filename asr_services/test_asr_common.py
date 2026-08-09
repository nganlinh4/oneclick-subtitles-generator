import unittest

from asr_services.asr_common import format_srt_time, generate_srt_content, process_words


class AsrCommonTests(unittest.TestCase):
    def setUp(self):
        self.words = [
            {"text": "Hello", "start": 0.0, "end": 0.4},
            {"text": "world.", "start": 0.5, "end": 1.0},
            {"text": "Again", "start": 2.0, "end": 2.4},
        ]

    def test_sentence_strategy_splits_on_punctuation_and_pause(self):
        segments = process_words(self.words, "sentence", 60, 7, 0.8)
        self.assertEqual([s["segment"] for s in segments], ["Hello world.", "Again"])
        self.assertEqual((segments[0]["start"], segments[0]["end"]), (0.0, 1.0))

    def test_word_strategy_respects_word_limit(self):
        segments = process_words(self.words, "word", 60, 2, 5.0)
        self.assertEqual([s["segment"] for s in segments], ["Hello world.", "Again"])

    def test_cjk_joiner_does_not_insert_spaces(self):
        words = [
            {"text": "你", "start": 0.0, "end": 0.2},
            {"text": "好。", "start": 0.2, "end": 0.5},
        ]
        segments = process_words(words, "sentence", 60, 7, 0.8, "")
        self.assertEqual(segments[0]["segment"], "你好。")

    def test_srt_format_clamps_negative_time(self):
        self.assertEqual(format_srt_time(-1), "00:00:00,000")
        content = generate_srt_content([{"start": 0, "end": 1.25, "segment": "Hello"}])
        self.assertIn("00:00:00,000 --> 00:00:01,250", content)


if __name__ == "__main__":
    unittest.main()
