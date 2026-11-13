# Herdr Noodle

A compact Herdr layout for coding agents, browsing files, reviewing Git changes, and generating commit messages through your existing AI connections.

![Noodle layout](preview.png)

- Spaces show their folder below the name, beside a two-line initial avatar.
- Files have Git status colors and file-type icons. Files, diffs, and rendered Markdown open beside your terminal.
- Changes, History, and Git Graph share one panel. Select files, review diffs, create or switch branches, and use the Fetch menu.
- A borderless three-line commit area has compact, right-aligned **Commit** and **Generate** controls. Choose a connection, then its available model.
- The footer shows compact subscription usage meters with consistent green, warning, and red colors.

The preview uses fictional demo content rather than anyone's workspaces, terminal history, credentials, or account usage.

## Install

Start Herdr once so its shipped mods and icons exist. Read [RECIPE.md](RECIPE.md) and the included source before installing; mods are trusted executable code.

Requirements: Herdr **0.1.15** (the tested version), Git, and Python **3.9+**. `bash` and `bat` are optional for syntax-colored previews; source and diffs still open without `bat`. AI features require a supported installed and signed-in CLI.

From this repository:

```sh
python3 install.py
herdr-app do layout.switch '{"name":"noodle"}'
```

The installer copies `layouts/noodle.json`, its preview, and the six folders under `mods/`. It refuses every existing name before copying anything. It never replaces Herdr's shipped mods, your settings, key bindings, spaces, or account files. For another configuration folder, use `python3 install.py --home /path/to/herdr-app`.

If a name conflicts, rename the incoming layout or mod and update its references as described in your own `~/.config/herdr-app/AGENTS.md`. Do not overwrite someone else's customized mod. This installer deliberately has no overwrite/update option.

You can also ask an agent to read your Herdr `AGENTS.md`, then install this repository following its sharing instructions.

## Commit behavior

Checkboxes represent the real Git index, not a separate selection. With checked files, Commit uses their staged content and preserves unstaged hunks. With nothing checked, Commit stages and commits all changed files in the reviewed file list, including new files and deletions. A message is required.

Generate follows the same scope: checked files use their staged changes; no checked files includes all working changes. It only fills the text area. It does not stage files or commit. A changed draft, repository, branch, or selection prevents an obsolete result from replacing your current work. Large diffs over 60,000 UTF-8 bytes require a smaller selection.

Only Generate spins during generation. Fetch spins for actions from Fetch and its menu, including Pull and Push. Selecting files and switching branches leave those indicators still.

## Connections and access

Usage reads the CLI sign-ins for Codex, Claude, OpenCode, and Kiro. Missing installations are grouped at the end of the usage popup. Kiro currently has **no structured quota adapter**; Claude's internal usage interface can change. API estimates and account classification are not displayed.

Commit generation supports native Codex and the connected model providers exposed by OpenCode, including **OpenCode Go**. It discovers models instead of bundling a fixed catalog, remembers the selection, and does not silently switch accounts or models. Claude and Kiro generation adapters are not implemented. Tested with Codex CLI **0.167.2** and OpenCode **2.2.7**; provider interfaces and quota availability depend on the installed CLI version.

The usage collector runs Python and the installed CLIs, and those CLIs may contact their providers. Generate sends the selected diff to the connection you choose. Codex runs an ephemeral, read-only invocation from a neutral temporary folder with tool features disabled. OpenCode uses its stateless text-generation endpoint. Its current CLI accepts the request body through process arguments, so the prompt can be visible to local process inspection while running.

Git actions run normal Git commands and honor your repository hooks, signing, remotes, and authentication. Pull, Push, branch switching, staging, commits, stash operations, and the explicitly confirmed restore/discard actions modify your repository. Trash actions use recoverable system Trash on macOS and Linux. Windows has no Trash adapter here. The file browser and preview read the focused folder and its Git content. Nothing in this repository contains your credentials or account data.

See [the connection notes](mods/workspace-usage/CONNECTIONS.md) and [source provenance](NOTICE.md).

## Validate

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.cjs
for mod in mods/*; do herdr-app check "$mod"; done
```

Python checks cover the installer, package, and generation scope. Node is needed only for development tests. Commit tests use disposable repositories and do not call AI providers. Herdr's check validates the initial render; also exercise the installed layout in the app.

Switch back with `herdr-app do layout.switch '{"name":"main"}'`. To uninstall, switch away first, then remove only the `noodle` layout/preview and the six mods you installed after checking that no other layout uses them. These files are listed in [manifest.json](manifest.json).

## Sharing

This folder is a complete layout bundle. Publish it as a GitHub repository and add the topic **`herdr-layout`** to make it discoverable through Herdr's layout directory. Publication, repository visibility, and licensing are decisions for the repository owner. No global settings or runtime state belong in the bundle.
