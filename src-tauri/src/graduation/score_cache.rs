//! Persistent sharpness-score cache for grad-reel photo curation.
//!
//! Every grad-reel run currently re-decodes and re-scores every photo
//! via [`super::curate::score_image`] (JPEG decode → resize to 500px →
//! 3x3 Laplacian variance). For a 100-photo class this is 5-20s of
//! wall-clock CPU that produces *identical* results across runs when
//! the underlying pixels haven't changed. Since HEIC decode is already
//! cached (see `heic.rs`), the JPEG bytes-on-disk key is stable
//! across runs — perfect for a content-addressed score sidecar.
//!
//! # Storage
//!
//! One tiny sidecar file per photo, under `{cache_dir}/scores/`:
//!
//! ```text
//! {cache_dir}/scores/{sha256(algo_ver|path|mtime_ns|size)[..16]}.f64
//! ```
//!
//! Each file holds exactly 8 little-endian bytes — the raw `f64`
//! sharpness value. No JSON parsing, no shared in-memory map, no
//! lock contention across rayon threads (each thread writes its own
//! filename in parallel). At 40 bytes total per entry, even 100k
//! photos costs ~4 MB — well below any cleanup threshold.
//!
//! # GC interaction
//!
//! The graduation cache GC (`paths::gc_cache`) uses `read_dir` at the
//! top level and skips subdirectories via its `p.is_file()` check.
//! Because sidecars live under a `scores/` subdirectory, the existing
//! GC will never prune them (it can't recurse into subdirs). This is
//! intentional — a working cache means sidecars have old mtimes but
//! are still valid, so mtime-based pruning would defeat the cache.
//! Growth is bounded by real photo count, ~40 bytes per entry.
//!
//! # Correctness
//!
//! The cache key is `sha256(SCORE_ALGO_VERSION | usable_path | mtime_ns
//! | size)[..16]`. `usable_path` is the file that will actually be
//! scored (post-HEIC-decode for HEIC/HEIF, or the source itself for
//! JPEG/PNG/etc.). For HEIC-derived JPEGs, the HEIC cache guarantees
//! identical bytes for identical source content, so the sidecar key
//! transitively depends on the raw HEIC content. For everything else,
//! `mtime + size` is the standard "did the file change?" heuristic
//! already in use throughout the codebase.
//!
//! **Algorithm version:** `SCORE_ALGO_VERSION` is folded into the key
//! so that any change to the scoring pipeline (e.g. bumping
//! `RESIZE_MAX_EDGE`, tuning the Laplacian kernel, switching filter
//! type) automatically invalidates every existing sidecar. Bump the
//! constant whenever `curate::score_image` changes behaviour.
//!
//! **Known limitations of mtime+size fingerprinting:**
//! * On FAT/exFAT-formatted media (some SD cards / USB sticks),
//!   filesystem mtime granularity is 2 seconds. A same-size photo
//!   replaced within that window reuses the stale key.
//! * Copy-preserving operations (`cp -p`, Finder Duplicate) that
//!   retain mtime and size on a same-length replacement also hit the
//!   same key.
//! * An EXIF-only edit that produces a same-length file (no image
//!   pixel change) is a false miss the other way — a fresh score is
//!   computed for identical pixels. That's a wasted CPU cycle, not a
//!   correctness issue.
//! These are the industry-standard mtime+size trade-offs also used
//! by git, make, and rsync. If ranking anomalies are ever reported
//! against SD-card workflows, upgrade the key to include a partial
//! content hash (first/last N KB).
//!
//! Read failures (corrupt file, permission denied, disk gone) fall
//! back to a re-score with no user-visible error. Write failures are
//! logged to stderr (matching the `[graduation]` convention in
//! `pptx.rs` / `commands.rs`) and then swallowed — a stale or absent
//! cache is preferable to a failed render.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use sha2::{Digest, Sha256};

/// Where sidecar files live, relative to the graduation cache dir
/// (`{app_data}/graduation-cache/heic/`, passed in as `heic_cache_dir`).
const SCORES_SUBDIR: &str = "scores";

/// Scoring-algorithm version. Bump this whenever `curate::score_image`
/// changes behaviour (resize target, kernel weights, filter type,
/// colour-space handling, anything measurable). Every existing sidecar
/// on disk becomes automatically unreachable — a fresh score is
/// computed on the next scan, keeping ranking correct without any
/// user-facing "clear cache" step. The dead sidecars persist until
/// the user clears `graduation-cache/heic/scores/` manually; growth
/// is bounded (~40 bytes/photo/version) so this is cheap.
const SCORE_ALGO_VERSION: u8 = 1;

/// Compute the sidecar key for `path`. Returns `None` when the file
/// can't be stat'd — the caller then treats it as a cache miss.
fn key_for(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ns = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let size = meta.len();
    let mut h = Sha256::new();
    h.update([SCORE_ALGO_VERSION]);
    h.update(b"|");
    h.update(path.to_string_lossy().as_bytes());
    h.update(b"|");
    h.update(mtime_ns.to_le_bytes());
    h.update(b"|");
    h.update(size.to_le_bytes());
    let digest = h.finalize();
    Some(hex_prefix(&digest, 16))
}

fn hex_prefix(bytes: &[u8], nibbles: usize) -> String {
    let mut s = String::with_capacity(nibbles);
    for byte in bytes {
        s.push(nibble(byte >> 4));
        s.push(nibble(byte & 0x0f));
        if s.len() >= nibbles {
            break;
        }
    }
    s.truncate(nibbles);
    s
}

fn nibble(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        _ => (b'a' + (n - 10)) as char,
    }
}

fn sidecar_path(cache_dir: &Path, key: &str) -> PathBuf {
    cache_dir.join(SCORES_SUBDIR).join(format!("{key}.f64"))
}

/// Read the cached sharpness score for `path`, if any. Any failure
/// (missing file, corrupt bytes, wrong length, non-finite value)
/// resolves to `None` so the caller re-scores fresh.
pub fn read(cache_dir: &Path, path: &Path) -> Option<f64> {
    let key = key_for(path)?;
    let sidecar = sidecar_path(cache_dir, &key);
    let bytes = fs::read(&sidecar).ok()?;
    if bytes.len() != 8 {
        return None;
    }
    let mut arr = [0u8; 8];
    arr.copy_from_slice(&bytes);
    let score = f64::from_le_bytes(arr);
    // Guard against garbage payloads sneaking past the length check.
    if !score.is_finite() {
        return None;
    }
    Some(score)
}

/// Write a freshly-computed score to the sidecar cache. Best-effort:
/// any I/O failure is swallowed (a failed cache write is never worth
/// aborting a render).
///
/// Atomicity: writes to a `.tmp` sibling then renames. `std::fs::rename`
/// is atomic on the same filesystem, so concurrent rayon threads
/// writing different keys never see torn files; two threads racing on
/// the *same* key would produce identical bytes (score is a pure
/// function of content), so the winner is irrelevant.
pub fn write(cache_dir: &Path, path: &Path, score: f64) {
    if !score.is_finite() {
        return;
    }
    let Some(key) = key_for(path) else { return };
    let sidecar = sidecar_path(cache_dir, &key);
    // Guarantee the scores/ subdir exists. Cheap on the happy path
    // once the first write has created it.
    if let Some(parent) = sidecar.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!(
                "[graduation] score_cache: mkdir {} failed: {e}",
                parent.display()
            );
            return;
        }
    }
    let tmp = sidecar.with_extension("f64.tmp");
    let mut f = match fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "[graduation] score_cache: create {} failed: {e}",
                tmp.display()
            );
            return;
        }
    };
    if let Err(e) = f.write_all(&score.to_le_bytes()) {
        eprintln!(
            "[graduation] score_cache: write {} failed: {e}",
            tmp.display()
        );
        let _ = fs::remove_file(&tmp);
        return;
    }
    if let Err(e) = f.sync_all() {
        eprintln!(
            "[graduation] score_cache: fsync {} failed: {e}",
            tmp.display()
        );
        let _ = fs::remove_file(&tmp);
        return;
    }
    drop(f);
    if let Err(e) = fs::rename(&tmp, &sidecar) {
        eprintln!(
            "[graduation] score_cache: rename {} → {} failed: {e}",
            tmp.display(),
            sidecar.display()
        );
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_photo(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn round_trip_reads_written_score() {
        let cache = tempdir().unwrap();
        let src = tempdir().unwrap();
        let photo = make_photo(src.path(), "a.jpg", b"fake-bytes");

        assert!(read(cache.path(), &photo).is_none(), "empty cache should miss");
        write(cache.path(), &photo, 42.5);
        assert_eq!(read(cache.path(), &photo), Some(42.5));
    }

    #[test]
    fn different_photos_get_different_keys() {
        let cache = tempdir().unwrap();
        let src = tempdir().unwrap();
        let a = make_photo(src.path(), "a.jpg", b"bytes-a");
        let b = make_photo(src.path(), "b.jpg", b"bytes-b-different-len");

        write(cache.path(), &a, 10.0);
        write(cache.path(), &b, 20.0);
        assert_eq!(read(cache.path(), &a), Some(10.0));
        assert_eq!(read(cache.path(), &b), Some(20.0));
    }

    #[test]
    fn mtime_change_invalidates_cache() {
        let cache = tempdir().unwrap();
        let src = tempdir().unwrap();
        let photo = make_photo(src.path(), "a.jpg", b"v1");

        write(cache.path(), &photo, 5.0);
        assert_eq!(read(cache.path(), &photo), Some(5.0));

        // Rewrite with same length but bump mtime — key changes,
        // stale sidecar becomes unreachable and read returns None.
        // Sleep guarantees mtime advances past filesystem granularity
        // (Windows FAT: 2s; NTFS/APFS: sub-ms usually, but be safe).
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&photo, b"v2").unwrap();
        assert!(
            read(cache.path(), &photo).is_none(),
            "modified file must miss the cache"
        );
    }

    #[test]
    fn corrupt_sidecar_reads_as_miss() {
        let cache = tempdir().unwrap();
        let src = tempdir().unwrap();
        let photo = make_photo(src.path(), "a.jpg", b"pixels");
        let key = key_for(&photo).unwrap();
        let sidecar = sidecar_path(cache.path(), &key);
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        // Wrong length — must not be treated as a valid score.
        fs::write(&sidecar, b"nope").unwrap();
        assert!(read(cache.path(), &photo).is_none());
    }

    #[test]
    fn non_finite_scores_are_rejected() {
        let cache = tempdir().unwrap();
        let src = tempdir().unwrap();
        let photo = make_photo(src.path(), "a.jpg", b"pixels");

        // Sanity: the write path silently drops NaN so it never poisons
        // the cache.
        write(cache.path(), &photo, f64::NAN);
        assert!(read(cache.path(), &photo).is_none());

        write(cache.path(), &photo, f64::INFINITY);
        assert!(read(cache.path(), &photo).is_none());

        // Force a finite value in — the cache round-trips normally.
        write(cache.path(), &photo, 1.5);
        assert_eq!(read(cache.path(), &photo), Some(1.5));
    }

    #[test]
    fn missing_source_file_is_a_clean_miss() {
        let cache = tempdir().unwrap();
        // Path that doesn't exist. read() must return None instead of
        // panicking or erroring — the caller falls through to score.
        let ghost = cache.path().join("ghost.jpg");
        assert!(read(cache.path(), &ghost).is_none());
        // write() on a missing source is also a silent no-op.
        write(cache.path(), &ghost, 1.0);
        assert!(read(cache.path(), &ghost).is_none());
    }
}
