import { useTranslation } from 'react-i18next';
import CloseButton from '../common/CloseButton';
import { formatTime as formatDuration } from '../../utils/timeFormatter';
import { getAspectRatio, heightToQuality, formatBytes } from './queueHelpers';

const PreviewModal = ({
  previewUrl,
  previewItem,
  previewInfo,
  previewClientInfo,
  previewExtra,
  previewDuration,
  setPreviewDuration,
  setPreviewClientInfo,
  onClose
}) => {
  const { t } = useTranslation();

  return (
    <div className="preview-modal-overlay" onClick={onClose}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-modal-header">
          <div className="preview-title" style={{ gap: '1rem', padding: '0 16px' }}>
            <span className="material-symbols-rounded" style={{ fontSize: '48px' }}>live_tv</span>
            <span>{t('videoRendering.preview', 'Preview')}</span>
            {/* Video info badges (always render container; fill when data available) */}
            <div className="preview-badges">
              {(() => {
                const info = previewInfo || previewClientInfo;

                const videoBasics = [];
                const videoCodecs = [];
                const audioBadges = [];
                const fileBadges = [];

                // VIDEO BASICS (order: res, fps, duration, quality)
                if (info?.width && info?.height) {
                  videoBasics.push(
                    <span key="res" className="preview-badge video" title={t('videoRendering.resolutionLabel','Resolution')}>
                      {info.width}×{info.height}
                      {getAspectRatio(info.width, info.height) ? ` (${getAspectRatio(info.width, info.height)})` : ''}
                    </span>
                  );
                }
                if (info?.fps) {
                  videoBasics.push(
                    <span key="fps" className="preview-badge video" title={t('videoRendering.frameRateLabel','Frame rate')}>{info.fps} fps</span>
                  );
                }
                if (typeof previewDuration === 'number' && !isNaN(previewDuration)) {
                  videoBasics.push(
                    <span key="dur" className="preview-badge video" title={t('videoRendering.durationLabel','Duration')}>{formatDuration(previewDuration, 'hms')}</span>
                  );
                }
                if (info?.quality || (info?.height && !info?.quality)) {
                  videoBasics.push(
                    <span key="quality" className="preview-badge video" title={t('videoRendering.qualityLabel','Quality')}>{info.quality || heightToQuality(info.height)}</span>
                  );
                }

                // FILE (then)
                if (previewExtra?.size) {
                  fileBadges.push(
                    <span key="size" className="preview-badge file" title={t('videoRendering.fileSizeLabel','File size')}>{formatBytes(previewExtra.size)}</span>
                  );
                }
                if (previewExtra?.createdAt) {
                  const d = new Date(previewExtra.createdAt);
                  if (!isNaN(d.getTime())) {
                    fileBadges.push(
                      <span key="created" className="preview-badge file" title={t('videoRendering.createdAtLabel','Created at')}>{d.toLocaleString()}</span>
                    );
                  }
                }

                // VIDEO CODECS
                if (info?.codec) {
                  videoCodecs.push(
                    <span key="vcodec" className="preview-badge video" title={t('videoRendering.videoCodecLabel','Video codec')}>{info.codec}</span>
                  );
                }
                if (info?.bit_rate) {
                  videoCodecs.push(
                    <span key="vbitrate" className="preview-badge video" title={t('videoRendering.videoBitrateLabel','Video bitrate')}>{Math.round(info.bit_rate / 1000)} kbps</span>
                  );
                } else if (previewExtra?.size && typeof previewDuration === 'number' && previewDuration > 0) {
                  const kbps = Math.round((previewExtra.size * 8) / previewDuration / 1000);
                  videoCodecs.push(
                    <span key="est-bitrate" className="preview-badge video" title={t('videoRendering.estimatedBitrateLabel','Estimated bitrate')}>{kbps} kbps</span>
                  );
                }

                // AUDIO
                if (info?.audio_codec) {
                  audioBadges.push(
                    <span key="acodec" className="preview-badge audio" title={t('videoRendering.audioCodecLabel','Audio codec')}>{info.audio_codec}</span>
                  );
                }
                if (Number.isFinite(info?.audio_channels)) {
                  audioBadges.push(
                    <span key="achannels" className="preview-badge audio" title={t('videoRendering.audioChannelsLabel','Audio channels')}>{info.audio_channels} ch{info.audio_channel_layout ? ` (${info.audio_channel_layout})` : ''}</span>
                  );
                }
                if (Number.isFinite(info?.audio_sample_rate)) {
                  const khz = Math.round((info.audio_sample_rate / 1000) * 10) / 10;
                  audioBadges.push(
                    <span key="asamplerate" className="preview-badge audio" title={t('videoRendering.audioSampleRateLabel','Audio sample rate')}>{khz} kHz</span>
                  );
                }
                if (Number.isFinite(info?.audio_bit_rate)) {
                  audioBadges.push(
                    <span key="abitrate" className="preview-badge audio" title={t('videoRendering.audioBitrateLabel','Audio bitrate')}>{Math.round(info.audio_bit_rate / 1000)} kbps</span>
                  );
                }

                // FILE container (last)
                if (previewUrl) {
                  const extMatch = previewUrl.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
                  if (extMatch && extMatch[1]) {
                    fileBadges.push(
                      <span key="container" className="preview-badge file" title={t('videoRendering.containerLabel','Container')}>{extMatch[1].toUpperCase()}</span>
                    );
                  }
                }

                const ordered = [];
                if (videoBasics.length) ordered.push(...videoBasics);
                if (videoCodecs.length) {
                  if (ordered.length) ordered.push(<span key="sep-vcodec" className="preview-sep" />);
                  ordered.push(...videoCodecs);
                }
                if (audioBadges.length) {
                  if (ordered.length) ordered.push(<span key="sep-audio" className="preview-sep" />);
                  ordered.push(...audioBadges);
                }
                if (fileBadges.length) {
                  if (ordered.length) ordered.push(<span key="sep-file" className="preview-sep" />);
                  ordered.push(...fileBadges);
                }
                return ordered;
              })()}
            </div>
          </div>
          <CloseButton
            onClick={onClose}
            variant="modal"
            size="medium"
            className="preview-close-btn"
          />
        </div>
        <div className="preview-modal-content">
          <video
            src={previewUrl}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setPreviewDuration(v.duration || null);
              const vw = v.videoWidth || null;
              const vh = v.videoHeight || null;
              const fps = (previewItem && previewItem.settings && previewItem.settings.frameRate) ? previewItem.settings.frameRate : undefined;
              if (vw && vh) {
                setPreviewClientInfo({ width: vw, height: vh, fps });
              }
            }}
            controls
            style={{ width: '100%', height: 'auto', borderRadius: 24, maxHeight: '75vh' }}
          />
        </div>
      </div>
    </div>
  );
};

export default PreviewModal;
