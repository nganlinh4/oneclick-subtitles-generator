import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import VideoAnalysisModal from './VideoAnalysisModal';

// Mock react-i18next
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      // The component appends the countdown number and "seconds" separately now.
      // So, the keys here should just return the main message part.
      if (key === 'videoAnalysis.autoSelectDefaultCountdown') {
        return 'Default countdown message';
      }
      if (key === 'videoAnalysis.autoSelectRecommendedCountdown') {
        return 'Recommended countdown message';
      }
      if (key === 'videoAnalysis.seconds') {
        return 'seconds'; // Ensure "seconds" is also translated for full message construction
      }
      // Fallback for other keys used in the component (e.g., button labels)
      if (key === 'videoAnalysis.useDefaultPreset') return 'Use My Default Preset';
      if (key === 'videoAnalysis.useRecommended') return 'Use Recommended';
      if (key === 'videoAnalysis.title') return 'Video Analysis Results'; // For userInteraction test
      return key; // Return the key itself if no specific mock is defined
    },
  }),
}));

// Mock PROMPT_PRESETS used in getPresetTitle
jest.mock('../services/geminiService', () => ({
  PROMPT_PRESETS: [
    { id: 'general', title: 'General purpose' },
    { id: 'recommended-preset-id', title: 'Recommended Preset Title' },
  ],
}));

describe('VideoAnalysisModal Component', () => {
  const mockOnClose = jest.fn();
  const mockOnUsePreset = jest.fn();
  const mockOnUseDefaultPreset = jest.fn();
  const mockOnEditRules = jest.fn();

  const analysisResultMock = {
    recommendedPreset: {
      id: 'recommended-preset-id',
      reason: 'This is a recommended preset.',
    },
    transcriptionRules: {
      additionalNotes: ['Test note 1'],
    },
  };

  const defaultProps = {
    isOpen: true,
    onClose: mockOnClose,
    analysisResult: analysisResultMock,
    onUsePreset: mockOnUsePreset,
    onUseDefaultPreset: mockOnUseDefaultPreset,
    onEditRules: mockOnEditRules,
  };

  let mockLocalStorageGetItem;

  beforeEach(() => {
    jest.useFakeTimers();
    mockOnClose.mockClear();
    mockOnUsePreset.mockClear();
    mockOnUseDefaultPreset.mockClear();
    mockOnEditRules.mockClear();

    // Mock localStorage.getItem
    mockLocalStorageGetItem = jest.spyOn(Storage.prototype, 'getItem');
    // Default mock for video_analysis_timeout for the countdown
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'video_analysis_timeout') {
        return '20'; // Default 20 seconds for countdown
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock); // Provide stored result if component tries to read it
      }
      return null;
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    mockLocalStorageGetItem.mockRestore();
  });

  test('should call onUseDefaultPreset when timer expires and autoSelectDefaultPreset is true in localStorage', () => {
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'auto_select_default_preset') {
        return 'true';
      }
      if (key === 'video_analysis_timeout') {
        return '20';
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      return null;
    });

    render(<VideoAnalysisModal {...defaultProps} />);
    
    act(() => {
      jest.advanceTimersByTime(20000); // Advance by 20 seconds
    });

    expect(mockOnUseDefaultPreset).toHaveBeenCalledTimes(1);
    expect(mockOnUsePreset).not.toHaveBeenCalled();
  });

  test('should call onUsePreset with recommended preset when timer expires and autoSelectDefaultPreset is false in localStorage', () => {
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'auto_select_default_preset') {
        return 'false';
      }
      if (key === 'video_analysis_timeout') {
        return '20';
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      return null;
    });

    render(<VideoAnalysisModal {...defaultProps} />);

    act(() => {
      jest.advanceTimersByTime(20000);
    });

    expect(mockOnUsePreset).toHaveBeenCalledTimes(1);
    expect(mockOnUsePreset).toHaveBeenCalledWith(analysisResultMock.recommendedPreset.id);
    expect(mockOnUseDefaultPreset).not.toHaveBeenCalled();
  });

  test('should call onUsePreset with recommended preset when timer expires and autoSelectDefaultPreset is not in localStorage', () => {
    // localStorage.getItem will return null by default for 'auto_select_default_preset' due to the mock setup in beforeEach
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'video_analysis_timeout') {
        return '20';
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      // 'auto_select_default_preset' will return undefined, which simulates it not being in localStorage
      return null;
    });
    
    render(<VideoAnalysisModal {...defaultProps} />);

    act(() => {
      jest.advanceTimersByTime(20000);
    });

    expect(mockOnUsePreset).toHaveBeenCalledTimes(1);
    expect(mockOnUsePreset).toHaveBeenCalledWith(analysisResultMock.recommendedPreset.id);
    expect(mockOnUseDefaultPreset).not.toHaveBeenCalled();
  });

  test('should display countdown timer if timeout is set', () => {
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'video_analysis_timeout') {
        return '10'; // Set a 10-second timeout for this test
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      return null;
    });

    render(<VideoAnalysisModal {...defaultProps} />);
    expect(screen.getByText(/Recommended countdown message 10 seconds/i)).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(1000); // Advance 1 second
    });
    expect(screen.getByText(/Recommended countdown message 9 seconds/i)).toBeInTheDocument();
  });

  test('should display "Default countdown message" when autoSelectDefaultPreset is true', () => {
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'auto_select_default_preset') {
        return 'true';
      }
      if (key === 'video_analysis_timeout') {
        return '15'; // Use a different timeout for this test
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      return null;
    });

    render(<VideoAnalysisModal {...defaultProps} />);
    expect(screen.getByText(/Default countdown message 15 seconds/i)).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(1000); // Advance 1 second
    });
    expect(screen.getByText(/Default countdown message 14 seconds/i)).toBeInTheDocument();
  });

  test('should not start countdown if timeout setting is "none"', () => {
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'video_analysis_timeout') {
        return 'none';
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      return null;
    });
    render(<VideoAnalysisModal {...defaultProps} />);
    expect(screen.queryByText(/Auto-selecting recommended preset in/i)).not.toBeInTheDocument();
  });

  test('should clear timers and stop countdown on user interaction', () => {
    mockLocalStorageGetItem.mockImplementation((key) => {
      if (key === 'video_analysis_timeout') {
        return '20';
      }
      if (key === 'video_analysis_result') {
        return JSON.stringify(analysisResultMock);
      }
      return null;
    });
    render(<VideoAnalysisModal {...defaultProps} />);
    // Message will be "Recommended" by default if auto_select_default_preset is not 'true'
    expect(screen.getByText(/Recommended countdown message 20 seconds/i)).toBeInTheDocument();

    // Simulate user clicking the modal overlay (which calls handleUserInteraction)
    const modal = screen.getByRole('dialog');
    fireEvent.click(modal);


    expect(screen.queryByText(/Recommended countdown message/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Default countdown message/i)).not.toBeInTheDocument();

    // Advance timers to see if the original timeout still fires
    act(() => {
      jest.advanceTimersByTime(20000);
    });
    expect(mockOnUseDefaultPreset).not.toHaveBeenCalled();
    expect(mockOnUsePreset).not.toHaveBeenCalled();
  });

  describe('Button Rendering and Styling', () => {
    test('should render "Use My Default Preset" as primary when autoSelectDefaultPreset is true', () => {
      mockLocalStorageGetItem.mockImplementation((key) => {
        if (key === 'auto_select_default_preset') return 'true';
        if (key === 'video_analysis_timeout') return '20'; // Needs a timeout to show buttons
        if (key === 'video_analysis_result') return JSON.stringify(analysisResultMock);
        return null;
      });

      render(<VideoAnalysisModal {...defaultProps} />);

      const useDefaultButton = screen.getByText('Use My Default Preset');
      const useRecommendedButton = screen.getByText('Use Recommended');

      // Check classes
      expect(useDefaultButton).toHaveClass('use-recommended-button'); // Primary style
      expect(useRecommendedButton).toHaveClass('use-default-button'); // Secondary style

      // Check order (right-most is primary)
      const buttons = screen.getAllByRole('button');
      expect(buttons.indexOf(useRecommendedButton)).toBeLessThan(buttons.indexOf(useDefaultButton));
    });

    test('should render "Use Recommended" as primary when autoSelectDefaultPreset is false', () => {
      mockLocalStorageGetItem.mockImplementation((key) => {
        if (key === 'auto_select_default_preset') return 'false';
        if (key === 'video_analysis_timeout') return '20';
        if (key === 'video_analysis_result') return JSON.stringify(analysisResultMock);
        return null;
      });

      render(<VideoAnalysisModal {...defaultProps} />);

      const useDefaultButton = screen.getByText('Use My Default Preset');
      const useRecommendedButton = screen.getByText('Use Recommended');

      // Check classes
      expect(useRecommendedButton).toHaveClass('use-recommended-button'); // Primary style
      expect(useDefaultButton).toHaveClass('use-default-button'); // Secondary style
      
      // Check order (right-most is primary)
      const buttons = screen.getAllByRole('button');
      expect(buttons.indexOf(useDefaultButton)).toBeLessThan(buttons.indexOf(useRecommendedButton));
    });

    test('should render "Use Recommended" as primary when autoSelectDefaultPreset is not set', () => {
      // Default mockLocalStorageGetItem already handles this (returns null for auto_select_default_preset)
       mockLocalStorageGetItem.mockImplementation((key) => {
        if (key === 'video_analysis_timeout') return '20';
        if (key === 'video_analysis_result') return JSON.stringify(analysisResultMock);
        // auto_select_default_preset will be null
        return null;
      });
      render(<VideoAnalysisModal {...defaultProps} />);

      const useDefaultButton = screen.getByText('Use My Default Preset');
      const useRecommendedButton = screen.getByText('Use Recommended');

      // Check classes
      expect(useRecommendedButton).toHaveClass('use-recommended-button'); // Primary style
      expect(useDefaultButton).toHaveClass('use-default-button'); // Secondary style

      // Check order
      const buttons = screen.getAllByRole('button');
      expect(buttons.indexOf(useDefaultButton)).toBeLessThan(buttons.indexOf(useRecommendedButton));
    });
  });
});
