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
        if !root.is_dir() {
            return Err(format!(
                "preview root {} is not a directory",
                root.display()
            ));
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
        let thread = thread::spawn(move || {
            serve_loop(&server_for_thread, &root_for_thread, stop_rx);
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

fn serve_loop(server: &Arc<Server>, root: &std::path::Path, stop_rx: mpsc::Receiver<()>) {
    loop {
        if stop_rx.try_recv().is_ok() {
            return;
        }
        let req = match server.recv() {
            Ok(r) => r,
            Err(_) => return,
        };
        let url = req.url().to_string();
        let response = serve_request(&url, root);
        let _ = req.respond(response);
    }
}

fn serve_request(url: &str, root: &std::path::Path) -> Response<std::io::Cursor<Vec<u8>>> {
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
    let mut full = root.to_path_buf();
    for part in requested.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return not_found();
        }
        full.push(part);
    }
    // Path traversal defense: canonicalize and re-check.
    let (root_canon, full_canon) = match (root.canonicalize(), full.canonicalize()) {
        (Ok(r), Ok(f)) => (r, f),
        _ => return not_found(),
    };
    if !full_canon.starts_with(&root_canon) {
        return not_found();
    }
    let mut file = match std::fs::File::open(&full_canon) {
        Ok(f) => f,
        Err(_) => return not_found(),
    };
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return not_found();
    }
    let mime = mime_guess::from_path(&full_canon)
        .first_or_octet_stream()
        .to_string();
    let mut resp = Response::from_data(buf);
    if let Ok(h) = Header::from_bytes(b"Content-Type", mime.as_bytes()) {
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
