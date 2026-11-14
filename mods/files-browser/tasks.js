import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Button } from "gpui-base";
import { run, setShared } from "herdr";
import { workspaceCall } from "./tools.js";

export class Tasks {
  constructor(owner) {
    this.owner = owner;
    this.name = InputState.new({ placeholder: "Task name (test, lint, build…)" });
    this.command = InputState.new({ placeholder: "Command to run in this repository" });
  }
  call(action, args, cx, next) {
    if (this.busy) return;
    const root = this.owner.root; this.busy = true; this.error = null;
    cx.spawn(async cx => {
      try { const result = await workspaceCall(action, { root, ...args }); if (root === this.owner.root) next?.(result, cx); }
      catch (e) { setShared("noodle.documents.request", null); this.error = e.message; }
      finally { this.busy = false; cx.notify(); }
    }); cx.notify();
  }
  load(cx) { this.call("tasks_list", {}, cx, result => { this.data = result; this.root = this.owner.root; }); }
  start(name, cx, resolution) {
    this.call("task_run", { name, resolution, drafts: this.pending?.drafts }, cx, (result, cx) => {
      if (result.needsDraftResolution) { this.pending = { name, drafts: result.drafts }; return; }
      setShared("noodle.documents.request", null); this.pending = null; this.data = { ...this.data, runs: [result.run, ...(this.data?.runs || [])] }; this.showTerminal(result.run);
    });
  }
  showTerminal(task) { run("terminal.keep", { terminal: task.name, place: "tab" }); }
  render(t, cx) {
    const button = (id, label, fn) => Button.new(id).h(28).px(8).rounded(5).text_size(12).disabled(Boolean(this.busy)).on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().id("repo-tasks").flex_1().min_h(0).overflow_y_scrollbar().px(12).py(12).gap(10)
      .child(h_flex().items_center().gap(8).child(div().font_semibold().flex_1().child("Tasks"))
        .child(button("refresh-tasks", "Refresh", cx => this.load(cx)))
        .child(button("close-tasks", "Close", cx => { this.owner.tools.mode = null; cx.notify(); })))
      .child(div().text_size(11).text_color(t.muted).child(this.owner.root || ""))
      .child(Input.new(this.name)).child(Input.new(this.command))
      .child(button("save-task", "Save task", cx => this.call("task_save", { name: this.name.value(), command: this.command.value() }, cx, result => { this.data = { ...this.data, saved: result.saved }; })))
      .children([...(this.data?.saved || []), ...(this.data?.suggestions || []).filter(s => !this.data?.saved?.some(t => t.name === s.name))].map(task => h_flex().min_h(32).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().tooltip(task.command).child(task.name))
        .child(button(`run-${task.name}`, "Run", cx => this.owner.tools.flushOwners(cx, cx => this.start(task.name, cx))))))
      .when(Boolean(this.pending), el => el.child(v_flex().p(12).gap(8).bg(t.raised)
        .child(div().child("This repository has unsaved drafts. Which files should the task use?"))
        .child(h_flex().gap(6).flex_wrap()
          .child(button("save-and-run", "Save & run", cx => this.owner.tools.flushOwners(cx, cx => this.start(this.pending.name, cx, "save"))))
          .child(button("run-saved", "Run saved files", cx => this.start(this.pending.name, cx, "saved")))
          .child(button("cancel-task-run", "Cancel", cx => { this.pending = null; setShared("noodle.documents.request", null); cx.notify(); })))))
      .children((this.data?.runs || []).map(task => v_flex().gap(6).py(8).border_t(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).truncate().child(`${task.title} · ${task.state}${task.code != null ? ` (${task.code})` : ""}`))
          .child(button(`rerun-${task.id}`, "Rerun", cx => this.owner.tools.flushOwners(cx, cx => this.start(task.title, cx)))))
        .child(h_flex().gap(6).flex_wrap()
          .child(button(`show-task-${task.id}`, "Show terminal", () => this.showTerminal(task)))
          .child(button(`output-${task.id}`, "Output", cx => this.call("task_output", { id: task.id }, cx, result => { this.output = result; })))
          .when(["starting", "running"].includes(task.state), el => el
            .child(button(`stop-${task.id}`, "Stop", cx => this.call("task_stop", { id: task.id }, cx)))
            .child(button(`force-${task.id}`, "Force stop…", cx => { this.force = task; cx.notify(); }))))))
      .when(Boolean(this.force), el => el.child(h_flex().gap(6).flex_wrap().child(div().child(`Force stop ${this.force.title}?`))
        .child(button("cancel-force-task", "Cancel", cx => { this.force = null; cx.notify(); }))
        .child(button("confirm-force-task", "Force stop", cx => this.call("task_stop", { id: this.force.id, force: true }, cx, () => { this.force = null; })))))
      .when(Boolean(this.output), el => el.child(v_flex().gap(8)
        .child(div().text_size(11).text_color(t.muted).child(this.output.truncated ? "Last 200,000 characters · older output omitted" : "Task output"))
        .children(this.output.diagnostics.map((d, i) => button(`diagnostic-${i}`, `${d.path}:${d.line}`, cx => this.owner.show(d.path, cx, d))))
        .child(div().font_family("JetBrains Mono").text_size(12).child(this.output.text || "No output yet"))))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)));
  }
}
