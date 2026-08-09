use osg_domain::{MediaAsset, SubtitleTrack};
use serde::Serialize;

use crate::ImportedMedia;

#[derive(Debug, Default)]
pub struct Session {
    media: Option<ImportedMedia>,
    subtitle_track: Option<SubtitleTrack>,
}

impl Session {
    pub fn set_media(&mut self, media: ImportedMedia) {
        self.media = Some(media);
    }

    pub fn set_subtitle_track(&mut self, track: SubtitleTrack) {
        self.subtitle_track = Some(track);
    }

    #[must_use]
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            media: self.media.as_ref().map(|media| media.asset().clone()),
            subtitle_track: self.subtitle_track.clone(),
        }
    }

    #[must_use]
    pub fn media_path(&self) -> Option<&std::path::Path> {
        self.media.as_ref().map(ImportedMedia::canonical_path)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub media: Option<MediaAsset>,
    pub subtitle_track: Option<SubtitleTrack>,
}

#[cfg(test)]
mod tests {
    use osg_domain::{SubtitleCue, SubtitleTrack, TrackOrigin};

    use super::Session;

    #[test]
    fn snapshot_is_an_owned_view_of_canonical_state() {
        let mut session = Session::default();
        session.set_subtitle_track(
            SubtitleTrack::new(
                "English".to_owned(),
                TrackOrigin::Srt,
                vec![SubtitleCue::new(0, 1_000, "Hello".to_owned()).expect("valid cue")],
            )
            .expect("valid track"),
        );

        let snapshot = session.snapshot();
        assert_eq!(
            snapshot.subtitle_track.expect("track").cues[0].text,
            "Hello"
        );
    }
}
