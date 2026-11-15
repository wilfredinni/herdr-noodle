import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Scrollbar } from "gpui-base";
import { shared, setShared, panes, focused, run } from "herdr";
import { GithubPanel } from "./githubPanel.js";

export class GithubPreview extends GithubPanel {
  constructor(options, cx) {
    const owner = { preview: true, view: "github", root: null, on: null, context: null };
    super(owner, () => owner.context, cx);
    this.selectionKey = options.selectionKey || "github.preview.unselected";
    owner.openFile = (file, _commit, cx, options) => this.openFile(file, options, cx);
    this.sync(cx);
  }

  active() { return Boolean(this.selection && focused()?.tab === this.selection.tab); }
  current(snapshot) { return super.current(snapshot) && JSON.stringify(shared(this.selectionKey)) === this.signature; }
  refresh(cx) { this.sync(cx, true); }

  sync(cx, force = false) {
    const selection = shared(this.selectionKey), signature = JSON.stringify(selection);
    if (!force && signature === this.signature) return;
    const previous = this.selection;
    this.signature = signature; this.pendingSignature = signature; this.selection = selection;
    this.detailVersion++; this.detailLoading = false; this.error = null;
    if (!selection || !["pr", "run"].includes(selection.mode) || typeof selection.root !== "string" || !/^[1-9][0-9]{0,19}$/.test(String(selection.number))) {
      this.pr = null; this.run = null; this.owner.root = null;
      return;
    }
    const changed = !previous || previous.root !== selection.root || previous.on !== selection.on || previous.number !== selection.number || previous.mode !== selection.mode;
    Object.assign(this.owner, { root: selection.root, on: selection.on, branch: selection.branch, head: selection.head,
      context: JSON.stringify([selection.root, selection.on, selection.mode, selection.number]) });
    this.mode = selection.mode === "pr" ? "prs" : "workflows";
    if (changed) { this.pr = null; this.run = null; this.log = null; this.detailSection = "overview"; this.folded = {}; this.threadLimit = 50; this.reviewLimit = 50; }
    if (selection.mode === "pr") this.showPr({ number: selection.number }, cx);
    else this.showRun({ id: selection.number }, cx);
  }

  close() {
    const pane = panes().find(p => p.tab === this.selection?.tab && p.mod === "changes-graph");
    if (pane) run("pane.close", { pane: pane.pane });
  }

  openFile(file, options, cx) {
    const selection = this.selection, all = panes();
    const source = all.find(p => p.pane === selection.sourcePane && p.terminal);
    if (!source) { this.error = "The original terminal is closed. Reopen this PR from GitHub in the sidebar."; cx.notify(); return; }
    const selectionKey = `git-file-preview.${selection.tab}`;
    setShared(selectionKey, { root: selection.root, on: selection.on, sourcePane: source.pane, file, branch: selection.branch, head: selection.head, ...options });
    const existing = all.find(p => p.tab === selection.tab && p.mod === "git-file-preview");
    if (existing) run("pane.focus", { pane: existing.pane });
    else run("pane.split", { pane: source.pane, direction: "right", mod: "git-file-preview", props: { selectionKey } });
  }

  render(t, cx) {
    const signature = JSON.stringify(shared(this.selectionKey));
    if (signature !== this.signature && signature !== this.pendingSignature) {
      this.pendingSignature = signature;
      cx.spawn(async cx => { await Promise.resolve(); this.sync(cx); });
    }
    const selection = this.selection, workflow = selection?.mode === "run";
    const iconButton = (id, label, path, action, disabled = false) => Button.new(id).size(26).flex_none().flex().items_center().justify_center().rounded(5)
      .bg("#00000000").text_color(t.muted).disabled(disabled).accessibility_label(label).tooltip(label)
      .hover(el => el.bg(t.hover).text_color(t.foreground)).focus(el => el.bg(t.hover)).on_click((_e, cx) => action(cx))
      .child(svg(path).size(13).when(id === "github-preview-refresh" && this.detailLoading, el => el.spin(900)));
    return v_flex().id("github-preview").size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(workflow ? "mods/changes-graph/history.svg" : "mods/changes-graph/github.svg").size(14).text_color(t.muted))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12).font_semibold().child(selection ? `${workflow ? "Workflow run" : "Pull request"} #${selection.number}` : "GitHub preview"))
          .when(Boolean(selection), el => el.child(div().truncate().text_size(11).text_color(t.muted).child(selection.repository || selection.root))))
        .child(iconButton("github-preview-refresh", "Refresh preview", this.detailLoading ? "mods/workspace-chrome/spinner.svg" : "mods/changes-graph/fetch.svg", cx => this.refresh(cx), !selection || this.detailLoading))
        .child(iconButton("github-preview-close", "Close GitHub preview", "mods/pane/close.svg", () => this.close())))
      .when(Boolean(this.pr && !workflow), el => el.child(this.prHeader(t)).child(this.detailTabs(t)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("github-preview-content").absolute().inset_0().overflow_y_scroll().p(14).gap(12)
          .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
          .when(this.detailLoading, el => el.child(div().text_size(11).text_color(t.muted).child("Loading details…")))
          .when(Boolean(this.pr && !workflow), el => el.child(this.prDetail(t, cx)))
          .when(Boolean(this.run && workflow), el => el.child(this.runDetail(t)))
          .when(!selection, el => el.child(div().text_size(12).text_color(t.muted).child("Select a pull request or workflow run from the GitHub sidebar."))))
        .child(Scrollbar.vertical("github-preview-content").absolute().inset_0()));
  }
}
