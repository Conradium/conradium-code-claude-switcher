import * as crypto from "crypto";
import * as fs from "fs";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { AccountChatService } from "./accountChat";
import { AccountWindowService } from "./accountWindow";
import { BrowserOAuthLogin } from "./browserOAuth";
import {
  getConfiguredClaudeCommand,
  missingClaudeCliMessage,
  quoteForTerminal,
  resolveClaudeCommand,
} from "./cli";
import { CredentialSync, CurrentAccountState } from "./credentialSync";
import { hasUsableOAuthCreds, sameNonEmptyToken } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { identityLabel, profileIdentity, sameIdentity } from "./identity";
import { getAccountConfigDir } from "./isolatedConfig";
import { TokenRefresher } from "./oauth";
import { ProfileActivityRegistry } from "./profileActivity";
import { SwitchService } from "./switchService";
import { AccountsViewProvider } from "./ui/accountsView";
import { StatusBarController } from "./ui/statusBar";
import { UsagePoller } from "./usage";
import { UsageAlerts } from "./usageAlerts";
import {
  ACCOUNT_COLORS,
  ACCOUNT_LIMIT_MESSAGE,
  AccountProfile,
  ClaudeAuthIdentity,
  OAuthCreds,
} from "./types";
import { WarmupService } from "./warmup";

const LOGIN_WATCH_TIMEOUT_MS = 15 * 60_000;
const WALKTHROUGH_SHOWN_KEY = "claudeSwitcher.walkthroughShown";
const CREDENTIALS_WATCH_INTERVAL_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
  const store = new AccountStore(context);
  const credentials = new CredentialsManager();
  const refresher = new TokenRefresher();
  const browserOAuth = new BrowserOAuthLogin();
  const profileActivity = new ProfileActivityRegistry(context);
  const homeDir = (id: string) => getAccountConfigDir(context, id);
  const sync = new CredentialSync(store, credentials, refresher, homeDir);
  const switchService = new SwitchService(store, credentials, sync, (id) =>
    profileActivity.isActive(id, { excludeSelf: true })
  );
  const warmupService = new WarmupService(context, store, sync, profileActivity);
  const accountWindowService = new AccountWindowService(
    context,
    store,
    credentials,
    sync,
    profileActivity
  );
  const accountChats = new AccountChatService(
    context,
    store,
    sync,
    profileActivity,
    () => refreshUI()
  );
  const statusBar = new StatusBarController(store);
  const viewProvider = new AccountsViewProvider(context.extensionUri, store, () =>
    accountChats.openTabCounts()
  );

  const getInterval = () =>
    vscode.workspace.getConfiguration("claudeSwitcher").get<number>("pollIntervalSeconds", 240);

  // One editor title button per account color. The buttons are declared in package.json;
  // context keys show the ones whose account has a Claude tab to open (not this window's
  // Claude Code account). The generic picker button shows when none of them does.
  const updateTitleButtons = () => {
    const activeId = store.getActiveId();
    let any = false;
    ACCOUNT_COLORS.forEach((_, i) => {
      const p = store.findByColor(i);
      const visible = Boolean(p && p.titleButton !== false && p.id !== activeId);
      any ||= visible;
      void vscode.commands.executeCommand(
        "setContext",
        `claudeSwitcher.accountTabButton${i + 1}`,
        visible
      );
    });
    void vscode.commands.executeCommand("setContext", "claudeSwitcher.anyAccountTabButton", any);
  };

  const refreshUI = () => {
    statusBar.refresh();
    viewProvider.refresh();
    updateTitleButtons();
    accountChats.refreshAppearance();
    accountChats.refreshUsage();
  };

  // --- Current account tracking ---

  let notifiedUnsavedKey: string | undefined;
  const applyCurrentState = (state: CurrentAccountState) => {
    profileActivity.setActiveProfile(store.getActiveId());
    statusBar.setUnsavedIdentity(state.unsavedIdentity);
    const key = state.unsavedIdentity ? identityLabel(state.unsavedIdentity) : undefined;
    viewProvider.setUnsavedLabel(key);
    if (key && key !== notifiedUnsavedKey) {
      notifiedUnsavedKey = key;
      void vscode.window
        .showInformationMessage(
          `Claude Code is logged in as ${key}, which is not saved as a profile yet.`,
          "Save as profile"
        )
        .then((choice) => {
          if (choice === "Save as profile") {
            void vscode.commands.executeCommand("claudeSwitcher.addCurrentAccount");
          }
        });
    }
    if (!key) {
      notifiedUnsavedKey = undefined;
    }
  };

  const synchronizeCurrentProfile = async () => {
    try {
      applyCurrentState(await sync.syncCurrent());
    } catch {
      profileActivity.setActiveProfile(store.getActiveId());
    }
  };

  // Claude Code rewrites its credentials file on every token rotation and on
  // /login. Import each new generation right away instead of waiting for the next
  // usage poll, so the saved profile never keeps an already spent refresh token.
  let watchedCredentialsPath: string | undefined;
  let syncTimer: NodeJS.Timeout | undefined;
  const onCredentialsFileChanged = () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void synchronizeCurrentProfile().then(refreshUI);
    }, 750);
  };
  const watchCredentialsFile = () => {
    const next = credentials.getCredentialsPath();
    if (watchedCredentialsPath === next) {
      return;
    }
    if (watchedCredentialsPath) {
      fs.unwatchFile(watchedCredentialsPath, onCredentialsFileChanged);
    }
    watchedCredentialsPath = next;
    fs.watchFile(next, { interval: CREDENTIALS_WATCH_INTERVAL_MS }, onCredentialsFileChanged);
  };

  // --- Login helpers ---

  const authorizeInBrowser = async (configDir?: string) => {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Waiting for Claude authorization in your browser...",
        cancellable: false,
      },
      () => browserOAuth.authorize((url) => vscode.env.openExternal(vscode.Uri.parse(url)))
    );
    if (result.ok && result.creds) {
      credentials.writeCreds(result.creds, configDir, {
        organizationUuid: result.identity?.orgId ?? null,
      });
      sync.rememberIdentity(result.creds, result.identity);
    }
    return result;
  };

  const openClaudeLogin = async (options?: { configDir?: string; terminalName?: string }) => {
    const configuredCommand = getConfiguredClaudeCommand();
    const resolvedCommand = resolveClaudeCommand(configuredCommand);
    if (!resolvedCommand) {
      const result = await authorizeInBrowser(options?.configDir);
      if (!result.ok) {
        vscode.window.showWarningMessage(
          `${missingClaudeCliMessage()} Browser authorization also failed: ${result.error ?? "unknown error"}`
        );
      } else {
        vscode.window.showInformationMessage(
          "Claude authorization completed in the browser without the Claude Code CLI."
        );
      }
      return { ok: result.ok, usedBrowser: true, identity: result.identity };
    }

    const terminal = vscode.window.createTerminal({
      name: options?.terminalName ?? "Claude Login",
      env: options?.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : undefined,
    });
    terminal.show();
    terminal.sendText(`${quoteForTerminal(resolvedCommand)} auth login`);
    return { ok: true, usedBrowser: false, identity: undefined as ClaudeAuthIdentity | undefined };
  };

  /**
   * Resolves once an isolated login wrote new usable credentials into `configDir`
   * (or after a timeout), so the user does not have to click "Complete" manually.
   */
  const pendingLoginWatches = new Set<() => void>();
  const waitForLogin = (configDir: string, previous: OAuthCreds | null) =>
    new Promise<boolean>((resolve) => {
      const file = credentials.getCredentialsPath(configDir);
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        fs.unwatchFile(file, check);
        clearTimeout(timeout);
        pendingLoginWatches.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(false);
      const check = () => {
        const creds = credentials.readCurrent(configDir);
        if (
          creds &&
          hasUsableOAuthCreds(creds) &&
          !(previous && sameNonEmptyToken(previous.refreshToken, creds.refreshToken))
        ) {
          finish(true);
        }
      };
      const timeout = setTimeout(cancel, LOGIN_WATCH_TIMEOUT_MS);
      pendingLoginWatches.add(cancel);
      fs.watchFile(file, { interval: 1_000 }, check);
      check();
    });

  // --- Isolated reauthorization of a saved profile ---

  const completeProfileReauthorization = async (
    id: string,
    silentWhenMissing = false
  ): Promise<{ ok: boolean; message: string; missing?: boolean }> => {
    const profile = store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const configDir = homeDir(id);
    const creds = credentials.readCurrent(configDir);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        missing: silentWhenMissing,
        message: `No completed isolated login found for "${profile.label}" yet.`,
      };
    }

    const identity = await sync.identify(creds, configDir);
    if (!identity) {
      return {
        ok: false,
        message: `Could not verify which Claude account the isolated login for "${profile.label}" belongs to.`,
      };
    }

    const conflict = store.findByIdentity(identity, id);
    if (conflict) {
      return {
        ok: false,
        message:
          `The isolated login belongs to "${conflict.label}" (${identityLabel(identity)}). ` +
          `"${profile.label}" was not overwritten.`,
      };
    }

    const previousIdentity = profileIdentity(profile);
    if (previousIdentity && !sameIdentity(previousIdentity, identity)) {
      return {
        ok: false,
        message:
          `The isolated login identity (${identityLabel(identity)}) does not match ` +
          `"${profile.label}" (${identityLabel(previousIdentity)}). The profile was not overwritten.`,
      };
    }

    await store.updateCreds(id, creds);
    await store.updateIdentity(id, identity);
    await store.clearUsageError(id);
    await sync.captureOAuthAccount(id, configDir);
    return {
      ok: true,
      message: `Reauthorized "${profile.label}" as ${identityLabel(identity)}.`,
    };
  };

  const startProfileReauthorization = async (id: string) => {
    const profile = store.get(id);
    if (!profile) {
      vscode.window.showWarningMessage("Profile not found.");
      return;
    }

    const configDir = homeDir(id);
    try {
      credentials.moveCredentialsAside(configDir, "reauth-backup");
    } catch (e) {
      vscode.window.showWarningMessage((e as Error).message);
      return;
    }

    const login = await openClaudeLogin({
      configDir,
      terminalName: `Claude Login: ${profile.label}`,
    });
    if (!login.ok) {
      return;
    }

    const finish = async () => {
      const res = await completeProfileReauthorization(id);
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      if (res.ok) {
        await poller.pollOne(id, true);
      }
      refreshUI();
    };

    if (login.usedBrowser || (await waitForLogin(configDir, null))) {
      await finish();
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `The isolated login for "${profile.label}" was not detected. Complete it manually once you finished logging in.`,
      "Complete reauthorization"
    );
    if (choice === "Complete reauthorization") {
      await finish();
    }
  };

  // --- Adding another account without touching the current one ---

  const importIsolatedLogin = async (id: string, configDir: string) => {
    const creds = credentials.readCurrent(configDir);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      vscode.window.showWarningMessage("No completed Claude login was found.");
      return;
    }
    const identity = await sync.identify(creds, configDir);
    const existing = identity ? store.findByIdentity(identity) : undefined;
    if (existing) {
      await store.updateCreds(existing.id, creds);
      if (identity) {
        await store.updateIdentity(existing.id, identity);
      }
      await store.clearUsageError(existing.id);
      await sync.captureOAuthAccount(existing.id, configDir);
      fs.rmSync(configDir, { recursive: true, force: true });
      vscode.window.showInformationMessage(
        `This login belongs to the saved profile "${existing.label}"; it was refreshed with the new login.`
      );
      await poller.pollOne(existing.id, true);
      refreshUI();
      return;
    }

    // Checked before the login too; another window may have saved one in the meantime.
    if (store.isFull()) {
      fs.rmSync(configDir, { recursive: true, force: true });
      vscode.window.showWarningMessage(`${ACCOUNT_LIMIT_MESSAGE} The new login was not saved.`);
      return;
    }

    const label = await vscode.window.showInputBox({
      title: "Save the new Claude account",
      prompt: "Profile name (e.g. Work, Personal, Max #1)",
      value: identity?.email ?? (creds.subscriptionType ? `${creds.subscriptionType} account` : "New account"),
      validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
    });
    if (label === undefined) {
      fs.rmSync(configDir, { recursive: true, force: true });
      return;
    }
    const profile = await store.addFromCreds(label.trim(), creds, {
      id,
      identity,
      activate: false,
    });
    await sync.captureOAuthAccount(profile.id, configDir);
    vscode.window.showInformationMessage(
      `Saved "${profile.label}". The current Claude Code account was not changed; use Switch when you need it.`
    );
    await poller.pollOne(profile.id, true);
    refreshUI();
  };

  const addAccount = async () => {
    if (store.isFull()) {
      vscode.window.showWarningMessage(ACCOUNT_LIMIT_MESSAGE);
      return;
    }
    const id = crypto.randomUUID();
    const configDir = homeDir(id);
    fs.mkdirSync(configDir, { recursive: true });
    const login = await openClaudeLogin({ configDir, terminalName: "Claude Login: new account" });
    if (!login.ok) {
      fs.rmSync(configDir, { recursive: true, force: true });
      return;
    }
    if (!login.usedBrowser) {
      vscode.window.showInformationMessage(
        "Finish the login in the terminal/browser. The current Claude Code account stays untouched; the new account is saved automatically."
      );
      if (!(await waitForLogin(configDir, null))) {
        fs.rmSync(configDir, { recursive: true, force: true });
        vscode.window.showWarningMessage("No completed Claude login was detected. Nothing was saved.");
        return;
      }
    }
    await importIsolatedLogin(id, configDir);
  };

  const usageAlerts = new UsageAlerts(
    context.globalState,
    store,
    () => accountChats.openTabCounts().keys(),
    (id) => profileActivity.isActive(id, { excludeSelf: true })
  );
  const poller = new UsagePoller(store, sync, getInterval, () => {
    refreshUI();
    usageAlerts.check();
  });

  // Publish the remembered owner before asynchronous startup work, so another
  // window does not start a second session on this login during restart.
  profileActivity.setActiveProfile(store.getActiveId());

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, viewProvider),
    statusBar,
    accountChats,
    profileActivity,
    { dispose: () => poller.stop() },
    {
      dispose: () => {
        if (watchedCredentialsPath) {
          fs.unwatchFile(watchedCredentialsPath, onCredentialsFileChanged);
        }
        if (syncTimer) {
          clearTimeout(syncTimer);
        }
        for (const cancel of [...pendingLoginWatches]) {
          cancel();
        }
      },
    }
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.addCurrentAccount", async () => {
      const res = await switchService.captureCurrent();
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      await synchronizeCurrentProfile();
      const activeId = store.getActiveId();
      if (res.ok && activeId) {
        await poller.pollOne(activeId, true);
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.addAccount", () => addAccount())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.switchAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Switch to account…"));
      if (!targetId) {
        return;
      }
      let res = await switchService.switchTo(targetId);
      if (!res.ok && res.reauthProfileId) {
        const completed = await completeProfileReauthorization(res.reauthProfileId, true);
        if (completed.ok) {
          res = await switchService.switchTo(targetId);
        } else if (!completed.missing) {
          vscode.window.showWarningMessage(completed.message);
        }
      }
      if (!res.ok) {
        if (res.reauthProfileId) {
          const choice = await vscode.window.showWarningMessage(
            `${res.message} Reauthorize this profile in an isolated Claude login so another saved account cannot overwrite it.`,
            "Reauthorize profile"
          );
          if (choice === "Reauthorize profile") {
            await startProfileReauthorization(res.reauthProfileId);
          }
        } else if (res.message !== "Cancelled.") {
          vscode.window.showWarningMessage(res.message);
        }
      }
      profileActivity.setActiveProfile(store.getActiveId());
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.refreshUsage", async (id?: string) => {
      if (id) {
        await poller.pollOne(id, true);
        refreshUI();
        usageAlerts.check();
      } else {
        await poller.pollAll(true);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.sayHi", async (id?: string) => {
      const targetIds = id ? [id] : await pickWarmupTargets(store);
      if (!targetIds || targetIds.length === 0) {
        return;
      }

      for (const targetId of targetIds) {
        const res = await warmupService.sayHi(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
        if (res.ok) {
          await poller.pollOne(targetId, true);
        }
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openIndependentWindow", async (id?: string) => {
      const targetIds = id ? [id] : await pickWindowTargets(store);
      if (!targetIds || targetIds.length === 0) {
        return;
      }

      for (const targetId of targetIds) {
        const res = await accountWindowService.open(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openClaudeTab", async (id?: unknown) => {
      // Menu contributions such as editor/title pass the active editor's URI, not an id.
      const targetId =
        typeof id === "string"
          ? id
          : await pickClaudeTabTarget(store, sync, profileActivity, accountChats);
      if (!targetId) {
        return;
      }
      const res = await accountChats.open(targetId);
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
      }
    }),
    vscode.commands.registerCommand("claudeSwitcher.showClaudeTab", (id: string) => {
      if (!accountChats.reveal(id)) {
        void vscode.commands.executeCommand("claudeSwitcher.openClaudeTab", id);
      }
    }),
    ...ACCOUNT_COLORS.map((_, i) =>
      vscode.commands.registerCommand(`claudeSwitcher.openAccountTab${i + 1}`, () => {
        // Like Claude Code's own title bar button, each click opens another tab.
        const profile = store.findByColor(i);
        if (profile) {
          void vscode.commands.executeCommand("claudeSwitcher.openClaudeTab", profile.id);
        }
      })
    ),
    // Panel-only commands (not contributed): a card's color and title bar button.
    vscode.commands.registerCommand(
      "claudeSwitcher.setAccountColor",
      async (id: string, color: number) => {
        await store.setColor(id, color);
        refreshUI();
      }
    ),
    vscode.commands.registerCommand(
      "claudeSwitcher.setTitleButton",
      async (id: string, visible: boolean) => {
        await store.setTitleButton(id, visible);
        refreshUI();
      }
    ),
    // Brings Claude tabs back, with their conversations, when VS Code restarts.
    vscode.window.registerWebviewPanelSerializer("claudeSwitcher.chat", {
      deserializeWebviewPanel: (panel, state) => accountChats.restore(panel, state),
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.login", async () => {
      // Save the outgoing login's latest rotation before Claude Code replaces it.
      await synchronizeCurrentProfile();
      await openClaudeLogin();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.browserLogin", async () => {
      await synchronizeCurrentProfile();
      const result = await authorizeInBrowser();
      if (result.ok) {
        vscode.window.showInformationMessage(
          "Claude authorization completed in the browser. Reload the window so Claude Code uses it."
        );
        await synchronizeCurrentProfile();
      } else {
        vscode.window.showWarningMessage(
          `Browser authorization failed: ${result.error ?? "unknown error"}`
        );
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.reauthorizeProfile", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Reauthorize profile..."));
      if (targetId) {
        await startProfileReauthorization(targetId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeSwitcher.completeProfileReauthorization",
      async (id?: string) => {
        const targetId = id ?? (await pickAccount(store, "Complete profile reauthorization..."));
        if (!targetId) {
          return;
        }
        const res = await completeProfileReauthorization(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
        if (res.ok) {
          await poller.pollOne(targetId, true);
        }
        refreshUI();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.removeAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Remove account profile…"));
      if (!targetId) {
        return;
      }
      const profile = store.get(targetId);
      const confirm = await vscode.window.showWarningMessage(
        `Remove the profile "${profile?.label ?? targetId}"? (does not log the account out of Claude)`,
        { modal: true },
        "Remove"
      );
      if (confirm === "Remove") {
        // The isolated config dir holds a live copy of the login. Keep it only while
        // another window still runs Claude Code on it.
        const inUse = profileActivity.isActive(targetId, { excludeSelf: true });
        await store.remove(targetId);
        // A profile beyond the fifth can take the freed color.
        await store.assignMissingColors();
        if (!inUse) {
          try {
            fs.rmSync(homeDir(targetId), { recursive: true, force: true });
          } catch {
            /* best effort: the profile itself is already removed */
          }
        }
        profileActivity.setActiveProfile(store.getActiveId());
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.renameAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Rename profile…"));
      if (!targetId) {
        return;
      }
      const profile = store.get(targetId);
      const label = await vscode.window.showInputBox({
        title: "New profile name",
        value: profile?.label,
        validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
      });
      if (label) {
        await store.rename(targetId, label.trim());
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.undoSwitch", async () => {
      const res = await switchService.undoSwitch();
      profileActivity.setActiveProfile(store.getActiveId());
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openPanel", () => {
      void vscode.commands.executeCommand("claudeSwitcher.accountsView.focus");
    })
  );

  const openWalkthrough = () =>
    vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      `${context.extension.id}#gettingStarted`,
      false
    );
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openWalkthrough", openWalkthrough),
    vscode.commands.registerCommand("claudeSwitcher.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id}`
      )
    )
  );
  // Show the walkthrough once, on the first activation after install.
  if (!context.globalState.get<boolean>(WALKTHROUGH_SHOWN_KEY)) {
    void context.globalState.update(WALKTHROUGH_SHOWN_KEY, true);
    void openWalkthrough();
  }

  // React to setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSwitcher.pollIntervalSeconds")) {
        poller.restart();
      }
      if (
        e.affectsConfiguration("claudeSwitcher.warnThresholdPercent") ||
        e.affectsConfiguration("claudeSwitcher.showEditorTitleButton")
      ) {
        refreshUI();
      }
      if (e.affectsConfiguration("claudeSwitcher.credentialsPath")) {
        watchCredentialsFile();
        onCredentialsFileChanged();
      }
    })
  );

  watchCredentialsFile();
  // Profiles saved before account colors existed get theirs here.
  void store
    .assignMissingColors()
    .then(synchronizeCurrentProfile)
    .then(() => {
      refreshUI();
      poller.start();
    });
}

export function deactivate(): void {
  /* resources are released via context.subscriptions */
}

/** Shared account-picker QuickPick with a usage preview. */
async function pickAccount(store: AccountStore, title: string): Promise<string | undefined> {
  const activeId = store.getActiveId();
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const items = accounts.map((p: AccountProfile) => {
    const u = p.lastUsage;
    const parts: string[] = [];
    if (typeof u?.sessionPercent === "number") parts.push(`5h: ${u.sessionPercent}%`);
    if (typeof u?.weeklyPercent === "number") parts.push(`weekly: ${u.weeklyPercent}%`);
    if (u?.error) parts.push("⚠ usage error");
    return {
      label: (p.id === activeId ? "$(check) " : "$(account) ") + p.label,
      description: [p.subscriptionType, parts.join("  ")].filter(Boolean).join("  ·  "),
      id: p.id,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an account",
    matchOnDescription: true,
  });
  return picked?.id;
}

/**
 * Lists only profiles a Claude tab can open on: not this window's Claude Code
 * account, and not a login another VS Code window is already using.
 */
async function pickClaudeTabTarget(
  store: AccountStore,
  sync: CredentialSync,
  profileActivity: ProfileActivityRegistry,
  accountChats: AccountChatService
): Promise<string | undefined> {
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const currentId = (await sync.syncCurrent()).ownerId;
  const tabCounts = accountChats.openTabCounts();
  const available = accounts.filter(
    (p) =>
      p.id !== currentId &&
      (tabCounts.has(p.id) || !profileActivity.isActive(p.id, { excludeSelf: true }))
  );
  if (available.length === 0) {
    vscode.window.showInformationMessage(
      "No other profile is available. Save another account, or close the session using it in another window."
    );
    return undefined;
  }

  const items = available.map((p) => {
    const u = p.lastUsage;
    const parts: string[] = [];
    if (typeof u?.sessionPercent === "number") parts.push(`5h: ${u.sessionPercent}%`);
    if (typeof u?.weeklyPercent === "number") parts.push(`weekly: ${u.weeklyPercent}%`);
    if (u?.error) parts.push("⚠ usage error");
    const tabs = tabCounts.get(p.id);
    if (tabs) parts.push(`${tabs} tab${tabs === 1 ? "" : "s"} open`);
    return {
      label: "$(account) " + p.label,
      description: [p.subscriptionType, parts.join("  ")].filter(Boolean).join("  ·  "),
      id: p.id,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Open Claude Code tab for account…",
    placeHolder: "Select an account not used by this window's Claude Code",
    matchOnDescription: true,
  });
  return picked?.id;
}

async function pickWarmupTargets(store: AccountStore): Promise<string[] | undefined> {
  const accounts = store.list();
  const activeId = store.getActiveId();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const inactive = accounts.filter((p) => p.id !== activeId);
  const items: Array<{ label: string; description?: string; ids: string[] }> = [];
  if (inactive.length > 1) {
    items.push({
      label: "$(run-all) Say Hi on all inactive accounts",
      description: `${inactive.length} accounts`,
      ids: inactive.map((p) => p.id),
    });
  }
  for (const p of accounts) {
    items.push({
      label: (p.id === activeId ? "$(circle-slash) " : "$(comment) ") + p.label,
      description:
        p.id === activeId
          ? "active account is skipped to avoid token races"
          : p.subscriptionType,
      ids: p.id === activeId ? [] : [p.id],
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Say Hi",
    placeHolder: "Select account to warm up",
    matchOnDescription: true,
  });
  return picked?.ids;
}

async function pickWindowTargets(store: AccountStore): Promise<string[] | undefined> {
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const activeId = store.getActiveId();
  const items: Array<{ label: string; description?: string; ids: string[] }> = [];
  if (accounts.length > 1) {
    items.push({
      label: "$(run-all) Open all accounts in independent windows",
      description: `${accounts.length} windows`,
      ids: accounts.map((p) => p.id),
    });
  }
  for (const p of accounts) {
    items.push({
      label: (p.id === activeId ? "$(check) " : "$(window) ") + p.label,
      description: p.id === activeId ? "current account" : p.subscriptionType,
      ids: [p.id],
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Open independent account window",
    placeHolder: "Select account",
    matchOnDescription: true,
  });
  return picked?.ids;
}
