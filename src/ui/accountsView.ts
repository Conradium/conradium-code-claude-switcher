import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { requiresProfileReauthorization } from "../oauth";
import { ACCOUNT_COLORS, MAX_ACCOUNTS } from "../types";

interface ViewAccount {
  id: string;
  label: string;
  subscriptionType?: string;
  isActive: boolean;
  windows: { label: string; percent: number; severity: string; resetsAt: string | null }[];
  error?: string;
  fetchedAt?: number;
  retryAfter?: number;
  needsReauthorization: boolean;
  /** Login email, when it adds information beyond the label. */
  email?: string;
  /** Claude Code chat tabs open on this profile in this window. */
  openTabs: number;
  /** ACCOUNT_COLORS index; undefined when all five are taken by other profiles. */
  color?: number;
  /** Whether the profile's color button shows in the editor title bar. */
  titleButton: boolean;
}

/** Activity bar panel: list of accounts with usage limits and actions. */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claudeSwitcher.accountsView";
  private view?: vscode.WebviewView;
  private refreshSeq = 0;
  private unsaved: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore,
    private readonly getOpenTabs: () => Map<string, number> = () => new Map()
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string; id?: string; value?: unknown }) => {
      switch (msg.type) {
        case "ready":
          this.refresh();
          break;
        case "switch":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.switchAccount", msg.id);
          break;
        case "openTab":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.openClaudeTab", msg.id);
          break;
        case "showTab":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.showClaudeTab", msg.id);
          break;
        case "openWindow":
          if (msg.id) {
            void vscode.commands.executeCommand("claudeSwitcher.openIndependentWindow", msg.id);
          }
          break;
        case "refresh":
          void vscode.commands.executeCommand("claudeSwitcher.refreshUsage", msg.id);
          break;
        case "refreshAll":
          void vscode.commands.executeCommand("claudeSwitcher.refreshUsage");
          break;
        case "sayHi":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.sayHi", msg.id);
          break;
        case "sayHiAll":
          void vscode.commands.executeCommand("claudeSwitcher.sayHi");
          break;
        case "add":
          void vscode.commands.executeCommand("claudeSwitcher.addCurrentAccount");
          break;
        case "login":
          void vscode.commands.executeCommand("claudeSwitcher.addAccount");
          break;
        case "browserLogin":
          void vscode.commands.executeCommand("claudeSwitcher.browserLogin");
          break;
        case "terminalLogin":
          void vscode.commands.executeCommand("claudeSwitcher.login");
          break;
        case "openWindowPick":
          void vscode.commands.executeCommand("claudeSwitcher.openIndependentWindow");
          break;
        case "walkthrough":
          void vscode.commands.executeCommand("claudeSwitcher.openWalkthrough");
          break;
        case "settings":
          void vscode.commands.executeCommand("claudeSwitcher.openSettings");
          break;
        case "setColor":
          if (msg.id && typeof msg.value === "number") {
            void vscode.commands.executeCommand("claudeSwitcher.setAccountColor", msg.id, msg.value);
          }
          break;
        case "setTitleButton":
          if (msg.id && typeof msg.value === "boolean") {
            void vscode.commands.executeCommand("claudeSwitcher.setTitleButton", msg.id, msg.value);
          }
          break;
        case "reauthorize":
          if (msg.id) {
            void vscode.commands.executeCommand("claudeSwitcher.reauthorizeProfile", msg.id);
          }
          break;
        case "remove":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.removeAccount", msg.id);
          break;
        case "rename":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.renameAccount", msg.id);
          break;
        case "undo":
          void vscode.commands.executeCommand("claudeSwitcher.undoSwitch");
          break;
      }
    });

    this.refresh();
  }

  /** Label of a logged-in Claude account that is not saved as a profile (or undefined). */
  setUnsavedLabel(label: string | undefined): void {
    this.unsaved = label;
    this.refresh();
  }

  /** Sends the current state to the webview. */
  refresh(): void {
    if (!this.view) {
      return;
    }
    const activeId = this.store.getActiveId();
    const profiles = this.store.list();
    const warnThreshold = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<number>("warnThresholdPercent", 80);
    // Secret reads are async; drop a slower, older render instead of letting it
    // overwrite a newer state.
    const seq = ++this.refreshSeq;
    const openTabs = this.getOpenTabs();

    void Promise.all(
      profiles.map(async (p): Promise<ViewAccount> => {
        const creds = await this.store.getCreds(p.id);
        const error = p.lastUsage?.error;
        const needsReauthorization =
          !hasUsableOAuthCreds(creds) ||
          this.store.isRefreshTokenDead(p.id, creds?.refreshToken) ||
          requiresProfileReauthorization(error);
        return {
          id: p.id,
          label: p.label,
          subscriptionType: p.subscriptionType,
          isActive: p.id === activeId,
          windows: p.lastUsage?.windows ?? [],
          error: displayUsageError(error, needsReauthorization),
          fetchedAt: p.lastUsage?.fetchedAt,
          retryAfter: p.lastUsage?.retryAfter,
          needsReauthorization,
          email:
            p.authEmail && p.authEmail.toLowerCase() !== p.label.toLowerCase()
              ? p.authEmail
              : undefined,
          openTabs: openTabs.get(p.id) ?? 0,
          color: p.color,
          titleButton: p.titleButton !== false,
        };
      })
    ).then((accounts) => {
      if (seq === this.refreshSeq) {
        void this.view?.webview.postMessage({
          type: "state",
          accounts,
          colors: ACCOUNT_COLORS,
          maxAccounts: MAX_ACCOUNTS,
          titleButtons: vscode.workspace
            .getConfiguration("claudeSwitcher")
            .get<boolean>("showEditorTitleButton", true),
          warnThreshold,
          unsaved: this.unsaved,
        });
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude Accounts</title>
</head>
<body>
  <div id="list"></div>
  <button id="add" class="add-btn" aria-haspopup="menu" aria-expanded="false">Add account</button>
  <p id="limit" class="limit hidden" role="status"></p>
  <p id="note" class="note hidden">Don't use <code>/logout</code> to change accounts &mdash; it revokes that login on Anthropic's side.</p>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function displayUsageError(
  error: string | undefined,
  needsReauthorization: boolean
): string | undefined {
  if (needsReauthorization) {
    return "Login was revoked or expired. Reauthorize this profile to keep using it.";
  }
  return error;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
