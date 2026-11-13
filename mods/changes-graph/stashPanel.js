import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Scrollbar } from "gpui-base";
import { stashes, git, changeStash } from "./fileOps.js";
import { shortAge } from "./graph.js";

export class StashPanel {
  constructor(owner) { this.owner = owner; this.reset(); }

  reset() {
    this.entries = []; this.loading = false; this.error = null; this.confirmation = null;
    this.selected = null; this.patch = null; this.patchError = null; this.patchLoading = false;
    this.version = (this.version ?? 0) + 1; this.patchVersion = (this.patchVersion ?? 0) + 1;
  }

  async refresh() {
    const p = this.owner, snapshot = p.fileActions.snapshot(), version = ++this.version;
    if (!p.fileActions.current(snapshot)) return;
    this.loading = true; this.error = null;
    try {
      const entries = await stashes(snapshot);
      if (version !== this.version || !p.fileActions.current(snapshot)) return;
      this.entries = entries;
      if (this.selected && !entries.some(entry => entry.hash === this.selected)) { this.selected = null; this.patch = null; this.patchVersion++; }
    } catch (error) { if (version === this.version && p.fileActions.current(snapshot)) this.error = error.message; }
    finally { if (version === this.version) this.loading = false; }
  }

  create(cx) {
    const p = this.owner;
    if (!p.hasHead || !p.files.length || p.files.some(file => file.status === "U")) return;
    p.fileActions.run("Stash all changes", snapshot => git(["stash", "push", "--include-untracked", "-m", "Herdr stash"], snapshot), cx);
  }

  confirm(entry, action, cx) {
    if (!this.owner.fileActions.enabled()) return;
    this.confirmation = { entry, action, snapshot: this.owner.fileActions.snapshot() }; cx.notify();
  }

  perform(cx) {
    const confirmation = this.confirmation;
    if (!confirmation) return;
    this.confirmation = null;
    this.owner.fileActions.run(`${confirmation.action} stash`, snapshot => changeStash(confirmation.entry, confirmation.action, snapshot), cx, confirmation.snapshot);
  }

  show(entry, cx) {
    const p = this.owner, snapshot = p.fileActions.snapshot();
    if (!p.fileActions.current(snapshot) || !/^[0-9a-f]{40,64}$/.test(entry.hash)) return;
    const version = ++this.patchVersion;
    this.selected = entry.hash; this.patch = null; this.patchError = null; this.patchLoading = true;
    cx.spawn(async cx => {
      try {
        const output = await git(["stash", "show", "--patch", "--include-untracked", "--no-ext-diff", "--no-textconv", entry.hash], snapshot);
        if (version === this.patchVersion && p.fileActions.current(snapshot)) this.patch = output.slice(0, 200000) + (output.length > 200000 ? "\nPreview limited to 200,000 characters." : "");
      } catch (error) { if (version === this.patchVersion && p.fileActions.current(snapshot)) this.patchError = error.message; }
      finally { if (version === this.patchVersion) this.patchLoading = false; cx.notify(); }
    }); cx.notify();
  }

  button(id, label, action, t, disabled = false, danger = false) {
    return Button.new(id).h_flex().h(28).px(9).items_center().justify_center().rounded(5).border_1().border_color(t.border).bg(t.raised)
      .text_size(12).font_normal().text_color(danger ? t.ansi1 : t.foreground).disabled(disabled).accessibility_label(label)
      .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent)).on_click((_e, cx) => action(cx)).child(label);
  }

  render(t, cx) {
    const p = this.owner, disabled = !p.fileActions.enabled(), conflict = p.files.some(file => file.status === "U");
    const confirmation = this.confirmation;
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id("stash-list").absolute().inset_0().overflow_y_scroll().p(14).gap(12)
        .child(h_flex().gap(8).items_center().justify_end()
          .child(this.button("stash-create", "Stash all", cx => this.create(cx), t, disabled || conflict || !p.hasHead || !p.files.length)))
        .when(Boolean(confirmation), el => el.child(v_flex().p(12).gap(9).border_1().border_color(t.border).rounded(6)
          .child(div().font_semibold().child(`${confirmation.action === "drop" ? "Drop" : confirmation.action === "pop" ? "Pop" : "Apply"} ${confirmation.entry.ref}?`))
          .child(div().text_size(12).text_color(t.muted).child(confirmation.action === "drop" ? "Permanently remove this saved stash." : confirmation.action === "pop" ? "Restore its staged and working changes, then drop the stash if applying succeeds." : "Restore its staged and working changes. Keep the stash saved."))
          .child(div().text_size(11).text_color(t.muted).child(confirmation.entry.subject))
          .child(h_flex().justify_end().gap(8)
            .child(this.button("stash-cancel", "Cancel", cx => { this.confirmation = null; cx.notify(); }, t))
            .child(this.button("stash-confirm", confirmation.action === "drop" ? "Drop stash" : confirmation.action === "pop" ? "Pop stash" : "Apply stash", cx => this.perform(cx), t, disabled, confirmation.action === "drop")))))
        .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
        .children(this.entries.slice(0, 200).map(entry => v_flex().flex_none().gap(8).pb(14).border_b(1).border_color(t.border)
          .child(h_flex().gap(7).items_center().text_color(t.muted).text_size(11)
            .child(svg("mods/changes-graph/stashes.svg").size(13)).child(div().child(entry.ref))
            .child(div().flex_1())).child(div().text_size(12).child(entry.subject))
          .child(div().text_size(11).text_color(t.muted).child(shortAge(entry.time)))
          .child(h_flex().gap(6)
            .child(this.button(`stash-view-${entry.hash}`, "View diff", cx => this.show(entry, cx), t, disabled))
            .child(this.button(`stash-apply-${entry.hash}`, "Apply", cx => this.confirm(entry, "apply", cx), t, disabled || conflict))
            .child(this.button(`stash-pop-${entry.hash}`, "Pop", cx => this.confirm(entry, "pop", cx), t, disabled || conflict))
            .child(div().flex_1())
            .child(this.button(`stash-drop-${entry.hash}`, "Drop", cx => this.confirm(entry, "drop", cx), t, disabled, true)))
          .when(this.selected === entry.hash, el => el.child(v_flex().gap(6)
            .child(h_flex().justify_end().child(this.button("stash-close-diff", "Close diff", cx => { this.selected = null; this.patchVersion++; cx.notify(); }, t)))
            .child(div().overflow_y_scroll().overflow_x_scroll().h(240).p(10).bg(t.canvas).rounded(5).font_family("JetBrains Mono").text_size(11).line_height("17px")
              .text_color(this.patchError ? t.ansi1 : t.muted).child(this.patchError || (this.patchLoading ? "Loading stash diff…" : this.patch || "No text diff in this stash")))))))
        .when(!this.entries.length && !this.error, el => el.child(v_flex().py(32).gap(8).items_center().text_color(t.muted)
          .child(svg("mods/changes-graph/stashes.svg").size(24)).child(div().font_semibold().child(this.loading ? "Loading stashes…" : "No stashed changes"))
          .child(div().text_size(12).child("Save your current work before switching context."))))
        .when(this.entries.length > 200, el => el.child(div().text_size(11).text_color(t.muted).child("Showing the latest 200 stashes"))))
      .child(Scrollbar.vertical("stash-list").absolute().inset_0());
  }
}
