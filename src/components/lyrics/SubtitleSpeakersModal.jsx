import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CustomModelDialog from '../settings/CustomModelDialog';
import CustomDropdown from '../common/CustomDropdown';
import { isValidSpeakerName, normalizeSpeaker, SPEAKER_LABEL_STYLES, subtitleDisplayText } from '../../utils/subtitleSpeaker';
import { cueOverlapsTimelineRange } from './utils/timelineDomain';

// Mounted only while open: drafts never alter live cues until one undoable Apply.
export default function SubtitleSpeakersModal({ lyrics, selectedRange, onApply, onClose }) {
  const { t } = useTranslation();
  const speakers = useMemo(() => {
    const found = new Map();
    for (const cue of lyrics) {
      const speaker = normalizeSpeaker(cue.speaker);
      if (speaker && !found.has(speaker.id)) found.set(speaker.id, speaker);
    }
    return [...found.values()];
  }, [lyrics]);
  const [names, setNames] = useState(() => Object.fromEntries(speakers.map((s) => [s.id, s.name])));
  const [scope, setScope] = useState(selectedRange ? 'selection' : 'all');
  const [assignment, setAssignment] = useState('keep');
  const [newName, setNewName] = useState('');
  const [style, setStyle] = useState('keep');
  const [newId] = useState(() => `manual:${crypto.randomUUID()}`);
  const inScope = (cue) => scope === 'all' || (selectedRange && cueOverlapsTimelineRange(cue, selectedRange.start, selectedRange.end));
  const affected = lyrics.filter(inScope);
  const valid = affected.length > 0 && Object.values(names).every(isValidSpeakerName) && (assignment !== 'new' || isValidSpeakerName(newName));
  const transform = (cue) => {
    let speaker = normalizeSpeaker(cue.speaker);
    // Renaming an identity is global; assigning cues and label style honor the selected scope.
    if (speaker) speaker = { ...speaker, name: names[speaker.id] ?? speaker.name };
    if (inScope(cue)) {
      if (assignment === 'none') speaker = null;
      else if (assignment === 'new') speaker = { id: newId, name: newName.trim(), labelStyle: speaker?.labelStyle ?? 'hidden' };
      else if (assignment !== 'keep') {
        const source = speakers.find((s) => `id:${s.id}` === assignment);
        if (source) speaker = { ...source, name: names[source.id] ?? source.name };
      }
      if (speaker && style !== 'keep') speaker = { ...speaker, labelStyle: style };
    }
    return { ...cue, speaker };
  };
  const example = affected[0] && valid ? subtitleDisplayText(transform(affected[0])) : '';
  return <CustomModelDialog isOpen onClose={onClose} title={t('lyrics.speakersTitle')}
    footer={<button className="apply-btn speaker-apply-btn" disabled={!valid} onClick={() => { onApply(lyrics.map(transform)); onClose(); }}>{t('subtitleSplit.apply')}</button>}>
    <div className="subtitle-speakers-options">
      <p>{t('lyrics.speakersDescription')}</p>
      {speakers.map((speaker, index) => <label key={speaker.id}>
        <span>{t('lyrics.speakerName', { number: index + 1 })}</span>
        <input value={names[speaker.id] ?? speaker.name} maxLength={200} onChange={(event) => setNames({ ...names, [speaker.id]: event.target.value })} />
      </label>)}
      <label><span>{t('lyrics.speakerScope')}</span>
        <CustomDropdown id="speaker-scope" value={scope} onChange={setScope} options={[
          { value: 'all', label: t('lyrics.speakerAll') },
          ...(selectedRange ? [{ value: 'selection', label: t('lyrics.speakerSelection') }] : []),
        ]} />
      </label>
      <label><span>{t('lyrics.speakerAssign')}</span>
        <CustomDropdown id="speaker-assignment" value={assignment} onChange={setAssignment} options={[
          { value: 'keep', label: t('lyrics.speakerKeep') },
          ...speakers.map((s) => ({ value: `id:${s.id}`, label: names[s.id] ?? s.name })),
          { value: 'new', label: t('lyrics.speakerNew') },
          { value: 'none', label: t('lyrics.speakerNone') },
        ]} />
      </label>
      {assignment === 'new' && <label><span>{t('lyrics.speakerNew')}</span><input id="speaker-new-name" value={newName} maxLength={200} onChange={(event) => setNewName(event.target.value)} /></label>}
      <label><span>{t('lyrics.speakerFormat')}</span>
        <CustomDropdown id="speaker-label-style" value={style} onChange={setStyle} options={[
          { value: 'keep', label: t('lyrics.speakerKeep') },
          ...SPEAKER_LABEL_STYLES.map((value) => ({ value, label: t(`lyrics.speakerStyle_${value}`) })),
        ]} />
      </label>
      {example && <p className="speaker-label-example">{example}</p>}
    </div>
  </CustomModelDialog>;
}
