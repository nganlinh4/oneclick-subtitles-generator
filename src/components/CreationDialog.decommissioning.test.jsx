import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CreateSubtitlesModal from './CreateSubtitlesModal';

export const SPEECH_TAB_DECOMMISSIONED_SELECTORS = Object.freeze([
  // Legacy Transport Selectors
  '[data-testid="method-selector-old"]',
  '[data-testid="method-selector-new"]',
  '[data-testid="transport-selector-websocket"]',
  '[data-testid="transport-selector-rest"]',
  '#generation-audio-only',
  
  // Dual JS Window Scheduler & Delay Knobs
  '#segment-processing-delay-slider',
  '[data-testid="segment-processing-delay"]',
  
  // Slicing & Token Display Knobs
  '#max-duration-slider',
  '#auto-split-subtitles',
  '#max-words-slider',
  '.footer-token-info',
  '[data-testid="token-usage-counter"]',
  
  // Irrelevant Visual & Generative Prompt Knobs
  '#fps-slider',
  '[data-testid="media-resolution-dropdown"]',
  '#generation-prompt-preset',
  '#use-transcription-rules',
  '#use-outside-context',
  '#outside-context-range',
  'textarea[name="customPrompt"]',
  '#thinking-budget-slider',
]);

describe('CreationDialog: Decommissioning & Isolation Contract', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    videoFile: { assetId: 'test-media-1', name: 'lecture.mp4', duration: 180 },
    videoDuration: 180,
    initialTask: 'Speech',
  };

  it('renders the Speech task by default with clean task-first controls', () => {
    const { container } = render(<CreateSubtitlesModal {...defaultProps} />);

    // Assert task tabs exist
    expect(screen.getByRole('tab', { name: /speech/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /translate/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /visual/i })).toBeInTheDocument();

    // Assert primary speech controls exist
    expect(screen.getByLabelText(/engine/i)).toBeInTheDocument();
    expect(screen.getByText(/caption layout/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/identify speakers/i)).toBeInTheDocument();
    expect(
      screen.getByText(/audio from this video is used\. the video stays unchanged\./i)
    ).toBeInTheDocument();
  });

  it('strictly excludes all legacy transport, chunk, and scheduler controls from the Speech tab', () => {
    render(<CreateSubtitlesModal {...defaultProps} />);

    // Query on document.body because CreateSubtitlesModal renders in a Portal
    for (const selector of SPEECH_TAB_DECOMMISSIONED_SELECTORS) {
      const element = document.body.querySelector(selector);
      expect(
        element,
        `Decommissioned selector "${selector}" must NOT leak into the Speech tab`
      ).toBeNull();
    }
  });

  it('preserves visual controls only on the Visual / Custom tab', () => {
    render(<CreateSubtitlesModal {...defaultProps} initialTask="VisualCustom" />);

    // Visual tab should display FPS and resolution options
    expect(document.body.querySelector('#fps-slider')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="media-resolution-dropdown"]')).not.toBeNull();
  });

  it('preserves translation controls on the Translate tab', () => {
    render(<CreateSubtitlesModal {...defaultProps} initialTask="Translate" />);

    // Translate tab should display target language and translation notice
    expect(document.body.querySelector('#translate-target-language')).not.toBeNull();
    expect(
      screen.getByText(/translated cues link to source spans without fake word timestamps/i)
    ).toBeInTheDocument();
  });
});
