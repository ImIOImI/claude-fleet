//! fleet-embedder: text embedding sidecar for claude-fleet. Protocol: see
//! README.md. Exits 0 when stdin closes.

mod embed;
mod protocol;

use std::io::{self, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    id: u64,
    texts: Vec<String>,
}

fn send<W: Write>(w: &mut W, v: &Value) -> io::Result<()> {
    protocol::write_frame(w, v.to_string().as_bytes())
}

fn model_dir_arg() -> Option<PathBuf> {
    // args_os: <userData> may not be valid UTF-8.
    let mut args = std::env::args_os().skip(1);
    while let Some(a) = args.next() {
        if a == "--model-dir" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn main() -> ExitCode {
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let Some(dir) = model_dir_arg() else {
        let _ = send(&mut out, &json!({"type": "fatal", "error": "usage: fleet-embedder --model-dir <dir>"}));
        return ExitCode::from(1);
    };
    let mut embedder = match embed::Embedder::load(&dir) {
        Ok(e) => e,
        Err(e) => {
            let _ = send(&mut out, &json!({"type": "fatal", "error": format!("load {}: {e}", dir.display())}));
            return ExitCode::from(1);
        }
    };
    if send(&mut out, &json!({"type": "ready", "model": "Xenova/bge-small-en-v1.5", "dim": embed::DIM})).is_err() {
        return ExitCode::from(1);
    }

    let mut input = BufReader::new(io::stdin().lock());
    loop {
        let frame = match protocol::read_frame(&mut input) {
            Ok(Some(f)) => f,
            Ok(None) => return ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("fleet-embedder: {e}");
                return ExitCode::from(2);
            }
        };
        let reply = match serde_json::from_slice::<Request>(&frame) {
            Err(e) => json!({"id": null, "error": format!("bad request: {e}")}),
            Ok(req) => match embedder.embed(&req.texts) {
                Err(e) => json!({"id": req.id, "error": e.to_string()}),
                Ok(vecs) => {
                    let mut bytes = Vec::with_capacity(vecs.len() * embed::DIM * 4);
                    for v in &vecs {
                        for x in v {
                            bytes.extend_from_slice(&x.to_le_bytes());
                        }
                    }
                    json!({
                        "id": req.id,
                        "n": vecs.len(),
                        "dim": embed::DIM,
                        "vectors": base64::engine::general_purpose::STANDARD.encode(bytes),
                    })
                }
            },
        };
        if send(&mut out, &reply).is_err() {
            return ExitCode::SUCCESS;
        }
    }
}
