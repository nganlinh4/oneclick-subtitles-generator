"""Local-only music/Korean test media; never included in the shipped application.

Sources must be downloaded first from the URLs recorded below. The blank video
is explicitly synthetic packaging for an audio workflow, not real camera footage.
References stay in the benchmark process and are never sent to Gemini.
"""
import csv
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1] / 'target/subtitle-benchmark'
SOURCE = ROOT / 'sources/additional'
OUTPUT = ROOT / 'additional-media'
REVISION = 'de188c963fd4539bc769b3feb83582e5a9595e36'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    music = SOURCE / 'cortez-feel.mp3'
    korean = SOURCE / 'fleurs-ko-1883.wav'
    korean_duration = float(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=nw=1:nk=1', str(korean)], text=True))
    words = (SOURCE / 'cortez-feel-words.txt').read_text(encoding='utf-8').splitlines()
    timings = list(csv.DictReader((SOURCE / 'cortez-feel-words.csv').open(encoding='utf-8')))
    assert len(words) == len(timings), 'Lyric word/annotation count mismatch'
    music_words = [{'text': text, 'start': float(row['word_start']) - 10,
                    'end': float(row['word_end']) - 10}
                   for text, row in zip(words, timings)
                   if float(row['word_start']) >= 10 and float(row['word_end']) <= 70]
    assert music_words
    korean_text = '다리 밑 수직 간격은 15미터이며, 공사는 2011년 8월에 마무리되었으며, 해당 다리의 통행금지는 2017년 3월까지이다.'
    configurations = [
        ('cortez-feel', music, 10, 60, {'words': music_words, 'cues': [], 'wordTimingVerified': True},
         {'source': f'https://huggingface.co/datasets/jamendolyrics/jamendolyrics/tree/{REVISION}',
          'artist': 'Cortez', 'title': 'Feel (Stripped)', 'license': 'CC BY (dataset LicenseType)',
          'track': 'https://www.jamendo.com/track/1481500/feel-stripped'}),
        ('fleurs-ko-1883', korean, 0, korean_duration,
         {'words': [{'text': korean_text}], 'cues': [], 'wordTimingVerified': False},
         {'source': 'https://huggingface.co/datasets/google/fleurs', 'license': 'CC-BY',
          'configuration': 'ko_kr', 'split': 'test', 'rowId': 1883,
          'referencePolicy': 'Official utterance transcript only; no word timing ground truth.'}),
    ]
    cases = []
    for identity, audio, start, duration, reference, provenance in configurations:
        output = OUTPUT / f'{identity}.mp4'
        # Refuse implicit overwrites or stale reuse; a receipt is written once per build.
        if output.exists():
            raise ValueError(f'Output already exists: {output.name}')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-f', 'lavfi', '-i', 'color=c=0x202020:s=640x360:r=1',
                        '-ss', str(start), '-i', str(audio), '-t', str(duration),
                        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264',
                        '-preset', 'fast', '-crf', '26', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-n', str(output)], check=True)
        reference_path = OUTPUT / f'{identity}.reference.json'
        reference_path.write_text(json.dumps(reference, ensure_ascii=False, indent=2), encoding='utf-8')
        cases.append({'id': identity, 'file': output.name, 'sha256': digest(output),
                      'durationSeconds': duration, 'reference': reference_path.name,
                      'referenceSha256': digest(reference_path), 'audioSourceSha256': digest(audio),
                      'sourceRange': [start, start + duration], 'visuals': 'synthetic blank background',
                      'provenance': provenance})
    (OUTPUT / 'manifest.json').write_text(json.dumps({'cases': cases}, indent=2), encoding='utf-8')
    print(json.dumps([{'id': case['id'], 'duration': case['durationSeconds']} for case in cases]))


if __name__ == '__main__':
    main()
