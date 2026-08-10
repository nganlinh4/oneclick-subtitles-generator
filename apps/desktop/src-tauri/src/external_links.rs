use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt as _;

use crate::error::{CommandError, CommandResult};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExternalLink {
    AiStudioApiKeys,
    AiStudioUsage,
    CreatorEmail,
    CreatorGithub,
    CreatorScholar,
    CreatorYoutube,
    GeminiVideoDocumentation,
    GeniusApiClients,
    GoogleCloudCredentials,
    UdbmReleases,
    YoutubeApiOverview,
    YtDlpSupportedSites,
}

impl ExternalLink {
    const fn url(self) -> &'static str {
        match self {
            Self::AiStudioApiKeys => "https://aistudio.google.com/app/apikey",
            Self::AiStudioUsage => {
                "https://aistudio.google.com/usage?timeRange=last-1-day&tab=rate-limit"
            }
            Self::CreatorEmail => "mailto:nganlinh4@gmail.com",
            Self::CreatorGithub => "https://github.com/nganlinh4",
            Self::CreatorScholar => "https://scholar.google.com/citations?user=kWFVuFwAAAAJ&hl=en",
            Self::CreatorYoutube => "https://www.youtube.com/@tteokl",
            Self::GeminiVideoDocumentation => {
                "https://ai.google.dev/gemini-api/docs/video-understanding"
            }
            Self::GeniusApiClients => "https://genius.com/api-clients",
            Self::GoogleCloudCredentials => "https://console.cloud.google.com/apis/credentials",
            Self::UdbmReleases => "https://github.com/nganlinh4/udbm/releases",
            Self::YoutubeApiOverview => {
                "https://console.developers.google.com/apis/api/youtube.googleapis.com/overview"
            }
            Self::YtDlpSupportedSites => {
                "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md"
            }
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle as an owned command extractor"
)]
pub(crate) fn open_external_link(app: AppHandle, link: ExternalLink) -> CommandResult<()> {
    app.opener()
        .open_url(link.url(), None::<&str>)
        .map_err(|_| CommandError::external_link_failed())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::ExternalLink;

    #[test]
    fn every_target_is_fixed_unique_and_uses_an_expected_scheme() {
        let targets = [
            ExternalLink::AiStudioApiKeys,
            ExternalLink::AiStudioUsage,
            ExternalLink::CreatorEmail,
            ExternalLink::CreatorGithub,
            ExternalLink::CreatorScholar,
            ExternalLink::CreatorYoutube,
            ExternalLink::GeminiVideoDocumentation,
            ExternalLink::GeniusApiClients,
            ExternalLink::GoogleCloudCredentials,
            ExternalLink::UdbmReleases,
            ExternalLink::YoutubeApiOverview,
            ExternalLink::YtDlpSupportedSites,
        ];
        let urls = targets
            .into_iter()
            .map(ExternalLink::url)
            .collect::<BTreeSet<_>>();

        assert_eq!(urls.len(), targets.len());
        assert!(
            urls.iter()
                .all(|url| { url.starts_with("https://") || *url == "mailto:nganlinh4@gmail.com" })
        );
    }

    #[test]
    fn wire_values_are_closed_and_camel_case() {
        let parsed =
            serde_json::from_str::<ExternalLink>(r#""creatorGithub""#).expect("known link target");
        assert_eq!(parsed, ExternalLink::CreatorGithub);
        assert!(serde_json::from_str::<ExternalLink>(r#""https://attacker.invalid""#).is_err());
        assert!(serde_json::from_str::<ExternalLink>(r#""creator_github""#).is_err());
    }
}
