//! FFmpeg progress parser.
//!
//! FFmpeg with `-progress pipe:1` emits repeating blocks of key=value
//! lines on stdout, terminated by `progress=continue` or
//! `progress=end`. Example:
//! ```text
//! frame=213
//! fps=59.5
//! total_size=3268608
//! out_time_ms=8880000
//! out_time=00:00:08.880000
//! progress=continue
//! ```
//! This module parses those blocks into structured events.

use std::io::{BufRead, BufReader, Read};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ProgressTick {
    /// Encoded frame count so far.
    pub frame: Option<u64>,
    /// Encoding speed in frames per second.
    pub fps: Option<f64>,
    /// Bytes written to the output so far.
    pub total_size: Option<u64>,
    /// Encoded output-clock microseconds (from `out_time_us`, the
    /// authoritative field in FFmpeg 6.0+). Prefer this if set.
    pub out_time_us: Option<i64>,
    /// Encoded output-clock microseconds parsed from `out_time_ms`.
    /// FFmpeg historically emitted this as *microseconds* under a
    /// misleading name; recent builds fixed it to true milliseconds.
    /// We keep it separate from `out_time_us` so we can prefer the
    /// authoritative field and not collapse different units into one.
    pub out_time_ms: Option<i64>,
    /// True once FFmpeg emits `progress=end`.
    pub done: bool,
}

impl ProgressTick {
    /// Best-effort microseconds: prefer `out_time_us`, fall back to
    /// `out_time_ms` (which older FFmpeg builds emitted as microseconds
    /// too — same value under a different name).
    pub fn best_us(&self) -> Option<i64> {
        self.out_time_us.or(self.out_time_ms)
    }
}

/// Stateful, incremental parser for FFmpeg's `-progress pipe:1` output.
///
/// tauri-plugin-shell delivers stdout in chunks that rarely align with
/// FFmpeg's per-block key=value emission (single lines arrive in
/// separate events). This parser accumulates key/value fields into a
/// pending `ProgressTick` across `feed_line` calls and emits it only
/// when it sees `progress=continue` / `progress=end` — the block
/// terminators. That way `frame`, `fps`, `out_time_us`, and friends
/// stay bundled in the same event.
#[derive(Default)]
pub struct ProgressParser {
    current: ProgressTick,
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a single terminated line (no trailing newline required).
    /// Returns `Some(tick)` when a block completes, `None` otherwise.
    pub fn feed_line(&mut self, line: &str) -> Option<ProgressTick> {
        let l = line.trim_end();
        let (k, v) = l.split_once('=')?;
        match k {
            "frame" => self.current.frame = v.parse().ok(),
            "fps" => self.current.fps = v.parse().ok(),
            "total_size" => self.current.total_size = v.parse().ok(),
            "out_time_us" => self.current.out_time_us = v.parse().ok(),
            "out_time_ms" => self.current.out_time_ms = v.parse().ok(),
            "progress" => {
                self.current.done = v == "end";
                return Some(std::mem::take(&mut self.current));
            }
            _ => {}
        }
        None
    }

    /// Drain any partial block that hadn't seen a `progress=` terminator
    /// yet (called on EOF).
    pub fn drain(&mut self) -> Option<ProgressTick> {
        if has_data(&self.current) {
            Some(std::mem::take(&mut self.current))
        } else {
            None
        }
    }
}

/// Read every line from `reader`, invoking `on_tick` once per completed
/// progress block. Returns Ok when EOF is hit.
///
/// `on_tick` is called on the caller's thread, so keep it fast — the
/// intended use is to emit a Tauri event and return.
pub fn parse_stream<R: Read>(reader: R, mut on_tick: impl FnMut(ProgressTick)) -> std::io::Result<()> {
    let mut buf = BufReader::new(reader);
    let mut parser = ProgressParser::new();
    let mut line = String::new();
    loop {
        line.clear();
        let n = buf.read_line(&mut line)?;
        if n == 0 {
            if let Some(t) = parser.drain() {
                on_tick(t);
            }
            return Ok(());
        }
        if let Some(t) = parser.feed_line(&line) {
            let is_end = t.done;
            on_tick(t);
            if is_end {
                return Ok(());
            }
        }
    }
}

fn has_data(t: &ProgressTick) -> bool {
    t.frame.is_some() || t.fps.is_some() || t.total_size.is_some() || t.out_time_us.is_some() || t.out_time_ms.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_two_blocks_then_end() {
        let input = concat!(
            "frame=10\n",
            "fps=25.0\n",
            "out_time_ms=400000\n",
            "progress=continue\n",
            "frame=20\n",
            "fps=25.0\n",
            "out_time_ms=800000\n",
            "progress=end\n",
        );
        let mut ticks: Vec<ProgressTick> = Vec::new();
        parse_stream(Cursor::new(input), |t| ticks.push(t)).unwrap();
        assert_eq!(ticks.len(), 2);
        assert_eq!(ticks[0].frame, Some(10));
        assert!(ticks[1].done);
        assert_eq!(ticks[1].out_time_ms, Some(800_000));
        assert_eq!(ticks[1].out_time_us, None);
        // best_us falls back to out_time_ms when out_time_us is absent.
        assert_eq!(ticks[1].best_us(), Some(800_000));
    }

    #[test]
    fn prefers_out_time_us_over_ms() {
        let input = "frame=1\nout_time_us=1234\nout_time_ms=5678\nprogress=end\n";
        let mut ticks: Vec<ProgressTick> = Vec::new();
        parse_stream(Cursor::new(input), |t| ticks.push(t)).unwrap();
        assert_eq!(ticks[0].out_time_us, Some(1234));
        assert_eq!(ticks[0].out_time_ms, Some(5678));
        assert_eq!(ticks[0].best_us(), Some(1234)); // us wins
    }
}
