//! FFmpeg concat demuxer list writer.
//!
//! The concat demuxer takes a text file listing input files, one per
//! line, and streams them as a single virtual input. This bypasses the
//! Windows 8191-char command-line limit that would blow up on any
//! meaningful photo count. See
//! <https://ffmpeg.org/ffmpeg-formats.html#concat-1>.
//!
//! Each entry looks like:
//! ```text
//! file 'C:\path\to\photo.jpg'
//! duration 2.5
//! ```
//! and every path is single-quoted with FFmpeg's `\'` escape sequence.

use std::io::Write;
use std::path::{Path, PathBuf};

/// One frame in the reel: a photo path and how long to hold it.
#[derive(Debug, Clone)]
pub struct ConcatEntry {
    pub path: PathBuf,
    pub duration_sec: f64,
}

/// Write a concat demuxer list file. The concat demuxer requires that
/// the LAST frame is duplicated (once with a duration, once without) so
/// FFmpeg emits it — otherwise the final duration line is ignored and
/// the last still gets stretched to fill the remaining time. See
/// <https://trac.ffmpeg.org/wiki/Slideshow#Concatdemuxer>.
pub fn write_list(dest: &Path, entries: &[ConcatEntry]) -> Result<(), String> {
    if entries.is_empty() {
        return Err("concat list cannot be empty".to_string());
    }
    let f = std::fs::File::create(dest)
        .map_err(|e| format!("create({}): {e}", dest.display()))?;
    let mut w = std::io::BufWriter::new(f);
    // ffconcat v1 marker so FFmpeg treats interpret-time correctly.
    writeln!(w, "ffconcat version 1.0").map_err(|e| format!("write: {e}"))?;
    for e in entries {
        writeln!(w, "file '{}'", escape_for_concat(&e.path))
            .map_err(|e| format!("write: {e}"))?;
        writeln!(w, "duration {:.3}", e.duration_sec)
            .map_err(|e| format!("write: {e}"))?;
    }
    // Duplicate the last entry sans duration so its still is emitted.
    let last = entries.last().unwrap();
    writeln!(w, "file '{}'", escape_for_concat(&last.path))
        .map_err(|e| format!("write: {e}"))?;
    w.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// FFmpeg concat demuxer escape rules: single-quote the whole thing;
/// inside the quotes, a literal single quote is `'\''` (close, escaped
/// quote, reopen). Backslashes are literal on Windows paths — do not
/// double them.
fn escape_for_concat(p: &Path) -> String {
    let s = p.to_string_lossy();
    // Replace ' with '\''  (four chars: close-quote, backslash, quote,
    // open-quote). We're already inside single quotes at call sites.
    s.replace('\'', "'\\''")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn escape_handles_apostrophe() {
        let p = PathBuf::from("/tmp/ann's photo.jpg");
        assert_eq!(escape_for_concat(&p), r"/tmp/ann'\''s photo.jpg");
    }

    #[test]
    fn escape_leaves_backslash_alone() {
        let p = PathBuf::from(r"C:\Users\alice\photo.jpg");
        assert_eq!(escape_for_concat(&p), r"C:\Users\alice\photo.jpg");
    }

    #[test]
    fn write_emits_trailing_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let list = tmp.path().join("list.txt");
        let entries = vec![
            ConcatEntry { path: PathBuf::from("/a.jpg"), duration_sec: 2.0 },
            ConcatEntry { path: PathBuf::from("/b.jpg"), duration_sec: 3.0 },
        ];
        write_list(&list, &entries).unwrap();
        let text = std::fs::read_to_string(&list).unwrap();
        // Two `duration` lines but three `file` lines (last is duplicated).
        assert_eq!(text.matches("duration").count(), 2);
        assert_eq!(text.matches("file '").count(), 3);
    }
}
