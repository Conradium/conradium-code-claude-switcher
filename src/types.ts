/**
 * Raw structure stored in ~/.claude/.credentials.json
 * { "claudeAiOauth": { ... } }
 */
export interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the accessToken expires */
  expiresAt: number;
  /** epoch ms when the refreshToken expires */
  refreshTokenExpiresAt?: number;
  scopes: string[];
  clientId?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface ClaudeAuthIdentity {
  /** Stable Claude account id (account.uuid) — the most reliable identity key. */
  accountUuid?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
}

export interface CredentialsFile {
  claudeAiOauth: OAuthCreds;
  /** Claude Code stores the organization of the login next to the tokens. */
  organizationUuid?: string;
  [key: string]: unknown;
}

/** Profile metadata (no secrets) — kept in globalState. */
export interface AccountProfile {
  id: string;
  label: string;
  subscriptionType?: string;
  authAccountUuid?: string;
  authEmail?: string;
  authOrgId?: string;
  authOrgName?: string;
  /**
   * Snapshot of `oauthAccount` from Claude Code's `.claude.json` for this account.
   * Restored on switch so Claude Code's cached account info matches the tokens.
   */
  oauthAccount?: Record<string, unknown>;
  /**
   * SHA-256 prefix of a refresh token the server rejected with invalid_grant.
   * The extension never sends that token again; a newer generation clears it.
   */
  deadRefreshTokenHash?: string;
  /**
   * Index into ACCOUNT_COLORS, unique across profiles. It picks the avatar color, the
   * Claude tab icon and the editor title bar button (one per color, so at most five).
   */
  color?: number;
  /** Whether the profile's color button shows in the editor title bar (default: on). */
  titleButton?: boolean;
  addedAt: number;
  order: number;
  /** last read usage snapshot (cached for fast rendering) */
  lastUsage?: UsageSnapshot;
}

/**
 * Account colors. Each has a title bar command (`claudeSwitcher.openAccountTab<n>`, n = index + 1)
 * and an icon (`media/tab-<n>.svg`) declared in package.json, so the length is fixed at five.
 */
export const ACCOUNT_COLORS = [
  { name: "Teal", hex: "#2B8A92" },
  { name: "Orange", hex: "#D97757" },
  { name: "Violet", hex: "#8E6FD8" },
  { name: "Blue", hex: "#3B82C4" },
  { name: "Pink", hex: "#CF5C8E" },
] as const;

/** One color per account, so the number of saved accounts is capped at the palette size. */
export const MAX_ACCOUNTS = ACCOUNT_COLORS.length;

export const ACCOUNT_LIMIT_MESSAGE = `You can save up to ${MAX_ACCOUNTS} accounts. Remove one to add another.`;

/** A single usage window (5h / weekly / opus, etc.) normalized for the UI. */
export interface UsageWindow {
  kind: string;
  label: string;
  /** 0-100 */
  percent: number;
  severity: string;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fetchedAt: number;
  windows: UsageWindow[];
  /** convenience shortcuts for the UI */
  sessionPercent: number | null;
  weeklyPercent: number | null;
  /** set when the request failed */
  error?: string;
  /** earliest time a retry is allowed (epoch ms) — backoff on 429 */
  retryAfter?: number;
}

/** A profile together with its decrypted secrets (for internal operations). */
export interface AccountWithCreds {
  profile: AccountProfile;
  creds: OAuthCreds;
  isActive: boolean;
}
