import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState, Textarea, TextareaState, Checkbox, Popover, ScrollHandle } from "gpui-base";
import { shared, setShared, openOverlay, closeOverlay, writeTextFile, notify } from "herdr";
import { CommitGenerator } from "./commitGenerator.js";
import { githubCall, githubButton } from "./githubPanel.js";

export function prSettingsKey(root, on) { return `ai.pr.instructions.${JSON.stringify([on ?? null, root])}`; }
export function prDraftKey(root, on, branch) { return `ai.pr.draft.${JSON.stringify([on ?? null, root, branch])}`; }

function closeButton(id, label, action, t) {
  return Button.new(id).size(26).flex_none().flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted)
    .accessibility_label(label).tooltip(label).hover(el => el.bg(t.hover).text_color(t.foreground)).focus(el => el.bg(t.hover))
    .on_click((_e, cx) => action(cx)).child(svg("mods/pane/close.svg").size(13));
}

export class PrSettings {
  constructor(options) {
    this.options = options; this.key = prSettingsKey(options.root, options.on);
    const saved = shared(this.key) || {};
    this.input = TextareaState.new({ value: saved.instructions || "", placeholder: "Describe the PR title, language, structure and validation details you prefer." });
    this.path = InputState.new({ value: saved.template ?? options.templates?.[0] ?? "", placeholder: ".github/pull_request_template.md or an absolute path" });
    this.input.focus();
  }
  save(cx) {
    const instructions = this.input.value().trim(), template = this.path.value().trim();
    if (instructions.length > 8000 || instructions.includes("\0") || template.includes("\0")) { this.error = "Use up to 8,000 instruction characters without null characters."; cx.notify(); return; }
    this.saving = true; this.error = null;
    cx.spawn(async cx => {
      try {
        if (template) await githubCall("template", { ...this.options, template });
        setShared(this.key, { instructions, template }); closeOverlay(this.options.overlay);
      } catch (error) { this.error = error.message; }
      finally { this.saving = false; cx.notify(); }
    }); cx.notify();
  }
  render(t) {
    return v_flex().id("pr-instructions-dialog").size_full().min_h(0).p(20).gap(14).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground)
      .child(h_flex().gap(12).items_center().child(div().flex_1().text_size(15).font_semibold().child("PR instructions"))
        .child(closeButton("close-pr-instructions", "Close PR instructions", () => closeOverlay(this.options.overlay), t)))
      .child(Textarea.new(this.input).flex_1().min_h(100).w_full().p(10).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(13).line_height("20px").accessibility_label("PR generation instructions"))
      .child(div().text_size(12).child("PR template file"))
      .child(Input.new(this.path).h(32).px(8).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(12).accessibility_label("PR template file path"))
      .when(Boolean(this.options.templates?.length), el => el.child(h_flex().gap(5).overflow_x_scrollbar()
        .children(this.options.templates.map((path, i) => githubButton(`pr-template-${i}`, path, cx => { this.path.set_value(path); cx.notify(); }, t, this.saving)))))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(12).items_center().child(div().flex_1().text_size(11).text_color(t.muted).child("Leave empty to use the default style and no template."))
        .child(githubButton("save-pr-instructions", this.saving ? "Saving…" : "Save", cx => this.save(cx), t, this.saving).bg(t.accent).text_color(t.accent_foreground)));
  }
}

export class PrComposer {
  constructor(options, cx) {
    this.options = options; this.root = options.root; this.on = options.on; this.context = options.context; this.branch = options.branch; this.head = options.head;
    this.key = prDraftKey(this.root, this.on, this.branch); this.settingsKey = prSettingsKey(this.root, this.on);
    const saved = shared(this.key) || {};
    this.base = InputState.new({ value: saved.base || options.info.repo.defaultBranchRef?.name || "main", placeholder: "Base branch" });
    this.baseSearch = InputState.new({ placeholder: "Find a branch…" });
    this.baseFocus = cx.focus_handle(); this.baseScroll = ScrollHandle.new(); this.baseAt = 0; this.branches = null;
    this.baseSearch.on("change", (_e, cx) => { this.baseAt = 0; this.baseScroll.scroll_to_item(0); cx.notify(); });
    this.baseSearch.on("submit", (_e, cx) => this.chooseBase(this.baseChoices()[this.baseAt], cx));
    this.title = InputState.new({ value: saved.title || "", placeholder: "Pull request title" });
    this.body = TextareaState.new({ value: saved.body || "", placeholder: "Describe the problem, changes and validation.", rows: 12 });
    this.draft = saved.draft ?? false; this.revision = 0; this.files = []; this.busy = false; this.ready = false;
    this.gitToolbar = { enabled: () => this.current() && !this.busy };
    this.generator = new CommitGenerator(this, () => this.context, cx);
    let validTitle = Boolean(this.title.value().trim());
    for (const input of [this.base, this.title, this.body]) {
      input.on("change", (_e, cx) => { this.revision++; const valid = Boolean(this.title.value().trim()); if (valid !== validTitle) { validTitle = valid; cx.notify(); } });
      input.on("blur", () => this.saveDraft());
    }
    this.title.focus(); this.check(cx);
    if (!saved.body) this.loadTemplate(cx);
  }
  current() {
    const value = shared("github.active");
    return value?.context === this.context && value?.root === this.root && value?.on === this.on && value?.branch === this.branch && value?.head === this.head;
  }
  settings() { return shared(this.settingsKey) || { instructions: "", template: this.options.info.templates?.[0] || "" }; }
  saveDraft() {
    const draft = { base: this.base.value(), title: this.title.value(), body: this.body.value(), draft: this.draft };
    if (JSON.stringify(shared(this.key)) !== JSON.stringify(draft)) setShared(this.key, draft);
  }
  close() { this.saveDraft(); closeOverlay(this.options.overlay); }
  baseChoices() {
    const query = this.baseSearch.value().trim().toLowerCase(), defaultBranch = this.options.info.repo.defaultBranchRef?.name;
    return (this.branches || []).filter(name => name.toLowerCase().includes(query))
      .sort((a, b) => Number(b === defaultBranch) - Number(a === defaultBranch) || Number(b === this.base.value()) - Number(a === this.base.value()) || a.localeCompare(b));
  }
  openBases(open, cx) {
    this.baseOpen = open;
    if (open) {
      this.baseSearch.set_value(""); this.baseAt = Math.max(0, this.baseChoices().indexOf(this.base.value()));
      this.baseSearch.focus();
      if (!this.branches) this.loadBases(cx);
    } else this.baseFocus.focus();
    cx.notify();
  }
  loadBases(cx) {
    if (this.basesLoading || !this.current()) return;
    this.basesLoading = true; this.basesError = null;
    cx.spawn(async cx => {
      try {
        const value = await githubCall("branches", this.options);
        if (this.current()) { this.branches = value.items; this.baseAt = Math.max(0, this.baseChoices().indexOf(this.base.value())); }
      } catch (error) { if (this.current()) this.basesError = error.message; }
      finally { this.basesLoading = false; cx.notify(); }
    });
  }
  chooseBase(name, cx) {
    if (!name || !this.branches?.includes(name) || this.busy || !this.current()) return;
    this.base.set_value(name); this.revision++; this.saveDraft(); this.openBases(false, cx);
  }
  basePicker(t, disabled) {
    const choices = this.baseChoices(), rows = choices.slice(0, 100), defaultBranch = this.options.info.repo.defaultBranchRef?.name;
    const trigger = Button.new("pr-base-branch").h_flex().flex_1().min_w(0).h(32).px(8).gap(8).rounded(5).border_1().border_color(t.input)
      .bg(t.background).text_size(12).text_color(t.foreground).disabled(disabled).accessibility_label(`PR base branch: ${this.base.value()}`).tooltip("Choose the branch to merge into")
      .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
      .child(svg("mods/changes-graph/branch.svg").size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(this.base.value())).child(svg("mods/changes-graph/chevron.svg").size(10).flex_none().text_color(t.muted));
    return Popover.new("pr-base-picker").open(Boolean(this.baseOpen)).anchor("bottom_left").track_focus(this.baseFocus)
      .on_open_change((open, cx) => this.openBases(open, cx)).trigger(trigger)
      .when(this.baseOpen, el => el.content(v_flex().id("pr-base-menu").w(360).p(5).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_md().text_color(t.foreground).track_focus(this.baseFocus)
        .on_key_down((e, cx) => {
          if (e.key === "escape") { this.openBases(false, cx); cx.stop_propagation(); }
          if (["up", "down"].includes(e.key)) { this.baseAt = Math.max(0, Math.min(rows.length - 1, this.baseAt + (e.key === "down" ? 1 : -1))); this.baseScroll.scroll_to_item(this.baseAt); cx.stop_propagation(); cx.notify(); }
        })
        .child(Input.new(this.baseSearch).h(30).px(8).text_size(12).accessibility_label("Find a base branch"))
        .child(v_flex().id("pr-base-branches").h(Math.min(240, Math.max(36, (this.branches?.length || 0) * 32))).overflow_y_scrollbar().track_scroll(this.baseScroll)
          .children(rows.map((name, i) => Button.new(`pr-base-option-${name}`).h_flex().w_full().h(32).flex_none().px(8).gap(8).rounded(4).text_size(12).text_color(t.foreground)
            .bg(i === this.baseAt ? t.selected : "#00000000").accessibility_label(`Use base branch ${name}`).tooltip(name).disabled(disabled)
            .hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover)).on_click((_e, cx) => this.chooseBase(name, cx))
            .child(svg(name === this.base.value() ? "mods/workspace-chrome/check.svg" : "mods/changes-graph/branch.svg").size(12).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(name))
            .when(name === defaultBranch, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child("default")))))
          .when(!rows.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child(this.basesLoading ? "Loading branches…" : this.basesError || (this.branches?.length ? "No matching branches" : "No branches available")))))
        .when(Boolean(this.basesError), el => el.child(githubButton("pr-base-retry", "Retry", cx => this.loadBases(cx), t, this.basesLoading)))
        .when(choices.length > 100, el => el.child(div().px(8).text_size(11).text_color(t.muted).child(`${choices.length} matches. Refine your search to see more.`)))));
  }
  check(cx) {
    this.checking = true;
    cx.spawn(async cx => {
      try {
        const value = await githubCall("ready", this.options);
        if (value.head !== this.head || value.branch !== this.branch) throw new Error("The branch changed. Reopen the PR composer.");
        this.ready = value.ready; this.error = null;
      } catch (error) { this.error = error.message; }
      finally { this.checking = false; cx.notify(); }
    });
  }
  loadTemplate(cx) {
    const revision = this.revision, settings = JSON.stringify(this.settings());
    if (!this.settings().template) return;
    cx.spawn(async cx => {
      try {
        const value = await githubCall("template", { ...this.options, template: this.settings().template });
        if (revision === this.revision && settings === JSON.stringify(this.settings()) && !this.body.value()) { this.body.set_value(value.body); this.saveDraft(); }
      } catch (error) { this.error = error.message; }
      cx.notify();
    });
  }
  publish(cx) {
    if (!this.current()) return;
    this.saveDraft();
    setShared("github.publish", { ...this.options, id: `${Date.now()}`, action: this.options.sync?.upstream ? "push" : "publish" });
    closeOverlay(this.options.overlay);
  }
  async submit(action, data) {
    if (this.on) throw new Error("Open a local checkout to create or generate a pull request. Remote GitHub browsing remains available.");
    const file = await githubCall("prepare", this.options);
    await writeTextFile(file.path, JSON.stringify({ root: this.root, head: this.head, branch: this.branch, ...data }), "{}");
    return githubCall(action, { ...this.options, token: file.token });
  }
  generate(cx) {
    if (this.busy || !this.current() || !this.generator.model()) return;
    this.saveDraft(); this.busy = true; this.generator.running = true; this.generator.open = false; this.error = null;
    const revision = this.revision, settings = JSON.stringify(this.settings()), base = this.base.value().trim(), saved = JSON.stringify(shared(this.key));
    cx.spawn(async cx => {
      try {
        const value = await this.submit("generate", { ...this.generator.selected, ...this.settings(), base });
        if (this.current() && revision === this.revision && base === this.base.value().trim() && settings === JSON.stringify(this.settings()) && saved === JSON.stringify(shared(this.key))) {
          this.title.set_value(value.title); this.body.set_value(value.body); this.revision++; this.saveDraft();
        } else notify({ title: "PR draft kept", body: "Your draft, repository or instructions changed. Generate again.", level: "info" });
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; this.generator.running = false; cx.notify(); }
    }); cx.notify();
  }
  create(cx) {
    if (!this.current() || !this.ready || this.busy || !this.title.value().trim()) return;
    this.saveDraft(); this.busy = true; this.error = null;
    const data = { base: this.base.value().trim(), title: this.title.value().trim(), body: this.body.value(), draft: this.draft };
    cx.spawn(async cx => {
      try {
        const value = await this.submit("create", data);
        setShared(this.key, null); setShared("github.created", { root: this.root, on: this.on, url: value.url, id: `${Date.now()}` });
        closeOverlay(this.options.overlay); notify({ title: "Pull request ready", body: value.url, level: "info" });
      } catch (error) { this.error = error.message; }
      finally { this.busy = false; cx.notify(); }
    }); cx.notify();
  }
  render(t, cx) {
    const current = this.current(), disabled = this.busy || !current;
    return v_flex().id("pr-composer-dialog").size_full().min_h(0).p(20).gap(12).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground)
      .child(h_flex().gap(12).items_center().child(div().flex_1().text_size(15).font_semibold().child("New pull request"))
        .child(closeButton("close-pr-composer", "Close PR composer", () => this.close(), t).disabled(this.busy)))
      .child(div().text_size(11).text_color(t.muted).child(`${this.options.info.repo.name} · ${this.branch} · ${this.head.slice(0, 8)}`))
      .child(h_flex().gap(10).items_center().child(div().text_size(12).child("Base branch"))
        .child(this.basePicker(t, disabled)))
      .child(Input.new(this.title).h(34).px(10).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(13).accessibility_label("PR title"))
      .child(Textarea.new(this.body).flex_1().min_h(160).w_full().p(10).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(13).line_height("20px").accessibility_label("PR description"))
      .child(h_flex().gap(8).items_center().child(Checkbox.new("pr-draft").size(14).p(0).flex_none().flex().items_center().justify_center().rounded(3).border_1()
        .border_color(this.draft ? t.accent : t.input).bg(this.draft ? t.accent : "#00000000").text_color(t.accent_foreground).focus(el => el.border_color(t.foreground))
        .when(this.draft, el => el.child(svg("mods/workspace-chrome/check.svg").size(10)))
        .checked(this.draft).disabled(this.busy).accessibility_label("Create as draft")
        .on_change((value, cx) => { this.draft = value; this.saveDraft(); cx.notify(); })).child(div().text_size(12).child("Create as draft")))
      .when(!current, el => el.child(div().text_size(12).text_color(t.ansi1).child("The repository or branch changed. Close and reopen this composer; your draft is saved.")))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .when(!this.ready, el => el.child(h_flex().gap(8).items_center().child(div().flex_1().text_size(11).text_color(t.muted).child(this.checking ? "Checking remote branch…" : "Publish or push this branch before creating the PR. Your draft is kept."))
        .child(githubButton("pr-check-published", "Check again", cx => this.check(cx), t, this.checking || disabled))
        .child(githubButton("pr-publish", this.options.sync?.upstream ? "Push branch" : "Publish branch", cx => this.publish(cx), t, disabled))))
      .child(h_flex().gap(8).items_center().justify_end()
        .child(Button.new("pr-instructions").size(28).flex_none().flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted).disabled(disabled)
          .accessibility_label("PR instructions").tooltip("PR instructions").hover(el => el.bg(t.hover).text_color(t.foreground)).focus(el => el.bg(t.hover))
          .on_click(() => { this.saveDraft(); openOverlay({ mod: "changes-graph", props: { prSettings: true, root: this.root, on: this.on, templates: this.options.info.templates }, kind: "dialog", frame: "none", width: 560, height: 450 }); })
          .child(svg("mods/changes-graph/commit-instructions.svg").size(15)))
        .child(this.generator.render(t, cx, { id: "generate-pr", label: "Generate pull request", ready: Boolean(this.generator.model() && current && this.base.value().trim()), generate: cx => this.generate(cx) }))
        .child(githubButton("create-pr", this.busy && !this.generator.running ? "Creating…" : "Create PR", cx => this.create(cx), t, disabled || !this.ready || !this.title.value().trim()).bg(t.accent).text_color(t.accent_foreground)));
  }
}
