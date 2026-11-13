const own = name => `mods/files-browser/icons/${name}.svg`;
const folders = {
  src: "code", source: "code", lib: "code", app: "code", components: "code", hooks: "code", ui: "code",
  test: "test", tests: "test", __tests__: "test", fixtures: "test", spec: "test", specs: "test",
  docs: "book", doc: "book", documentation: "book", examples: "book",
  config: "settings", configs: "settings", settings: "settings", ".config": "settings", ".vscode": "settings",
  assets: "image", images: "image", public: "image", static: "image", fonts: "image",
  dist: "package", build: "package", out: "package", target: "package", coverage: "test", node_modules: "package", vendor: "package",
  ".github": "git", ".gitlab": "git", ".git": "git", ".agents": "agent", ".codex": "agent", ".claude": "agent", skills: "agent",
  scripts: "terminal", bin: "terminal", migrations: "database", database: "database",
};
const extensions = {
  ts: ["icons/tsc.svg", "ansi4"], tsx: ["icons/tsc.svg", "ansi4"], mts: ["icons/tsc.svg", "ansi4"], cts: ["icons/tsc.svg", "ansi4"],
  js: ["icons/node.svg", "ansi3"], jsx: ["icons/node.svg", "ansi3"], mjs: ["icons/node.svg", "ansi3"], cjs: ["icons/node.svg", "ansi3"],
  py: ["icons/python.svg", "ansi3"], rs: ["icons/cargo.svg", "ansi1"], go: ["icons/go.svg", "ansi6"], java: ["icons/java.svg", "ansi1"], rb: ["icons/ruby.svg", "ansi1"],
  md: [own("markdown"), "ansi4"], markdown: [own("markdown"), "ansi4"], mdown: [own("markdown"), "ansi4"],
  json: [own("json"), "ansi3"], jsonc: [own("json"), "ansi3"], yaml: [own("settings"), "ansi5"], yml: [own("settings"), "ansi5"], toml: [own("settings"), "ansi5"], ini: [own("settings"), "ansi5"],
  html: [own("code"), "ansi1"], vue: [own("code"), "ansi2"], svelte: [own("code"), "ansi1"], astro: [own("code"), "ansi5"], css: [own("style"), "ansi4"], scss: [own("style"), "ansi5"],
  sh: [own("terminal"), "ansi2"], bash: [own("terminal"), "ansi2"], zsh: [own("terminal"), "ansi2"], ps1: [own("terminal"), "ansi4"],
  png: [own("image"), "ansi5"], jpg: [own("image"), "ansi5"], jpeg: [own("image"), "ansi5"], gif: [own("image"), "ansi5"], svg: [own("image"), "ansi3"], webp: [own("image"), "ansi5"], ico: [own("image"), "ansi5"],
  sql: [own("database"), "ansi3"], sqlite: [own("database"), "ansi3"], db: [own("database"), "ansi3"],
  lock: [own("lock"), "muted"], zip: [own("package"), "ansi3"], gz: [own("package"), "ansi3"], tar: [own("package"), "ansi3"],
};
export function fileIcon(name, directory = false) {
  const lower = name.toLowerCase();
  if (directory) return { path: "mods/files-browser/folder.svg", color: folders[lower] ? "ansi4" : "muted", badge: folders[lower] ? own(folders[lower]) : null };
  const special = lower === "package.json" ? ["icons/npm.svg", "ansi1"]
    : lower.startsWith("bun.lock") ? ["icons/bun.svg", "muted"]
    : lower.startsWith("pnpm-lock") ? ["icons/pnpm.svg", "ansi3"]
    : lower.startsWith("dockerfile") || lower.startsWith("compose.") || lower.startsWith("docker-compose.") ? ["icons/docker.svg", "ansi4"]
    : lower.startsWith(".git") ? ["icons/git.svg", "ansi1"]
    : /^\.?env(?:\.|$)/.test(lower) ? [own("lock"), "ansi3"]
    : /^(?:license|licence|copying)(?:\.|$)/.test(lower) ? [own("license"), "ansi3"]
    : /^(?:makefile|gnumakefile)$/.test(lower) ? ["icons/make.svg", "ansi2"] : null;
  const [path, color] = special || extensions[lower.split(".").pop()] || ["mods/files-browser/file.svg", "muted"];
  return { path, color, badge: null };
}
