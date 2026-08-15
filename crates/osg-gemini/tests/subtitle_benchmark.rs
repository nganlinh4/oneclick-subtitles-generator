#[path = "subtitle_benchmark/manifest.rs"]
mod manifest;
#[path = "subtitle_benchmark/report.rs"]
mod report;
#[path = "subtitle_benchmark/runner.rs"]
mod runner;
#[path = "subtitle_benchmark/scoring.rs"]
mod scoring;
#[path = "subtitle_benchmark/setup.rs"]
mod setup;

#[test]
fn subtitle_benchmark_fixtures_are_valid() {
    let manifest = manifest::Manifest::load().expect("load subtitle benchmark manifest");
    manifest
        .validate()
        .expect("validate subtitle benchmark protocol and fixtures");
    manifest
        .fingerprint()
        .expect("fingerprint subtitle benchmark protocol and fixtures");
    scoring::self_check().expect("validate benchmark scoring invariants");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires SUBTITLE_BENCH_LIVE=1 and real Gemini credentials"]
async fn subtitle_benchmark_live() {
    assert_eq!(
        std::env::var("SUBTITLE_BENCH_LIVE").as_deref(),
        Ok("1"),
        "set SUBTITLE_BENCH_LIVE=1 after reviewing tests/subtitle-benchmark/README.md"
    );
    runner::run().await.expect("run live subtitle benchmark");
}
