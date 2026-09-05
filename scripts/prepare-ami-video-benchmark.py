"""Build three real-video evaluation clips and human-word references from AMI.

Requires the reviewed source files and extracted manual annotation archive in
target/subtitle-benchmark/sources. No credentials or provider calls are used.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'target/subtitle-benchmark/sources'
OUTPUT = ROOT / 'target/subtitle-benchmark/real-video'
NITE = '{http://nite.sourceforge.net/}'
CASES = [
    ('ES2004a', 'Corner', 60, 120),
    ('ES2002a', 'Corner', 120, 210),
    ('IS1009a', 'C', 60, 210),
]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def timecode(seconds):
    millis = round(seconds * 1000)
    minutes, millis = divmod(millis, 60000)
    hours, minutes = divmod(minutes, 60)
    seconds, millis = divmod(millis, 1000)
    return f'{hours:02}:{minutes:02}:{seconds:02},{millis:03}'


def reference(meeting, start, end):
    cues, words = [], []
    source_files = []
    for speaker in 'ABCD':
        word_path = SOURCE / f'annotations/words/{meeting}.{speaker}.words.xml'
        segment_path = SOURCE / f'annotations/segments/{meeting}.{speaker}.segments.xml'
        source_files.extend([word_path, segment_path])
        elements = list(ET.parse(word_path).getroot())
        by_id = {node.get(NITE + 'id'): index for index, node in enumerate(elements)}
        for segment in ET.parse(segment_path).getroot():
            child = segment.find(NITE + 'child')
            if child is None:
                continue
            ids = re.findall(r'id\(([^)]+)\)', child.get('href', ''))
            if not ids:
                continue
            selected = elements[by_id[ids[0]]:by_id[ids[-1]] + 1]
            spoken = []
            for node in selected:
                if node.tag != 'w' or node.get('punc') == 'true':
                    continue
                a, b = float(node.get('starttime')), float(node.get('endtime'))
                if a < start or b > end or b <= a:
                    continue
                spoken.append({'text': node.text or '', 'start': a - start,
                               'end': b - start, 'speaker': speaker})
            if spoken:
                words.extend(spoken)
                cues.append({'text': ' '.join(w['text'] for w in spoken),
                             'start': spoken[0]['start'], 'end': spoken[-1]['end'],
                             'speaker': speaker})
    cues.sort(key=lambda cue: (cue['start'], cue['end'], cue['speaker']))
    words.sort(key=lambda word: (word['start'], word['end'], word['speaker']))
    assert cues and words, f'no annotated speech in {meeting}'
    return cues, words, {str(p.relative_to(SOURCE)): digest(p) for p in source_files}


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {'protocol': 'ami-video-v1', 'license': 'CC-BY-4.0',
                'source': 'https://groups.inf.ed.ac.uk/ami/download/',
                'annotationArchiveSha256': digest(SOURCE / 'ami_public_manual_1.6.2.zip'),
                'referencePolicy': 'Manual word boundaries, grouped by original human segments; '
                'punctuation and non-speech events excluded, partially cut words excluded. '
                'Overlapping speakers retained. Not a verbatim subtitle style reference.',
                'cases': []}
    for meeting, camera, start, end in CASES:
        video = SOURCE / f'{meeting}.{camera}.avi'
        audio = SOURCE / f'{meeting}-{start}-{end}.flac'
        output = OUTPUT / f'{meeting}-{start}-{end}.mp4'
        if not output.exists():
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                            '-ss', str(start), '-i', str(video), '-i', str(audio),
                            '-t', str(end - start), '-map', '0:v:0', '-map', '1:a:0',
                            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                            '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
                            '-n', str(output)], check=True)
        cues, words, annotation_hashes = reference(meeting, start, end)
        reference_path = output.with_suffix('.reference.json')
        reference_path.write_text(json.dumps({'cues': cues, 'words': words},
                                            indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        output.with_suffix('.srt').write_text('\n\n'.join(
            f'{i}\n{timecode(cue["start"])} --> {timecode(cue["end"])}\n{cue["text"]}'
            for i, cue in enumerate(cues, 1)) + '\n', encoding='utf-8')
        manifest['cases'].append({'id': meeting, 'file': output.name,
                                  'sha256': digest(output), 'durationSeconds': end - start,
                                  'sourceRange': [start, end], 'camera': camera,
                                  'videoSourceSha256': digest(video),
                                  'audioExcerptSha256': digest(audio),
                                  'reference': reference_path.name,
                                  'referenceSha256': digest(reference_path),
                                  'annotations': annotation_hashes,
                                  'cues': len(cues), 'words': len(words)})
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps([{k: case[k] for k in ['id', 'durationSeconds', 'cues', 'words']}
                      for case in manifest['cases']], indent=2))


if __name__ == '__main__':
    main()
