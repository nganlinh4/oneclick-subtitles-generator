//! Explicit billed smoke using the shipping Rust transport; WAV on stdin, key in the environment.
use std::io::Read;
use osg_gemini::{ApiKey, CancellationToken, GeminiClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut wav = Vec::new();
    std::io::stdin().take(4_000_001).read_to_end(&mut wav)?;
    let key = ApiKey::new(std::env::var("GEMINI_API_KEY")?)?;
    let client = GeminiClient::new(key)?;
    let mut updates = 0usize;
    client.transcribe_live_draft(&wav, &[], &CancellationToken::new(), |text| {
        updates += 1;
        println!("Live draft {updates}: {} bytes", text.len());
    }).await?;
    if updates == 0 { return Err("No Live drafts received".into()); }
    println!("Shipping Rust transport succeeded: {updates} draft updates");
    Ok(())
}
