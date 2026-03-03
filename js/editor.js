const MONACO_MODULE_URL = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm";

const LANGUAGE_BY_EXTENSION = new Map([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["json", "json"],
  ["css", "css"],
  ["html", "html"],
  ["md", "markdown"],
  ["py", "python"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["hpp", "cpp"],
  ["cc", "cpp"],
  ["java", "java"],
  ["go", "go"],
  ["rs", "rust"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["lua", "lua"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["xml", "xml"],
  ["toml", "ini"],
  ["ini", "ini"],
]);

const TOKEN_BREAK_CHARS = new Set([
  " ",
  "\t",
  "\r",
  "\n",
  "\"",
  "'",
  "`",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  ",",
]);

function getTabLabel(path) {
  if (!path) {
    return "untitled";
  }
  if (path.startsWith("untitled:")) {
    return path.slice("untitled:".length);
  }
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

function detectLanguage(path) {
  const label = getTabLabel(path);
  const dotIndex = label.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === label.length - 1) {
    return "plaintext";
  }
  const extension = label.slice(dotIndex + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) || "plaintext";
}

function dirname(path) {
  if (!path || !path.includes("/")) {
    return "";
  }
  return path.slice(0, path.lastIndexOf("/"));
}

function isRelativeToken(token) {
  if (!token) {
    return false;
  }
  if (/^[a-zA-Z]+:\/\//.test(token)) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(token)) {
    return false;
  }
  if (token.startsWith("/") || token.startsWith("#")) {
    return false;
  }
  if (!token.includes("/") && !token.includes(".")) {
    return false;
  }
  if (!/[A-Za-z_]/.test(token)) {
    return false;
  }
  if (!(token.startsWith("./") || token.startsWith("../") || token.includes("/"))) {
    return false;
  }
  return true;
}

function extractTokenAtColumn(line, column) {
  if (typeof line !== "string" || !line) {
    return "";
  }
  const clampedIndex = Math.max(0, Math.min(line.length - 1, column - 1));
  let start = clampedIndex;
  let end = clampedIndex;

  if (TOKEN_BREAK_CHARS.has(line[start]) && start > 0) {
    start -= 1;
    end -= 1;
  }

  while (start > 0 && !TOKEN_BREAK_CHARS.has(line[start - 1])) {
    start -= 1;
  }
  while (end < line.length && !TOKEN_BREAK_CHARS.has(line[end])) {
    end += 1;
  }

  return line.slice(start, end).replace(/[;:]+$/, "").trim();
}

function resolveRelativePath(basePath, token) {
  const pathToken = token.split(/[?#]/, 1)[0];
  if (!isRelativeToken(pathToken)) {
    return null;
  }

  const sourceSegments =
    basePath && !basePath.startsWith("untitled:")
      ? dirname(basePath).split("/").filter(Boolean)
      : [];
  const relativeSegments = pathToken.split("/");

  for (const segment of relativeSegments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (sourceSegments.length === 0) {
        return null;
      }
      sourceSegments.pop();
      continue;
    }
    sourceSegments.push(segment);
  }

  return sourceSegments.join("/");
}

export class EditorService {
  constructor(bus, options) {
    this.bus = bus;
    this.container = options.container;
    this.tabsContainer = options.tabsContainer;
    this.monaco = null;
    this.editor = null;
    this.models = new Map();
    this.openOrder = [];
    this.activePath = null;
    this.disposables = [];
    this.untitledCounter = 1;
  }

  async init() {
    this.monaco = await import(MONACO_MODULE_URL);
    this.monaco.editor.defineTheme("mandelogue-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#111111",
        "editorLineNumber.foreground": "#6d6d6d",
        "editorCursor.foreground": "#f5f5f5",
      },
    });

    this.editor = this.monaco.editor.create(this.container, {
      value: "",
      language: "plaintext",
      theme: "mandelogue-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "\"IBM Plex Mono\", Consolas, Menlo, monospace",
      fontSize: 13,
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: "selection",
      smoothScrolling: false,
      scrollBeyondLastLine: false,
    });

    this.disposables.push(
      this.editor.onDidChangeModelContent(() => {
        if (!this.activePath) {
          return;
        }
        const record = this.models.get(this.activePath);
        if (!record) {
          return;
        }
        record.dirty = true;
        this.renderTabs();
        this.emitActiveFileChanged();
      })
    );

    this.editor.addCommand(
      this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.KeyS,
      () => {
        this.bus.emit("keyboard-save-request");
      }
    );

    this.disposables.push(
      this.editor.onMouseDown((event) => {
        if (!event?.event?.leftButton) {
          return;
        }
        if (event.target.type !== this.monaco.editor.MouseTargetType.CONTENT_TEXT) {
          return;
        }
        if (!this.activePath) {
          return;
        }
        const model = this.editor.getModel();
        const position = event.target.position;
        if (!model || !position) {
          return;
        }

        const line = model.getLineContent(position.lineNumber);
        const token = extractTokenAtColumn(line, position.column);
        const resolvedPath = resolveRelativePath(this.activePath, token);
        if (!resolvedPath) {
          return;
        }

        this.bus.emit("editor-relative-link-clicked", {
          sourcePath: this.activePath,
          token,
          resolvedPath,
        });
      })
    );
  }

  openFile({ path, content, markDirty = false }) {
    let record = this.models.get(path);
    if (!record) {
      const model = this.monaco.editor.createModel(content ?? "", detectLanguage(path));
      record = { model, dirty: Boolean(markDirty) };
      this.models.set(path, record);
      this.openOrder.push(path);
    } else if (typeof content === "string" && record.model.getValue() !== content) {
      record.model.setValue(content);
      record.dirty = Boolean(markDirty);
    }

    this.setActiveFile(path);
  }

  createUntitledFile() {
    let candidate = `untitled:new-file-${this.untitledCounter}.txt`;
    while (this.models.has(candidate)) {
      this.untitledCounter += 1;
      candidate = `untitled:new-file-${this.untitledCounter}.txt`;
    }
    this.untitledCounter += 1;
    this.openFile({
      path: candidate,
      content: "",
      markDirty: true,
    });
    return candidate;
  }

  setActiveFile(path) {
    const record = this.models.get(path);
    if (!record) {
      return;
    }
    this.activePath = path;
    this.editor.setModel(record.model);
    this.editor.focus();
    this.renderTabs();
    this.emitActiveFileChanged();
  }

  renameFile(oldPath, newPath) {
    if (!this.models.has(oldPath)) {
      return;
    }
    const existing = this.models.get(oldPath);
    this.models.delete(oldPath);
    this.models.set(newPath, existing);

    const openIndex = this.openOrder.indexOf(oldPath);
    if (openIndex >= 0) {
      this.openOrder[openIndex] = newPath;
    }

    this.monaco.editor.setModelLanguage(existing.model, detectLanguage(newPath));
    if (this.activePath === oldPath) {
      this.activePath = newPath;
    }
    this.renderTabs();
    this.emitActiveFileChanged();
  }

  markSaved(path) {
    const record = this.models.get(path);
    if (!record) {
      return;
    }
    record.dirty = false;
    this.renderTabs();
    this.emitActiveFileChanged();
  }

  hasOpenFile(path) {
    return this.models.has(path);
  }

  getOpenPaths() {
    return [...this.openOrder];
  }

  getFileSnapshot(path) {
    const record = this.models.get(path);
    if (!record) {
      return null;
    }
    return {
      path,
      content: record.model.getValue(),
      dirty: record.dirty,
      label: getTabLabel(path),
    };
  }

  setFileContent(path, content, options = {}) {
    const record = this.models.get(path);
    if (!record) {
      return false;
    }
    const markDirty = options.markDirty === true;
    if (record.model.getValue() !== content) {
      record.model.setValue(content);
    }
    record.dirty = markDirty;
    this.renderTabs();
    this.emitActiveFileChanged();
    return true;
  }

  closeFile(path, options = {}) {
    const record = this.models.get(path);
    if (!record) {
      return { closed: false, reason: "missing" };
    }

    const force = options.force === true;
    if (record.dirty && !force) {
      return { closed: false, reason: "dirty", dirty: true };
    }

    const index = this.openOrder.indexOf(path);
    if (index >= 0) {
      this.openOrder.splice(index, 1);
    }
    this.models.delete(path);
    record.model.dispose();

    if (this.activePath === path) {
      const nextPath =
        this.openOrder[Math.max(0, index - 1)] || this.openOrder[0] || null;
      this.activePath = nextPath;
      if (nextPath) {
        const nextRecord = this.models.get(nextPath);
        if (nextRecord) {
          this.editor.setModel(nextRecord.model);
        }
      } else {
        this.editor.setModel(null);
      }
    }

    this.renderTabs();
    this.emitActiveFileChanged();
    return { closed: true, path };
  }

  closePathsMatching(predicate, options = {}) {
    const candidates = this.openOrder.filter((path) => predicate(path));
    for (const path of candidates) {
      this.closeFile(path, options);
    }
  }

  getActiveFile() {
    if (!this.activePath) {
      return null;
    }
    return this.getFileSnapshot(this.activePath);
  }

  undo() {
    if (!this.editor) {
      return;
    }
    this.editor.trigger("keyboard", "undo", null);
  }

  redo() {
    if (!this.editor) {
      return;
    }
    this.editor.trigger("keyboard", "redo", null);
  }

  renderTabs() {
    this.tabsContainer.innerHTML = "";
    for (const path of this.openOrder) {
      const record = this.models.get(path);
      if (!record) {
        continue;
      }

      const tab = document.createElement("div");
      tab.className = "editor-tab";
      tab.dataset.tabPath = path;
      if (path === this.activePath) {
        tab.classList.add("is-active");
      }
      if (record.dirty) {
        tab.classList.add("is-dirty");
      }

      const labelButton = document.createElement("button");
      labelButton.type = "button";
      labelButton.className = "editor-tab-main";
      labelButton.textContent = getTabLabel(path);
      labelButton.addEventListener("click", () => {
        this.setActiveFile(path);
      });
      tab.appendChild(labelButton);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "editor-tab-close";
      closeButton.textContent = "x";
      closeButton.setAttribute("aria-label", `Close ${getTabLabel(path)}`);
      closeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.bus.emit("editor-tab-close-request", { path });
      });
      tab.appendChild(closeButton);

      this.tabsContainer.appendChild(tab);
    }
  }

  emitActiveFileChanged() {
    this.bus.emit("active-file-changed", this.getActiveFile());
  }

  dispose() {
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch (error) {
        // Ignore dispose errors.
      }
    }
    this.disposables = [];

    for (const record of this.models.values()) {
      try {
        record.model.dispose();
      } catch (error) {
        // Ignore dispose errors.
      }
    }
    this.models.clear();

    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
  }
}
