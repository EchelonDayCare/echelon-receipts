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

use tauri::{AppHandle, Manager, State};

use crate::db_gate::DbGate;
use crate::website::git_ops::WorkingCopy;
use crate::website::revisions;

const AZURE_OPENAI_ENDPOINT: &str = "https://ai-nse.openai.azure.com";
const CHAT_DEPLOY: &str = "gpt-5.4";
const CHAT_API_VER: &str = "2025-04-01-preview";

const SUPPORTED_PAGES: &[&str] = &["about", "careers", "tour", "contact", "services", "seo", "home", "site", "gallery-videos"];

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
    /// For pages whose UI touches shared state (currently only `contact`,
    /// which renders social links from `site.json`), the AI may also
    /// return a full replacement for `site.json`. When present, the
    /// frontend should save it as a second draft. `None` means the model
    /// left site.json unchanged (or the page doesn't touch it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_original_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_proposed_json: Option<String>,
}

#[tauri::command]
pub async fn website_ai_edit_content(
    app: AppHandle,
    db: State<'_, DbGate>,
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

    // Prefer the active draft over the working-copy file. The
    // working copy can lag behind the DB after a save (git ops run
    // asynchronously), so reading it means AI edits sometimes ran
    // against stale JSON and clobbered fresh unpublished edits when
    // the user accepted the diff. The DB draft is the durable
    // source of truth.
    let wc = working_copy_from_app(&app)?;
    let content_path: PathBuf = wc.repo_dir.join("content").join(format!("{page}.json"));
    let original_json = match revisions::load_draft(db.inner(), &page).await {
        Ok(Some(s)) => s,
        _ => {
            if !content_path.exists() {
                return Err(format!("{}: not found in working copy", content_path.display()));
            }
            std::fs::read_to_string(&content_path)
                .map_err(|e| format!("read {}: {e}", content_path.display()))?
        }
    };
    // Sanity: current content must parse as JSON so we know the "before" state.
    let original_value: serde_json::Value = serde_json::from_str(&original_json)
        .map_err(|e| format!("current {page}.json is not valid JSON: {e}"))?;

    // Contact page also renders content from site.json (socials, address,
    // phone, email). Feed that as extra context so the AI can add / remove
    // social platforms, adjust the aria label, etc.
    let (site_original_json, site_original_value): (Option<String>, Option<serde_json::Value>) = if page == "contact" {
        let from_draft = revisions::load_draft(db.inner(), "site").await.ok().flatten();
        let src = match from_draft {
            Some(s) => Some(s),
            None => {
                let site_path = wc.repo_dir.join("content").join("site.json");
                if site_path.exists() { std::fs::read_to_string(&site_path).ok() } else { None }
            }
        };
        match src {
            Some(s) => match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(v) => (Some(s), Some(v)),
                Err(_) => (None, None),
            },
            None => (None, None),
        }
    } else {
        (None, None)
    };

    // Call AOAI with a strict-JSON response contract.
    let key = crate::secrets::get_secret("azure_ai_key")?;
    let (proposed_json, site_proposed_json, summary) =
        call_content_editor(&key, &page, &original_value, site_original_value.as_ref(), prompt).await?;

    // Validate the proposed JSON — refuse anything that doesn't parse.
    let proposed_value: serde_json::Value = serde_json::from_str(&proposed_json)
        .map_err(|e| format!("model returned invalid JSON: {e}"))?;
    // Enforce schema-level allowlist: the proposed JSON's top-level
    // keys must be a subset of the original's. Model can add nested
    // fields (e.g. new job listings, new social platforms), but not
    // introduce brand-new top-level keys — that path was how earlier
    // sessions produced JSON that failed schema::validate at draft
    // save time and confused the user with a late-stage error.
    if let (Some(orig_obj), Some(prop_obj)) = (original_value.as_object(), proposed_value.as_object()) {
        let orig_keys: std::collections::HashSet<&String> = orig_obj.keys().collect();
        let extra: Vec<&String> = prop_obj
            .keys()
            .filter(|k| !orig_keys.contains(k))
            .collect();
        if !extra.is_empty() {
            let names: Vec<String> = extra.iter().map(|k| (*k).clone()).collect();
            return Err(format!(
                "model added unknown top-level key(s): {} — retry with a narrower instruction",
                names.join(", ")
            ));
        }
    }
    if let Some(ref s) = site_proposed_json {
        let site_prop_val: serde_json::Value = serde_json::from_str(s)
            .map_err(|e| format!("model returned invalid site JSON: {e}"))?;
        if let (Some(orig_obj), Some(prop_obj)) = (
            site_original_value.as_ref().and_then(|v| v.as_object()),
            site_prop_val.as_object(),
        ) {
            let orig_keys: std::collections::HashSet<&String> = orig_obj.keys().collect();
            let extra: Vec<&String> = prop_obj
                .keys()
                .filter(|k| !orig_keys.contains(k))
                .collect();
            if !extra.is_empty() {
                let names: Vec<String> = extra.iter().map(|k| (*k).clone()).collect();
                return Err(format!(
                    "model added unknown top-level key(s) to site.json: {} — retry",
                    names.join(", ")
                ));
            }
        }
    }

    Ok(AiEditResponse {
        page,
        original_json,
        proposed_json,
        summary,
        model: CHAT_DEPLOY.to_string(),
        site_original_json,
        site_proposed_json,
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
    site_original: Option<&serde_json::Value>,
    user_prompt: &str,
) -> Result<(String, Option<String>, String), String> {
    let url = format!(
        "{AZURE_OPENAI_ENDPOINT}/openai/deployments/{CHAT_DEPLOY}/chat/completions?api-version={CHAT_API_VER}"
    );

    let contact_extra = if page == "contact" {
        "\n\
         CONTACT PAGE — EXTRA CONTEXT\n\
         The Contact page renders social links from `site.socials` (an open \
         dict of `{platform_key: url}`). The template iterates every key, so \
         you can add ANY platform the user asks for (instagram, tiktok, \
         youtube, linkedin, x, threads, whatsapp, etc.) by adding a new key \
         to `site.socials`. Use lowercase keys with no spaces. When adding \
         or removing a social link:\n\
         * Return the full replacement `site.json` in `site_content_json`.\n\
         * Also keep `site.same_as` (a JSON-LD array) in sync — add the new \
           URL if the user gave one, remove URLs whose platform was removed.\n\
         * Never rename or delete existing `site.socials` keys that the user \
           didn't ask to change.\n\
         * If the user's request only affects `contact.json` (heading, map, \
           aria labels), leave `site_content_json` empty (null).\n"
    } else if page == "about" {
        "\n\
         ABOUT PAGE — EXTRA CONTEXT\n\
         The About page supports an OPEN array `custom_sections` for any \
         extra headings the owner wants (e.g. Business Hours, Awards, \
         Testimonials, Enrolment steps). Each entry is:\n\
           { \"heading\": string,\n\
             \"type\": \"paragraph\" | \"bullets\",\n\
             \"paragraph\": string   // when type = paragraph\n\
             \"bullets\": [string]   // when type = bullets\n\
           }\n\
         When the user asks to add a new section that doesn't fit an \
         existing key (Vision, Mission, Team, Why choose us, Neighbourhoods), \
         APPEND a new entry to `custom_sections` — do NOT stuff it into an \
         unrelated bullet list. If `custom_sections` is missing, create it. \
         Keep existing custom sections in the order they appear unless the \
         user asks to reorder or remove one.\n"
    } else if page == "services" {
        "\n\
         SERVICES / PROGRAMS PAGE — EXTRA CONTEXT\n\
         Schema:\n\
           daycare_program { heading, paragraphs: [string], brochure_path, brochure_link_label }\n\
           waiting_list { heading, form_url, form_placeholder_text, form_height }\n\
           service_schema { name, service_type, audience_min_age (number), \
                            audience_max_age (number), description }\n\
         Rules:\n\
         * `daycare_program.paragraphs` is the ONLY place for new descriptive \
           paragraphs about the program. Append new paragraphs there; do not \
           create new top-level keys.\n\
         * `waiting_list.form_url` must remain a Google Forms embed URL \
           (`docs.google.com/forms/.../viewform?embedded=true`). If the user \
           gives a share URL, transform it to the embed form. `form_height` \
           is a numeric string in pixels (e.g. \"1400\").\n\
         * `service_schema` is SEO metadata (JSON-LD) — keep it terse, one \
           sentence for `description`. Ages are numbers, not strings.\n\
         * `brochure_link_label` is the visible text of the download link \
           (emoji OK). `brochure_path` is the repo-relative path — only change \
           it if the user says they've replaced the PDF at a different path.\n"
    } else if page == "seo" {
        "\n\
         SEO PAGE — EXTRA CONTEXT\n\
         Schema: { schema_version, pages: { <slug>: { path, title, description, \
         og_title, og_description, canonical_url, breadcrumb: [{name,item}], \
         robots? } }, sitemap_urls: [{loc, changefreq, priority}] }\n\
         Rules:\n\
         * `path`, `canonical_url`, `breadcrumb`, `robots` and `sitemap_urls` \
           are infrastructural — never change them unless the user explicitly \
           says a URL has moved.\n\
         * Keep every existing page slug in `pages`. Never drop a page.\n\
         * `title` is best under 60 characters (Google truncates longer). \
           `description` is best 70–160 characters. If the user asks to \
           shorten or lengthen, respect these targets.\n\
         * `og_title` and `og_description` usually mirror `title` and \
           `description`. When the user rewrites one, mirror the change to \
           the other unless they say otherwise.\n\
         * Match the daycare's voice: warm, factual, mention Vancouver / \
           Vancouver BC where natural for local SEO.\n"
    } else if page == "home" {
        "\n\
         HOME PAGE — EXTRA CONTEXT\n\
         Schema: { hero { heading, subtext, cta_label, cta_href }, \
         gallery_preview { heading, items: [{id, src, alt}] }, \
         stats: [string], faq { heading, items: [{id, question, answer}] } }\n\
         Rules:\n\
         * `hero.heading` is the biggest headline on the site — keep it short, \
           punchy, and audience-focused (parents of ages 30 months to 5 years).\n\
         * `hero.cta_href` links into the site (`pages/services.html#waiting-list` etc). \
           Never change it unless the user says the link target has moved.\n\
         * `gallery_preview.items` — `id` and `src` are photo file references — \
           NEVER change them. You may improve `alt` text (short, descriptive, \
           accessible). Never add or remove items unless the user explicitly \
           asks and specifies a new src path.\n\
         * `stats` is an array of exactly 3 short claims (e.g. \"1000+ Happy Families\"). \
           Keep count at 3 unless the user says otherwise. Each entry should be \
           terse — 3–6 words.\n\
         * `faq.items` — each entry needs a stable `id` (snake_case, e.g. \
           `faq_ages`). When adding a new FAQ, mint a new `id` that describes \
           the topic. Never drop existing FAQs the user didn't ask to remove.\n\
         * Keep answers 1–3 sentences, factual, warm.\n"
    } else if page == "site" {
        "\n\
         SITE (GLOBAL) — EXTRA CONTEXT\n\
         Schema: { name, tagline, brand { brand_color, brand_color_strong, \
         theme_color }, hire_link { label }, sticky_call { label }, nav: [\
         {label, path, key}], area_served: [{type, name}], footer { \
         copyright_holder, rights, contact_link_label }, plus MANY read-only \
         fields (address, phone, email, socials, assets, urls, a11y, sitemap, \
         cache_bust).\n\
         Rules:\n\
         * `address`, `phone`, `email`, `socials`, `same_as`, `geo` — DO NOT \
           edit here. These are owned by the Contact editor and duplicated \
           across the site. If the user asks to change them, tell them to use \
           the Contact page editor.\n\
         * `assets`, `urls`, `cache_bust`, `sitemap`, `a11y`, `robots_default`, \
           `schema_version` — read-only. NEVER touch.\n\
         * `brand.brand_color` and `brand.theme_color` should stay equal unless \
           the user explicitly asks for a different theme color.\n\
         * `brand.brand_color_strong` should be a visibly-darker shade of \
           `brand_color` — keep them harmonious.\n\
         * `nav[].path` and `nav[].key` are structural — only edit `label`. \
           Never add or remove nav items unless the user explicitly asks.\n\
         * `area_served[].type` is one of \"City\" or \"Neighborhood\". Names \
           should read as \"<Name>, Vancouver\" for neighborhoods.\n\
         * Keep tagline short (2–5 words) and copyright_holder = legal daycare \
           name.\n"
    } else if page == "gallery-videos" {
        "\n\
         GALLERY VIDEOS — EXTRA CONTEXT\n\
         Schema: { heading, intro, videos: [{id, filename, poster, ...}] }\n\
         Rules:\n\
         * You may edit `heading` (short — 1–3 words) and `intro` (1–2 sentence \
           caption above the playlist).\n\
         * The `videos` array is managed by the Gallery Videos media screen. \
           NEVER add, remove, or reorder video entries here. NEVER touch \
           `filename`, `poster`, or `id`.\n"
    } else {
        ""
    };

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
            `type_options`), or inside dict fields explicitly documented as \
            open (e.g. `site.socials` for the contact page).\n\
         2. If the user asks for something outside the schema (e.g. a new \
            top-level key or a style/visual change), reflect the intent in the \
            closest legal field and describe the gap in `summary`. Do not \
            invent keys.\n\
         3. Keep every existing item that the user did not explicitly ask to \
            change. Never silently drop jobs, locations, or filter options.\n\
         4. Copy tone: warm, professional, brief. Avoid emojis unless the \
            existing content uses them.\n\
         5. Return only the JSON object described in the response schema. No \
            prose, no markdown, no code fences.{contact_extra}"
    );

    let mut user_text = format!(
        "Current `{page}.json`:\n```json\n{}\n```\n\nUser request:\n{}",
        serde_json::to_string_pretty(original).unwrap_or_else(|_| original.to_string()),
        user_prompt,
    );
    if let Some(site_v) = site_original {
        user_text = format!(
            "Current `site.json` (shared site-wide data — socials, address, phone, email):\n```json\n{}\n```\n\n{}",
            serde_json::to_string_pretty(site_v).unwrap_or_else(|_| site_v.to_string()),
            user_text,
        );
    }

    // Structured output: model MUST return an object with `content_json` (the
    // new full JSON, as a string) plus a plain-English `summary`. For the
    // contact page it may also return `site_content_json` (nullable).
    let schema = if page == "contact" {
        json!({
            "type": "object",
            "properties": {
                "content_json": {
                    "type": "string",
                    "description": "The complete replacement JSON for contact.json, as a raw JSON-encoded string. Must parse via JSON.parse."
                },
                "site_content_json": {
                    "type": ["string", "null"],
                    "description": "Optional full replacement JSON for site.json when the user's request touches shared fields (socials, address, phone, email). Null when only contact.json changed."
                },
                "summary": {
                    "type": "string",
                    "description": "Brief plain-English recap of the changes made (2-4 sentences)."
                }
            },
            "required": ["content_json", "site_content_json", "summary"],
            "additionalProperties": false
        })
    } else {
        json!({
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
        })
    };

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
    let site_content_json = parsed["site_content_json"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());
    let summary = parsed["summary"]
        .as_str()
        .unwrap_or("(no summary provided)")
        .to_string();
    Ok((content_json, site_content_json, summary))
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
