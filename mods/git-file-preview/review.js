import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Button, Popover, ScrollHandle } from "gpui-base";
import { exec, appHome, setShared } from "herdr";
import { diffRows } from "./content.js";
import { highlightRows } from "./highlight.js";

export class Review {
  constructor(owner, cx) {
    this.owner = owner; this.focus = cx.focus_handle(); this.scroll = ScrollHandle.new();
    this.search = InputState.new({ placeholder: "Filter branches…" });
    this.search.on("change", (_e, cx) => { this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.search.on("submit", (_e, cx) => this.choose(this.choices()[this.at], cx));
    this.reset();
  }
  reset() { this.branches = []; this.branch = null; this.branchOpen = false; this.at = 0; this.hunks = null; this.confirm = null; this.comparison = null; this.pr = null; this.log = null; this.error = null; }
  choices() { const filter = this.search.value().trim().toLowerCase(); return this.branches.filter(branch => branch.name.toLowerCase().includes(filter)); }
  choose(branch, cx) { if (!branch) return; this.branch = branch; this.branchOpen = false; this.comparison = null; cx.notify(); }
  show(mode, cx) {
    this.mode = mode; this.error = null; this.log = null;
    if (mode === "hunks") this.load(cx);
    if (mode === "compare") this.call("review_branches", {}, cx, data => { this.branches = data.branches; });
    if (mode === "pr") { this.pr = null; this.call("review_pr", {}, cx, data => { this.pr = data; }); }
    cx.notify();
  }
  call(action, request, cx, next) {
    if (this.busy) return; this.busy = true; this.error = null;
    const selection = this.owner.selection, version = this.owner.version;
    cx.spawn(async cx => {
      let result;
      try {
        const r = await exec("python3", [`${appHome()}/helpers/noodle/workspace.py`, action, JSON.stringify({ home: appHome(), root: selection.root, path: selection.file?.path, ...request })]);
        result = JSON.parse(r.stdout || '{}'); if (r.code || result.error) throw new Error(result.error || r.stderr);
      } catch (e) { result = null; if (version === this.owner.version) this.error = e.message; }
      finally { this.busy = false; cx.notify(); }
      if (result && version === this.owner.version) next?.(result, cx);
    }); cx.notify();
  }
  load(cx) {
    this.mode = "hunks"; this.hunks = null; this.owner.mode = "review";
    const selection = this.owner.selection;
    this.call("review_hunks", { mode: selection.diffMode === "staged" ? "staged" : "unstaged" }, cx, data => {
      const rows = data.hunks.map(hunk => diffRows(hunk.replace(/\n$/, "").split("\n")));
      const key = row => JSON.stringify([row.kind, row.oldNumber, row.newNumber, row.text]);
      const colors = new Map((this.owner.result?.rows || []).filter(row => row.spans).map(row => [key(row), row.spans]));
      for (const row of rows.flat()) if (colors.has(key(row))) row.spans = colors.get(key(row));
      this.hunks = { ...data, rows };
      cx.spawn(async cx => {
        let syntaxError = null;
        try { await highlightRows({ ...selection, diffMode: data.mode }, rows.flat(), { exec }); }
        catch (error) { syntaxError = String(error.message || error); }
        if (this.hunks?.token !== data.token) return;
        this.hunks = { ...data, rows, syntaxError }; cx.notify();
      });
      cx.notify();
    });
  }
  apply(operation, index, cx, confirmed = false) {
    if (operation === "discard" && !confirmed) { this.confirm = index; cx.notify(); return; }
    this.call("review_apply", { token: this.hunks.token, hunk: index, operation, confirmed }, cx, (_data, cx) => {
      this.confirm = null; setShared("noodle.files.changed", { root: this.owner.root, sequence: Date.now() }); this.owner.refresh(cx, true); this.load(cx);
    });
  }
  branchPicker(t, cx, button) {
    const choices = this.choices();
    return Popover.new("review-branch-picker").open(this.branchOpen).anchor("bottom_left").track_focus(this.focus)
      .on_open_change((open, cx) => { this.branchOpen = open; this.search.set_value(""); this.at = 0; cx.notify(); })
      .trigger(button("review-branch", this.branch?.name || "Choose branch…", () => {}).h_flex().gap(8).items_center()
        .child(svg("mods/changes-graph/chevron.svg").size(11)))
      .content(v_flex().w(300).p(6).gap(4).rounded(6).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).track_focus(this.focus)
        .on_key_down((e, cx) => {
          if (["up", "down"].includes(e.key)) {
            this.at = Math.max(0, Math.min(choices.length - 1, this.at + (e.key === "down" ? 1 : -1))); this.scroll.scroll_to_item(this.at);
          } else if (e.key === "enter") this.choose(choices[this.at], cx);
          else if (e.key === "escape") this.branchOpen = false;
          else return;
          cx.stop_propagation(); cx.notify();
        })
        .child(Input.new(this.search).h(30).accessibility_label("Filter comparison branches"))
        .child(v_flex().id("review-branch-list").max_h(260).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(choices.map((branch, i) => button(`review-branch-${branch.ref}`, branch.name, cx => this.choose(branch, cx))
            .w_full().h(30).flex_none().justify_start().truncate().bg(i === this.at ? t.selected : t.popover).accessibility_label(`Compare with ${branch.name}`)))
          .when(!choices.length, el => el.child(div().p(8).text_color(t.muted).child("No matching branches")))));
  }
  render(t, cx) {
    const s = this.owner.selection;
    const button = (id, label, fn, disabled = this.busy) => Button.new(id).h(28).px(10).flex_none().rounded(5).border_1().border_color(t.border).bg(t.raised).text_color(t.foreground).text_size(12).font_normal()
      .disabled(Boolean(disabled)).accessibility_label(label).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().id("git-review-tools").flex_1().min_h(0)
      .child(h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).bg(t.background).overflow_x_scrollbar()
        .child(this.owner.segments("review-mode", [...(!s.hash && s.file ? [["hunks", "File hunks"]] : []), ["compare", "Compare branch"], ["pr", "PR / CI"]], this.mode, (mode, cx) => { if (!this.busy) this.show(mode, cx); }, t)))
      .when(this.busy, el => el.child(div().px(16).py(8).text_color(t.muted).child("Loading…")))
      .when(Boolean(this.error), el => el.child(div().px(16).py(12).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("review-content").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12)
        .when(this.mode === "hunks", el => el
          .when(Boolean(this.hunks?.syntaxError), el => el.child(div().text_color(t.muted).child(this.hunks.syntaxError)))
          .when(Boolean(this.hunks && !this.hunks.hunks.length), el => el.child(div().text_color(t.muted).child("No textual hunks in this version. New files use whole-file staging.")))
          .children((this.hunks?.hunks || []).map((hunk, index) => v_flex().gap(8).pb(12).border_b(1).border_color(t.border)
            .child(h_flex().gap(8).items_center().child(div().flex_1().child(`Hunk ${index + 1}`))
              .child(button(`stage-hunk-${index}`, this.hunks.mode === "staged" ? "Unstage hunk" : "Stage hunk", cx => this.apply(this.hunks.mode === "staged" ? "unstage" : "stage", index, cx)))
              .when(this.hunks.mode !== "staged", el => el.child(button(`discard-hunk-${index}`, "Discard…", cx => this.apply("discard", index, cx)))))
            .when(this.confirm === index, el => el.child(h_flex().gap(8).items_center().child(div().flex_1().child("Discard this hunk from the working file?"))
              .child(button("cancel-discard-hunk", "Cancel", cx => { this.confirm = null; cx.notify(); }))
              .child(button("confirm-discard-hunk", "Discard hunk", cx => this.apply("discard", index, cx, true)))))
            .child(div().w_full().id(`review-hunk-${index}`).overflow_x_scrollbar().font_family("JetBrains Mono").text_size(12).line_height("24px")
              .children(this.hunks.rows[index].map(row => this.owner.diffRow(row, t)))))))
        .when(this.mode === "compare", el => el
          .child(h_flex().gap(8).items_center().child(this.branchPicker(t, cx, button)).child(button("compare-ref", "Compare", cx => this.call("review_compare", { ref: this.branch.ref }, cx, data => { this.comparison = data; }), this.busy || !this.branch)))
          .when(Boolean(this.comparison), el => el.child(div().text_color(t.muted).child(`Merge base ${this.comparison.base.slice(0, 8)} → HEAD ${this.comparison.head.slice(0, 8)}`)))
          .children((this.comparison?.files || []).map(file => button(`compare-${file.path}`, `${file.status}  ${file.path}`, cx => this.owner.openFile(file, null, cx, { hash: this.comparison.head, parent: this.comparison.base, kind: "diff", commit: null }))))
          .when(this.comparison?.incomplete, el => el.child(div().child("Comparison limited to 1,000 files"))))
        .when(this.mode === "pr" && Boolean(this.pr), el => el
          .child(div().font_semibold().child(`#${this.pr.number} ${this.pr.title}`))
          .child(div().text_color(t.muted).child(`${this.pr.headRefName} → ${this.pr.baseRefName} · ${this.pr.headRefOid.slice(0, 8)}`))
          .child(div().text_color(this.pr.headRefOid === this.pr.localHead ? t.ansi2 : t.ansi3).child(this.pr.headRefOid === this.pr.localHead ? "Checks match local HEAD" : "PR checks belong to a different commit than local HEAD"))
          .child(button("copy-pr-link", "Copy PR link", cx => cx.write_to_clipboard(this.pr.url)))
          .child(div().child(`Review: ${this.pr.reviewDecision || "No review decision"}`))
          .children((this.pr.reviews || []).map((r, i) => div().py(6).child(`${r.author?.login || "Reviewer"}: ${r.state}${r.body ? ` · ${r.body}` : ""}`)))
          .children((this.pr.statusCheckRollup || []).map((check, i) => h_flex().min_h(28).gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().child(`${check.name || check.context} · ${check.conclusion || check.status || check.state}`))
            .when(Boolean(check.detailsUrl || check.targetUrl), el => el.child(button(`copy-check-${i}`, "Copy link", cx => cx.write_to_clipboard(check.detailsUrl || check.targetUrl))))
            .when(Boolean(/\/actions\/runs\/(\d+)/.exec(check.detailsUrl || "")), el => el.child(button(`failure-log-${i}`, "Failure log", cx => this.call("review_log", { run: /\/actions\/runs\/(\d+)/.exec(check.detailsUrl)[1] }, cx, data => { this.log = data; }))))))
        .when(Boolean(this.log), el => el.child(v_flex().gap(8).child(button("copy-failure-log", "Copy failure log", cx => cx.write_to_clipboard(this.log.text)))
          .child(div().text_color(t.muted).child(`Logs for ${this.log.head.slice(0, 8)}${this.log.truncated ? " · last 200,000 characters" : ""}`))
          .child(div().font_family("JetBrains Mono").text_size(12).child(this.log.text || "No failure logs"))))));
  }
}
