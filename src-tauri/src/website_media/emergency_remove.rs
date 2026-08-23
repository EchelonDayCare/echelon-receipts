//! Emergency-remove data shape for the child-photo takedown flow.
//!
//! When a parent revokes consent, we not only delete the current file
//! from the website repo — we also rewrite the git history to expunge
//! every previous revision of that photo. That history rewrite belongs
//! in the `website` module (PR 3) because it needs the git session.
//!
//! What lives HERE is the request record: who asked, when, and why.
//! Emitting the request-side is stable enough to publish now so the
//! frontend can wire against it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmergencyRemoveMark {
    /// Content-addressed file id — the derived filename or, for the
    /// original, the sha256 hex of the upload.
    pub file_id: String,
    /// Free-form reason surfaced in the audit log. Kept short; the full
    /// context lives in the audit record itself.
    pub reason: String,
    /// RFC 3339 / ISO 8601 timestamp. We store as string so we don't
    /// depend on chrono's `serde` feature (not enabled in the crate).
    /// Use [`Self::requested_at_parsed`] to get a `DateTime<Utc>`.
    pub requested_at: String,
    /// User email or system id that filed the request.
    pub requested_by: String,
}

impl EmergencyRemoveMark {
    /// Construct from a strongly-typed `DateTime<Utc>` — formats to
    /// RFC 3339.
    pub fn new(
        file_id: impl Into<String>,
        reason: impl Into<String>,
        requested_at: DateTime<Utc>,
        requested_by: impl Into<String>,
    ) -> Self {
        Self {
            file_id: file_id.into(),
            reason: reason.into(),
            requested_at: requested_at.to_rfc3339(),
            requested_by: requested_by.into(),
        }
    }

    /// Parse [`Self::requested_at`] back into a `DateTime<Utc>`. Returns
    /// an error if the field was hand-edited to an invalid value.
    pub fn requested_at_parsed(&self) -> Result<DateTime<Utc>, chrono::ParseError> {
        DateTime::parse_from_rfc3339(&self.requested_at).map(|dt| dt.with_timezone(&Utc))
    }

    /// JSON-encode. Uses `serde_json` (already in the crate).
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Inverse of [`Self::to_json`].
    pub fn from_json(s: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn emergency_remove_mark_json_roundtrip() {
        let at = Utc.with_ymd_and_hms(2026, 8, 23, 12, 0, 0).unwrap();
        let mark = EmergencyRemoveMark::new(
            "a3f2b1e4c8d90a5f-w800.avif",
            "parent revoked consent",
            at,
            "admin@echelondaycare.example",
        );
        let json = mark.to_json().expect("serialize");
        // JSON must contain each field literally so audit log readers
        // don't need our type to parse the file.
        assert!(json.contains("\"file_id\""));
        assert!(json.contains("\"reason\""));
        assert!(json.contains("\"requested_at\""));
        assert!(json.contains("\"requested_by\""));

        let back = EmergencyRemoveMark::from_json(&json).expect("deserialize");
        assert_eq!(mark, back);

        // Timestamp round-trips through RFC 3339.
        assert_eq!(back.requested_at_parsed().unwrap(), at);
    }
}
