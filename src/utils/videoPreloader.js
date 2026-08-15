import { downloadNativeVideo } from '../platform/nativeUrlDownloadAdapter';
import { getDownloadCookieSource } from '../platform/downloadCookiePreference';

export const preloadYouTubeVideo = (videoUrl) => {


    if (!videoUrl || (!videoUrl.includes('youtube.com') && !videoUrl.includes('youtu.be'))) {
        return;
    }

    // Store the URL in localStorage for the VideoPreview component
    localStorage.setItem('current_video_url', videoUrl);

    downloadNativeVideo({ url: videoUrl, cookieSource: getDownloadCookieSource() })
        .catch((error) => console.warn('Failed to start background download:', error));
};
