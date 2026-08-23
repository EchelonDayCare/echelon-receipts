//! Integration-test host for the `website_media` module.
//!
//! PR 3 groundwork ships `src-tauri/src/website_media/` as an isolated
//! module without touching `src-tauri/src/lib.rs` — the wiring goes in
//! after the parallel PR 2 (`feat/website-cms-core`) lands. Until then,
//! this file pulls the module in via `#[path]` so `cargo test --test
//! website_media` compiles and runs every unit test declared inside the
//! module files.
//!
//! Once `lib.rs` grows `pub mod website_media;` this file becomes
//! redundant and should be deleted — see `PR3_INTEGRATION.md`.

// The chrono/serde deps used by emergency_remove.rs are already in the
// crate manifest; we just need Cargo to link them into this test binary.
#[path = "../src/website_media/mod.rs"]
mod website_media;

// A no-op top-level test so `cargo test --test website_media` doesn't
// report "no tests" on some Rust versions when every real test lives
// inside `#[cfg(test)] mod tests` blocks inside the module files.
#[test]
fn website_media_module_loaded() {
    // If the module fails to compile this test won't even build, so
    // reaching this assertion means every `pub use` from `mod.rs`
    // resolved cleanly.
    assert_eq!(website_media::RECIPE_VERSION, 1);
}
