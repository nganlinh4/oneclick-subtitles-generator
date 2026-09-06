import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptionGroupingToolbar } from './CaptionGroupingToolbar';
import { REGROUPING_POLICIES } from '../../platform/localCaptionRegrouping';

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue, options) => {
      if (typeof defaultValue === 'string' && options) {
        return defaultValue.replace(/\{\{(\w+)\}\}/g, (_, k) => options[k]);
      }
      return defaultValue;
    },
  }),
}));

describe('CaptionGroupingToolbar', () => {
  it('renders all 4 regrouping policies', () => {
    render(<CaptionGroupingToolbar activePolicy="Natural" cueCount={20} />);
    expect(screen.getByTestId('policy-natural')).toBeInTheDocument();
    expect(screen.getByTestId('policy-short')).toBeInTheDocument();
    expect(screen.getByTestId('policy-one-word')).toBeInTheDocument();
    expect(screen.getByTestId('policy-custom')).toBeInTheDocument();
    expect(screen.getByTestId('grouping-cue-count')).toHaveTextContent('20 cues');
  });

  it('selects policy on click', () => {
    const onPolicyChange = vi.fn();
    render(<CaptionGroupingToolbar activePolicy="Natural" onPolicyChange={onPolicyChange} />);

    fireEvent.click(screen.getByTestId('policy-short'));
    expect(onPolicyChange).toHaveBeenCalledWith(REGROUPING_POLICIES.SHORT, expect.any(Object));
  });

  it('toggles custom sliders drawer on adjust click', () => {
    render(<CaptionGroupingToolbar activePolicy="Natural" />);
    expect(screen.queryByTestId('custom-sliders-drawer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-adjust-drawer'));
    expect(screen.getByTestId('custom-sliders-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('slider-max-words')).toBeInTheDocument();
    expect(screen.getByTestId('slider-max-duration')).toBeInTheDocument();
    expect(screen.getByTestId('slider-pause-threshold')).toBeInTheDocument();
  });

  it('toggles preserve manual edits checkbox', () => {
    const onPreserveEditsChange = vi.fn();
    render(
      <CaptionGroupingToolbar
        activePolicy="Natural"
        preserveEdits={true}
        preservedCount={3}
        onPreserveEditsChange={onPreserveEditsChange}
      />
    );

    const checkbox = screen.getByTestId('preserve-edits-checkbox');
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/Preserve manual edits/)).toHaveTextContent('(3)');

    fireEvent.click(checkbox);
    expect(onPreserveEditsChange).toHaveBeenCalledWith(false);
  });
});
