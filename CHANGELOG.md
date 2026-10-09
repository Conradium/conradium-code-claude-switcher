# Changelog

## 0.4.0

Renamed to **Conradium Code: Claude Account Switcher**, now published by Conradium. Because the
extension ID changed, profiles saved by the previous version are not carried over: add your
accounts again after installing.

Redesigned accounts panel.

- New look: a usage-dial icon on a teal tile replaces the orange Claude-style icon on the
  Marketplace, in the sidebar and on Claude tabs. The panel and the chat use teal for buttons,
  selection, focus, usage bars and the thinking / working indicator, and Claude orange for what
  is live or waiting on you (running tools, permission requests).
- The panel has two sections: **Claude Code**, the account the Claude Code extension uses in this
  window, and **Conradium Code**, the other accounts, which run in their own Claude tabs. Each
  card shows an avatar in the account's color, plan, login email and one primary action:
  **Open tab** (or **Show tab** while one is open). Use in Claude Code (switch), New Claude tab,
  Open in new window, Refresh, Say Hi, Reauthorize, Title bar button, Color, Rename and Remove
  are in the card's `⋯` menu.
- A **+ Add account** button below the accounts replaces Save current / + Add account; its menu
  also offers browser authorization and terminal login, which were not reachable from the panel.
- The panel has no toolbar of its own. Refresh is in the view title bar; Say Hi, Open account
  windows, Undo last switch, Settings and Getting started are in its overflow menu. Commands use
  the `Claude` category, so menus no longer repeat the "Claude:" prefix.
- A profile whose login was revoked shows an inline alert with a Reauthorize button.
- When Claude Code is signed in to an account that is not saved, the Claude Code section says so
  and offers Save as profile.
- Each account gets one of five colors (teal, orange, violet, blue, pink), unique among accounts.
  **Color…** in the card menu picks another one, swapping with the account that has it.
- Up to five accounts can be saved, one per color. At five, **+ Add account** is replaced by a
  note, and adding or saving another login is refused before any login starts. Profiles saved
  before this release are kept even beyond five; a profile without a color takes the first one
  that frees up.
- **Open in Claude tab** opens a Claude Code chat tab for another account in the current
  window: our own chat UI over the Claude Code CLI running headless with `CLAUDE_CONFIG_DIR` set
  to the profile's config dir, instead of a whole new VS Code window. It streams replies, shows
  tool calls and diffs, answers permission prompts and questions inline, switches permission
  mode, stops a turn, and resumes the session if Claude Code exits. The account stays reserved while the tab is open, and its card shows a **Tab** chip
  that jumps to it.
- The Claude tab was rebuilt with a full chat layout: a header with History, Settings and New
  chat; a composer with model, permission mode and thinking-effort pickers, `/` command and `@`
  file pickers, and image paste, drop and attach; and a status line with context use, tokens and
  cost.
- **Restore checkpoint** on a prompt puts the files Claude changed since then back, using Claude
  Code's file checkpointing (setting `claudeSwitcher.chat.checkpoints`, on by default).
- **History** lists the account's earlier conversations in this folder and resumes one with its
  messages shown.
- Claude's questions (AskUserQuestion) open in a panel in place of the composer: one tab per
  question, radio buttons or checkboxes, an **Other** option with a text field, and a side-by-side
  preview for options that have one. Keyboard: arrows choose and switch questions, number keys
  pick, Ctrl+Enter submits. **Esc** (or ×) declines and interrupts the turn. The conversation
  keeps a collapsible **Questions** step showing what was picked, or "Declined · Tool
  interrupted", including in resumed conversations.
- Edit and Write cards show a line diff with **Open diff** for VS Code's diff editor; file paths
  open the file.
- Auto mode and Bypass permissions are available in the mode picker; Bypass asks for
  confirmation and restarts Claude Code with the required flag.
- The settings drawer shows MCP servers (enable, disable, reconnect) and saved permission rules.
- The tab warns when its Claude Code login is not the profile's account.
- Above the composer, the tab shows the account's plan limits (5h session and weekly bars, with
  reset times), updated with every usage poll; click the refresh icon to poll now. The status
  line shows context window use from the start of the session.
- Buttons in the editor title bar, next to Claude Code's own, open Claude tabs: one per account
  in that account's color, up to five, for every account except the one Claude Code itself uses.
  Each click opens another tab, like Claude Code's own button. Turn one account's button off with **Title bar
  button** in its card menu, or all of them with `claudeSwitcher.showEditorTitleButton`. When no
  account has a button, a single button opens a picker instead. Claude tabs use the same colored
  icon, and follow renames and color changes while open. The buttons sit directly after Claude
  Code's, ordered by color name, and their commands are named `Claude tab: Open for …`.
- Once a prompt scrolls out of view, it stays pinned at the top of the tab with its image
  attachments; click it to jump back. Resumed conversations keep their prompts' images.
- The chat stays scrolled to the bottom, also while replies, tool output and images finish
  rendering and when a tab is reopened. Scroll up to read and it stays put; scroll back to the
  bottom and it follows again.
- Replies and tool calls sit on a timeline with a status dot: green when an action finished,
  red when it failed, hollow when it was stopped, orange while it runs.
- Claude tabs no longer give Claude the task-list tools (`TodoWrite`, `TaskCreate`,
  `TaskUpdate`, `TaskList`, `TaskGet`): current models keep track of their work without them,
  and every call only cost tokens.
- Each turn has one continuous timeline from its first action to its last, with every
  thinking step, tool call and reply as a dot on it.
- Tool calls show an always-visible IN / OUT box under their title: the command, path or
  pattern, and the first lines of output. Click it (or press Enter / Space) to expand both.
- Thinking shows a running token estimate (`Thinking… ~20 tokens`, `Thought for 7s · ~312
  tokens`), also for omitted thinking when it can be worked out from the message's tokens.
  The thinking text itself is not shown.
- Sleeker composer: a `+` menu (attach image, reference a file), a `/` button, a chip with the
  time until the 5-hour limit resets, one model pill with the thinking effort (one menu for
  both), the permission mode on the right, and an icon-only Send / Stop button that is dimmed
  while there is nothing to send. Attached images are compact chips with their size.
- The status dot and "Ready / Working…" text under the composer are gone; the working
  indicator in the log already shows that. When Claude Code is starting or has stopped, the
  banner above the composer says so. The thinking line no longer has a `✻` icon.
- Claude tabs survive a VS Code restart: they reopen in place and resume their conversation. If
  the account can't be used yet, the tab says why and offers Try again.
- New Claude tabs open in their own editor group beside the editor, and the group is locked so
  files open elsewhere (setting `claudeSwitcher.chat.lockEditorGroup`).
- A Getting Started walkthrough opens once after install. Reopen it with **Claude: Getting
  started** or from the panel's overflow menu.
- Usage alerts: a notification when Claude Code's account, or one with an open Claude tab,
  passes `claudeSwitcher.warnThresholdPercent` of its 5-hour or weekly limit, and again when it
  reaches the limit. Each shows once per limit window (also across reloads) and offers to
  switch to, or open a tab for, the saved account with the most room left. Turn off with
  `claudeSwitcher.usageAlerts`.

## 0.3.1

Bug fixes.

- Switching away from a login that could not be tied to a profile (for example after
  `claude /login` with another account while offline) no longer copies its tokens into the
  previously active profile.
- Token refresh, token exchange, usage and `claude auth status` requests now time out. A hung
  refresh used to hold Claude Code's refresh lock indefinitely, and a hung usage request stalled
  polling for every account.
- A failed lock acquisition no longer leaves a partial set of Claude Code's refresh locks behind
  for 60 seconds; Windows `EPERM` on a lock that is being deleted is treated as busy.
- After a 401, an expired token generation is refreshed instead of being returned again.
- Say Hi no longer blocks switching to that profile for 5 minutes ("in use in another VS Code
  window"), and a failed independent-window launch releases its startup lease.
- A Say Hi timeout on Windows now stops Claude Code itself, not only its `cmd.exe` wrapper.
- Removing a profile also deletes its isolated config dir, which held a live copy of the login.
- The weekly figure prefers the all-models window over per-model windows; fallback usage
  percentages are clamped to 0-100.
- Browser authorization records the stable Claude account id.
- The panel ignores out-of-order state updates and shows "updated Xh ago" for older data.

## 0.3.0

Fixes saved accounts and Claude Code itself repeatedly needing reauthorization.

- Token refreshes now take Claude Code's own refresh locks (`<configDir>/.oauth_refresh.lock`
  and the legacy `<configDir>.lock`) instead of a private lock in the temp directory, so Claude
  Code waits for the extension and adopts its rotation instead of spending the same single-use
  refresh token.
- Every rotation is written back (compare-and-swap) to all local credential files holding the
  login, and the newest generation across the vault, `~/.claude` and isolated config dirs is
  always used.
- Switching first saves the outgoing account's latest rotation under the lock. Previously a
  rotation made by Claude Code after the last poll was lost on switch, leaving the profile with a
  spent token.
- Undo restores the newest token generation of the previous profile instead of the raw `.bak`
  copy, which could contain an already rotated refresh token.
- Accounts are identified by Claude account id via `/api/oauth/profile` (no CLI needed), so a
  fully rotated login is still recognized. Team members sharing one organization and one person
  in several organizations are no longer confused with each other.
- Watches `.credentials.json` and imports Claude Code's rotations immediately.
- Switching also replaces `organizationUuid` in `.credentials.json` and `oauthAccount` in
  `.claude.json`, which previously kept the previous account's values.
- A refresh token rejected with `invalid_grant` is never sent again; the profile recovers on its
  own once any copy holds a newer login. Network errors no longer show "Needs reauthorization".
- New **+ Add account** flow logs in to another account in an isolated config dir without
  touching the current one; isolated logins and reauthorizations complete automatically.
  The panel's toolbar buttons are now "Save current" and "+ Add account".
- When Claude Code is logged in to an account that is not saved, the status bar shows it and the
  extension offers to save it.
- Browser authorization and default refresh scopes include `user:plugins`, matching current
  Claude Code.
- Documented that `/logout` revokes the login on Anthropic's side and must not be used to change
  accounts.

## 0.2.5

- Added browser-based OAuth authorization that works without Claude Code CLI.
- Automatically offer browser authorization when the CLI cannot be found.
- Added a dedicated command for browser authorization even when the CLI is available.

## 0.2.4

- Improved authorization reliability for saved accounts by consistently preserving and selecting
  the newest valid access and refresh token generation.
- Added cross-window active-profile leases so background usage polling never spends a rotating
  refresh token currently owned by Claude Code in another VS Code window.
- Propagate successful inactive-profile token rotations to matching credential files with an
  atomic compare-and-swap, preventing stale files from restoring already spent refresh tokens.
- Recover profiles previously marked `invalid_grant` when Claude Code has already persisted a
  newer valid token generation for the same saved profile.
- Reconcile fully rotated active credentials using the verified Claude account identity.

## 0.2.3

- Treat OAuth `invalid_grant` / invalid refresh-token responses as a reauthorization-needed
  state instead of a retryable usage-refresh failure.
- Stop automatic and manual usage refreshes from repeatedly retrying profiles that are already
  known to need reauthorization, reducing repeated "Failed to refresh token" noise.
- Clear stale usage errors and retry backoff automatically when a profile receives fresh
  credentials after reauthorization or a successful token update.
- Use the same per-account lock for Say Hi warmups and usage token refreshes, reducing refresh
  token races between background polling, warmups, and independent VS Code windows.
- Show a short "Needs reauthorization" message in the panel and status tooltip instead of the raw
  token endpoint error payload.

## 0.2.2

- Added independent account windows, Say Hi warmups, and safer cross-window token-refresh locking.
- Added isolated profile reauthorization for broken accounts. The fallback login runs in that
  profile's own `CLAUDE_CONFIG_DIR`, so another active account cannot overwrite it.
- Added account identity checks through `claude auth status --json`; reauthorization is rejected if
  the completed login belongs to a different known profile.
- Hardened credential handling so empty or incomplete OAuth credentials are ignored and never
  written to Claude Code.
- Updated Claude OAuth refresh requests with the current beta header, default Claude Code scopes,
  and clearer local validation before hitting the token endpoint.
- Show the panel's `Auth` action only for profiles that actually need reauthorization.
- Improved CLI discovery, Windows command quoting, and troubleshooting for login and warmup flows.

## 0.2.1

- Fixed token refresh to use the current Claude Code OAuth token endpoint and include saved scopes
  in the refresh request.

## 0.2.0

- Added independent account windows. Each account can now open the current project in a separate
  VS Code window with its own isolated `CLAUDE_CONFIG_DIR` and `.credentials.json`.
- Added "Say Hi" warmups for inactive saved accounts using `claude -p "Hi"` with `haiku` by default,
  without switching the active account.
- Added a login helper command that opens `claude auth login` in an integrated terminal.
- Documented that Claude Code CLI is required for correct operation.
- Documented the privacy and security model: no telemetry, no data collection, no custom backend,
  and credentials are used only locally or with Anthropic/Claude Code endpoints required for the
  selected feature.
- Added Claude Code CLI auto-detection and clearer Say Hi troubleshooting when `claude` is not in
  the VS Code extension host PATH.
- Fixed Windows Say Hi launcher quoting for full `claude.exe` paths.
- Made the active account marker workspace-scoped, so separate VS Code windows can track different
  active accounts independently.
- Added cross-window locking around token refreshes to reduce intermittent login failures from
  rotating refresh tokens.
- Avoided overwriting saved profiles when an unknown account is detected in the credentials file.
- Added settings for the Claude CLI command, Say Hi model, Say Hi prompt, and Say Hi timeout.

## 0.1.0

- Initial release.
- Save the currently logged-in Claude account as a profile (tokens stored in SecretStorage).
- Fast account switching (panel, status bar, QuickPick) by swapping `~/.claude/.credentials.json`,
  with a `.bak` backup and an undo command.
- Live usage limits (5-hour and weekly windows) from the `/api/oauth/usage` endpoint,
  with auto-refresh, backoff on 429, and manual refresh.
- Automatic refresh of expired tokens (refresh token flow).
