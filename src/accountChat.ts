import { ChildProcess, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { ChatDiffProvider, ToolEdit } from "./chatDiff";
import { findPromptParent, listChatHistory, loadChatTranscript } from "./chatHistory";
import {
  buildSpawnArgs,
  getConfiguredClaudeCommand,
  killProcessTree,
  missingClaudeCliMessage,
  resolveClaudeCommand,
} from "./cli";
import { CredentialSync } from "./credentialSync";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { getAccountConfigDir } from "./isolatedConfig";
import { ProfileActivityRegistry } from "./profileActivity";
import { ACCOUNT_COLORS, UsageSnapshot } from "./types";

export interface AccountChatResult {
  ok: boolean;
  message: string;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const PREFS_KEY = "claudeSwitcher.chatPrefs";
const VIEW_TYPE = "claudeSwitcher.chat";
const CONTROL_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The extension icon (media/icon.png) drawn inline: the usage dial on the teal tile. */
const BRAND_MARK = `<svg viewBox="0 0 128 128" aria-hidden="true">
  <defs><linearGradient id="brandTile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#236970" /><stop offset="1" stop-color="#133f45" /></linearGradient></defs>
  <rect width="128" height="128" rx="30" fill="url(#brandTile)" />
  <g transform="translate(22 22) scale(3.5)">
    <path d="M5.07 17.5A8 8 0 0 1 17.14 7.37" fill="none" stroke="#eef6f3" stroke-width="3.4" />
    <path d="M18.55 8.91A8 8 0 0 1 18.93 17.5" fill="none" stroke="#ee8f63" stroke-width="3.4" />
    <path d="M15.86 8.9L13.07 14.4L10.93 12.6z" fill="#eef6f3" stroke="#eef6f3" stroke-width="0.6" stroke-linejoin="round" />
    <circle cx="12" cy="13.5" r="2.1" fill="#eef6f3" />
  </g>
</svg>`;

/** Composer choices remembered across Claude tabs. Bypass mode is never remembered. */
interface ChatPrefs {
  model?: string;
  effort?: string;
  mode?: PermissionMode;
}

/** What a Claude tab keeps in its webview state, so VS Code can restore it after a restart. */
interface SavedTabState {
  profileId: string;
  sessionId?: string;
}

/** Where a tab goes when it is created: an existing panel (restore) or a new one. */
interface TabTarget {
  panel?: vscode.WebviewPanel;
  sessionId?: string;
  fork?: ForkTarget;
}

/** A fork opened in its own tab: the conversation up to a prompt, with the prompt as a draft. */
interface ForkTarget {
  /** The conversation forked from; unset when forking from its first prompt. */
  sessionId?: string;
  /** The chain entry the fork resumes up to; unset for an empty fork. */
  at?: string;
  /** The prompt forked from; the replay stops before it. */
  uuid: string;
  text: string;
}

interface ImageAttachment {
  mediaType: string;
  data: string;
}

/** Messages the chat webview sends to the extension. */
type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; images?: ImageAttachment[]; clientId: string }
  | { type: "interrupt" }
  | { type: "newChat" }
  | { type: "restart" }
  | { type: "setMode"; mode: string }
  | { type: "setModel"; model: string }
  | { type: "setEffort"; effort: string }
  | {
      type: "permission";
      requestId: string;
      behavior: "allow" | "allowAlways" | "deny";
      /** AskUserQuestion: the answer per question text, and the picked previews. */
      answers?: Record<string, string>;
      annotations?: Record<string, { preview?: string }>;
      /** A deny that also ends the turn (Esc on a question). */
      interrupt?: boolean;
    }
  | { type: "history" }
  | { type: "resume"; sessionId: string }
  | { type: "restoreCheckpoint"; uuid: string }
  | { type: "fork"; uuid: string; rewind: boolean; text: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string; edits?: ToolEdit[]; content?: string }
  | { type: "pickImages" }
  | { type: "searchFiles"; query: string }
  | { type: "mcpStatus" }
  | { type: "mcpToggle"; name: string; enabled: boolean }
  | { type: "mcpReconnect"; name: string }
  | { type: "permissionRules" }
  | { type: "refreshUsage" }
  | { type: "openSettings" }
  | { type: "retry" };

interface PendingPermission {
  input: Record<string, unknown>;
  suggestions?: unknown[];
}

interface PendingControl {
  resolve: (response: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Runs Claude Code for a saved profile behind our own chat UI in an editor tab of
 * this window. Claude Code runs headless (`-p` with stream-json in both directions)
 * with `CLAUDE_CONFIG_DIR` pointing at the profile's isolated config dir; tool
 * permission prompts and control requests (model, effort, checkpoints, MCP) go over
 * the same stream. The official Claude Code chat panel cannot do this, because its
 * environment is per window, not per tab.
 */
export class AccountChatService implements vscode.Disposable {
  private readonly sessions = new Set<ChatSession>();
  private readonly diffs = new ChatDiffProvider();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AccountStore,
    private readonly sync: CredentialSync,
    private readonly profileActivity: ProfileActivityRegistry,
    private readonly onChange: () => void
  ) {}

  /** Number of open Claude tabs per profile id. */
  openTabCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const session of this.sessions) {
      counts.set(session.profileId, (counts.get(session.profileId) ?? 0) + 1);
    }
    return counts;
  }

  /** Sends each open tab its profile's latest usage limits. */
  refreshUsage(): void {
    for (const session of this.sessions) {
      session.postUsage();
    }
  }

  /** Updates open tabs after a profile was renamed or recolored. */
  refreshAppearance(): void {
    for (const session of this.sessions) {
      const profile = this.store.get(session.profileId);
      if (profile) {
        session.setAppearance(profile.label, profile.color);
      }
    }
  }

  /** Focuses the most recently opened Claude tab of a profile. */
  reveal(id: string): boolean {
    const session = [...this.sessions].reverse().find((s) => s.profileId === id);
    session?.reveal();
    return session !== undefined;
  }

  async open(id: string): Promise<AccountChatResult> {
    return this.create(id, {});
  }

  /**
   * Reopens a Claude tab VS Code kept from the last session (see the panel serializer
   * in extension.ts). If the account cannot be used right now, the tab stays open with
   * the reason and a Try again button instead of disappearing.
   */
  async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const saved = state as Partial<SavedTabState> | undefined;
    if (!saved || typeof saved.profileId !== "string") {
      panel.dispose();
      return;
    }
    const profileId = saved.profileId;
    const sessionId = typeof saved.sessionId === "string" ? saved.sessionId : undefined;
    const res = await this.create(profileId, { panel, sessionId });
    if (res.ok) {
      return;
    }
    const profile = this.store.get(profileId);
    showRestoreError(
      this.context.extensionUri,
      panel,
      profile?.label ?? "this account",
      profile?.color,
      res.message,
      { profileId, sessionId }
    );
    const listener = panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.type === "retry") {
        listener.dispose();
        void this.restore(panel, { profileId, sessionId });
      }
    });
  }

  private async create(id: string, target: TabTarget): Promise<AccountChatResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const creds = await this.store.getCreds(id);
    if (!creds) {
      return { ok: false, message: `No stored credentials for "${profile.label}".` };
    }
    if (!hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message: `"${profile.label}" needs reauthorization. Reauthorize this profile first.`,
      };
    }

    const current = await this.sync.syncCurrent();
    if (current.ownerId === id) {
      return {
        ok: false,
        message:
          `"${profile.label}" is already this window's account. ` +
          "Use the regular Claude Code panel for it instead.",
      };
    }

    // Tabs of this window share the profile's config dir, where Claude Code's own
    // refresh lock coordinates them. Anything else on this login must be refused.
    const hasOwnTab = [...this.sessions].some((s) => s.profileId === id);
    if (!hasOwnTab && this.profileActivity.isActive(id, { excludeSelf: true })) {
      return {
        ok: false,
        message:
          `"${profile.label}" is in use in another VS Code window. ` +
          "Close that session first, so two sessions do not spend the same refresh token.",
      };
    }

    const command = resolveClaudeCommand(getConfiguredClaudeCommand());
    if (!command) {
      return { ok: false, message: missingClaudeCliMessage() };
    }

    const release = this.profileActivity.hold(id);
    const prepared = await this.sync.prepareHomeDir(id);
    if (!prepared.ok) {
      release();
      return {
        ok: false,
        message: prepared.deferred
          ? `Token refresh is already running for "${profile.label}". Try again in a few seconds.`
          : `"${profile.label}" needs reauthorization. Reauthorize this profile first.`,
      };
    }

    const session = new ChatSession({
      extensionUri: this.context.extensionUri,
      panel: target.panel,
      sessionId: target.sessionId,
      fork: target.fork,
      profileId: id,
      label: profile.label,
      color: profile.color,
      expectedEmail: profile.authEmail,
      command,
      configDir: getAccountConfigDir(this.context, id),
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      diffs: this.diffs,
      usage: () => this.store.get(id)?.lastUsage,
      prefs: () => this.context.globalState.get<ChatPrefs>(PREFS_KEY, {}),
      savePrefs: (patch) =>
        void this.context.globalState.update(PREFS_KEY, {
          ...this.context.globalState.get<ChatPrefs>(PREFS_KEY, {}),
          ...patch,
        }),
      prepare: async () => (await this.sync.prepareHomeDir(id)).ok,
      onExit: () => void this.sync.importHomeDir(id),
      openFork: (fork) => this.create(id, { sessionId: fork.sessionId, fork }),
      onDispose: () => {
        this.sessions.delete(session);
        release();
        this.onChange();
      },
    });
    this.sessions.add(session);
    this.onChange();

    return { ok: true, message: `Opened Claude Code for "${profile.label}" in a new tab.` };
  }

  dispose(): void {
    for (const session of [...this.sessions]) {
      session.dispose();
    }
    this.diffs.dispose();
  }
}

interface ChatSessionOptions {
  extensionUri: vscode.Uri;
  /** A panel VS Code restored after a restart; otherwise the session creates one. */
  panel?: vscode.WebviewPanel;
  /** The conversation the restored tab showed, resumed on start. */
  sessionId?: string;
  /** Set when this tab was opened as a fork of another tab's conversation. */
  fork?: ForkTarget;
  profileId: string;
  label: string;
  /** The profile's color (ACCOUNT_COLORS index), for the tab icon. */
  color?: number;
  /** The email this profile was saved with, to catch a config dir signed in elsewhere. */
  expectedEmail?: string;
  command: string;
  configDir: string;
  cwd: string;
  diffs: ChatDiffProvider;
  usage: () => UsageSnapshot | undefined;
  prefs: () => ChatPrefs;
  savePrefs: (patch: ChatPrefs) => void;
  /** Refreshes the profile's credentials in its config dir before a restart. */
  prepare: () => Promise<boolean>;
  /** Called after each Claude Code process exits, to import token rotations. */
  onExit: () => void;
  /** Opens a fork of this tab's conversation in a new tab of the same profile. */
  openFork: (fork: ForkTarget) => Promise<AccountChatResult>;
  onDispose: () => void;
}

/** One chat tab: a webview panel and the Claude Code process behind it. */
class ChatSession {
  readonly profileId: string;
  private readonly panel: vscode.WebviewPanel;
  private child: ChildProcess | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private sessionId: string | undefined;
  /** Set after a fork: the chain entry the next start resumes up to, in a new session. */
  private forkAt: string | undefined;
  private mode: PermissionMode;
  private model: string | undefined;
  private effort: string | undefined;
  /** Bypass mode needs a launch flag; set once the person confirmed it for this tab. */
  private bypassAllowed = false;
  private busy = false;
  private disposed = false;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly controls = new Map<string, PendingControl>();
  /** Client ids of sent prompts, waiting for Claude Code to echo them with their uuid. */
  private readonly unacked: string[] = [];
  private fileIndex: { at: number; files: string[] } | undefined;

  constructor(private readonly opts: ChatSessionOptions) {
    this.profileId = opts.profileId;
    const prefs = opts.prefs();
    this.mode = prefs.mode && prefs.mode !== "bypassPermissions" ? prefs.mode : "default";
    this.model = prefs.model;
    this.effort = prefs.effort;
    this.sessionId = opts.sessionId;
    this.forkAt = opts.fork?.at;

    const mediaRoot = vscode.Uri.joinPath(opts.extensionUri, "media");
    if (opts.panel) {
      this.panel = opts.panel;
      this.panel.title = `Claude · ${opts.label}`;
      this.panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    } else {
      this.panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        `Claude · ${opts.label}`,
        chatColumn(),
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [mediaRoot],
        }
      );
      void lockChatGroup();
    }
    this.panel.iconPath = tabIcon(mediaRoot, opts.color);
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
    this.panel.onDidDispose(() => this.dispose());
  }

  reveal(): void {
    this.panel.reveal();
  }

  setAppearance(label: string, color: number | undefined): void {
    if (label === this.opts.label && color === this.opts.color) {
      return;
    }
    this.opts.label = label;
    this.opts.color = color;
    this.panel.title = `Claude · ${label}`;
    this.updateIcon();
  }

  private updateIcon(): void {
    const media = vscode.Uri.joinPath(this.opts.extensionUri, "media");
    this.panel.iconPath = tabIcon(media, this.opts.color, this.busy);
  }

  postUsage(): void {
    const usage = this.opts.usage();
    this.post({
      type: "usage",
      windows: usage?.windows ?? [],
      error: usage?.error ?? null,
      fetchedAt: usage?.fetchedAt ?? null,
      warnThreshold: vscode.workspace
        .getConfiguration("claudeSwitcher")
        .get<number>("warnThresholdPercent", 80),
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.panel.dispose();
    this.opts.onDispose();
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({
          type: "init",
          profileId: this.profileId,
          sessionId: this.sessionId ?? null,
          label: this.opts.label,
          cwd: this.opts.cwd,
          mode: this.mode,
          model: this.model ?? "default",
          effort: this.effort ?? null,
          checkpoints: checkpointsEnabled(),
        });
        this.postUsage();
        if (this.sessionId) {
          // A tab restored after a restart picks its conversation back up; a fork
          // shows the conversation up to the prompt it was forked from.
          const fork = this.forkAt ? this.opts.fork : undefined;
          this.post({
            type: "replay",
            events: loadChatTranscript(this.opts.configDir, this.opts.cwd, this.sessionId, fork?.uuid),
            divider: fork ? "Forked. The original conversation is still open in its own tab." : undefined,
          });
        }
        if (this.opts.fork) {
          this.post({ type: "forked", text: this.opts.fork.text });
          this.opts.fork.text = ""; // The draft is only put back once.
        }
        this.start();
        break;
      case "send":
        this.send(msg.text, msg.images ?? [], msg.clientId);
        break;
      case "interrupt":
        void this.request({ subtype: "interrupt" }).catch(() => undefined);
        break;
      case "setMode":
        await this.setMode(msg.mode);
        break;
      case "setModel":
        this.model = msg.model === "default" ? undefined : msg.model;
        this.opts.savePrefs({ model: this.model });
        this.tryControl({ subtype: "set_model", model: this.model ?? "default" });
        break;
      case "setEffort":
        this.effort = msg.effort || undefined;
        this.opts.savePrefs({ effort: this.effort });
        this.tryControl({ subtype: "apply_flag_settings", settings: { effortLevel: this.effort ?? null } });
        break;
      case "newChat":
        this.stop();
        this.setSessionId(undefined);
        this.forkAt = undefined;
        this.post({ type: "cleared" });
        void this.restart();
        break;
      case "restart":
        void this.restart();
        break;
      case "permission":
        this.answerPermission(msg);
        break;
      case "history":
        this.post({ type: "history", items: listChatHistory(this.opts.configDir, this.opts.cwd) });
        break;
      case "resume":
        this.resume(msg.sessionId);
        break;
      case "restoreCheckpoint":
        await this.restoreCheckpoint(msg.uuid);
        break;
      case "fork":
        await this.fork(msg.uuid, msg.rewind, msg.text);
        break;
      case "openFile":
        await this.openFile(msg.path, msg.line);
        break;
      case "openDiff":
        await this.opts.diffs.open(this.resolvePath(msg.path), msg.edits, msg.content);
        break;
      case "pickImages":
        await this.pickImages();
        break;
      case "searchFiles":
        this.post({ type: "files", query: msg.query, items: await this.searchFiles(msg.query) });
        break;
      case "mcpStatus":
        await this.postMcpStatus();
        break;
      case "mcpToggle":
        await this.controlThen({ subtype: "mcp_toggle", serverName: msg.name, enabled: msg.enabled });
        await this.postMcpStatus();
        break;
      case "mcpReconnect":
        await this.controlThen({ subtype: "mcp_reconnect", serverName: msg.name });
        await this.postMcpStatus();
        break;
      case "permissionRules":
        await this.postPermissionRules();
        break;
      case "refreshUsage":
        void vscode.commands.executeCommand("claudeSwitcher.refreshUsage");
        break;
      case "openSettings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "claudeSwitcher.chat");
        break;
    }
  }

  // ---------------------------------------------------------------- process

  private start(): void {
    if (this.child || this.disposed) {
      return;
    }

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      this.mode === "default" ? "manual" : this.mode,
      // Newer models omit thinking text unless a summary is asked for.
      "--thinking-display",
      "summarized",
    ];
    if (this.bypassAllowed) {
      args.push("--allow-dangerously-skip-permissions");
    }
    args.push("--disallowedTools", TASK_TOOLS.join(","));
    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.effort) {
      args.push("--effort", this.effort);
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
      if (this.forkAt) {
        args.push("--fork-session", "--resume-session-at", this.forkAt);
      }
    }

    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: this.opts.configDir };
    if (checkpointsEnabled()) {
      env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "1";
    }

    this.stdoutBuffer = "";
    this.stderrTail = "";
    const child = spawn(...buildSpawnArgs(this.opts.command, args), {
      cwd: this.opts.cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    this.setBusy(false);
    this.post({ type: "status", state: "ready", mode: this.mode });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.stdin?.on("error", () => undefined);
    child.on("error", (e) => {
      this.stderrTail += `\n${e.message}`;
    });
    child.on("close", (code) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.resetProcessState();
      this.opts.onExit();
      if (!this.disposed) {
        this.post({
          type: "status",
          state: "exited",
          message: `Claude Code is not running: it exited${code === null ? "" : ` with code ${code}`}.`,
          details: this.stderrTail.trim().slice(-600),
          canResume: this.sessionId !== undefined,
        });
      }
    });

    void this.initialize();
  }

  /** Asks Claude Code for its commands, models and signed-in account. */
  private async initialize(): Promise<void> {
    let info: Record<string, any>;
    try {
      info = await this.request({ subtype: "initialize" });
    } catch {
      return; // Older CLIs: the composer just has fewer choices.
    }
    const email: string | undefined = info.account?.email;
    const expected = this.opts.expectedEmail;
    this.post({
      type: "capabilities",
      commands: Array.isArray(info.commands) ? info.commands : [],
      models: Array.isArray(info.models) ? info.models : [],
      agents: Array.isArray(info.agents) ? info.agents : [],
      account: info.account ?? null,
      accountMismatch: !!(email && expected && email.toLowerCase() !== expected.toLowerCase()),
      expectedEmail: expected ?? null,
    });
    // Answered locally (no API call), so the meter shows before the first prompt.
    void this.postContextUsage();
  }

  private stop(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    this.resetProcessState();
    killProcessTree(child);
    this.opts.onExit();
  }

  private resetProcessState(): void {
    this.pending.clear();
    this.unacked.length = 0;
    for (const control of this.controls.values()) {
      clearTimeout(control.timer);
      control.reject(new Error("Claude Code stopped."));
    }
    this.controls.clear();
    this.setBusy(false);
  }

  private async restart(): Promise<void> {
    this.stop();
    this.post({ type: "status", state: "starting" });
    if (!(await this.opts.prepare())) {
      this.post({
        type: "status",
        state: "exited",
        message: `Could not refresh the login for "${this.opts.label}". Reauthorize this profile, or try again in a few seconds.`,
        canResume: this.sessionId !== undefined,
      });
      return;
    }
    this.start();
  }

  // ---------------------------------------------------------------- conversation

  private send(text: string, images: ImageAttachment[], clientId: string): void {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) {
      return;
    }
    if (!this.child) {
      this.post({ type: "error", message: "Claude Code is not running. Restart the session first." });
      return;
    }
    const content: unknown[] = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    }));
    if (trimmed) {
      content.push({ type: "text", text: trimmed });
    }
    this.unacked.push(clientId);
    this.write({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
    this.setBusy(true);
  }

  private resume(sessionId: string): void {
    if (this.busy) {
      this.post({ type: "error", message: "Wait for Claude to finish, or stop it, before opening another conversation." });
      return;
    }
    this.stop();
    this.setSessionId(sessionId);
    this.forkAt = undefined;
    this.post({ type: "cleared" });
    this.post({
      type: "replay",
      events: loadChatTranscript(this.opts.configDir, this.opts.cwd, sessionId),
    });
    void this.restart();
  }

  private async setMode(requested: string): Promise<void> {
    if (!(PERMISSION_MODES as readonly string[]).includes(requested)) {
      return;
    }
    const mode = requested as PermissionMode;
    if (mode === "bypassPermissions" && !this.bypassAllowed) {
      const choice = await vscode.window.showWarningMessage(
        "Bypass permissions?",
        {
          modal: true,
          detail:
            "Claude will run every tool, including shell commands and file edits, without asking. " +
            "Only use this in a workspace you can afford to lose changes in. Claude Code restarts to apply it.",
        },
        "Bypass permissions"
      );
      if (choice !== "Bypass permissions") {
        this.post({ type: "mode", mode: this.mode });
        return;
      }
      if (this.busy) {
        this.post({ type: "error", message: "Wait for Claude to finish before turning on bypass mode." });
        this.post({ type: "mode", mode: this.mode });
        return;
      }
      this.bypassAllowed = true;
      this.mode = mode;
      this.post({ type: "mode", mode });
      await this.restart();
      return;
    }

    this.mode = mode;
    if (mode !== "bypassPermissions") {
      this.opts.savePrefs({ mode });
    }
    this.post({ type: "mode", mode });
    this.tryControl({ subtype: "set_permission_mode", mode });
  }

  /** Puts files back to before a prompt. Resolves false if cancelled or refused. */
  private async restoreCheckpoint(uuid: string): Promise<boolean> {
    if (this.busy) {
      this.post({ type: "error", message: "Stop Claude before restoring a checkpoint." });
      return false;
    }
    let preview: Record<string, any>;
    try {
      preview = await this.request({ subtype: "rewind_files", user_message_id: uuid, dry_run: true });
    } catch (e) {
      this.post({ type: "error", message: `Could not restore: ${errorText(e)}` });
      return false;
    }
    if (!preview.canRewind) {
      this.post({ type: "error", message: preview.error || "No checkpoint is stored for this message." });
      return false;
    }
    const files: string[] = Array.isArray(preview.filesChanged) ? preview.filesChanged : [];
    if (files.length === 0) {
      this.post({ type: "notice", message: "No files changed since this message, so there is nothing to restore." });
      return true;
    }

    const shown = files.slice(0, 12).map((f) => path.relative(this.opts.cwd, f) || f);
    const more = files.length > shown.length ? `\n…and ${files.length - shown.length} more` : "";
    const choice = await vscode.window.showWarningMessage(
      `Restore ${files.length} file${files.length === 1 ? "" : "s"} to how they were before this message?`,
      {
        modal: true,
        detail: `${shown.join("\n")}${more}\n\nChanges made after this message, by Claude or by you, are lost. The conversation itself stays as it is.`,
      },
      "Restore"
    );
    if (choice !== "Restore") {
      return false;
    }
    try {
      const result = await this.request({ subtype: "rewind_files", user_message_id: uuid });
      if (result.canRewind === false) {
        throw new Error(result.error || "Rewind refused.");
      }
      this.post({
        type: "notice",
        message: `Restored ${files.length} file${files.length === 1 ? "" : "s"} to before this message.`,
      });
      return true;
    } catch (e) {
      this.post({ type: "error", message: `Could not restore: ${errorText(e)}` });
      return false;
    }
  }

  /**
   * Opens a new tab with a conversation holding everything before a prompt, with
   * the prompt back in the composer. This tab keeps the original conversation.
   */
  private async fork(uuid: string, rewind: boolean, text: string): Promise<void> {
    if (rewind && this.busy) {
      this.post({ type: "error", message: "Stop Claude before rewinding the code." });
      return;
    }
    const source = this.sessionId;
    const parent = source ? findPromptParent(this.opts.configDir, this.opts.cwd, source, uuid) : undefined;
    if (!source || parent === undefined) {
      this.post({ type: "error", message: "This message is not in the saved conversation yet, so it cannot be forked." });
      return;
    }
    if (rewind && !(await this.restoreCheckpoint(uuid))) {
      return;
    }
    // From the first prompt, the fork is an empty conversation.
    const res = await this.opts.openFork(
      parent === null ? { uuid, text } : { sessionId: source, at: parent, uuid, text }
    );
    if (!res.ok) {
      this.post({ type: "error", message: res.message });
    }
  }

  private answerPermission(msg: Extract<WebviewMessage, { type: "permission" }>): void {
    const request = this.pending.get(msg.requestId);
    if (!request) {
      return;
    }
    this.pending.delete(msg.requestId);

    let response: Record<string, unknown>;
    if (msg.behavior === "deny") {
      response = { behavior: "deny", message: "The user denied this tool use." };
      if (msg.interrupt) {
        response.interrupt = true;
      }
    } else {
      const updatedInput = msg.answers
        ? {
            ...request.input,
            answers: msg.answers,
            ...(msg.annotations && Object.keys(msg.annotations).length ? { annotations: msg.annotations } : {}),
          }
        : request.input;
      response = { behavior: "allow", updatedInput };
      if (msg.behavior === "allowAlways" && request.suggestions?.length) {
        response.updatedPermissions = request.suggestions;
      }
    }
    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: msg.requestId, response },
    });
    if (msg.interrupt) {
      // Older CLIs ignore the flag on a deny; this stops the turn either way.
      void this.request({ subtype: "interrupt" }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- workspace helpers

  private resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.opts.cwd, p);
  }

  private async openFile(p: string, line?: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.resolvePath(p)));
      const pos = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
      await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
        selection: pos ? new vscode.Range(pos, pos) : undefined,
      });
    } catch {
      this.post({ type: "error", message: `Could not open ${p}.` });
    }
  }

  private async pickImages(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: { Images: Object.keys(IMAGE_TYPES).map((ext) => ext.slice(1)) },
    });
    if (!uris?.length) {
      return;
    }
    const images: { name: string; mediaType: string; data: string }[] = [];
    for (const uri of uris) {
      const mediaType = IMAGE_TYPES[path.extname(uri.fsPath).toLowerCase()];
      if (!mediaType) {
        continue;
      }
      try {
        const bytes = await fs.promises.readFile(uri.fsPath);
        if (bytes.length > MAX_IMAGE_BYTES) {
          this.post({ type: "error", message: `${path.basename(uri.fsPath)} is larger than 5 MB.` });
          continue;
        }
        images.push({ name: path.basename(uri.fsPath), mediaType, data: bytes.toString("base64") });
      } catch {
        this.post({ type: "error", message: `Could not read ${path.basename(uri.fsPath)}.` });
      }
    }
    if (images.length) {
      this.post({ type: "images", images });
    }
  }

  private async searchFiles(query: string): Promise<string[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    if (!this.fileIndex || Date.now() - this.fileIndex.at > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**", 20_000);
      this.fileIndex = {
        at: Date.now(),
        files: uris.map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, "/")).sort(),
      };
    }
    const q = query.toLowerCase();
    if (!q) {
      return this.fileIndex.files.slice(0, 40);
    }
    const scored: { file: string; score: number }[] = [];
    for (const file of this.fileIndex.files) {
      const lower = file.toLowerCase();
      const at = lower.indexOf(q);
      if (at < 0) {
        continue;
      }
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      const score = (base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 1000 + file.length;
      scored.push({ file, score });
    }
    return scored.sort((a, b) => a.score - b.score).slice(0, 40).map((s) => s.file);
  }

  private async postMcpStatus(): Promise<void> {
    if (!this.child) {
      this.post({ type: "mcp", servers: [], error: "Claude Code is not running." });
      return;
    }
    try {
      const res = await this.request({ subtype: "mcp_status" });
      const servers = (Array.isArray(res.mcpServers) ? res.mcpServers : []).map((s: Record<string, any>) => ({
        name: s.name,
        status: s.status,
        scope: s.scope,
        tools: Array.isArray(s.tools) ? s.tools.length : 0,
        error: s.error,
      }));
      this.post({ type: "mcp", servers });
    } catch (e) {
      this.post({ type: "mcp", servers: [], error: errorText(e) });
    }
  }

  private async postPermissionRules(): Promise<void> {
    if (!this.child) {
      this.post({ type: "rules", rules: [], error: "Claude Code is not running." });
      return;
    }
    try {
      const res = await this.request({ subtype: "list_permission_rules" });
      const state = res.state ?? {};
      this.post({
        type: "rules",
        rules: Array.isArray(state.rules) ? state.rules : [],
        directories: Array.isArray(state.workspaceDirectories) ? state.workspaceDirectories : [],
      });
    } catch (e) {
      this.post({ type: "rules", rules: [], error: errorText(e) });
    }
  }

  private async postContextUsage(): Promise<void> {
    try {
      const res = await this.request({ subtype: "get_context_usage", detail: "summary" });
      this.post({
        type: "context",
        totalTokens: res.totalTokens,
        maxTokens: res.maxTokens,
        percentage: res.percentage,
      });
    } catch {
      // Older CLIs do not report context usage; the meter stays hidden.
    }
  }

  // ---------------------------------------------------------------- control channel

  /** Sends a control request and resolves with its success payload. */
  private request(request: Record<string, unknown>): Promise<Record<string, any>> {
    if (!this.child) {
      return Promise.reject(new Error("Claude Code is not running."));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error("Claude Code did not answer in time."));
      }, CONTROL_TIMEOUT_MS);
      this.controls.set(id, { resolve, reject, timer });
      this.write({ type: "control_request", request_id: id, request });
    });
  }

  /** Fire-and-forget control request; failures are shown in the chat. */
  private tryControl(request: Record<string, unknown>): void {
    if (!this.child) {
      return; // Applied through launch flags on the next start.
    }
    void this.controlThen(request);
  }

  private async controlThen(request: Record<string, unknown>): Promise<void> {
    try {
      await this.request(request);
    } catch (e) {
      this.post({ type: "error", message: errorText(e) });
    }
  }

  private write(message: unknown): void {
    this.child?.stdin?.write(JSON.stringify(message) + "\n");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.onEvent(event);
    }
  }

  private onEvent(event: Record<string, any>): void {
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          if (event.session_id && event.session_id !== this.sessionId) {
            this.forkAt = undefined; // The fork now has its own session.
          }
          this.setSessionId(event.session_id ?? this.sessionId);
          this.post({
            type: "event",
            event: { type: "system", subtype: "init", model: event.model, permissionMode: event.permissionMode },
          });
        } else if (event.subtype === "status" && typeof event.permissionMode === "string") {
          this.syncMode(event.permissionMode);
        } else if (event.subtype === "compact_boundary") {
          this.post({ type: "notice", message: "Conversation compacted." });
        }
        return;
      case "control_request": {
        const request = event.request;
        if (request?.subtype !== "can_use_tool") {
          // We register no hooks or SDK MCP servers; refuse anything else explicitly.
          this.write({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: event.request_id,
              error: `Unsupported request: ${request?.subtype}`,
            },
          });
          return;
        }
        this.pending.set(event.request_id, {
          input: request.input ?? {},
          suggestions: request.permission_suggestions,
        });
        this.post({
          type: "permission",
          requestId: event.request_id,
          toolUseId: request.tool_use_id ?? null,
          toolName: request.tool_name,
          input: request.input ?? {},
          description: request.description,
          canAlwaysAllow: Array.isArray(request.permission_suggestions)
            && request.permission_suggestions.length > 0,
        });
        return;
      }
      case "control_response": {
        const response = event.response ?? {};
        const control = this.controls.get(response.request_id);
        if (control) {
          this.controls.delete(response.request_id);
          clearTimeout(control.timer);
          if (response.subtype === "error") {
            control.reject(new Error(String(response.error ?? "Request failed.")));
          } else {
            control.resolve(response.response ?? {});
          }
        } else if (response.subtype === "error") {
          this.post({ type: "error", message: String(response.error ?? "Request failed.") });
        }
        return;
      }
      case "result":
        this.setBusy(false);
        this.post({ type: "event", event });
        void this.postContextUsage();
        return;
      case "user":
        if (event.isReplay) {
          this.onReplayedUser(event);
          return;
        }
        this.post({ type: "event", event });
        return;
      case "stream_event":
      case "assistant":
        this.post({ type: "event", event });
        return;
    }
  }

  /** Claude Code echoes each prompt with the uuid its checkpoints are keyed by. */
  private onReplayedUser(event: Record<string, any>): void {
    const content = event.message?.content;
    if (Array.isArray(content) && content.some((c: any) => c?.type === "tool_result")) {
      return;
    }
    const clientId = this.unacked.shift();
    if (clientId && typeof event.uuid === "string") {
      this.post({ type: "userAck", clientId, uuid: event.uuid });
    }
  }

  /** Claude Code changes mode by itself, e.g. leaving plan mode after a plan is approved. */
  private syncMode(mode: string): void {
    const normalized = mode === "manual" ? "default" : mode;
    if (normalized !== this.mode && (PERMISSION_MODES as readonly string[]).includes(normalized)) {
      this.mode = normalized as PermissionMode;
      this.post({ type: "mode", mode: this.mode });
    }
  }

  /** The webview saves the id in its state, so a restored tab resumes this conversation. */
  private setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.post({ type: "session", sessionId: sessionId ?? null });
  }

  private setBusy(busy: boolean): void {
    if (this.busy !== busy) {
      this.busy = busy;
      this.post({ type: "busy", busy });
      if (!this.disposed) {
        this.updateIcon();
      }
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const media = vscode.Uri.joinPath(this.opts.extensionUri, "media");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude</title>
</head>
<body>
  <header class="topbar">
    <div class="who">
      <span class="avatar" id="avatar" aria-hidden="true"></span>
      <div class="who-text">
        <span id="account" class="who-name"></span>
        <span id="accountSub" class="who-sub"></span>
      </div>
    </div>
    <div class="topbar-actions">
      <button class="tb-btn" id="historyBtn" title="Conversation history" aria-pressed="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.8L2 5.3"/><path d="M2 2v3.3h3.3"/><path d="M8 4.7V8l2.7 1.3"/></svg>
        <span>History</span>
      </button>
      <button class="tb-btn icon" id="settingsBtn" title="Settings, MCP servers and permissions" aria-pressed="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h6.5M11.5 4H14M2 8h1.5M6.5 8H14M2 12h8.5M13.5 12h.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="5" cy="8" r="1.5"/><circle cx="12" cy="12" r="1.5"/></svg>
      </button>
      <button class="tb-btn primary" id="newChatBtn" title="Start a new conversation">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
        <span>New chat</span>
      </button>
    </div>
  </header>

  <div id="mismatch" class="banner warn hidden" role="alert"></div>

  <div class="body">
    <div class="log-wrap">
    <button id="pinned" class="pinned hidden" title="Scroll to this prompt"></button>
    <main id="log" aria-live="polite">
      <section id="welcome" class="welcome">
        <div class="welcome-mark" aria-hidden="true">${BRAND_MARK}</div>
        <h1>What should we build?</h1>
        <p id="welcomeSub" class="muted"></p>
        <div class="welcome-tips">
          <span><kbd>@</kbd> reference a file</span>
          <span><kbd>/</kbd> run a command or skill</span>
          <span><kbd>Ctrl</kbd>+<kbd>V</kbd> paste a screenshot</span>
        </div>
      </section>
    </main>
    <footer class="composer-wrap" id="composerWrap">
    <div id="banner" class="banner hidden" role="status"></div>
    <div id="yolo" class="yolo hidden">Bypass mode: Claude runs every tool without asking.</div>
    <section id="ask" class="ask hidden" aria-label="Claude's questions"></section>
    <div class="composer" id="composer">
      <div id="popup" class="popup hidden" role="listbox"></div>
      <div id="attachments" class="attachments hidden"></div>
      <textarea id="input" rows="1" placeholder="Ask Claude…" aria-label="Message"></textarea>
      <div class="composer-bar">
        <div class="bar-left">
          <button class="icon-btn" id="plusBtn" title="Attach an image or reference a file" aria-label="Attach an image or reference a file" aria-haspopup="menu">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
          </button>
          <button class="icon-btn boxed" id="slashBtn" title="Commands and skills (/)" aria-label="Commands and skills">/</button>
          <span id="usageChip" class="pill static usage-chip hidden">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>
            <span id="usageChipText"></span>
          </span>
          <button class="pill model-pill" id="modelBtn" title="Model and thinking effort" aria-haspopup="menu"><span id="modelLabel" class="model-name">Default</span><span id="effortLabel" class="effort-label hidden"></span><svg class="chev" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3l2.5 2.5L6.5 3"/></svg></button>
        </div>
        <div class="bar-right">
          <button class="mode-btn" id="modeBtn" title="Permission mode (Shift+Tab)" aria-haspopup="menu"><span id="modeIcon" class="mode-icon"></span><span id="modeLabel" class="mode-label">Ask before edits</span></button>
          <button class="send" id="send" title="Send (Enter)" aria-label="Send">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.5 7.5 8 3l4.5 4.5"/></svg>
          </button>
          <button class="send stop hidden" id="stop" title="Stop (Esc)" aria-label="Stop">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="statusline">
      <span id="ctxMeter" class="meter hidden" title="Context window used"><span class="meter-label">Context</span><span class="meter-bar"><span id="ctxFill"></span></span><span id="ctxText"></span></span>
      <div id="usage" class="usage hidden" aria-label="Plan usage limits"></div>
      <span class="spacer"></span>
      <span id="tokens" class="stat hidden" title="Tokens this session (input / output)"></span>
      <span id="cost" class="stat hidden" title="API-equivalent cost of this session"></span>
    </div>
    </footer>
    </div>

    <aside id="drawer" class="drawer hidden" aria-label="Side panel">
      <div class="drawer-head">
        <h2 id="drawerTitle"></h2>
        <button class="tb-btn icon" id="drawerClose" title="Close">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div id="historyPane" class="drawer-pane hidden">
        <input id="historySearch" class="field" type="search" placeholder="Search conversations" />
        <ul id="historyList" class="history-list"></ul>
      </div>
      <div id="settingsPane" class="drawer-pane hidden">
        <section class="setting-group">
          <h3>Checkpoints</h3>
          <p class="muted" id="checkpointState"></p>
        </section>
        <section class="setting-group">
          <div class="group-head"><h3>MCP servers</h3><button class="link" id="mcpRefresh">Refresh</button></div>
          <ul id="mcpList" class="plain-list"></ul>
        </section>
        <section class="setting-group">
          <div class="group-head"><h3>Permission rules</h3><button class="link" id="rulesRefresh">Refresh</button></div>
          <ul id="rulesList" class="plain-list"></ul>
        </section>
        <section class="setting-group">
          <button class="btn" id="openSettings">Open extension settings</button>
        </section>
      </div>
    </aside>
  </div>
  <div id="menu" class="menu hidden" role="menu"></div>
  <div id="lightbox" class="lightbox hidden" role="dialog" aria-modal="true" aria-label="Image preview">
    <button class="lightbox-close" id="lightboxClose" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    <img id="lightboxImg" alt="" />
    <div id="lightboxName" class="lightbox-name"></div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function isChatTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(VIEW_TYPE);
}

/** New Claude tabs join the group that already has some; otherwise they open beside the editor. */
function chatColumn(): vscode.ViewColumn {
  const chatGroup = vscode.window.tabGroups.all.find((g) => g.tabs.some(isChatTab));
  if (chatGroup) {
    return chatGroup.viewColumn;
  }
  return vscode.window.tabGroups.activeTabGroup.tabs.length ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
}

/**
 * Locks the editor group holding the new Claude tab, so files open in another group.
 * VS Code keeps the lock, and the serializer brings the tabs back, after a restart.
 * Only a group that holds nothing but Claude tabs is locked.
 */
async function lockChatGroup(): Promise<void> {
  if (!vscode.workspace.getConfiguration("claudeSwitcher").get<boolean>("chat.lockEditorGroup", true)) {
    return;
  }
  const group = vscode.window.tabGroups.activeTabGroup;
  if (group.tabs.length > 0 && group.tabs.every(isChatTab)) {
    await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
  }
}

/** The tab icon in the profile's color (the same icon as its title bar button). */
/** The tab's icon; while Claude works in the tab, a variant with a dot in the corner. */
function tabIcon(media: vscode.Uri, color: number | undefined, busy = false): vscode.Uri {
  const name =
    color === undefined || color < 0 || color >= ACCOUNT_COLORS.length
      ? "claude-tab"
      : `tab-${color + 1}`;
  return vscode.Uri.joinPath(media, busy ? `${name}-busy.svg` : `${name}.svg`);
}

/** A restored tab whose account cannot be used right now. */
function showRestoreError(
  extensionUri: vscode.Uri,
  panel: vscode.WebviewPanel,
  label: string,
  color: number | undefined,
  message: string,
  state: SavedTabState
): void {
  const nonce = crypto.randomBytes(16).toString("hex");
  const media = vscode.Uri.joinPath(extensionUri, "media");
  panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
  panel.title = `Claude · ${label}`;
  panel.iconPath = tabIcon(media, color);
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
  const esc = (t: string) =>
    t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  // The state keeps the tab restorable even if it is closed again before a retry works.
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <section class="welcome">
    <div class="welcome-mark" aria-hidden="true">${BRAND_MARK}</div>
    <h1>The Claude tab for ${esc(label)} was not reopened</h1>
    <p class="muted">${esc(message)}</p>
    <button class="btn primary" id="retry">Try again</button>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    vscode.setState(${stateJson});
    document.getElementById("retry").addEventListener("click", () => vscode.postMessage({ type: "retry" }));
  </script>
</body>
</html>`;
}

function checkpointsEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSwitcher").get<boolean>("chat.checkpoints", true);
}

/**
 * Claude Code's task-list tools, always withheld: current models track their work
 * without them, and every call only spends tokens.
 */
const TASK_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
