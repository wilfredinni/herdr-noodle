# Optional Herdr development patches

These patches are source-development artifacts, not installable layout files. Do not copy them into the Herdr home, apply them automatically, or replace a user's Herdr application during a normal Noodle installation.

- `herdr-gutter.patch` adds `EditorState.set_gutter_marks` for Git change bars inside the writable editor. Noodle checks for this method and skips those marks if it is absent. Editing, native syntax highlighting and Cmd+S / Ctrl+S saving still work. Git Source preview indicators use the mod's own renderer and do not need this patch.
- `herdr-editor.patch` contains editor search/selection API development changes. The current simple file editor does not require this patch.

Both target specific files in Herdr's vendored GPUI source; the tested layout version does not guarantee that either patch applies to another source revision. A separately requested native build needs the matching Herdr source, its own build instructions and validation. Check patch applicability against that checkout before modifying it. Do not infer native API support from a successful mod render check; inspect the destination's generated type declarations and runtime capability.
