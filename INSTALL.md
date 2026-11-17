# Install Noodle in Herdr

Follow the target computer's Herdr `AGENTS.md`. Use `herdr-app --help` to locate its home; the usual Unix path is `~/.config/herdr-app`, and `HERDR_APP_HOME` can select another home. Read that home's `AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`, plus this repository's `RECIPE.md` and source before installing. Herdr 0.1.15 is the tested version; verify the APIs on other versions.

## Requirements

| Component | Required for |
| --- | --- |
| Herdr and its `herdr-app` / `hc` commands | Layout, panes and terminal tasks |
| Git and Python 3.9+ | Git panels, file operations, editing and recovery drafts |
| ripgrep (`rg`) | Quick Open and content search |
| `bash` and `bat` | Syntax colors in Diff, Source and File hunks; previews remain readable without them |
| GitHub CLI (`gh`), signed in by the user | Optional GitHub PRs, creation, reviews, workflows and logs |
| Supported, signed-in agent CLIs | Optional usage meters and commit/PR generation |

Run `herdr-app --version`, `git --version`, `python3 --version` and `rg --version` in the environment Herdr uses. Python helpers use only the standard library; there are no pip packages or Node dependencies to install. Node is needed only to run the development tests.

The full layout is tested on **macOS**. Linux is not fully validated; image previews use macOS's `sips` and `qlmanage`, and Reveal in Finder uses `open -R`. Windows is **not supported by the complete package**: shared helpers require Unix `fcntl` locks and `os.fchmod`, even though the folder-listing code has a PowerShell adapter. Remote Git browsing is separate from local helper features: the file editor, search, tasks, Review and image helpers are local-only. Do not advertise installing this bundle as enabling those features on another platform or machine.

## Search features and native requirements

Focus the file editor or Git file preview and press **Cmd+F / Ctrl+F** for literal, case-sensitive search. **Enter / Shift+Enter** or **Next / Previous** moves between matches and wraps at either end. **Escape** or **Close** closes the find field and clears search highlights. **Cmd+S / Ctrl+S** still saves in the editor. These shortcuts are bound inside the mods; no additional global find/save key bindings are needed.

| Surface | Standard installation | With the native search bridges |
| --- | --- | --- |
| File editor | Selects the current match; does not highlight every match | All matches yellow, current match orange, including while the find field has focus |
| Diff, Unified and Split | Yellow matches, orange current match, count and scrolling to the current match | Same behavior; no native search patch needed |
| Source and Review | Yellow matches, orange current match, count and scrolling to the current match | Same behavior; no native search patch needed |
| Rendered Markdown Preview | Markdown renders, but search is unavailable without the retained Markdown API | Searches rendered words with yellow/orange highlights, count and scrolling; formatting, links and code blocks remain intact |

The preview keeps the query when switching among Diff, Source, Review and Preview, and searches the content loaded for the active tab. Markdown search includes link labels and text across formatting, not Markdown delimiters or hidden link destinations. Preview search is bounded by the existing content limits: Source 5,000 lines/400,000 characters, Diff 1,500 lines and Markdown 200,000 characters. The editor supports local UTF-8 files up to 1 MiB.

Check the destination's generated declarations and actual runtime capabilities. Editor highlighting requires `EditorState.search(query, direction)` and `close_search()`. Markdown search requires `TextViewState.markdown(text)`, `TextView.new(state)` and the state's `search`, `status`, `close_search` and `release` methods. A version number or successful initial render check alone does not establish support. Copying the mods does not add these APIs to Herdr.

## Install the complete bundle

1. Read the code and explain its access before copying: the mods run Git, Python and installed CLIs; read the focused projects and local CLI sign-ins; and keep drafts under Herdr's `data/noodle/`. Usage, Generate and explicitly requested PR / CI queries can contact their providers. Installation itself must not run Generate, authenticate accounts, or modify project Git state.
2. Check **all** destination names before writing. Never overwrite an existing layout, mod, helper folder or preview during a new installation. Resolve collisions by renaming the incoming files and all their references. An update to existing files requires an explicit update request, a comparison with the installed version and a backup. Do not replace Herdr's shipped mods.
3. Copy the following entries, preserving their relative paths under the target Herdr home. `manifest.json` declares the layout, preview, helper directories, personal mods and reused shipped mods.

| Repository source | Destination under `<HerdrHome>` |
| --- | --- |
| `layouts/noodle.json` | `layouts/noodle.json` |
| `layouts/noodle.png` | `layouts/noodle.png` |
| `helpers/noodle/` | `helpers/noodle/` |
| Each of the seven `mods/<name>/` folders in `manifest.json` | `mods/<name>/` |

**The entire `helpers/noodle/` directory is required.** Installing only the mods can pass an initial render check while file editing and Review fail later. The helper modules import one another; do not copy just `workspace.py`.

The seven mods are `spaces-paths`, `files-browser`, `changes-graph`, `git-file-preview`, `file-editor`, `git-error` and `workspace-usage`. Reuse Herdr's shipped `workspace-chrome`, `tabs`, `pane` and `menu`, and its `worktree` dialog. Leave their folders untouched.

Leave root `preview.png`, documentation, tests, prototypes and `native/` outside the Herdr home. `layouts/noodle.png` is the layout's referenced Settings thumbnail and must be installed. Never copy `.git`, credentials, `.env` files, generated `.d.ts` / `jsconfig.json`, `__pycache__`, `data/`, `shared.json`, global settings, keys or `layouts/.state/` from the source machine. Herdr creates runtime state on the destination.

If a mod is renamed, update its layout references, self-opening mod names, asset paths and Python paths. If the helper folder is renamed, update every `helpers/noodle/` reference in the incoming mods. If the layout or thumbnail is renamed, update the layout's `preview` property. Check the whole mapping before copying anything.

## Validate on the destination

For Quick Open, merge `"cmd-p": "mod.open:files-browser"` into the existing
`"layout:noodle"` section of the destination's `keys.json` (`ctrl-p` on Linux).
Use the built-in `mod.open` command so the shortcut works when Files is hidden
or Changes is selected. Do not replace the rest of the user's key bindings.

Replace `<HerdrHome>` and any renamed mod/layout names in these commands:

```sh
for mod in spaces-paths files-browser changes-graph git-file-preview file-editor git-error workspace-usage; do
  herdr-app check "<HerdrHome>/mods/$mod" || exit 1
done
herdr-app do layout.switch '{"name":"noodle"}'
herdr-app status
```

Check that the Settings thumbnail exists and every helper file was copied. In a disposable project, open a local text file from Files, edit and save with Cmd+S / Ctrl+S, close and reopen it, and verify the exact saved text. Try Quick Open, content search and a Changes diff with Source and Review. Confirm that `herdr-app status` reports no errors after these interactions. Initial `check` success alone does not validate asynchronous helpers or saving. Do not exercise commit, discard, stash or branch mutations on the user's working repositories as an installation test.

Use a fixture with repeated words to check Cmd+F / Ctrl+F in the editor, Diff in both Unified and Split, Source, Review and a Markdown file's Preview tab. Check Next/Previous, Enter/Shift+Enter, wraparound, a query with no matches, and Escape. In the preview, retain the query across tab changes and verify that navigation reveals an offscreen match without losing syntax colors or Review controls. On a build with the native bridges, check all yellow matches and the orange current match while the find field has focus; in Markdown, also check formatted text and link labels. On a build without the bridges, expect selection-only editor search and no rendered Markdown search; use Source to search that Markdown file instead. The legacy Markdown find field may report “No matches” even for visible words, so do not treat that as a content check.

If `gh` is installed and signed in, open GitHub and check Pull requests and Workflows. New PR and its instructions dialog can be inspected without submitting. Do not click Generate or Create PR as an installation test; fixture tests cover those paths without provider calls or GitHub writes. PR creation/generation use a local checkout and private request files under `data/noodle/github/`.

The standard editor needs no native patch for editing, syntax highlighting or saving. Git gutter marks **inside the writable editor** appear only when Herdr exposes `EditorState.set_gutter_marks`; their absence does not affect Source preview indicators. See [native/README.md](native/README.md) for the optional development patches. Do not apply patches or rebuild Herdr during a normal layout installation.

## Optional native development build

For full editor highlighting and rendered Markdown search, use a Herdr build exposing the APIs above. If a native build is separately requested, read that source checkout's `AGENTS.md` and build instructions, and check patch applicability before modifying it. The patches target `herdrdev/herdr-app` commit `48ddb41ce4ba07073a6a4283f44608ac93644368`, not arbitrary Herdr releases. Clone the source with its submodules and initialize the submodules at that revision before building. On this baseline, apply these in order from the Herdr source root, using the patch files from this Noodle repository and checking each with `git apply --check` before applying it:

1. `native/herdr-gutter.patch` establishes the gutter API baseline expected by the search patch.
2. `native/herdr-search-highlights.patch` adds editor search highlights and restores the `checking()` export needed by the sidebar on that older checkout.
3. `native/herdr-preview-search.patch` adds retained rendered Markdown search.

Do not also apply the older `native/herdr-editor.patch`; it is not part of this sequence. If a capability is already present or a patch does not apply, compare the source and APIs rather than forcing or reapplying the patch.

The tested macOS build used **Rust 1.95.0**, **Zig 0.16.0**, the checkout's locked dependencies and its platform build prerequisites. From the matching Herdr source root, with `ZIG` pointing to the Zig executable:

```sh
ZIG=/absolute/path/to/zig CARGO_PROFILE_DEV_DEBUG=0 \
  cargo +1.95.0 \
  --config 'profile.dev.package.quickjs-jit-macro.debug=2' \
  --config 'profile.dev.package.quickjs-jit-macro.strip="none"' \
  build --locked
```

The package overrides avoid the malformed proc-macro dylib produced by the tested macOS linker configuration. An offline build additionally needs all dependencies cached. Follow the source checkout's instructions for packaging a separate development application; keep the signed release app intact. Test with an isolated Herdr home and core session, and do not launch a bare development binary against the user's real home. Reopening the user's main window with that build requires an explicit request. A normal layout copy neither installs nor updates this custom binary.

Using that development executable and the isolated environment, run:

```sh
<development-herdr-app> check <this-repo>/native/search-check
<development-herdr-app> check <this-repo>/native/markdown-search-check
```

Then perform the visual search checks above in the running development app. These native self-checks cover Unicode, navigation, wraparound and rendered Markdown behavior; initial render checks alone do not verify colors, focus or scrolling. See [native/README.md](native/README.md) for the bridge details.

## Remove the installation

Switch to another layout first, for example `herdr-app do layout.switch '{"name":"main"}'`. Remove only the installed personal layout, thumbnail, mods and helper directory from the recorded file mapping, after checking that no other layout uses them. Keep recovery drafts in `data/noodle/` unless the user separately asks to delete them. Keep Herdr's shipped files, settings and keys.
