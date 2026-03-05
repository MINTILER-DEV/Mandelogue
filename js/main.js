import { EditorService } from "./editor.js";
import { TerminalService } from "./terminal.js";
import { FileSystemService } from "./filesystem.js";
import { VMService } from "./vm.js";
import {
  PROJECT_TEMPLATES,
  createProjectTemplateFiles,
  getProjectTemplateById,
} from "./project-templates.js";
import { VmHttpProxyBridge } from "./vm-http-proxy.js";

class EventBus {
  constructor() {
    this.target = new EventTarget();
  }

  on(type, listener) {
    const wrapped = (event) => {
      listener(event.detail, event);
    };
    this.target.addEventListener(type, wrapped);
    return () => {
      this.target.removeEventListener(type, wrapped);
    };
  }

  emit(type, detail) {
    this.target.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

class TopbarManager {
  constructor(bus, options) {
    this.bus = bus;
    this.tabsContainer = options.tabsContainer;
    this.menusContainer = options.menusContainer;
    this.topbarLeft = options.topbarLeft;
    this.tabs = new Map();
    this.openTabId = null;
    this.boundDocumentClick = this.onDocumentClick.bind(this);
    this.boundWindowResize = this.onWindowResize.bind(this);
    document.addEventListener("click", this.boundDocumentClick);
    window.addEventListener("resize", this.boundWindowResize);
  }

  addTab({ id, label, items = [] }) {
    if (!id || this.tabs.has(id)) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "topbar-tab";
    button.textContent = label;
    button.dataset.tabId = id;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMenu(id);
    });

    const menu = document.createElement("div");
    menu.className = "topbar-menu";
    menu.dataset.tabId = id;
    this.populateMenu(menu, items);

    this.tabsContainer.appendChild(button);
    this.menusContainer.appendChild(menu);
    this.tabs.set(id, { button, menu });
  }

  createActionButton(item, className = "menu-item") {
    const itemButton = document.createElement("button");
    itemButton.type = "button";
    itemButton.className = className;
    itemButton.textContent = item.label;
    itemButton.disabled = Boolean(item.disabled);
    itemButton.addEventListener("click", async () => {
      this.closeMenus();
      try {
        if (typeof item.onSelect === "function") {
          await item.onSelect();
        }
      } catch (error) {
        this.bus.emit("status", {
          level: "error",
          message: error instanceof Error ? error.message : "Menu action failed.",
        });
      }
    });
    return itemButton;
  }

  parseCategoryGroups(items) {
    const hasHeading = Array.isArray(items) && items.some((item) => item && item.type === "heading");
    if (!hasHeading) {
      return [];
    }

    const groups = [];
    let current = null;

    for (const item of items) {
      if (!item) {
        continue;
      }
      if (item.type === "heading") {
        current = {
          label: item.label || "Category",
          actions: [],
        };
        groups.push(current);
        continue;
      }
      if (item.type === "separator") {
        current = null;
        continue;
      }
      if (!current) {
        const fallbackLabel = "General";
        const fallback =
          groups.length > 0 && groups[groups.length - 1].label === fallbackLabel
            ? groups[groups.length - 1]
            : (() => {
                const next = { label: fallbackLabel, actions: [] };
                groups.push(next);
                return next;
              })();
        current = fallback;
      }
      current.actions.push(item);
    }

    return groups.filter((group) => Array.isArray(group.actions) && group.actions.length > 0);
  }

  populateMenu(menu, items) {
    menu.innerHTML = "";
    const groups = this.parseCategoryGroups(items);
    if (groups.length === 0) {
      for (const item of items) {
        if (item.type === "separator") {
          const separator = document.createElement("div");
          separator.className = "menu-separator";
          menu.appendChild(separator);
          continue;
        }
        if (item.type === "heading") {
          const heading = document.createElement("div");
          heading.className = "menu-heading";
          heading.textContent = item.label || "";
          menu.appendChild(heading);
          continue;
        }
        menu.appendChild(this.createActionButton(item, "menu-item"));
      }
      return;
    }

    menu.classList.add("has-categories");
    const categoryList = document.createElement("div");
    categoryList.className = "menu-categories";

    for (const group of groups) {
      const categoryRow = document.createElement("div");
      categoryRow.className = "menu-category";

      const categoryButton = document.createElement("button");
      categoryButton.type = "button";
      categoryButton.className = "menu-category-button";
      const labelSpan = document.createElement("span");
      labelSpan.className = "menu-category-label";
      labelSpan.textContent = group.label;
      const chevronSpan = document.createElement("span");
      chevronSpan.className = "menu-category-chevron";
      chevronSpan.textContent = ">";
      categoryButton.append(labelSpan, chevronSpan);

      const categoryPanel = document.createElement("div");
      categoryPanel.className = "menu-category-panel";
      for (const action of group.actions) {
        categoryPanel.appendChild(this.createActionButton(action, "menu-item menu-sub-item"));
      }

      categoryRow.append(categoryButton, categoryPanel);
      categoryList.appendChild(categoryRow);
    }

    menu.appendChild(categoryList);
  }

  toggleMenu(tabId) {
    if (this.openTabId === tabId) {
      this.closeMenus();
      return;
    }
    this.closeMenus();
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    this.positionMenu(tab);
    tab.button.dataset.open = "true";
    tab.menu.dataset.open = "true";
    this.openTabId = tabId;
  }

  closeMenus() {
    for (const tab of this.tabs.values()) {
      tab.button.dataset.open = "false";
      tab.menu.dataset.open = "false";
    }
    this.openTabId = null;
  }

  positionMenu(tab) {
    const leftOffset = tab.button.offsetLeft;
    tab.menu.style.left = `${leftOffset}px`;
  }

  onDocumentClick(event) {
    if (!this.topbarLeft.contains(event.target)) {
      this.closeMenus();
    }
  }

  onWindowResize() {
    if (!this.openTabId) {
      return;
    }
    const openTab = this.tabs.get(this.openTabId);
    if (openTab) {
      this.positionMenu(openTab);
    }
  }

  dispose() {
    document.removeEventListener("click", this.boundDocumentClick);
    window.removeEventListener("resize", this.boundWindowResize);
  }
}

class ContextMenuManager {
  constructor() {
    this.menu = document.createElement("div");
    this.menu.className = "context-menu";
    document.body.appendChild(this.menu);
    this.boundDocumentPointerDown = this.onDocumentPointerDown.bind(this);
    this.boundWindowResize = this.hide.bind(this);
    this.boundWindowBlur = this.hide.bind(this);
    document.addEventListener("pointerdown", this.boundDocumentPointerDown);
    window.addEventListener("resize", this.boundWindowResize);
    window.addEventListener("blur", this.boundWindowBlur);
  }

  show(x, y, items) {
    this.menu.innerHTML = "";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "context-menu-item";
      button.textContent = item.label;
      button.disabled = Boolean(item.disabled);
      button.addEventListener("click", async () => {
        this.hide();
        if (item.disabled || typeof item.onSelect !== "function") {
          return;
        }
        await item.onSelect();
      });
      this.menu.appendChild(button);
    }

    this.menu.classList.add("is-open");
    this.menu.style.left = "0";
    this.menu.style.top = "0";
    const width = this.menu.offsetWidth;
    const height = this.menu.offsetHeight;
    const maxX = Math.max(0, window.innerWidth - width - 6);
    const maxY = Math.max(0, window.innerHeight - height - 6);
    this.menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
    this.menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  }

  hide() {
    this.menu.classList.remove("is-open");
  }

  onDocumentPointerDown(event) {
    if (!this.menu.contains(event.target)) {
      this.hide();
    }
  }

  dispose() {
    document.removeEventListener("pointerdown", this.boundDocumentPointerDown);
    window.removeEventListener("resize", this.boundWindowResize);
    window.removeEventListener("blur", this.boundWindowBlur);
    this.menu.remove();
  }
}

class DialogManager {
  constructor() {
    this.queue = Promise.resolve();
    this.isOpen = false;
  }

  enqueue(task) {
    const run = this.queue.then(() => task());
    this.queue = run.catch(() => {});
    return run;
  }

  show(options = {}) {
    return this.enqueue(() => this.openDialog(options));
  }

  alert(message, options = {}) {
    return this.show({
      ...options,
      type: "alert",
      message,
      choices: [{ label: options.okLabel || "OK", value: true, primary: true }],
    }).then(() => true);
  }

  confirm(message, options = {}) {
    return this.show({
      ...options,
      type: "confirm",
      message,
      choices: [
        { label: options.okLabel || "OK", value: true, primary: true },
        { label: options.cancelLabel || "Cancel", value: false },
      ],
      defaultValue: false,
    }).then((value) => Boolean(value));
  }

  prompt(message, defaultValue = "", options = {}) {
    return this.show({
      ...options,
      type: "prompt",
      message,
      inputValue: String(defaultValue ?? ""),
      choices: [
        { label: options.okLabel || "OK", value: "submit", primary: true },
        { label: options.cancelLabel || "Cancel", value: "cancel" },
      ],
    }).then((result) => {
      if (!result || result.choice !== "submit") {
        return null;
      }
      return typeof result.inputValue === "string" ? result.inputValue : "";
    });
  }

  choose(message, choices, options = {}) {
    const mappedChoices = Array.isArray(choices)
      ? choices.map((choice, index) => ({
          label: choice.label || `Option ${index + 1}`,
          value: Object.prototype.hasOwnProperty.call(choice, "value") ? choice.value : choice.label,
          primary: choice.primary === true,
        }))
      : [];
    if (mappedChoices.length === 0) {
      return Promise.resolve(null);
    }
    if (options.includeCancel !== false) {
      mappedChoices.push({
        label: options.cancelLabel || "Cancel",
        value: null,
      });
    }
    return this.show({
      ...options,
      type: "choice",
      message,
      choices: mappedChoices,
      defaultValue: null,
    });
  }

  openDialog(options = {}) {
    const title = String(options.title || "Mandelogue");
    const message = String(options.message || "");
    const type = String(options.type || "alert");
    const choices = Array.isArray(options.choices) ? options.choices : [];
    const defaultValue = options.defaultValue;

    return new Promise((resolve) => {
      this.isOpen = true;
      const overlay = document.createElement("div");
      overlay.className = "dialog-overlay";

      const modal = document.createElement("div");
      modal.className = "dialog-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");

      const heading = document.createElement("h2");
      heading.className = "dialog-title";
      heading.textContent = title;
      modal.appendChild(heading);

      const body = document.createElement("div");
      body.className = "dialog-message";
      body.textContent = message;
      modal.appendChild(body);

      let input = null;
      if (type === "prompt") {
        input = document.createElement("input");
        input.type = "text";
        input.className = "dialog-input";
        input.value = String(options.inputValue || "");
        if (options.placeholder) {
          input.placeholder = String(options.placeholder);
        }
        modal.appendChild(input);
      }

      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      modal.appendChild(actions);

      const close = (result) => {
        if (!this.isOpen) {
          return;
        }
        this.isOpen = false;
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        resolve(result);
      };

      const onKeyDown = (event) => {
        if (!this.isOpen) {
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          if (type === "prompt") {
            close({ choice: "cancel", inputValue: input ? input.value : "" });
            return;
          }
          close(defaultValue ?? null);
          return;
        }
        if (event.key === "Enter" && type === "prompt" && input) {
          event.preventDefault();
          close({ choice: "submit", inputValue: input.value });
        }
      };
      window.addEventListener("keydown", onKeyDown, true);

      for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dialog-button";
        if (choice.primary) {
          button.classList.add("is-primary");
        }
        button.textContent = choice.label;
        button.addEventListener("click", () => {
          if (type === "prompt") {
            close({
              choice: choice.value,
              inputValue: input ? input.value : "",
            });
            return;
          }
          close(choice.value);
        });
        actions.appendChild(button);
      }

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const firstButton = actions.querySelector(".dialog-button.is-primary") || actions.querySelector(".dialog-button");
      if (input) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      } else if (firstButton) {
        setTimeout(() => firstButton.focus(), 0);
      }
    });
  }
}

function normalizePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function dirname(path) {
  const normalized = normalizePath(path);
  if (!normalized || !normalized.includes("/")) {
    return "";
  }
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function getFileLabel(path) {
  if (!path) {
    return "No file open";
  }
  if (path.startsWith("untitled:")) {
    return path.slice("untitled:".length);
  }
  return path.split("/").pop() || path;
}

function getPathBasename(path) {
  const normalized = normalizePath(path);
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("/");
  return segments[segments.length - 1] || "";
}

const DEVICON_CDN_BASE = "https://cdn.jsdelivr.net/gh/devicons/devicon/icons";
const FALLBACK_FILE_ICON_URL = "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons/file-earmark-code.svg";
const FILE_ICON_URL_BY_EXTENSION = new Map([
  ["c", `${DEVICON_CDN_BASE}/c/c-original.svg`],
  ["h", `${DEVICON_CDN_BASE}/c/c-original.svg`],
  ["cpp", `${DEVICON_CDN_BASE}/cplusplus/cplusplus-original.svg`],
  ["cxx", `${DEVICON_CDN_BASE}/cplusplus/cplusplus-original.svg`],
  ["cc", `${DEVICON_CDN_BASE}/cplusplus/cplusplus-original.svg`],
  ["hpp", `${DEVICON_CDN_BASE}/cplusplus/cplusplus-original.svg`],
  ["hh", `${DEVICON_CDN_BASE}/cplusplus/cplusplus-original.svg`],
  ["rs", `${DEVICON_CDN_BASE}/rust/rust-original.svg`],
  ["py", `${DEVICON_CDN_BASE}/python/python-original.svg`],
  ["lua", `${DEVICON_CDN_BASE}/lua/lua-original.svg`],
  ["js", `${DEVICON_CDN_BASE}/javascript/javascript-original.svg`],
  ["mjs", `${DEVICON_CDN_BASE}/javascript/javascript-original.svg`],
  ["cjs", `${DEVICON_CDN_BASE}/javascript/javascript-original.svg`],
  ["ts", `${DEVICON_CDN_BASE}/typescript/typescript-original.svg`],
  ["tsx", `${DEVICON_CDN_BASE}/typescript/typescript-original.svg`],
  ["jsx", `${DEVICON_CDN_BASE}/react/react-original.svg`],
  ["java", `${DEVICON_CDN_BASE}/java/java-original.svg`],
  ["go", `${DEVICON_CDN_BASE}/go/go-original.svg`],
  ["cs", `${DEVICON_CDN_BASE}/csharp/csharp-original.svg`],
  ["php", `${DEVICON_CDN_BASE}/php/php-original.svg`],
  ["rb", `${DEVICON_CDN_BASE}/ruby/ruby-original.svg`],
  ["swift", `${DEVICON_CDN_BASE}/swift/swift-original.svg`],
  ["kt", `${DEVICON_CDN_BASE}/kotlin/kotlin-original.svg`],
  ["kts", `${DEVICON_CDN_BASE}/kotlin/kotlin-original.svg`],
  ["scala", `${DEVICON_CDN_BASE}/scala/scala-original.svg`],
  ["r", `${DEVICON_CDN_BASE}/r/r-original.svg`],
  ["dart", `${DEVICON_CDN_BASE}/dart/dart-original.svg`],
  ["zig", `${DEVICON_CDN_BASE}/zig/zig-original.svg`],
  ["sh", `${DEVICON_CDN_BASE}/bash/bash-original.svg`],
  ["bash", `${DEVICON_CDN_BASE}/bash/bash-original.svg`],
  ["zsh", `${DEVICON_CDN_BASE}/bash/bash-original.svg`],
  ["ps1", `${DEVICON_CDN_BASE}/powershell/powershell-original.svg`],
  ["html", `${DEVICON_CDN_BASE}/html5/html5-original.svg`],
  ["htm", `${DEVICON_CDN_BASE}/html5/html5-original.svg`],
  ["css", `${DEVICON_CDN_BASE}/css3/css3-original.svg`],
  ["scss", `${DEVICON_CDN_BASE}/sass/sass-original.svg`],
  ["sass", `${DEVICON_CDN_BASE}/sass/sass-original.svg`],
  ["sql", `${DEVICON_CDN_BASE}/azuresqldatabase/azuresqldatabase-original.svg`],
  ["xml", `${DEVICON_CDN_BASE}/html5/html5-original.svg`],
  ["json", `${DEVICON_CDN_BASE}/javascript/javascript-original.svg`],
  ["yaml", `${DEVICON_CDN_BASE}/yaml/yaml-original.svg`],
  ["yml", `${DEVICON_CDN_BASE}/yaml/yaml-original.svg`],
  ["toml", `${DEVICON_CDN_BASE}/toml/toml-original.svg`],
  ["md", `${DEVICON_CDN_BASE}/markdown/markdown-original.svg`],
]);

const FILE_ICON_URL_BY_NAME = new Map([
  ["dockerfile", `${DEVICON_CDN_BASE}/docker/docker-original.svg`],
  ["makefile", `${DEVICON_CDN_BASE}/cmake/cmake-original.svg`],
  ["cmakelists.txt", `${DEVICON_CDN_BASE}/cmake/cmake-original.svg`],
]);

function resolveFileIconUrl(path) {
  const normalized = normalizePath(path);
  const name = getPathBasename(normalized).toLowerCase();
  if (!name) {
    return FALLBACK_FILE_ICON_URL;
  }
  if (FILE_ICON_URL_BY_NAME.has(name)) {
    return FILE_ICON_URL_BY_NAME.get(name);
  }
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    const extension = name.slice(dotIndex + 1);
    if (FILE_ICON_URL_BY_EXTENSION.has(extension)) {
      return FILE_ICON_URL_BY_EXTENSION.get(extension);
    }
  }
  return FALLBACK_FILE_ICON_URL;
}

function createFileIconNode(path) {
  const icon = document.createElement("img");
  icon.className = "file-icon";
  icon.alt = "";
  icon.loading = "lazy";
  icon.decoding = "async";
  icon.referrerPolicy = "no-referrer";
  icon.src = resolveFileIconUrl(path);
  icon.addEventListener("error", () => {
    if (icon.src !== FALLBACK_FILE_ICON_URL) {
      icon.src = FALLBACK_FILE_ICON_URL;
    }
  });
  return icon;
}

function formatTopbarFileDisplay(activeFile) {
  if (!activeFile || !activeFile.label) {
    return "Mandelogue Web Editor";
  }
  return `Mandelogue Web Editor \u2022 [${activeFile.label}]`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
}

function basenameWithoutExtension(path) {
  const label = getFileLabel(path);
  const dotIndex = label.lastIndexOf(".");
  if (dotIndex <= 0) {
    return label || "a.out";
  }
  return label.slice(0, dotIndex);
}

function suggestRepoDirectory(input) {
  const match = String(input || "").trim().match(/\/([^/]+?)(?:\.git)?(?:[#?].*)?$/);
  if (!match) {
    return "repo";
  }
  return match[1] || "repo";
}

function parseGithubRepoReference(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^github\.com\//i, "https://github.com/");
  const match = normalized.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/|$)/i
  );
  if (!match) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    repoName: repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
  };
}

function base64ToBytes(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeBytesAsTextOrNull(bytes) {
  const sampleLength = Math.min(bytes.length, 512);
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] === 0) {
      return null;
    }
  }

  try {
    return new TextDecoder().decode(bytes);
  } catch (error) {
    return null;
  }
}

function renderExplorerTree(container, tree, onFileClick) {
  container.innerHTML = "";

  if (!tree) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "Open a folder or project to browse files.";
    container.appendChild(empty);
    return;
  }

  const rootList = document.createElement("ul");
  rootList.className = "tree-list root";
  rootList.appendChild(renderDirectoryNode(tree, onFileClick, true));
  container.appendChild(rootList);
}

function renderDirectoryNode(node, onFileClick, isRoot = false) {
  const listItem = document.createElement("li");
  const details = document.createElement("details");
  details.open = Boolean(isRoot);

  const summary = document.createElement("summary");
  summary.className = "tree-summary";
  summary.dataset.treeKind = "directory";
  summary.dataset.path = node.path || "";
  if (!isRoot) {
    summary.draggable = true;
  }
  const arrow = document.createElement("span");
  arrow.className = "tree-arrow";
  arrow.textContent = "▸";
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = node.name || "/";
  summary.append(arrow, label);
  details.appendChild(summary);

  const childrenList = document.createElement("ul");
  childrenList.className = "tree-list";
  if (isRoot) {
    childrenList.classList.add("root");
  }

  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    if (child.type === "directory") {
      childrenList.appendChild(renderDirectoryNode(child, onFileClick));
      continue;
    }

    const childItem = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-button";
    button.dataset.path = child.path;
    button.dataset.treeKind = "file";
    button.draggable = true;
    const icon = createFileIconNode(child.path);
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = child.name;
    button.append(icon, label);
    button.addEventListener("click", () => {
      onFileClick(child.path);
    });
    childItem.appendChild(button);
    childrenList.appendChild(childItem);
  }

  details.appendChild(childrenList);
  listItem.appendChild(details);
  return listItem;
}

function highlightExplorerFile(container, filePath) {
  const active = container.querySelector(".file-button.is-active");
  if (active) {
    active.classList.remove("is-active");
  }
  if (!filePath || filePath.startsWith("untitled:")) {
    return;
  }
  const button = container.querySelector(`.file-button[data-path="${CSS.escape(filePath)}"]`);
  if (button) {
    button.classList.add("is-active");
  }
}

function downloadTextFile(fileName, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function downloadBinaryFile(fileName, payload) {
  const blob = payload instanceof Blob ? payload : new Blob([payload], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

const ZSTD_WASM_WEB_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/index.web.js";
const ZSTD_WASM_BINARY_URL =
  "https://cdn.jsdelivr.net/npm/@bokuweb/zstd-wasm@0.0.27/dist/web/zstd.wasm";
let zstdWorker = null;
let zstdWorkerSeq = 0;
const zstdPendingRequests = new Map();
const ZSTD_WORKER_TIMEOUT_MS = 150000;

function getZstdWorker() {
  if (zstdWorker) {
    return zstdWorker;
  }
  const workerUrl = new URL("./zstd-worker.js", import.meta.url);
  zstdWorker = new Worker(workerUrl, { type: "module" });

  zstdWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    const id = data.id;
    if (!id || !zstdPendingRequests.has(id)) {
      return;
    }
    const pending = zstdPendingRequests.get(id);
    zstdPendingRequests.delete(id);
    if (!data.ok) {
      pending.reject(new Error(data.error || "zstd worker operation failed."));
      return;
    }
    const rawBuffer = data.buffer;
    const byteOffset = Number(data.byteOffset) || 0;
    const byteLength = Number(data.byteLength) || 0;
    if (!(rawBuffer instanceof ArrayBuffer) || byteLength <= 0) {
      pending.reject(new Error("zstd worker returned empty output."));
      return;
    }
    pending.resolve(rawBuffer.slice(byteOffset, byteOffset + byteLength));
  });

  zstdWorker.addEventListener("error", (event) => {
    const message = event?.message || "zstd worker crashed.";
    for (const pending of zstdPendingRequests.values()) {
      pending.reject(new Error(message));
    }
    zstdPendingRequests.clear();
    try {
      zstdWorker.terminate();
    } catch (error) {
      // Ignore terminate errors.
    }
    zstdWorker = null;
  });

  zstdWorker.postMessage({
    type: "init",
    moduleUrl: ZSTD_WASM_WEB_MODULE_URL,
    wasmUrl: ZSTD_WASM_BINARY_URL,
  });

  return zstdWorker;
}

async function runZstdWorkerOperation(operation, arrayBuffer, options = {}) {
  const worker = getZstdWorker();
  const requestId = `zstd_${Date.now().toString(36)}_${(zstdWorkerSeq += 1).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      zstdPendingRequests.delete(requestId);
      reject(new Error("zstd operation timed out."));
    }, ZSTD_WORKER_TIMEOUT_MS);

    zstdPendingRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    });
    worker.postMessage({
      id: requestId,
      operation,
      buffer: arrayBuffer,
      level: Number(options.level) || 1,
    });
  });
}

async function zstdCompressArrayBuffer(arrayBuffer, level = 1) {
  return runZstdWorkerOperation("compress", arrayBuffer, { level });
}

async function zstdDecompressArrayBuffer(arrayBuffer) {
  return runZstdWorkerOperation("decompress", arrayBuffer, {});
}

function disposeZstdWorker() {
  for (const pending of zstdPendingRequests.values()) {
    pending.reject(new Error("zstd worker disposed."));
  }
  zstdPendingRequests.clear();
  if (zstdWorker) {
    try {
      zstdWorker.terminate();
    } catch (error) {
      // Ignore terminate errors.
    }
    zstdWorker = null;
  }
}

async function gzipCompressArrayBuffer(arrayBuffer) {
  if (typeof CompressionStream !== "function") {
    throw new Error("Gzip compression is not supported by this browser.");
  }
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(new Uint8Array(arrayBuffer));
  await writer.close();
  return new Response(stream.readable).arrayBuffer();
}

async function gzipDecompressArrayBuffer(arrayBuffer) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Gzip decompression is not supported by this browser.");
  }
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(new Uint8Array(arrayBuffer));
  await writer.close();
  return new Response(stream.readable).arrayBuffer();
}

function startProgressTicker(bus, message, options = {}) {
  const initial = Number.isFinite(options.initial) ? options.initial : 10;
  const max = Number.isFinite(options.max) ? options.max : 92;
  let percent = Math.max(0, Math.min(max, initial));

  bus.emit("vm-progress", {
    message,
    percent,
    visible: true,
  });

  const timer = setInterval(() => {
    // Keep moving near the end instead of freezing at a hard cap.
    const remaining = Math.max(0, max - percent);
    const step = Math.max(0.25, remaining * 0.08);
    percent = Math.min(max, percent + step);
    bus.emit("vm-progress", {
      message,
      percent,
      visible: true,
    });
  }, 300);

  return () => {
    clearInterval(timer);
  };
}

async function bootstrap() {
  const bus = new EventBus();
  const dom = {
    app: document.getElementById("app"),
    topbarLeft: document.querySelector(".topbar-left"),
    topbarTabs: document.getElementById("topbar-tabs"),
    topbarMenus: document.getElementById("topbar-menus"),
    currentFileDisplay: document.getElementById("current-file-display"),
    statusDisplay: document.getElementById("status-display"),
    settingsRoot: document.querySelector(".settings-root"),
    settingsButton: document.getElementById("settings-button"),
    settingsMenu: document.getElementById("settings-menu"),
    settingsApply: document.getElementById("settings-apply"),
    settingsClose: document.getElementById("settings-close"),
    settingsPresetFast: document.getElementById("settings-preset-fast"),
    settingsPresetBalanced: document.getElementById("settings-preset-balanced"),
    settingsPresetFull: document.getElementById("settings-preset-full"),
    settingMaxMountFiles: document.getElementById("setting-max-mount-files"),
    settingMaxFileKb: document.getElementById("setting-max-file-kb"),
    settingMaxTotalMb: document.getElementById("setting-max-total-mb"),
    settingSyncInterval: document.getElementById("setting-sync-interval"),
    settingVmBatchCmds: document.getElementById("setting-vm-batch-cmds"),
    settingVmB64Chunk: document.getElementById("setting-vm-b64-chunk"),
    explorer: document.getElementById("explorer"),
    editorTabs: document.getElementById("editor-tabs"),
    editorHost: document.getElementById("editor"),
    terminalPanel: document.getElementById("terminal-panel"),
    terminalHost: document.getElementById("terminal"),
    terminalResizeHandle: document.getElementById("terminal-resize-handle"),
    vmProgress: document.getElementById("vm-progress"),
    vmProgressText: document.getElementById("vm-progress-text"),
    vmProgressFill: document.getElementById("vm-progress-fill"),
    bottomVm: document.getElementById("bottom-vm"),
    bottomFolder: document.getElementById("bottom-folder"),
    bottomTabs: document.getElementById("bottom-tabs"),
    bottomMount: document.getElementById("bottom-mount"),
    bottomMountText: document.getElementById("bottom-mount-text"),
    bottomMountFill: document.getElementById("bottom-mount-fill"),
    bottomTerminal: document.getElementById("bottom-terminal"),
    rightSidebar: document.getElementById("right-sidebar"),
    rightDevtoolsToggle: document.getElementById("right-devtools-toggle"),
    devtoolsPanel: document.getElementById("devtools-panel"),
    devtoolsClose: document.getElementById("devtools-close"),
    devtoolsClear: document.getElementById("devtools-clear"),
    devtoolsCommandLog: document.getElementById("devtools-command-log"),
    vmScreen: document.getElementById("vm-screen"),
  };

  const topbar = new TopbarManager(bus, {
    tabsContainer: dom.topbarTabs,
    menusContainer: dom.topbarMenus,
    topbarLeft: dom.topbarLeft,
  });
  const contextMenu = new ContextMenuManager();
  const dialogs = new DialogManager();

  const editor = new EditorService(bus, {
    container: dom.editorHost,
    tabsContainer: dom.editorTabs,
  });

  const terminal = new TerminalService(bus, {
    container: dom.terminalHost,
    panelElement: dom.terminalPanel,
    resizeHandle: dom.terminalResizeHandle,
    layoutElement: dom.app,
  });

  const filesystem = new FileSystemService(bus);
  const vm = new VMService(bus, {
    screenContainer: dom.vmScreen,
    config: {
      memoryMb: 512,
      vgaMemoryMb: 16,
      enableSnapshots: true,
      autoLoadDefaultSnapshot: true,
      defaultSnapshotKey: "default",
    },
  });
  const vmHttpProxy = new VmHttpProxyBridge(bus, vm, {
    defaultPort: 8080,
    requestTimeoutMs: 45000,
  });

  const disposables = [];
  let statusTimer = null;
  let vmProgressTimer = null;
  let vmToHostSyncTimer = null;
  let vmToHostSyncRunning = false;
  let vmToHostSyncStartedAt = 0;
  let vmToHostSyncErrorShown = false;
  let vmKnownPaths = new Set();
  let currentMlpFileName = "project.mlp";
  let lastTerminalInputAt = Date.now();
  let terminalBusyUntil = 0;
  let vmToHostSyncIntervalMs = 12000;
  const VM_TO_HOST_IDLE_MS = 2500;
  const VM_TO_HOST_POST_INPUT_COOLDOWN_MS = 12000;
  const VM_TO_HOST_POST_ENTER_COOLDOWN_MS = 30000;
  const SETTINGS_STORAGE_KEY = "mandelogue.settings.v1";
  const DEVTOOLS_MAX_LOG_ENTRIES = 220;
  const bottomState = {
    vmMessage: "waiting...",
    terminalRows: null,
    terminalCols: null,
    autoSyncText: "Sync: idle",
  };
  let devtoolsOpen = false;
  let devtoolsLogEntries = [];
  const autoSyncSkipCounts = new Map();
  const mountOverlayState = {
    visible: false,
    downloadProcessed: 0,
    downloadTotal: 0,
    readProcessed: 0,
    readTotal: 0,
    writeProcessed: 0,
    writeTotal: 0,
    phase: "idle",
  };
  const SETTINGS_PRESETS = {
    fast: {
      maxMountFiles: 1000,
      maxMountFileBytes: 512 * 1024,
      maxMountTotalBytes: 16 * 1024 * 1024,
      syncIntervalSeconds: 20,
      mountBatchCommandLimit: 20,
      mountBase64ChunkSize: 512,
    },
    balanced: {
      maxMountFiles: 2000,
      maxMountFileBytes: 768 * 1024,
      maxMountTotalBytes: 32 * 1024 * 1024,
      syncIntervalSeconds: 12,
      mountBatchCommandLimit: 24,
      mountBase64ChunkSize: 768,
    },
    full: {
      maxMountFiles: 5000,
      maxMountFileBytes: 2 * 1024 * 1024,
      maxMountTotalBytes: 160 * 1024 * 1024,
      syncIntervalSeconds: 8,
      mountBatchCommandLimit: 36,
      mountBase64ChunkSize: 1024,
    },
  };

  dom.currentFileDisplay.textContent = formatTopbarFileDisplay(editor.getActiveFile());

  const refreshExplorer = () => {
    renderExplorerTree(dom.explorer, filesystem.getTree(), openFileInEditor);
    const active = editor.getActiveFile();
    highlightExplorerFile(dom.explorer, active ? active.path : "");
  };

  const setStatus = (level, message, holdMs = 3200) => {
    if (!message) {
      return;
    }
    dom.statusDisplay.textContent = message;
    dom.statusDisplay.dataset.level = level || "info";
    if (statusTimer) {
      clearTimeout(statusTimer);
    }
    if (holdMs > 0) {
      statusTimer = setTimeout(() => {
        dom.statusDisplay.textContent = "";
        dom.statusDisplay.dataset.level = "info";
      }, holdMs);
    }
  };

  const formatAutoSyncReason = (reason) => {
    const map = {
      "no-folder": "no workspace",
      busy: "already running",
      "terminal-active": "terminal active",
      "terminal-cooldown": "terminal busy",
      "background-unavailable": "bg channel unavailable",
      "background-not-ready": "bg channel not ready",
      mounting: "mount in progress",
      "shell-busy": "shell busy",
      "vm-not-ready": "vm not ready",
      error: "error",
      ok: "ok",
      "no-changes": "ok no changes",
      started: "running",
    };
    return map[reason] || String(reason || "unknown");
  };

  const updateAutoSyncDebug = (state, reason = "", source = "auto") => {
    const normalizedState = String(state || "skip");
    const normalizedReason = String(reason || "");
    const key = `${normalizedState}:${normalizedReason}`;
    const previous = autoSyncSkipCounts.get(key) || 0;
    autoSyncSkipCounts.set(key, previous + 1);
    const counter = autoSyncSkipCounts.get(key);
    const label = normalizedState === "skip" ? "skip" : normalizedState;
    const reasonText = normalizedReason ? ` ${formatAutoSyncReason(normalizedReason)}` : "";
    const sourceText = source === "manual" ? "manual" : "auto";
    bottomState.autoSyncText = `Sync(${sourceText}): ${label}${reasonText} [${counter}]`;
    renderBottomBar();
  };

  const renderBottomBar = () => {
    if (!dom.bottomVm || !dom.bottomFolder || !dom.bottomTabs || !dom.bottomTerminal) {
      return;
    }
    const active = editor.getActiveFile();
    const tabCount = editor.getOpenPaths().length;
    const activeText = active ? ` | Active: ${active.label}${active.dirty ? " *" : ""}` : "";
    dom.bottomVm.textContent = `VM: ${bottomState.vmMessage || "..."}`;
    dom.bottomFolder.textContent = `Folder: ${
      filesystem.hasOpenFolder() ? filesystem.getRootName() : "none"
    }`;
    dom.bottomTabs.textContent = `Tabs: ${tabCount}${activeText}`;
    const syncSuffix = bottomState.autoSyncText ? ` | ${bottomState.autoSyncText}` : "";
    if (
      Number.isFinite(bottomState.terminalCols) &&
      Number.isFinite(bottomState.terminalRows)
    ) {
      dom.bottomTerminal.textContent = `Term: ${bottomState.terminalCols}x${bottomState.terminalRows}${syncSuffix}`;
    } else {
      dom.bottomTerminal.textContent = `Term: -${syncSuffix}`;
    }
  };

  const setDevtoolsOpen = (open) => {
    devtoolsOpen = open === true;
    if (dom.app) {
      dom.app.dataset.devtoolsOpen = devtoolsOpen ? "true" : "false";
    }
    if (dom.devtoolsPanel) {
      dom.devtoolsPanel.dataset.open = devtoolsOpen ? "true" : "false";
      dom.devtoolsPanel.setAttribute("aria-hidden", devtoolsOpen ? "false" : "true");
    }
    if (dom.rightDevtoolsToggle) {
      dom.rightDevtoolsToggle.setAttribute("aria-expanded", devtoolsOpen ? "true" : "false");
    }
  };

  const formatClockTime = (stamp) => {
    const date = new Date(Number(stamp) || Date.now());
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  const appendDevtoolsLog = (entry) => {
    if (!entry || !dom.devtoolsCommandLog) {
      return;
    }
    const channel = String(entry.channel || "internal");
    const summary = String(entry.summary || "").trim();
    if (!summary) {
      return;
    }
    devtoolsLogEntries.push({
      ts: Number(entry.ts) || Date.now(),
      channel,
      summary,
    });
    if (devtoolsLogEntries.length > DEVTOOLS_MAX_LOG_ENTRIES) {
      devtoolsLogEntries = devtoolsLogEntries.slice(devtoolsLogEntries.length - DEVTOOLS_MAX_LOG_ENTRIES);
    }
  };

  const renderDevtoolsLog = () => {
    if (!dom.devtoolsCommandLog) {
      return;
    }
    if (devtoolsLogEntries.length === 0) {
      dom.devtoolsCommandLog.innerHTML = '<div class="devtools-log-empty">No internal VM commands yet.</div>';
      return;
    }
    const atBottom =
      dom.devtoolsCommandLog.scrollTop + dom.devtoolsCommandLog.clientHeight >=
      dom.devtoolsCommandLog.scrollHeight - 14;
    const html = devtoolsLogEntries
      .map((entry) => {
        const time = formatClockTime(entry.ts);
        const channel = escapeHtml(entry.channel);
        const summary = escapeHtml(entry.summary);
        return `<div class="devtools-log-entry"><div class="devtools-log-meta">[${time}] [${channel}]</div><div class="devtools-log-command">${summary}</div></div>`;
      })
      .join("");
    dom.devtoolsCommandLog.innerHTML = html;
    if (atBottom || devtoolsOpen) {
      dom.devtoolsCommandLog.scrollTop = dom.devtoolsCommandLog.scrollHeight;
    }
  };

  const clampPositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  };

  const clampVmChunkSize = (value, fallback) => {
    const parsed = clampPositiveInt(value, fallback);
    return Math.max(128, Math.min(2048, parsed));
  };

  const clampVmBatchCommandLimit = (value, fallback) => {
    const parsed = clampPositiveInt(value, fallback);
    return Math.max(8, Math.min(64, parsed));
  };

  const getCurrentRuntimeSettings = () => {
    const fsConfig = filesystem.getConfigSnapshot();
    const vmTuning = vm.getMountTuning();
    return {
      maxMountFiles: fsConfig.maxMountFiles,
      maxMountFileBytes: fsConfig.maxMountFileBytes,
      maxMountTotalBytes: fsConfig.maxMountTotalBytes,
      syncIntervalSeconds: Math.max(2, Math.floor(vmToHostSyncIntervalMs / 1000)),
      mountBatchCommandLimit: vmTuning.mountBatchCommandLimit,
      mountBase64ChunkSize: vmTuning.mountBase64ChunkSize,
    };
  };

  const saveSettingsToStorage = (settings) => {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // Ignore storage failures.
    }
  };

  const loadSettingsFromStorage = () => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return parsed;
    } catch (error) {
      return null;
    }
  };

  const applyRuntimeSettings = (settings, options = {}) => {
    const fsDefaults = filesystem.getConfigSnapshot();
    const vmDefaults = vm.getMountTuning();
    const normalized = {
      maxMountFiles: clampPositiveInt(settings.maxMountFiles, fsDefaults.maxMountFiles),
      maxMountFileBytes: clampPositiveInt(settings.maxMountFileBytes, fsDefaults.maxMountFileBytes),
      maxMountTotalBytes: clampPositiveInt(settings.maxMountTotalBytes, fsDefaults.maxMountTotalBytes),
      syncIntervalSeconds: Math.max(
        2,
        clampPositiveInt(settings.syncIntervalSeconds, Math.max(2, Math.floor(vmToHostSyncIntervalMs / 1000)))
      ),
      mountBatchCommandLimit: clampVmBatchCommandLimit(
        settings.mountBatchCommandLimit,
        vmDefaults.mountBatchCommandLimit
      ),
      mountBase64ChunkSize: clampVmChunkSize(
        settings.mountBase64ChunkSize,
        vmDefaults.mountBase64ChunkSize
      ),
    };

    filesystem.updateConfig({
      maxMountFiles: normalized.maxMountFiles,
      maxMountFileBytes: normalized.maxMountFileBytes,
      maxMountTotalBytes: normalized.maxMountTotalBytes,
    });
    vm.updateMountTuning({
      mountBatchCommandLimit: normalized.mountBatchCommandLimit,
      mountBase64ChunkSize: normalized.mountBase64ChunkSize,
    });

    vmToHostSyncIntervalMs = normalized.syncIntervalSeconds * 1000;
    if (options.restartSync !== false && filesystem.hasOpenFolder()) {
      startVmToHostAutoSync();
    }

    return normalized;
  };

  const fillSettingsInputs = (settings) => {
    if (dom.settingMaxMountFiles) {
      dom.settingMaxMountFiles.value = String(settings.maxMountFiles);
    }
    if (dom.settingMaxFileKb) {
      dom.settingMaxFileKb.value = String(Math.max(1, Math.floor(settings.maxMountFileBytes / 1024)));
    }
    if (dom.settingMaxTotalMb) {
      dom.settingMaxTotalMb.value = String(
        Math.max(1, Math.floor(settings.maxMountTotalBytes / (1024 * 1024)))
      );
    }
    if (dom.settingSyncInterval) {
      dom.settingSyncInterval.value = String(settings.syncIntervalSeconds);
    }
    if (dom.settingVmBatchCmds) {
      dom.settingVmBatchCmds.value = String(settings.mountBatchCommandLimit);
    }
    if (dom.settingVmB64Chunk) {
      dom.settingVmB64Chunk.value = String(settings.mountBase64ChunkSize);
    }
  };

  const readSettingsInputs = () => {
    const current = getCurrentRuntimeSettings();
    return {
      maxMountFiles: clampPositiveInt(dom.settingMaxMountFiles?.value, current.maxMountFiles),
      maxMountFileBytes:
        clampPositiveInt(dom.settingMaxFileKb?.value, Math.max(1, Math.floor(current.maxMountFileBytes / 1024))) *
        1024,
      maxMountTotalBytes:
        clampPositiveInt(
          dom.settingMaxTotalMb?.value,
          Math.max(1, Math.floor(current.maxMountTotalBytes / (1024 * 1024)))
        ) *
        1024 *
        1024,
      syncIntervalSeconds: clampPositiveInt(dom.settingSyncInterval?.value, current.syncIntervalSeconds),
      mountBatchCommandLimit: clampVmBatchCommandLimit(
        dom.settingVmBatchCmds?.value,
        current.mountBatchCommandLimit
      ),
      mountBase64ChunkSize: clampVmChunkSize(
        dom.settingVmB64Chunk?.value,
        current.mountBase64ChunkSize
      ),
    };
  };

  const sanitizeRuntimeSettings = (settings) => {
    return {
      ...settings,
      mountBatchCommandLimit: clampVmBatchCommandLimit(
        settings.mountBatchCommandLimit,
        getCurrentRuntimeSettings().mountBatchCommandLimit
      ),
      mountBase64ChunkSize: clampVmChunkSize(
        settings.mountBase64ChunkSize,
        getCurrentRuntimeSettings().mountBase64ChunkSize
      ),
    };
  };

  const setSettingsMenuOpen = (open) => {
    if (!dom.settingsMenu) {
      return;
    }
    dom.settingsMenu.dataset.open = open ? "true" : "false";
  };

  const renderMountOverlay = () => {
    if (!dom.bottomMount || !dom.bottomMountText || !dom.bottomMountFill) {
      return;
    }

    if (!mountOverlayState.visible) {
      dom.bottomMount.dataset.open = "false";
      dom.bottomMount.setAttribute("aria-hidden", "true");
      dom.bottomMountText.textContent = "Mount idle";
      dom.bottomMountFill.style.width = "0%";
      return;
    }

    dom.bottomMount.dataset.open = "true";
    dom.bottomMount.setAttribute("aria-hidden", "false");

    let message = "Preparing file list...";
    let percent = 0;
    if (mountOverlayState.phase === "downloading") {
      message = `Downloading repository ${mountOverlayState.downloadProcessed}/${mountOverlayState.downloadTotal}`;
      if (mountOverlayState.downloadTotal > 0) {
        percent =
          (mountOverlayState.downloadProcessed / mountOverlayState.downloadTotal) * 100;
      }
    } else if (mountOverlayState.phase === "importing") {
      message = `Writing files to device ${mountOverlayState.downloadProcessed}/${mountOverlayState.downloadTotal}`;
      if (mountOverlayState.downloadTotal > 0) {
        percent =
          (mountOverlayState.downloadProcessed / mountOverlayState.downloadTotal) * 100;
      }
    } else if (mountOverlayState.phase === "reading") {
      message = `Reading files ${mountOverlayState.readProcessed}/${mountOverlayState.readTotal}`;
      if (mountOverlayState.readTotal > 0) {
        percent = (mountOverlayState.readProcessed / mountOverlayState.readTotal) * 18;
      }
    } else if (mountOverlayState.phase === "writing") {
      message = `Writing to VM ${mountOverlayState.writeProcessed}/${mountOverlayState.writeTotal}`;
      if (mountOverlayState.writeTotal > 0) {
        percent = 18 + (mountOverlayState.writeProcessed / mountOverlayState.writeTotal) * 80;
      } else {
        percent = 18;
      }
    } else if (mountOverlayState.phase === "finalizing") {
      message = "Finalizing mount...";
      percent = 99;
    }
    dom.bottomMountText.textContent = message;
    dom.bottomMountFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  };

  const setVmProgress = ({ message, percent = null, visible = true, autoHideMs = 0 }) => {
    if (!dom.vmProgress || !dom.vmProgressText || !dom.vmProgressFill) {
      return;
    }

    if (vmProgressTimer) {
      clearTimeout(vmProgressTimer);
      vmProgressTimer = null;
    }

    const wasCollapsed = dom.vmProgress.classList.contains("is-collapsed");

    if (!visible) {
      dom.vmProgress.classList.add("is-collapsed");
      dom.vmProgress.setAttribute("aria-hidden", "true");
      if (!wasCollapsed) {
        bus.emit("terminal-layout-changed");
      }
      return;
    }

    dom.vmProgress.classList.remove("is-collapsed");
    dom.vmProgress.removeAttribute("aria-hidden");
    if (wasCollapsed) {
      bus.emit("terminal-layout-changed");
    }
    dom.vmProgressText.textContent = message || "VM loading...";
    bottomState.vmMessage = message || bottomState.vmMessage;
    renderBottomBar();
    const hasPercent = Number.isFinite(percent);
    if (hasPercent) {
      const clamped = Math.max(0, Math.min(100, percent));
      dom.vmProgressFill.classList.remove("is-indeterminate");
      dom.vmProgressFill.style.width = `${clamped}%`;
    } else {
      dom.vmProgressFill.classList.add("is-indeterminate");
      dom.vmProgressFill.style.width = "32%";
    }

    if (autoHideMs > 0) {
      vmProgressTimer = setTimeout(() => {
        dom.vmProgress.classList.add("is-collapsed");
        dom.vmProgress.setAttribute("aria-hidden", "true");
        bus.emit("terminal-layout-changed");
      }, autoHideMs);
    }
  };

  const syncOpenEditorsFromBytes = (path, bytes) => {
    if (!editor.hasOpenFile(path)) {
      return;
    }
    const snapshot = editor.getFileSnapshot(path);
    if (!snapshot || snapshot.dirty) {
      return;
    }
    const text = decodeBytesAsTextOrNull(bytes);
    if (text === null || text === snapshot.content) {
      return;
    }
    editor.setFileContent(path, text, { markDirty: false });
  };

  const performVmToHostSync = async (options = {}) => {
    const announceNoChanges = options.announceNoChanges === true;
    const force = options.force === true;
    const source = options.source === "manual" ? "manual" : "auto";
    const sharedFsMode =
      typeof vm.supportsSharedFilesystem === "function" && vm.supportsSharedFilesystem();
    if (!filesystem.hasOpenFolder()) {
      updateAutoSyncDebug("skip", "no-folder", source);
      return { skipped: "no-folder" };
    }
    if (!force && mountOverlayState.visible) {
      updateAutoSyncDebug("skip", "mounting", source);
      return { skipped: "mounting" };
    }
    if (
      !sharedFsMode &&
      source === "auto" &&
      typeof vm.supportsBackgroundChannel === "function" &&
      !vm.supportsBackgroundChannel()
    ) {
      updateAutoSyncDebug("skip", "background-unavailable", source);
      return { skipped: "background-unavailable" };
    }
    if (
      !sharedFsMode &&
      source === "auto" &&
      typeof vm.supportsBackgroundChannel === "function" &&
      vm.supportsBackgroundChannel() &&
      typeof vm.isBackgroundChannelReady === "function" &&
      !vm.isBackgroundChannelReady()
    ) {
      updateAutoSyncDebug("skip", "background-not-ready", source);
      return { skipped: "background-not-ready" };
    }
    if (vmToHostSyncRunning) {
      updateAutoSyncDebug("skip", "busy", source);
      return { skipped: "busy" };
    }
    if (!sharedFsMode && !force && Date.now() - lastTerminalInputAt < VM_TO_HOST_IDLE_MS) {
      updateAutoSyncDebug("skip", "terminal-active", source);
      return { skipped: "terminal-active" };
    }
    if (!sharedFsMode && !force && Date.now() < terminalBusyUntil) {
      updateAutoSyncDebug("skip", "terminal-cooldown", source);
      return { skipped: "terminal-cooldown" };
    }
    if (
      !sharedFsMode &&
      !force &&
      typeof vm.isLikelyAtPrompt === "function" &&
      !vm.isLikelyAtPrompt(2500)
    ) {
      // Avoid probing during background auto sync because it can contend with long-running user commands.
      if ((source === "manual" || force) && typeof vm.probeShellReady === "function") {
        await vm.probeShellReady(2600);
      }
      if (typeof vm.isLikelyAtPrompt === "function" && !vm.isLikelyAtPrompt(2500)) {
        updateAutoSyncDebug("skip", "shell-busy", source);
        return { skipped: "shell-busy" };
      }
    }

    updateAutoSyncDebug("state", "started", source);
    vmToHostSyncRunning = true;
    vmToHostSyncStartedAt = Date.now();
    try {
      const rootName = filesystem.getRootName();
      const exportedFiles = await vm.exportFolderSnapshot(rootName);
      const nextPaths = new Set();
      let createdCount = 0;
      let updatedCount = 0;
      let deletedCount = 0;

      for (const entry of exportedFiles) {
        const relativePath = normalizePath(entry.relativePath);
        if (!relativePath) {
          continue;
        }
        if (filesystem.getMountIgnoreReason(relativePath)) {
          continue;
        }

        nextPaths.add(relativePath);
        const bytes = base64ToBytes(entry.base64 || "");
        const existed = filesystem.hasFileHandle(relativePath);
        await filesystem.writeFileBytes(relativePath, bytes);
        syncOpenEditorsFromBytes(relativePath, bytes);
        if (existed) {
          updatedCount += 1;
        } else {
          createdCount += 1;
        }
      }

      for (const previousPath of vmKnownPaths) {
        if (nextPaths.has(previousPath)) {
          continue;
        }
        if (!filesystem.hasFileHandle(previousPath)) {
          continue;
        }
        const snapshot = editor.getFileSnapshot(previousPath);
        if (snapshot && snapshot.dirty) {
          continue;
        }
        try {
          const removedType = await filesystem.removeEntry(previousPath, { recursive: false });
          if (removedType === "file") {
            editor.closeFile(previousPath, { force: true });
            deletedCount += 1;
          }
        } catch (error) {
          // Ignore transient remove failures.
        }
      }

      vmKnownPaths = nextPaths;
      if (createdCount > 0 || deletedCount > 0) {
        refreshExplorer();
      }
      if (createdCount > 0 || updatedCount > 0 || deletedCount > 0) {
        setStatus(
          "info",
            `Synced VM -> device (+${createdCount} ~${updatedCount} -${deletedCount})`,
            1400
          );
        updateAutoSyncDebug("ok", "ok", source);
      } else if (announceNoChanges) {
        setStatus("info", "Synced VM -> device (no changes).", 1200);
        updateAutoSyncDebug("ok", "no-changes", source);
      } else {
        updateAutoSyncDebug("ok", "no-changes", source);
      }
      vmToHostSyncErrorShown = false;
      return {
        skipped: null,
        createdCount,
        updatedCount,
        deletedCount,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("not ready") || error.message.toLowerCase().includes("cancelled"))
      ) {
        updateAutoSyncDebug("skip", "vm-not-ready", source);
        return { skipped: "vm-not-ready" };
      }
      if (!vmToHostSyncErrorShown) {
        bus.emit("status", {
          level: "error",
          message: error instanceof Error ? error.message : "VM -> device sync failed.",
        });
        vmToHostSyncErrorShown = true;
      }
      updateAutoSyncDebug("skip", "error", source);
      return { skipped: "error" };
    } finally {
      vmToHostSyncRunning = false;
      vmToHostSyncStartedAt = 0;
    }
  };

  const resetVmToHostSyncState = () => {
    if (vmToHostSyncTimer) {
      clearInterval(vmToHostSyncTimer);
      vmToHostSyncTimer = null;
    }
    vmToHostSyncRunning = false;
    vmToHostSyncStartedAt = 0;
    vmToHostSyncErrorShown = false;
    vmKnownPaths = new Set();
    autoSyncSkipCounts.clear();
    bottomState.autoSyncText = "Sync: idle";
  };

  const startVmToHostAutoSync = () => {
    if (vmToHostSyncTimer) {
      clearInterval(vmToHostSyncTimer);
    }
    performVmToHostSync({ source: "auto" });
    vmToHostSyncTimer = setInterval(() => {
      performVmToHostSync({ source: "auto" });
    }, vmToHostSyncIntervalMs);
  };

  const pickSingleFile = async (accept = "") => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) {
      input.accept = accept;
    }
    const file = await new Promise((resolve) => {
      input.addEventListener(
        "change",
        () => {
          resolve(input.files && input.files[0] ? input.files[0] : null);
        },
        { once: true }
      );
      input.click();
    });
    return file || null;
  };

  const activateWorkspace = (result, options = {}) => {
    renderExplorerTree(dom.explorer, result.tree, openFileInEditor);
    renderBottomBar();
    vm.setWorkingDirectory(result.rootName);
    resetVmToHostSyncState();
    startVmToHostAutoSync();
    if (options.autoMount !== false) {
      mountFolderToVm().catch((error) => {
        bus.emit("status", {
          level: "error",
          message: error instanceof Error ? error.message : "Failed to mount workspace into VM.",
        });
      });
    }
  };

  const storedSettings = loadSettingsFromStorage();
  if (storedSettings) {
    const appliedFromStorage = applyRuntimeSettings(storedSettings, { restartSync: false });
    fillSettingsInputs(appliedFromStorage);
  } else {
    fillSettingsInputs(getCurrentRuntimeSettings());
  }
  setSettingsMenuOpen(false);
  setDevtoolsOpen(false);
  renderDevtoolsLog();

  const openFileInEditor = async (relativePath) => {
    const normalizedPath = normalizePath(relativePath);
    if (editor.hasOpenFile(normalizedPath)) {
      editor.setActiveFile(normalizedPath);
      return;
    }

    try {
      const content = await filesystem.readFile(normalizedPath);
      editor.openFile({
        path: normalizedPath,
        content,
        markDirty: false,
      });
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not open file.",
      });
    }
  };

  const saveFile = async (pathOverride = null) => {
    const requestedPath = pathOverride ? normalizePath(pathOverride) : null;
    let snapshot = requestedPath
      ? editor.getFileSnapshot(requestedPath)
      : editor.getActiveFile();

    if (!snapshot && requestedPath && filesystem.hasOpenFolder() && filesystem.hasFileHandle(requestedPath)) {
      const diskContent = await filesystem.readFile(requestedPath);
      snapshot = {
        path: requestedPath,
        content: diskContent,
        dirty: false,
        label: getFileLabel(requestedPath),
      };
    }

    if (!snapshot) {
      bus.emit("status", {
        level: "error",
        message: "No file available to save.",
      });
      return null;
    }

    let targetPath = snapshot.path;
    let targetContent = snapshot.content;

    if (targetPath.startsWith("untitled:")) {
      if (filesystem.hasOpenFolder()) {
        const requested = await dialogs.prompt("Save file as", getFileLabel(targetPath), {
          title: "Save File",
          placeholder: "path/to/file.ext",
        });
        if (!requested) {
          return null;
        }
        targetPath = await filesystem.createFile(normalizePath(requested));
        editor.renameFile(snapshot.path, targetPath);
        snapshot = editor.getFileSnapshot(targetPath) || snapshot;
        targetContent = snapshot.content;
      } else {
        const fileName = getFileLabel(targetPath);
        downloadTextFile(fileName, targetContent);
        editor.markSaved(targetPath);
        bus.emit("status", {
          level: "info",
          message: `Downloaded ${fileName}`,
        });
        return targetPath;
      }
    }

    if (editor.hasOpenFile(targetPath)) {
      const latest = editor.getFileSnapshot(targetPath);
      if (latest) {
        targetContent = latest.content;
      }
    }

    if (filesystem.hasOpenFolder()) {
      await filesystem.writeFile(targetPath, targetContent);
      if (editor.hasOpenFile(targetPath)) {
        editor.markSaved(targetPath);
      }
      await vm.syncSingleFile(filesystem.getRootName(), targetPath, targetContent);
      refreshExplorer();
      bus.emit("status", {
        level: "info",
        message: `Saved ${targetPath}`,
      });
      return targetPath;
    }

    downloadTextFile(getFileLabel(targetPath), targetContent);
    if (editor.hasOpenFile(targetPath)) {
      editor.markSaved(targetPath);
    }
    bus.emit("status", {
      level: "info",
      message: `Downloaded ${getFileLabel(targetPath)}`,
    });
    return targetPath;
  };

  const requestCloseTab = async (path) => {
    const snapshot = editor.getFileSnapshot(path);
    if (!snapshot) {
      return false;
    }

    if (snapshot.dirty) {
      const shouldSave = await dialogs.confirm(`Save changes to ${snapshot.label} before closing?`, {
        title: "Unsaved Changes",
        okLabel: "Save",
        cancelLabel: "Don't Save",
      });
      if (shouldSave) {
        const savedPath = await saveFile(path);
        if (!savedPath) {
          return false;
        }
        if (savedPath !== path && editor.hasOpenFile(savedPath)) {
          editor.closeFile(savedPath, { force: true });
          return true;
        }
      } else {
        const shouldDiscard = await dialogs.confirm(`Close ${snapshot.label} without saving changes?`, {
          title: "Discard Changes",
          okLabel: "Discard",
          cancelLabel: "Cancel",
        });
        if (!shouldDiscard) {
          return false;
        }
      }
    }

    editor.closeFile(path, { force: true });
    return true;
  };

  const closeTabsInOrder = async (paths) => {
    if (!Array.isArray(paths) || paths.length === 0) {
      return;
    }
    for (const path of paths) {
      if (!editor.hasOpenFile(path)) {
        continue;
      }
      const closed = await requestCloseTab(path);
      if (!closed) {
        break;
      }
    }
  };

  const createFileAt = async (baseDirectory = "") => {
    if (!filesystem.hasOpenFolder()) {
      editor.createUntitledFile();
      bus.emit("status", {
        level: "info",
        message: "Created unsaved file tab.",
      });
      return;
    }

    const base = normalizePath(baseDirectory);
    const suggestion = base ? `${base}/new-file.txt` : "new-file.txt";
    const rawName = await dialogs.prompt("New file path", suggestion, {
      title: "New File",
      placeholder: "path/to/file.txt",
    });
    if (!rawName) {
      return;
    }
    const createdPath = await filesystem.createFile(normalizePath(rawName));
    refreshExplorer();
    editor.openFile({
      path: createdPath,
      content: "",
      markDirty: false,
    });
    await vm.syncSingleFile(filesystem.getRootName(), createdPath, "");
    bus.emit("status", {
      level: "info",
      message: `Created ${createdPath}`,
    });
  };

  const createFolderAt = async (baseDirectory = "") => {
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder or project before creating subfolders.",
      });
      return;
    }

    const base = normalizePath(baseDirectory);
    const suggestion = base ? `${base}/new-folder` : "new-folder";
    const rawName = await dialogs.prompt("New folder path", suggestion, {
      title: "New Folder",
      placeholder: "path/to/folder",
    });
    if (!rawName) {
      return;
    }

    const createdPath = await filesystem.createFolder(normalizePath(rawName));
    refreshExplorer();
    await vm.createDirectory(filesystem.getRootName(), createdPath);
    bus.emit("status", {
      level: "info",
      message: `Created folder ${createdPath}`,
    });
  };

  const removeEntry = async (relativePath, kind) => {
    const normalizedPath = normalizePath(relativePath);
    if (!normalizedPath) {
      return;
    }

    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder or project before removing entries.",
      });
      return;
    }

    const label = getFileLabel(normalizedPath);
    const confirmed = await dialogs.confirm(`Remove ${label}?`, {
      title: "Remove Entry",
      okLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      return;
    }

    const removedType = await filesystem.removeEntry(normalizedPath, { recursive: true });
    if (removedType === "file") {
      editor.closeFile(normalizedPath, { force: true });
    } else {
      editor.closePathsMatching(
        (path) => path === normalizedPath || path.startsWith(`${normalizedPath}/`),
        { force: true }
      );
    }
    await vm.removePath(filesystem.getRootName(), normalizedPath, removedType === "directory");
    refreshExplorer();
    bus.emit("status", {
      level: "info",
      message: `Removed ${normalizedPath}`,
    });
  };

  const applyLocalPathRenameState = (sourcePath, targetPath, type) => {
    if (type === "file") {
      if (editor.hasOpenFile(sourcePath)) {
        editor.renameFile(sourcePath, targetPath);
      }
      if (vmKnownPaths.has(sourcePath)) {
        vmKnownPaths.delete(sourcePath);
        vmKnownPaths.add(targetPath);
      }
      return;
    }

    const prefix = `${sourcePath}/`;
    const openPaths = editor.getOpenPaths();
    for (const openPath of openPaths) {
      if (openPath === sourcePath || openPath.startsWith(prefix)) {
        const suffix = openPath === sourcePath ? "" : openPath.slice(prefix.length);
        const renamedPath = suffix ? `${targetPath}/${suffix}` : targetPath;
        if (editor.hasOpenFile(openPath)) {
          editor.renameFile(openPath, renamedPath);
        }
      }
    }
    const nextKnownPaths = new Set();
    for (const knownPath of vmKnownPaths) {
      if (knownPath === sourcePath || knownPath.startsWith(prefix)) {
        const suffix = knownPath === sourcePath ? "" : knownPath.slice(prefix.length);
        nextKnownPaths.add(suffix ? `${targetPath}/${suffix}` : targetPath);
        continue;
      }
      nextKnownPaths.add(knownPath);
    }
    vmKnownPaths = nextKnownPaths;
  };

  const renameWorkspacePath = async (sourcePath, targetPath, options = {}) => {
    const normalizedSource = normalizePath(sourcePath);
    const normalizedTarget = normalizePath(targetPath);
    if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
      return false;
    }
    if (normalizedTarget.split("/").some((segment) => segment === "..")) {
      bus.emit("status", {
        level: "error",
        message: "Path cannot contain '..' segments.",
      });
      return false;
    }

    const statusVerb = options.statusVerb || "Renamed";
    const vmFailureMessage = options.vmFailureMessage || `${statusVerb} locally, but VM rename failed.`;
    try {
      const result = await filesystem.renameEntry(normalizedSource, normalizedTarget);
      applyLocalPathRenameState(normalizedSource, normalizedTarget, result.type);

      try {
        await vm.renamePath(filesystem.getRootName(), normalizedSource, normalizedTarget);
      } catch (error) {
        bus.emit("status", {
          level: "error",
          message: error instanceof Error ? error.message : vmFailureMessage,
        });
      }

      refreshExplorer();
      bus.emit("status", {
        level: "info",
        message: `${statusVerb} ${getFileLabel(normalizedSource)} to ${getFileLabel(normalizedTarget)}`,
      });
      return true;
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : `${statusVerb} failed.`,
      });
      return false;
    }
  };

  const renameEntry = async (relativePath, kind) => {
    const sourcePath = normalizePath(relativePath);
    if (!sourcePath) {
      return;
    }
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder or project before renaming entries.",
      });
      return;
    }

    const rawTarget = await dialogs.prompt(`Rename ${kind} path`, sourcePath, {
      title: "Rename",
      placeholder: "new/path",
    });
    if (rawTarget === null) {
      return;
    }
    const targetPath = normalizePath(rawTarget);
    if (!targetPath) {
      bus.emit("status", {
        level: "error",
        message: "Rename path must not be empty.",
      });
      return;
    }
    await renameWorkspacePath(sourcePath, targetPath, {
      statusVerb: "Renamed",
      vmFailureMessage: "Renamed locally, but VM rename failed.",
    });
  };

  const moveEntryToDirectory = async (relativePath, destinationDirectory) => {
    const sourcePath = normalizePath(relativePath);
    if (!sourcePath || !filesystem.hasOpenFolder()) {
      return false;
    }
    const destination = normalizePath(destinationDirectory);
    const sourceName = getPathBasename(sourcePath);
    if (!sourceName) {
      return false;
    }
    const targetPath = destination ? `${destination}/${sourceName}` : sourceName;
    if (sourcePath === targetPath) {
      return false;
    }
    if (targetPath.startsWith(`${sourcePath}/`)) {
      bus.emit("status", {
        level: "error",
        message: "Cannot move a folder into itself.",
      });
      return false;
    }
    return renameWorkspacePath(sourcePath, targetPath, {
      statusVerb: "Moved",
      vmFailureMessage: "Moved locally, but VM move failed.",
    });
  };

  const mountFolderToVm = async () => {
    if (!filesystem.hasOpenFolder()) {
      return;
    }
    const rootName = filesystem.getRootName();
    if (typeof vm.probeShellReady === "function") {
      await vm.probeShellReady(2600);
    }
    setStatus("info", `Mounting ${rootName} into VM...`, 1800);
    mountOverlayState.visible = true;
    mountOverlayState.phase = "reading";
    mountOverlayState.downloadProcessed = 0;
    mountOverlayState.downloadTotal = 0;
    mountOverlayState.readProcessed = 0;
    mountOverlayState.readTotal = 0;
    mountOverlayState.writeProcessed = 0;
    mountOverlayState.writeTotal = 0;
    renderMountOverlay();

    try {
      const { files, skipped, total } = await filesystem.collectMountableFiles();
      const ignoredCount = skipped.filter((item) =>
        typeof item.reason === "string" && item.reason.startsWith("Ignored by")
      ).length;
      const failedCount = skipped.length - ignoredCount;

      mountOverlayState.readProcessed = Number.isFinite(total) ? total : mountOverlayState.readProcessed;
      mountOverlayState.readTotal = Number.isFinite(total) ? total : mountOverlayState.readTotal;
      mountOverlayState.phase = "writing";
      mountOverlayState.writeTotal = files.length;
      mountOverlayState.writeProcessed = 0;
      renderMountOverlay();

      if (files.length > 0) {
        await vm.mountFolder(rootName, files);
        setStatus("info", `Mounted ${files.length} files into VM`, 2600);
        vmKnownPaths = new Set(files.map((entry) => entry.relativePath));
      } else {
        vm.setWorkingDirectory(rootName);
        setStatus("info", `Opened empty folder in VM: ${rootName}`, 2600);
        vmKnownPaths = new Set();
      }
      if (ignoredCount > 0) {
        setStatus("info", `Ignored ${ignoredCount} generated/cache file(s) during VM mount.`, 3200);
      }
      if (failedCount > 0) {
        setStatus("error", `Mount skipped ${failedCount} file(s) due to limits or read errors.`, 3400);
      }
      mountOverlayState.phase = "finalizing";
      mountOverlayState.writeProcessed = mountOverlayState.writeTotal;
      renderMountOverlay();
    } finally {
      setTimeout(() => {
        mountOverlayState.visible = false;
        mountOverlayState.phase = "idle";
        renderMountOverlay();
      }, 220);
    }
  };

  const saveVmSnapshot = async () => {
    try {
      await vm.saveSnapshot("default");
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not save VM snapshot.",
      });
    }
  };

  const loadVmSnapshot = async () => {
    try {
      const loaded = await vm.loadSnapshot("default");
      if (!loaded) {
        bus.emit("status", {
          level: "error",
          message: "No local default VM snapshot found.",
        });
      }
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not load VM snapshot.",
      });
    }
  };

  const clearVmSnapshot = async () => {
    const confirmed = await dialogs.confirm("Delete the local default VM snapshot?", {
      title: "Delete Snapshot",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      return;
    }
    try {
      await vm.clearSnapshot("default");
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not remove VM snapshot.",
      });
    }
  };

  const downloadVmSnapshot = async () => {
    const mode = await dialogs.choose(
      "Download snapshot format",
      [
        {
          label: "Compressed (.bin.zst) (Recommended)",
          value: "compressed",
          primary: true,
        },
        {
          label: "Raw (.bin)",
          value: "raw",
        },
      ],
      {
        title: "Download VM Snapshot",
      }
    );
    if (!mode) {
      return;
    }

    try {
      bus.emit("vm-progress", {
        message: "VM: preparing snapshot download...",
        percent: 5,
        visible: true,
      });
      const stateBuffer = await vm.exportSnapshotBuffer();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let payload = stateBuffer;
      let fileName = `mandelogue-vm-snapshot-${stamp}.bin`;

      if (mode === "compressed") {
        let stopTicker = startProgressTicker(bus, "VM: compressing snapshot (zstd)...", {
          initial: 18,
          max: 90,
        });
        try {
          payload = await zstdCompressArrayBuffer(stateBuffer, 1);
          fileName = `mandelogue-vm-snapshot-${stamp}.bin.zst`;
          stopTicker();
          bus.emit("vm-progress", {
            message: "VM: compression complete. Starting download...",
            percent: 95,
            visible: true,
          });
        } catch (compressionError) {
          stopTicker();
          const compressionMessage =
            compressionError instanceof Error ? compressionError.message : "zstd compression failed";
          bus.emit("status", {
            level: "info",
            message: `Zstd compression unavailable (${compressionMessage}). Trying gzip...`,
          });
          stopTicker = startProgressTicker(bus, "VM: compressing snapshot (gzip)...", {
            initial: 18,
            max: 88,
          });
          try {
            payload = await gzipCompressArrayBuffer(stateBuffer);
            fileName = `mandelogue-vm-snapshot-${stamp}.bin.gz`;
            stopTicker();
            bus.emit("vm-progress", {
              message: "VM: compression complete. Starting download...",
              percent: 95,
              visible: true,
            });
          } catch (gzipError) {
            stopTicker();
            bus.emit("status", {
              level: "info",
              message: "Compression unavailable. Downloading raw snapshot instead.",
            });
            payload = stateBuffer;
            fileName = `mandelogue-vm-snapshot-${stamp}.bin`;
          }
        }
      }

      downloadBinaryFile(fileName, payload);
      bus.emit("status", {
        level: "info",
        message: `Downloaded VM snapshot (${Math.round((payload.byteLength || 0) / 1024)} KB).`,
      });
      bus.emit("vm-progress", {
        message: "VM: snapshot download ready.",
        percent: 100,
        visible: true,
        autoHideMs: 1400,
      });
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not download VM snapshot.",
      });
      bus.emit("vm-progress", {
        message: "VM: snapshot download failed.",
        percent: 100,
        visible: true,
        autoHideMs: 2200,
      });
    }
  };

  const uploadVmSnapshot = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin,.state,.snapshot,.gz,.zst,.zstd,.bin.gz,.bin.zst,.bin.zstd,application/octet-stream";

    const file = await new Promise((resolve) => {
      input.addEventListener(
        "change",
        () => {
          resolve(input.files && input.files[0] ? input.files[0] : null);
        },
        { once: true }
      );
      input.click();
    });

    if (!file) {
      return;
    }

    try {
      let buffer = await file.arrayBuffer();
      const lowerName = String(file.name || "").toLowerCase();

      if (lowerName.endsWith(".gz") || lowerName.endsWith(".bin.gz")) {
        const stopTicker = startProgressTicker(
          bus,
          `VM: decompressing ${file.name} (gzip)...`,
          {
            initial: 18,
            max: 82,
          }
        );
        try {
          buffer = await gzipDecompressArrayBuffer(buffer);
        } finally {
          stopTicker();
        }
      } else if (
        lowerName.endsWith(".zst") ||
        lowerName.endsWith(".zstd") ||
        lowerName.endsWith(".bin.zst") ||
        lowerName.endsWith(".bin.zstd")
      ) {
        const stopTicker = startProgressTicker(
          bus,
          `VM: decompressing ${file.name} (zstd)...`,
          {
            initial: 18,
            max: 82,
          }
        );
        try {
          buffer = await zstdDecompressArrayBuffer(buffer);
        } finally {
          stopTicker();
        }
      }

      bus.emit("vm-progress", {
        message: `VM: importing ${file.name}...`,
        percent: 70,
        visible: true,
      });
      await vm.importSnapshotBuffer(buffer, { sourceLabel: file.name || "snapshot file" });
      bus.emit("vm-progress", {
        message: "VM: snapshot upload complete.",
        percent: 100,
        visible: true,
        autoHideMs: 1400,
      });
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not upload VM snapshot.",
      });
      bus.emit("vm-progress", {
        message: "VM: snapshot upload failed.",
        percent: 100,
        visible: true,
        autoHideMs: 2200,
      });
    }
  };

  const syncVmToHostNow = async () => {
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder or project before syncing VM changes.",
      });
      return;
    }
    const result = await performVmToHostSync({
      announceNoChanges: true,
      force: true,
      source: "manual",
    });
    if (result && result.skipped === "busy") {
      const elapsed = vmToHostSyncStartedAt > 0 ? Date.now() - vmToHostSyncStartedAt : 0;
      if (elapsed > 7000 && typeof vm.cancelActiveCapture === "function") {
        vm.cancelActiveCapture("Stale VM sync cancelled for manual retry.");
        await new Promise((resolve) => setTimeout(resolve, 250));
        await performVmToHostSync({
          announceNoChanges: true,
          force: true,
          source: "manual",
        });
        return;
      }
      setStatus("info", "Sync already running.", 1200);
    }
  };

  const ensureMlpFileName = (name) => {
    const trimmed = String(name || "").trim() || "mandelogue-project";
    return trimmed.toLowerCase().endsWith(".mlp") ? trimmed : `${trimmed}.mlp`;
  };

  const saveWorkspaceAsMlp = async (suggestedName = "") => {
    if (!filesystem.hasOpenFolder()) {
      setStatus("error", "Open a folder or project before saving .mlp.", 2400);
      return false;
    }
    try {
      const payload = await filesystem.exportMlpPayload();
      const fileName = ensureMlpFileName(
        suggestedName || currentMlpFileName || `${filesystem.getRootName() || "project"}.mlp`
      );
      downloadTextFile(fileName, JSON.stringify(payload, null, 2));
      currentMlpFileName = fileName;
      setStatus("info", `Downloaded ${fileName}`, 2200);
      return true;
    } catch (error) {
      setStatus(
        "error",
        error instanceof Error ? error.message : "Could not save Mandelogue project.",
        3200
      );
      return false;
    }
  };

  const createMandelogueProject = async () => {
    const projectNameInput = await dialogs.prompt("Mandelogue project name", "Mandelogue Project", {
      title: "New Mandelogue Project",
      placeholder: "Project name",
    });
    if (projectNameInput === null) {
      return;
    }
    const projectName = String(projectNameInput || "").trim() || "Mandelogue Project";
    const result = filesystem.createEmptyProject(projectName);
    currentMlpFileName = ensureMlpFileName(projectName);
    activateWorkspace(result);
    setStatus("info", `Created Mandelogue project ${projectName}`, 2400);
  };

  const createProjectFromTemplate = async () => {
    const templateChoice = await dialogs.choose(
      "Choose a project template",
      PROJECT_TEMPLATES.map((template, index) => ({
        label: template.label,
        value: template.id,
        primary: index === 0,
      })),
      {
        title: "New Project from Template",
      }
    );
    if (!templateChoice) {
      return;
    }

    const template = getProjectTemplateById(templateChoice);
    if (!template) {
      setStatus("error", "Unknown project template selected.", 2400);
      return;
    }

    const suggestedName = template.defaultProjectName || template.label || "New Project";
    const nameInput = await dialogs.prompt("Project name", suggestedName, {
      title: `${template.label} Name`,
      placeholder: "Project name",
    });
    if (nameInput === null) {
      return;
    }
    const projectName = String(nameInput || "").trim() || suggestedName;
    const files = createProjectTemplateFiles(template.id);
    const result = filesystem.openProject(projectName, files);
    currentMlpFileName = ensureMlpFileName(projectName);
    activateWorkspace(result);
    if (template.preferredOpenFile && filesystem.hasFileHandle(template.preferredOpenFile)) {
      openFileInEditor(template.preferredOpenFile);
    }
    setStatus("info", `Created ${template.label}: ${projectName}`, 2600);
  };

  const openMandelogueProject = async () => {
    const file = await pickSingleFile(".mlp,application/json,text/plain");
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = filesystem.openMlpPayload(payload);
      currentMlpFileName = ensureMlpFileName(file.name || payload.rootName || "project");
      activateWorkspace(result);
      setStatus("info", `Opened Mandelogue project ${result.rootName}`, 2400);
    } catch (error) {
      setStatus(
        "error",
        error instanceof Error ? error.message : "Could not open Mandelogue project.",
        3400
      );
    }
  };

  const fetchGithubRepositoryFiles = async (repoRef, branchName, progressCallback = null) => {
    const owner = repoRef.owner;
    const repo = repoRef.repo;
    const branch = String(branchName || "").trim();
    if (!branch) {
      throw new Error("Branch name is required.");
    }
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(
      branch
    )}?recursive=1`;
    const treeResponse = await fetch(treeUrl, {
      headers: {
        Accept: "application/vnd.github+json",
      },
    });
    if (!treeResponse.ok) {
      throw new Error(`GitHub tree request failed (${treeResponse.status}).`);
    }
    const treePayload = await treeResponse.json();
    const blobs = Array.isArray(treePayload.tree)
      ? treePayload.tree.filter((entry) => entry && entry.type === "blob" && typeof entry.path === "string")
      : [];
    if (treePayload.truncated) {
      throw new Error("Repository tree is too large for unauthenticated GitHub API import.");
    }
    if (blobs.length === 0) {
      return [];
    }
    if (blobs.length > 1200) {
      throw new Error(`Repository has ${blobs.length} files. Import limit is 1200 files.`);
    }
    if (progressCallback) {
      progressCallback({
        stage: "downloading",
        processed: 0,
        total: blobs.length,
      });
    }

    const branchPath = encodeURIComponent(branch);

    const files = [];
    for (let index = 0; index < blobs.length; index += 1) {
      const blob = blobs[index];
      const relativePath = normalizePath(blob.path);
      if (!relativePath) {
        continue;
      }
      if (blob.size > 2 * 1024 * 1024) {
        continue;
      }

      const encodedRelativePath = relativePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branchPath}/${encodedRelativePath}`;
      const fileResponse = await fetch(rawUrl);
      if (!fileResponse.ok) {
        continue;
      }
      const bytes = new Uint8Array(await fileResponse.arrayBuffer());
      files.push({
        relativePath,
        bytes,
      });

      if (progressCallback) {
        progressCallback({
          stage: "downloading",
          processed: index + 1,
          total: blobs.length,
        });
      }

      if ((index + 1) % 40 === 0 || index + 1 === blobs.length) {
        setStatus("info", `Fetching GitHub repository files ${index + 1}/${blobs.length}`, 900);
      }
    }
    return files;
  };

  const importGithubRepository = async () => {
    const repoInput = await dialogs.prompt(
      "GitHub repository URL",
      "https://github.com/owner/repo",
      {
        title: "Import GitHub Repository",
        placeholder: "https://github.com/owner/repo",
      }
    );
    if (!repoInput) {
      return;
    }
    const repoRef = parseGithubRepoReference(repoInput);
    if (!repoRef) {
      setStatus("error", "Use a valid GitHub repository URL.", 3000);
      return;
    }

    const destination = await dialogs.choose(
      "Where should this repository be imported?",
      [
        { label: "Device Folder", value: "device", primary: true },
        { label: "Mandelogue Project (.mlp)", value: "mlp" },
      ],
      {
        title: "Import Destination",
      }
    );
    if (!destination) {
      return;
    }

    let defaultBranch = "main";
    try {
      const repoMetaResponse = await fetch(`https://api.github.com/repos/${repoRef.owner}/${repoRef.repo}`, {
        headers: {
          Accept: "application/vnd.github+json",
        },
      });
      if (repoMetaResponse.ok) {
        const repoMeta = await repoMetaResponse.json();
        if (typeof repoMeta.default_branch === "string" && repoMeta.default_branch.trim()) {
          defaultBranch = repoMeta.default_branch.trim();
        }
      }
    } catch (error) {
      // Fall back to "main" if metadata lookup fails.
    }

    const branchInput = await dialogs.prompt("Branch or tag", defaultBranch, {
      title: "Import Branch",
      placeholder: "main",
    });
    if (branchInput === null) {
      return;
    }
    const selectedBranch = String(branchInput || "").trim() || defaultBranch;

    setStatus("info", `Fetching repository ${repoRef.owner}/${repoRef.repo}...`, 1200);
    mountOverlayState.visible = true;
    mountOverlayState.phase = "downloading";
    mountOverlayState.downloadProcessed = 0;
    mountOverlayState.downloadTotal = 0;
    mountOverlayState.readProcessed = 0;
    mountOverlayState.readTotal = 0;
    mountOverlayState.writeProcessed = 0;
    mountOverlayState.writeTotal = 0;
    renderMountOverlay();
    let repositoryFiles = [];
    try {
      repositoryFiles = await fetchGithubRepositoryFiles(
        repoRef,
        selectedBranch,
        ({ processed, total }) => {
          mountOverlayState.visible = true;
          mountOverlayState.phase = "downloading";
          mountOverlayState.downloadProcessed = Number.isFinite(processed) ? processed : 0;
          mountOverlayState.downloadTotal = Number.isFinite(total) ? total : 0;
          renderMountOverlay();
        }
      );
    } catch (error) {
      setStatus(
        "error",
        error instanceof Error ? error.message : "Failed to fetch repository.",
        3600
      );
      mountOverlayState.visible = false;
      mountOverlayState.phase = "idle";
      renderMountOverlay();
      return;
    }

    if (repositoryFiles.length === 0) {
      setStatus("error", "No files were imported from this repository.", 3200);
      mountOverlayState.visible = false;
      mountOverlayState.phase = "idle";
      renderMountOverlay();
      return;
    }

    if (destination === "device") {
      if (!filesystem.isDeviceFolderMode()) {
        const pickFolder = await dialogs.confirm(
          "Choose a device folder to import this repository into?",
          {
            title: "Device Folder Required",
            okLabel: "Choose Folder",
            cancelLabel: "Cancel",
          }
        );
        if (!pickFolder) {
          mountOverlayState.visible = false;
          mountOverlayState.phase = "idle";
          renderMountOverlay();
          return;
        }
        try {
          const opened = await filesystem.openFolder();
          activateWorkspace(opened, { autoMount: false });
        } catch (error) {
          setStatus(
            "error",
            error instanceof Error ? error.message : "Could not open device folder.",
            3400
          );
          mountOverlayState.visible = false;
          mountOverlayState.phase = "idle";
          renderMountOverlay();
          return;
        }
      }

      const suggestedPrefix = suggestRepoDirectory(repoRef.canonicalUrl);
      const importPrefixInput = await dialogs.prompt(
        "Import subfolder path inside current device folder",
        suggestedPrefix,
        {
          title: "Device Import Path",
          placeholder: "repo-folder",
        }
      );
      if (importPrefixInput === null) {
        mountOverlayState.visible = false;
        mountOverlayState.phase = "idle";
        renderMountOverlay();
        return;
      }
      const importPrefix = normalizePath(importPrefixInput || suggestedPrefix);
      if (importPrefix.split("/").some((segment) => segment === "..")) {
        setStatus("error", "Import path cannot contain '..' segments.", 3200);
        mountOverlayState.visible = false;
        mountOverlayState.phase = "idle";
        renderMountOverlay();
        return;
      }

      for (let index = 0; index < repositoryFiles.length; index += 1) {
        const entry = repositoryFiles[index];
        const targetPath = importPrefix ? `${importPrefix}/${entry.relativePath}` : entry.relativePath;
        await filesystem.writeFileBytes(targetPath, entry.bytes);
        mountOverlayState.visible = true;
        mountOverlayState.phase = "importing";
        mountOverlayState.downloadProcessed = index + 1;
        mountOverlayState.downloadTotal = repositoryFiles.length;
        renderMountOverlay();
        if ((index + 1) % 60 === 0 || index + 1 === repositoryFiles.length) {
          setStatus("info", `Writing files to device ${index + 1}/${repositoryFiles.length}`, 900);
        }
      }

      refreshExplorer();
      mountFolderToVm().catch((error) => {
        setStatus(
          "error",
          error instanceof Error ? error.message : "Failed to mount imported files.",
          3200
        );
      });
      setStatus("info", `Imported ${repositoryFiles.length} files into device folder.`, 2600);
      return;
    }

    const projectName = suggestRepoDirectory(repoRef.canonicalUrl);
    const opened = filesystem.openProject(
      projectName,
      repositoryFiles.map((entry) => ({
        relativePath: entry.relativePath,
        bytes: entry.bytes,
      }))
    );
    currentMlpFileName = ensureMlpFileName(projectName);
    activateWorkspace(opened);
    setStatus("info", `Imported ${repositoryFiles.length} files into Mandelogue project.`, 2600);

    const saveMlpNow = await dialogs.confirm("Download this project as an .mlp file now?", {
      title: "Save Mandelogue Project",
      okLabel: "Download .mlp",
      cancelLabel: "Later",
    });
    if (saveMlpNow) {
      await saveWorkspaceAsMlp(currentMlpFileName);
    }
  };

  const testVmInternet = async () => {
    bottomState.vmMessage = "Testing VM internet";
    renderBottomBar();
    bus.emit("terminal-output", {
      data: "[tools] Testing VM internet connectivity...\r\n",
    });

    try {
      const result = await vm.testInternetConnection();
      if (result.output) {
        const outputWithCrlf = result.output.replace(/\r?\n/g, "\r\n");
        bus.emit("terminal-output", {
          data: outputWithCrlf.endsWith("\r\n") ? outputWithCrlf : `${outputWithCrlf}\r\n`,
        });
      }
      const summary = `[tools] Internet test ${result.ok ? "passed" : "failed"} (ping: ${result.ping}, dns: ${result.dns}, http: ${result.http})`;
      bus.emit("terminal-output", { data: `${summary}\r\n` });
      setStatus(result.ok ? "info" : "error", summary, result.ok ? 2400 : 3600);
      bottomState.vmMessage = result.ok ? "VM internet OK" : "VM internet check failed";
      renderBottomBar();
    } catch (error) {
      const message = error instanceof Error ? error.message : "VM internet test failed.";
      bus.emit("terminal-output", {
        data: `[tools] Internet test error: ${message}\r\n`,
      });
      setStatus("error", message, 3400);
      bottomState.vmMessage = "VM internet check failed";
      renderBottomBar();
    }
  };

  const enableVmHttpProxy = async () => {
    const ready = await vmHttpProxy.init();
    if (!ready) {
      setStatus("error", "Service Worker API unavailable. VM proxy route cannot be enabled.", 3600);
      return false;
    }
    const currentState = vmHttpProxy.getState();
    const input = await dialogs.prompt("VM HTTP port", String(currentState.port || 8080), {
      title: "Start VM Proxy",
      placeholder: "8080",
    });
    if (input === null) {
      return false;
    }
    try {
      vmHttpProxy.setPort(input);
    } catch (error) {
      setStatus("error", error instanceof Error ? error.message : "Invalid proxy port.", 2800);
      return false;
    }
    vmHttpProxy.enable();
    const state = vmHttpProxy.getState();
    setStatus("info", `VM HTTP proxy started at ${vmHttpProxy.getProxyPrefix()} (port ${state.port}).`, 2800);
    return true;
  };

  const disableVmHttpProxy = () => {
    vmHttpProxy.disable();
    setStatus("info", "VM HTTP proxy disabled.", 2000);
  };

  const setVmHttpProxyPort = async () => {
    const state = vmHttpProxy.getState();
    const input = await dialogs.prompt("VM HTTP port", String(state.port || 8080), {
      title: "Set VM Proxy Port",
      placeholder: "8080",
    });
    if (input === null) {
      return;
    }
    try {
      const port = vmHttpProxy.setPort(input);
      setStatus("info", `VM HTTP proxy port set to ${port}.`, 2200);
    } catch (error) {
      setStatus("error", error instanceof Error ? error.message : "Invalid proxy port.", 2800);
    }
  };

  const showVmHttpProxyStatus = () => {
    const state = vmHttpProxy.getState();
    const prefix = vmHttpProxy.getProxyPrefix();
    const message = `Proxy ${state.enabled ? "enabled" : "disabled"} | route: ${prefix} | VM port: ${state.port}`;
    setStatus("info", message, 2800);
    bus.emit("terminal-output", {
      data: `[proxy] ${message}\r\n`,
    });
  };

  const testVmHttpProxy = async () => {
    if (!vmHttpProxy.isEnabled()) {
      const enabled = await enableVmHttpProxy();
      if (!enabled) {
        return;
      }
    }
    const testPath = vmHttpProxy.buildProxyUrl("/");
    bus.emit("terminal-output", {
      data: `[proxy] Testing ${testPath} ...\r\n`,
    });
    try {
      const response = await fetch(testPath, {
        method: "GET",
        cache: "no-store",
      });
      const resultLine = `[proxy] ${response.status} ${response.statusText}`.trim();
      bus.emit("terminal-output", {
        data: `${resultLine}\r\n`,
      });
      setStatus(response.ok ? "info" : "error", resultLine, response.ok ? 1800 : 3000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Proxy request failed.";
      bus.emit("terminal-output", {
        data: `[proxy] ${message}\r\n`,
      });
      setStatus("error", message, 3000);
    }
  };

  const openVmProxyPreview = async () => {
    if (!vmHttpProxy.isEnabled()) {
      const enabled = await enableVmHttpProxy();
      if (!enabled) {
        return;
      }
    }
    const input = await dialogs.prompt("Preview path", "/", {
      title: "Open VM Preview",
      placeholder: "/",
    });
    if (input === null) {
      return;
    }
    const previewUrl = vmHttpProxy.buildProxyUrl(input || "/");
    window.open(previewUrl, "_blank", "noopener,noreferrer");
    setStatus("info", `Opened preview: ${previewUrl}`, 2200);
  };

  const runNodeServerInVm = async () => {
    if (!filesystem.hasOpenFolder()) {
      setStatus("error", "Open a folder or project before running Node.", 2600);
      return;
    }
    const vmRoot = `/home/user/${filesystem.getRootName()}`;
    const qRoot = shellQuote(vmRoot);
    vm.queueCommand(`cd ${qRoot}`);
    vm.queueCommand(
      "if [ -f package.json ] && command -v npm >/dev/null 2>&1; then npm run start; " +
        "elif [ -f server.js ] && command -v node >/dev/null 2>&1; then node server.js; " +
        "else echo '[run] Node entrypoint not found. Expected package.json or server.js.'; fi"
    );
    setStatus("info", "Started Node server command in VM terminal.", 2200);
  };

  const getDefaultCompileInput = (extensions, fallbackName) => {
    const active = editor.getActiveFile();
    if (active && !active.path.startsWith("untitled:")) {
      const lowerPath = active.path.toLowerCase();
      if (extensions.some((extension) => lowerPath.endsWith(extension))) {
        return active.path;
      }
    }
    const openPaths = editor.getOpenPaths();
    for (const path of openPaths) {
      if (path.startsWith("untitled:")) {
        continue;
      }
      const lowerPath = path.toLowerCase();
      if (extensions.some((extension) => lowerPath.endsWith(extension))) {
        return path;
      }
    }
    return fallbackName;
  };

  const runVmCommand = async (label, command, options = {}) => {
    const commandTag = options.tag || "run";
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 300000);
    bus.emit("terminal-output", {
      data: `[${commandTag}] Starting ${label}...\r\n`,
    });

    let result = null;
    try {
      result = await vm.runCapturedCommandWithExitCode(command, { timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} failed.`;
      bus.emit("terminal-output", {
        data: `[${commandTag}] ${message}\r\n`,
      });
      bus.emit("status", {
        level: "error",
        message,
      });
      return null;
    }

    if (result.output) {
      const outputWithCrlf = result.output.replace(/\r?\n/g, "\r\n");
      bus.emit("terminal-output", {
        data: outputWithCrlf.endsWith("\r\n") ? outputWithCrlf : `${outputWithCrlf}\r\n`,
      });
    }

    bus.emit("terminal-output", {
      data: `[${commandTag}] Exit code: ${result.exitCode}\r\n`,
    });

    const successMessage = options.successMessage || `${label} finished successfully.`;
    const failureTemplate = options.failureMessage || `${label} failed with exit code $?`;
    const failureMessage = String(failureTemplate).replace(/\$\?/g, String(result.exitCode));
    bus.emit("status", {
      level: result.exitCode === 0 ? "info" : "error",
      message: result.exitCode === 0 ? successMessage : failureMessage,
    });
    return result;
  };

  const runCompileCommand = async (compilerLabel, command) => {
    return runVmCommand(`${compilerLabel} build`, command, {
      tag: "compile",
      timeoutMs: 300000,
      successMessage: `${compilerLabel} compile finished successfully.`,
      failureMessage: `${compilerLabel} compile failed with exit code $?`,
    });
  };

  const runScriptInVm = async (tool) => {
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder or project before running scripts.",
      });
      return;
    }

    const configs = {
      python: {
        label: "Python",
        extensions: [".py"],
        defaultInput: "main.py",
      },
      lua: {
        label: "Lua",
        extensions: [".lua"],
        defaultInput: "main.lua",
      },
    };
    const config = configs[tool];
    if (!config) {
      return;
    }

    const defaultInput = getDefaultCompileInput(config.extensions, config.defaultInput);
    const sourceInput = await dialogs.prompt(`${config.label} input file`, defaultInput, {
      title: `${config.label} Compile`,
      placeholder: "relative/path/to/source",
    });
    if (!sourceInput) {
      return;
    }
    const sourcePath = normalizePath(sourceInput);
    if (!sourcePath || sourcePath.startsWith("untitled:")) {
      bus.emit("status", {
        level: "error",
        message: "Choose a saved source file inside the opened folder or project.",
      });
      return;
    }
    if (!filesystem.hasFileHandle(sourcePath)) {
      bus.emit("status", {
        level: "error",
        message: `Input file is not in the opened folder or project: ${sourcePath}`,
      });
      return;
    }

    const sourceSnapshot = editor.getFileSnapshot(sourcePath);
    if (sourceSnapshot && sourceSnapshot.dirty) {
      await saveFile(sourcePath);
    }

    const vmRoot = `/home/user/${filesystem.getRootName()}`;
    const qRoot = shellQuote(vmRoot);
    const qInput = shellQuote(sourcePath);
    let command = "";
    if (tool === "python") {
      command = [
        `cd ${qRoot}`,
        "&&",
        "if command -v python3 >/dev/null 2>&1; then",
        `python3 ${qInput};`,
        "elif command -v python >/dev/null 2>&1; then",
        `python ${qInput};`,
        "else",
        "echo '[run] python not found in VM.'; exit 127;",
        "fi",
      ].join(" ");
    } else if (tool === "lua") {
      command = [
        `cd ${qRoot}`,
        "&&",
        "if command -v lua >/dev/null 2>&1; then",
        `lua ${qInput};`,
        "else",
        "echo '[run] lua not found in VM.'; exit 127;",
        "fi",
      ].join(" ");
    }

    bottomState.vmMessage = `${config.label} run started`;
    renderBottomBar();
    const result = await runVmCommand(`${config.label} run`, command, {
      tag: "run",
      timeoutMs: 300000,
      successMessage: `${config.label} run completed.`,
      failureMessage: `${config.label} run failed.`,
    });
    bottomState.vmMessage =
      result && result.exitCode === 0 ? `${config.label} run finished` : `${config.label} run failed`;
    renderBottomBar();
  };

  const compileInVm = async (tool) => {
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder or project before compiling.",
      });
      return;
    }

    const configs = {
      c: {
        label: "C",
        extensions: [".c"],
        defaultInput: "main.c",
      },
      cpp: {
        label: "C++",
        extensions: [".cpp", ".cc", ".cxx", ".c++"],
        defaultInput: "main.cpp",
      },
      rust: {
        label: "Rust",
        extensions: [".rs"],
        defaultInput: "main.rs",
      },
    };

    const config = configs[tool];
    if (!config) {
      return;
    }

    const defaultInput = getDefaultCompileInput(config.extensions, config.defaultInput);
    const sourceInput = await dialogs.prompt(`${config.label} input file`, defaultInput, {
      title: `${config.label} Run`,
      placeholder: "relative/path/to/script",
    });
    if (!sourceInput) {
      return;
    }
    const sourcePath = normalizePath(sourceInput);
    if (!sourcePath || sourcePath.startsWith("untitled:")) {
      bus.emit("status", {
        level: "error",
        message: "Choose a saved source file inside the opened folder or project.",
      });
      return;
    }
    if (!filesystem.hasFileHandle(sourcePath)) {
      bus.emit("status", {
        level: "error",
        message: `Input file is not in the opened folder or project: ${sourcePath}`,
      });
      return;
    }

    const includeAll = await dialogs.confirm("Include all matching files from the opened folder/project?", {
      title: "Compile Options",
      okLabel: "Include All",
      cancelLabel: "Single File",
    });
    const outputDefault = `${basenameWithoutExtension(sourcePath)}.out`;
    const outputInput = await dialogs.prompt("Output file path", outputDefault, {
      title: "Compile Output",
      placeholder: "relative/path/to/output",
    });
    if (!outputInput) {
      return;
    }
    const outputPath = normalizePath(outputInput);
    if (!outputPath) {
      return;
    }

    const sourceSnapshot = editor.getFileSnapshot(sourcePath);
    if (sourceSnapshot && sourceSnapshot.dirty) {
      await saveFile(sourcePath);
    }

    const vmRoot = `/home/user/${filesystem.getRootName()}`;
    const qRoot = shellQuote(vmRoot);
    const qInput = shellQuote(sourcePath);
    const qOutput = shellQuote(outputPath);
    let command = "";

    if (tool === "c") {
      if (includeAll) {
        command = [
          `cd ${qRoot}`,
          "&&",
          "if ! command -v gcc >/dev/null 2>&1; then",
          "echo '[compile] gcc not found in VM.';",
          "else",
          "SRC_COUNT=$(find . -type f -name '*.c' | wc -l);",
          "if [ \"$SRC_COUNT\" -eq 0 ]; then echo '[compile] No .c files found.';",
          `else find . -type f -name '*.c' -print0 | xargs -0 gcc -O2 -std=c11 -o ${qOutput}; fi;`,
          `if [ -f ${qOutput} ]; then chmod +x ${qOutput}; fi;`,
          "fi",
        ].join(" ");
      } else {
        command = [
          `cd ${qRoot}`,
          "&&",
          "if ! command -v gcc >/dev/null 2>&1; then",
          "echo '[compile] gcc not found in VM.';",
          `else gcc -O2 -std=c11 ${qInput} -o ${qOutput} && chmod +x ${qOutput};`,
          "fi",
        ].join(" ");
      }
    } else if (tool === "cpp") {
      if (includeAll) {
        command = [
          `cd ${qRoot}`,
          "&&",
          "if ! command -v g++ >/dev/null 2>&1; then",
          "echo '[compile] g++ not found in VM.';",
          "else",
          "SRC_COUNT=$(find . -type f \\( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' -o -name '*.c++' \\) | wc -l);",
          "if [ \"$SRC_COUNT\" -eq 0 ]; then echo '[compile] No C++ files found.';",
          `else find . -type f \\( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' -o -name '*.c++' \\) -print0 | xargs -0 g++ -O2 -std=c++17 -o ${qOutput}; fi;`,
          `if [ -f ${qOutput} ]; then chmod +x ${qOutput}; fi;`,
          "fi",
        ].join(" ");
      } else {
        command = [
          `cd ${qRoot}`,
          "&&",
          "if ! command -v g++ >/dev/null 2>&1; then",
          "echo '[compile] g++ not found in VM.';",
          `else g++ -O2 -std=c++17 ${qInput} -o ${qOutput} && chmod +x ${qOutput};`,
          "fi",
        ].join(" ");
      }
    } else if (tool === "rust") {
      if (includeAll) {
        command = [
          `cd ${qRoot}`,
          "&&",
          "if ! command -v rustc >/dev/null 2>&1; then",
          "echo '[compile] rustc not found in VM.';",
          "elif [ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1; then",
          "cargo build --release;",
          `else rustc -O ${qInput} -o ${qOutput} && chmod +x ${qOutput}; fi`,
        ].join(" ");
      } else {
        command = [
          `cd ${qRoot}`,
          "&&",
          "if ! command -v rustc >/dev/null 2>&1; then",
          "echo '[compile] rustc not found in VM.';",
          `else rustc -O ${qInput} -o ${qOutput} && chmod +x ${qOutput}; fi`,
        ].join(" ");
      }
    }

    bottomState.vmMessage = `${config.label} compile running`;
    renderBottomBar();
    await runCompileCommand(config.label, command);
    bottomState.vmMessage = `${config.label} compile finished`;
    renderBottomBar();
  };

  const handleOpenFolder = async () => {
    if (!filesystem.isSupported()) {
      bus.emit("status", {
        level: "error",
        message: "File System Access API is unavailable. Use a Chromium-based browser.",
      });
      return;
    }

    const result = await filesystem.openFolder();
    currentMlpFileName = ensureMlpFileName(result.rootName || "project");
    activateWorkspace(result);
    bus.emit("status", {
      level: "info",
      message: `Opened folder ${result.rootName}`,
    });
  };

  let explorerDragPath = "";
  let explorerDropTargetElement = null;

  const clearExplorerDropTarget = () => {
    if (explorerDropTargetElement) {
      explorerDropTargetElement.classList.remove("is-drop-target");
      explorerDropTargetElement = null;
    }
    dom.explorer.classList.remove("is-drop-target-root");
  };

  const setExplorerDropTarget = (target) => {
    const element = target instanceof Element ? target : null;
    let nextTarget = null;
    if (element) {
      nextTarget = element.closest(".tree-summary") || element.closest(".file-button");
    }

    if (explorerDropTargetElement && explorerDropTargetElement !== nextTarget) {
      explorerDropTargetElement.classList.remove("is-drop-target");
    }
    explorerDropTargetElement = nextTarget;
    if (explorerDropTargetElement) {
      explorerDropTargetElement.classList.add("is-drop-target");
      dom.explorer.classList.remove("is-drop-target-root");
      return;
    }
    if (element && dom.explorer.contains(element)) {
      dom.explorer.classList.add("is-drop-target-root");
    } else {
      dom.explorer.classList.remove("is-drop-target-root");
    }
  };

  const getExplorerDragPathFromTarget = (target) => {
    const element = target instanceof Element ? target : null;
    if (!element) {
      return "";
    }
    const fileNode = element.closest(".file-button");
    if (fileNode) {
      return normalizePath(fileNode.dataset.path || "");
    }
    const directoryNode = element.closest(".tree-summary");
    if (directoryNode) {
      return normalizePath(directoryNode.dataset.path || "");
    }
    return "";
  };

  const getExplorerDropDirectoryFromTarget = (target) => {
    const element = target instanceof Element ? target : null;
    if (!element) {
      return null;
    }
    const directoryNode = element.closest(".tree-summary");
    if (directoryNode) {
      return normalizePath(directoryNode.dataset.path || "");
    }
    const fileNode = element.closest(".file-button");
    if (fileNode) {
      return dirname(normalizePath(fileNode.dataset.path || ""));
    }
    if (dom.explorer.contains(element)) {
      return "";
    }
    return null;
  };

  const handleExplorerDragStart = (event) => {
    if (!filesystem.hasOpenFolder()) {
      return;
    }
    const sourcePath = getExplorerDragPathFromTarget(event.target);
    if (!sourcePath) {
      return;
    }
    explorerDragPath = sourcePath;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", sourcePath);
    }
  };

  const handleExplorerDragOver = (event) => {
    if (!explorerDragPath) {
      clearExplorerDropTarget();
      return;
    }
    const destinationDirectory = getExplorerDropDirectoryFromTarget(event.target);
    if (destinationDirectory === null) {
      clearExplorerDropTarget();
      return;
    }
    const sourceName = getPathBasename(explorerDragPath);
    if (!sourceName) {
      clearExplorerDropTarget();
      return;
    }
    const targetPath = destinationDirectory ? `${destinationDirectory}/${sourceName}` : sourceName;
    if (!targetPath || targetPath === explorerDragPath || targetPath.startsWith(`${explorerDragPath}/`)) {
      clearExplorerDropTarget();
      return;
    }
    event.preventDefault();
    setExplorerDropTarget(event.target);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  };

  const handleExplorerDrop = async (event) => {
    if (!explorerDragPath) {
      clearExplorerDropTarget();
      return;
    }
    const sourcePath = explorerDragPath;
    explorerDragPath = "";
    const destinationDirectory = getExplorerDropDirectoryFromTarget(event.target);
    if (destinationDirectory === null) {
      clearExplorerDropTarget();
      return;
    }
    const sourceName = getPathBasename(sourcePath);
    if (!sourceName) {
      return;
    }
    const targetPath = destinationDirectory ? `${destinationDirectory}/${sourceName}` : sourceName;
    if (!targetPath || targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`)) {
      clearExplorerDropTarget();
      return;
    }
    event.preventDefault();
    clearExplorerDropTarget();
    await moveEntryToDirectory(sourcePath, destinationDirectory);
  };

  const handleExplorerDragLeave = (event) => {
    if (!explorerDragPath) {
      clearExplorerDropTarget();
      return;
    }
    const related = event.relatedTarget;
    if (!(related instanceof Element) || !dom.explorer.contains(related)) {
      clearExplorerDropTarget();
    }
  };

  const handleExplorerDragEnd = () => {
    explorerDragPath = "";
    clearExplorerDropTarget();
  };

  const handleExplorerContextMenu = (event) => {
    event.preventDefault();
    const fileNode = event.target.closest(".file-button");
    const directoryNode = event.target.closest(".tree-summary");
    const kind = fileNode ? "file" : "directory";
    const path = normalizePath((fileNode || directoryNode)?.dataset.path || "");
    const baseDirectory = kind === "directory" ? path : dirname(path);

    contextMenu.show(event.clientX, event.clientY, [
      {
        label: "New File",
        disabled: !filesystem.hasOpenFolder(),
        onSelect: () => createFileAt(baseDirectory),
      },
      {
        label: "New Folder",
        disabled: !filesystem.hasOpenFolder(),
        onSelect: () => createFolderAt(baseDirectory),
      },
      {
        label: "Save",
        disabled: kind !== "file",
        onSelect: () => saveFile(path),
      },
      {
        label: "Rename",
        disabled: !filesystem.hasOpenFolder() || !path,
        onSelect: () => renameEntry(path, kind),
      },
      {
        label: "Remove",
        disabled: !filesystem.hasOpenFolder() || !path,
        onSelect: () => removeEntry(path, kind),
      },
    ]);
  };

  const handleTabContextMenu = (event) => {
    const tabElement = event.target.closest(".editor-tab");
    if (!tabElement) {
      return;
    }
    event.preventDefault();
    const tabPath = tabElement.dataset.tabPath;
    const openPaths = editor.getOpenPaths();
    const tabIndex = openPaths.indexOf(tabPath);
    const closeLeftPaths = tabIndex > 0 ? openPaths.slice(0, tabIndex) : [];
    const closeRightPaths = tabIndex >= 0 ? openPaths.slice(tabIndex + 1) : [];
    contextMenu.show(event.clientX, event.clientY, [
      {
        label: "Save",
        onSelect: () => saveFile(tabPath),
      },
      {
        label: "Rename",
        disabled: !tabPath || tabPath.startsWith("untitled:") || !filesystem.hasOpenFolder(),
        onSelect: () => renameEntry(tabPath, "file"),
      },
      {
        label: "Close",
        onSelect: () => requestCloseTab(tabPath),
      },
      {
        label: "Close All to Left",
        disabled: closeLeftPaths.length === 0,
        onSelect: () => closeTabsInOrder(closeLeftPaths),
      },
      {
        label: "Close All to Right",
        disabled: closeRightPaths.length === 0,
        onSelect: () => closeTabsInOrder(closeRightPaths),
      },
      {
        label: "Close All",
        disabled: openPaths.length === 0,
        onSelect: () => closeTabsInOrder(openPaths),
      },
    ]);
  };

  const handleGlobalKeydown = async (event) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }
    if (event.key.toLowerCase() !== "s") {
      return;
    }
    event.preventDefault();
    await saveFile();
  };

  const handleSettingsButtonClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const isOpen = dom.settingsMenu?.dataset.open === "true";
    if (!isOpen) {
      fillSettingsInputs(getCurrentRuntimeSettings());
    }
    setSettingsMenuOpen(!isOpen);
  };

  const handleSettingsApply = () => {
    const next = sanitizeRuntimeSettings(readSettingsInputs());
    const applied = applyRuntimeSettings(next);
    fillSettingsInputs(applied);
    saveSettingsToStorage(applied);
    setStatus("info", "Settings applied.", 1200);
    setSettingsMenuOpen(false);
  };

  const applySettingsPreset = (key) => {
    const preset = SETTINGS_PRESETS[key];
    if (!preset) {
      return;
    }
    const applied = applyRuntimeSettings(sanitizeRuntimeSettings(preset));
    fillSettingsInputs(applied);
    saveSettingsToStorage(applied);
    setStatus("info", `Applied ${key} preset.`, 1300);
    setSettingsMenuOpen(false);
  };

  const handleSettingsClose = () => {
    setSettingsMenuOpen(false);
  };

  const handleSettingsPresetFast = () => {
    applySettingsPreset("fast");
  };

  const handleSettingsPresetBalanced = () => {
    applySettingsPreset("balanced");
  };

  const handleSettingsPresetFull = () => {
    applySettingsPreset("full");
  };

  const handleDevtoolsToggle = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDevtoolsOpen(!devtoolsOpen);
    if (devtoolsOpen) {
      renderDevtoolsLog();
    }
  };

  const handleDevtoolsClose = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDevtoolsOpen(false);
  };

  const handleDevtoolsClear = (event) => {
    event.preventDefault();
    event.stopPropagation();
    devtoolsLogEntries = [];
    renderDevtoolsLog();
  };

  const handleDocumentPointerDown = (event) => {
    if (dom.settingsMenu?.dataset.open === "true" && dom.settingsRoot) {
      if (!dom.settingsRoot.contains(event.target)) {
        setSettingsMenuOpen(false);
      }
    }
    if (
      devtoolsOpen &&
      dom.devtoolsPanel &&
      dom.rightSidebar &&
      !dom.devtoolsPanel.contains(event.target) &&
      !dom.rightSidebar.contains(event.target)
    ) {
      setDevtoolsOpen(false);
    }
  };

  dom.explorer.addEventListener("contextmenu", handleExplorerContextMenu);
  dom.explorer.addEventListener("dragstart", handleExplorerDragStart);
  dom.explorer.addEventListener("dragover", handleExplorerDragOver);
  dom.explorer.addEventListener("drop", handleExplorerDrop);
  dom.explorer.addEventListener("dragleave", handleExplorerDragLeave);
  dom.explorer.addEventListener("dragend", handleExplorerDragEnd);
  dom.editorTabs.addEventListener("contextmenu", handleTabContextMenu);
  window.addEventListener("keydown", handleGlobalKeydown);
  if (dom.settingsButton) {
    dom.settingsButton.addEventListener("click", handleSettingsButtonClick);
  }
  if (dom.settingsApply) {
    dom.settingsApply.addEventListener("click", handleSettingsApply);
  }
  if (dom.settingsClose) {
    dom.settingsClose.addEventListener("click", handleSettingsClose);
  }
  if (dom.settingsPresetFast) {
    dom.settingsPresetFast.addEventListener("click", handleSettingsPresetFast);
  }
  if (dom.settingsPresetBalanced) {
    dom.settingsPresetBalanced.addEventListener("click", handleSettingsPresetBalanced);
  }
  if (dom.settingsPresetFull) {
    dom.settingsPresetFull.addEventListener("click", handleSettingsPresetFull);
  }
  if (dom.rightDevtoolsToggle) {
    dom.rightDevtoolsToggle.addEventListener("click", handleDevtoolsToggle);
  }
  if (dom.devtoolsClose) {
    dom.devtoolsClose.addEventListener("click", handleDevtoolsClose);
  }
  if (dom.devtoolsClear) {
    dom.devtoolsClear.addEventListener("click", handleDevtoolsClear);
  }
  document.addEventListener("pointerdown", handleDocumentPointerDown);

  disposables.push(
    bus.on("status", ({ level, message, holdMs }) => {
      setStatus(level, message, holdMs);
    })
  );

  disposables.push(
    bus.on("active-file-changed", (activeFile) => {
      dom.currentFileDisplay.textContent = formatTopbarFileDisplay(activeFile);
      highlightExplorerFile(dom.explorer, activeFile ? activeFile.path : "");
      renderBottomBar();
    })
  );

  disposables.push(
    bus.on("vm-internal-command", (entry) => {
      appendDevtoolsLog(entry);
      if (devtoolsOpen) {
        renderDevtoolsLog();
      }
    })
  );

  disposables.push(
    bus.on("mount-read-progress", ({ processed, total }) => {
      mountOverlayState.phase = "reading";
      mountOverlayState.readProcessed = Number.isFinite(processed) ? processed : 0;
      mountOverlayState.readTotal = Number.isFinite(total) ? total : 0;
      renderMountOverlay();
      setStatus("info", `Reading files for VM mount: ${processed}/${total}`, 1200);
    })
  );

  disposables.push(
    bus.on("vm-mount-progress", ({ processed, total }) => {
      mountOverlayState.phase = "writing";
      mountOverlayState.writeProcessed = Number.isFinite(processed) ? processed : 0;
      mountOverlayState.writeTotal = Number.isFinite(total) ? total : 0;
      renderMountOverlay();
    })
  );

  disposables.push(
    bus.on("terminal-input", ({ data }) => {
      lastTerminalInputAt = Date.now();
      const text = typeof data === "string" ? data : "";
      if (text.includes("\u0003")) {
        terminalBusyUntil = Math.max(terminalBusyUntil, Date.now() + 1200);
        return;
      }
      const hasSubmit = text.includes("\r") || text.includes("\n");
      const cooldownMs = hasSubmit
        ? VM_TO_HOST_POST_ENTER_COOLDOWN_MS
        : VM_TO_HOST_POST_INPUT_COOLDOWN_MS;
      terminalBusyUntil = Math.max(terminalBusyUntil, Date.now() + cooldownMs);
    })
  );

  disposables.push(
    bus.on("vm-progress", ({ message, percent, visible, autoHideMs }) => {
      setVmProgress({ message, percent, visible, autoHideMs });
    })
  );

  disposables.push(
    bus.on("terminal-resized", ({ rows, cols }) => {
      bottomState.terminalRows = Number.isFinite(rows) ? rows : bottomState.terminalRows;
      bottomState.terminalCols = Number.isFinite(cols) ? cols : bottomState.terminalCols;
      renderBottomBar();
    })
  );

  disposables.push(
    bus.on("editor-tab-close-request", ({ path }) => {
      requestCloseTab(path);
    })
  );

  disposables.push(
    bus.on("editor-relative-link-clicked", ({ resolvedPath }) => {
      if (editor.hasOpenFile(resolvedPath)) {
        editor.setActiveFile(resolvedPath);
        return;
      }
      if (filesystem.hasFileHandle(resolvedPath)) {
        openFileInEditor(resolvedPath);
        return;
      }
      bus.emit("status", {
        level: "error",
        message: `Missing relative file: ${resolvedPath}`,
      });
    })
  );

  disposables.push(
    bus.on("keyboard-save-request", () => {
      saveFile();
    })
  );

  topbar.addTab({
    id: "file",
    label: "File",
    items: [
      { label: "Open Folder", onSelect: handleOpenFolder },
      { label: "New Project from Template", onSelect: createProjectFromTemplate },
      { label: "New Mandelogue Project", onSelect: createMandelogueProject },
      { label: "Open Mandelogue Project (.mlp)", onSelect: openMandelogueProject },
      { label: "Save Mandelogue Project As (.mlp)", onSelect: () => saveWorkspaceAsMlp() },
      { type: "separator" },
      { label: "Save", onSelect: () => saveFile() },
      { label: "New File", onSelect: () => createFileAt("") },
    ],
  });

  topbar.addTab({
    id: "edit",
    label: "Edit",
    items: [
      { label: "Undo", onSelect: () => editor.undo() },
      { label: "Redo", onSelect: () => editor.redo() },
    ],
  });

  topbar.addTab({
    id: "tools",
    label: "Tools",
    items: [
      {
        type: "heading",
        label: "Snapshots",
      },
      {
        label: "Save VM Snapshot",
        onSelect: saveVmSnapshot,
      },
      {
        label: "Load VM Snapshot",
        onSelect: loadVmSnapshot,
      },
      {
        label: "Delete VM Snapshot",
        onSelect: clearVmSnapshot,
      },
      {
        label: "Download VM Snapshot",
        onSelect: downloadVmSnapshot,
      },
      {
        label: "Upload VM Snapshot",
        onSelect: uploadVmSnapshot,
      },
      {
        type: "separator",
      },
      {
        type: "heading",
        label: "Sync & Network",
      },
      {
        label: "Sync VM -> Device",
        onSelect: syncVmToHostNow,
      },
      {
        label: "Test VM Internet",
        onSelect: testVmInternet,
      },
      {
        type: "separator",
      },
      {
        type: "heading",
        label: "HTTP Preview Proxy",
      },
      {
        label: "Start VM HTTP Proxy (Manual Port)",
        onSelect: enableVmHttpProxy,
      },
      {
        label: "Stop VM HTTP Proxy",
        onSelect: disableVmHttpProxy,
      },
      {
        label: "Set VM Proxy Port",
        onSelect: setVmHttpProxyPort,
      },
      {
        label: "Test Proxy Route",
        onSelect: testVmHttpProxy,
      },
      {
        label: "Proxy Status",
        onSelect: showVmHttpProxyStatus,
      },
      {
        type: "separator",
      },
      {
        type: "heading",
        label: "Repository",
      },
      {
        label: "Import GitHub Repository",
        onSelect: importGithubRepository,
      },
    ],
  });

  topbar.addTab({
    id: "run",
    label: "Run",
    items: [
      {
        type: "heading",
        label: "Web / Node",
      },
      {
        label: "Run Node Server (server.js / npm start)",
        onSelect: runNodeServerInVm,
      },
      {
        label: "Open VM Web Preview (/__vm_proxy__/)",
        onSelect: openVmProxyPreview,
      },
      {
        type: "separator",
      },
      {
        type: "heading",
        label: "Compile",
      },
      {
        label: "Compile C",
        onSelect: () => compileInVm("c"),
      },
      {
        label: "Compile C++",
        onSelect: () => compileInVm("cpp"),
      },
      {
        label: "Compile Rust",
        onSelect: () => compileInVm("rust"),
      },
      {
        type: "separator",
      },
      {
        type: "heading",
        label: "Scripts",
      },
      {
        label: "Run Python",
        onSelect: () => runScriptInVm("python"),
      },
      {
        label: "Run Lua",
        onSelect: () => runScriptInVm("lua"),
      },
    ],
  });

  disposables.push(
    bus.on("add-topbar-tab", (tabDefinition) => {
      topbar.addTab(tabDefinition);
    })
  );

  renderExplorerTree(dom.explorer, null, openFileInEditor);
  setVmProgress({
    message: "VM: waiting for runtime initialization...",
    percent: null,
    visible: true,
  });
  renderBottomBar();
  renderMountOverlay();

  await Promise.all([editor.init(), terminal.init(), vm.init()]);
  vmHttpProxy.init().catch(() => {
    // Proxy route can still be enabled later if registration succeeds.
  });
  bus.emit("terminal-output", {
    data: "\r\n[system] Terminal online. Waiting for VM serial output...\r\n",
  });
  bus.emit("status", {
    level: "info",
    message: "Editor, terminal, and VM initialized.",
  });

  const teardown = () => {
    for (const dispose of disposables) {
      try {
        dispose();
      } catch (error) {
        // Ignore event disposal errors.
      }
    }
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (vmProgressTimer) {
      clearTimeout(vmProgressTimer);
      vmProgressTimer = null;
    }
    resetVmToHostSyncState();
    dom.explorer.removeEventListener("contextmenu", handleExplorerContextMenu);
    dom.explorer.removeEventListener("dragstart", handleExplorerDragStart);
    dom.explorer.removeEventListener("dragover", handleExplorerDragOver);
    dom.explorer.removeEventListener("drop", handleExplorerDrop);
    dom.explorer.removeEventListener("dragleave", handleExplorerDragLeave);
    dom.explorer.removeEventListener("dragend", handleExplorerDragEnd);
    dom.editorTabs.removeEventListener("contextmenu", handleTabContextMenu);
    window.removeEventListener("keydown", handleGlobalKeydown);
    if (dom.settingsButton) {
      dom.settingsButton.removeEventListener("click", handleSettingsButtonClick);
    }
    if (dom.settingsApply) {
      dom.settingsApply.removeEventListener("click", handleSettingsApply);
    }
    if (dom.settingsClose) {
      dom.settingsClose.removeEventListener("click", handleSettingsClose);
    }
    if (dom.settingsPresetFast) {
      dom.settingsPresetFast.removeEventListener("click", handleSettingsPresetFast);
    }
    if (dom.settingsPresetBalanced) {
      dom.settingsPresetBalanced.removeEventListener("click", handleSettingsPresetBalanced);
    }
    if (dom.settingsPresetFull) {
      dom.settingsPresetFull.removeEventListener("click", handleSettingsPresetFull);
    }
    if (dom.rightDevtoolsToggle) {
      dom.rightDevtoolsToggle.removeEventListener("click", handleDevtoolsToggle);
    }
    if (dom.devtoolsClose) {
      dom.devtoolsClose.removeEventListener("click", handleDevtoolsClose);
    }
    if (dom.devtoolsClear) {
      dom.devtoolsClear.removeEventListener("click", handleDevtoolsClear);
    }
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    editor.dispose();
    terminal.dispose();
    vm.dispose();
    vmHttpProxy.dispose();
    disposeZstdWorker();
    topbar.dispose();
    contextMenu.dispose();
  };

  window.addEventListener("beforeunload", teardown, { once: true });
}

bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : "Application bootstrap failed.";
  const statusElement = document.getElementById("status-display");
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.dataset.level = "error";
  }
});
