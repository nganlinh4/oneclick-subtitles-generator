import React from 'react';
import { Composition } from 'remotion';
import SubtitledVideoWrapper from './Composition';
import { Props, VideoMetadata, LyricEntry } from '../types';

// Sample data for preview mode
const sampleSubtitles: LyricEntry[] = [
  { start: 0, end: 2, text: "Welcome to" },
  { start: 2, end: 4, text: "Subtitle Video Maker" },
  { start: 4, end: 6, text: "Preview Mode" }
];

const defaultMetadata: VideoMetadata = {
  videoType: 'Subtitled Video',
  resolution: '1080p',
  frameRate: 60,
  originalAudioVolume: 100,
  narrationVolume: 100
};

// Create a type-safe wrapper component
const VideoComponentWrapper: React.FC<Record<string, unknown>> = (props) => {
  // Ensure all required props are present with defaults
  const safeProps: Props = {
    audioUrl: (props.audioUrl as string) || '',
    lyrics: (props.lyrics as LyricEntry[]) || sampleSubtitles,
    metadata: (props.metadata as VideoMetadata) || defaultMetadata,
    narrationUrl: props.narrationUrl as string | undefined,
    isVideoFile: (props.isVideoFile as boolean) || false,
    framesPathUrl: (props.framesPathUrl as string) || undefined,
    extractedAudioUrl: (props.extractedAudioUrl as string) || undefined,
  };

  return <SubtitledVideoWrapper {...safeProps} />;
};

export const RemotionRoot: React.FC = () => {
  // Create a flexible composition that can handle any aspect ratio
  // The server will override dimensions, fps, and duration based on the actual video
  const commonProps = {
    component: VideoComponentWrapper,
    fps: 60, // Default, will be overridden by server
    width: 1920, // Default, will be overridden by server based on video aspect ratio
    height: 1080, // Default, will be overridden by server based on video aspect ratio
    durationInFrames: 180 // Default, will be overridden by server based on audio/video duration
  };

  return (
    <>
      <Composition
        id="subtitled-video"
        {...commonProps}
        defaultProps={{
          audioUrl: '',
          lyrics: sampleSubtitles,
          metadata: { ...defaultMetadata, videoType: 'Subtitled Video' }
        }}
      />
    </>
  );
};