import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import YoutubeUrlInput from './inputs/YoutubeUrlInput';
import YoutubeSearchInput from './inputs/YoutubeSearchInput';
import FileUploadInput from './inputs/FileUploadInput';
import UnifiedUrlInput from './inputs/UnifiedUrlInput';
import { initTabPillAnimation } from '../utils/tabPillAnimation';
import '../styles/InputMethods.css';
import '../styles/components/tab-content-animations.css';

const InputMethods = ({ onVideoSelect, apiKeysSet, selectedVideo, setSelectedVideo, uploadedFile, setUploadedFile, activeTab, setActiveTab, isSrtOnlyMode, setIsSrtOnlyMode, setStatus, subtitlesData, setVideoSegments, setSegmentsStatus, enableYoutubeSearch = true }) => {
  const { t } = useTranslation();
  const tabsRef = useRef(null);
  const containerRef = useRef(null);
  const contentRef = useRef(null);
  const [previousTab, setPreviousTab] = useState(null);
  const [animationDirection, setAnimationDirection] = useState('center');

  // Handle case where YouTube search is disabled but active tab is youtube-search
  useEffect(() => {
    if (!enableYoutubeSearch && activeTab === 'youtube-search') {
      setActiveTab('unified-url');
    }
  }, [enableYoutubeSearch, activeTab, setActiveTab]);

  // Initialize pill position and container height on component mount
  useEffect(() => {
    if (tabsRef.current) {
      // Small delay to ensure the DOM is fully rendered
      setTimeout(() => {
        initTabPillAnimation('.input-tabs');

        // Set initial height with extra 100px to ensure enough space
        if (containerRef.current && contentRef.current) {
          const contentHeight = contentRef.current.offsetHeight;
          containerRef.current.style.height = `${contentHeight + 100}px`;
        }
      }, 50);
    }
  }, []);

  // Update pill position when active tab changes
  useEffect(() => {
    if (tabsRef.current) {
      // Reset wasActive and lastActive attributes on all tabs when active tab changes programmatically
      const tabButtons = tabsRef.current.querySelectorAll('.tab-btn');
      tabButtons.forEach(tab => {
        tab.dataset.wasActive = 'false';
        tab.dataset.lastActive = 'false';
      });

      // Determine animation direction based on tab order
      if (previousTab) {
        const tabOrder = enableYoutubeSearch
          ? ['unified-url', 'youtube-search', 'file-upload']
          : ['unified-url', 'file-upload'];
        const prevIndex = tabOrder.indexOf(previousTab);
        const currentIndex = tabOrder.indexOf(activeTab);

        if (prevIndex !== -1 && currentIndex !== -1) {
          if (prevIndex < currentIndex) {
            setAnimationDirection('left');
          } else if (prevIndex > currentIndex) {
            setAnimationDirection('right');
          } else {
            setAnimationDirection('center');
          }
        } else {
          setAnimationDirection('center');
        }
      }

      // Update previous tab for next change
      setPreviousTab(activeTab);

      // Small delay to ensure the active class is applied
      setTimeout(() => {
        initTabPillAnimation('.input-tabs');
      }, 10);
    }
  }, [activeTab, previousTab, enableYoutubeSearch]);

  // Handle height animation when content changes
  useEffect(() => {
    // Use a small delay to ensure the new content is rendered
    const animationTimeout = setTimeout(() => {
      if (containerRef.current && contentRef.current) {
        // Get the height of the content and add 100px for extra space
        const contentHeight = contentRef.current.offsetHeight;

        // Set the container height to match the content height plus extra space
        containerRef.current.style.height = `${contentHeight + 100}px`;
      }
    }, 50); // Small delay to ensure content is rendered

    return () => clearTimeout(animationTimeout);
  }, [activeTab, uploadedFile]);

  const renderInputMethod = () => {
    // Determine the animation class based on direction
    const animationClass = `tab-content-slide-${animationDirection}`;

    switch (activeTab) {
      case 'unified-url':
        return (
          <div key={`tab-${activeTab}`} className={`tab-content ${animationClass}`}>
            <UnifiedUrlInput
              selectedVideo={selectedVideo}
              setSelectedVideo={setSelectedVideo}
            />
          </div>
        );
      case 'youtube-search':
        return (
          <div key={`tab-${activeTab}`} className={`tab-content ${animationClass}`}>
            <YoutubeSearchInput
              apiKeysSet={apiKeysSet}
              selectedVideo={selectedVideo}
              setSelectedVideo={setSelectedVideo}
            />
          </div>
        );
      case 'file-upload':
        return (
          <div key={`tab-${activeTab}`} className={`tab-content ${animationClass}`}>
            <FileUploadInput
              onVideoSelect={onVideoSelect}
              uploadedFile={uploadedFile}
              setUploadedFile={setUploadedFile}
              isSrtOnlyMode={isSrtOnlyMode}
              setIsSrtOnlyMode={setIsSrtOnlyMode}
              setStatus={setStatus}
              subtitlesData={subtitlesData}
              setVideoSegments={setVideoSegments}
              setSegmentsStatus={setSegmentsStatus}
            />
          </div>
        );
      // For backward compatibility, redirect old tabs to the unified URL input
      case 'all-sites-url':
      case 'douyin-url':
        // Redirect to unified URL input
        setTimeout(() => setActiveTab('unified-url'), 0);
        return (
          <div key={`tab-${activeTab}`} className={`tab-content ${animationClass}`}>
            <UnifiedUrlInput
              selectedVideo={selectedVideo}
              setSelectedVideo={setSelectedVideo}
            />
          </div>
        );
      case 'youtube-url':
        return (
          <div key={`tab-${activeTab}`} className={`tab-content ${animationClass}`}>
            <YoutubeUrlInput
              onVideoSelect={onVideoSelect}
              selectedVideo={selectedVideo}
              setSelectedVideo={setSelectedVideo}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="input-methods-container" ref={containerRef}>
      <div className="input-header">
        <h2 className="input-title">
          {t('inputMethods.title', 'Select Video Source')}
        </h2>

        <div className="input-tabs" ref={tabsRef}>
          <button
            className={`tab-btn ${activeTab === 'unified-url' ? 'active' : ''}`}
            onClick={() => setActiveTab('unified-url')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'inline-block' }}>globe_asia</span>
            {t('inputMethods.unifiedUrl', 'Video URL')}
          </button>

          {enableYoutubeSearch && (
          <button
            className={`tab-btn ${activeTab === 'youtube-search' ? 'active' : ''}`}
            onClick={() => setActiveTab('youtube-search')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'inline-block' }}>search</span>
            {t('inputMethods.youtubeSearch', 'Search YouTube')}
          </button>
          )}

          <button
            className={`tab-btn ${activeTab === 'file-upload' ? 'active' : ''}`}
            onClick={() => setActiveTab('file-upload')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18, display: 'inline-block' }}>file_upload</span>
            {t('inputMethods.fileUpload', 'Upload File')}
          </button>
        </div>
      </div>

      <div className="tab-content-wrapper" ref={contentRef}>
        {renderInputMethod()}
      </div>
    </div>
  );
};

export default InputMethods;