//! MiniJinja renderer for the Echelon Day Care site.
//!
//! Reads content JSON + templates from the working-copy on disk and
//! produces the same HTML the site-repo `scripts/render.py` produces
//! (byte-close, semantic-identical). See PR1_NOTES.md § "Deterministic
//! output" — LF newlines, 2-space JSON indent, `tojson(indent=2)` for
//! all JSON-LD blocks.
//!
//! # Why not just shell out to Python?
//! We don't want to depend on a system Python at edit time, and we
//! want the preview to be instant. MiniJinja is a Rust-native Jinja2
//! dialect that supports everything the templates use: `{% extends %}`,
//! `{% include %}`, `{% raw %}`, `{% block %}`, filters (`safe`,
//! `tojson`, `map`, `attribute`), and StrictUndefined. Autoescape is
//! ON for `.html` and `.j2` files.
//!
//! # PR 2 acceptable weakness
//! Line-by-line HTML output may not be byte-identical to the
//! committed `.html` files in the site repo. Publish validation
//! compares parsed DOM well-formedness rather than raw bytes; the
//! site repo's `scripts/validate.py` (run in CI) is the authoritative
//! parity check.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use minijinja::{Environment, UndefinedBehavior, Value as MjValue};
use serde_json::{Map, Value};

/// A pre-loaded working-copy view of `content/*.json` + templates.
///
/// Callers build one of these per render run; construction reads
/// every content file into memory so downstream page renders don't
/// re-hit disk.
pub struct RenderInputs {
    /// Base of the working copy (contains `content/`, `templates/`,
    /// `manifests/`, `pages/`).
    pub repo_root: PathBuf,
    /// Loaded content, keyed by file stem (`"site"`, `"home"`, ...).
    pub content: BTreeMap<String, Value>,
}

impl RenderInputs {
    /// Load `content/*.json` from `repo_root` into memory.
    ///
    /// Errors on IO failure or malformed JSON. If a specific
    /// `overrides` map is passed, those entries replace the disk
    /// version for that file (used when previewing an unsaved draft
    /// without rewriting the working copy).
    pub fn load(
        repo_root: &Path,
        overrides: BTreeMap<String, Value>,
    ) -> Result<Self, String> {
        let content_dir = repo_root.join("content");
        if !content_dir.is_dir() {
            return Err(format!(
                "content dir not found at {}",
                content_dir.display()
            ));
        }
        let mut content = BTreeMap::new();
        for entry in std::fs::read_dir(&content_dir)
            .map_err(|e| format!("read content dir: {e}"))?
        {
            let entry = entry.map_err(|e| format!("read entry: {e}"))?;
            let path = entry.path();
            if path
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| e.eq_ignore_ascii_case("json"))
                != Some(true)
            {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            let val: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("parse {}: {e}", path.display()))?;
            content.insert(stem, val);
        }
        for (k, v) in overrides {
            content.insert(k, v);
        }
        Ok(Self {
            repo_root: repo_root.to_path_buf(),
            content,
        })
    }

    /// Path to the `templates/` dir the MiniJinja loader will use.
    pub fn templates_dir(&self) -> PathBuf {
        self.repo_root.join("templates")
    }
}

/// Configure a MiniJinja env with the same defaults `render.py` uses.
///
/// - Autoescape ON for `.html` and `.j2`.
/// - `undefined_behavior = Strict` — matches Jinja2's
///   `StrictUndefined` so a typo like `about.hedaing` is caught at
///   render time, not silently rendered empty.
/// - FileSystemLoader points at `templates_dir`.
pub fn make_env(templates_dir: &Path) -> Environment<'static> {
    let mut env = Environment::new();
    // Safe template loader: canonicalize root, reject any resolved
    // path outside root, reject symlinks anywhere in the resolved
    // path. Replaces MiniJinja's default `path_loader` which followed
    // symlinks — a hostile repo could commit
    // `templates/leak.html.j2` -> `../../../.ssh/id_rsa` and get the
    // file contents rendered into HTML.
    let root_canon = templates_dir.canonicalize().unwrap_or_else(|_| templates_dir.to_path_buf());
    env.set_loader(move |name: &str| -> Result<Option<String>, minijinja::Error> {
        // Reject `..`, absolute paths, and NUL bytes.
        if name.contains('\0') || name.starts_with('/') || name.starts_with('\\') {
            return Ok(None);
        }
        for seg in name.split(['/', '\\']) {
            if seg == ".." || seg.starts_with('.') && seg != "." && seg.len() > 1 && !seg.contains('.') {
                // Reject `..` explicitly. Allow ordinary hidden files
                // (unlikely in templates but harmless).
                if seg == ".." {
                    return Ok(None);
                }
            }
        }
        let candidate = root_canon.join(name);
        // Reject if any component along the resolved path is a symlink.
        let mut probe = root_canon.clone();
        for part in candidate.strip_prefix(&root_canon).unwrap_or(&candidate).components() {
            probe = probe.join(part.as_os_str());
            match std::fs::symlink_metadata(&probe) {
                Ok(m) if m.file_type().is_symlink() => {
                    return Ok(None);
                }
                Ok(_) => {}
                // The final path is checked below via canonicalize.
                Err(_) => break,
            }
        }
        // Canonicalize the final path and confirm containment under root.
        let final_canon = match candidate.canonicalize() {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };
        if !final_canon.starts_with(&root_canon) {
            return Ok(None);
        }
        match std::fs::read_to_string(&final_canon) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(minijinja::Error::new(
                minijinja::ErrorKind::TemplateNotFound,
                format!("read template {}: {e}", final_canon.display()),
            )),
        }
    });
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.set_auto_escape_callback(|name| {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".html")
            || lower.ends_with(".htm")
            || lower.ends_with(".xml")
            || lower.ends_with(".j2")
            || lower.contains(".html.")
        {
            minijinja::AutoEscape::Html
        } else {
            minijinja::AutoEscape::None
        }
    });
    env
}

/// Build the per-page context that mirrors
/// `render.py::make_page_context` closely enough for MiniJinja to
/// render the templates unchanged.
///
/// `page_key` is one of: `index`, `about`, `services`, `gallery`,
/// `contact`, `tour`, `careers`, `not_found`.
pub fn build_page_context(
    page_key: &str,
    content: &BTreeMap<String, Value>,
) -> Result<Value, String> {
    let site = content
        .get("site")
        .ok_or_else(|| "content/site.json missing".to_string())?
        .clone();
    let seo = content
        .get("seo")
        .ok_or_else(|| "content/seo.json missing".to_string())?
        .clone();

    let seo_page = seo
        .get("pages")
        .and_then(|p| p.get(page_key))
        .cloned()
        .ok_or_else(|| format!("seo.pages.{page_key} missing"))?;

    let page_path = seo_page
        .get("path")
        .and_then(|p| p.as_str())
        .ok_or_else(|| format!("seo.pages.{page_key}.path missing"))?;
    let depth = page_path.matches('/').count();
    let asset_prefix = "../".repeat(depth);
    let from_dir: String = if let Some(idx) = page_path.rfind('/') {
        page_path[..idx].to_string()
    } else {
        String::new()
    };

    let link_to = |target: &str| -> String {
        if from_dir.is_empty() {
            target.to_string()
        } else {
            rel_path(&from_dir, target)
        }
    };

    let nav = site.get("nav").and_then(|n| n.as_array()).cloned().unwrap_or_default();
    let active_nav_key = active_nav_key_for(page_key);
    let nav_items: Vec<Value> = nav
        .into_iter()
        .map(|item| {
            let label = item.get("label").cloned().unwrap_or(Value::Null);
            let key = item.get("key").and_then(|k| k.as_str()).unwrap_or("");
            let target = item.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let mut m = Map::new();
            m.insert("label".into(), label);
            m.insert("href".into(), Value::String(link_to(target)));
            m.insert("active".into(), Value::Bool(Some(key) == active_nav_key));
            Value::Object(m)
        })
        .collect();

    let contact_href = link_to("pages/contact.html");
    let careers_href = link_to("pages/careers.html");

    let area_served_entries = if page_key == "index" {
        site.get("area_served")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default()
    } else {
        vec![serde_json::json!({"type": "City", "name": "Vancouver"})]
    };
    let childcare_schema = build_childcare_schema(&site, &area_served_entries);

    let mut ctx = Map::new();
    ctx.insert("site".into(), site.clone());
    ctx.insert("seo".into(), seo_page.clone());
    ctx.insert("asset_prefix".into(), Value::String(asset_prefix));
    ctx.insert("nav_items".into(), Value::Array(nav_items));
    ctx.insert("contact_href".into(), Value::String(contact_href));
    ctx.insert("careers_href".into(), Value::String(careers_href));
    ctx.insert("childcare_schema".into(), childcare_schema);

    if let Some(bc) = seo_page.get("breadcrumb").and_then(|b| b.as_array()) {
        if !bc.is_empty() {
            ctx.insert("breadcrumb_schema".into(), build_breadcrumb_schema(bc));
        }
    }

    match page_key {
        "index" => {
            if let Some(home) = content.get("home") {
                ctx.insert("home".into(), home.clone());
                if let Some(items) = home
                    .get("faq")
                    .and_then(|f| f.get("items"))
                    .and_then(|i| i.as_array())
                {
                    ctx.insert("faq_schema".into(), build_faq_schema(items));
                }
            }
        }
        "about" => {
            if let Some(v) = content.get("about") {
                ctx.insert("about".into(), v.clone());
            }
        }
        "services" => {
            if let Some(v) = content.get("services") {
                ctx.insert("services".into(), v.clone());
                if let Some(svc) = v.get("service_schema") {
                    ctx.insert("service_schema".into(), build_service_schema(&site, svc));
                }
            }
        }
        "gallery" => {
            if let Some(v) = content.get("gallery") {
                ctx.insert("gallery".into(), v.clone());
            }
        }
        "gallery-photos" => {
            // Photos page reuses the existing gallery.json content.
            if let Some(v) = content.get("gallery") {
                ctx.insert("gallery".into(), v.clone());
            }
        }
        "gallery-videos" => {
            if let Some(v) = content.get("gallery-videos") {
                ctx.insert("gallery_videos".into(), v.clone());
            }
        }
        "contact" => {
            if let Some(v) = content.get("contact") {
                ctx.insert("contact".into(), v.clone());
            }
        }
        "tour" => {
            if let Some(v) = content.get("tour") {
                ctx.insert("tour".into(), v.clone());
            }
        }
        "careers" => {
            if let Some(v) = content.get("careers") {
                ctx.insert("careers".into(), v.clone());
            }
        }
        _ => {}
    }
    Ok(Value::Object(ctx))
}

fn active_nav_key_for(page_key: &str) -> Option<&'static str> {
    match page_key {
        "index" => Some("home"),
        "about" => Some("about"),
        "services" => Some("services"),
        "gallery" => Some("gallery"),
        "gallery-photos" => Some("gallery"),
        "gallery-videos" => Some("gallery"),
        "contact" => Some("contact"),
        "tour" => Some("tour"),
        "careers" => Some("careers"),
        _ => None,
    }
}

/// Compute the relative path from `from_dir` to `target`, matching
/// Python's `os.path.relpath(target, from_dir)` behaviour on POSIX.
/// Both inputs are `/`-separated repo-relative paths.
fn rel_path(from_dir: &str, target: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = target.split('/').filter(|s| !s.is_empty()).collect();
    let mut common = 0usize;
    while common < from.len() && common < to.len() && from[common] == to[common] {
        common += 1;
    }
    let up = from.len() - common;
    let mut parts: Vec<String> = (0..up).map(|_| "..".to_string()).collect();
    parts.extend(to[common..].iter().map(|s| s.to_string()));
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

// ─────────────────────────────────────────────────────────────────────
// Schema builders — mirror render.py::build_*_schema
// ─────────────────────────────────────────────────────────────────────

fn build_postal_address(site: &Value) -> Value {
    let a = site.get("address").cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "@type": "PostalAddress",
        "streetAddress": a.get("streetAddress").cloned().unwrap_or(Value::Null),
        "addressLocality": a.get("addressLocality").cloned().unwrap_or(Value::Null),
        "addressRegion": a.get("addressRegion").cloned().unwrap_or(Value::Null),
        "postalCode": a.get("postalCode").cloned().unwrap_or(Value::Null),
        "addressCountry": a.get("addressCountry").cloned().unwrap_or(Value::Null),
    })
}

fn build_geo(site: &Value) -> Value {
    let g = site.get("geo").cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "@type": "GeoCoordinates",
        "latitude": g.get("latitude").cloned().unwrap_or(Value::Null),
        "longitude": g.get("longitude").cloned().unwrap_or(Value::Null),
    })
}

fn build_area_served(entries: &[Value]) -> Value {
    if entries.len() == 1 {
        let e = &entries[0];
        return serde_json::json!({
            "@type": e.get("type").cloned().unwrap_or(Value::Null),
            "name": e.get("name").cloned().unwrap_or(Value::Null),
        });
    }
    Value::Array(
        entries
            .iter()
            .map(|e| {
                serde_json::json!({
                    "@type": e.get("type").cloned().unwrap_or(Value::Null),
                    "name": e.get("name").cloned().unwrap_or(Value::Null),
                })
            })
            .collect(),
    )
}

fn build_childcare_schema(site: &Value, area_served: &[Value]) -> Value {
    let urls = site.get("urls").cloned().unwrap_or(Value::Null);
    let base = urls.get("base").and_then(|b| b.as_str()).unwrap_or("");
    let logo_absolute = urls
        .get("logo_absolute")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    serde_json::json!({
        "@context": "https://schema.org",
        "@type": "ChildCare",
        "name": site.get("name").cloned().unwrap_or(Value::Null),
        "url": format!("{base}/"),
        "logo": logo_absolute,
        "image": logo_absolute,
        "telephone": site.get("phone").and_then(|p| p.get("e164")).cloned().unwrap_or(Value::Null),
        "email": site.get("email").cloned().unwrap_or(Value::Null),
        "address": build_postal_address(site),
        "geo": build_geo(site),
        "areaServed": build_area_served(area_served),
        "sameAs": site.get("same_as").cloned().unwrap_or_else(|| Value::Array(vec![])),
    })
}

fn build_breadcrumb_schema(entries: &[Value]) -> Value {
    let items: Vec<Value> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| {
            serde_json::json!({
                "@type": "ListItem",
                "position": i + 1,
                "name": e.get("name").cloned().unwrap_or(Value::Null),
                "item": e.get("item").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    serde_json::json!({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": items,
    })
}

fn build_faq_schema(items: &[Value]) -> Value {
    let entities: Vec<Value> = items
        .iter()
        .map(|q| {
            serde_json::json!({
                "@type": "Question",
                "name": q.get("question").cloned().unwrap_or(Value::Null),
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": q.get("answer").cloned().unwrap_or(Value::Null),
                }
            })
        })
        .collect();
    serde_json::json!({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": entities,
    })
}

fn build_service_schema(site: &Value, svc: &Value) -> Value {
    let base = site
        .get("urls")
        .and_then(|u| u.get("base"))
        .and_then(|b| b.as_str())
        .unwrap_or("");
    serde_json::json!({
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": svc.get("service_type").cloned().unwrap_or(Value::Null),
        "name": svc.get("name").cloned().unwrap_or(Value::Null),
        "provider": {
            "@type": "ChildCare",
            "name": site.get("name").cloned().unwrap_or(Value::Null),
            "url": format!("{base}/"),
            "telephone": site.get("phone").and_then(|p| p.get("e164")).cloned().unwrap_or(Value::Null),
            "address": build_postal_address(site),
        },
        "areaServed": {"@type": "City", "name": "Vancouver"},
        "audience": {
            "@type": "PeopleAudience",
            "suggestedMinAge": svc.get("audience_min_age").cloned().unwrap_or(Value::Null),
            "suggestedMaxAge": svc.get("audience_max_age").cloned().unwrap_or(Value::Null),
        },
        "description": svc.get("description").cloned().unwrap_or(Value::Null),
    })
}

// ─────────────────────────────────────────────────────────────────────
// Public render entry points
// ─────────────────────────────────────────────────────────────────────

/// Descriptor for a single page render.
#[derive(Debug, Clone)]
pub struct PageRender {
    pub key: &'static str,
    pub template: &'static str,
    pub output: &'static str,
}

/// The 8 pages the site repo templates cover. `gallery` is included
/// because the render pipeline still emits it even though PR 2
/// disables editing.
pub const ALL_PAGES: &[PageRender] = &[
    PageRender { key: "index",     template: "index.html.j2",           output: "index.html" },
    PageRender { key: "about",     template: "pages/about.html.j2",     output: "pages/about.html" },
    PageRender { key: "services",  template: "pages/services.html.j2",  output: "pages/services.html" },
    PageRender { key: "gallery",   template: "pages/gallery.html.j2",   output: "pages/gallery.html" },
    PageRender { key: "gallery-photos", template: "pages/gallery-photos.html.j2", output: "pages/gallery-photos.html" },
    PageRender { key: "gallery-videos", template: "pages/gallery-videos.html.j2", output: "pages/gallery-videos.html" },
    PageRender { key: "contact",   template: "pages/contact.html.j2",   output: "pages/contact.html" },
    PageRender { key: "tour",      template: "pages/tour.html.j2",      output: "pages/tour.html" },
    PageRender { key: "careers",   template: "pages/careers.html.j2",   output: "pages/careers.html" },
    PageRender { key: "not_found", template: "404.html.j2",             output: "404.html" },
];

/// Render every page in [`ALL_PAGES`] into `out_dir`. Skips any page
/// whose template isn't found on disk — matches render.py's
/// "incremental build-out" fallback so a partial site repo checkout
/// still previews the pages it does have.
///
/// Returns the list of written page keys and their relative output
/// paths (for the preview server and validator).
pub fn render_all(
    inputs: &RenderInputs,
    out_dir: &Path,
) -> Result<Vec<(String, PathBuf)>, String> {
    let env = make_env(&inputs.templates_dir());
    let mut written = Vec::new();
    // Compute a single "templates fingerprint" that hashes EVERY file
    // under `templates/` — not just `base.html.j2` — so an edit to
    // any partial (header, nav, footer, head_meta, head_extras) or to
    // base.html.j2 itself invalidates every page's cached stamp. The
    // prior implementation read `base.html` (nonexistent — the actual
    // file is `base.html.j2`) which always yielded empty bytes, and
    // never hashed partials at all. That silently kept cache hits
    // when templates were edited, and stale HTML was committed to
    // the repo on the next publish.
    let templates_fingerprint = hash_templates_tree(&inputs.templates_dir());
    for page in ALL_PAGES {
        let tmpl_path = inputs.templates_dir().join(page.template);
        if !tmpl_path.exists() {
            continue;
        }
        let out_path = out_dir.join(page.output);
        let ctx = build_page_context(page.key, &inputs.content)?;
        let stamp = compute_render_stamp(page.key, &ctx, &tmpl_path, &templates_fingerprint);
        let stamp_path = out_path.with_extension("stamp");
        let cache_hit = out_path.exists()
            && std::fs::read_to_string(&stamp_path)
                .map(|s| s.trim() == stamp)
                .unwrap_or(false);
        if !cache_hit {
            let tmpl = env
                .get_template(page.template)
                .map_err(|e| format!("load template {}: {e}", page.template))?;
            let mj_ctx: MjValue = MjValue::from_serialize(&ctx);
            let html = tmpl
                .render(mj_ctx)
                .map_err(|e| format!("render {}: {e}", page.template))?;
            let html = normalize_lf(&html);
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            std::fs::write(&out_path, html.as_bytes())
                .map_err(|e| format!("write {}: {e}", out_path.display()))?;
            let _ = std::fs::write(&stamp_path, stamp.as_bytes());
        }
        written.push((page.key.to_string(), PathBuf::from(page.output)));
    }
    if let Some(jobs_path) = write_jobs_json(&inputs.content, out_dir)? {
        written.push(("careers_jobs".to_string(), jobs_path));
    }
    Ok(written)
}

/// Hash every regular file under `templates_dir` into a single
/// fingerprint used to invalidate the render cache. Symlinks are
/// resolved by the walk but not followed outside the tree — the
/// template loader itself rejects out-of-root paths (see
/// `make_env`). Order is stabilized by sorting relative paths so
/// two runs on the same tree always produce identical fingerprints.
fn hash_templates_tree(templates_dir: &Path) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for entry in walkdir::WalkDir::new(templates_dir)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(templates_dir) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        entries.push((rel, entry.path().to_path_buf()));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut h = Sha256::new();
    for (rel, path) in &entries {
        h.update(rel.as_bytes());
        h.update([0u8]);
        let bytes = std::fs::read(path).unwrap_or_default();
        h.update(&bytes);
        h.update([0u8]);
    }
    h.finalize().to_vec()
}

fn compute_render_stamp(
    page_key: &str,
    ctx: &serde_json::Value,
    tmpl_path: &Path,
    templates_fingerprint: &[u8],
) -> String {
    use sha2::{Digest, Sha256};
    let ctx_bytes = serde_json::to_vec(ctx).unwrap_or_default();
    let tmpl_bytes = std::fs::read(tmpl_path).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(page_key.as_bytes());
    h.update([0u8]);
    h.update(&ctx_bytes);
    h.update([0u8]);
    h.update(&tmpl_bytes);
    h.update([0u8]);
    h.update(templates_fingerprint);
    let digest = h.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Emit `assets/data/jobs.json` from `content.careers.jobs`. Field order
/// mirrors the Python renderer so committed diffs stay minimal.
fn write_jobs_json(
    content: &std::collections::BTreeMap<String, serde_json::Value>,
    out_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    let Some(careers) = content.get("careers") else {
        return Ok(None);
    };
    let Some(jobs) = careers.get("jobs").and_then(|v| v.as_array()) else {
        return Ok(None);
    };
    const FIELD_ORDER: &[&str] = &[
        "id", "title", "category", "type", "location", "short", "details", "datePosted",
    ];
    let mut ordered: Vec<serde_json::Value> = Vec::with_capacity(jobs.len());
    for j in jobs {
        let Some(obj) = j.as_object() else { continue };
        let mut ord = serde_json::Map::new();
        for k in FIELD_ORDER {
            if let Some(v) = obj.get(*k) {
                ord.insert((*k).to_string(), v.clone());
            }
        }
        ordered.push(serde_json::Value::Object(ord));
    }
    let rel = PathBuf::from("assets").join("data").join("jobs.json");
    let out_path = out_dir.join(&rel);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let mut text = serde_json::to_string_pretty(&serde_json::Value::Array(ordered))
        .map_err(|e| format!("serialize jobs.json: {e}"))?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(&out_path, text.as_bytes())
        .map_err(|e| format!("write {}: {e}", out_path.display()))?;
    Ok(Some(rel))
}

fn normalize_lf(s: &str) -> String {
    let mut out = s.replace("\r\n", "\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn rel_path_matches_python_relpath() {
        assert_eq!(rel_path("pages", "index.html"), "../index.html");
        assert_eq!(rel_path("pages", "pages/about.html"), "about.html");
        assert_eq!(rel_path("", "index.html"), "index.html");
        assert_eq!(rel_path("", "pages/about.html"), "pages/about.html");
    }

    #[test]
    fn active_nav_key_is_stable() {
        assert_eq!(active_nav_key_for("index"), Some("home"));
        assert_eq!(active_nav_key_for("not_found"), None);
    }

    #[test]
    fn normalize_lf_ends_with_newline() {
        assert_eq!(normalize_lf("x"), "x\n");
        assert_eq!(normalize_lf("x\r\n"), "x\n");
        assert_eq!(normalize_lf("x\n"), "x\n");
    }

    // Smoke render test with a minimal fixture — see
    // src-tauri/tests/fixtures/website/. Exercises MiniJinja against
    // a template that uses filters and `|safe`.
    #[test]
    fn smoke_render_minimal_template_reads_site_json() {
        let fixtures = fixtures_root();
        let inputs = RenderInputs::load(&fixtures, BTreeMap::new()).unwrap();
        assert!(inputs.content.contains_key("site"));

        let env = make_env(&inputs.templates_dir());
        let tmpl = env.get_template("minimal.html.j2").unwrap();
        let ctx = serde_json::json!({
            "site": inputs.content["site"],
        });
        let mj_ctx: MjValue = MjValue::from_serialize(&ctx);
        let out = tmpl.render(mj_ctx).unwrap();
        assert!(out.contains("Echelon Day Care"), "output was: {out}");
    }

    fn fixtures_root() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("website")
    }

    #[test]
    fn write_jobs_json_mirrors_careers_jobs_with_python_field_order() {
        let mut content = BTreeMap::new();
        content.insert(
            "careers".to_string(),
            serde_json::json!({
                "jobs": [
                    {
                        "id": "J001",
                        "title": "Educator",
                        "category": "Teaching",
                        "type": "Full-time",
                        "location": "Vancouver",
                        "short": "s",
                        "details": "d",
                        "datePosted": "2026-01-01",
                        "extra_ignored": "nope"
                    },
                    {
                        "id": "J002",
                        "title": "Cook",
                        "type": "Casual",
                        "location": "Vancouver",
                        "short": "s2",
                        "details": "d2",
                        "datePosted": "2026-08-23"
                    }
                ]
            }),
        );
        let tmp = tempfile::tempdir().unwrap();
        let out = write_jobs_json(&content, tmp.path()).unwrap().unwrap();
        assert_eq!(out, PathBuf::from("assets/data/jobs.json"));
        let raw = std::fs::read_to_string(tmp.path().join(&out)).unwrap();
        assert!(raw.ends_with('\n'));
        // Field order and dropped-extra check via textual position.
        let j1 = raw.find("\"J001\"").unwrap();
        let title1 = raw.find("\"Educator\"").unwrap();
        let cat1 = raw.find("\"Teaching\"").unwrap();
        assert!(j1 < title1 && title1 < cat1);
        assert!(!raw.contains("extra_ignored"));
        // Second job omits "category" cleanly.
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 2);
        assert!(parsed[1].get("category").is_none());
        assert_eq!(parsed[1]["title"], "Cook");
    }

    #[test]
    fn write_jobs_json_returns_none_when_no_careers() {
        let content = BTreeMap::new();
        let tmp = tempfile::tempdir().unwrap();
        let out = write_jobs_json(&content, tmp.path()).unwrap();
        assert!(out.is_none());
        assert!(!tmp.path().join("assets/data/jobs.json").exists());
    }
}
