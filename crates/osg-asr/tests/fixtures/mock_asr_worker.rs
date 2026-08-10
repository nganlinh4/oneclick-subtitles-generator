use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn main() {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    if arguments.get(1).is_some_and(|value| value == "--descendant") {
        std::thread::sleep(Duration::from_millis(900));
        if let Some(path) = arguments.get(2) {
            let _ = std::fs::write(path, b"escaped process tree");
        }
        return;
    }

    let mut loaded = false;
    while let Some(request) = read_frame() {
        let request_id = extract_u64(&request, "requestId").unwrap_or(1);
        let input = extract_string(&request, "inputPath").unwrap_or_default();
        let mode = Path::new(&input)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("valid");

        match mode {
            "unframed" => {
                std::io::stdout().write_all(b"native worker log on stdout").unwrap();
                std::io::stdout().flush().unwrap();
                return;
            }
            "oversized" => {
                std::io::stdout()
                    .write_all(&(8_u32 * 1024 * 1024 + 1).to_be_bytes())
                    .unwrap();
                std::io::stdout().flush().unwrap();
                return;
            }
            "badseq" => {
                write_json(&phase(request_id, 1, "model_loading"));
                continue;
            }
            _ => {}
        }

        let mut sequence = 0;
        if !loaded {
            write_json(&phase(request_id, sequence, "model_loading"));
            sequence += 1;
            loaded = true;
        }
        write_json(&phase(request_id, sequence, "transcribing"));
        sequence += 1;

        match mode {
            "hang" => loop {
                std::thread::sleep(Duration::from_secs(1));
            },
            "tree" => {
                let sentinel = PathBuf::from(input).with_extension("survived");
                Command::new(std::env::current_exe().unwrap())
                    .arg("--descendant")
                    .arg(sentinel)
                    .spawn()
                    .unwrap();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            "crash" => std::process::exit(17),
            "worker-error" => {
                write_json(&format!(
                    "{{\"protocolVersion\":1,\"requestId\":{request_id},\"sequence\":{sequence},\"event\":\"error\",\"code\":\"inference_failed\"}}"
                ));
                continue;
            }
            "stderr" => {
                let block = vec![b'x'; 1024 * 1024];
                std::io::stderr().write_all(&block).unwrap();
                std::io::stderr().flush().unwrap();
            }
            _ => {}
        }

        write_json(&phase(request_id, sequence, "finalizing"));
        sequence += 1;
        let words = if mode == "invalid" {
            r#"[{"text":"broken","startSeconds":2.0,"endSeconds":1.0}]"#
        } else {
            r#"[{"text":"Hello","startSeconds":0.0,"endSeconds":0.4},{"text":"world.","startSeconds":0.5,"endSeconds":1.0},{"text":"Again","startSeconds":1.2,"endSeconds":1.7}]"#
        };
        write_json(&format!(
            "{{\"protocolVersion\":1,\"requestId\":{request_id},\"sequence\":{sequence},\"event\":\"complete\",\"transcript\":\"Hello world. Again\",\"language\":\"en\",\"backend\":\"cpu\",\"words\":{words},\"joinWithoutSpaces\":false}}"
        ));
    }
}

fn phase(request_id: u64, sequence: u16, phase: &str) -> String {
    format!(
        "{{\"protocolVersion\":1,\"requestId\":{request_id},\"sequence\":{sequence},\"event\":\"phase\",\"phase\":\"{phase}\"}}"
    )
}

fn read_frame() -> Option<String> {
    let mut header = [0_u8; 4];
    std::io::stdin().read_exact(&mut header).ok()?;
    let length = u32::from_be_bytes(header) as usize;
    let mut body = vec![0_u8; length];
    std::io::stdin().read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

fn write_json(value: &str) {
    let bytes = value.as_bytes();
    std::io::stdout()
        .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    std::io::stdout().write_all(bytes).unwrap();
    std::io::stdout().flush().unwrap();
}

fn extract_u64(json: &str, key: &str) -> Option<u64> {
    let marker = format!("\"{key}\":");
    let rest = json.split_once(&marker)?.1;
    let digits = rest.chars().take_while(char::is_ascii_digit).collect::<String>();
    digits.parse().ok()
}

fn extract_string(json: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\":\"");
    let mut characters = json.split_once(&marker)?.1.chars();
    let mut output = String::new();
    while let Some(character) = characters.next() {
        match character {
            '"' => return Some(output),
            '\\' => match characters.next()? {
                '"' => output.push('"'),
                '\\' => output.push('\\'),
                '/' => output.push('/'),
                'b' => output.push('\u{0008}'),
                'f' => output.push('\u{000c}'),
                'n' => output.push('\n'),
                'r' => output.push('\r'),
                't' => output.push('\t'),
                _ => return None,
            },
            other => output.push(other),
        }
    }
    None
}
