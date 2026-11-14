import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Button } from "gpui-base";
import { exec, appHome, setShared } from "herdr";

export class Review {
  constructor(owner) { this.owner = owner; this.ref = InputState.new({ placeholder: "Branch/ref (blank uses upstream)" }); }
  call(action, request, cx, next) {
    if (this.busy) return; this.busy = true; this.error = null;
    const selection = this.owner.selection, version = this.owner.version;
    cx.spawn(async cx => {
      try {
        const r = await exec("python3", [`${appHome()}/helpers/noodle/workspace.py`, action, JSON.stringify({ home: appHome(), root: selection.root, path: selection.file?.path, ...request })]);
        const result = JSON.parse(r.stdout || '{}'); if (r.code || result.error) throw new Error(result.error || r.stderr);
        if (version === this.owner.version) next?.(result, cx);
      } catch (e) { this.error = e.message; }
      finally { this.busy = false; cx.notify(); }
    }); cx.notify();
  }
  load(cx) { this.mode = "hunks"; this.hunks = null; this.owner.mode = "review"; this.call("review_hunks", { mode: this.owner.selection.diffMode === "staged" ? "staged" : "unstaged" }, cx, data => { this.hunks = data; }); }
  apply(operation, index, cx, confirmed = false) {
    if (operation === "discard" && !confirmed) { this.confirm = index; cx.notify(); return; }
    this.call("review_apply", { token: this.hunks.token, hunk: index, operation, confirmed }, cx, (_data, cx) => {
      this.confirm = null; setShared("noodle.files.changed", { root: this.owner.root, sequence: Date.now() }); this.owner.refresh(cx, true); this.load(cx);
    });
  }
  render(t, cx) {
    const s = this.owner.selection;
    const button = (id, label, fn, disabled = this.busy) => Button.new(id).h(28).px(8).rounded(5).text_size(12).disabled(Boolean(disabled)).on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().id("git-review-tools").flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).py(8).gap(8).items_center().overflow_x_scrollbar()
        .child(button("review-hunks", "File hunks", cx => this.load(cx), s.on || s.hash || !s.file || this.busy))
        .child(button("review-compare", "Compare branch", cx => { this.mode = "compare"; this.error = null; cx.notify(); }, s.on || this.busy))
        .child(button("review-pr", "PR / CI", cx => { this.mode = "pr"; this.call("review_pr", {}, cx, data => { this.pr = data; }); }, s.on || this.busy)))
      .when(Boolean(this.error), el => el.child(div().px(16).py(12).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("review-content").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(12)
        .when(this.mode === "hunks", el => el
          .when(Boolean(this.hunks && !this.hunks.hunks.length), el => el.child(div().text_color(t.muted).child("No textual hunks in this version. New files use whole-file staging.")))
          .children((this.hunks?.hunks || []).map((hunk, index) => v_flex().gap(8).pb(12).border_b(1).border_color(t.border)
            .child(h_flex().gap(8).items_center().child(div().flex_1().child(`Hunk ${index + 1}`))
              .child(button(`stage-hunk-${index}`, this.hunks.mode === "staged" ? "Unstage hunk" : "Stage hunk", cx => this.apply(this.hunks.mode === "staged" ? "unstage" : "stage", index, cx)))
              .when(this.hunks.mode !== "staged", el => el.child(button(`discard-hunk-${index}`, "Discard…", cx => this.apply("discard", index, cx)))))
            .when(this.confirm === index, el => el.child(h_flex().gap(8).items_center().child(div().flex_1().child("Discard this hunk from the working file?"))
              .child(button("cancel-discard-hunk", "Cancel", cx => { this.confirm = null; cx.notify(); }))
              .child(button("confirm-discard-hunk", "Discard hunk", cx => this.apply("discard", index, cx, true)))))
            .child(div().font_family("JetBrains Mono").text_size(12).child(hunk)))))
        .when(this.mode === "compare", el => el
          .child(h_flex().gap(8).child(Input.new(this.ref).flex_1()).child(button("compare-ref", "Compare", cx => this.call("review_compare", { ref: this.ref.value().trim() }, cx, data => { this.comparison = data; }))))
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
