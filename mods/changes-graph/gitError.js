import { openOverlay } from "herdr";

export function failureInfo(label, error) {
  const detail = String(error?.message ?? error).trim();
  if (/would be overwritten|please commit your changes or stash|untracked working tree files/i.test(detail))
    return { title: label.startsWith("Switch to ") ? "Couldn’t switch branches" : "Local changes block this operation", message: "Commit or stash your changes, then try again.", detail };
  if (/authentication failed|permission denied|could not read Username|terminal prompts disabled/i.test(detail))
    return { title: "Git couldn’t authenticate", message: "Check your Git credentials and repository access.", detail };
  if (/could not resolve host|failed to connect|network is unreachable|connection timed out/i.test(detail))
    return { title: "Couldn’t reach the remote", message: "Check your connection and try again.", detail };
  if (/non-fast-forward|stale info|fetch first/i.test(detail))
    return { title: "The remote branch has changed", message: "Fetch and review the latest changes before pushing.", detail };
  return { title: label.startsWith("Switch to ") ? "Couldn’t switch branches" : `${label} couldn’t complete`, message: "Review the Git details before trying again.", detail };
}

export function showGitError(label, error, snapshot) {
  const info = failureInfo(label, error);
  return openOverlay({ mod: "git-error", kind: "dialog", width: 380,
    props: { ...info, label, root: snapshot.root, branch: snapshot.branch } });
}
