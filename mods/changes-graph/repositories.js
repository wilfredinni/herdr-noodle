import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { exec, appHome, readTextFile, shared, setShared } from "herdr";

export class Repositories {
  constructor(owner, workspace, cx) {
    this.owner = owner; this.workspace = workspace; this.rows = []; this.expanded = true;
    cx.timer.every(60000, cx => this.refresh(cx, true));
  }

  refresh(cx, force = false) {
    const workspace = this.workspace(), context = JSON.stringify(workspace);
    if (!workspace.folder || (context === this.context && (this.loading || !force || this.owner.busy))) return;
    if (context !== this.context) { this.rows = []; this.error = null; this.limited = false; }
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
        if (this.rows.length === 1 && !this.owner.root && !this.owner.loading) this.choose(this.rows[0], cx);
      } catch (error) { if (version === this.version) this.error = String(error); }
      finally { if (version === this.version) this.loading = false; cx.notify(); }
    });
  }

  choose(row, cx) {
    if (this.owner.busy || !this.rows.includes(row)) return;
    const workspace = this.workspace();
    if (JSON.stringify(workspace) !== this.context) return;
    setShared(`git.repository.${workspace.id}`, { workspace: workspace.folder, on: workspace.on, root: row.root });
    this.owner.refresh(cx); cx.notify();
  }

  update(root, branch, files) {
    const row = this.rows.find(row => row.root === root);
    if (row) { row.branch = branch || "(detached)"; row.count = files.length; row.conflict = files.some(file => file.status === "U"); row.error = null; }
  }

  render(t, cx) {
    const p = this.owner, workspace = this.workspace(), selected = shared(`git.repository.${workspace.id}`);
    const changed = this.rows.filter(row => row.count > 0).length, unknown = this.rows.filter(row => row.count === null || row.error).length;
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().h(36).flex_none().px(8).gap(4).items_center()
        .child(Button.new("repositories-toggle").h_flex().h(28).flex_1().min_w(0).px(4).gap(7).items_center().justify_start().rounded(5).bg("#00000000").text_color(t.foreground).text_size(12).font_normal()
          .accessibility_label(this.expanded ? "Collapse repositories" : "Expand repositories").hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
          .on_click((_e, cx) => { this.expanded = !this.expanded; cx.notify(); })
          .child(svg(`mods/changes-graph/${this.expanded ? "chevron" : "expand"}.svg`).size(11))
          .child(div().font_semibold().child("Repositories"))
          .child(div().text_size(11).text_color(t.muted).child(String(this.rows.length)))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.muted).tooltip(workspace.folder || "").child((workspace.folder || "").split(/[\\/]/).filter(Boolean).pop() || "")))
        .child(Button.new("repositories-refresh").size(28).flex_none().flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted).disabled(this.loading || p.busy)
          .accessibility_label("Refresh repositories").tooltip("Refresh repositories").hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => { this.refresh(cx, true); cx.notify(); })
          .child(svg("mods/changes-graph/fetch.svg").size(13).when(this.loading, el => el.spin(900)))))
      .when(this.expanded, el => el
        .child(v_flex().id("repositories-list").overflow_y_scrollbar().h(Math.min(180, Math.max(36, this.rows.length * 34 + 6))).flex_none().px(6).pb(6).gap(2)
          .children(this.rows.map(row => {
            const active = p.root === row.root && !p.loading, sync = [row.ahead ? `↑${row.ahead}` : "", row.behind ? `↓${row.behind}` : ""].filter(Boolean).join(" ");
            return Button.new(`repository-${row.root}`).h_flex().w_full().h(32).flex_none().px(8).gap(8).items_center().justify_start().rounded(5).text_size(12).font_normal().text_color(t.foreground)
              .bg(active ? t.selected : "#00000000").disabled(p.busy).accessibility_label(`Select repository ${row.name}, ${row.branch || "unknown branch"}, ${row.count ?? "unknown"} changed files`)
              .tooltip(`${row.root}\n${row.branch || "Status unavailable"}${row.error ? "\n" + row.error : ""}${row.worktree ? "\nLinked worktree or submodule" : ""}`).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
              .on_click((_e, cx) => this.choose(row, cx))
              .child(svg(`mods/changes-graph/${row.worktree ? "branch" : "repository"}.svg`).size(13).flex_none().text_color(t.muted))
              .child(div().flex_1().min_w(0).truncate().child(row.name))
              .child(div().max_w(140).min_w(0).truncate().text_size(11).text_color(t.muted).child(row.branch || "Unavailable"))
              .when(Boolean(sync), el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(sync)))
              .when(row.conflict || Boolean(row.error), el => el.child(svg("mods/changes-graph/warning.svg").size(13).text_color(t.ansi1)))
              .child(div().min_w(18).px(4).rounded(3).bg(t.raised).text_right().text_size(11).child(row.count === null ? "?" : String(row.count)));
          }))
          .when(!this.rows.length, el => el.child(div().px(8).py(8).text_size(12).text_color(t.muted).child(this.loading ? "Finding repositories…" : this.error || "No repositories in this workspace"))))
        .child(div().px(14).py(6).text_size(11).text_color(t.muted).child(`${changed} with changes · ${this.rows.reduce((sum, row) => sum + (row.count || 0), 0)} files${unknown ? ` · ${unknown} unavailable` : ""}`))
        .when(this.limited || Boolean(this.error && this.rows.length), el => el.child(div().px(14).pb(8).text_size(11).text_color(t.muted).child(this.error || "Search limited: open a closer folder to find more repositories."))))
      .when(Boolean(p.root), el => el.child(h_flex().h(32).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(12)
        .child(svg("mods/changes-graph/repository.svg").size(13).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().tooltip(p.root).font_semibold().child(p.root.split(/[\\/]/).filter(Boolean).pop()))
        .when(Boolean(selected?.workspace === workspace.folder && selected?.on === workspace.on), el => el.child(Button.new("repository-follow-terminal").h(24).px(6).rounded(4).bg("#00000000").text_size(11).text_color(t.muted).disabled(p.busy)
          .accessibility_label("Follow terminal repository").tooltip("Follow terminal repository").hover(el => el.bg(t.hover)).on_click((_e, cx) => { setShared(`git.repository.${workspace.id}`, null); p.refresh(cx); cx.notify(); }).child("Follow terminal")))));
  }
}
