# Optional Herdr development patches

These patches are source-development artifacts, not installable layout files. Do not copy them into the Herdr home, apply them automatically, or replace a user's Herdr application during a normal Noodle installation.

- `herdr-gutter.patch` adds `EditorState.set_gutter_marks` for Git change bars inside the writable editor. Noodle checks for this method and skips those marks if it is absent. Editing, native syntax highlighting and Cmd+S / Ctrl+S saving still work. Git Source preview indicators use the mod's own renderer and do not need this patch.
- `herdr-editor.patch` contains editor search/selection API development changes. The current simple file editor does not require this patch.
- `herdr-search-highlights.patch` exposes native match highlighting and navigation to the file editor. Matches are yellow and the current match is orange, including while the find field has focus. It adds `EditorState.search(query, direction)` and `close_search()`. Released builds without these methods retain selection-only search.
- `herdr-preview-search.patch`, applied after the search-highlights patch, exposes retained Markdown with `TextViewState.markdown(text)` and `TextView.new(state)`. It reuses native rendered-text ranges for search highlighting and scrolling, preserving Markdown formatting, links, code blocks and selection. Diff, Source and Review search use the mod's existing row renderers.

The search patch targets the development checkout with `herdr-gutter.patch` already applied. It also restores the released `checking()` export needed by the current sidebar when using that older checkout.

These patches target specific files in Herdr's vendored GPUI source; the tested layout version does not guarantee that either patch applies to another source revision. A separately requested native build needs the matching Herdr source, its own build instructions and validation. Check patch applicability against that checkout before modifying it. Do not infer native API support from a successful mod render check; inspect the destination's generated type declarations and runtime capability.

Run `<development-herdr-app> check <this-repo>/native/search-check` to exercise the real native search bridge, including Unicode offsets, navigation, wraparound and unchanged text. For visual verification, show that check mod in an isolated app home and core session: all three occurrences should be yellow, with the second orange while the query field has focus. Keep the signed release app intact.

Run `<development-herdr-app> check <this-repo>/native/markdown-search-check` for Markdown search, including words across formatting, inline code, link labels, wraparound, invalid directions and released-state rejection. Link destinations are not rendered text and are not searched.

The tested macOS development build used Rust 1.95.0, Zig 0.16.0 and `CARGO_PROFILE_DEV_DEBUG=0`, with Cargo overrides `profile.dev.package.quickjs-jit-macro.debug=2` and `profile.dev.package.quickjs-jit-macro.strip="none"`. The overrides avoid a malformed proc-macro dylib from the macOS linker; they affect the build tool, not the editor's behavior.
