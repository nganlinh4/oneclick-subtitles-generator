import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate, Audio, useVideoConfig } from 'remotion';
import SubtitledVideoContent from '../components/SubtitledVideo';
import { LyricEntry, VideoMetadata } from '../types';

interface Props {
  audioUrl: string;
  lyrics: LyricEntry[];
  metadata?: VideoMetadata; // Make metadata optional again to match what might come from the server
  narrationUrl?: string;
  isVideoFile?: boolean;
  framesPathUrl?: string; // When provided, use server-extracted frames instead of raw video
  extractedAudioUrl?: string; // When frames are used, play this audio
}

// Default metadata to use if none is provided
const DEFAULT_METADATA: VideoMetadata = {
  videoType: 'Subtitled Video',
  resolution: '1080p',
  frameRate: 30,
  originalAudioVolume: 100,
  narrationVolume: 100
};

const SubtitledVideoWrapper: React.FC<Props> = ({
  audioUrl,
  lyrics,
  metadata = DEFAULT_METADATA,
  narrationUrl,
  isVideoFile = false,
  framesPathUrl,
  extractedAudioUrl,
}) => {
  return (
    <SubtitledVideoContent
      audioUrl={audioUrl}
      lyrics={lyrics}
      metadata={metadata}
      narrationUrl={narrationUrl}
      isVideoFile={isVideoFile}
      framesPathUrl={framesPathUrl}
      extractedAudioUrl={extractedAudioUrl}
    />
  );
};

export default SubtitledVideoWrapper;
