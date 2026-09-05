import { formatSecondsToTimecode } from '../timecode';

/** Parse explicit units only; invalid input must not silently move to frame zero. */
export const convertTimeStringToSeconds = (value) => {
  if (typeof value !== 'string') throw new Error('Subtitle timestamp must be a string.');
  const text = value.trim();
  const units = text.match(/^(\d+)m(\d{1,2})s(?:(\d{1,3})ms)?$/);
  if (units) {
    const [, minutes, seconds, millis = '0'] = units;
    if (Number(seconds) >= 60) throw new Error('Subtitle seconds are outside their minute.');
    const result = Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
    if (!Number.isFinite(result)) throw new Error('Subtitle timestamp is not finite.');
    return result;
  }
  const colon = text.match(/^(?:(\d+):)?(\d+):(\d{1,2})(?:[.,](\d{1,9}))?$/);
  if (colon) {
    const [, hours, minutes, seconds, fraction = '0'] = colon;
    if (Number(seconds) >= 60 || (hours !== undefined && Number(minutes) >= 60)) {
      throw new Error('Subtitle timestamp has an out-of-range component.');
    }
    const result = Number(hours ?? 0) * 3600 + Number(minutes) * 60
      + Number(seconds) + Number('0.' + fraction);
    if (!Number.isFinite(result)) throw new Error('Subtitle timestamp is not finite.');
    return result;
  }
  throw new Error('Subtitle timestamp has no supported explicit format.');
};

export const formatSecondsToSRTTime = (seconds) => formatSecondsToTimecode(seconds, ',');
