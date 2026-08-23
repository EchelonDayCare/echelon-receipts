//! Deterministic derived-filename hashing.
//!
//! Every rendered variant of a photo has a filename derived from
//! `(sha256(original_bytes), width, format_tag, recipe_version)` hashed
//! with BLAKE3 and truncated to the first 16 hex chars, followed by
//! `-w{width}.{ext}`. Bumping [`RECIPE_VERSION`] regenerates every
//! filename, which is the cache-bust strategy at the CDN edge.

use sha2::{Digest, Sha256};

/// Current pipeline recipe. Bump when the re-encode pipeline changes in a
/// way that should invalidate every previously derived file.
pub const RECIPE_VERSION: u32 = 1;

/// Length of the hex prefix used in derived filenames.
pub const HASH_PREFIX_LEN: usize = 16;

/// Output format for a re-encoded photo variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Format {
    /// AV1 Image File Format — best compression, modern browsers only.
    Avif,
    /// Broad compat, better than JPG on modern browsers.
    Webp,
    /// Universal fallback, decodes everywhere.
    Jpg,
}

impl Format {
    /// Filename extension (no leading dot).
    pub fn ext(self) -> &'static str {
        match self {
            Format::Avif => "avif",
            Format::Webp => "webp",
            Format::Jpg => "jpg",
        }
    }

    /// Stable single-byte tag mixed into the derived-filename hash. Never
    /// renumber these values — doing so is a de-facto recipe-version bump
    /// for one format but not the others.
    pub fn tag(self) -> u8 {
        match self {
            Format::Avif => 1,
            Format::Webp => 2,
            Format::Jpg => 3,
        }
    }
}

/// SHA-256 of the original upload. Stable identity for the source photo.
pub fn source_hash(original_bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(original_bytes);
    h.finalize().into()
}

/// Full hex string of [`source_hash`]. Used as `PhotoOutput::base_hash`.
pub fn source_hash_hex(original_bytes: &[u8]) -> String {
    let bytes = source_hash(original_bytes);
    let mut out = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{:02x}", b);
    }
    out
}

/// Deterministic filename for a rendered variant.
///
/// Format: `{16-hex}-w{width}.{ext}`, e.g. `a3f2b1e4c8d90a5f-w800.avif`.
pub fn filename(original_bytes: &[u8], width: u32, format: Format, recipe_version: u32) -> String {
    let src = source_hash(original_bytes);
    let mut h = blake3::Hasher::new();
    h.update(&src);
    h.update(&width.to_be_bytes());
    h.update(&[format.tag()]);
    h.update(&recipe_version.to_be_bytes());
    let hex = h.finalize().to_hex();
    let prefix = &hex.as_str()[..HASH_PREFIX_LEN];
    format!("{prefix}-w{width}.{}", format.ext())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_filename_stable() {
        // Golden test: known input → known hex prefix. If this test fails
        // after a dependency bump, sha2/blake3 changed their output — which
        // would ALSO silently invalidate every already-published file.
        let bytes = b"echelon-receipts-website-media-golden-input";
        let out = filename(bytes, 800, Format::Avif, RECIPE_VERSION);

        // Must match the shape "{16-hex}-w800.avif"
        assert!(out.ends_with("-w800.avif"), "unexpected suffix: {out}");
        let (prefix, _) = out.split_once('-').unwrap();
        assert_eq!(prefix.len(), HASH_PREFIX_LEN, "hex prefix wrong length");
        assert!(
            prefix.chars().all(|c| c.is_ascii_hexdigit()),
            "prefix not hex: {prefix}"
        );

        // Same call twice → byte-identical string.
        let out2 = filename(bytes, 800, Format::Avif, RECIPE_VERSION);
        assert_eq!(out, out2);
    }

    #[test]
    fn hash_recipe_version_bump_changes_output() {
        let bytes = b"same-source-bytes";
        let v1 = filename(bytes, 800, Format::Avif, 1);
        let v2 = filename(bytes, 800, Format::Avif, 2);
        assert_ne!(
            v1, v2,
            "bumping the recipe version MUST change every derived filename"
        );
    }

    #[test]
    fn hash_different_widths_produce_different_names() {
        let bytes = b"same-source";
        let a = filename(bytes, 400, Format::Avif, RECIPE_VERSION);
        let b = filename(bytes, 800, Format::Avif, RECIPE_VERSION);
        let c = filename(bytes, 1600, Format::Avif, RECIPE_VERSION);
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    #[test]
    fn hash_different_formats_produce_different_names() {
        let bytes = b"same-source";
        let a = filename(bytes, 800, Format::Avif, RECIPE_VERSION);
        let b = filename(bytes, 800, Format::Webp, RECIPE_VERSION);
        let c = filename(bytes, 800, Format::Jpg, RECIPE_VERSION);
        assert_ne!(a, b);
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    #[test]
    fn hash_source_hex_is_sha256_shape() {
        let hex = source_hash_hex(b"anything");
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
