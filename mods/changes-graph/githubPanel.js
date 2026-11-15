import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Scrollbar, InputState, Input, Tabs, Tab, ScrollHandle } from "gpui-base";
import { exec, appHome, shared, setShared, openOverlay, focused, panes, run } from "herdr";
import { shortAge } from "./graph.js";
import { reviewMarkdown } from "./reviewMarkdown.js";

export async function githubCall(action, request) {
  let args = [`${appHome()}/helpers/noodle/workspace.py`, `github_${action}`, JSON.stringify({ home: appHome(), ...request })];
  if (request.on) {
    const bootstrap = "import json,os,pathlib,runpy,sys; home=os.environ.get('HERDR_APP_HOME',str(pathlib.Path.home()/'.config/herdr-app')); helper=pathlib.Path(home)/'helpers/noodle/workspace.py'; request=json.loads(sys.argv[2]); request['home']=home; sys.path.insert(0,str(helper.parent)); sys.argv=[str(helper),sys.argv[1],json.dumps(request)]; runpy.run_path(str(helper),run_name='__main__')";
    args = ["-c", bootstrap, `github_${action}`, JSON.stringify(request)];
  }
  const result = await exec("python3", args, { on: request.on, timeout: action === "generate" ? 240000 : 120000 });
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error("GitHub returned an invalid response. Refresh to try again."); }
  if (result.code || value.error) throw new Error(value.error || result.stderr || "GitHub request failed.");
  return value;
}

export function githubButton(id, label, action, t, disabled = false) {
  return Button.new(id).h_flex().h(28).px(9).flex_none().gap(6).items_center().justify_center().rounded(5)
    .border_1().border_color(t.border).bg(t.raised).text_size(12).font_normal().text_color(t.foreground)
    .disabled(disabled).when(disabled, el => el.opacity(0.5)).accessibility_label(label).hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
    .on_click((_e, cx) => action(cx)).child(label);
}

export function githubOpen(cx, url) {
  if (typeof url === "string" && /^https:\/\/[^\s/]+\//.test(url)) cx.open_url(url);
}

export function threadMarkdown(pr, thread) {
  const state = [thread.isResolved ? "Resolved" : "Unresolved", ...(thread.isOutdated ? ["Outdated"] : [])].join(" · ");
  return `### ${thread.path}:${thread.line || thread.originalLine || "?"} (${state})\n\n${pr.html_url}\n\n`
    + thread.comments.map(comment => `**${comment.author?.login || "Reviewer"}** · ${comment.url}\n\n${comment.body}`).join("\n\n---\n\n");
}

export function prCounts(pr) {
  const checks = pr?.statusCheckRollup || [];
  return { total: checks.length, failed: checks.filter(c => /FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED/.test(c.conclusion || c.state || "")).length,
    unresolved: (pr?.threads || []).filter(thread => !thread.isResolved).length };
}

export class GithubPanel {
  constructor(owner, key, cx) {
    this.owner = owner; this.key = key;
    if (!owner.preview) {
      this.listScroll = ScrollHandle.new();
      this.search = InputState.new({ placeholder: "Filter pull requests…" });
      this.search.on("change", (_e, cx) => { this.listScroll.scroll_to_item(0); cx.notify(); });
    }
    this.reset();
    cx.timer.every(15000, cx => {
      if ((owner.preview ? !this.active() : owner.view !== "github") || this.loading || this.detailLoading || !owner.root) return;
      if (this.mode === "workflows" && (owner.preview ? this.run && this.run.status !== "completed" : this.runs.some(run => run.status !== "completed"))) this.refresh(cx);
      else if (this.mode === "prs" && this.pr?.statusCheckRollup?.some(check => ["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED"].includes(check.status || check.state))) this.showPr(this.pr, cx);
    });
  }

  reset() {
    this.mode = "prs"; this.info = null; this.prs = []; this.runs = []; this.pr = null; this.run = null; this.log = null;
    this.page = 1; this.more = false; this.allBranches = false; this.loading = false; this.detailLoading = false;
    this.prNumber = null; this.runId = null; this.selectedPrRow = null; this.loadedBranch = null; this.threadLimit = 50; this.reviewLimit = 50;
    this.detailSection = "overview";
    this.error = null; this.folded = {}; this.version = (this.version || 0) + 1; this.detailVersion = (this.detailVersion || 0) + 1;
  }
  snapshot() { const p = this.owner; return { root: p.root, on: p.on, context: p.context, branch: p.branch, head: p.head }; }
  current(s) { return s.context === this.key() && s.context === this.owner.context && s.root === this.owner.root && s.on === this.owner.on; }
  enter(cx) {
    if (this.loadedBranch != null && this.loadedBranch !== this.owner.branch) { const mode = this.mode; this.reset(); this.mode = mode; }
    if (!this.info) this.refresh(cx);
  }

  refresh(cx, more = false) {
    if (this.loading || !this.owner.root) return;
    const s = this.snapshot(), version = ++this.version, mode = this.mode, page = more ? this.page + 1 : 1;
    this.loading = true; this.error = null;
    cx.spawn(async cx => {
      try {
        const [info, data] = await Promise.all([this.info || githubCall("info", s),
          githubCall(mode === "prs" ? "prs" : "runs", { ...s, page, branch: this.allBranches ? null : s.branch })]);
        if (!this.current(s) || version !== this.version || mode !== this.mode) return;
        this.info = info; this.loadedBranch = s.branch; this.page = page; this.more = data.more;
        if (mode === "prs") {
          this.prs = more ? [...this.prs, ...data.items.filter(pr => !this.prs.some(old => old.number === pr.number))] : data.items;
          const chosen = this.prs.find(pr => pr.number === this.prNumber) || this.selectedPrRow
            || (!this.prNumber && (this.prs.find(pr => pr.head.ref === s.branch && pr.head.repo?.full_name === info.repo.name) || info.current));
          if (chosen) {
            this.prNumber = chosen.number;
            this.selectedPrRow = chosen;
            if (!this.prs.some(pr => pr.number === chosen.number)) this.prs.unshift(chosen);
          }
        } else {
          this.runs = more ? [...this.runs, ...data.items.filter(run => !this.runs.some(old => old.id === run.id))] : data.items;
          const selected = this.runs.find(run => run.id === this.runId);
          if (selected) this.runId = selected.id;
        }
      } catch (error) { if (this.current(s) && version === this.version) this.error = error.message; }
      finally { if (version === this.version) { this.loading = false; cx.notify(); } }
    }); cx.notify();
  }

  switch(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode; this.version++; this.detailVersion++; this.loading = false; this.detailLoading = false;
    this.log = null; this.refresh(cx);
  }

  detail(action, request, cx, next) {
    const s = this.snapshot(), version = ++this.detailVersion;
    this.detailLoading = true; this.error = null;
    cx.spawn(async cx => {
      try {
        const value = await githubCall(action, { ...s, ...request });
        if (this.current(s) && version === this.detailVersion) {
          next(value, cx);
          if (this.owner.preview && action === "pr") setShared(`${this.selectionKey}.summary`, { root: s.root, on: s.on, number: value.number, head: value.head.sha, state: value.state, ...prCounts(value) });
        }
      } catch (error) { if (this.current(s) && version === this.detailVersion) this.error = error.message; }
      finally { if (version === this.detailVersion) { this.detailLoading = false; cx.notify(); } }
    }); cx.notify();
  }
  showPr(pr, cx) {
    this.prNumber = pr.number; this.log = null;
    if (this.pr?.number !== pr.number) { this.pr = null; this.detailSection = "overview"; this.threadLimit = 50; this.reviewLimit = 50; }
    this.detail("pr", { number: pr.number }, cx, value => { this.pr = value; });
  }
  showRun(run, cx) {
    this.runId = run.id;
    if (this.run?.id !== run.id) { this.run = null; this.log = null; }
    this.detail("run", { run: run.id }, cx, value => { this.run = value; });
  }
  logText(value) { return `${this.run.html_url}\nCommit: ${value.head}${value.truncated ? "\nTruncated: last 200,000 bytes" : ""}\n\n${value.text}`; }
  logs(cx, job, failed, copy = false) {
    this.detail("log", { run: this.run.id, job, failed }, cx, (value, cx) => { this.log = value; if (copy) cx.write_to_clipboard(this.logText(value)); });
  }
  openPreview(row, mode, cx) {
    const s = this.snapshot(), f = focused();
    if (!this.current(s) || !f?.tab) return;
    const all = panes(), selectionKey = `github.preview.${f.tab}`, previous = shared(selectionKey);
    const source = all.find(p => p.pane === f.pane && p.terminal)
      || all.find(p => p.pane === previous?.sourcePane && p.tab === f.tab && p.terminal)
      || all.find(p => p.tab === f.tab && p.terminal);
    if (!source) { this.error = "Open a terminal pane before opening a GitHub preview."; cx.notify(); return; }
    if (mode === "pr") { this.prNumber = row.number; this.selectedPrRow = row; } else this.runId = row.id;
    setShared(selectionKey, { ...s, repository: this.info?.repo.name, tab: f.tab, sourcePane: source.pane, mode, number: mode === "pr" ? row.number : row.id,
      title: row.title || row.display_title || row.name, revision: `${Date.now()}:${this.previewSequence = (this.previewSequence || 0) + 1}` });
    const existing = all.find(p => p.tab === f.tab && p.mod === "changes-graph");
    if (existing) run("pane.focus", { pane: existing.pane });
    else run("pane.split", { pane: source.pane, direction: "right", mod: "changes-graph", props: { githubPreview: true, selectionKey } });
    cx.notify();
  }
  refreshPreview() {
    const selectionKey = `github.preview.${focused()?.tab}`, selection = shared(selectionKey);
    if (selection?.root === this.owner.root && selection.on === this.owner.on)
      setShared(selectionKey, { ...selection, revision: `${Date.now()}:${this.previewSequence = (this.previewSequence || 0) + 1}` });
  }
  newPr(cx) {
    const p = this.owner;
    if (!this.info || !p.head || !p.branch || p.busy || !this.current(this.snapshot())) return;
    openOverlay({ mod: "changes-graph", props: { prComposer: true, ...this.snapshot(), sync: p.sync, info: this.info }, kind: "dialog", modal: true, frame: "none", width: 660, height: 600 });
  }
  openThread(thread, cx) {
    const pr = this.pr, comment = thread.comments[0];
    if (thread.isOutdated || thread.diffSide === "LEFT") { githubOpen(cx, comment?.url || pr.html_url); return; }
    this.detail("location", { number: pr.number, path: thread.path, reviewedHead: pr.head.sha }, cx, (value, cx) => {
      if (!value.local) githubOpen(cx, comment?.url || pr.html_url);
      else this.owner.openFile({ path: thread.path, status: "M" }, null, cx, { hash: value.head, kind: "file", navigation: { line: thread.line || thread.originalLine || 1 } });
    });
  }

  status(t, value) {
    const text = String(value || "pending").replace(/_/g, " ").toLowerCase();
    return div().flex_none().text_size(11).text_color(/fail|error|cancel|timed out|action required/.test(text) ? t.ansi1 : /success|approved/.test(text) ? t.ansi2 : /pending|progress|queued|waiting/.test(text) ? t.ansi3 : t.muted).child(text);
  }
  section(title, children, t) {
    return v_flex().flex_none().gap(8).pt(14).border_t(1).border_color(t.border)
      .child(div().text_size(12).font_semibold().child(title)).children(children);
  }
  markdown(id, value, t) { return reviewMarkdown(id, value, t); }

  prDetail(t, cx) {
    const pr = this.pr;
    if (!pr) return div();
    const button = (id, label, fn, disabled = false) => githubButton(id, label, fn, t, disabled);
    const workflows = new Map();
    for (const check of pr.statusCheckRollup || []) {
      const group = check.workflowName || (check.name || check.context || "Checks").split(" / ")[0];
      if (!workflows.has(group)) workflows.set(group, []);
      workflows.get(group).push(check);
    }
    const counts = prCounts(pr);
    return v_flex().id("github-pr-detail").flex_none().gap(12)
      .when(this.detailSection === "overview", el => el
        .child(div().text_size(12).font_semibold().child(counts.failed || counts.unresolved ? "Needs your attention" : "PR status"))
        .when(counts.failed > 0, el => el.child(button("github-attention-checks", `${counts.failed} failed ${counts.failed === 1 ? "check" : "checks"}`, cx => { this.detailSection = "checks"; cx.notify(); }).w_full().justify_start().text_color(t.ansi1)))
        .when(counts.unresolved > 0, el => el.child(button("github-attention-reviews", `${counts.unresolved} unresolved review ${counts.unresolved === 1 ? "thread" : "threads"}`, cx => { this.detailSection = "reviews"; cx.notify(); }).w_full().justify_start().text_color(t.ansi3)))
        .when(!counts.failed && !counts.unresolved, el => el.child(div().text_size(12).text_color(t.muted).child(pr.reviewDecision || (counts.total ? "No failing checks or unresolved threads" : "No checks reported"))))
        .child(this.markdown(`github-body-${pr.number}`, pr.body, t))
        .child(h_flex().gap(6).child(button("github-open-pr", "Open on GitHub", cx => githubOpen(cx, pr.html_url)))
          .child(button("github-copy-pr", "Copy link", cx => cx.write_to_clipboard(pr.html_url)))))
      .when(this.detailSection === "checks", el => el
      .child(this.section("Checks", [...workflows].map(([name, checks], i) => v_flex().gap(5)
        .child(div().text_size(11).text_color(t.muted).child(name))
        .children(checks.slice().sort((a, b) => Number(!/FAILURE|ERROR/.test(a.conclusion || a.state)) - Number(!/FAILURE|ERROR/.test(b.conclusion || b.state))).map((check, j) => Button.new(`github-check-${i}-${j}`).w_full().min_h(28).h_flex().gap(8).px(5).items_center().bg("#00000000").rounded(4).hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
          .accessibility_label(`Open ${check.name || check.context}`).on_click((_e, cx) => githubOpen(cx, check.detailsUrl || check.targetUrl))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(check.name || check.context))
          .child(this.status(t, check.conclusion || check.status || check.state))))), t)))
      .when(this.detailSection === "checks" && !workflows.size, el => el.child(div().text_size(12).text_color(t.muted).child("No checks reported for this PR.")))
      .when(this.detailSection === "reviews", el => el.child(this.section("Reviews", [
        div().text_size(11).text_color(t.muted).child(pr.reviewDecision || "No review decision"),
        ...pr.reviews.slice(0, this.reviewLimit).map(review => v_flex().gap(5).py(7).border_b(1).border_color(t.border)
          .child(h_flex().gap(8).items_center().child(div().flex_1().text_size(12).child(review.user?.login || "Reviewer")).child(this.status(t, review.state)))
          .when(Boolean(review.body), el => el.child(this.markdown(`github-review-${review.id}`, review.body, t)))
          .child(h_flex().justify_end().child(button(`github-copy-review-${review.id}`, "Copy review", cx => cx.write_to_clipboard(`## ${review.user?.login || "Reviewer"}: ${review.state}\n\n${review.html_url}\n\n${review.body || ""}`))))),
        ...(pr.reviews.length > this.reviewLimit ? [button("github-more-reviews", "Show more reviews", cx => { this.reviewLimit += 50; cx.notify(); })] : []),
        button("github-copy-unresolved", "Copy unresolved reviews", cx => cx.write_to_clipboard(pr.threads.filter(thread => !thread.isResolved).map(thread => threadMarkdown(pr, thread)).join("\n\n---\n\n")), !pr.threads.some(thread => !thread.isResolved)),
        ...pr.threads.slice().sort((a, b) => Number(a.isResolved) - Number(b.isResolved)).slice(0, this.threadLimit).map((thread, index) => {
          const folded = this.folded[thread.id] ?? thread.isResolved;
          return v_flex().gap(6).py(8).border_b(1).border_color(t.border)
            .child(Button.new(`github-thread-${index}`).h_flex().w_full().min_h(28).gap(7).items_center().bg("#00000000").text_color(t.foreground).hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
              .accessibility_label(`${folded ? "Expand" : "Collapse"} ${thread.path} review`).on_click((_e, cx) => { this.folded[thread.id] = !folded; cx.notify(); })
              .child(svg(folded ? "mods/changes-graph/plus.svg" : "mods/changes-graph/minus.svg").size(10))
              .child(div().flex_1().min_w(0).truncate().text_size(12).child(`${thread.path}:${thread.line || thread.originalLine || "?"}`))
              .child(this.status(t, thread.isResolved ? "resolved" : "unresolved")))
            .when(thread.isOutdated, el => el.child(div().text_size(11).text_color(t.muted).child("Outdated")))
            .when(!folded, el => el.children(thread.comments.map(comment => v_flex().gap(4).pl(10)
              .child(div().text_size(11).text_color(t.muted).child(comment.author?.login || "Reviewer"))
              .child(this.markdown(`github-comment-${comment.id}`, comment.body, t))))
              .child(h_flex().gap(6).justify_end()
                .child(button(`github-location-${index}`, "Open location", cx => this.openThread(thread, cx), this.detailLoading))
                .child(button(`github-copy-thread-${index}`, "Copy thread", cx => cx.write_to_clipboard(threadMarkdown(pr, thread))))));
        }),
        ...(pr.threads.length > this.threadLimit ? [button("github-more-threads", "Show more threads", cx => { this.threadLimit += 50; cx.notify(); })] : []),
      ], t)));
  }

  prHeader(t) {
    const pr = this.pr;
    if (!pr) return div();
    return v_flex().id("github-pr-header").flex_none().px(14).py(12).gap(7).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center().child(this.status(t, pr.draft ? "draft" : pr.state))
        .child(div().text_size(11).text_color(t.muted).child(`PR #${pr.number}`)))
      .child(div().text_size(14).font_semibold().child(pr.title))
      .child(div().text_size(11).text_color(t.muted).child(`${pr.head.ref} → ${pr.base.ref} · ${pr.head.sha.slice(0, 8)}`));
  }

  detailTabs(t) {
    const counts = prCounts(this.pr);
    return Tabs.new("github-detail-tabs").h_flex().h(38).flex_none().px(14).gap(14).border_b(1).border_color(t.border).overflow_x_scrollbar()
      .children([["overview", "Overview"], ["checks", counts.failed ? `Checks · ${counts.failed} failed` : `Checks · ${counts.total}`], ["reviews", `Reviews · ${counts.unresolved}`]].map(([section, label]) =>
        Tab.new(`github-detail-${section}`).h_flex().h(38).flex_none().px(1).items_center().text_size(12).selected(this.detailSection === section)
          .bg("#00000000").text_color(this.detailSection === section ? t.foreground : section === "checks" && counts.failed ? t.ansi1 : t.muted)
          .border_b(this.detailSection === section ? 2 : 0).border_color(t.accent).accessibility_label(label).focus(el => el.bg(t.hover))
          .on_click((_e, cx) => { this.detailSection = section; cx.notify(); }).child(label)));
  }

  runDetail(t) {
    const run = this.run;
    if (!run) return div();
    const button = (id, label, fn) => githubButton(id, label, fn, t, this.detailLoading);
    return v_flex().id("github-run-detail").flex_none().gap(10).pt(14)
      .child(div().font_semibold().child(run.display_title || run.name))
      .child(div().text_size(11).text_color(t.muted).child(`${run.head_branch} · ${run.head_sha.slice(0, 8)}`))
      .when(Boolean(run.run_started_at), el => el.child(div().text_size(11).text_color(t.muted)
        .child(`Duration: ${Math.max(0, Math.round(((run.status === "completed" ? Date.parse(run.updated_at) : Date.now()) - Date.parse(run.run_started_at)) / 1000))}s`)))
      .child(h_flex().gap(6).child(button("github-open-run", "Open on GitHub", cx => githubOpen(cx, run.html_url)))
        .child(button("github-failed-logs", "Copy failure logs", cx => this.logs(cx, null, true, true))))
      .children((run.jobs || []).map(job => this.section(job.name, [
        h_flex().gap(8).items_center().child(this.status(t, job.conclusion || job.status))
          .child(div().flex_1().text_size(11).text_color(t.muted).child(job.started_at && job.completed_at ? `${Math.max(0, Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000))}s` : ""))
          .child(button(`github-job-log-${job.id}`, "Logs", cx => this.logs(cx, job.id, false))),
        ...(job.steps || []).map(step => h_flex().min_h(26).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(step.name)).child(this.status(t, step.conclusion || step.status))),
      ], t)))
      .when(Boolean(this.log), el => el.child(this.section("Logs", [
        h_flex().gap(8).items_center().child(div().flex_1().text_size(11).text_color(t.muted).child(`${this.log.head.slice(0, 8)}${this.log.truncated ? " · last 200,000 bytes" : ""}`))
          .child(githubButton("github-copy-log", "Copy logs", cx => cx.write_to_clipboard(this.logText(this.log)), t)),
        div().h(280).overflow_y_scrollbar().overflow_x_scroll().p(10).bg(t.canvas).font_family("JetBrains Mono").text_size(11).line_height("17px").child(this.log.text || "No matching log lines."),
      ], t)));
  }

  render(t, cx) {
    const p = this.owner, workflows = this.mode === "workflows", query = this.search.value().trim().toLowerCase();
    const button = (id, label, fn, disabled = false) => githubButton(id, label, fn, t, disabled);
    const rows = workflows ? this.runs : this.prs.filter(row => `${row.number} ${row.title} ${row.user?.login || ""} ${row.head.ref}`.toLowerCase().includes(query));
    const summary = shared(`github.preview.${focused()?.tab}.summary`);
    return v_flex().id("github-panel").flex_1().min_h(0)
      .child(h_flex().h(44).px(12).gap(6).flex_none().items_center().overflow_x_scrollbar().border_b(1).border_color(t.border)
        .children([["prs", "Pull requests"], ["workflows", "Workflows"]].map(([mode, label]) => button(`github-mode-${mode}`, label, cx => this.switch(mode, cx)).bg(this.mode === mode ? t.selected : "#00000000")))
        .child(div().flex_1())
        .child(Button.new("github-refresh").size(28).flex_none().flex().items_center().justify_center().rounded(5).bg("#00000000").text_color(t.muted).disabled(this.loading || !p.root)
          .accessibility_label("Refresh GitHub").tooltip("Refresh GitHub").hover(el => el.bg(t.hover)).focus(el => el.bg(t.hover))
          .on_click((_e, cx) => { this.refresh(cx); this.refreshPreview(); }).child(svg(this.loading ? "mods/workspace-chrome/spinner.svg" : "mods/changes-graph/fetch.svg").size(13).when(this.loading, el => el.spin(900))))
        .child(button("github-new-pr", "New PR", cx => this.newPr(cx), !this.info || !p.head || !p.branch || p.busy || Boolean(p.on) || Boolean(this.error))
          .tooltip(p.on ? "PR creation requires a local checkout" : "Create a pull request for this branch")))
      .when(!workflows, el => el.child(div().flex_none().px(12).pt(10).pb(6)
        .child(Input.new(this.search).h(30).w_full().px(8).rounded(5).border_1().border_color(t.input).bg(t.canvas).text_size(12).accessibility_label("Filter pull requests"))))
      .when(workflows, el => el.child(h_flex().flex_none().px(12).py(8).gap(6).items_center()
        .child(button("github-branch-filter", this.allBranches ? "All branches" : p.branch || "All branches", cx => { this.allBranches = !this.allBranches; this.version++; this.loading = false; this.runId = null; this.refresh(cx); })
          .tooltip(this.allBranches ? "Show runs for the current branch" : "Show runs for all branches"))))
      .when(Boolean(this.error), el => el.child(v_flex().flex_none().px(14).py(10).gap(4).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.ansi1).child(this.error))
        .when(Boolean(this.prs.length || this.runs.length), el => el.child(div().text_size(11).text_color(t.muted).child("Showing the last available data. Refresh to try again.")))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("github-content").absolute().inset_0().overflow_y_scroll().track_scroll(this.listScroll).px(6).pb(14).gap(1)
          .child(div().px(7).py(8).text_size(11).text_color(t.muted).child(`${workflows ? "Workflow runs" : "Pull requests"} · ${rows.length}`))
          .children(rows.map(row => {
            const id = workflows ? row.id : row.number, selected = workflows ? this.runId === id : this.prNumber === id;
            const counts = !workflows && summary?.root === p.root && summary.on === p.on && summary.number === id && summary.head === row.head.sha ? summary : null;
            return Button.new(`github-row-${id}`).w_full().min_h(52).py(9).px(8).flex_none().h_flex().gap(8).items_start().rounded(4).bg(selected ? t.selected : "#00000000").text_color(t.foreground)
              .accessibility_label(workflows ? `View workflow ${row.display_title || row.name}` : `View PR ${id}: ${row.title}`).hover(el => el.bg(t.hover)).focus(el => el.border_1().border_color(t.accent))
              .on_click((_e, cx) => this.openPreview(row, workflows ? "run" : "pr", cx))
              .child(svg(workflows ? "mods/changes-graph/history.svg" : "mods/changes-graph/github.svg").size(13).mt(2).flex_none().text_color(workflows && row.conclusion === "failure" || counts?.failed ? t.ansi1 : t.muted))
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(div().text_size(12).child(workflows ? row.display_title || row.name : row.title))
                .child(div().truncate().text_size(11).text_color(t.muted).child(workflows ? `${row.name} · ${row.head_branch} · ${shortAge(Date.parse(row.created_at) / 1000)}` : `#${id} · ${row.user?.login || ""} · ${row.head.ref} → ${row.base.ref}`))
                .when(!workflows && row.head.ref === p.branch && row.head.repo?.full_name === this.info?.repo.name, el => el.child(div().text_size(11).text_color(t.accent).child("Current branch")))
                .when(Boolean(counts), el => el.child(div().text_size(11).text_color(counts?.failed ? t.ansi1 : t.muted).child(`${counts?.failed ? `${counts.failed} failed` : `${counts?.total} checks`} · ${counts?.unresolved} unresolved threads`)))
                .when(workflows || row.draft || counts?.state === "closed", el => el.child(this.status(t, workflows ? row.conclusion || row.status : counts?.state === "closed" ? "closed" : "draft"))));
          }))
          .when(this.more, el => el.child(button("github-load-more", "Load more", cx => this.refresh(cx, true), this.loading)))
          .when(!rows.length && !this.error, el => el.child(v_flex().px(12).py(30).gap(8).items_center().text_color(t.muted)
            .child(svg("mods/changes-graph/github.svg").size(24)).child(div().font_semibold().child(this.loading ? "Loading GitHub…" : query && !workflows ? "No matching pull requests" : workflows ? "No workflow runs" : "No open pull requests"))
            .child(div().text_size(12).child(query && !workflows ? "Try a different title, number, author, or branch." : workflows ? "Runs for the selected branch appear here." : "Create a pull request for your committed changes."))))
          .when(rows.length > 0, el => el.child(div().px(8).pt(14).text_size(11).text_color(t.muted).child(`Select a ${workflows ? "run" : "PR"} to open its details beside the terminal.`))))
        .child(Scrollbar.vertical("github-content").absolute().inset_0()))
      .child(this.owner.gitToolbar.render(t, cx).border_t(1).border_color(t.border));
  }
}
