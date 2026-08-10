use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if let Some(index) = arguments.iter().position(|argument| argument == "--sentinel") {
        std::thread::sleep(Duration::from_millis(750));
        std::fs::write(&arguments[index + 1], b"escaped process").unwrap();
        return;
    }
    let backend = argument_value(&arguments, "--backend").unwrap_or("edge_tts");
    send(&format!(
        r#"{{"type":"hello","protocol":1,"backend":"{backend}","worker_version":"mock-1.0","max_text_bytes":16384}}"#
    ));

    let mut stdin = std::io::stdin().lock();
    loop {
        let Some(request) = receive(&mut stdin) else {
            return;
        };
        let request_id = json_u64(&request, "request_id").unwrap();
        if request.contains(r#""command":"shutdown""#) {
            return;
        }
        if request.contains(r#""command":"list_voices""#) {
            send(&format!(
                r#"{{"type":"voices","protocol":1,"request_id":{request_id},"voices":[{{"id":"en-US-Mock","display_name":"Mock Voice","language":"en-US","gender":"neutral"}}]}}"#
            ));
            continue;
        }

        let text = json_string(&request, "text").unwrap_or_default();
        if text == "MOCK_HANG" {
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        if let Some(sentinel) = text.strip_prefix("MOCK_TREE|") {
            Command::new(std::env::current_exe().unwrap())
                .arg("--sentinel")
                .arg(sentinel)
                .spawn()
                .unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        if text == "MOCK_EXIT" {
            std::process::exit(19);
        }
        if text == "MOCK_CORRUPT" {
            std::io::stdout().write_all(&[0xff, 0xff, 0xff, 0xff]).unwrap();
            std::io::stdout().flush().unwrap();
            continue;
        }
        if text == "MOCK_WRONG_ID" {
            send(&format!(
                r#"{{"type":"error","protocol":1,"request_id":{},"code":"invalid_request","retryable":false}}"#,
                request_id + 1
            ));
            continue;
        }
        if text == "MOCK_ERROR_SECRET" {
            send(&format!(
                r#"{{"type":"error","protocol":1,"request_id":{request_id},"code":"C:/private/leaked-key","retryable":false}}"#
            ));
            continue;
        }
        if text == "MOCK_SECRET_OK"
            && std::env::var("OSG_SPEECH_PROVIDER_SECRET").as_deref() != Ok("super-secret")
        {
            send(&format!(
                r#"{{"type":"error","protocol":1,"request_id":{request_id},"code":"authentication_failed","retryable":false}}"#
            ));
            continue;
        }
        if text == "MOCK_MANAGED_ENV" {
            let model_root = std::env::var_os("OSG_SPEECH_MODEL_ROOT").map(std::path::PathBuf::from);
            let valid = model_root.is_some_and(|path| path.is_absolute() && path.is_dir())
                && std::env::var("HF_HUB_OFFLINE").as_deref() == Ok("1")
                && std::env::var("HF_DATASETS_OFFLINE").as_deref() == Ok("1")
                && std::env::var("TRANSFORMERS_OFFLINE").as_deref() == Ok("1")
                && std::env::var_os("OSG_SPEECH_PROVIDER_SECRET").is_none();
            if !valid {
                send(&format!(
                    r#"{{"type":"error","protocol":1,"request_id":{request_id},"code":"invalid_worker_environment","retryable":false}}"#
                ));
                continue;
            }
        }
        if text == "MOCK_STDERR" {
            std::io::stderr().write_all(&vec![b'x'; 256 * 1024]).unwrap();
            std::io::stderr().flush().unwrap();
        }
        if text == "MOCK_SLOW" {
            std::thread::sleep(Duration::from_millis(300));
        }

        send(&format!(
            r#"{{"type":"progress","protocol":1,"request_id":{request_id},"phase":"loading_model","fraction_millionths":250000}}"#
        ));
        send(&format!(
            r#"{{"type":"progress","protocol":1,"request_id":{request_id},"phase":"synthesizing","fraction_millionths":1000000}}"#
        ));
        let output = json_string(&request, "output_path").unwrap();
        let format = json_string(&request, "output_format").unwrap();
        let bytes = if text == "MOCK_BAD_ARTIFACT" {
            std::fs::write(&output, b"private malformed bytes").unwrap();
            23
        } else if format == "mp3" {
            let bytes = b"ID3\x04\0\0mock-audio";
            std::fs::write(&output, bytes).unwrap();
            bytes.len()
        } else {
            let wav = wav_fixture();
            std::fs::write(&output, &wav).unwrap();
            wav.len()
        };
        send(&format!(
            r#"{{"type":"complete","protocol":1,"request_id":{request_id},"artifact":{{"bytes":{bytes},"duration_micros":100000,"sample_rate_hz":24000,"channels":1}}}}"#
        ));
    }
}

fn argument_value<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .map(String::as_str)
}

fn receive(reader: &mut impl Read) -> Option<String> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length).ok()?;
    let length = usize::try_from(u32::from_be_bytes(length)).ok()?;
    if length == 0 || length > 1024 * 1024 {
        return None;
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).ok()?;
    String::from_utf8(payload).ok()
}

fn send(payload: &str) {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&u32::try_from(payload.len()).unwrap().to_be_bytes())
        .unwrap();
    stdout.write_all(payload.as_bytes()).unwrap();
    stdout.flush().unwrap();
}

fn json_u64(source: &str, key: &str) -> Option<u64> {
    let marker = format!(r#""{key}":"#);
    let tail = source.split_once(&marker)?.1;
    let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
    tail.get(..digits)?.parse().ok()
}

fn json_string(source: &str, key: &str) -> Option<String> {
    let marker = format!(r#""{key}":""#);
    let mut characters = source.split_once(&marker)?.1.chars();
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
                'u' => {
                    let code: String = characters.by_ref().take(4).collect();
                    output.push(char::from_u32(u32::from_str_radix(&code, 16).ok()?)?);
                }
                _ => return None,
            },
            other => output.push(other),
        }
    }
    None
}

fn wav_fixture() -> Vec<u8> {
    let samples = 2_400_u32;
    let data_bytes = samples * 2;
    let mut wav = Vec::with_capacity(usize::try_from(44 + data_bytes).unwrap());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&24_000_u32.to_le_bytes());
    wav.extend_from_slice(&48_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    wav.resize(usize::try_from(44 + data_bytes).unwrap(), 0);
    wav
}

#[allow(dead_code)]
fn assert_path_is_native(path: &str) {
    assert!(Path::new(path).is_absolute());
}
