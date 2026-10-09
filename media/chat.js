// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const post = (type, extra) => vscode.postMessage({ type, ...extra });

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const log = $("log");
  const input = /** @type {HTMLTextAreaElement} */ ($("input"));
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const banner = $("banner");
  const popup = $("popup");
  const menu = $("menu");
  const drawer = $("drawer");
  const attachmentsEl = $("attachments");
  const welcome = $("welcome");
  const pinned = $("pinned");

  const MODES = [
    { value: "default", label: "Manual", short: "Ask before edits", description: "Claude will ask for approval before making each edit" },
    { value: "acceptEdits", label: "Edit automatically", short: "Edit automatically", description: "Claude will edit your selected text or the whole file" },
    { value: "plan", label: "Plan", short: "Plan mode", description: "Claude will explore the code and present a plan before editing" },
    { value: "auto", label: "Auto", short: "Auto", description: "Claude will approve actions that pass a safety check and pause for anything risky", needs: "auto" },
    { value: "bypassPermissions", label: "Bypass permissions", short: "Bypass permissions", description: "Claude will run every tool without asking", danger: true },
  ];
  const FALLBACK_MODELS = [
    { value: "default", displayName: "Default", description: "The model this account uses by default" },
    { value: "opus", displayName: "Opus", description: "Most capable" },
    { value: "sonnet", displayName: "Sonnet", description: "Fast and capable" },
    { value: "haiku", displayName: "Haiku", description: "Fastest" },
  ];
  const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
  const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
  /** Edit tools whose card shows a diff instead of the IN/OUT box. */
  const DIFF_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
  /** Task-list tools: withheld from Claude now, but still in conversations from before. */
  const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
  /** Asked in the question panel above the composer; logged as a "Questions" card. */
  const ASK_TOOL = "AskUserQuestion";
  const OUT_PREVIEW_LINES = 3;
  const DIFF_PREVIEW_LINES = 24;
  const WORKING_VERBS = [
    "Thinking", "Pondering", "Musing", "Noodling", "Brewing", "Cogitating", "Conjuring", "Crafting",
    "Deliberating", "Percolating", "Ruminating", "Mulling", "Tinkering", "Synthesizing", "Untangling",
    "Wrangling", "Simmering", "Marinating", "Puzzling", "Scheming", "Whittling", "Forging", "Spelunking",
    "Herding bytes", "Clauding", "Reticulating", "Finagling", "Hatching", "Sleuthing", "Calibrating",
  ];
  const VERB_INTERVAL_MS = 4000;

  const state = {
    busy: false,
    running: false,
    mode: "default",
    model: "default",
    effort: /** @type {string|null} */ (null),
    models: FALLBACK_MODELS,
    commands: /** @type {any[]} */ ([]),
    checkpoints: true,
    resolvedModel: "",
    busySince: 0,
    tokensIn: 0,
    tokensOut: 0,
    costBase: 0,
    costRun: 0,
  };

  /** Assistant messages by API message id: { el, blocks: Map<index, block>, streamed }. */
  const messages = new Map();
  /** Tool cards by tool_use id. */
  const tools = new Map();
  /** Sent prompts by client id: { el, uuid, text, rewindBtn }. */
  const prompts = new Map();
  /** Every prompt on screen, in order, for the pinned prompt bar. */
  let promptEntries = [];
  /** What VS Code restores this tab from after a restart. */
  const saved = { profileId: null, sessionId: null };
  /** The wrapper holding everything since the last prompt; its timeline runs through it. */
  let currentTurn = null;
  /** The prompt the current turn answers; tool edits mark it restorable. */
  let currentPrompt = null;
  let currentMessageId = null;
  /** @type {{name: string, mediaType: string, data: string, width?: number, height?: number}[]} */
  let attachments = [];
  let historyItems = [];

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(paths, viewBox = "0 0 16 16") {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", viewBox);
    s.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", d);
      s.appendChild(p);
    }
    return s;
  }

  const ICONS = {
    copy: ["M5.5 5.5h7v8h-7z", "M3.5 10.5v-8h7"],
    check: ["M3 8.5l3 3 7-7"],
    restore: ["M3 3v4h4", "M3.6 7A5 5 0 1 1 5 11.5"],
    rewind: ["M2.5 2.5v4h4", "M2.9 6.5A5.5 5.5 0 1 1 3.6 11"],
    diff: ["M4 2v8", "M1.5 5.5h5", "M12 6v8", "M9.5 10.5h5"],
    open: ["M9 2.5h4.5V7", "M13.5 2.5 7.5 8.5", "M11.5 9.5v4h-9v-9h4"],
    chev: ["M6 4l4 4-4 4"],
    chevDown: ["M4 6l4 4 4-4"],
    close: ["M4 4l8 8", "M12 4l-8 8"],
    mode_default: [
      "M5.5 8.5V4a1 1 0 0 1 2 0v3.5",
      "M7.5 7V3a1 1 0 0 1 2 0v4",
      "M9.5 7V4a1 1 0 0 1 2 0v3.5",
      "M11.5 7.5V6a1 1 0 0 1 2 0v3.5a5 5 0 0 1-5 5h-.6a4 4 0 0 1-3.3-1.7L2.3 9.6a1 1 0 0 1 1.6-1.2l1.6 1.8",
    ],
    mode_acceptEdits: ["M5 4.5 1.5 8 5 11.5", "M11 4.5 14.5 8 11 11.5", "M9.2 3 6.8 13"],
    mode_plan: ["M4.5 1.5h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-8z", "M2.5 4.5h4", "M2.5 8h4", "M2.5 11.5h4"],
    effort: ["M2 11.5a6 6 0 0 1 12 0", "M8 11.5 10.5 7", "M3.6 7.6l1 .6", "M8 5.5v1.2", "M12.4 7.6l-1 .6"],
    mode_auto: ["M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"],
    mode_bypassPermissions: ["M8 2 1.5 13.5h13z", "M8 6.5v3", "M8 11.5v.01"],
  };

  function iconButton(icon, label, onClick, cls = "mini") {
    const b = el("button", cls);
    b.title = label;
    b.setAttribute("aria-label", label);
    b.appendChild(svg(ICONS[icon]));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  function copyButton(getText, cls) {
    return iconButton("copy", "Copy", (b) => {
      void navigator.clipboard.writeText(getText());
      b.replaceChildren(svg(ICONS.check));
      b.classList.add("done");
      setTimeout(() => {
        b.replaceChildren(svg(ICONS.copy));
        b.classList.remove("done");
      }, 1200);
    }, cls);
  }

  /**
   * The log follows its end, also while replies, tool output and images grow after they were
   * added. Scrolling up stops that; scrolling back to the end starts it again.
   */
  let following = true;
  let lastScrollTop = 0;
  log.addEventListener(
    "scroll",
    () => {
      const top = log.scrollTop;
      if (log.scrollHeight - top - log.clientHeight < 4) following = true;
      else if (top < lastScrollTop) following = false;
      lastScrollTop = top;
    },
    { passive: true }
  );
  const followObserver = new ResizeObserver(() => {
    if (following) scrollDown();
  });
  followObserver.observe(log);

  /**
   * The composer floats over the log's end; pad the log so the last message clears it.
   * The overlays span the scrollbar too, so they learn its width (the native bar's
   * size depends on the OS) to keep their content lined up with the messages.
   */
  const composerWrap = $("composerWrap");
  new ResizeObserver(() => {
    log.parentElement.style.setProperty("--gutter", log.offsetWidth - log.clientWidth + "px");
    log.parentElement.style.setProperty("--composer-h", composerWrap.offsetHeight + "px");
    log.style.paddingBottom = composerWrap.offsetHeight + 8 + "px";
    if (following) scrollDown();
  }).observe(composerWrap);

  /**
   * Adds a node to the log. Prompts and dividers sit in the log itself and end the
   * current turn; everything else goes into the turn, so its timeline runs unbroken
   * from the first action to the last.
   */
  function append(node) {
    welcome.remove();
    const standalone = node.classList.contains("user") || node.classList.contains("divider");
    let parent = log;
    if (standalone) {
      currentTurn = null;
    } else {
      if (!currentTurn) currentTurn = addLogChild(newTurn());
      parent = currentTurn;
    }
    if (parent === log) addLogChild(node);
    else parent.appendChild(node);
    if (!standalone) scheduleTimeline(currentTurn);
    if (following) scrollDown();
    return node;
  }

  /** The working indicator, while shown, stays the last thing in the log. */
  function addLogChild(node) {
    if (working.parentElement === log) log.insertBefore(node, working);
    else log.appendChild(node);
    followObserver.observe(node);
    return node;
  }

  // ---------------------------------------------------------------- timeline

  const timelineQueue = new Set();
  const turnObserver = new ResizeObserver((entries) => {
    for (const entry of entries) scheduleTimeline(/** @type {HTMLElement} */ (entry.target));
  });

  function newTurn() {
    const turn = el("div", "turn");
    turn.appendChild(el("span", "turn-line"));
    turnObserver.observe(turn);
    return turn;
  }

  function scheduleTimeline(turn) {
    if (!turn) return;
    timelineQueue.add(turn);
    if (timelineQueue.size === 1) {
      requestAnimationFrame(() => {
        for (const t of timelineQueue) layoutTimeline(t);
        timelineQueue.clear();
      });
    }
  }

  /** Draws the turn's line from its first action's dot to its last one. */
  function layoutTimeline(turn) {
    const line = /** @type {HTMLElement} */ (turn.querySelector(":scope > .turn-line"));
    const dots = turn.querySelectorAll(".msg.assistant .dot");
    if (!line) return;
    if (dots.length < 2 || !turn.isConnected) {
      line.style.display = "none";
      return;
    }
    const base = turn.getBoundingClientRect().top;
    const first = dots[0].getBoundingClientRect();
    const last = dots[dots.length - 1].getBoundingClientRect();
    line.style.display = "";
    line.style.top = first.top + first.height / 2 - base + "px";
    line.style.height = Math.max(0, last.top - first.top) + "px";
  }

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function formatTokens(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function timeAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
  }

  // ---------------------------------------------------------------- markdown

  /** Small, safe Markdown renderer: everything is escaped before any markup is added. */
  function markdown(src) {
    const out = [];
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    let list = null;
    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) {
        closeList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        const lang = escapeHtml(fence[1] || "");
        out.push(
          `<div class="code"><div class="code-head"><span>${lang || "code"}</span></div>` +
            `<pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`
        );
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        closeList();
        out.push("<hr>");
        i++;
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        const item = (bullet || ordered)[1];
        const task = item.match(/^\[([ xX])\]\s+(.*)$/);
        out.push(
          task
            ? `<li class="task${task[1] === " " ? "" : " done"}">${inline(task[2])}</li>`
            : `<li>${inline(item)}</li>`
        );
        i++;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        closeList();
        const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = row(line);
        i += 2;
        let html = '<div class="table"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          html += "<tr>" + row(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        }
        out.push(html + "</tbody></table></div>");
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        closeList();
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
        continue;
      }
      if (/^\s*$/.test(line)) {
        closeList();
        i++;
        continue;
      }
      closeList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i])
      ) {
        para.push(lines[i++]);
      }
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    closeList();
    return out.join("");
  }

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = escapeHtml(s);
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => {
      const code = codes[Number(n)];
      const looksLikePath = /^[\w.\-/\\]+\.\w{1,8}(:\d+)?$/.test(code) && /[/\\.]/.test(code);
      return looksLikePath
        ? `<code class="path" data-path="${escapeHtml(code)}">${escapeHtml(code)}</code>`
        : `<code>${escapeHtml(code)}</code>`;
    });
  }

  /** Adds copy buttons to code blocks once a markdown block is rendered. */
  function enhance(container) {
    for (const head of container.querySelectorAll(".code-head")) {
      if (head.querySelector("button")) continue;
      const code = head.parentElement?.querySelector("code");
      head.appendChild(copyButton(() => code?.textContent || ""));
    }
  }

  log.addEventListener("click", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const pathEl = target.closest("[data-path]");
    if (pathEl) {
      const raw = pathEl.getAttribute("data-path") || "";
      const m = raw.match(/^(.*?)(?::(\d+))?$/);
      post("openFile", { path: m ? m[1] : raw, line: m && m[2] ? Number(m[2]) : undefined });
    }
  });

  // ---------------------------------------------------------------- tools

  function shortPath(p) {
    if (typeof p !== "string") return "";
    const parts = p.split(/[\\/]/);
    return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
  }

  function toolSummary(name, input) {
    input = input || {};
    switch (name) {
      case "Bash":
      case "PowerShell":
        return input.description || input.command || "";
      case "Read":
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return shortPath(input.file_path || input.notebook_path);
      case "Glob":
      case "Grep":
        return input.pattern || "";
      case "WebFetch":
        return input.url || "";
      case "WebSearch":
        return input.query || "";
      case "Task":
      case "Agent":
        return input.description || "";
      case "TodoWrite":
        return `${(input.todos || []).length} items`;
      case "TaskCreate":
        return input.subject || "";
      case "TaskUpdate":
        return [input.taskId ? `#${input.taskId}` : "", input.status || input.subject || ""].filter(Boolean).join(" → ");
      case "TaskGet":
        return input.taskId ? `#${input.taskId}` : "";
      case "Skill":
        return input.skill || input.command || "";
      default:
        return "";
    }
  }

  function toolGlyph(name) {
    if (name === "Bash" || name === "PowerShell") return "›_";
    if (name === "Read") return "R";
    if (EDIT_TOOLS.has(name)) return "±";
    if (name === "Glob" || name === "Grep") return "⌕";
    if (name === "WebFetch" || name === "WebSearch") return "◎";
    if (name === "Task" || name === "Agent") return "◇";
    if (TASK_TOOLS.has(name)) return "☑";
    if (name.startsWith("mcp__")) return "⧉";
    return "•";
  }

  const TOOL_LABELS = { TaskCreate: "Add task", TaskUpdate: "Update task", TaskList: "List tasks", TaskGet: "Read task", TodoWrite: "Tasks" };

  function toolLabel(name) {
    const mcp = name.match(/^mcp__(.+?)__(.+)$/);
    return mcp ? `${mcp[2]} · ${mcp[1].replace(/_/g, " ")}` : TOOL_LABELS[name] || name;
  }

  /** What the IN row of a tool card shows. */
  function toolInputText(name, input) {
    input = input || {};
    const where = (s) => (input.path ? `${s}  in ${input.path}` : s);
    switch (name) {
      case "Bash":
      case "PowerShell":
        return input.command || "";
      case "Read": {
        const file = input.file_path || "";
        if (typeof input.offset !== "number" && typeof input.limit !== "number") return file;
        const from = input.offset || 1;
        return `${file}  (lines ${from}${typeof input.limit === "number" ? `–${from + input.limit - 1}` : "+"})`;
      }
      case "Grep":
        return where(input.pattern || "") + (input.glob ? `  (${input.glob})` : "");
      case "Glob":
        return where(input.pattern || "");
      case "WebFetch":
        return input.url || "";
      case "WebSearch":
        return input.query || "";
      case "Task":
      case "Agent":
        return input.prompt || input.description || "";
      case "ExitPlanMode":
        return input.plan || "";
      default:
        return Object.keys(input).length ? JSON.stringify(input) : "";
    }
  }

  /** Detailed view of a tool's input, shared by tool cards and permission prompts. */
  function toolDetail(name, input) {
    input = input || {};
    const box = el("div", "tool-detail");
    const file = input.file_path || input.notebook_path;
    if ((name === "Bash" || name === "PowerShell") && input.command) {
      const pre = el("pre", "cmd");
      pre.appendChild(el("span", "prompt-sign", name === "PowerShell" ? "PS> " : "$ "));
      pre.appendChild(document.createTextNode(input.command));
      box.appendChild(pre);
    } else if ((name === "Edit" || name === "MultiEdit" || name === "Write") && file) {
      const edits =
        name === "Edit" && typeof input.old_string === "string"
          ? [{ old_string: input.old_string, new_string: input.new_string || "", replace_all: input.replace_all }]
          : name === "MultiEdit" && Array.isArray(input.edits)
            ? input.edits
            : undefined;
      const content = name === "Write" && typeof input.content === "string" ? input.content : undefined;
      box.appendChild(diffView(file, edits, content));
    } else if (name === "ExitPlanMode" && typeof input.plan === "string") {
      const md = el("div", "md plan");
      md.innerHTML = markdown(input.plan);
      enhance(md);
      box.appendChild(md);
    } else if (Object.keys(input).length) {
      box.appendChild(el("pre", "json", JSON.stringify(input, null, 2)));
    }
    return box;
  }

  /** Inline diff of an Edit/MultiEdit/Write, with a button for VS Code's diff editor. */
  function diffView(file, edits, content) {
    const wrap = el("div", "diff");
    const head = el("div", "diff-head");
    const fileLink = el("button", "diff-file", shortPath(file));
    fileLink.title = `Open ${file}`;
    fileLink.addEventListener("click", () => post("openFile", { path: file }));
    head.appendChild(fileLink);

    const rows = [];
    let added = 0;
    let removed = 0;
    if (content !== undefined) {
      for (const l of content.split("\n")) rows.push(["add", l]);
      added = rows.length;
    } else {
      (edits || []).forEach((e, idx) => {
        if (idx > 0) rows.push(["sep", "⋯"]);
        for (const [kind, text] of lineDiff(e.old_string || "", e.new_string || "")) {
          rows.push([kind, text]);
          if (kind === "add") added++;
          if (kind === "del") removed++;
        }
      });
    }
    const counts = el("span", "diff-counts");
    if (added) counts.appendChild(el("span", "plus", `+${added}`));
    if (removed) counts.appendChild(el("span", "minus", `−${removed}`));
    head.appendChild(counts);
    const openDiff = el("button", "link", "Open diff");
    openDiff.addEventListener("click", () => post("openDiff", { path: file, edits, content }));
    head.appendChild(openDiff);
    wrap.appendChild(head);

    const pre = el("pre", "diff-body");
    const renderRows = (limit) => {
      pre.replaceChildren();
      for (const [kind, text] of rows.slice(0, limit)) {
        const line = el("div", "dl " + kind);
        line.appendChild(el("span", "sign", kind === "add" ? "+" : kind === "del" ? "−" : " "));
        line.appendChild(el("span", "", text));
        pre.appendChild(line);
      }
    };
    renderRows(DIFF_PREVIEW_LINES);
    wrap.appendChild(pre);
    if (rows.length > DIFF_PREVIEW_LINES) {
      const more = el("button", "diff-more", `Show all ${rows.length} lines`);
      more.addEventListener("click", () => {
        renderRows(rows.length);
        more.remove();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  /** Line diff via longest common subsequence; falls back to remove-all/add-all for huge inputs. */
  function lineDiff(a, b) {
    const x = a.split("\n");
    const y = b.split("\n");
    if (x.length * y.length > 250_000) {
      return [...x.map((l) => ["del", l]), ...y.map((l) => ["add", l])];
    }
    const n = x.length;
    const m = y.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push(["ctx", x[i]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push(["del", x[i++]]);
      } else {
        out.push(["add", y[j++]]);
      }
    }
    while (i < n) out.push(["del", x[i++]]);
    while (j < m) out.push(["add", y[j++]]);
    return out;
  }

  function resultText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : ""))
        .join("\n");
    }
    return content == null ? "" : JSON.stringify(content, null, 2);
  }

  // ---------------------------------------------------------------- rendering

  function addUser(text, opts = {}) {
    const node = el("div", "msg user");
    const bubble = el("div", "bubble");
    if (opts.images?.length) {
      const strip = el("div", "bubble-images");
      for (const img of opts.images) {
        const im = /** @type {HTMLImageElement} */ (el("img"));
        im.src = `data:${img.mediaType};base64,${img.data}`;
        im.alt = img.name || "image";
        im.title = "View image";
        im.addEventListener("click", () => openLightbox(im.src, im.alt));
        strip.appendChild(im);
      }
      bubble.appendChild(strip);
    }
    if (text) bubble.appendChild(el("div", "bubble-text", text));
    node.appendChild(bubble);

    const actions = el("div", "msg-actions");
    const at = opts.time ? new Date(opts.time) : new Date();
    if (!isNaN(at.getTime())) {
      const time = el("span", "msg-time", at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      time.title = at.toLocaleString();
      actions.appendChild(time);
    }
    actions.appendChild(copyButton(() => text));
    const entry = { el: node, bubble, uuid: opts.uuid || null, text, images: opts.images || [], rewindBtn: null };
    const rewind = iconButton("rewind", "Fork or rewind from here", (b) => openRewindMenu(b, entry), "mini rewind");
    rewind.setAttribute("aria-haspopup", "menu");
    entry.rewindBtn = rewind;
    actions.appendChild(rewind);
    node.appendChild(actions);
    refreshRewind(entry);

    append(node);
    promptEntries.push(entry);
    scrollDown();
    return entry;
  }

  // ---------------------------------------------------------------- pinned prompt

  let pinnedEntry = null;
  let pinnedQueued = false;

  /**
   * Keeps the prompt of the turn at the top of the view pinned above the log once
   * its bubble has scrolled out of sight.
   */
  function updatePinned() {
    pinnedQueued = false;
    const top = log.scrollTop;
    let active = null;
    for (const entry of promptEntries) {
      if (entry.el.offsetTop <= top + 4) active = entry;
      else break;
    }
    const hidden = active && active.el.offsetTop + active.bubble.offsetTop + active.bubble.offsetHeight <= top + 4;
    const next = hidden ? active : null;
    if (next !== pinnedEntry) {
      pinnedEntry = next;
      renderPinned();
    }
  }

  function schedulePinned() {
    if (!pinnedQueued) {
      pinnedQueued = true;
      requestAnimationFrame(updatePinned);
    }
  }

  function renderPinned() {
    pinned.replaceChildren();
    pinned.classList.toggle("hidden", !pinnedEntry);
    if (!pinnedEntry) return;
    const inner = el("span", "pinned-inner");
    const images = pinnedEntry.images || [];
    if (images.length) {
      const strip = el("span", "pinned-images");
      for (const img of images.slice(0, 4)) {
        const im = /** @type {HTMLImageElement} */ (el("img"));
        im.src = `data:${img.mediaType};base64,${img.data}`;
        im.alt = img.name || "image";
        strip.appendChild(im);
      }
      if (images.length > 4) strip.appendChild(el("span", "pinned-more", `+${images.length - 4}`));
      inner.appendChild(strip);
    }
    const text = pinnedEntry.text || (images.length ? `${images.length} image${images.length === 1 ? "" : "s"}` : "");
    inner.appendChild(el("span", "pinned-text", text));
    pinned.title = "Scroll to this prompt";
    pinned.appendChild(inner);
  }

  pinned.addEventListener("click", () => {
    pinnedEntry?.el.scrollIntoView({ block: "start", behavior: "smooth" });
  });
  log.addEventListener("scroll", schedulePinned, { passive: true });
  window.addEventListener("resize", schedulePinned);

  /** Fork and rewind need the uuid Claude Code stores the prompt under. */
  function refreshRewind(entry) {
    entry?.rewindBtn?.classList.toggle("hidden", !entry.uuid);
  }

  function openRewindMenu(anchor, entry) {
    if (!entry.uuid) return;
    const blocked = state.busy ? "Stop Claude first" : "";
    const noCode = blocked || (state.checkpoints ? "" : "Checkpoints are off in settings");
    openMenu(
      anchor,
      null,
      [
        { value: "fork", label: "Fork conversation into a new tab" },
        { value: "rewind", label: "Rewind code to here", disabled: !!noCode, title: noCode },
        { value: "both", label: "Fork into a new tab and rewind code", disabled: !!noCode, title: noCode },
      ],
      (value) => {
        if (value === "rewind") post("restoreCheckpoint", { uuid: entry.uuid });
        else post("fork", { uuid: entry.uuid, rewind: value === "both", text: entry.text });
      },
      { below: true, alignRight: true, role: "menuitem" }
    );
  }

  function getMessage(id) {
    let m = messages.get(id);
    if (!m) {
      const node = el("div", "msg assistant");
      m = { el: node, blocks: new Map(), streamed: false };
      messages.set(id, m);
      append(node);
    }
    return m;
  }

  let renderQueued = new Set();
  function scheduleRender(block) {
    renderQueued.add(block);
    if (renderQueued.size === 1) {
      requestAnimationFrame(() => {
        for (const b of renderQueued) renderBlock(b);
        renderQueued = new Set();
        if (following) scrollDown();
      });
    }
  }

  /** Rough token count of streamed text (~4 characters per token). */
  function estimateTokens(text) {
    return text ? Math.max(1, Math.round(text.length / 4)) : 0;
  }

  function renderBlock(block) {
    if (block.type === "text") {
      block.body.innerHTML = markdown(block.text);
      enhance(block.body);
    } else if (block.type === "thinking") {
      // The thinking itself is never shown, only how long it took and roughly how big it was.
      // Omitted or redacted thinking arrives empty and is sized from the output tokens.
      const empty = !block.text.trim();
      block.el.classList.toggle("live", !block.done);
      const tokens = empty ? block.tokens : estimateTokens(block.text);
      const count = tokens ? `~${formatTokens(tokens)} tokens` : "";
      if (!block.done) {
        block.label.textContent = count ? `Thinking… ${count}` : "Thinking…";
      } else {
        const secs = block.startedAt ? Math.max(1, Math.round((block.done - block.startedAt) / 1000)) : 0;
        const head = secs ? `Thought for ${secs}s` : "Thought";
        block.label.textContent = count ? `${head} · ${count}` : head;
      }
    }
  }

  function startBlock(m, index, content) {
    let block;
    if (content.type === "text") {
      const wrap = el("div", "text-block");
      wrap.appendChild(el("span", "dot"));
      const body = el("div", "md");
      wrap.appendChild(body);
      block = { type: "text", text: content.text || "", el: wrap, body };
      const actions = el("div", "msg-actions");
      actions.appendChild(copyButton(() => block.text));
      wrap.appendChild(actions);
      m.el.appendChild(wrap);
    } else if (content.type === "thinking") {
      const row = el("div", "thinking");
      // The dot puts the thinking step on the turn's timeline.
      row.appendChild(el("span", "dot"));
      const label = el("span", "thinking-label");
      row.appendChild(label);
      // Streamed blocks time themselves until content_block_stop; saved ones are done.
      const live = typeof index === "number";
      block = {
        type: "thinking",
        text: content.thinking || "",
        el: row,
        label,
        startedAt: live ? Date.now() : 0,
        done: live ? 0 : 1,
        /** Tokens of hidden thinking, worked out from the message's output_tokens. */
        tokens: 0,
      };
      m.el.appendChild(row);
    } else if (content.type === "tool_use") {
      block = { type: "tool_use", json: "", el: toolCard(m.el, content.id, content.name, content.input) };
    } else {
      return;
    }
    m.blocks.set(index, block);
    scheduleRender(block);
  }

  /**
   * Omitted thinking streams no text, so its size is the message's output tokens minus
   * what the visible text and tool inputs account for. Only done when a single thinking
   * block is hidden; otherwise the label keeps just the time.
   */
  function estimateHiddenThinking(m, outputTokens) {
    const blocks = [...m.blocks.values()];
    const hidden = blocks.filter((b) => b.type === "thinking" && !b.text.trim());
    if (hidden.length !== 1) return;
    let visible = 0;
    for (const b of blocks) {
      if (b.type === "text" || b.type === "thinking") visible += estimateTokens(b.text);
      else if (b.type === "tool_use") visible += estimateTokens(b.json);
    }
    const rest = outputTokens - visible;
    if (rest > 0) {
      hidden[0].tokens = rest;
      scheduleRender(hidden[0]);
    }
  }

  function toolCard(parent, id, name, toolInput) {
    let card = tools.get(id);
    if (card) {
      updateToolCard(card, toolInput);
      return card.el;
    }
    if (name === ASK_TOOL) return askCard(parent, id, toolInput).el;
    const node = el("div", "tool running");
    const head = el("div", "tool-head");
    const dot = el("span", "dot");
    dot.title = "Running";
    head.appendChild(dot);
    head.appendChild(el("span", "tool-glyph", toolGlyph(name)));
    head.appendChild(el("span", "tool-name", toolLabel(name)));
    const sum = el("span", "tool-sum");
    head.appendChild(sum);
    node.appendChild(head);
    const body = el("div", "tool-body");
    node.appendChild(body);
    parent.appendChild(node);
    card = { el: node, name, sum, body, dot, input: null, done: false, io: null };
    tools.set(id, card);
    updateToolCard(card, toolInput);
    return node;
  }

  function updateToolCard(card, toolInput) {
    if (!toolInput || !Object.keys(toolInput).length) return;
    card.input = toolInput;
    if (card.ask) {
      renderAskCard(card);
      return;
    }
    card.sum.textContent = toolSummary(card.name, toolInput);
    const file = toolInput.file_path || toolInput.notebook_path;
    if (file) {
      card.sum.classList.add("clickable");
      card.sum.setAttribute("data-path", file);
    }
    if (DIFF_TOOLS.has(card.name) && file) {
      card.body.querySelector(".tool-detail")?.remove();
      card.body.prepend(toolDetail(card.name, toolInput));
      return;
    }
    const io = ensureIo(card);
    const text = toolInputText(card.name, toolInput);
    io.in.content.textContent = text;
    io.in.row.classList.toggle("hidden", !text);
    if (!card.done) setOut(card, "Running…", "pending");
  }

  /**
   * The IN/OUT box of a tool card. Collapsed it shows one line of input and the first
   * lines of output; a click (or Enter/Space) expands both together.
   */
  function ensureIo(card) {
    if (card.io) return card.io;
    const box = el("div", "io");
    box.tabIndex = 0;
    box.setAttribute("role", "button");
    box.setAttribute("aria-expanded", "false");
    const row = (label, cls) => {
      const r = el("div", "io-row " + cls);
      r.appendChild(el("span", "io-label", label));
      const content = el("pre", "io-content");
      r.appendChild(content);
      box.appendChild(r);
      return { row: r, content };
    };
    const io = { el: box, in: row("IN", "in"), out: row("OUT", "out") };
    io.out.row.classList.add("hidden");
    const toggle = () => {
      const open = box.classList.toggle("expanded");
      box.setAttribute("aria-expanded", String(open));
    };
    box.addEventListener("click", (e) => {
      // Selecting text to copy it should not collapse the box.
      if (window.getSelection()?.toString()) return;
      if (/** @type {HTMLElement} */ (e.target).closest("a, button")) return;
      toggle();
    });
    box.addEventListener("keydown", (e) => {
      if (e.target === box && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        toggle();
      }
    });
    card.body.prepend(box);
    card.io = io;
    return io;
  }

  /** Fills the OUT row: "pending" (muted, e.g. Running…), "ok" or "err". */
  function setOut(card, text, kind) {
    const { row, content } = ensureIo(card).out;
    row.classList.remove("hidden");
    row.classList.toggle("pending", kind === "pending");
    row.classList.toggle("err", kind === "err");
    content.textContent = text;
    row.classList.toggle("more", text.split("\n").length > OUT_PREVIEW_LINES);
  }

  function onStreamEvent(ev, parentToolId) {
    if (parentToolId) return; // subagent internals stay inside the Task card
    switch (ev.type) {
      case "message_start": {
        const m = getMessage(ev.message.id);
        m.streamed = true;
        currentMessageId = ev.message.id;
        break;
      }
      case "content_block_start": {
        const m = messages.get(currentMessageId);
        if (m) startBlock(m, ev.index, ev.content_block);
        break;
      }
      case "content_block_delta": {
        const m = messages.get(currentMessageId);
        const block = m && m.blocks.get(ev.index);
        if (!block) break;
        if (ev.delta.type === "text_delta") block.text += ev.delta.text;
        else if (ev.delta.type === "thinking_delta") block.text += ev.delta.thinking;
        else if (ev.delta.type === "input_json_delta" && block.type === "tool_use") {
          // Only counted, for the hidden-thinking estimate; the card renders the final input.
          block.json += ev.delta.partial_json || "";
          break;
        } else break;
        scheduleRender(block);
        break;
      }
      case "content_block_stop": {
        const block = messages.get(currentMessageId)?.blocks.get(ev.index);
        if (block?.type === "thinking" && !block.done) {
          block.done = Date.now();
          scheduleRender(block);
        }
        break;
      }
      case "message_delta": {
        const m = messages.get(currentMessageId);
        const out = ev.usage?.output_tokens;
        if (m && typeof out === "number") estimateHiddenThinking(m, out);
        break;
      }
    }
  }

  function onAssistant(ev) {
    const msg = ev.message;
    if (ev.parent_tool_use_id) return;
    const m = getMessage(msg.id);
    for (const content of msg.content || []) {
      if (content.type === "tool_use") {
        toolCard(m.el, content.id, content.name, content.input);
      } else if (!m.streamed) {
        startBlock(m, `${content.type}:${m.blocks.size}`, content);
      }
    }
    if (msg.content?.some((c) => c.type === "text" && /API Error|rate limit/i.test(c.text || "")) && !m.streamed) {
      m.el.classList.add("error");
    }
  }

  function onUser(ev) {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const card = tools.get(c.tool_use_id);
      if (!card) continue;
      if (card.ask) {
        finishAskCard(card, c, ev.tool_use_result);
        continue;
      }
      card.el.classList.remove("running");
      card.el.classList.toggle("failed", !!c.is_error);
      card.done = true;
      card.dot.title = c.is_error ? "Failed" : "Done";
      const text = resultText(c.content).trim();
      const shown = text.length > 8000 ? text.slice(0, 8000) + "\n… (truncated)" : text;
      card.body.querySelector(".tool-result")?.remove();
      if (card.io) {
        setOut(card, shown || "(no output)", c.is_error ? "err" : shown ? "ok" : "pending");
      } else if (c.is_error && shown) {
        // Edit and Write keep their diff; only a failure adds the error under it.
        card.body.appendChild(el("pre", "tool-result err", shown));
      }
    }
  }

  /** Tools still running when a turn ends were stopped before they finished. */
  function settleTools() {
    for (const card of tools.values()) {
      if (card.ask) {
        if (!card.done && card.ask.status === "pending") setAskStatus(card, "stopped");
        continue;
      }
      if (!card.done && card.el.classList.contains("running")) {
        card.el.classList.remove("running");
        card.el.classList.add("stopped");
        card.dot.title = "Stopped before it finished";
        if (card.io) setOut(card, "Stopped before it finished", "pending");
      }
    }
  }

  function onResult(ev) {
    dropAsk();
    settleTools();
    const failed = ev.is_error || (ev.subtype && ev.subtype !== "success");
    // A turn you stopped ends as a failure carrying only a CLI diagnostic.
    if (interrupted && failed) notice("Interrupted", "interrupted");
    else if (failed) {
      const errors = Array.isArray(ev.errors) ? ev.errors.join("\n") : "";
      notice(errors || ev.result || `Turn ended: ${ev.subtype}`, "error");
    }
    const usage = ev.usage || {};
    state.tokensIn += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    state.tokensOut += usage.output_tokens || 0;
    if (typeof ev.total_cost_usd === "number") state.costRun = ev.total_cost_usd;
    renderStats();

    const secs = typeof ev.duration_ms === "number" ? (ev.duration_ms / 1000).toFixed(1) + "s" : "";
    const turns = ev.num_turns ? `${ev.num_turns} step${ev.num_turns === 1 ? "" : "s"}` : "";
    const meta = [secs, turns].filter(Boolean).join(" · ");
    if (meta) append(el("div", "turn-meta", meta));
  }

  function notice(text, kind = "info") {
    append(el("div", "notice " + kind, text));
  }

  // ---------------------------------------------------------------- permissions

  function permissionCard(p) {
    if (p.toolName === ASK_TOOL) return openAsk(p);
    const card = el("div", "permission");
    const title = el("div", "perm-title");
    const plan = p.toolName === "ExitPlanMode";
    title.appendChild(el("span", "perm-badge", plan ? "Plan" : "Permission"));
    title.appendChild(el("strong", "", plan ? "Claude is ready to code. Approve this plan?" : `Allow ${toolLabel(p.toolName)}?`));
    const sum = toolSummary(p.toolName, p.input) || p.description || "";
    if (sum && !plan) title.appendChild(el("span", "muted", sum));
    card.appendChild(title);
    card.appendChild(toolDetail(p.toolName, p.input));

    const actions = el("div", "perm-actions");
    const answer = (behavior) => {
      post("permission", { requestId: p.requestId, behavior });
      card.classList.add("answered");
      actions.replaceChildren(
        el("span", "muted", behavior === "deny" ? (plan ? "Kept planning" : "Denied") : behavior === "allowAlways" ? "Always allowed" : plan ? "Plan approved" : "Allowed")
      );
    };
    const yes = el("button", "btn primary", plan ? "Approve plan" : "Allow");
    yes.addEventListener("click", () => answer("allow"));
    actions.appendChild(yes);
    if (p.canAlwaysAllow) {
      const always = el("button", "btn", plan ? "Approve and auto-accept edits" : "Always allow");
      always.title = plan ? "" : "Allow this from now on (saved to the project's permission rules)";
      always.addEventListener("click", () => answer("allowAlways"));
      actions.appendChild(always);
    }
    const no = el("button", "btn ghost", plan ? "Keep planning" : "Deny");
    no.addEventListener("click", () => answer("deny"));
    actions.appendChild(no);
    card.appendChild(actions);
    append(card);
    scrollDown();
    yes.focus();
  }

  // ---------------------------------------------------------------- questions

  const askEl = $("ask");
  const composerEl = $("composer");
  /** The question panel while Claude waits on an answer; it takes the composer's place. */
  let ask = null;
  /** Question requests that arrive while one is open. */
  const askQueue = [];
  /** Set when you stop the turn: it then ends with "Interrupted" instead of an error notice. */
  let interrupted = false;
  const ASK_STATUS = { pending: "Waiting for your answer", answered: "Answered", declined: "Declined", stopped: "Not answered" };

  function askQuestions(input) {
    return Array.isArray(input?.questions) ? input.questions : [];
  }

  /**
   * The "Questions" step on the timeline. It shows each question with what was picked
   * once answered, and collapses from its header.
   */
  function askCard(parent, id, toolInput) {
    const node = el("div", "tool ask-card running");
    const head = el("button", "ask-card-head");
    const dot = el("span", "dot");
    head.appendChild(dot);
    head.appendChild(el("span", "ask-card-title", "Questions"));
    const sub = el("span", "ask-card-sub");
    head.appendChild(sub);
    node.appendChild(head);
    const body = el("div", "ask-card-body");
    node.appendChild(body);
    const note = el("div", "ask-card-note hidden");
    node.appendChild(note);
    parent.appendChild(node);
    const card = {
      el: node,
      name: ASK_TOOL,
      dot,
      input: null,
      done: false,
      io: null,
      ask: { head, sub, body, note, status: "pending", answers: null, open: false },
    };
    head.addEventListener("click", () => {
      card.ask.open = !card.ask.open;
      renderAskCard(card);
    });
    tools.set(id, card);
    updateToolCard(card, toolInput);
    renderAskCard(card);
    return card;
  }

  function renderAskCard(card) {
    const a = card.ask;
    const questions = askQuestions(card.input);
    const label = ASK_STATUS[a.status];
    const count = questions.length ? `${questions.length} question${questions.length === 1 ? "" : "s"}` : "";
    a.sub.replaceChildren(el("span", "", [label, count].filter(Boolean).join(" · ")));
    const chev = svg(ICONS.chevDown);
    chev.classList.add("ask-card-chev");
    a.sub.appendChild(chev);
    a.head.setAttribute("aria-expanded", String(a.open));
    a.head.title = a.open ? "Hide the questions" : "Show the questions";
    card.el.classList.toggle("open", a.open);
    card.el.classList.toggle("running", a.status === "pending");
    card.el.classList.toggle("failed", a.status === "declined");
    card.el.classList.toggle("stopped", a.status === "stopped");
    card.dot.title = label;
    a.note.classList.toggle("hidden", a.status !== "declined" || !a.note.textContent);
    a.body.classList.toggle("hidden", !a.open || !questions.length);
    a.body.classList.toggle("settled", a.status === "answered");
    a.body.replaceChildren();
    if (!a.open) return;
    for (const q of questions) {
      const block = el("div", "ask-card-q");
      block.appendChild(el("div", "ask-card-question", q.question || ""));
      const { chosen, other } = splitAnswer(q, a.answers?.[q.question]);
      const list = el("div", "ask-card-opts");
      const row = (text, desc, on) => {
        const r = el("div", "ask-card-opt" + (on ? " chosen" : ""));
        r.appendChild(el("span", "ask-mark" + (q.multiSelect ? " check" : "") + (on ? " on" : "")));
        const t = el("span", "ask-opt-text");
        t.appendChild(el("span", "ask-opt-label", text));
        if (desc) t.appendChild(el("span", "ask-opt-desc", desc));
        r.appendChild(t);
        list.appendChild(r);
      };
      (q.options || []).forEach((o, i) => row(o.label, o.description, chosen.has(i)));
      if (other) row("Other", other, true);
      block.appendChild(list);
      a.body.appendChild(block);
    }
  }

  function setAskStatus(card, status) {
    card.ask.status = status;
    renderAskCard(card);
  }

  /** The tool result: the answers (live, or from a saved conversation) or a refusal. */
  function finishAskCard(card, c, toolUseResult) {
    card.done = true;
    const text = resultText(c.content).trim();
    if (c.is_error) {
      card.ask.note.textContent = !text || /doesn't want to proceed|rejected|interrupt/i.test(text) ? "Tool interrupted" : text.split("\n")[0];
      setAskStatus(card, "declined");
      return;
    }
    const stored = toolUseResult && typeof toolUseResult.answers === "object" ? toolUseResult.answers : null;
    card.ask.answers = card.ask.answers || stored || parseAnswers(text, askQuestions(card.input));
    setAskStatus(card, "answered");
  }

  /** Which options an answer picked, and the free text it adds ("Other"). */
  function splitAnswer(q, value) {
    const chosen = new Set();
    if (typeof value !== "string" || !value) return { chosen, other: "" };
    const labels = (q.options || []).map((o) => String(o.label ?? ""));
    if (!q.multiSelect) {
      const i = labels.indexOf(value);
      if (i >= 0) chosen.add(i);
      return { chosen, other: i >= 0 ? "" : value };
    }
    // Multi-select answers are the picked labels joined by ", ", with free text last.
    const longestFirst = labels.map((l, i) => /** @type {[string, number]} */ ([l, i])).sort((x, y) => y[0].length - x[0].length);
    let pos = 0;
    while (pos < value.length) {
      const hit = longestFirst.find(
        ([l]) => l && value.startsWith(l, pos) && (pos + l.length === value.length || value.startsWith(", ", pos + l.length))
      );
      if (!hit) break;
      chosen.add(hit[1]);
      pos += hit[0].length + 2;
    }
    return { chosen, other: value.slice(pos).trim() };
  }

  /** Reads `"question"="answer", …` from a result text, for transcripts without stored answers. */
  function parseAnswers(text, questions) {
    const out = {};
    let pos = 0;
    questions.forEach((q, i) => {
      const key = `"${q.question}"="`;
      const at = text.indexOf(key, pos);
      if (at < 0) return;
      const start = at + key.length;
      const next = questions[i + 1];
      let end = next ? text.indexOf(`", "${next.question}"="`, start) : -1;
      if (end < 0) end = text.lastIndexOf('"');
      if (end < start) return;
      out[q.question] = text.slice(start, end);
      pos = end;
    });
    return out;
  }

  /** Finds the timeline card a question request belongs to, or adds one (subagents have none). */
  function askCardFor(p) {
    let card = p.toolUseId ? tools.get(p.toolUseId) : undefined;
    if (!card?.ask) card = [...tools.values()].reverse().find((c) => c.ask && !c.done && c.ask.status === "pending");
    if (!card) {
      const id = p.toolUseId || `ask:${p.requestId}`;
      card = askCard(getMessage(id).el, id, p.input);
    }
    if (!card.input) updateToolCard(card, p.input);
    return card;
  }

  function openAsk(p) {
    if (ask) {
      askQueue.push(p);
      return;
    }
    const questions = askQuestions(p.input);
    ask = {
      p,
      card: askCardFor(p),
      questions,
      tab: 0,
      picks: questions.map(() => ({ chosen: new Set(), other: false, otherText: "" })),
      /** The focused option per question; "Other" is the last one. */
      cursor: questions.map(() => 0),
      collapsed: false,
    };
    closeMenu();
    hidePopup();
    composerEl.classList.add("hidden");
    askEl.classList.remove("hidden");
    renderWorking();
    renderAsk("option");
    scrollDown();
  }

  /** The answer to question i as Claude Code expects it: labels joined by ", ", free text last. */
  function askValue(i) {
    const q = ask.questions[i];
    const pick = ask.picks[i];
    const parts = (q.options || []).filter((_, j) => pick.chosen.has(j)).map((o) => o.label);
    const other = pick.other ? pick.otherText.trim() : "";
    if (other) parts.push(other);
    return parts.join(", ");
  }

  function askReady() {
    return ask.questions.every((_, i) => askValue(i));
  }

  function askHasPreview(q) {
    return !q.multiSelect && (q.options || []).some((o) => typeof o.preview === "string" && o.preview);
  }

  /** Draws the panel for the current question; `focus` is "option", "other" or "submit". */
  function renderAsk(focus) {
    if (!ask) return;
    const { questions, tab } = ask;
    const q = questions[tab] || { question: "", options: [] };
    const pick = ask.picks[tab] || { chosen: new Set(), other: false, otherText: "" };
    askEl.replaceChildren();
    askEl.classList.toggle("collapsed", ask.collapsed);

    const head = el("div", "ask-head");
    const tabs = el("div", "ask-tabs");
    tabs.setAttribute("role", "tablist");
    questions.forEach((item, i) => {
      const t = el("button", "ask-tab" + (i === tab ? " active" : ""), item.header || `Question ${i + 1}`);
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(i === tab));
      t.tabIndex = i === tab ? 0 : -1;
      t.title = item.question || "";
      t.addEventListener("click", () => {
        ask.tab = i;
        ask.collapsed = false;
        renderAsk("option");
      });
      tabs.appendChild(t);
    });
    head.appendChild(tabs);
    const actions = el("div", "ask-tools");
    const collapse = iconButton("chevDown", ask.collapsed ? "Show the questions" : "Hide the questions", () => {
      ask.collapsed = !ask.collapsed;
      renderAsk(ask.collapsed ? "" : "option");
      if (ask?.collapsed) /** @type {HTMLElement} */ (askEl.querySelector(".ask-collapse"))?.focus();
    }, "mini ask-collapse");
    collapse.setAttribute("aria-expanded", String(!ask.collapsed));
    actions.append(collapse, iconButton("close", "Cancel (Esc)", cancelAsk));
    head.appendChild(actions);
    askEl.appendChild(head);
    if (ask.collapsed) {
      refreshAsk();
      return;
    }

    const body = el("div", "ask-body");
    body.appendChild(el("div", "ask-question", q.question || ""));
    const previews = askHasPreview(q);
    const main = el("div", "ask-main" + (previews ? " with-preview" : ""));
    const list = el("div", "ask-opts");
    list.setAttribute("role", q.multiSelect ? "group" : "radiogroup");
    list.setAttribute("aria-label", q.question || "");
    const options = [...(q.options || []), { label: "Other", other: true }];
    /** @type {HTMLElement[]} */
    const rows = [];
    let field = null;
    options.forEach((o, i) => {
      const on = o.other ? pick.other : pick.chosen.has(i);
      const row = el("div", "ask-opt" + (on ? " on" : "") + (o.other ? " other" : ""));
      row.setAttribute("role", q.multiSelect ? "checkbox" : "radio");
      row.setAttribute("aria-checked", String(on));
      row.tabIndex = i === ask.cursor[tab] ? 0 : -1;
      row.appendChild(el("span", "ask-mark" + (q.multiSelect ? " check" : "") + (on ? " on" : "")));
      const text = el("span", "ask-opt-text");
      text.appendChild(el("span", "ask-opt-label", o.label));
      if (o.description) text.appendChild(el("span", "ask-opt-desc", o.description));
      row.appendChild(text);
      if (o.other && on) {
        field = /** @type {HTMLInputElement} */ (el("input", "field ask-other"));
        field.type = "text";
        field.placeholder = "Type your answer";
        field.value = pick.otherText;
        field.setAttribute("aria-label", "Your answer");
        field.addEventListener("input", () => {
          pick.otherText = /** @type {HTMLInputElement} */ (field).value;
          refreshAsk();
        });
        field.addEventListener("click", (e) => e.stopPropagation());
        text.appendChild(field);
      }
      row.addEventListener("click", () => pickAsk(i, true));
      row.addEventListener("mouseenter", () => showAskPreview(i));
      row.addEventListener("focus", () => {
        ask.cursor[tab] = i;
        rows.forEach((r, j) => (r.tabIndex = j === i ? 0 : -1));
        showAskPreview(i);
      });
      list.appendChild(row);
      rows.push(row);
    });
    list.addEventListener("mouseleave", () => showAskPreview(ask.cursor[ask.tab]));
    main.appendChild(list);
    if (previews) main.appendChild(el("div", "ask-preview"));
    body.appendChild(main);
    const submit = el("button", "btn primary ask-submit", "Submit answers");
    submit.addEventListener("click", submitAsk);
    body.appendChild(submit);
    const foot = el("div", "ask-foot");
    foot.innerHTML = "<kbd>Esc</kbd> to cancel · <kbd>↑</kbd><kbd>↓</kbd> to choose" + (questions.length > 1 ? " · <kbd>←</kbd><kbd>→</kbd> for other questions" : "");
    body.appendChild(foot);
    askEl.appendChild(body);
    refreshAsk();
    showAskPreview(ask.cursor[tab]);
    if (focus === "other" && field) field.focus();
    else if (focus === "submit" && !submit.hasAttribute("disabled")) submit.focus();
    else if (focus) rows[ask.cursor[tab]]?.focus();
  }

  /** Updates what typing changes without redrawing: answered tabs and the Submit button. */
  function refreshAsk() {
    if (!ask) return;
    askEl.querySelectorAll(".ask-tab").forEach((t, i) => t.classList.toggle("answered", !!askValue(i)));
    askEl.querySelector(".ask-submit")?.toggleAttribute("disabled", !askReady());
  }

  /** The preview pane shows the hovered or focused option, else the picked one. */
  function showAskPreview(i) {
    const pane = askEl.querySelector(".ask-preview");
    if (!pane || !ask) return;
    const options = ask.questions[ask.tab].options || [];
    const picked = options[[...ask.picks[ask.tab].chosen][0]];
    const o = [options[i], picked, ...options].find((x) => x && typeof x.preview === "string" && x.preview);
    if (!o) return;
    const body = el("div", "ask-preview-body md");
    body.innerHTML = markdown(o.preview);
    pane.replaceChildren(el("div", "ask-preview-title", o.label), body);
  }

  /** Picks option i of the current question ("Other" is the last). A single choice moves on. */
  function pickAsk(i, advance) {
    const tab = ask.tab;
    const q = ask.questions[tab];
    const pick = ask.picks[tab];
    const isOther = i === (q.options || []).length;
    ask.cursor[tab] = i;
    if (q.multiSelect) {
      if (isOther) pick.other = !pick.other;
      else if (pick.chosen.has(i)) pick.chosen.delete(i);
      else pick.chosen.add(i);
      renderAsk(isOther && pick.other ? "other" : "option");
      return;
    }
    if (isOther) {
      pick.other = true;
      pick.chosen.clear();
      renderAsk("other");
      return;
    }
    pick.other = false;
    pick.chosen = new Set([i]);
    if (advance) advanceAsk();
    else renderAsk("option");
  }

  /** Goes to the next unanswered question, or to Submit once all are answered. */
  function advanceAsk() {
    const n = ask.questions.length;
    for (let k = 1; k < n; k++) {
      const j = (ask.tab + k) % n;
      if (!askValue(j)) {
        ask.tab = j;
        renderAsk("option");
        return;
      }
    }
    renderAsk(askReady() ? "submit" : "option");
  }

  function switchAskTab(step) {
    const n = ask.questions.length;
    if (n < 2) return;
    ask.tab = (ask.tab + step + n) % n;
    renderAsk("option");
  }

  function submitAsk() {
    if (!ask || !askReady()) return;
    const answers = {};
    /** @type {Record<string, {preview: string}>} */
    const annotations = {};
    ask.questions.forEach((q, i) => {
      answers[q.question] = askValue(i);
      const picked = (q.options || [])[[...ask.picks[i].chosen][0]];
      if (askHasPreview(q) && !ask.picks[i].other && picked?.preview) annotations[q.question] = { preview: picked.preview };
    });
    post("permission", { requestId: ask.p.requestId, behavior: "allow", answers, annotations });
    ask.card.ask.answers = answers;
    ask.card.ask.open = true;
    setAskStatus(ask.card, "answered");
    closeAsk();
  }

  /** Esc or ×: refuses the questions and stops the turn. */
  function cancelAsk() {
    if (!ask) return;
    post("permission", { requestId: ask.p.requestId, behavior: "deny", interrupt: true });
    ask.card.ask.note.textContent = "Tool interrupted";
    ask.card.ask.open = true;
    interrupted = true;
    setAskStatus(ask.card, "declined");
    // The interrupt ends the turn, so anything queued behind it is moot.
    askQueue.length = 0;
    closeAsk();
  }

  function closeAsk() {
    const hadFocus = askEl.contains(document.activeElement);
    ask = null;
    askEl.replaceChildren();
    askEl.classList.add("hidden");
    composerEl.classList.remove("hidden");
    renderWorking();
    // The answered card opened in the log; bring it into view.
    scrollDown();
    const next = askQueue.shift();
    if (next) openAsk(next);
    else if (hadFocus) input.focus();
  }

  /** Claude Code stopped or the turn ended: an open question can no longer be answered. */
  function dropAsk() {
    askQueue.length = 0;
    if (!ask) return;
    if (ask.card.ask.status === "pending") setAskStatus(ask.card, "stopped");
    closeAsk();
  }

  askEl.addEventListener("keydown", (e) => {
    if (!ask) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelAsk();
      return;
    }
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.tagName === "INPUT") {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        if ((e.ctrlKey || e.metaKey) && askReady()) submitAsk();
        else advanceAsk();
      }
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitAsk();
      return;
    }
    if (ask.collapsed) return;
    const count = (ask.questions[ask.tab]?.options || []).length + 1;
    const onOption = !!target.closest(".ask-opt");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const cur = onOption ? ask.cursor[ask.tab] : e.key === "ArrowDown" ? -1 : count;
      const next = Math.max(0, Math.min(count - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
      /** @type {HTMLElement | undefined} */ (askEl.querySelectorAll(".ask-opt")[next])?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      switchAskTab(e.key === "ArrowRight" ? 1 : -1);
    } else if (onOption && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      pickAsk(ask.cursor[ask.tab], e.key === "Enter");
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= count && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      pickAsk(Number(e.key) - 1, true);
    }
  });

  // ---------------------------------------------------------------- menus

  let menuOwner = null;

  /**
   * Opens the shared dropdown: above a composer pill by default, or below a message
   * action with `below`. Action menus pass role "menuitem" and get no check column.
   * An item with `heading` starts a titled section.
   */
  function openMenu(anchor, title, items, onPick, opts = {}) {
    if (menuOwner === anchor) return closeMenu();
    const role = opts.role || "menuitemradio";
    menu.replaceChildren();
    menu.classList.toggle("actions", role === "menuitem");
    menu.classList.remove("mode-menu");
    if (title) menu.appendChild(el("div", "menu-title", title));
    for (const item of items) {
      if (item.heading) {
        menu.appendChild(el("div", "menu-title", item.heading));
        continue;
      }
      const b = el("button", "menu-item" + (item.checked ? " checked" : "") + (item.danger ? " danger" : ""));
      b.setAttribute("role", role);
      if (role === "menuitemradio") b.setAttribute("aria-checked", String(!!item.checked));
      if (item.disabled) b.setAttribute("disabled", "");
      if (item.title) b.title = item.title;
      const text = el("span", "menu-text");
      text.appendChild(el("span", "menu-label", item.label));
      if (item.description) text.appendChild(el("span", "menu-desc", item.description));
      b.appendChild(text);
      if (item.hint) b.appendChild(el("kbd", "", item.hint));
      b.addEventListener("click", () => {
        closeMenu();
        onPick(item.value, item);
      });
      menu.appendChild(b);
    }
    placeMenu(anchor, opts);
  }

  /** Shows the menu next to its anchor, above it unless `opts.below` fits. */
  function placeMenu(anchor, opts = {}) {
    menu.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    const left = opts.alignRight ? r.right - menu.offsetWidth : r.left;
    menu.style.left = Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8)) + "px";
    if (opts.below && r.bottom + 6 + menu.offsetHeight <= window.innerHeight - 8) {
      menu.style.top = r.bottom + 6 + "px";
      menu.style.bottom = "";
    } else {
      menu.style.top = "";
      menu.style.bottom = window.innerHeight - r.top + 6 + "px";
    }
    menuOwner = anchor;
    anchor.setAttribute("aria-expanded", "true");
    /** @type {HTMLElement|null} */ (
      menu.querySelector(".checked") || menu.querySelector(".menu-item:not([disabled])")
    )?.focus();
  }

  function closeMenu() {
    menu.classList.add("hidden");
    menuOwner?.setAttribute("aria-expanded", "false");
    menuOwner = null;
  }

  document.addEventListener("mousedown", (e) => {
    const t = /** @type {Node} */ (e.target);
    if (menuOwner && !menu.contains(t) && !menuOwner.contains(t)) closeMenu();
    if (!popup.classList.contains("hidden") && !popup.contains(t) && t !== input) hidePopup();
  });

  function currentModelInfo() {
    return state.models.find((m) => m.value === state.model) || state.models[0];
  }

  function modelName(value) {
    const m = state.models.find((x) => x.value === value);
    if (!m) return value;
    return value === "default" ? "Default" : (m.displayName || value).replace(/\s*\(.*\)\s*$/, "");
  }

  function renderPills() {
    const info = currentModelInfo();
    $("modelLabel").textContent = modelName(state.model);
    const effortShown = !!state.effort && !(info && info.supportsEffort === false);
    const effortLabel = $("effortLabel");
    effortLabel.textContent = effortShown ? EFFORT_LABELS[state.effort] || state.effort : "";
    effortLabel.classList.toggle("hidden", !effortShown);
    const effortText = info && info.supportsEffort === false ? "" : ` · effort: ${state.effort ? EFFORT_LABELS[state.effort] || state.effort : "Auto"}`;
    $("modelBtn").title = `Model: ${state.resolvedModel || modelName(state.model)}${effortText}`;
    const mode = MODES.find((m) => m.value === state.mode) || MODES[0];
    $("modeLabel").textContent = mode.short;
    $("modeIcon").replaceChildren(svg(ICONS["mode_" + mode.value] || ICONS.mode_default));
    $("modeBtn").dataset.mode = state.mode;
    $("modeBtn").title = `Permission mode: ${mode.label} (Shift+Tab to switch)`;
    $("yolo").classList.toggle("hidden", state.mode !== "bypassPermissions");
  }

  /** One menu for the model and, when the model supports it, the thinking effort. */
  $("modelBtn").addEventListener("click", () => {
    const info = currentModelInfo();
    const items = [
      { heading: "Model" },
      ...state.models.map((m) => ({
        value: "model:" + m.value,
        label: m.value === "default" ? "Default" : m.displayName || m.value,
        description: m.description,
        checked: m.value === state.model,
      })),
    ];
    if (!(info && info.supportsEffort === false)) {
      const levels = (info && info.supportedEffortLevels) || FALLBACK_EFFORTS;
      items.push(
        { heading: "Thinking effort" },
        { value: "effort:", label: "Auto", description: "The model's default effort", checked: !state.effort },
        ...levels.map((l) => ({
          value: "effort:" + l,
          label: EFFORT_LABELS[l] || l,
          description: l === "max" ? "Deepest reasoning, uses the most tokens" : l === "low" ? "Quickest answers" : "",
          checked: state.effort === l,
        }))
      );
    }
    openMenu($("modelBtn"), null, items, (value) => {
      const [kind, choice] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
      if (kind === "model") {
        state.model = choice;
        renderPills();
        post("setModel", { model: choice });
      } else {
        state.effort = choice || null;
        renderPills();
        post("setEffort", { effort: choice });
      }
    });
  });

  function availableModes() {
    const info = currentModelInfo();
    return MODES.filter((m) => m.needs !== "auto" || (info && info.supportsAutoMode));
  }

  function setMode(value) {
    if (value === state.mode) return;
    if (value !== "bypassPermissions") {
      state.mode = value;
      renderPills();
    }
    post("setMode", { mode: value });
  }

  /** The mode picker: one row per mode with its icon, plus the effort slider at the bottom. */
  function openModeMenu() {
    const anchor = $("modeBtn");
    if (menuOwner === anchor) return closeMenu();
    menu.replaceChildren();
    menu.classList.remove("actions");
    menu.classList.add("mode-menu");

    const head = el("div", "mode-menu-head");
    head.appendChild(el("span", "", "Modes"));
    const hint = el("span", "mode-menu-hint");
    hint.append(el("kbd", "", "⇧"), " + ", el("kbd", "", "tab"), " to switch");
    head.appendChild(hint);
    menu.appendChild(head);

    for (const m of availableModes()) {
      const checked = m.value === state.mode;
      const b = el("button", "menu-item mode-item" + (checked ? " checked" : "") + (m.danger ? " danger" : ""));
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(checked));
      b.dataset.mode = m.value;
      const icon = el("span", "mode-item-icon");
      icon.appendChild(svg(ICONS["mode_" + m.value] || ICONS.mode_default));
      b.appendChild(icon);
      const text = el("span", "menu-text");
      text.appendChild(el("span", "menu-label", m.label));
      text.appendChild(el("span", "menu-desc", m.description));
      b.appendChild(text);
      if (checked) b.appendChild(svg(ICONS.check)).classList.add("mode-item-check");
      b.addEventListener("click", () => {
        closeMenu();
        setMode(m.value);
      });
      menu.appendChild(b);
    }

    const info = currentModelInfo();
    if (!(info && info.supportsEffort === false)) menu.appendChild(effortRow(info));

    placeMenu(anchor, { alignRight: true });
    menuOwner = anchor;
    anchor.setAttribute("aria-expanded", "true");
    /** @type {HTMLElement|null} */ (menu.querySelector(".mode-item.checked") || menu.querySelector(".mode-item"))?.focus();
  }

  /** "Effort (High)" with a dot per level; clicking the current level goes back to Auto. */
  function effortRow(info) {
    const levels = (info && info.supportedEffortLevels) || FALLBACK_EFFORTS;
    const row = el("div", "effort-row");
    const icon = el("span", "mode-item-icon");
    icon.appendChild(svg(ICONS.effort));
    row.appendChild(icon);
    const label = el("span", "effort-row-label");
    row.appendChild(label);
    const track = el("div", "effort-track");
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", "Thinking effort");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(levels.length - 1));
    track.tabIndex = 0;
    row.appendChild(track);

    const dots = levels.map((l) => {
      const d = el("button", "effort-dot");
      d.tabIndex = -1;
      d.title = EFFORT_LABELS[l] || l;
      d.addEventListener("click", () => setEffort(state.effort === l ? null : l));
      track.appendChild(d);
      return d;
    });

    const paint = () => {
      const name = state.effort ? EFFORT_LABELS[state.effort] || state.effort : "Auto";
      label.replaceChildren("Effort ", el("span", "muted", `(${name})`));
      const idx = levels.indexOf(state.effort || "");
      dots.forEach((d, i) => d.classList.toggle("on", i === idx));
      track.setAttribute("aria-valuenow", String(Math.max(idx, 0)));
      track.setAttribute("aria-valuetext", name);
    };
    const setEffort = (level) => {
      state.effort = level;
      renderPills();
      paint();
      post("setEffort", { effort: level || "" });
    };
    track.addEventListener("keydown", (e) => {
      const idx = levels.indexOf(state.effort || "");
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        setEffort(levels[Math.min(idx + 1, levels.length - 1)]);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        setEffort(idx <= 0 ? null : levels[idx - 1]);
      }
    });
    paint();
    return row;
  }

  $("modeBtn").addEventListener("click", openModeMenu);

  // ---------------------------------------------------------------- popup: / and @

  let popupKind = null;
  let popupItems = [];
  let popupIndex = 0;
  let fileQuery = null;
  let fileTimer = 0;

  function showPopup(kind, items) {
    popupKind = kind;
    popupItems = items;
    popupIndex = 0;
    popup.replaceChildren();
    if (!items.length) {
      popup.appendChild(el("div", "popup-empty", kind === "files" ? "No matching files" : "No matching commands"));
    }
    items.forEach((item, idx) => {
      const row = el("div", "popup-item");
      row.setAttribute("role", "option");
      row.appendChild(el("span", "popup-label", item.label));
      if (item.description) row.appendChild(el("span", "popup-desc", item.description));
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pickPopup(idx);
      });
      popup.appendChild(row);
    });
    popup.classList.remove("hidden");
    highlightPopup();
  }

  function hidePopup() {
    popup.classList.add("hidden");
    popupKind = null;
    popupItems = [];
  }

  function highlightPopup() {
    const rows = popup.querySelectorAll(".popup-item");
    rows.forEach((r, i) => {
      r.classList.toggle("active", i === popupIndex);
      r.setAttribute("aria-selected", String(i === popupIndex));
    });
    rows[popupIndex]?.scrollIntoView({ block: "nearest" });
  }

  function pickPopup(idx) {
    const item = popupItems[idx];
    if (!item) return;
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const after = input.value.slice(caret);
    let replaced;
    if (popupKind === "commands") {
      replaced = before.replace(/^\s*\/\S*$/, `/${item.value} `);
    } else {
      replaced = before.replace(/@[^\s@]*$/, `@${item.value} `);
    }
    input.value = replaced + after;
    input.selectionStart = input.selectionEnd = replaced.length;
    hidePopup();
    autosize();
    refreshSend();
    input.focus();
  }

  function updatePopup() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const slash = before.match(/^\s*\/(\S*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = state.commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
        .slice(0, 50)
        .map((c) => ({
          value: c.name,
          label: "/" + c.name + (c.argumentHint ? " " + c.argumentHint : ""),
          description: (c.description || "").replace(/\s*\((user|project|plugin[^)]*)\)\s*$/, ""),
        }));
      showPopup("commands", items);
      return;
    }
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const q = at[1];
      if (q !== fileQuery) {
        fileQuery = q;
        clearTimeout(fileTimer);
        fileTimer = setTimeout(() => post("searchFiles", { query: q }), 80);
      }
      return;
    }
    fileQuery = null;
    hidePopup();
  }

  function insertAtCaret(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s$/.test(input.value.slice(0, start));
    const insert = (needsSpace ? " " : "") + text;
    input.value = input.value.slice(0, start) + insert + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + insert.length;
    input.focus();
    refreshSend();
    updatePopup();
  }

  $("slashBtn").addEventListener("click", () => {
    if (!input.value.trim().startsWith("/")) {
      input.value = "/" + input.value.replace(/^\s+/, "");
      input.selectionStart = input.selectionEnd = 1;
    }
    input.focus();
    refreshSend();
    updatePopup();
  });
  $("plusBtn").addEventListener("click", () => {
    openMenu(
      $("plusBtn"),
      null,
      [
        { value: "image", label: "Attach image", description: "PNG, JPEG, GIF or WebP up to 5 MB" },
        { value: "file", label: "Reference file", hint: "@" },
      ],
      (value) => (value === "image" ? post("pickImages") : insertAtCaret("@")),
      { role: "menuitem" }
    );
  });

  // ---------------------------------------------------------------- image viewer

  const lightbox = $("lightbox");
  const lightboxImg = /** @type {HTMLImageElement} */ ($("lightboxImg"));

  function openLightbox(src, name) {
    lightboxImg.src = src;
    lightboxImg.alt = name || "image";
    $("lightboxName").textContent = name || "";
    lightbox.classList.remove("hidden");
    $("lightboxClose").focus();
  }

  function closeLightbox() {
    lightbox.classList.add("hidden");
    lightboxImg.removeAttribute("src");
  }

  lightbox.addEventListener("click", (e) => {
    if (e.target !== lightboxImg) closeLightbox();
  });

  // ---------------------------------------------------------------- attachments

  /** Compact chips: a small thumbnail, the name and the image size; × shows on hover. */
  function renderAttachments() {
    attachmentsEl.replaceChildren();
    attachmentsEl.classList.toggle("hidden", attachments.length === 0);
    attachments.forEach((img, idx) => {
      const chip = el("div", "att-chip");
      chip.title = `View ${img.name}`;
      const im = /** @type {HTMLImageElement} */ (el("img"));
      im.src = `data:${img.mediaType};base64,${img.data}`;
      im.alt = "";
      chip.addEventListener("click", (e) => {
        if (!x.contains(/** @type {Node} */ (e.target))) openLightbox(im.src, img.name);
      });
      chip.appendChild(im);
      chip.appendChild(el("span", "att-name", img.name));
      if (img.width && img.height) chip.appendChild(el("span", "att-size", `${img.width}×${img.height}`));
      const x = el("button", "att-x", "×");
      x.title = `Remove ${img.name}`;
      x.setAttribute("aria-label", `Remove ${img.name}`);
      x.addEventListener("click", () => {
        attachments.splice(idx, 1);
        renderAttachments();
        input.focus();
      });
      chip.appendChild(x);
      attachmentsEl.appendChild(chip);
    });
    refreshSend();
  }

  /** Adds images to the composer once their pixel size is known. */
  function addAttachments(images) {
    for (const img of images) {
      const probe = new Image();
      const done = () => {
        attachments.push({ ...img, width: probe.naturalWidth || undefined, height: probe.naturalHeight || undefined });
        renderAttachments();
      };
      probe.onload = done;
      probe.onerror = done;
      probe.src = `data:${img.mediaType};base64,${img.data}`;
    }
  }

  function addImageFiles(files) {
    for (const file of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
      if (file.size > 5 * 1024 * 1024) {
        notice(`${file.name || "Image"} is larger than 5 MB.`, "error");
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        addAttachments([{ name: file.name || "pasted image", mediaType: file.type, data: url.slice(url.indexOf(",") + 1) }]);
      };
      reader.readAsDataURL(file);
    }
  }

  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  });
  const composer = $("composer");
  composer.addEventListener("dragover", (e) => {
    e.preventDefault();
    composer.classList.add("dragging");
  });
  composer.addEventListener("dragleave", () => composer.classList.remove("dragging"));
  composer.addEventListener("drop", (e) => {
    e.preventDefault();
    composer.classList.remove("dragging");
    addImageFiles([...(e.dataTransfer?.files || [])]);
  });

  // ---------------------------------------------------------------- drawer

  let drawerKind = null;

  function openDrawer(kind) {
    if (drawerKind === kind) return closeDrawer();
    drawerKind = kind;
    drawer.classList.remove("hidden");
    $("historyPane").classList.toggle("hidden", kind !== "history");
    $("settingsPane").classList.toggle("hidden", kind !== "settings");
    $("drawerTitle").textContent = kind === "history" ? "History" : "Settings";
    $("historyBtn").setAttribute("aria-pressed", String(kind === "history"));
    $("settingsBtn").setAttribute("aria-pressed", String(kind === "settings"));
    if (kind === "history") {
      $("historyList").replaceChildren(el("li", "muted pad", "Loading…"));
      post("history");
      /** @type {HTMLInputElement} */ ($("historySearch")).focus();
    } else {
      $("checkpointState").textContent = state.checkpoints
        ? "On. Use the rewind button on a prompt to put files back to before it."
        : "Off. Turn on Claude Switcher › Chat: Checkpoints in settings and start a new chat.";
      $("mcpList").replaceChildren(el("li", "muted", "Loading…"));
      $("rulesList").replaceChildren(el("li", "muted", "Loading…"));
      post("mcpStatus");
      post("permissionRules");
    }
  }

  function closeDrawer() {
    drawerKind = null;
    drawer.classList.add("hidden");
    $("historyBtn").setAttribute("aria-pressed", "false");
    $("settingsBtn").setAttribute("aria-pressed", "false");
  }

  function renderHistory() {
    const q = /** @type {HTMLInputElement} */ ($("historySearch")).value.trim().toLowerCase();
    const list = $("historyList");
    list.replaceChildren();
    const items = historyItems.filter((h) => !q || h.title.toLowerCase().includes(q));
    if (!items.length) {
      list.appendChild(el("li", "muted pad", q ? "No conversations match." : "No earlier conversations for this account in this folder."));
      return;
    }
    for (const h of items) {
      const li = el("li");
      const b = el("button", "history-item");
      b.appendChild(el("span", "history-title", h.title));
      b.appendChild(el("span", "history-time", timeAgo(h.updatedAt)));
      b.addEventListener("click", () => {
        closeDrawer();
        post("resume", { sessionId: h.sessionId });
      });
      li.appendChild(b);
      list.appendChild(li);
    }
  }

  function renderMcp(msg) {
    const list = $("mcpList");
    list.replaceChildren();
    if (msg.error) return list.appendChild(el("li", "muted", msg.error));
    if (!msg.servers.length) {
      return list.appendChild(el("li", "muted", "No MCP servers. Add them with `claude mcp add` or a .mcp.json in the project."));
    }
    for (const s of msg.servers) {
      const li = el("li", "mcp-row");
      li.appendChild(el("span", "chip " + (s.status || ""), s.status || "unknown"));
      const text = el("span", "mcp-text");
      text.appendChild(el("span", "mcp-name", s.name));
      text.appendChild(el("span", "muted", [s.scope, s.tools ? `${s.tools} tools` : ""].filter(Boolean).join(" · ")));
      if (s.error) text.appendChild(el("span", "err-text", s.error));
      li.appendChild(text);
      if (s.status === "failed" || s.status === "needs-auth") {
        const r = el("button", "link", "Reconnect");
        r.addEventListener("click", () => post("mcpReconnect", { name: s.name }));
        li.appendChild(r);
      }
      const t = el("button", "link", s.status === "disabled" ? "Enable" : "Disable");
      t.addEventListener("click", () => post("mcpToggle", { name: s.name, enabled: s.status === "disabled" }));
      li.appendChild(t);
      list.appendChild(li);
    }
  }

  function ruleText(r) {
    if (typeof r === "string") return r;
    const value = r.ruleValue || r.rule || r;
    const tool = value.toolName || r.toolName;
    const content = value.ruleContent ?? r.ruleContent;
    if (tool) return content ? `${tool}(${content})` : tool;
    return JSON.stringify(r);
  }

  function renderRules(msg) {
    const list = $("rulesList");
    list.replaceChildren();
    if (msg.error) return list.appendChild(el("li", "muted", msg.error));
    if (!msg.rules.length) {
      list.appendChild(el("li", "muted", "No saved rules. Use Always allow on a permission prompt to add one."));
    }
    for (const r of msg.rules) {
      const li = el("li", "rule-row");
      const behavior = r.ruleBehavior || r.behavior || "";
      if (behavior) li.appendChild(el("span", "chip " + behavior, behavior));
      li.appendChild(el("code", "", ruleText(r)));
      if (r.source) li.appendChild(el("span", "muted", r.source));
      list.appendChild(li);
    }
  }

  $("historyBtn").addEventListener("click", () => openDrawer("history"));
  $("settingsBtn").addEventListener("click", () => openDrawer("settings"));
  $("drawerClose").addEventListener("click", closeDrawer);
  $("historySearch").addEventListener("input", renderHistory);
  $("mcpRefresh").addEventListener("click", () => post("mcpStatus"));
  $("rulesRefresh").addEventListener("click", () => post("permissionRules"));
  $("openSettings").addEventListener("click", () => post("openSettings"));

  // ---------------------------------------------------------------- state

  let tick = 0;
  let verbIndex = -1;
  let verbChangedAt = 0;
  const working = el("div", "working");
  working.setAttribute("aria-hidden", "true");
  const workingVerb = el("span", "working-verb");
  const workingMeta = el("span", "working-meta");
  working.append(el("span", "working-glyph", "✻"), workingVerb, workingMeta);

  function nextVerb() {
    let i = Math.floor(Math.random() * WORKING_VERBS.length);
    if (i === verbIndex) i = (i + 1) % WORKING_VERBS.length;
    verbIndex = i;
    verbChangedAt = Date.now();
    return WORKING_VERBS[i];
  }

  /** The "Pondering…" line at the end of the conversation while Claude works. */
  function renderWorking() {
    // While a question is open Claude is waiting on you, which its card already shows.
    if (!state.busy || !state.running || ask) {
      working.remove();
      return;
    }
    if (verbIndex < 0 || Date.now() - verbChangedAt >= VERB_INTERVAL_MS) {
      workingVerb.textContent = nextVerb() + "…";
    }
    const secs = Math.floor((Date.now() - state.busySince) / 1000);
    workingMeta.textContent = `${secs}s · Esc to stop`;
    if (log.lastElementChild !== working) {
      log.appendChild(working);
      if (following) scrollDown();
    }
  }

  function setBusy(value) {
    state.busy = value;
    stopBtn.classList.toggle("hidden", !state.busy);
    sendBtn.classList.toggle("hidden", state.busy);
    if (value && !state.busySince) state.busySince = Date.now();
    if (!value) {
      state.busySince = 0;
      verbIndex = -1;
    }
    clearInterval(tick);
    if (value) tick = setInterval(renderWorking, 1000);
    renderWorking();
  }

  function renderStats() {
    const tokens = $("tokens");
    tokens.classList.toggle("hidden", !state.tokensIn && !state.tokensOut);
    tokens.textContent = `${formatTokens(state.tokensIn)} in · ${formatTokens(state.tokensOut)} out`;
    const total = state.costBase + state.costRun;
    const cost = $("cost");
    cost.classList.toggle("hidden", !total);
    cost.textContent = "$" + total.toFixed(total < 1 ? 3 : 2);
  }

  // ---------------------------------------------------------------- plan usage

  let usage = null;

  function fmtDuration(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function fmtReset(iso) {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (isNaN(t)) return "";
    const diff = t - Date.now();
    return diff <= 0 ? "resets soon" : `resets in ${fmtDuration(diff)}`;
  }

  /** The account's plan limits (5h session, weekly), next to the context meter under the composer. */
  function renderUsage() {
    renderUsageChip();
    const strip = $("usage");
    const windows = usage?.windows || [];
    strip.replaceChildren();
    strip.classList.toggle("hidden", !windows.length && !usage?.error);
    if (!usage) return;
    const warn = usage.warnThreshold || 80;
    for (const w of windows) {
      const pct = Math.min(100, Math.max(0, Math.round(w.percent)));
      const level = pct >= warn ? "danger" : pct >= warn * 0.75 ? "warn" : "ok";
      const item = el("div", "usage-item " + level);
      const reset = fmtReset(w.resetsAt);
      item.title = `${w.label}: ${pct}% used${reset ? `, ${reset}` : ""}`;
      item.appendChild(el("span", "usage-label", w.label));
      const bar = el("span", "usage-bar");
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", w.label);
      bar.setAttribute("aria-valuenow", String(pct));
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      const fill = el("span", "usage-fill");
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      item.appendChild(bar);
      item.appendChild(el("span", "usage-pct", pct + "%"));
      if (reset) item.appendChild(el("span", "usage-reset", reset));
      strip.appendChild(item);
    }
    if (usage.error) {
      strip.appendChild(el("span", "usage-error", windows.length ? "Last refresh failed" : `Usage unavailable: ${usage.error}`));
    }
    const refresh = el("button", "usage-refresh");
    refresh.title = usage.fetchedAt ? `Updated ${timeAgo(usage.fetchedAt)}. Refresh usage` : "Refresh usage";
    refresh.setAttribute("aria-label", "Refresh usage");
    refresh.appendChild(svg(ICONS.restore));
    refresh.addEventListener("click", () => {
      refresh.classList.add("spinning");
      post("refreshUsage");
    });
    strip.appendChild(refresh);
  }

  /** Time until the 5-hour window resets, in the composer bar; the tooltip has every window. */
  function renderUsageChip() {
    const chip = $("usageChip");
    const windows = usage?.windows || [];
    const session = windows.find((w) => w.kind === "session") || windows.find((w) => /5h/.test(w.label));
    const at = session?.resetsAt ? new Date(session.resetsAt).getTime() : NaN;
    chip.classList.toggle("hidden", isNaN(at));
    if (isNaN(at)) return;
    $("usageChipText").textContent = at - Date.now() <= 0 ? "now" : fmtDuration(at - Date.now());
    chip.title = windows
      .map((w) => {
        const reset = fmtReset(w.resetsAt);
        return `${w.label}: ${Math.round(w.percent)}% used${reset ? `, ${reset}` : ""}`;
      })
      .join("\n");
    chip.classList.toggle("warn", session.percent >= (usage.warnThreshold || 80));
  }

  // Keep "resets in" current between polls.
  setInterval(() => usage && renderUsage(), 60_000);

  function resetStats() {
    state.tokensIn = state.tokensOut = state.costBase = state.costRun = 0;
    renderStats();
    $("ctxMeter").classList.add("hidden");
  }

  function showBanner(message, details, actionLabel, kind = "warn") {
    banner.replaceChildren();
    banner.classList.toggle("info", kind === "info");
    const text = el("div", "banner-text");
    text.appendChild(el("div", "", message));
    if (details) text.appendChild(el("pre", "", details));
    banner.appendChild(text);
    if (actionLabel) {
      const b = el("button", "btn primary", actionLabel);
      b.addEventListener("click", () => {
        banner.classList.add("hidden");
        post("restart");
      });
      banner.appendChild(b);
    }
    banner.classList.remove("hidden");
  }

  function sendInput() {
    const text = input.value.trim();
    // Headless Claude Code does not clear on /clear, so start a new chat here like the button does.
    if (/^\/(clear|new|reset)$/i.test(text)) {
      attachments = [];
      renderAttachments();
      input.value = "";
      hidePopup();
      autosize();
      refreshSend();
      closeDrawer();
      post("newChat");
      return;
    }
    if ((!text && !attachments.length) || state.busy || !state.running) return;
    const clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const images = attachments;
    interrupted = false;
    currentPrompt = addUser(text, { images });
    prompts.set(clientId, currentPrompt);
    post("send", { text, images: images.map(({ mediaType, data }) => ({ mediaType, data })), clientId });
    attachments = [];
    renderAttachments();
    input.value = "";
    hidePopup();
    autosize();
    refreshSend();
  }

  /** Send is dimmed until there is something to send. */
  function refreshSend() {
    sendBtn.toggleAttribute("disabled", !input.value.trim() && !attachments.length);
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 260) + "px";
  }

  function clearLog() {
    dropAsk();
    messages.clear();
    tools.clear();
    prompts.clear();
    currentPrompt = null;
    promptEntries = [];
    pinnedEntry = null;
    renderPinned();
    currentTurn = null;
    turnObserver.disconnect();
    followObserver.disconnect();
    followObserver.observe(log);
    following = true;
    log.replaceChildren(welcome);
  }

  function replay(events, divider) {
    for (const ev of events) {
      if (ev.type === "history_prompt") {
        currentPrompt = addUser(ev.text, { uuid: ev.uuid, time: ev.timestamp, images: ev.images });
      } else if (ev.type === "assistant") onAssistant(ev);
      else if (ev.type === "user") onUser(ev);
    }
    settleTools();
    if (events.length) append(el("div", "divider", divider || "Resumed. Earlier messages above."));
    scrollDown();
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "init":
        saved.profileId = msg.profileId;
        saved.sessionId = msg.sessionId;
        vscode.setState({ ...saved });
        $("account").textContent = msg.label;
        $("avatar").textContent = (msg.label || "?").trim().charAt(0).toUpperCase();
        $("accountSub").textContent = msg.cwd;
        $("accountSub").title = msg.cwd;
        $("welcomeSub").textContent = `Claude Code as ${msg.label}, working in ${msg.cwd}`;
        state.mode = msg.mode;
        state.model = msg.model;
        state.effort = msg.effort;
        state.checkpoints = msg.checkpoints;
        renderPills();
        break;
      case "capabilities": {
        if (msg.models.length) {
          state.models = msg.models;
          if (!state.models.some((m) => m.value === state.model)) {
            state.models = [...state.models, { value: state.model, displayName: state.model }];
          }
        }
        state.commands = msg.commands.some((c) => c.name === "clear")
          ? msg.commands
          : [{ name: "clear", description: "Start a new conversation" }, ...msg.commands];
        if (msg.account?.email) {
          const plan = msg.account.subscriptionType ? ` · ${msg.account.subscriptionType}` : "";
          $("accountSub").textContent = msg.account.email + plan;
        }
        const mismatch = $("mismatch");
        mismatch.classList.toggle("hidden", !msg.accountMismatch);
        if (msg.accountMismatch) {
          mismatch.textContent =
            `This tab is signed in as ${msg.account.email}, but the profile was saved for ${msg.expectedEmail}. ` +
            "Reauthorize the profile if that is not intended.";
        }
        renderPills();
        break;
      }
      case "status":
        state.running = msg.state === "ready";
        if (msg.state === "ready") {
          banner.classList.add("hidden");
          state.costBase += state.costRun;
          state.costRun = 0;
          if (msg.mode) state.mode = msg.mode;
          renderPills();
        }
        if (msg.state !== "ready") dropAsk();
        // The CLI being down is the only status worth a message; busy shows in the log.
        if (msg.state === "exited") {
          showBanner(msg.message, msg.details, msg.canResume ? "Resume session" : "Restart");
        } else if (msg.state === "starting") {
          showBanner("Claude Code is not running yet. Starting it…", "", "", "info");
        }
        setBusy(state.busy && state.running);
        break;
      case "busy":
        setBusy(msg.busy);
        break;
      case "session":
        saved.sessionId = msg.sessionId;
        if (saved.profileId) vscode.setState({ ...saved });
        break;
      case "mode":
        state.mode = msg.mode;
        renderPills();
        break;
      case "cleared":
        clearLog();
        resetStats();
        break;
      case "replay":
        replay(msg.events, msg.divider);
        break;
      case "forked":
        input.value = msg.text || "";
        autosize();
        refreshSend();
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
        break;
      case "userAck": {
        const entry = prompts.get(msg.clientId);
        if (entry) {
          entry.uuid = msg.uuid;
          refreshRewind(entry);
        }
        break;
      }
      case "error":
        notice(msg.message, "error");
        break;
      case "notice":
        notice(msg.message, "info");
        break;
      case "permission":
        permissionCard(msg);
        break;
      case "history":
        historyItems = msg.items;
        renderHistory();
        break;
      case "images":
        addAttachments(msg.images);
        input.focus();
        break;
      case "files":
        if (msg.query === fileQuery) {
          showPopup("files", msg.items.map((f) => {
            const slash = f.lastIndexOf("/");
            return { value: f, label: f.slice(slash + 1), description: slash > 0 ? f.slice(0, slash) : "" };
          }));
        }
        break;
      case "mcp":
        renderMcp(msg);
        break;
      case "rules":
        renderRules(msg);
        break;
      case "usage":
        usage = msg;
        renderUsage();
        break;
      case "context":
        if (typeof msg.percentage === "number") {
          const meter = $("ctxMeter");
          meter.classList.remove("hidden");
          meter.classList.toggle("high", msg.percentage >= 80);
          $("ctxFill").style.width = Math.min(100, msg.percentage) + "%";
          $("ctxText").textContent = msg.maxTokens
            ? `${msg.percentage}% · ${formatTokens(msg.totalTokens || 0)}/${formatTokens(msg.maxTokens)}`
            : `${msg.percentage}%`;
          meter.title = `Context: ${formatTokens(msg.totalTokens || 0)} of ${formatTokens(msg.maxTokens || 0)} tokens`;
        }
        break;
      case "event": {
        const ev = msg.event;
        if (ev.type === "system" && ev.subtype === "init") {
          state.resolvedModel = ev.model || "";
          renderPills();
        } else if (ev.type === "stream_event") onStreamEvent(ev.event, ev.parent_tool_use_id);
        else if (ev.type === "assistant") onAssistant(ev);
        else if (ev.type === "user") onUser(ev);
        else if (ev.type === "result") onResult(ev);
        break;
      }
    }
  });

  input.addEventListener("keydown", (e) => {
    if (!popup.classList.contains("hidden") && popupItems.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        popupIndex = (popupIndex + (e.key === "ArrowDown" ? 1 : -1) + popupItems.length) % popupItems.length;
        highlightPopup();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickPopup(popupIndex);
        return;
      }
    }
    if (e.key === "Escape") {
      if (!popup.classList.contains("hidden")) hidePopup();
      else if (state.busy) stopTurn();
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const modes = availableModes().filter((m) => m.value !== "bypassPermissions" || state.mode === "bypassPermissions");
      const idx = modes.findIndex((m) => m.value === state.mode);
      setMode(modes[(idx + 1) % modes.length].value);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendInput();
    }
  });
  input.addEventListener("input", () => {
    autosize();
    refreshSend();
    updatePopup();
  });
  input.addEventListener("click", updatePopup);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!lightbox.classList.contains("hidden")) closeLightbox();
      else if (menuOwner) closeMenu();
      else if (ask) cancelAsk();
      else if (drawerKind) closeDrawer();
      else if (state.busy && document.activeElement !== input) stopTurn();
    }
  });
  sendBtn.addEventListener("click", sendInput);
  function stopTurn() {
    interrupted = true;
    post("interrupt");
  }
  stopBtn.addEventListener("click", stopTurn);
  $("newChatBtn").addEventListener("click", () => {
    closeDrawer();
    post("newChat");
  });

  renderPills();
  setBusy(false);
  refreshSend();
  input.focus();
  post("ready");
})();
