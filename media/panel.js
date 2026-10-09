(function () {
  const vscode = acquireVsCodeApi();
  let state = vscode.getState() || { accounts: [], warnThreshold: 80 };

  const listEl = document.getElementById("list");
  const noteEl = document.getElementById("note");
  const limitEl = document.getElementById("limit");

  /** Ids with a pending refresh / switch; cleared by the next state push. */
  const busy = new Set();
  let busyTimer;
  let openMenu;
  let renderPending = false;

  const post = (type, id, value) => vscode.postMessage({ type, id, value });

  // --- Icons (static markup only; user data always goes through textContent) ---

  const ICONS = {
    plus: '<path d="M8 3v10M3 8h10"/>',
    chevron: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5V5h-2.5"/>',
    more: '<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>',
    userPlus: '<circle cx="6.5" cy="5.5" r="2.5"/><path d="M2 13.5c.5-2.5 2.3-3.5 4.5-3.5s4 1 4.5 3.5"/><path d="M13 5v4M11 7h4"/>',
    save: '<path d="M8 2.5v7M5 6.5l3 3 3-3"/><path d="M3 11.5v2h10v-2"/>',
    globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5z"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3"/>',
    chat: '<path d="M2.5 3.5h11v7H7l-3 2.5v-2.5H2.5z"/>',
    window: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/>',
    key: '<circle cx="5" cy="11" r="2.5"/><path d="M6.8 9.2 13 3M10.5 5.5 12 7"/>',
    pencil: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
    trash: '<path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.6 9h6.8l.6-9"/>',
    undo: '<path d="M4.5 6.5H10a3 3 0 0 1 0 6H7"/><path d="M7 4 4.5 6.5 7 9"/>',
    help: '<circle cx="8" cy="8" r="5.5"/><path d="M6.5 6.5a1.5 1.5 0 1 1 2.1 1.4c-.4.2-.6.5-.6.9v.4M8 11v.1"/>',
    gear: '<path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>',
    warn: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
    swap: '<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8"/><path d="M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>',
    pin: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6h12"/><circle cx="11.5" cy="4.25" r=".6" fill="currentColor"/>',
    palette: '<path d="M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.3-.6 1.3-1.2 0-.9-.8-1.1-.8-1.9 0-.6.5-1 1.1-1h1.6a2.3 2.3 0 0 0 2.3-2.3c0-2.6-2.5-4.6-5.5-4.6z"/><circle cx="5.3" cy="7" r=".7" fill="currentColor"/><circle cx="7.8" cy="5" r=".7" fill="currentColor"/><circle cx="10.5" cy="6" r=".7" fill="currentColor"/>',
    dot: '<circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none"/>',
    check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  };

  /** Full-color 24×24 marks for the section headings. */
  const MARKS = {
    claude:
      '<path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.970 2.970 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.010l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.020.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.530.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.180 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.440-1.882.930-1.086-.006-.158h-.055L4.132 18.560l-1.130.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    conradium:
      '<path d="M5.07 17.5A8 8 0 0 1 17.14 7.37" fill="none" stroke="#2B8A92" stroke-width="3.4"/>' +
      '<path d="M18.55 8.91A8 8 0 0 1 18.93 17.5" fill="none" stroke="#D97757" stroke-width="3.4"/>' +
      '<path d="M15.86 8.9L13.07 14.4L10.93 12.6z" fill="#2B8A92" stroke="#2B8A92" stroke-width="0.6" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="13.5" r="2.1" fill="#2B8A92"/>',
  };

  function mark(name) {
    const span = document.createElement("span");
    span.className = "mark";
    span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + MARKS[name] + "</svg>";
    return span;
  }

  function icon(name, cls) {
    const span = document.createElement("span");
    span.className = "icon" + (cls ? " " + cls : "");
    span.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[name] +
      "</svg>";
    return span;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function iconButton(name, title, onClick, cls) {
    const b = el("button", "icon-btn" + (cls ? " " + cls : ""));
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(icon(name));
    b.addEventListener("click", onClick);
    return b;
  }

  // --- Dropdown menus ---

  /**
   * items: { icon, label, detail?, onClick, danger?, hidden? } | "separator" | { header }
   */
  function showMenu(anchor, items, alignTo = anchor) {
    const wasOpenHere = openMenu && openMenu.anchor === anchor;
    closeMenu();
    if (wasOpenHere) return;

    const menu = el("div", "menu");
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (!item || item.hidden) continue;
      if (item === "separator") {
        const last = menu.lastElementChild;
        if (last && !last.classList.contains("menu-sep")) menu.appendChild(el("div", "menu-sep"));
        continue;
      }
      if (item.header) {
        menu.appendChild(el("div", "menu-header", item.header));
        continue;
      }
      const b = el("button", "menu-item" + (item.danger ? " danger" : ""));
      b.setAttribute("role", "menuitem");
      const ic = icon(item.icon);
      if (item.color) ic.style.color = item.color;
      b.appendChild(ic);
      const text = el("span", "menu-text");
      text.appendChild(el("span", "menu-label", item.label));
      if (item.detail) text.appendChild(el("span", "menu-detail", item.detail));
      b.appendChild(text);
      b.addEventListener("click", () => {
        closeMenu();
        item.onClick();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);

    // Anchor below the trigger, right-aligned; flip up when there is no room.
    const r = alignTo.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left = Math.min(r.right - m.width, vw - m.width - 6);
    left = Math.max(6, left);
    let top = r.bottom + 4;
    if (top + m.height > vh - 6 && r.top - m.height - 4 > 6) top = r.top - m.height - 4;
    menu.style.left = left + window.scrollX + "px";
    menu.style.top = top + window.scrollY + "px";

    anchor.classList.add("open");
    anchor.setAttribute("aria-expanded", "true");
    openMenu = { menu, anchor };
    const first = menu.querySelector(".menu-item");
    if (first) first.focus();
  }

  function closeMenu(restoreFocus) {
    if (!openMenu) return;
    const { menu, anchor } = openMenu;
    openMenu = undefined;
    menu.remove();
    anchor.classList.remove("open");
    anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor.isConnected) anchor.focus();
    if (renderPending) render();
  }

  document.addEventListener("mousedown", (e) => {
    if (!openMenu) return;
    if (openMenu.menu.contains(e.target) || openMenu.anchor.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (!openMenu) return;
    const items = [...openMenu.menu.querySelectorAll(".menu-item")];
    const idx = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (e.key === "Tab") {
      closeMenu();
    }
  });
  window.addEventListener("blur", () => closeMenu());
  window.addEventListener("resize", () => closeMenu());

  // --- Add account ---

  const ADD_ITEMS = [
    {
      icon: "userPlus",
      label: "Log in to another account",
      detail: "Isolated login — your current account stays active",
      onClick: () => post("login"),
    },
    {
      icon: "save",
      label: "Save current login",
      detail: "Save the account Claude Code is using now",
      onClick: () => post("add"),
    },
    "separator",
    { header: "Replace the current login" },
    {
      icon: "globe",
      label: "Authorize in browser",
      detail: "Sign Claude Code in without the CLI",
      onClick: () => post("browserLogin"),
    },
    {
      icon: "terminal",
      label: "Log in from terminal",
      detail: "Runs claude auth login in a terminal",
      onClick: () => post("terminalLogin"),
    },
  ];

  // Refresh, Say Hi, account windows, Undo, Settings and Getting started are in the
  // view title bar (Refresh) and its overflow menu, so the panel has no toolbar.
  const addBtn = document.getElementById("add");
  addBtn.prepend(icon("plus"));
  addBtn.addEventListener("click", (e) => showMenu(e.currentTarget, ADD_ITEMS));

  // --- Formatting ---

  function fmtDuration(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  function fmtReset(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    const diff = t - Date.now();
    return diff <= 0 ? "resets soon" : `resets in ${fmtDuration(diff)}`;
  }

  function fmtAgo(ts) {
    if (!ts) return "no usage data yet";
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // --- Rendering ---

  function meter(w, warn) {
    const pct = Math.min(100, Math.max(0, w.percent));
    const level = pct >= warn ? "danger" : pct >= warn * 0.75 ? "warn" : "ok";
    const wrap = el("div", "meter " + level);

    const row = el("div", "meter-row");
    row.appendChild(el("span", "meter-name", w.label));
    const reset = fmtReset(w.resetsAt);
    if (reset) row.appendChild(el("span", "meter-reset", reset));
    row.appendChild(el("span", "meter-pct", w.percent + "%"));

    const bar = el("div", "bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", w.label);
    bar.setAttribute("aria-valuenow", String(pct));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const fill = el("div", "fill");
    fill.style.width = pct + "%";
    bar.appendChild(fill);

    wrap.append(row, bar);
    return wrap;
  }

  function colorOf(acc) {
    const colors = state.colors || [];
    return acc.color !== undefined ? colors[acc.color] : undefined;
  }

  function startRefresh(id) {
    busy.add("refresh:" + id);
    armBusyTimeout();
    render();
    post("refresh", id);
  }

  /** Second menu on the same ⋯ button: one swatch per color, swapping with its holder. */
  function showColorMenu(anchor, acc) {
    if (!anchor.isConnected) return;
    const holders = new Map();
    for (const a of state.accounts || []) if (a.color !== undefined) holders.set(a.color, a);
    showMenu(
      anchor,
      (state.colors || []).map((c, i) => {
        const holder = holders.get(i);
        return {
          icon: i === acc.color ? "check" : "dot",
          color: c.hex,
          label: c.name,
          detail: holder && holder.id !== acc.id ? "Swaps with " + holder.label : undefined,
          onClick: () => {
            if (i !== acc.color) post("setColor", acc.id, i);
          },
        };
      })
    );
  }

  function card(acc, warn) {
    const refreshing = busy.has("refresh:" + acc.id);
    const switching = busy.has("switch:" + acc.id);
    const color = colorOf(acc);
    const c = el("div", "card" + (acc.isActive ? " active" : ""));
    if (color) c.style.setProperty("--c", color.hex);

    // Header: avatar, name + meta, primary action, menu.
    const head = el("div", "card-head");
    const avatar = el("div", "avatar" + (color ? "" : " plain"), (acc.label.trim()[0] || "?").toUpperCase());
    avatar.setAttribute("aria-hidden", "true");

    const ident = el("div", "ident");
    const nameRow = el("div", "name-row");
    const name = el("span", "name", acc.label);
    name.title = acc.label;
    nameRow.appendChild(name);
    if (acc.subscriptionType) nameRow.appendChild(el("span", "plan", acc.subscriptionType));
    ident.appendChild(nameRow);

    const meta = el("div", "meta");
    if (acc.email) {
      const email = el("span", "email", acc.email);
      email.title = acc.email;
      meta.appendChild(email);
    }
    const ago = el(
      "span",
      "ago",
      switching ? "switching…" : refreshing ? "refreshing…" : fmtAgo(acc.fetchedAt)
    );
    if (acc.fetchedAt) ago.title = "Usage updated " + new Date(acc.fetchedAt).toLocaleString();
    meta.appendChild(ago);
    ident.appendChild(meta);

    head.append(avatar, ident);

    // Accounts other than Claude Code's run in their own Claude tab.
    if (!acc.isActive) {
      const open = el("button", "primary small", acc.openTabs > 0 ? "Show tab" : "Open tab");
      open.title =
        acc.openTabs > 0
          ? acc.openTabs + (acc.openTabs > 1 ? " Claude tabs are" : " Claude tab is") + " open for this account. Click to show it."
          : "Open a Claude Code chat for this account in a tab of this window";
      open.addEventListener("click", () => post(acc.openTabs > 0 ? "showTab" : "openTab", acc.id));
      head.appendChild(open);
    }

    const menuBtn = iconButton("more", "More actions", (e) => {
      const anchor = e.currentTarget;
      const buttonsOn = state.titleButtons !== false;
      const colorName = color ? color.name.toLowerCase() : "";
      showMenu(anchor, [
        {
          icon: "chat",
          label: "New Claude tab",
          detail: "Another chat on this account",
          hidden: acc.isActive || acc.openTabs === 0,
          onClick: () => post("openTab", acc.id),
        },
        {
          icon: "swap",
          label: "Use in Claude Code",
          detail: "Switch the Claude Code extension to this account",
          hidden: acc.isActive,
          onClick: () => {
            busy.add("switch:" + acc.id);
            armBusyTimeout();
            render();
            post("switch", acc.id);
          },
        },
        {
          icon: "window",
          label: "Open in new window",
          detail: "Full VS Code window — uses more memory",
          hidden: acc.isActive,
          onClick: () => post("openWindow", acc.id),
        },
        "separator",
        { icon: "refresh", label: "Refresh usage", onClick: () => startRefresh(acc.id) },
        {
          icon: "chat",
          label: "Say Hi",
          detail: "One-turn warmup without switching",
          hidden: acc.isActive,
          onClick: () => post("sayHi", acc.id),
        },
        {
          icon: "key",
          label: "Reauthorize…",
          detail: "Fresh isolated login for this profile",
          onClick: () => post("reauthorize", acc.id),
        },
        "separator",
        {
          icon: acc.titleButton ? "check" : "pin",
          label: "Title bar button",
          detail: acc.isActive
            ? "Shows when another account is Claude Code's"
            : acc.titleButton
              ? "On — the " + colorName + " button opens this tab"
              : "Off — click to add a " + colorName + " button",
          hidden: !color || !buttonsOn,
          onClick: () => post("setTitleButton", acc.id, !acc.titleButton),
        },
        {
          icon: "palette",
          label: "Color…",
          detail: color ? color.name : "All five colors are taken",
          onClick: () => showColorMenu(anchor, acc),
        },
        {
          icon: "pencil",
          label: "Rename…",
          detail: "The name on this card and its Claude tab",
          onClick: () => post("rename", acc.id),
        },
        { icon: "trash", label: "Remove…", danger: true, onClick: () => post("remove", acc.id) },
      ]);
    });
    menuBtn.setAttribute("aria-haspopup", "menu");
    head.appendChild(menuBtn);
    c.appendChild(head);

    // Alerts.
    if (acc.needsReauthorization) {
      const alert = el("div", "alert reauth");
      alert.appendChild(icon("warn"));
      alert.appendChild(el("span", "alert-text", "Login expired or was revoked."));
      const fix = el("button", "small", "Reauthorize");
      fix.addEventListener("click", () => post("reauthorize", acc.id));
      alert.appendChild(fix);
      c.appendChild(alert);
    } else if (acc.error) {
      const alert = el("div", "alert");
      alert.appendChild(icon("warn"));
      alert.appendChild(el("span", "alert-text", acc.error));
      c.appendChild(alert);
    }

    // Usage.
    if (acc.windows && acc.windows.length) {
      const meters = el("div", "meters");
      for (const w of acc.windows) meters.appendChild(meter(w, warn));
      c.appendChild(meters);
    } else if (!acc.error && !acc.needsReauthorization && !refreshing) {
      const hint = el("button", "link", "Load usage limits");
      hint.addEventListener("click", () => startRefresh(acc.id));
      c.appendChild(hint);
    }

    if (refreshing) c.classList.add("busy");
    return c;
  }

  function section(title, hint, count, markName) {
    const s = el("div", "section");
    const h = el("div", "section-title");
    if (markName) h.appendChild(mark(markName));
    h.appendChild(el("span", "", title));
    if (count) h.appendChild(el("span", "count", String(count)));
    s.appendChild(h);
    if (hint) s.appendChild(el("div", "section-hint", hint));
    return s;
  }

  /** A dashed box in place of a card: an empty section, or an unsaved login. */
  function placeholder(text, action, warnIcon) {
    const p = el("div", "placeholder" + (warnIcon ? " notice" : ""));
    if (warnIcon) p.appendChild(icon("warn"));
    const body = el("div", "placeholder-body");
    body.appendChild(el("div", "", text));
    if (action) {
      const b = el("button", "small" + (action.primary ? " primary" : ""), action.label);
      b.addEventListener("click", action.onClick);
      body.appendChild(b);
    }
    p.appendChild(body);
    return p;
  }

  function render() {
    if (openMenu) {
      // Re-rendering would detach the menu's anchor; wait until it closes.
      renderPending = true;
      return;
    }
    renderPending = false;

    const accounts = state.accounts || [];
    const warn = state.warnThreshold || 80;
    const active = accounts.filter((a) => a.isActive);
    const others = accounts.filter((a) => !a.isActive);

    listEl.replaceChildren();
    noteEl.classList.toggle("hidden", accounts.length > 0);

    // One color per account, so saving stops at the palette size.
    const max = state.maxAccounts || 5;
    const full = accounts.length >= max;
    addBtn.classList.toggle("hidden", full);
    limitEl.classList.toggle("hidden", !full);
    limitEl.textContent = `${accounts.length} of ${max} accounts saved. Remove one to add another.`;

    // The account the Claude Code extension itself uses in this window.
    listEl.appendChild(
      section("Claude Code", "The Claude Code extension's account in this window", 0, "claude")
    );
    for (const a of active) listEl.appendChild(card(a, warn));
    if (state.unsaved) {
      listEl.appendChild(
        placeholder(
          "Signed in as " + state.unsaved + ", which is not saved yet.",
          { label: "Save as profile", primary: true, onClick: () => post("add") },
          true
        )
      );
    } else if (!active.length) {
      listEl.appendChild(
        placeholder("No saved account is in use.", {
          label: "Save current login",
          onClick: () => post("add"),
        })
      );
    }

    // Accounts that run in this extension's own Claude tabs.
    listEl.appendChild(
      section("Conradium Code", "Each account runs in its own Claude tab", others.length, "conradium")
    );
    for (const a of others) listEl.appendChild(card(a, warn));
    if (!others.length) {
      listEl.appendChild(placeholder("Add another account to chat with it in its own tab."));
    }
  }

  function armBusyTimeout() {
    clearTimeout(busyTimer);
    // Safety net in case no state push follows (e.g. a cancelled dialog).
    busyTimer = setTimeout(() => {
      busy.clear();
      render();
    }, 30000);
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "state") {
      state = msg;
      vscode.setState(state);
      busy.clear();
      clearTimeout(busyTimer);
      render();
    }
  });

  // Keep countdowns fresh.
  setInterval(render, 60000);

  render();
  post("ready");
})();
