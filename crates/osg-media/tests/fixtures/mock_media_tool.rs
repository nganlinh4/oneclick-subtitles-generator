use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--mock-hang") {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    if arguments.iter().any(|argument| argument == "--mock-stderr") {
        let mut stderr = io::stderr().lock();
        for _ in 0..10_000 {
            let _ = writeln!(stderr, "diagnostic padding 012345678901234567890123456789");
        }
        let _ = writeln!(stderr, "TAIL-MARKER");
        std::process::exit(7);
    }
    if arguments.iter().any(|argument| argument == "--mock-progress") {
        eprintln!("frame=10");
        eprintln!("out_time_us=1000000");
        eprintln!("speed=1.25x");
        eprintln!("progress=continue");
        eprintln!("out_time_us=2000000");
        eprintln!("progress=end");
        return;
    }
    if arguments.iter().any(|argument| argument == "-show_streams") {
        print!(r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"pix_fmt":"yuv420p"}},{{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}}],"format":{{"format_name":"mov,mp4","duration":"4.25","size":"10000"}}}}"#);
        return;
    }
    if arguments.iter().any(|argument| argument == "-version") {
        println!("ffmpeg version osg-mock-1.0");
        return;
    }
    if let Some(output) = arguments.last()
        && !output.starts_with('-')
    {
        fs::write(Path::new(output), b"mock-media-artifact").unwrap();
    }
}
