import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, shared, setShared } from "herdr";
import { shortAge } from "./graph.js";
import { showGitError } from "./gitError.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
export const BRANCH_ARGS = ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(authorname)%00%(committerdate:unix)%00%(subject)%00%(worktreepath)", "refs/heads/"];
export function branchRows(text) {
  return text.split("\n").filter(Boolean).map(line => {
    const [ref, author, timestamp, subject, worktree] = line.split("\0");
    return { name: ref.slice(11), author, timestamp: Number(timestamp), subject, worktree };
  });
}
const ACTIONS = [
  ["fetch", "Fetch", ["fetch", "--all"], "fetch"],
  ["fetch-from", "Fetch From…", null, "download"],
  ["pull", "Pull", ["pull", "--ff-only"], "download"],
  ["rebase", "Pull (Rebase)", ["pull", "--rebase"], "rebase"],
  ["push", "Push", ["push"], "upload"],
  ["push-to", "Push To…", null, "upload"],
  ["force", "Force Push…", null, "warning"],
];

export class GitToolbar {
  constructor(owner, key, cx) {
    this.owner = owner; this.key = key; this.focus = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.search = InputState.new({ placeholder: "Filter or create a branch…" });
    this.search.on("change", (_e, cx) => { this.at = 0; this.scroll.scroll_to_item(0); this.validateBranch(cx); });
    this.search.on("submit", (_e, cx) => { const branch = this.choices()[this.at]; if (branch) branch.create ? this.createBranch(branch.name, cx) : this.switchBranch(branch, cx); });
    this.reset();
  }

  reset() {
    this.open = null; this.mode = "actions"; this.branches = []; this.remotes = [];
    this.error = null; this.loading = false; this.at = 0; this.lease = null;
    this.creation = null; this.createVersion = (this.createVersion ?? 0) + 1;
    this.search.set_value(""); this.sequence = (this.sequence ?? 0) + 1;
  }

  snapshot() { const p = this.owner; return { context: p.context, root: p.root, on: p.on, branch: p.branch, head: p.head ?? "" }; }
  current(s) { const p = this.owner; return Boolean(s && s.context === this.key() && s.context === p.context && s.root === p.root && s.on === p.on); }
  enabled() { const p = this.owner; return Boolean(p.root && !p.busy && !p.loading && p.context === this.key()); }
  filtered() { const filter = this.search.value().trim().toLowerCase(); return this.branches.filter(b => b.name.toLowerCase().includes(filter)); }

  newBranchName() {
    const name = this.search.value().trim();
    if (!name || name.toLowerCase() === this.owner.branch?.toLowerCase() || this.branches.some(b => b.name.toLowerCase() === name.toLowerCase())) return "";
    return name;
  }

  choices() {
    const branches = this.filtered(), creation = this.creation;
    return creation?.valid && creation.name === this.newBranchName() ? [...branches, { name: creation.name, create: true }] : branches;
  }

  validateBranch(cx) {
    const name = this.newBranchName(), s = this.menuContext, version = ++this.createVersion;
    this.creation = null;
    if (!name || this.open !== "branches" || this.loading || this.error || !this.current(s)) { cx.notify(); return; }
    this.creation = { name, pending: true };
    cx.spawn(async cx => {
      try {
        const result = await exec("git", [...READ, "check-ref-format", "--branch", name], { cwd: s.root, on: s.on });
        if (version !== this.createVersion || !this.current(s) || name !== this.newBranchName()) return;
        const valid = result.code === 0 && result.stdout.trim() === name;
        this.creation = { name, valid, error: valid ? null : "Use a valid Git branch name." };
      } catch (e) {
        if (version === this.createVersion && this.current(s)) this.creation = { name, valid: false, error: e.message };
      }
      cx.notify();
    });
    cx.notify();
  }

  createBranch(name, cx) {
    if (!this.creation?.valid || this.creation.name !== name || this.newBranchName() !== name || !this.current(this.menuContext) || !this.enabled()) return;
    this.run(`Create branch ${name}`, ["switch", "--no-guess", "-c", name], cx, this.menuContext, this.menuContext.head);
  }

  show(kind, open, cx) {
    this.reset();
    if (!open || !this.enabled()) { cx.notify(); return; }
    this.open = kind; this.menuContext = this.snapshot();
    if (kind === "branches") this.loadBranches(cx);
    cx.notify();
  }

  loadBranches(cx) {
    const s = this.menuContext, sequence = this.sequence;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", [...READ, ...BRANCH_ARGS], { cwd: s.root, on: s.on });
        if (!this.current(s) || sequence !== this.sequence) return;
        if (r.code !== 0) throw new Error(r.stderr || "Cannot load branches");
        this.branches = branchRows(r.stdout);
        this.at = Math.max(0, this.filtered().findIndex(b => b.name === s.branch));
        this.scroll.scroll_to_item(this.at);
        this.search.focus();
      } catch (e) { if (this.current(s) && sequence === this.sequence) this.error = e.message; }
      finally { if (sequence === this.sequence) { this.loading = false; if (this.current(s)) this.validateBranch(cx); } cx.notify(); }
    });
  }

  switchBranch(branch, cx) {
    if (branch.name === this.owner.branch || (branch.worktree && branch.worktree !== this.owner.root)) return;
    this.run(`Switch to ${branch.name}`, ["switch", "--no-guess", "--", branch.name], cx);
  }

  action(id, cx) {
    const action = ACTIONS.find(a => a[0] === id);
    if (!action || !this.current(this.menuContext) || !this.enabled()) return;
    if (action[2]) { this.run(action[1], action[2], cx, this.menuContext); return; }
    const s = this.menuContext, sequence = this.sequence;
    this.mode = id; this.loading = true; this.error = null;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", [...READ, "remote"], { cwd: s.root, on: s.on });
        if (!this.current(s) || sequence !== this.sequence) return;
        if (r.code !== 0) throw new Error(r.stderr || "Cannot read remotes");
        this.remotes = r.stdout.split("\n").filter(Boolean);
      } catch (e) { if (this.current(s) && sequence === this.sequence) this.error = e.message; }
      finally { if (sequence === this.sequence) this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  remote(name, cx) {
    if (!this.remotes.includes(name) || !this.current(this.menuContext) || !this.enabled()) return;
    const s = this.menuContext;
    if (this.mode === "fetch-from") { this.run(`Fetch from ${name}`, ["fetch", "--", name], cx, s); return; }
    if (!s.branch) return;
    const ref = `refs/heads/${s.branch}`;
    if (this.mode === "push-to") { this.run(`Push to ${name}`, ["push", "--", name, `HEAD:${ref}`], cx, s); return; }
    if (this.mode !== "force") return;
    const sequence = this.sequence;
    this.loading = true; this.error = null;
    cx.spawn(async cx => {
      try {
        const r = await exec("git", ["ls-remote", "--heads", "--", name, ref], { cwd: s.root, on: s.on, timeout: 120000 });
        if (!this.current(s) || sequence !== this.sequence) return;
        if (r.code !== 0) throw new Error(r.stderr || "Cannot read remote branch");
        const oid = r.stdout.split("\n").find(line => line.split("\t")[1] === ref)?.split("\t")[0] ?? "";
        if (oid && !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error("Invalid remote branch response");
        this.lease = { remote: name, ref, oid, snapshot: s }; this.mode = "confirm-force";
      } catch (e) { if (this.current(s) && sequence === this.sequence) this.error = e.message; }
      finally { if (sequence === this.sequence) this.loading = false; cx.notify(); }
    });
    cx.notify();
  }

  run(label, args, cx, snapshot = this.menuContext, expectedHead) {
    if (!snapshot || !this.current(snapshot) || !this.enabled()) return;
    const p = this.owner, s = snapshot;
    this.open = null; this.running = label; this.remoteRunning = ["fetch", "pull", "push"].includes(args[0]); this.sequence++;
    p.busy = true; p.note = null;
    cx.spawn(async cx => {
      try {
        const head = await exec("git", [...READ, "symbolic-ref", "--quiet", "HEAD"], { cwd: s.root, on: s.on });
        if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr || "Cannot verify current branch");
        const branch = head.code === 0 ? head.stdout.trim().replace(/^refs\/heads\//, "") : null;
        if (!this.current(s) || branch !== s.branch) throw new Error("Repository or branch changed. Reopen the menu and try again.");
        if (expectedHead !== undefined) {
          const head = await exec("git", [...READ, "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: s.root, on: s.on });
          if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr || "Cannot verify HEAD");
          if (!this.current(s) || (head.code === 0 ? head.stdout.trim() : "") !== expectedHead)
            throw new Error("HEAD changed. Reopen the branch menu and try again.");
        }
        const r = await exec("git", args, { cwd: s.root, on: s.on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Git operation failed").trim());
      } catch (e) { if (this.current(s)) showGitError(label, e, s); }
      finally { p.busy = false; this.running = null; this.remoteRunning = false; p.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  menu(kind, trigger, body, width, cx) {
    return Popover.new(`git-${kind}`).open(this.open === kind).anchor(kind === "repository" ? "top_right" : kind === "branches" ? "bottom_left" : "bottom_right")
      .track_focus(this.focus).on_open_change((open, cx) => this.show(kind, open, cx)).trigger(trigger)
      .when(this.open === kind, el => el.content(v_flex().w(width).max_h(380).p(5).gap(2).bg(this.colors.popover).border_1().border_color(this.colors.border).rounded(8).shadow_md()
        .track_focus(this.focus).on_key_down((e, cx) => {
          if (e.key === "escape") { this.open = null; cx.stop_propagation(); cx.notify(); }
          if (kind === "branches" && ["up", "down"].includes(e.key)) {
            this.at = Math.max(0, Math.min(this.choices().length - 1, this.at + (e.key === "down" ? 1 : -1)));
            this.scroll.scroll_to_item(this.at);
            cx.stop_propagation(); cx.notify();
          }
        }).child(body)));
  }

  option(id, label, action, disabled = false, icon = null) {
    const t = this.colors;
    return Button.new(id).h_flex().h(29).px(8).gap(8).items_center().justify_start().rounded(4).text_size(12).font_normal().text_color(disabled ? t.dim : t.foreground)
      .disabled(disabled).accessibility_label(label).when(!disabled, el => el.hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => action(cx))
      .when(Boolean(icon), el => el.child(svg(`mods/changes-graph/${icon}.svg`).size(14).flex_none().text_color(disabled ? t.dim : t.muted))).child(label);
  }

  branchBody() {
    const t = this.colors, p = this.owner, branches = this.choices(), s = this.menuContext;
    return v_flex().min_h(0).gap(4)
      .child(div().px(8).py(4).text_size(11).text_color(t.muted).child("Local Branches"))
      .child(div().h(28).px(8).border_b(1).border_color(t.border).child(Input.new(this.search).h_full().text_size(12).accessibility_label("Filter or create a branch")))
      .child(v_flex().id("git-branch-list").h(Math.min(290, branches.length * 46)).min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).children(branches.map((b, i) => {
        if (b.create) return Button.new("git-create-branch").h_flex().w_full().h(46).flex_none().px(8).gap(8).items_center().rounded(4).font_normal()
          .accessibility_label(`Create branch ${b.name}`).bg(i === this.at ? t.selected : t.popover).hover(el => el.bg(t.hover))
          .on_click((_e, cx) => this.createBranch(b.name, cx))
          .child(svg("mods/workspace-chrome/plus.svg").size(13).flex_none().text_color(t.muted))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().text_size(12).text_color(t.foreground).child(`Create Branch: "${b.name}"`))
            .child(div().truncate().text_size(10.5).text_color(t.muted).child(s?.head ? `Based on ${s.branch || s.head.slice(0, 8)}` : "No commits yet")));
        const elsewhere = b.worktree && b.worktree !== p.root, current = b.name === p.branch;
        return Button.new(`git-branch-${b.name}`).h_flex().w_full().h(46).flex_none().px(8).gap(8).items_center().rounded(4).font_normal()
          .disabled(current || Boolean(elsewhere)).accessibility_label(`${current ? "Current branch" : "Switch to"} ${b.name}`).tooltip(elsewhere ? `Checked out in ${b.worktree}` : b.name)
          .bg(i === this.at ? t.selected : t.popover).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.switchBranch(b, cx))
          .child(svg(current ? "mods/workspace-chrome/check.svg" : "mods/changes-graph/branch.svg").size(13).flex_none().text_color(current ? t.accent : t.muted))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().truncate().text_size(12).text_color(t.foreground).child(b.name))
            .child(div().truncate().text_size(10.5).text_color(t.muted).child(`${b.author} · ${shortAge(b.timestamp)} · ${b.subject}`)));
      })))
      .when(!branches.length, el => el.child(div().p(8).text_size(11).text_color(t.muted).child(this.loading ? "Loading branches…" : this.error || (this.creation?.pending ? "Checking branch name…" : this.creation?.error || "No matching local branches"))));
  }

  actionBody() {
    const t = this.colors, p = this.owner;
    if (this.mode === "confirm-force") {
      const lease = this.lease;
      return v_flex().gap(6).p(4).text_size(12)
        .child(div().font_semibold().child("Force push this branch?"))
        .child(div().text_size(11).text_color(t.muted).child(`${lease.remote} / ${lease.snapshot.branch}`))
        .child(div().text_size(11).text_color(t.muted).child("May replace remote history. Refuses if the remote branch has changed."))
        .child(this.option("git-force-confirm", "Force Push", cx => this.run("Force push", ["push", `--force-with-lease=${lease.ref}:${lease.oid}`, "--", lease.remote, `HEAD:${lease.ref}`], cx, lease.snapshot)))
        .child(this.option("git-force-cancel", "Cancel", cx => { this.open = null; cx.notify(); }));
    }
    if (this.mode !== "actions") return v_flex().gap(2)
      .child(this.option("git-actions-back", "Back", cx => { this.sequence++; this.mode = "actions"; this.error = null; this.loading = false; cx.notify(); }))
      .child(div().px(8).py(3).text_size(11).text_color(t.muted).child(ACTIONS.find(a => a[0] === this.mode)?.[1] ?? "Choose remote"))
      .children(this.remotes.map(name => this.option(`git-remote-${name}`, name, cx => this.remote(name, cx), this.loading, "remote")))
      .when(this.loading || this.error || !this.remotes.length, el => el.child(div().p(8).text_size(11).text_color(this.error ? t.ansi1 : t.muted).child(this.loading ? "Loading…" : this.error || "No remotes configured")));
    return v_flex().gap(1).children(ACTIONS.flatMap(([id, label, , icon]) => [
      ...(["pull", "push"].includes(id) ? [div().h(1).mx(4).my(4).bg(t.border)] : []),
      this.option(`git-action-${id}`, label, cx => this.action(id, cx), !p.branch && !id.startsWith("fetch"), icon),
    ]));
  }

  repositoryHeader(t, cx) {
    this.colors = t;
    const p = this.owner, snapshot = this.snapshot(), workspace = p.repositories.workspace(), selection = shared(`git.repository.${workspace.id}`);
    const current = p.root && p.context === this.key();
    const title = current ? p.root.split(/[\\/]/).filter(Boolean).pop() : "Repository";
    const option = (id, label, action, disabled = false) => this.option(id, label, cx => { if (this.current(snapshot)) action(cx); }, disabled);
    const body = v_flex().gap(1)
      .child(option("repo-refresh", "Refresh", cx => { this.open = null; p.refresh(cx); p.repositories.refresh(cx, true); cx.notify(); }))
      .child(option("repo-copy", "Copy repository path", cx => { cx.write_to_clipboard(snapshot.root); this.open = null; cx.notify(); }))
      .when(selection?.workspace === workspace.folder && selection?.on === workspace.on, el => el.child(option("repo-follow", "Follow terminal repository", cx => {
        this.open = null; setShared(`git.repository.${workspace.id}`, null); p.refresh(cx); cx.notify();
      })))
      .child(div().h(1).my(4).bg(t.border))
      .child(option("repo-branches", "Switch or create branch…", cx => this.show("branches", true, cx)))
      .child(option("repo-fetch", "Fetch", cx => this.run("Fetch", ["fetch", "--all"], cx, snapshot)))
      .child(option("repo-pull", "Pull", cx => this.run("Pull", ["pull", "--ff-only"], cx, snapshot), !p.branch))
      .child(option("repo-push", "Push", cx => this.run("Push", ["push"], cx, snapshot), !p.branch))
      .child(div().h(1).my(4).bg(t.border))
      .child(option("repo-stashes", "View stashes", cx => { this.open = null; p.selectView("stashes", cx); }))
      .child(option("repo-stash-all", "Stash all changes", cx => { this.open = null; p.stash.create(cx); }, !p.hasHead || !p.files.length || p.files.some(file => file.status === "U")));
    const trigger = Button.new("repository-actions").size(28).flex().items_center().justify_center().rounded(4).bg("#00000000").text_color(t.muted).disabled(!this.enabled())
      .accessibility_label("Repository actions").tooltip("Repository actions").focus(el => el.border_color(t.accent)).child(svg("mods/changes-graph/more.svg").size(14));
    return h_flex().h(40).flex_none().px(14).gap(9).items_center()
      .child(h_flex().flex_1().min_w(0).child(p.repositories.selector(title, t, cx, workspace)))
      .child(this.menu("repository", trigger, body, 240, cx));
  }

  render(t, cx) {
    this.colors = t;
    const p = this.owner, enabled = this.enabled(), hasRepository = Boolean(p.root && p.context === this.key()), branch = p.branch || (p.head ? `Detached · ${p.head.slice(0, 8)}` : "No branch");
    const sync = hasRepository && p.branch ? p.sync : null, snapshot = this.snapshot();
    const primary = sync?.behind > 0 ? { label: `Pull (${sync.behind})`, args: ["pull", "--ff-only"], icon: "download" }
      : sync?.ahead > 0 ? { label: `Push (${sync.ahead})`, args: ["push"], icon: "upload" }
      : { label: "Fetch", args: ["fetch", "--all"], icon: "fetch" };
    const description = sync ? `${sync.ahead} outgoing · ${sync.behind} incoming · ${sync.upstream}` : "Fetch all remotes";
    const trigger = Button.new("git-current-branch").h_flex().h(28).min_w(0).max_w(220).flex_none().px(6).gap(6).items_center().justify_start().rounded(6)
      .bg(this.open === "branches" ? t.hover : "#00000000").border_1().border_color("#00000000").font_normal().text_size(12).text_color(hasRepository ? t.muted : t.dim)
      .disabled(!enabled).accessibility_label(`Switch branch, current: ${branch}`).hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent))
      .child(svg("mods/changes-graph/branch.svg").size(13).flex_none()).child(div().min_w(0).truncate().child(branch))
      .child(svg("mods/changes-graph/chevron.svg").size(11).flex_none().text_color(t.dim));
    const dropdown = Button.new("git-actions-menu").w(20).h(28).flex().items_center().justify_center().rounded(6).bg(this.open === "actions" ? t.hover : "#00000000").border_1().border_color("#00000000").disabled(!enabled)
      .text_color(t.dim).accessibility_label("Git actions").hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent))
      .child(svg("mods/changes-graph/chevron.svg").size(11).flex_none());
    return h_flex().h(38).flex_none().px(10).gap(8).items_center()
      .child(this.menu("branches", trigger, this.branchBody(), 320, cx))
      .child(div().flex_1().min_w(0))
      .child(h_flex().flex_none().h(28).items_center()
        .child(Button.new("git-fetch").h_flex().h(28).px(6).gap(6).items_center().rounded(6).bg("#00000000").border_1().border_color("#00000000").font_normal().text_size(12).text_color(hasRepository ? t.muted : t.dim).disabled(!enabled)
          .accessibility_label(primary.label === "Fetch" ? "Fetch all remotes" : primary.label).tooltip(description).hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent))
          .on_click((_e, cx) => this.run(primary.label, primary.args, cx, snapshot, primary.args[0] === "fetch" ? undefined : snapshot.head))
          .child(svg(this.remoteRunning ? "mods/workspace-chrome/spinner.svg" : `mods/changes-graph/${primary.icon}.svg`).id(this.remoteRunning ? "fetch-action-spinner" : "fetch-action-icon").size(13).flex_none().when(Boolean(this.remoteRunning), el => el.spin(900)))
          .child(primary.label))
        .child(this.menu("actions", dropdown, this.actionBody(), 230, cx)));
  }
}
