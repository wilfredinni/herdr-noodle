import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Button, Popover, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, appHome, readTextFile, shared, setShared, notify } from "herdr";
import { showGitError } from "./gitError.js";

export function selectedPaths(files) { return files.filter(f => f.staged).map(f => f.path).sort(); }
export function sameDraft(owner, snapshot, key) {
  return key() === snapshot.context && owner.context === snapshot.context && owner.root === snapshot.root && owner.on === snapshot.on
    && owner.messageRevision === snapshot.revision && JSON.stringify(selectedPaths(owner.files)) === JSON.stringify(snapshot.selected);
}

export class CommitGenerator {
  constructor(owner, key, cx) {
    this.owner = owner; this.key = key; this.connections = []; this.errors = []; this.open = false; this.running = false;
    this.focus = cx.focus_handle(); this.scroll = ScrollHandle.new(); this.at = 0;
    this.search = InputState.new({ placeholder: "Filter models…" });
    this.search.on("change", (_e, cx) => { this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const model = this.models()[this.at]; if (model) this.choose(model, cx); });
  }

  async call(request, on) {
    const script = await readTextFile(`${appHome()}/mods/changes-graph/generate.py`);
    const r = await exec("python3", ["-c", script, JSON.stringify(request)], { on, timeout: 240000 });
    let result;
    try { result = JSON.parse(r.stdout); } catch { throw new Error("The connection returned an invalid response. Try again."); }
    if (r.code !== 0 || result.error) throw new Error(result.error || "The connection request failed.");
    return result;
  }

  sync(cx, force = false) {
    const p = this.owner;
    if (!p.root || this.loading || (!force && this.machine === p.on)) return;
    this.machine = p.on; this.loading = true; this.connections = []; this.errors = [];
    const on = p.on;
    cx.spawn(async cx => {
      try {
        const result = await this.call({ action: "catalog" }, on);
        if (this.machine !== on) return;
        this.connections = result.connections; this.errors = result.errors;
        const saved = shared(this.preferenceKey());
        this.selected = saved ?? (this.connections[0] ? { connection: this.connections[0].id, model: this.connections[0].models[0].id } : null);
      } catch (e) { if (this.machine === on) this.errors = [e.message]; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  preferenceKey() { return `ai.commit.${this.machine ?? "local"}`; }
  connection() { return this.connections.find(c => c.id === this.selected?.connection); }
  model() { return this.connection()?.models.find(m => m.id === this.selected?.model); }
  icon(connection) { return (connection.id.startsWith("opencode:") ? svg(connection.icon) : image(connection.icon)).size(14); }
  models() {
    const query = this.search.value().trim().toLowerCase();
    return (this.connections.find(c => c.id === this.picking)?.models ?? []).filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query));
  }
  choose(model, cx) {
    this.selected = { connection: this.picking, model: model.id }; setShared(this.preferenceKey(), this.selected);
    this.open = false; this.picking = null; cx.notify();
  }
  enabled() { return this.owner.gitToolbar.enabled() && !this.running && !this.owner.files.some(file => file.status === "U"); }

  generate(cx) {
    if (!this.enabled() || !this.owner.files.length || !this.model()) return;
    const p = this.owner, s = { ...p.gitToolbar.snapshot(), selected: selectedPaths(p.files), revision: p.messageRevision };
    const choice = { ...this.selected };
    this.open = false; this.running = true; p.busy = true;
    cx.spawn(async cx => {
      try {
        const result = await this.call({ action: "generate", ...s, ...choice }, s.on);
        if (sameDraft(p, s, this.key)) {
          p.message = result.subject; p.messageRevision++; p.input.set_value(result.subject); p.input.focus();
        } else notify({ title: "Commit message kept", body: "Your draft or repository changed. Generate again for the current changes.", level: "info" });
      } catch (e) { if (this.key() === s.context) showGitError("Generate commit message", e, s); }
      finally { this.running = false; p.busy = false; p.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  option(id, text, action, t) {
    return Button.new(id).w_full().min_h(30).px(8).py(5).h_flex().items_center().justify_start().gap(8).rounded(5)
      .bg("#00000000").font_normal().text_size(12).text_color(t.foreground).hover(s => s.bg(t.hover)).focus(s => s.bg(t.hover))
      .on_click((_e, cx) => action(cx)).child(text);
  }

  body(t, cx) {
    const models = this.models(), connection = this.connections.find(c => c.id === this.picking);
    return v_flex().w(290).p(5).gap(3).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().text_color(t.foreground).track_focus(this.focus)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.open = false; cx.stop_propagation(); cx.notify(); }
        if (connection && (e.key === "up" || e.key === "down")) {
          this.at = Math.max(0, Math.min(models.length - 1, this.at + (e.key === "up" ? -1 : 1)));
          this.scroll.scroll_to_item(this.at); cx.stop_propagation(); cx.notify();
        }
      })
      .when(Boolean(connection), el => el
        .child(this.option("generation-back", `Back · ${connection.name}`, cx => { this.picking = null; this.search.set_value(""); this.focus.focus(); cx.notify(); }, t))
        .child(div().h(30).px(8).child(Input.new(this.search).h_full().text_size(12)))
        .child(v_flex().id("generation-models").h(Math.min(270, Math.max(32, models.length * 42))).overflow_y_scrollbar().track_scroll(this.scroll).gap(1)
          .children(models.map((model, index) => this.option(`generate-model-${model.id}`, v_flex().min_w(0).gap(2)
            .child(div().truncate().child(model.name)).child(div().truncate().text_size(10).text_color(t.muted).child(model.id)), cx => this.choose(model, cx), t)
            .bg(this.at === index ? t.hover : "#00000000").accessibility_label(`Use ${model.name}`)))
          .when(!models.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child("No matching models")))))
      .when(!connection, el => el
        .child(div().px(8).py(5).text_size(11).text_color(t.muted).child(this.loading ? "Loading connections…" : "Connection"))
        .children(this.connections.map(c => this.option(`generate-connection-${c.id}`, h_flex().gap(8).items_center()
          .child(this.icon(c)).child(div().flex_1().min_w(0).truncate().child(c.name)).child(svg("mods/changes-graph/chevron.svg").size(10)), cx => {
            this.picking = c.id; this.at = 0; this.search.set_value(""); this.search.focus(); cx.notify();
          }, t).accessibility_label(`Choose ${c.name}`)))
        .children(this.errors.map((error, i) => div().id(`generate-error-${i}`).px(8).py(4).text_size(11).text_color(t.muted).child(error)))
        .when(!this.connections.length && !this.loading && !this.errors.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child("Connect an account in Codex or OpenCode.")))
        .child(this.option("generation-refresh", "Refresh connections", cx => this.sync(cx, true), t).disabled(this.loading)));
  }

  render(t, cx) {
    this.sync(cx);
    const available = this.enabled(), model = this.model(), connection = this.connection();
    const hasChanges = Boolean(model && this.owner.root && this.owner.context === this.key() && this.owner.files.length);
    const ready = available && hasChanges;
    const selected = selectedPaths(this.owner.files).length;
    const scope = selected && selected < this.owner.files.length ? `${selected} selected files` : "all changed files";
    const trigger = Button.new("generate-connection-menu").w(30).h(26).h_flex().gap(4).items_center().justify_center().rounded_r(5).bg(this.open ? t.hover : "#00000000")
      .border_1().border_color("#00000000").text_color(t.muted).hover(s => s.bg(t.hover)).focus(s => s.border_color(t.accent)).disabled(!available)
      .accessibility_label("Choose generation connection and model").tooltip(model ? `${connection.name} · ${model.name}` : "Choose connection and model")
      .child(svg("mods/changes-graph/chevron.svg").size(9));
    return h_flex().id("generate-split-button").flex_none().h(28).items_center().rounded(5).border_1().border_color(t.border).bg(t.raised)
      .child(Button.new("generate-commit-message").h(26).px(9).h_flex().items_center().gap(6).rounded_l(4).bg("#00000000")
        .border_1().border_color("#00000000").font_normal().text_size(12).text_color(hasChanges ? t.foreground : t.dim)
        .disabled(!ready).hover(s => s.bg(t.hover)).focus(s => s.border_color(t.accent)).accessibility_label("Generate commit message")
        .tooltip(`Generate a message for ${scope}`).on_click((_e, cx) => this.generate(cx))
        .child(svg(this.running ? "mods/workspace-chrome/spinner.svg" : "mods/changes-graph/spark.svg").id(this.running ? "commit-generation-spinner" : "commit-generation-icon").size(13).when(this.running, el => el.spin(900))).child("Generate"))
      .child(div().w(1).h(12).flex_none().bg(t.border))
      .child(Popover.new("commit-generation-picker").open(this.open).anchor("bottom_right").track_focus(this.focus)
        .on_open_change((open, cx) => { this.open = open && available; this.picking = null; if (this.open) this.sync(cx, true); cx.notify(); })
        .trigger(trigger).when(this.open, el => el.content(this.body(t, cx))));
  }
}
