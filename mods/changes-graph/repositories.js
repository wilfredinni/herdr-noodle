import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, ScrollHandle } from "gpui-base";
import { exec, appHome, readTextFile, shared, setShared } from "herdr";

export class Repositories {
  constructor(owner, workspace, cx) {
    this.owner = owner; this.workspace = workspace; this.rows = []; this.open = false; this.focus = cx.focus_handle(); this.scroll = ScrollHandle.new();
    cx.timer.every(60000, cx => this.refresh(cx, true));
  }

  refresh(cx, force = false) {
    const workspace = this.workspace(), context = JSON.stringify(workspace);
    if (!workspace.folder || (context === this.context && (this.loading || !force || this.owner.busy))) return;
    if (context !== this.context) { this.open = false; this.rows = []; this.error = null; this.limited = false; }
    this.context = context; this.loading = true;
    const version = this.version = (this.version ?? 0) + 1;
    cx.spawn(async cx => {
      try {
        const script = await readTextFile(`${appHome()}/mods/changes-graph/repositories.py`);
        if (!script) throw new Error("Repository discovery is unavailable.");
        const result = await exec("python3", ["-c", script, workspace.folder], { on: workspace.on, timeout: 12000 });
        if (version !== this.version || context !== JSON.stringify(this.workspace())) return;
        const data = JSON.parse(result.stdout);
        if (result.code !== 0 || data.error) throw new Error(data.error || "Cannot discover repositories.");
        this.rows = data.repositories; this.limited = data.limited; this.error = data.warning || null;
        if (this.rows.length < 2) this.open = false;
        if (this.rows.length === 1 && !this.owner.root && !this.owner.loading) this.choose(this.rows[0], cx);
      } catch (error) { if (version === this.version) this.error = String(error); }
      finally { if (version === this.version) this.loading = false; cx.notify(); }
    });
  }

  choose(row, cx) {
    if (this.owner.busy || !this.rows.includes(row)) return;
    const workspace = this.workspace();
    if (JSON.stringify(workspace) !== this.context) return;
    this.open = false;
    setShared(`git.repository.${workspace.id}`, { workspace: workspace.folder, on: workspace.on, root: row.root });
    this.owner.refresh(cx); cx.notify();
  }

  update(root, branch, files, sync) {
    const row = this.rows.find(row => row.root === root);
    if (row) { row.branch = branch || "(detached)"; row.count = files.length; row.ahead = sync?.ahead || 0; row.behind = sync?.behind || 0; row.conflict = files.some(file => file.status === "U"); row.error = null; }
  }

  selector(title, t, cx, workspace = this.workspace()) {
    const p = this.owner, multiple = this.rows.length > 1;
    const label = h_flex().flex_1().min_w(0).gap(9).items_center()
      .child(svg("mods/changes-graph/repository.svg").size(14).flex_none().text_color(t.muted))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().child(title));
    if (!multiple) return label.tooltip(p.root || "");
    const trigger = Button.new("repository-select").h_flex().h(30).flex_1().min_w(0).max_w("100%").px(4).gap(7).items_center().justify_start().rounded(4).bg("#00000000").text_color(t.foreground).disabled(p.busy)
      .accessibility_label(`Select repository, current: ${title}`).tooltip(p.root || "Select a repository").hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
      .child(label).child(svg("mods/changes-graph/chevron.svg").size(11).flex_none().text_color(t.muted));
    return Popover.new("repository-picker").open(this.open).anchor("top_left").track_focus(this.focus)
      .on_open_change((open, cx) => {
        this.open = open && !p.busy;
        this.at = Math.max(0, this.rows.findIndex(row => row.root === p.root));
        if (this.open) this.scroll.scroll_to_item(this.at);
        cx.notify();
      }).trigger(trigger)
      .content(v_flex().w(420).p(8).gap(6).rounded(8).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).track_focus(this.focus)
        .on_key_down((e, cx) => {
          if (e.key === "escape") this.open = false;
          else if (["up", "down"].includes(e.key)) {
            this.at = Math.max(0, Math.min(this.rows.length - 1, (this.at || 0) + (e.key === "down" ? 1 : -1)));
            this.scroll.scroll_to_item(this.at);
          } else if (e.key === "enter") { const row = this.rows[this.at || 0]; if (row) this.choose(row, cx); }
          else return;
          cx.stop_propagation(); cx.notify();
        })
        .child(h_flex().h(28).flex_none().px(8).gap(8).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().tooltip(workspace.folder || "").child(`${(workspace.folder || "").split(/[\\/]/).filter(Boolean).pop() || "Workspace"} · ${this.rows.length} repositories`))
          .child(Button.new("repositories-refresh").size(26).flex_none().flex().items_center().justify_center().rounded(4).bg("#00000000").text_color(t.muted).disabled(this.loading || p.busy)
            .accessibility_label("Refresh repositories").tooltip(this.error || (this.limited ? "Search limited: open a closer folder to find more repositories. Refresh repositories." : "Refresh repositories")).focus(el => el.border_color(t.accent))
            .on_click((_e, cx) => { this.refresh(cx, true); cx.notify(); })
            .child(svg("mods/changes-graph/fetch.svg").size(13).when(this.loading, el => el.spin(900)))))
        .child(v_flex().id("repositories-list").h(Math.min(272, this.rows.length * 34)).flex_none().overflow_y_scrollbar().track_scroll(this.scroll).gap(2)
          .children(this.rows.map((row, index) => {
            const active = p.root === row.root, sync = [row.ahead ? `↑${row.ahead}` : "", row.behind ? `↓${row.behind}` : ""].filter(Boolean).join(" ");
            return Button.new(`repository-${row.root}`).h_flex().w_full().h(32).flex_none().px(8).gap(8).items_center().justify_start().rounded(5).border_1().border_color(this.at === index ? t.input : "#00000000").text_size(12).font_normal().text_color(t.foreground)
              .bg(active ? t.selected : "#00000000").disabled(p.busy).accessibility_label(`Select repository ${row.name}, ${row.branch || "unknown branch"}, ${row.count ?? "unknown"} changed files`)
              .tooltip(`${row.root}\n${row.branch || "Status unavailable"}${row.error ? "\n" + row.error : ""}${row.worktree ? "\nLinked worktree or submodule" : ""}`).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
              .on_click((_e, cx) => this.choose(row, cx))
              .child(svg(`mods/changes-graph/${row.worktree ? "branch" : "repository"}.svg`).size(13).flex_none().text_color(t.muted))
              .child(div().flex_1().min_w(0).truncate().child(row.name))
              .child(div().max_w(130).min_w(0).truncate().text_size(11).text_color(t.muted).child(row.branch || "Unavailable"))
              .when(Boolean(sync), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(sync)))
              .when(row.conflict || Boolean(row.error), el => el.child(svg("mods/changes-graph/warning.svg").size(13).text_color(t.ansi1)))
              .child(div().w(24).flex_none().text_right().text_size(11).text_color(row.count ? t.foreground : t.dim).tooltip(row.count == null ? "Changed-file count unavailable" : `${row.count} changed files`).child(row.count == null ? "?" : String(row.count)));
          }))));
  }
}
