import React, { useEffect } from 'react';
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
  frameRate: 30,
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
  };

  return <SubtitledVideoWrapper {...safeProps} />;
};

export const RemotionRoot: React.FC = () => {
  // Add low-cost preconnects for Google Fonts to reduce initial font fetch latency
  // This helps the component-level font-loading guard to complete faster.
  useEffect(() => {
    try {
      const addLink = (rel: string, href: string, crossOrigin?: string) => {
        if (document.querySelector(`link[rel="${rel}"][href="${href}"]`)) return;
        const l = document.createElement('link');
        l.rel = rel;
        l.href = href;
        if (crossOrigin) l.crossOrigin = crossOrigin;
        document.head.appendChild(l);
      };
      addLink('preconnect', 'https://fonts.googleapis.com');
      addLink('preconnect', 'https://fonts.gstatic.com', 'anonymous');
      addLink('dns-prefetch', 'https://fonts.googleapis.com');
      addLink('dns-prefetch', 'https://fonts.gstatic.com');
      // small, non-blocking attempt to warm the font provider (no await)
      const img = document.createElement('img');
      img.src = 'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iQ.woff2';
      img.style.display = 'none';
      img.onload = () => { try { img.remove(); } catch (e) {} };
      document.body.appendChild(img);
    } catch (e) {
      // non-fatal if DOM modifications fail
      // eslint-disable-next-line no-console
      console.warn('Failed to add preconnect links for fonts', e);
    }
  }, []);

  // Create a flexible composition that can handle any aspect ratio
  // The server will override dimensions, fps, and duration based on the actual video
  const commonProps = {
    component: VideoComponentWrapper,
    fps: 30, // Default, will be overridden by server
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