use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if let Some(path) = option_value(&arguments, "--mock-delayed-write") {
        std::thread::sleep(Duration::from_millis(700));
        fs::write(path, b"descendant survived").unwrap();
        return;
    }
    if let Some(path) = option_value(&arguments, "--mock-tree") {
        Command::new(env::current_exe().unwrap())
            .args(["--mock-delayed-write", path])
            .spawn()
            .unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if arguments.iter().any(|argument| argument == "--mock-hang") {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if arguments.iter().any(|argument| argument == "--mock-stderr") {
        eprint!("{}TAIL-MARKER", "x".repeat(96 * 1024));
        std::process::exit(2);
    }
    if arguments.iter().any(|argument| argument == "--mock-stdout") {
        print!("{}TAIL-MARKER", "x".repeat(2 * 1024 * 1024));
        return;
    }
    if arguments.iter().any(|argument| argument == "--mock-progress") {
        println!("OSG_PROGRESS\tdownloading\t50\t100\tNA\t25\t2");
        println!("OSG_PROGRESS\tfinished\t100\t100\tNA\t25\t0");
        return;
    }
    if arguments.iter().any(|argument| argument == "--version") {
        let executable_name = env::current_exe()
            .ok()
            .and_then(|path| path.file_stem().map(|name| name.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        if executable_name == "deno" {
            println!("deno 2.9.5 (stable, release)");
            println!("v8 fixture");
            println!("typescript fixture");
        } else {
            println!("2026.08.10");
        }
        return;
    }
    if arguments.iter().any(|argument| argument == "--dump-single-json") {
        println!(r#"{{"title":"Mock / title","duration":42.5,"formats":[{{"format_id":"137","ext":"mp4","height":1080,"vcodec":"h264","acodec":"none"}},{{"format_id":"140","ext":"m4a","vcodec":"none","acodec":"aac"}}],"subtitles":{{"en":[{{"ext":"vtt"}}]}}}}"#);
        return;
    }

    let template = option_value(&arguments, "--output").expect("mock requires --output");
    let extension = option_value(&arguments, "--audio-format").unwrap_or("mp4");
    let media_path = PathBuf::from(template.replace("%(ext)s", extension));
    fs::write(&media_path, b"mock-media").unwrap();
    if let Some(language) = option_value(&arguments, "--sub-langs") {
        let subtitle = PathBuf::from(template.replace("%(ext)s", &format!("{language}.srt")));
        fs::write(subtitle, b"1\n00:00:00,000 --> 00:00:01,000\nmock\n").unwrap();
    }
    println!("OSG_PROGRESS\tfinished\t10\t10\tNA\t10\t0");
}

fn option_value<'a>(arguments: &'a [String], option: &str) -> Option<&'a str> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == option)
        .map(|pair| pair[1].as_str())
}
