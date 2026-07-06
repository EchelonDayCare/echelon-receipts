// Azure endpoint URL allowlist. Phase-4b policy: the frontend may pass a
// non-secret Azure endpoint URL over IPC (e.g. the user's Whisper
// deployment lives on a resource we don't want to hardcode), but Rust must
// refuse anything that isn't a well-formed Azure OpenAI /
// Cognitive Services endpoint. Same spirit as `path_guard` — narrow the
// blast radius of an accidentally-editable setting or a compromised
// renderer that tries to redirect requests elsewhere.
use url::Url;

const ALLOWED_HOST_SUFFIXES: &[&str] = &[
    ".cognitiveservices.azure.com",
    ".openai.azure.com",
    ".services.ai.azure.com",
];

/// Validate an Azure OpenAI / Cognitive Services endpoint URL. Returns Ok
/// with a normalized URL string (parsed and re-serialized) or an Err with
/// a short user-facing reason.
pub fn validate_azure_endpoint(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Endpoint URL is empty. Configure it in Settings.".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;

    if parsed.scheme() != "https" {
        return Err("Endpoint must use https://".to_string());
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("Endpoint URL must not contain userinfo (user:pass@).".to_string());
    }
    let host = parsed.host_str().ok_or_else(|| "Endpoint URL has no host.".to_string())?;
    let host_l = host.to_ascii_lowercase();
    let host_ok = ALLOWED_HOST_SUFFIXES.iter().any(|s| host_l.ends_with(s));
    if !host_ok {
        return Err(format!(
            "Endpoint host '{host}' is not an allowed Azure host. Must end with one of: {}",
            ALLOWED_HOST_SUFFIXES.join(", ")
        ));
    }
    if !parsed.path().starts_with("/openai/deployments/") {
        return Err("Endpoint path must start with /openai/deployments/".to_string());
    }
    Ok(parsed.as_str().to_string())
}

const ALLOWED_MIME: &[&str] = &[
    "audio/webm",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
];

pub fn validate_audio_mime(mime: &str) -> Result<(), String> {
    let m = mime.trim().to_ascii_lowercase();
    // strip any ;codecs=... suffix — MediaRecorder ships e.g. audio/webm;codecs=opus
    let base = m.split(';').next().unwrap_or("").trim();
    if ALLOWED_MIME.contains(&base) {
        Ok(())
    } else {
        Err(format!("Unsupported audio MIME '{mime}'. Allowed: {}", ALLOWED_MIME.join(", ")))
    }
}

/// Whisper's own per-request limit is 25 MiB. Cap the *decoded* size we
/// will forward. Base64 inflates by ~4/3, so a 25 MiB decoded cap is
/// ~33.4 MiB of base64.
pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

pub fn validate_audio_size_b64(audio_b64: &str) -> Result<(), String> {
    // Cheap upper-bound check without allocating a decoded buffer just to
    // measure it. Base64 length * 3/4 ≥ decoded length. If the upper bound
    // already fits, we're done; otherwise reject.
    let upper = audio_b64.len().saturating_mul(3) / 4;
    if upper > MAX_AUDIO_BYTES {
        return Err(format!(
            "Audio too large: {}B decoded > {}B limit (Whisper max is 25 MiB per request).",
            upper, MAX_AUDIO_BYTES
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_openai_azure_com() {
        let r = validate_azure_endpoint(
            "https://ai-nse.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2024-06-01",
        );
        assert!(r.is_ok(), "{:?}", r);
    }

    #[test]
    fn accepts_cognitiveservices_azure_com() {
        let r = validate_azure_endpoint(
            "https://alosing-2058-resource.cognitiveservices.azure.com/openai/deployments/whisper/audio/translations?api-version=2024-06-01",
        );
        assert!(r.is_ok(), "{:?}", r);
    }

    #[test]
    fn rejects_http() {
        assert!(validate_azure_endpoint(
            "http://ai-nse.openai.azure.com/openai/deployments/x/chat/completions"
        ).is_err());
    }

    #[test]
    fn rejects_userinfo() {
        assert!(validate_azure_endpoint(
            "https://user:pass@ai-nse.openai.azure.com/openai/deployments/x/chat/completions"
        ).is_err());
    }

    #[test]
    fn rejects_foreign_host() {
        assert!(validate_azure_endpoint(
            "https://evil.example.com/openai/deployments/x/chat/completions"
        ).is_err());
        // Homoglyph / substring attack: allowed suffix must be a proper suffix.
        assert!(validate_azure_endpoint(
            "https://openai.azure.com.evil.com/openai/deployments/x/chat/completions"
        ).is_err());
    }

    #[test]
    fn rejects_wrong_path() {
        assert!(validate_azure_endpoint(
            "https://ai-nse.openai.azure.com/some/other/path"
        ).is_err());
    }

    #[test]
    fn rejects_empty_or_whitespace() {
        assert!(validate_azure_endpoint("").is_err());
        assert!(validate_azure_endpoint("   ").is_err());
    }

    #[test]
    fn rejects_malformed() {
        assert!(validate_azure_endpoint("not-a-url").is_err());
    }

    #[test]
    fn mime_accepts_webm_with_codecs() {
        assert!(validate_audio_mime("audio/webm;codecs=opus").is_ok());
    }

    #[test]
    fn mime_case_insensitive() {
        assert!(validate_audio_mime("AUDIO/WAV").is_ok());
    }

    #[test]
    fn mime_rejects_video() {
        assert!(validate_audio_mime("video/mp4").is_err());
    }

    #[test]
    fn size_accepts_small() {
        assert!(validate_audio_size_b64(&"A".repeat(1024)).is_ok());
    }

    #[test]
    fn size_rejects_over_25mib() {
        // 40 MiB of base64 -> 30 MiB decoded upper bound -> reject.
        assert!(validate_audio_size_b64(&"A".repeat(40 * 1024 * 1024)).is_err());
    }
}
