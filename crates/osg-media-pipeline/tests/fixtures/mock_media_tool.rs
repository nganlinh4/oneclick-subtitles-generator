use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let input = arguments
        .iter()
        .position(|argument| argument == "-i")
        .and_then(|index| arguments.get(index + 1))
        .cloned()
        .unwrap_or_default();
    if input.contains("hang") {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    if input.contains("fail") && !arguments.iter().any(|argument| argument == "-show_streams") {
        std::process::exit(9);
    }
    if arguments.iter().any(|argument| argument == "-version") {
        println!("ffmpeg version osg-pipeline-mock-1.0");
        return;
    }
    if arguments.iter().any(|argument| argument == "-show_streams") {
        if input.ends_with("audio.mp3") || input.ends_with("audio.wav") {
            print!(
                r#"{{"streams":[{{"index":0,"codec_type":"audio","codec_name":"mp3","sample_rate":"48000","channels":2}}],"format":{{"format_name":"mp3","duration":"4.0","size":"1000"}}}}"#
            );
        } else if input.ends_with("incompatible.webm") {
            print!(
                r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"vp9","width":1280,"height":720,"pix_fmt":"yuv444p"}},{{"index":1,"codec_type":"audio","codec_name":"vorbis","sample_rate":"48000","channels":2}}],"format":{{"format_name":"webm","duration":"4.0","size":"1000"}}}}"#
            );
        } else if input.ends_with("video-no-audio.mp4") {
            print!(
                r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"pix_fmt":"yuv420p"}}],"format":{{"format_name":"mov,mp4","duration":"4.0","size":"1000"}}}}"#
            );
        } else {
            print!(
                r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"pix_fmt":"yuv420p"}},{{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}}],"format":{{"format_name":"mov,mp4","duration":"4.0","size":"1000"}}}}"#
            );
        }
        return;
    }
    if let Some(output) = arguments
        .last()
        .filter(|argument| !argument.starts_with('-'))
    {
        if output.ends_with(".pcm") {
            let samples = [-32_768_i16, -16_384, 0, 32_767, 8_192, -8_192, 0, 0];
            let bytes = samples
                .iter()
                .flat_map(|sample| sample.to_le_bytes())
                .collect::<Vec<_>>();
            fs::write(Path::new(output), bytes).unwrap();
        } else {
            fs::write(Path::new(output), b"mock-media-artifact").unwrap();
        }
        let mut stderr = io::stderr().lock();
        let _ = writeln!(stderr, "out_time_us=4000000");
        let _ = writeln!(stderr, "progress=end");
    }
}
