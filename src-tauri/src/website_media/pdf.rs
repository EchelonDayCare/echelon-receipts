//! PDF acceptance — STUB (full thumbnail render in PR 3.5).
//!
//! We validate the container header + a size cap so bogus uploads don't
//! reach the git-committed site repo, but we do not render page-1
//! thumbnails yet. That needs a real PDF rasteriser (poppler or pdfium
//! bindings) which is a bigger integration piece slated for PR 3.5.

use super::error::MediaError;

/// Hard cap for a single PDF upload. 25 MiB covers every daycare-side
/// handout we've seen; larger files should be uploaded to Drive instead.
pub const MAX_PDF_SIZE: usize = 25 * 1024 * 1024;

/// Result of accepting a PDF for later processing.
#[derive(Debug, Clone)]
pub struct PdfAccepted {
    pub size: usize,
    /// SHA-256 hex of the original bytes — same identity contract as photos.
    pub base_hash: String,
}

/// Validate the PDF magic header + size cap. Returns bytes' hash on success.
pub fn accept_pdf(bytes: &[u8]) -> Result<PdfAccepted, MediaError> {
    if bytes.len() > MAX_PDF_SIZE {
        return Err(MediaError::InputTooLarge {
            size: bytes.len(),
            max: MAX_PDF_SIZE,
        });
    }
    if bytes.len() < 5 || &bytes[0..5] != b"%PDF-" {
        return Err(MediaError::InvalidPdf(
            "missing %PDF- magic in first 5 bytes".into(),
        ));
    }
    Ok(PdfAccepted {
        size: bytes.len(),
        base_hash: super::hash::source_hash_hex(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_accepts_valid_magic() {
        // Minimal valid-looking PDF stub: magic + a comment line.
        let bytes = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
        let out = accept_pdf(bytes).expect("accept");
        assert_eq!(out.size, bytes.len());
        assert_eq!(out.base_hash.len(), 64);
    }

    #[test]
    fn pdf_rejects_invalid_magic() {
        let err = accept_pdf(b"NOT-A-PDF").expect_err("reject");
        assert!(matches!(err, MediaError::InvalidPdf(_)));
    }

    #[test]
    fn pdf_rejects_too_large() {
        let bytes = vec![0u8; MAX_PDF_SIZE + 1];
        let err = accept_pdf(&bytes).expect_err("reject");
        assert!(matches!(err, MediaError::InputTooLarge { .. }));
    }
}
