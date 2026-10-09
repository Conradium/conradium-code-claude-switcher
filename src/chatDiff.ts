import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const SCHEME = "claude-switcher-diff";

export interface ToolEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Serves the read-only "before"/"after" sides of diffs opened from Claude tabs. */
export class ChatDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private next = 0;
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? "";
  }

  private virtual(fileName: string, side: string, text: string): vscode.Uri {
    // The file name stays last so the diff editor picks the right language.
    const key = `/${++this.next}/${side}/${fileName}`;
    this.docs.set(key, text);
    if (this.docs.size > 200) {
      this.docs.delete(this.docs.keys().next().value as string);
    }
    return vscode.Uri.from({ scheme: SCHEME, path: key });
  }

  /**
   * Opens a diff for an Edit/MultiEdit/Write tool call. Works both before the tool
   * ran (permission prompt: the file still has the old text) and after it (the file
   * has the new text), and falls back to just the edited snippets.
   */
  async open(filePath: string, edits: ToolEdit[] | undefined, content: string | undefined): Promise<void> {
    const name = path.basename(filePath) || "file";
    let current: string | undefined;
    try {
      current = fs.readFileSync(filePath, "utf8");
    } catch {
      current = undefined;
    }

    let before: string;
    let after: string;
    if (content !== undefined) {
      before = current !== undefined && current !== content ? current : "";
      after = content;
    } else if (edits?.length) {
      const forward = current === undefined ? undefined : applyEdits(current, edits, false);
      const backward = current === undefined ? undefined : applyEdits(current, edits, true);
      if (forward !== undefined) {
        before = current!;
        after = forward;
      } else if (backward !== undefined) {
        before = backward;
        after = current!;
      } else {
        before = edits.map((e) => e.old_string).join("\n\n");
        after = edits.map((e) => e.new_string).join("\n\n");
      }
    } else {
      return;
    }

    await vscode.commands.executeCommand(
      "vscode.diff",
      this.virtual(name, "before", before),
      this.virtual(name, "after", after),
      `${name} (Claude's change)`,
      { preview: true }
    );
  }

  dispose(): void {
    this.registration.dispose();
    this.docs.clear();
  }
}

/** Applies edits in order (or undoes them in reverse); undefined when one does not match. */
function applyEdits(text: string, edits: ToolEdit[], reverse: boolean): string | undefined {
  let result = text;
  const ordered = reverse ? [...edits].reverse() : edits;
  for (const edit of ordered) {
    const find = reverse ? edit.new_string : edit.old_string;
    const replace = reverse ? edit.old_string : edit.new_string;
    if (!find || !result.includes(find)) {
      return undefined;
    }
    result = edit.replace_all ? result.split(find).join(replace) : result.replace(find, () => replace);
  }
  return result;
}
