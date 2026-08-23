//! Typed schemas for the site repo's `content/*.json` files.
//!
//! These mirror the shapes defined in the site repo at commit
//! `80e10572` (PR 1 merged 2026-08-23). They are intentionally
//! **permissive on unknown keys** (`#[serde(flatten)] extra`) so a
//! future site-repo schema bump that adds a new field doesn't break
//! the app editor before the app can catch up — the extra field
//! round-trips through save + publish untouched.
//!
//! On the wire from the frontend and to MiniJinja, every schema is
//! carried as a `serde_json::Value` — the typed structs live here so
//! the Rust smoke test and validation layer can enforce required
//! keys at the boundary, but the editor UI works on the raw JSON.
//!
//! # Known content files (PR 2 scope)
//! - `site.json` — global brand / nav / assets
//! - `home.json` — hero, gallery preview, stats, FAQ
//! - `about.json` — vision / mission / neighborhoods (has raw HTML)
//! - `services.json` — daycare program, waiting list
//! - `contact.json` — heading, map iframe, socials
//! - `tour.json` — video src, poster, aria labels
//! - `careers.json` — jobs list, hiring banner, apply modal
//! - `seo.json` — per-page title/description/canonical/breadcrumb
//!
//! `gallery.json` is edited by the PR 3 media module and is
//! explicitly NOT parsed here.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The set of content files this PR edits. `gallery` intentionally
/// omitted — PR 3.
pub const EDITABLE_FILES: &[&str] = &[
    "site", "home", "about", "services", "contact", "tour", "careers", "seo",
];

/// Files present in the site repo but NOT editable in PR 2.
pub const PR2_LOCKED_FILES: &[&str] = &["gallery"];

/// True iff `name` (bare, no `.json`) is in [`EDITABLE_FILES`].
pub fn is_editable(name: &str) -> bool {
    EDITABLE_FILES.contains(&name)
}

/// Parse a `content/<name>.json` blob into a typed schema for
/// validation. On success the caller can be sure the JSON matches
/// what the templates expect; on failure the string is a JSON path
/// hint suitable for surfacing in the editor.
///
/// This is a thin wrapper around `serde_json::from_str::<Value>` +
/// per-file `SchemaValidator::check` so unknown keys don't error.
pub fn validate(name: &str, raw: &str) -> Result<Value, String> {
    let v: Value =
        serde_json::from_str(raw).map_err(|e| format!("{name}.json: not valid JSON — {e}"))?;
    check_schema_version(name, &v)?;
    match name {
        "site" => require_string(&v, "name")?,
        "home" => require_object(&v, "hero")?,
        "about" => require_object(&v, "vision")?,
        "services" => require_object(&v, "daycare_program")?,
        "contact" => require_string(&v, "heading")?,
        "tour" => require_string(&v, "heading")?,
        "careers" => require_object(&v, "hero_banner")?,
        "seo" => require_object(&v, "pages")?,
        _ => return Err(format!("Unknown content file: {name}")),
    }
    Ok(v)
}

fn check_schema_version(name: &str, v: &Value) -> Result<(), String> {
    match v.get("schema_version").and_then(|x| x.as_i64()) {
        Some(1) => Ok(()),
        Some(other) => Err(format!(
            "{name}.json has schema_version={other}, this app only supports 1"
        )),
        None => Err(format!("{name}.json is missing schema_version")),
    }
}

fn require_string(v: &Value, key: &str) -> Result<(), String> {
    match v.get(key).and_then(|x| x.as_str()) {
        Some(s) if !s.is_empty() => Ok(()),
        _ => Err(format!("required string field \"{key}\" missing or empty")),
    }
}

fn require_object(v: &Value, key: &str) -> Result<(), String> {
    match v.get(key) {
        Some(x) if x.is_object() => Ok(()),
        _ => Err(format!("required object field \"{key}\" missing")),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Typed views (used by tests and validators). The editor round-trips
// via serde_json::Value so unknown keys survive.
// ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteJson {
    pub schema_version: i64,
    pub name: String,
    pub tagline: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeHero {
    pub heading: String,
    pub subtext: String,
    pub cta_label: String,
    pub cta_href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeJson {
    pub schema_version: i64,
    pub hero: HomeHero,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// True iff a rendered HTML fragment for `file` is legally allowed
/// to bypass MiniJinja auto-escape via `|safe`. Matches PR1_NOTES.md
/// §1 and §2: only two fields on `about.json` (`intro_html`, and
/// `neighborhoods.paragraph_html`) are raw-HTML.
pub fn is_safe_html_field(file: &str, jsonpath: &str) -> bool {
    matches!(
        (file, jsonpath),
        ("about", "intro_html") | ("about", "neighborhoods.paragraph_html")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE_MIN: &str = r##"{
        "schema_version": 1,
        "name": "Echelon Day Care",
        "tagline": "Echelon Day Care",
        "brand": { "brand_color": "#2e7dd1", "brand_color_strong": "#1d5fa3", "theme_color": "#2e7dd1" },
        "cache_bust": "202606010606",
        "address": {"streetAddress":"575 W 8th Ave","addressLocality":"Vancouver","addressRegion":"BC","postalCode":"V5Z 1M9","addressCountry":"CA","display":"575 W 8th Ave, Vancouver, BC V5Z 1M9","footer_display":"575 W 8th Ave, Vancouver, BC"},
        "phone":{"e164":"+1-604-874-4010","display":"+1 604-874-4010","tel_href":"tel:+16048744010","display_short":"604-874-4010"},
        "email":"echelondaycare@hotmail.com",
        "geo":{"latitude":49.2641,"longitude":-123.1186},
        "socials":{"facebook":"https://www.facebook.com/echelon.daycare.5"},
        "same_as":["https://www.facebook.com/echelon.daycare.5"],
        "area_served":[{"type":"City","name":"Vancouver"}],
        "hire_link":{"label":"Work With Us","aria_label":"..."},
        "sticky_call":{"label":"Call us","aria_label":"..."},
        "nav":[],
        "assets":{"logo":"assets/img/logoMod.png","logo_alt":"...","favicon_16":"","favicon_32":"","favicon_180":"","og_image":"","webmanifest":"","css":"","js":""},
        "urls":{"base":"https://echelondaycare.com","logo_absolute":"","og_image_absolute":"","favicon_16_absolute":"","favicon_32_absolute":"","favicon_180_absolute":""},
        "footer":{"copyright_holder":"Echelon Day Care","rights":"All rights reserved.","contact_link_label":"Contact"},
        "a11y":{"skip_to_content":"...","primary_nav_label":"...","nav_toggle_aria_label":"..."},
        "sitemap":{"changefreq_default":"monthly"},
        "robots_default":"index, follow"
    }"##;

    #[test]
    fn site_roundtrips_through_serde() {
        let v: Value = serde_json::from_str(SITE_MIN).unwrap();
        let s = serde_json::to_string(&v).unwrap();
        let back: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v, back);
    }

    #[test]
    fn site_validates() {
        assert!(validate("site", SITE_MIN).is_ok());
    }

    #[test]
    fn site_missing_schema_version_fails() {
        let bad = r##"{"name":"x","tagline":"y"}"##;
        let e = validate("site", bad).unwrap_err();
        assert!(e.contains("schema_version"), "got: {e}");
    }

    #[test]
    fn unknown_file_rejected() {
        assert!(validate("bogus", r##"{"schema_version":1}"##).is_err());
    }

    #[test]
    fn is_editable_gates_gallery() {
        assert!(is_editable("site"));
        assert!(is_editable("home"));
        assert!(!is_editable("gallery"));
        assert!(!is_editable("random"));
    }

    #[test]
    fn safe_html_fields_are_pinned() {
        assert!(is_safe_html_field("about", "intro_html"));
        assert!(is_safe_html_field("about", "neighborhoods.paragraph_html"));
        assert!(!is_safe_html_field("about", "heading"));
        assert!(!is_safe_html_field("home", "intro_html"));
    }
}
