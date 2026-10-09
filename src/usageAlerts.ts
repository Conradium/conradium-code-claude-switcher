import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { AccountProfile, UsageWindow } from "./types";

/** Alerts already shown, as key → when the key may be forgotten (epoch ms): the window's reset. */
const NOTIFIED_KEY = "claudeSwitcher.usageAlertsNotified";
/** How long an alert on a window without a reset time is remembered. */
const NO_RESET_TTL_MS = 7 * 24 * 3_600_000;

export type UsageAlertLevel = "warn" | "limit";

export interface UsageAlert {
  profileId: string;
  /** The most severe window that crossed a line; the one the notification names. */
  window: UsageWindow;
  level: UsageAlertLevel;
  /** Every window this alert covers, so none of them notifies again on the next poll. */
  keys: Array<{ key: string; expiresAt: number }>;
}

/**
 * Identifies one level of one limit. The key is remembered until the window resets,
 * not matched on the reset time, which can shift by seconds between polls.
 */
export function usageAlertKey(profileId: string, kind: string, level: UsageAlertLevel): string {
  return `${profileId}|${kind}|${level}`;
}

/**
 * The alerts to show now: at most one per account in use, for its most severe window
 * past the threshold (or at its limit) that has not notified yet.
 */
export function pendingUsageAlerts(
  profiles: AccountProfile[],
  inUse: ReadonlySet<string>,
  threshold: number,
  notified: Readonly<Record<string, number>>,
  now = Date.now()
): UsageAlert[] {
  const alerts: UsageAlert[] = [];
  for (const profile of profiles) {
    const usage = profile.lastUsage;
    // After a failed poll the windows are the previous ones, so they say nothing new.
    if (!inUse.has(profile.id) || !usage || usage.error) {
      continue;
    }
    let worst: { window: UsageWindow; level: UsageAlertLevel } | undefined;
    const keys: UsageAlert["keys"] = [];
    for (const w of usage.windows) {
      const level: UsageAlertLevel | undefined =
        w.percent >= 100 ? "limit" : w.percent >= threshold ? "warn" : undefined;
      if (!level) {
        continue;
      }
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      // A window past its reset is from a snapshot older than the reset (a skipped poll).
      if (reset <= now) {
        continue;
      }
      const key = usageAlertKey(profile.id, w.kind, level);
      if ((notified[key] ?? 0) > now) {
        continue;
      }
      const expiresAt = Number.isFinite(reset) ? reset : now + NO_RESET_TTL_MS;
      keys.push({ key, expiresAt });
      if (level === "limit") {
        // A window first seen at its limit does not warn about the threshold afterwards.
        keys.push({ key: usageAlertKey(profile.id, w.kind, "warn"), expiresAt });
      }
      if (
        !worst ||
        (level === "limit" && worst.level === "warn") ||
        (level === worst.level && w.percent > worst.window.percent)
      ) {
        worst = { window: w, level };
      }
    }
    if (worst) {
      alerts.push({ profileId: profile.id, window: worst.window, level: worst.level, keys });
    }
  }
  return alerts;
}

/** The saved account with the most room left under the threshold, outside `exclude`. */
export function bestAlternative(
  profiles: AccountProfile[],
  exclude: ReadonlySet<string>,
  threshold: number
): AccountProfile | undefined {
  let best: { profile: AccountProfile; used: number } | undefined;
  for (const profile of profiles) {
    const usage = profile.lastUsage;
    if (exclude.has(profile.id) || !usage || usage.error || usage.windows.length === 0) {
      continue;
    }
    const used = Math.max(...usage.windows.map((w) => w.percent));
    if (used < threshold && (!best || used < best.used)) {
      best = { profile, used };
    }
  }
  return best?.profile;
}

/**
 * Notifies when an account used in this window (Claude Code's, or one with an open
 * Claude tab) passes the warning threshold of a usage limit, and again when it hits
 * the limit, once per limit window. Shown alerts are remembered across reloads, so
 * the reload after a switch does not repeat them.
 */
export class UsageAlerts {
  constructor(
    private readonly state: vscode.Memento,
    private readonly store: AccountStore,
    /** Accounts with a Claude tab open in this window. */
    private readonly openTabIds: () => Iterable<string>,
    /** Whether another VS Code window is using the account. */
    private readonly usedElsewhere: (id: string) => boolean
  ) {}

  check(): void {
    const config = vscode.workspace.getConfiguration("claudeSwitcher");
    if (!config.get<boolean>("usageAlerts", true)) {
      return;
    }
    const threshold = config.get<number>("warnThresholdPercent", 80);
    const now = Date.now();

    const stored = this.state.get<Record<string, number>>(NOTIFIED_KEY, {});
    const notified = Object.fromEntries(
      Object.entries(stored).filter(([, expiresAt]) => expiresAt > now)
    );
    const claudeCodeId = this.store.getActiveId();
    const inUse = new Set(this.openTabIds());
    if (claudeCodeId) {
      inUse.add(claudeCodeId);
    }

    const alerts = pendingUsageAlerts(this.store.list(), inUse, threshold, notified, now);
    for (const alert of alerts) {
      for (const { key, expiresAt } of alert.keys) {
        notified[key] = expiresAt;
      }
    }
    if (alerts.length || Object.keys(notified).length !== Object.keys(stored).length) {
      void this.state.update(NOTIFIED_KEY, notified);
    }

    const exclude = new Set(inUse);
    for (const p of this.store.list()) {
      if (this.usedElsewhere(p.id)) {
        exclude.add(p.id);
      }
    }
    const alternative = bestAlternative(this.store.list(), exclude, threshold);
    for (const alert of alerts) {
      void this.show(alert, alert.profileId === claudeCodeId, alternative);
    }
  }

  private async show(
    alert: UsageAlert,
    isClaudeCode: boolean,
    alternative: AccountProfile | undefined
  ): Promise<void> {
    const profile = this.store.get(alert.profileId);
    if (!profile) {
      return;
    }
    const who = `${profile.label} (${isClaudeCode ? "Claude Code" : "Claude tab"})`;
    const limit = limitName(alert.window);
    const reset = resetText(alert.window.resetsAt);
    const message =
      alert.level === "limit"
        ? `${who} has reached its ${limit}${reset}.`
        : `${who} has used ${alert.window.percent}% of its ${limit}${reset}.`;

    const action = alternative
      ? isClaudeCode
        ? `Switch to ${alternative.label}`
        : `Open tab for ${alternative.label}`
      : undefined;
    const showAccounts = "Show accounts";
    const choice = await vscode.window.showWarningMessage(
      message,
      ...(action ? [action, showAccounts] : [showAccounts])
    );
    if (choice && choice === action && alternative) {
      await vscode.commands.executeCommand(
        isClaudeCode ? "claudeSwitcher.switchAccount" : "claudeSwitcher.openClaudeTab",
        alternative.id
      );
    } else if (choice === showAccounts) {
      await vscode.commands.executeCommand("claudeSwitcher.openPanel");
    }
  }
}

function limitName(w: UsageWindow): string {
  switch (w.kind) {
    case "session":
      return "5-hour limit";
    case "weekly_opus":
      return "weekly Opus limit";
    case "weekly_sonnet":
      return "weekly Sonnet limit";
    default:
      return w.kind.startsWith("weekly") ? "weekly limit" : `${w.label} limit`;
  }
}

function resetText(resetsAt: string | null): string {
  const reset = resetsAt ? new Date(resetsAt) : undefined;
  if (!reset || Number.isNaN(reset.getTime())) {
    return "";
  }
  const time = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return reset.toDateString() === new Date().toDateString()
    ? `; it resets at ${time}`
    : `; it resets ${reset.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
