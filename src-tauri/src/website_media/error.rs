//! Error type shared across every step of the website media pipeline.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum MediaError {
    #[error("failed to decode image: {0}")]
    DecodeFailed(String),

    #[error("failed to encode image: {0}")]
    EncodeFailed(String),

    #[error("unsupported input format")]
    UnsupportedFormat,

    #[error("input too large: {size} bytes (max {max})")]
    InputTooLarge { size: usize, max: usize },

    #[error("invalid PDF: {0}")]
    InvalidPdf(String),

    #[error("stub not implemented: {0} — wired in a later PR")]
    StubNotImplemented(&'static str),
}
