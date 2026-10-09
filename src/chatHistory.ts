import * as fs from "fs";
import * as path from "path";

/** A past Claude Code conversation of one profile, as the History list shows it. */
export interface ChatHistoryItem {
  sessionId: string;
  title: string;
  updatedAt: number;
}

const TITLE_SCAN_BYTES = 256 * 1024;
const MAX_ITEMS = 60;

/**
 * Claude Code keeps each session's transcript in
 * `<config dir>/projects/<cwd with every non-alphanumeric character as "-">/<id>.jsonl`.
 * The drive letter's case depends on how the cwd was spelled, so match loosely.
 */
function projectDirs(configDir: string, cwd: string): string[] {
  const root = path.join(configDir, "projects");
  const wanted = cwd.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  try {
    return fs
      .readdirSync(root)
      .filter((name) => name.toLowerCase() === wanted)
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

export function listChatHistory(configDir: string, cwd: string): ChatHistoryItem[] {
  const files: { file: string; sessionId: string; mtime: number }[] = [];
  for (const dir of projectDirs(configDir, cwd)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        files.push({ file, sessionId: name.slice(0, -6), mtime: fs.statSync(file).mtimeMs });
      } catch {
        // Deleted while listing.
      }
    }
  }

  files.sort((a, b) => b.mtime - a.mtime);
  const items: ChatHistoryItem[] = [];
  for (const f of files.slice(0, MAX_ITEMS)) {
    const title = readTitle(f.file);
    if (title) {
      items.push({ sessionId: f.sessionId, title, updatedAt: f.mtime });
    }
  }
  return items;
}

/** Prefers a title Claude Code stored for the session, else the first prompt. */
function readTitle(file: string): string | undefined {
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(TITLE_SCAN_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  let firstPrompt: string | undefined;
  let storedTitle: string | undefined;
  for (const line of head.split("\n")) {
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      storedTitle = entry.customTitle;
    } else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
      storedTitle ??= entry.aiTitle;
    } else if (entry.type === "summary" && typeof entry.summary === "string") {
      storedTitle ??= entry.summary;
    } else if (!firstPrompt && isPromptEntry(entry)) {
      firstPrompt = promptText(entry.message.content);
    }
  }
  const title = (storedTitle ?? firstPrompt ?? "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 140) : undefined;
}

function readTranscript(configDir: string, cwd: string, sessionId: string): Record<string, any>[] | undefined {
  for (const dir of projectDirs(configDir, cwd)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), "utf8");
    } catch {
      continue;
    }
    return text.split("\n").map(parseLine).filter((e): e is Record<string, any> => e !== undefined);
  }
  return undefined;
}

/**
 * Turns a saved transcript into the stream events the chat view already renders,
 * so a resumed conversation shows its earlier turns. With `beforeUuid`, stops at
 * that prompt, which is what a fork from it keeps.
 */
export function loadChatTranscript(
  configDir: string,
  cwd: string,
  sessionId: string,
  beforeUuid?: string
): unknown[] {
  const events: unknown[] = [];
  for (const entry of readTranscript(configDir, cwd, sessionId) ?? []) {
    if (beforeUuid && entry.uuid === beforeUuid) {
      break;
    }
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) {
      continue;
    }
    if (entry.type === "assistant" && entry.message) {
      events.push({ type: "assistant", message: entry.message, parent_tool_use_id: null });
    } else if (entry.type === "user" && entry.message) {
      if (isPromptEntry(entry)) {
        events.push({
          type: "history_prompt",
          text: promptText(entry.message.content),
          images: promptImages(entry.message.content),
          uuid: entry.uuid,
          timestamp: entry.timestamp,
        });
      } else {
        // AskUserQuestion keeps its answers here, which the chat shows on the question card.
        const answers = entry.toolUseResult?.answers;
        events.push({
          type: "user",
          message: entry.message,
          parent_tool_use_id: null,
          ...(answers && typeof answers === "object" ? { tool_use_result: { answers } } : {}),
        });
      }
    }
  }
  return events;
}

/**
 * Finds the chain entry a prompt follows, which a fork resumes up to.
 * `null` means the prompt opened the conversation; `undefined` that it was not found.
 */
export function findPromptParent(
  configDir: string,
  cwd: string,
  sessionId: string,
  uuid: string
): string | null | undefined {
  const entry = readTranscript(configDir, cwd, sessionId)?.find((e) => e.uuid === uuid);
  if (!entry) {
    return undefined;
  }
  return typeof entry.parentUuid === "string" ? entry.parentUuid : null;
}

function parseLine(line: string): Record<string, any> | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A message the person typed, as opposed to tool results or injected command output. */
function isPromptEntry(entry: Record<string, any>): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) {
    return false;
  }
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((c) => c?.type === "tool_result")) {
    return false;
  }
  const text = promptText(content);
  if (!text) {
    return promptImages(content).length > 0;
  }
  return !/^<(command-|local-command-|system-reminder)/.test(text);
}

/** Images attached to a prompt; transcripts keep them inline as base64. */
function promptImages(content: unknown): { mediaType: string; data: string }[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((c) => c?.type === "image" && c.source?.type === "base64" && typeof c.source.data === "string")
    .map((c) => ({ mediaType: String(c.source.media_type || "image/png"), data: c.source.data as string }));
}

function promptText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
  }
  return "";
}
