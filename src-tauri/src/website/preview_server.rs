//! Local static-file preview server for the rendered site.
//!
//! # Why `tiny_http` instead of `axum`
//! The preview server needs to:
//!   1. Bind a random loopback port.
//!   2. Serve static files under `<render_dir>/`.
//!   3. Shut down cleanly when the CMS module reloads.
//!
//! `axum` would give us routing + async but pulls in `tower`,
//! `tower-http` (for static files), and forces us to spawn a tokio
//! task with a lifetime we now have to manage. `tiny_http` is a
//! single crate, ~300 lines of docs, and does exactly this job — it
//! runs on a dedicated OS thread and shuts down via
//! `Server::unblock()`. Zero async story. That's a much smaller
//! contract for the preview to break at ship time.
//!
//! The preview is browsed inside the app's WebView. No cross-origin
//! concerns because the WebView loads from `http://127.0.0.1:<port>`
//! and never leaves that origin.

use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use tiny_http::{Header, Response, Server, StatusCode};

/// Handle to a running preview server. Drop the handle to shut it
/// down.
pub struct PreviewHandle {
    /// URL the WebView should load (e.g. `http://127.0.0.1:53291/`).
    pub url: String,
    /// Root the server is serving.
    pub root: PathBuf,
    /// Port the server is bound to.
    pub port: u16,
    /// Server thread; `join()` on drop after signalling stop.
    thread: Option<JoinHandle<()>>,
    /// Tell the request loop to stop.
    stop_tx: mpsc::Sender<()>,
    /// Server handle so we can `unblock` `recv` on drop. `tiny_http`
    /// wraps this in an `Arc` internally so cloning is cheap.
    server: Arc<Server>,
}

impl PreviewHandle {
    /// Bind the server to `127.0.0.1:0` (kernel picks the port) and
    /// spawn a thread that serves everything under `root`.
    ///
    /// The server refuses to serve anything outside `root` — paths
    /// containing `..` or absolute components are rejected with 404.
    pub fn start(root: PathBuf) -> Result<Self, String> {
        Self::start_with_fallback(root, None)
    }

    /// Same as [`start`] but with an optional secondary root. A
    /// request that misses in `root` is retried against `fallback`
    /// before returning 404. Used by the preview to serve rendered
    /// HTML from `render_dir` while pulling `assets/**` directly out
    /// of the working copy — saving an expensive tree copy on every
    /// preview startup, and letting a freshly-uploaded photo show up
    /// in preview without re-rendering the entire site.
    pub fn start_with_fallback(
        root: PathBuf,
        fallback: Option<PathBuf>,
    ) -> Result<Self, String> {
        if !root.is_dir() {
            return Err(format!(
                "preview root {} is not a directory",
                root.display()
            ));
        }
        if let Some(fb) = fallback.as_ref() {
            if !fb.is_dir() {
                return Err(format!(
                    "preview fallback {} is not a directory",
                    fb.display()
                ));
            }
        }
        let server = Server::http("127.0.0.1:0")
            .map_err(|e| format!("bind preview server: {e}"))?;
        let addr = server.server_addr();
        let port = addr
            .to_ip()
            .map(|sa| sa.port())
            .ok_or_else(|| "preview server addr had no port".to_string())?;
        let url = format!("http://127.0.0.1:{port}/");
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let server_arc = Arc::new(server);
        let server_for_thread = Arc::clone(&server_arc);
        let root_for_thread = root.clone();
        let fallback_for_thread = fallback.clone();
        let thread = thread::spawn(move || {
            serve_loop(
                &server_for_thread,
                &root_for_thread,
                fallback_for_thread.as_deref(),
                stop_rx,
            );
        });
        Ok(Self {
            url,
            root,
            port,
            thread: Some(thread),
            stop_tx,
            server: server_arc,
        })
    }
}

impl Drop for PreviewHandle {
    fn drop(&mut self) {
        // Signal the loop to stop and unblock any in-flight `recv`.
        let _ = self.stop_tx.send(());
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn serve_loop(
    server: &Arc<Server>,
    root: &std::path::Path,
    fallback: Option<&std::path::Path>,
    stop_rx: mpsc::Receiver<()>,
) {
    loop {
        if stop_rx.try_recv().is_ok() {
            return;
        }
        let req = match server.recv() {
            Ok(r) => r,
            Err(_) => return,
        };
        let url = req.url().to_string();
        let range = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("Range"))
            .map(|h| h.value.as_str().to_string());
        let response = serve_request(&url, root, fallback, range.as_deref());
        let _ = req.respond(response);
    }
}

/// Parse a single-range `Range: bytes=<start>-<end?>` header.
/// Returns `(start, end_inclusive)` clamped to `[0, file_len)` on
/// success, or `None` for anything unusual (multi-range, suffix
/// ranges past EOF, malformed). Callers fall back to a normal 200
/// response on `None`.
fn parse_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let stripped = header.strip_prefix("bytes=")?.trim();
    // Refuse comma-separated multi-range — tiny_http would need
    // multipart/byteranges which we don't emit.
    if stripped.contains(',') {
        return None;
    }
    let (lo_s, hi_s) = stripped.split_once('-')?;
    let lo_s = lo_s.trim();
    let hi_s = hi_s.trim();
    if lo_s.is_empty() {
        // Suffix: last N bytes.
        let n: u64 = hi_s.parse().ok()?;
        if n == 0 || file_len == 0 {
            return None;
        }
        let start = file_len.saturating_sub(n);
        return Some((start, file_len - 1));
    }
    let start: u64 = lo_s.parse().ok()?;
    if start >= file_len {
        return None;
    }
    let end: u64 = if hi_s.is_empty() {
        file_len - 1
    } else {
        let e: u64 = hi_s.parse().ok()?;
        e.min(file_len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn serve_request(
    url: &str,
    root: &std::path::Path,
    fallback: Option<&std::path::Path>,
    range: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    // Strip query / fragment, then normalise to `<root>/<path>`.
    let path_only = url.split(&['?', '#'][..]).next().unwrap_or(url);
    // Default document.
    let requested = if path_only == "/" || path_only.is_empty() {
        "index.html".to_string()
    } else {
        path_only.trim_start_matches('/').to_string()
    };
    if requested.contains("..") || requested.contains(':') {
        return not_found();
    }
    // Try primary root first, then fallback root.
    let candidates: [Option<&std::path::Path>; 2] = [Some(root), fallback];
    for base in candidates.into_iter().flatten() {
        if let Some(bytes) = try_load(base, &requested) {
            let mime = mime_guess::from_path(&requested)
                .first_or_octet_stream()
                .to_string();
            return respond_with_bytes(bytes, mime, range);
        }
    }
    not_found()
}

fn try_load(base: &std::path::Path, requested: &str) -> Option<Vec<u8>> {
    let mut full = base.to_path_buf();
    for part in requested.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        full.push(part);
    }
    let (root_canon, full_canon) = match (base.canonicalize(), full.canonicalize()) {
        (Ok(r), Ok(f)) => (r, f),
        _ => return None,
    };
    if !full_canon.starts_with(&root_canon) {
        return None;
    }
    let mut file = std::fs::File::open(&full_canon).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn respond_with_bytes(
    buf: Vec<u8>,
    mime: String,
    range: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let file_len = buf.len() as u64;

    // Honour Range headers. WKWebView refuses to play `<video>`
    // sources that don't accept range requests — without this, Mac
    // preview video playback stalls after the first packet.
    if let Some(h) = range {
        if let Some((start, end)) = parse_range(h, file_len) {
            let slice = buf[start as usize..=end as usize].to_vec();
            let len = end - start + 1;
            let mut resp = Response::from_data(slice).with_status_code(StatusCode(206));
            if let Ok(h) = Header::from_bytes(b"Content-Type", mime.as_bytes()) {
                resp = resp.with_header(h);
            }
            if let Ok(h) = Header::from_bytes(b"Accept-Ranges", b"bytes") {
                resp = resp.with_header(h);
            }
            if let Ok(h) = Header::from_bytes(
                b"Content-Range",
                format!("bytes {start}-{end}/{file_len}").as_bytes(),
            ) {
                resp = resp.with_header(h);
            }
            if let Ok(h) = Header::from_bytes(b"Content-Length", len.to_string().as_bytes()) {
                resp = resp.with_header(h);
            }
            if let Ok(h) = Header::from_bytes(b"Cache-Control", b"no-store") {
                resp = resp.with_header(h);
            }
            return resp;
        }
    }

    let mut resp = Response::from_data(buf);
    if let Ok(h) = Header::from_bytes(b"Content-Type", mime.as_bytes()) {
        resp = resp.with_header(h);
    }
    // Always advertise range support so WKWebView is willing to seek.
    if let Ok(h) = Header::from_bytes(b"Accept-Ranges", b"bytes") {
        resp = resp.with_header(h);
    }
    // Preview MUST NOT be cached — the user is iterating on edits.
    if let Ok(h) = Header::from_bytes(b"Cache-Control", b"no-store") {
        resp = resp.with_header(h);
    }
    resp
}

fn not_found() -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string("Not found").with_status_code(StatusCode(404))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_serves_files_and_shuts_down() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::write(root.join("index.html"), b"<!doctype html>ECHELON").unwrap();
        std::fs::create_dir_all(root.join("pages")).unwrap();
        std::fs::write(root.join("pages").join("about.html"), b"ABOUT").unwrap();

        let handle = PreviewHandle::start(root.clone()).unwrap();
        let port = handle.port;
        assert!(handle.url.starts_with("http://127.0.0.1:"));

        // Root fetches index.html.
        let body = quick_get(port, "/");
        assert!(body.contains("ECHELON"), "root fetch: {body}");
        // Nested fetch works.
        let body = quick_get(port, "/pages/about.html");
        assert_eq!(body, "ABOUT");
        // Path traversal returns 404.
        let (status, _) = quick_get_status(port, "/../etc/passwd");
        assert_eq!(status, 404);
        // Non-existent returns 404.
        let (status, _) = quick_get_status(port, "/nope");
        assert_eq!(status, 404);

        drop(handle);
        // Give the drop time to shut down without hanging the test.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    fn quick_get(port: u16, path: &str) -> String {
        quick_get_status(port, path).1
    }

    fn quick_get_status(port: u16, path: &str) -> (u16, String) {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!(
            "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        let (head, body) = match buf.split_once("\r\n\r\n") {
            Some((h, b)) => (h, b),
            None => (buf.as_str(), ""),
        };
        let status: u16 = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        (status, body.to_string())
    }
}
