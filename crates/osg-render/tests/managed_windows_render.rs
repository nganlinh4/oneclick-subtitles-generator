#![cfg(windows)]
#![recursion_limit = "256"]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, OperationProgress as PackageProgress,
    RemovalOutcome as PackageRemovalOutcome, RenderPackageId, RenderPackageManager,
    RenderRuntimeCoordinator,
};
use osg_native_tools::{
    CancellationToken as ToolCancellationToken, ExecutableRole, NativeToolId, NativeToolManager,
    OperationProgress as ToolProgress, RemovalOutcome as ToolRemovalOutcome,
    RuntimeCoordinator as ToolRuntimeCoordinator,
};
use osg_render::{
    NativeRenderInputs, PreparedRender, RenderEngine, RenderPhase, RenderProgress,
    RenderProgressSink, RenderRequest, RenderRunControl, RenderRuntime,
};
use serde_json::json;

#[derive(Debug, Default)]
struct IdleCoordinator;

impl RenderRuntimeCoordinator for IdleCoordinator {
    fn quiesce(&self, _: RenderPackageId) -> osg_engine_packages::Result<()> {
        Ok(())
    }
}

impl ToolRuntimeCoordinator for IdleCoordinator {
    fn quiesce(&self, _: NativeToolId) -> osg_native_tools::Result<()> {
        Ok(())
    }
}

fn render_request() -> RenderRequest {
    serde_json::from_value(json!({
        "sourceAssetId": uuid::Uuid::now_v7(),
        "projectId": uuid::Uuid::now_v7(),
        "narrationArtifactId": null,
        "lyrics": [{"id":"cue-1","startUs":0,"endUs":1_000_000,"text":"OSG render smoke"}],
        "settings": {
            "resolution":"360p","frameRate":24,"originalAudioVolume":100,
            "narrationVolume":80,"trimStartUs":0,"trimEndUs":1_000_000
        },
        "customization": {
            "fontSize":28,"fontFamily":"Google Sans Flex","fontWeight":600,
            "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,
            "letterSpacing":0,"textTransform":"none","backgroundColor":"#000000",
            "backgroundOpacity":50,"borderRadius":4,"borderWidth":0,
            "borderColor":"#ffffff","borderStyle":"none","textShadowEnabled":true,
            "textShadowColor":"#000000","textShadowBlur":4,"textShadowOffsetX":0,
            "textShadowOffsetY":2,"glowEnabled":false,"glowColor":"#ffffff",
            "glowIntensity":10,"gradientEnabled":false,"gradientType":"linear",
            "gradientDirection":"45deg","gradientColorStart":"#ffffff",
            "gradientColorEnd":"#cccccc","gradientColorMid":"#eeeeee",
            "strokeEnabled":false,"strokeWidth":0,"strokeColor":"#000000",
            "multiShadowEnabled":false,"shadowLayers":1,"pulseEnabled":false,
            "pulseSpeed":1,"shakeEnabled":false,"shakeIntensity":2,"position":"bottom",
            "customPositionX":50,"customPositionY":80,"marginBottom":40,"marginTop":40,
            "marginLeft":0,"marginRight":0,"maxWidth":80,"fadeInDuration":0.1,
            "fadeOutDuration":0.1,"animationType":"fade","animationEasing":"ease",
            "wordWrap":true,"maxLines":3,"lineBreakBehavior":"auto",
            "rtlSupport":false,"preset":"default"
        },
        "crop": {"x":0,"y":0,"width":100,"height":100,"aspectRatio":null}
    }))
    .expect("bounded render request")
}

fn generate_source(ffmpeg: &Path, path: &Path) {
    let status = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x18171c:s=640x360:r=24:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=2",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-y",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("managed FFmpeg starts");
    assert!(status.success(), "managed FFmpeg creates the smoke fixture");
}

fn smoke_root() -> (Option<tempfile::TempDir>, PathBuf) {
    if let Some(configured) = std::env::var_os("OSG_REAL_RENDER_SMOKE_ROOT") {
        let root = PathBuf::from(configured);
        fs::create_dir_all(&root).expect("persistent smoke root");
        return (None, fs::canonicalize(root).expect("canonical smoke root"));
    }
    let temporary = tempfile::tempdir().expect("test root");
    let root = temporary.path().to_owned();
    (Some(temporary), root)
}

fn assert_render_result(rendered: &PreparedRender, events: &[RenderProgress]) {
    let output = fs::read(rendered.path()).expect("rendered MP4");
    assert_eq!(&output[4..8], b"ftyp");
    assert_eq!(rendered.duration_in_frames(), 24);
    assert_eq!(
        (rendered.width(), rendered.height(), rendered.fps()),
        (640, 360, 24)
    );
    assert!(rendered.size_bytes() > 32);
    assert_eq!(rendered.content_hash(), blake3::hash(&output).as_bytes());
    assert!(
        events
            .windows(2)
            .all(|pair| { pair[0].fraction_millionths <= pair[1].fraction_millionths })
    );
    for phase in [
        RenderPhase::Staging,
        RenderPhase::ExtractingFrames,
        RenderPhase::ExtractingAudio,
        RenderPhase::LoadingComposition,
        RenderPhase::RenderingFrames,
        RenderPhase::Encoding,
        RenderPhase::Muxing,
    ] {
        assert!(
            events.iter().any(|event| event.phase == phase),
            "missing {phase:?}"
        );
    }
}

#[test]
#[ignore = "downloads managed FFmpeg and Remotion, then performs a real Chromium render"]
fn published_managed_runtime_renders_a_real_mp4() {
    let (_temporary, root) = smoke_root();
    let reuse_installed =
        std::env::var_os("OSG_REAL_RENDER_REUSE").as_deref() == Some(std::ffi::OsStr::new("1"));
    let coordinator = Arc::new(IdleCoordinator);
    let render_manager =
        RenderPackageManager::new(root.join("render-packages"), coordinator.clone())
            .expect("render package manager");
    let tool_manager = NativeToolManager::new(root.join("native-tools"), coordinator)
        .expect("native tool manager");
    let package_progress = |_progress: PackageProgress| {};
    let tool_progress = |_progress: ToolProgress| {};

    if !reuse_installed {
        render_manager
            .install(&PackageCancellationToken::default(), &package_progress)
            .expect("managed Remotion install");
        tool_manager
            .install(
                NativeToolId::MediaTools,
                &ToolCancellationToken::default(),
                &tool_progress,
            )
            .expect("managed FFmpeg install");
    }

    let render_package = render_manager
        .resolve_for_launch(&PackageCancellationToken::default())
        .expect("managed Remotion lease");
    let media_tools = tool_manager
        .resolve(NativeToolId::MediaTools, &ToolCancellationToken::default())
        .expect("managed FFmpeg lease");
    let ffmpeg = media_tools
        .executable(ExecutableRole::Ffmpeg)
        .expect("FFmpeg executable");
    let source = root.join("source.mp4");
    generate_source(ffmpeg, &source);
    let source_bytes = fs::read(&source).expect("source bytes");

    let worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../video-renderer/worker/osg_render_worker.mjs");
    let worker_bytes = fs::read(&worker).expect("render worker");
    let runtime = RenderRuntime::load(
        &render_package.package_root().join("runtime"),
        &worker,
        &worker_bytes,
        "x86_64-pc-windows-msvc",
    )
    .expect("verified managed render runtime");
    let plan = render_request()
        .validate(640, 360, 2_000_000)
        .expect("validated render plan");
    let inputs = NativeRenderInputs::new(
        source.clone(),
        u64::try_from(source_bytes.len()).expect("source length"),
        *blake3::hash(&source_bytes).as_bytes(),
        "mp4",
        ffmpeg.to_owned(),
        root.join("staging"),
    )
    .expect("native inputs");
    let progress = Arc::new(Mutex::new(Vec::<RenderProgress>::new()));
    let sink_progress = Arc::clone(&progress);
    let control = RenderRunControl::new(Duration::from_mins(5))
        .expect("render control")
        .with_progress(RenderProgressSink::new(move |event| {
            sink_progress.lock().expect("progress lock").push(event);
        }));
    let rendered = match RenderEngine::new(runtime).render(&plan, &inputs, &control) {
        Ok(rendered) => rendered,
        Err(error) => {
            let phases = progress
                .lock()
                .expect("failed progress")
                .iter()
                .map(|event| (event.phase, event.fraction_millionths))
                .collect::<Vec<_>>();
            panic!("real managed render failed: {error:?}; bounded progress: {phases:?}");
        }
    };
    let events = progress.lock().expect("progress results");
    assert_render_result(&rendered, &events);
    drop(events);
    drop(rendered);
    drop(media_tools);
    drop(render_package);

    if !reuse_installed {
        assert_eq!(
            tool_manager
                .remove(
                    NativeToolId::MediaTools,
                    &ToolCancellationToken::default(),
                    &tool_progress,
                )
                .expect("remove managed FFmpeg"),
            ToolRemovalOutcome::Removed
        );
        assert_eq!(
            render_manager
                .remove(&PackageCancellationToken::default(), &package_progress)
                .expect("remove managed Remotion"),
            PackageRemovalOutcome::Removed
        );
    }
}
