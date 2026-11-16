# GitHub synchronization status

**Remote:** `origin` -> `https://github.com/Demmonics/cloak.git`

**Visibility:** PUBLIC

**Observed account permission:** ADMIN

**Default branch protection:** `main` reported unprotected (GitHub API 404). No protection is bypassed; the worker never pushes to `main`.

**Public `origin/main`:** `ac1a76a`

**Local implementation `main`:** `360a827`, 16 commits ahead at last check; blocked from publication because outgoing history contains personal-derived media and private project content.

**Documentation branch:** `copilot/documentation-sync`, based directly on `origin/main`; first safe docs checkpoint pending.

**Last successful Copilot push:** None yet.
**Worker:** Configuration is restricted to the Copilot documentation branch. Scheduled-task installation and push verification are pending.

## Publishing policy

The worker pushes only committed changes on `copilot/documentation-sync`, only when every outgoing commit includes `Privacy-Reviewed: yes`, every changed path is inside the Copilot docs/worker allowlist, the remote URL and public repository metadata match configuration, and the branch is a fast-forward. It does not stage, commit, switch, merge, or push any Antigravity/Codex branch. It does not force push.

The local feature branches are deliberately not published. A machine-generated status snapshot and JSONL log are kept in the worker worktree/AppData; no credentials or private content are logged.
