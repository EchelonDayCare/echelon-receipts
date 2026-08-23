//! AOAI-powered content editor for CMS pages.
//!
//! The user describes the change they want in plain English ("add a
//! Friday cook role, part-time casual, $22-25/hr"). We hand the current
//! JSON + the natural-language instruction to Azure OpenAI (gpt-5.4)
//! and ask it to return a fully-formed replacement JSON of the same
//! schema. The frontend shows the proposed JSON as a diff; the user
//! confirms and the app saves it as a normal draft revision.
//!
//! Scope: v3.21.0 gates this on `page == "careers"` only. Other pages
//! land in a follow-up once the flow is proven.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::website::git_ops::WorkingCopy;

const AZURE_OPENAI_ENDPOINT: &str = "https://ai-nse.openai.azure.com";
const CHAT_DEPLOY: &str = "gpt-5.4";
const CHAT_API_VER: &str = "2025-04-01-preview";

const SUPPORTED_PAGES: &[&str] = &["careers", "tour"];

#[derive(Debug, Deserialize)]
pub struct AiEditRequest {
    pub page: String,
    pub user_prompt: String,
}

#[derive(Debug, Serialize)]
pub struct AiEditResponse {
    pub page: String,
    pub original_json: String,
    pub proposed_json: String,
    pub summary: String,
    pub model: String,
}

#[tauri::command]
pub async fn website_ai_edit_content(
    app: AppHandle,
    request: AiEditRequest,
) -> Result<AiEditResponse, String> {
    crate::website::commands::require_enabled()?;
    let AiEditRequest { page, user_prompt } = request;
    if !SUPPORTED_PAGES.contains(&page.as_str()) {
        return Err(format!(
            "AI edit is only enabled for: {} (v3.21.0)",
            SUPPORTED_PAGES.join(", ")
        ));
    }
    let prompt = user_prompt.trim();
    if prompt.is_empty() {
        return Err("Describe the change you want to make.".into());
    }
    if prompt.len() > 4000 {
        return Err("Instruction too long (>4000 chars). Split into smaller edits.".into());
    }

    // Locate working copy + read current content JSON.
    let wc = working_copy_from_app(&app)?;
    let content_path: PathBuf = wc.repo_dir.join("content").join(format!("{page}.json"));
    if !content_path.exists() {
        return Err(format!("{}: not found in working copy", content_path.display()));
    }
    let original_json = std::fs::read_to_string(&content_path)
        .map_err(|e| format!("read {}: {e}", content_path.display()))?;
    // Sanity: current content must parse as JSON so we know the "before" state.
    let original_value: serde_json::Value = serde_json::from_str(&original_json)
        .map_err(|e| format!("current {page}.json is not valid JSON: {e}"))?;

    // Call AOAI with a strict-JSON response contract.
    let key = crate::secrets::get_secret("azure_ai_key")?;
    let (proposed_json, summary) =
        call_content_editor(&key, &page, &original_value, prompt).await?;

    // Validate the proposed JSON — refuse anything that doesn't parse.
    let _: serde_json::Value = serde_json::from_str(&proposed_json)
        .map_err(|e| format!("model returned invalid JSON: {e}"))?;

    Ok(AiEditResponse {
        page,
        original_json,
        proposed_json,
        summary,
        model: CHAT_DEPLOY.to_string(),
    })
}

fn working_copy_from_app(app: &AppHandle) -> Result<WorkingCopy, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let root = app_data.join("website");
    Ok(WorkingCopy {
        root: root.clone(),
        repo_dir: root.join("repo"),
        render_dir: root.join("render"),
    })
}

async fn call_content_editor(
    api_key: &str,
    page: &str,
    original: &serde_json::Value,
    user_prompt: &str,
) -> Result<(String, String), String> {
    let url = format!(
        "{AZURE_OPENAI_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );

    let system_prompt = format!(
        "You are a content editor for the Echelon Day Care website's static-site CMS.\n\
         You receive the current JSON for the `{page}` page and a plain-English \
         change request from the daycare owner. You return a strict JSON object \
         containing (a) the full REPLACEMENT JSON for `{page}.json` and (b) a \
         short human-readable summary of what changed.\n\
         \n\
         HARD RULES\n\
         1. Preserve the exact top-level shape of the input. Never rename keys, \
            never drop keys the site template depends on. Add new items only \
            inside array fields that clearly hold user content (e.g. `jobs`, \
            `type_options`).\n\
         2. If the user asks for something outside the schema (e.g. a new \
            top-level key or a style/visual change), reflect the intent in the \
            closest legal field and describe the gap in `summary`. Do not \
            invent keys.\n\
         3. Keep every existing item that the user did not explicitly ask to \
            change. Never silently drop jobs, locations, or filter options.\n\
         4. Copy tone: warm, professional, brief. Avoid emojis unless the \
            existing content uses them.\n\
         5. Return only the JSON object described in the response schema. No \
            prose, no markdown, no code fences."
    );

    let user_text = format!(
        "Current `{page}.json`:\n```json\n{}\n```\n\nUser request:\n{}",
        serde_json::to_string_pretty(original).unwrap_or_else(|_| original.to_string()),
        user_prompt,
    );

    // Structured output: model MUST return an object with `content_json` (the
    // new full JSON, as a string) plus a plain-English `summary`.
    let schema = json!({
        "type": "object",
        "properties": {
            "content_json": {
                "type": "string",
                "description": "The complete replacement JSON for the page, as a raw JSON-encoded string. Must parse via JSON.parse."
            },
            "summary": {
                "type": "string",
                "description": "Brief plain-English recap of the changes made (2-4 sentences)."
            }
        },
        "required": ["content_json", "summary"],
        "additionalProperties": false
    });

    let body = json!({
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_text },
        ],
        "max_completion_tokens": 8000,
        "reasoning_effort": "medium",
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "CmsContentEdit",
                "schema": schema,
                "strict": true
            }
        }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| redact(format!("http client: {e}"), api_key))?;

    let resp = client
        .post(&url)
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| redact(format!("request: {e}"), api_key))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| redact(format!("read: {e}"), api_key))?;
    if !status.is_success() {
        return Err(redact(
            format!("Azure OpenAI HTTP {status}: {}", truncate(&text, 800)),
            api_key,
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| redact(format!("response JSON: {e}"), api_key))?;
    let message = v["choices"][0]["message"]["content"].as_str().ok_or_else(|| {
        redact(
            format!("no message content in response: {}", truncate(&text, 400)),
            api_key,
        )
    })?;
    let parsed: serde_json::Value = serde_json::from_str(message)
        .map_err(|e| redact(format!("model output not JSON: {e}"), api_key))?;
    let content_json = parsed["content_json"]
        .as_str()
        .ok_or("model output missing `content_json`")?
        .to_string();
    let summary = parsed["summary"]
        .as_str()
        .unwrap_or("(no summary provided)")
        .to_string();
    Ok((content_json, summary))
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

fn redact(s: String, secret: &str) -> String {
    if secret.is_empty() {
        s
    } else {
        s.replace(secret, "***")
    }
}
