
const ActionButtons = ({
  videoRef,
  isAudioFile
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
          if (videoRef.current && videoRef.current.src) {
            const link = document.createElement('a');
            link.href = videoRef.current.src;
            link.download = `video_${Date.now()}.mp4`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          }
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
