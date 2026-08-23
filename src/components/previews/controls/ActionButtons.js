
import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../../../platform/activeNativeMedia';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { exportMediaAsset } from '../../../platform/mediaExportService';
import { showErrorToast } from '../../../utils/toastUtils';

export const downloadPreviewMedia = async ({ videoSource, currentSource }) => {
  if (isDesktopRuntime()) {
    const candidate = videoSource ?? currentSource;
    let capability;
    try {
      capability = await resolveActiveNativeMedia({ candidate });
    } catch {
      throw new Error('Select the media again before exporting it.');
    }
    const exported = await exportMediaAsset(capability.assetId);
    await revalidateActiveNativeMedia(capability);
    return exported;
  }
  if (!currentSource) return null;
  const link = document.createElement('a');
  link.href = currentSource;
  link.download = `video_${Date.now()}.mp4`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  return { status: 'started' };
};

const ActionButtons = ({
  videoRef,
  isAudioFile,
  videoSource,
}) => {
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '30px',
          height: '30px',
          borderRadius: '15px',
          background: 'rgba(76, 175, 80, 0.2)',
          cursor: 'pointer',
          transition: 'all 0.2s ease'
        }}
        onClick={(e) => {
          e.stopPropagation();
          void downloadPreviewMedia({
            videoSource,
            currentSource: videoRef.current?.src,
          }).catch((error) => {
            console.error('Preview media export failed:', error);
            showErrorToast(error?.message || 'The media file could not be exported.', 8000);
          });
        }}
      >
        <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
          download
        </span>
      </div>

      {/* PiP button - only show for video files, not audio files */}
      {!isAudioFile && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '30px',
            height: '30px',
            borderRadius: '15px',
            background: 'rgba(255, 152, 0, 0.2)',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
          onClick={async (e) => {
            e.stopPropagation();
            if (videoRef.current) {
              try {
                if (document.pictureInPictureElement) {
                  await document.exitPictureInPicture();
                } else if (videoRef.current.requestPictureInPicture) {
                  await videoRef.current.requestPictureInPicture();
                }
              } catch (error) {
                console.error('Picture-in-Picture error:', error);
              }
            }
          }}
        >
          <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
            picture_in_picture_alt
          </span>
        </div>
      )}
    </>
  );
};

export default ActionButtons;
