//! Explicit billed smoke using the shipping Rust transport; WAV on stdin, key in the environment.
use futures_util::StreamExt;
use osg_gemini::{
    ApiKey, CancellationToken, GeminiClient, InlineMedia, MediaInput, TranscribeRequest,
    TranscriptionStreamCompletion,
};
use std::io::Read;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut wav = Vec::new();
    std::io::stdin().take(4_000_001).read_to_end(&mut wav)?;
    let key = ApiKey::new(std::env::var("GEMINI_API_KEY")?)?;
    let client = GeminiClient::new(key)?;
    if std::env::args().any(|arg| arg == "--timed") {
        let started = std::time::Instant::now();
        let cancel = CancellationToken::new();
        let request =
            TranscribeRequest::new(MediaInput::Inline(InlineMedia::new("audio/wav", wav)?));
        let mut stream = client.transcribe_stream(request, &cancel).await?;
        println!("Timed stream opened: {}ms", started.elapsed().as_millis());
        let mut completion = TranscriptionStreamCompletion::default();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            completion.observe(&chunk)?;
            println!(
                "Timed chunk: {}ms, {} words",
                started.elapsed().as_millis(),
                chunk.transcription_words().len()
            );
        }
        println!("Timed stream complete: {} words", completion.finish()?);
        return Ok(());
    }
    let mut updates = 0usize;
    client
        .transcribe_live(&wav, &[], &CancellationToken::new(), |event| {
            updates += 1;
            println!(
                "Live update {updates}: {:?}, {}-{}ms, {} bytes",
                event.kind,
                event.start_ms,
                event.end_ms,
                event.text.len()
            );
        })
        .await?;
    if updates == 0 {
        return Err("No Live transcription updates received".into());
    }
    println!("Shipping Rust transport succeeded: {updates} Live updates");
    Ok(())
}
