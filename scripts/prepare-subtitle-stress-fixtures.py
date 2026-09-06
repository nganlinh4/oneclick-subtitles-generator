"""Prepare explicitly synthetic-duration stress and no-audio derivatives of AMI.

The hour source repeats real meeting media; it tests duration/streaming/resource
behaviour, not the linguistic diversity of an actual hour-long conversation.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1] / 'target/subtitle-benchmark'
OUTPUT = ROOT / 'additional-media'
SOURCE = ROOT / 'real-video/ES2004a-60-120.mp4'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    manifest_path = OUTPUT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    for identity, args, minimum_cues in [
        ('ami-no-audio', ['-i', str(SOURCE), '-t', '6', '-an', '-c:v', 'copy'], 0),
        ('ami-hour-repeat', ['-stream_loop', '59', '-i', str(SOURCE), '-t', '3600', '-c', 'copy'], 100),
    ]:
        output = OUTPUT / f'{identity}.mp4'
        if output.exists() or any(case['id'] == identity for case in manifest['cases']):
            raise ValueError(f'Refusing to overwrite existing fixture {identity}')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                        *args, '-movflags', '+faststart', '-n', str(output)], check=True)
        duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                        'format=duration', '-of', 'default=nw=1:nk=1', str(output)], text=True))
        reference = OUTPUT / f'{identity}.reference.json'
        reference.write_text(json.dumps({'scoreable': False, 'words': [], 'cues': [],
                                         'minimumCues': minimum_cues}), encoding='utf-8')
        manifest['cases'].append({'id': identity, 'file': output.name, 'sha256': digest(output),
            'durationSeconds': duration, 'reference': reference.name, 'referenceSha256': digest(reference),
            'sourceSha256': digest(SOURCE), 'source': SOURCE.name, 'license': 'CC-BY-4.0 (AMI)',
            'derivative': 'removed audio' if minimum_cues == 0 else '60 repetitions; duration stress only'})
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print(identity, duration)


if __name__ == '__main__':
    main()
