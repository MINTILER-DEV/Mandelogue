import { EditorService } from "./editor.js";
import { TerminalService } from "./terminal.js";
import { FileSystemService } from "./filesystem.js";
import { VMService } from "./vm.js";

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

    for (const item of items) {
      if (item.type === "separator") {
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        menu.appendChild(separator);
        continue;
      }

      const itemButton = document.createElement("button");
      itemButton.type = "button";
      itemButton.className = "menu-item";
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
      menu.appendChild(itemButton);
    }

    this.tabsContainer.appendChild(button);
    this.menusContainer.appendChild(menu);
    this.tabs.set(id, { button, menu });
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

function formatTopbarFileDisplay(activeFile) {
  if (!activeFile || !activeFile.label) {
    return "Mandelogue Web Editor";
  }
  return `Mandelogue Web Editor \u2022 [${activeFile.label}]`;
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
    empty.textContent = "Open a folder to browse files.";
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
  summary.textContent = node.name || "/";
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
    button.textContent = child.name;
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
    terminalMountOverlay: document.getElementById("terminal-mount-overlay"),
    terminalMountText: document.getElementById("terminal-mount-text"),
    terminalMountProgressFill: document.getElementById("terminal-mount-progress-fill"),
    terminalResizeHandle: document.getElementById("terminal-resize-handle"),
    vmProgress: document.getElementById("vm-progress"),
    vmProgressText: document.getElementById("vm-progress-text"),
    vmProgressFill: document.getElementById("vm-progress-fill"),
    bottomVm: document.getElementById("bottom-vm"),
    bottomFolder: document.getElementById("bottom-folder"),
    bottomTabs: document.getElementById("bottom-tabs"),
    bottomTerminal: document.getElementById("bottom-terminal"),
    vmScreen: document.getElementById("vm-screen"),
  };

  const topbar = new TopbarManager(bus, {
    tabsContainer: dom.topbarTabs,
    menusContainer: dom.topbarMenus,
    topbarLeft: dom.topbarLeft,
  });
  const contextMenu = new ContextMenuManager();

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

  const disposables = [];
  let statusTimer = null;
  let vmProgressTimer = null;
  let vmToHostSyncTimer = null;
  let vmToHostSyncRunning = false;
  let vmToHostSyncStartedAt = 0;
  let vmToHostSyncErrorShown = false;
  let vmKnownPaths = new Set();
  let lastTerminalInputAt = Date.now();
  let vmToHostSyncIntervalMs = 6000;
  const VM_TO_HOST_IDLE_MS = 2500;
  const SETTINGS_STORAGE_KEY = "mandelogue.settings.v1";
  const bottomState = {
    vmMessage: "waiting...",
    terminalRows: null,
    terminalCols: null,
  };
  const mountOverlayState = {
    visible: false,
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
      syncIntervalSeconds: 10,
      mountBatchCommandLimit: 20,
      mountBase64ChunkSize: 512,
    },
    balanced: {
      maxMountFiles: 2000,
      maxMountFileBytes: 768 * 1024,
      maxMountTotalBytes: 32 * 1024 * 1024,
      syncIntervalSeconds: 6,
      mountBatchCommandLimit: 24,
      mountBase64ChunkSize: 768,
    },
    full: {
      maxMountFiles: 5000,
      maxMountFileBytes: 2 * 1024 * 1024,
      maxMountTotalBytes: 160 * 1024 * 1024,
      syncIntervalSeconds: 4,
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
    if (
      Number.isFinite(bottomState.terminalCols) &&
      Number.isFinite(bottomState.terminalRows)
    ) {
      dom.bottomTerminal.textContent = `Term: ${bottomState.terminalCols}x${bottomState.terminalRows}`;
    } else {
      dom.bottomTerminal.textContent = "Term: -";
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
    if (!dom.terminalMountOverlay || !dom.terminalMountText || !dom.terminalMountProgressFill) {
      return;
    }

    if (!mountOverlayState.visible) {
      dom.terminalMountOverlay.dataset.open = "false";
      dom.terminalMountOverlay.setAttribute("aria-hidden", "true");
      dom.terminalMountProgressFill.style.width = "0%";
      return;
    }

    dom.terminalMountOverlay.dataset.open = "true";
    dom.terminalMountOverlay.setAttribute("aria-hidden", "false");

    let message = "Preparing file list...";
    let percent = 0;
    if (mountOverlayState.phase === "reading") {
      message = `Reading files ${mountOverlayState.readProcessed}/${mountOverlayState.readTotal}`;
      if (mountOverlayState.readTotal > 0) {
        percent = (mountOverlayState.readProcessed / mountOverlayState.readTotal) * 45;
      }
    } else if (mountOverlayState.phase === "writing") {
      message = `Writing to VM ${mountOverlayState.writeProcessed}/${mountOverlayState.writeTotal}`;
      if (mountOverlayState.writeTotal > 0) {
        percent = 45 + (mountOverlayState.writeProcessed / mountOverlayState.writeTotal) * 55;
      } else {
        percent = 55;
      }
    } else if (mountOverlayState.phase === "finalizing") {
      message = "Finalizing mount...";
      percent = 98;
    }
    dom.terminalMountText.textContent = message;
    dom.terminalMountProgressFill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
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
    if (!filesystem.hasOpenFolder()) {
      return { skipped: "no-folder" };
    }
    if (vmToHostSyncRunning) {
      return { skipped: "busy" };
    }
    if (!force && Date.now() - lastTerminalInputAt < VM_TO_HOST_IDLE_MS) {
      return { skipped: "terminal-active" };
    }
    if (!force && typeof vm.isLikelyAtPrompt === "function" && !vm.isLikelyAtPrompt(2500)) {
      return { skipped: "shell-busy" };
    }

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
      } else if (announceNoChanges) {
        setStatus("info", "Synced VM -> device (no changes).", 1200);
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
        return { skipped: "vm-not-ready" };
      }
      if (!vmToHostSyncErrorShown) {
        bus.emit("status", {
          level: "error",
          message: error instanceof Error ? error.message : "VM -> device sync failed.",
        });
        vmToHostSyncErrorShown = true;
      }
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
  };

  const startVmToHostAutoSync = () => {
    if (vmToHostSyncTimer) {
      clearInterval(vmToHostSyncTimer);
    }
    vmToHostSyncTimer = setInterval(() => {
      performVmToHostSync();
    }, vmToHostSyncIntervalMs);
  };

  const storedSettings = loadSettingsFromStorage();
  if (storedSettings) {
    const appliedFromStorage = applyRuntimeSettings(storedSettings, { restartSync: false });
    fillSettingsInputs(appliedFromStorage);
  } else {
    fillSettingsInputs(getCurrentRuntimeSettings());
  }
  setSettingsMenuOpen(false);

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
        const requested = window.prompt("Save file as", getFileLabel(targetPath));
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
      const shouldSave = window.confirm(`Save changes to ${snapshot.label} before closing?`);
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
        const shouldDiscard = window.confirm(`Close ${snapshot.label} without saving changes?`);
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
    const rawName = window.prompt("New file path", suggestion);
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
        message: "Open a folder before creating subfolders.",
      });
      return;
    }

    const base = normalizePath(baseDirectory);
    const suggestion = base ? `${base}/new-folder` : "new-folder";
    const rawName = window.prompt("New folder path", suggestion);
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
        message: "Open a folder before removing entries.",
      });
      return;
    }

    const label = getFileLabel(normalizedPath);
    const confirmed = window.confirm(`Remove ${label}?`);
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

  const mountFolderToVm = async () => {
    if (!filesystem.hasOpenFolder()) {
      return;
    }
    const rootName = filesystem.getRootName();
    if (typeof vm.nudgeShell === "function") {
      vm.nudgeShell();
    }
    setStatus("info", `Mounting ${rootName} into VM...`, 1800);
    mountOverlayState.visible = true;
    mountOverlayState.phase = "reading";
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
    const confirmed = window.confirm("Delete the local default VM snapshot?");
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
    try {
      const stateBuffer = await vm.exportSnapshotBuffer();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadBinaryFile(`mandelogue-vm-snapshot-${stamp}.bin`, stateBuffer);
      bus.emit("status", {
        level: "info",
        message: `Downloaded VM snapshot (${Math.round((stateBuffer.byteLength || 0) / 1024)} KB).`,
      });
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not download VM snapshot.",
      });
    }
  };

  const uploadVmSnapshot = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin,.state,.snapshot,application/octet-stream";

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
      const buffer = await file.arrayBuffer();
      await vm.importSnapshotBuffer(buffer, { sourceLabel: file.name || "snapshot file" });
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Could not upload VM snapshot.",
      });
    }
  };

  const syncVmToHostNow = async () => {
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder before syncing VM changes.",
      });
      return;
    }
    const result = await performVmToHostSync({ announceNoChanges: true, force: true });
    if (result && result.skipped === "busy") {
      const elapsed = vmToHostSyncStartedAt > 0 ? Date.now() - vmToHostSyncStartedAt : 0;
      if (elapsed > 7000 && typeof vm.cancelActiveCapture === "function") {
        vm.cancelActiveCapture("Stale VM sync cancelled for manual retry.");
        await new Promise((resolve) => setTimeout(resolve, 250));
        await performVmToHostSync({ announceNoChanges: true, force: true });
        return;
      }
      setStatus("info", "Sync already running.", 1200);
    }
  };

  const cloneGithubRepoInVm = async () => {
    const repoUrl = window.prompt("GitHub repository URL", "https://github.com/owner/repo");
    if (!repoUrl) {
      return;
    }

    const suggested = suggestRepoDirectory(repoUrl);
    const targetInput = window.prompt(
      "Destination folder in VM (relative to /home/user)",
      suggested
    );
    if (targetInput === null) {
      return;
    }
    const targetDirectory = normalizePath(targetInput || suggested);
    if (!targetDirectory) {
      bus.emit("status", {
        level: "error",
        message: "Destination folder cannot be empty.",
      });
      return;
    }
    if (targetDirectory.split("/").some((segment) => segment === "..")) {
      bus.emit("status", {
        level: "error",
        message: "Destination folder cannot contain '..' segments.",
      });
      return;
    }

    try {
      vm.cloneGithubRepository(repoUrl, targetDirectory);
      bus.emit("status", {
        level: "info",
        message: `Queued git clone into /home/user/${targetDirectory}`,
      });
      bottomState.vmMessage = `Cloning ${repoUrl}`;
      renderBottomBar();
    } catch (error) {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Failed to queue git clone.",
      });
    }
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

  const runCompileCommand = async (compilerLabel, command) => {
    bus.emit("terminal-output", {
      data: `[compile] Starting ${compilerLabel} build...\r\n`,
    });

    let result = null;
    try {
      result = await vm.runCapturedCommandWithExitCode(command, { timeoutMs: 300000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Compile command failed.";
      bus.emit("terminal-output", {
        data: `[compile] ${message}\r\n`,
      });
      bus.emit("status", {
        level: "error",
        message,
      });
      return;
    }

    if (result.output) {
      const outputWithCrlf = result.output.replace(/\r?\n/g, "\r\n");
      bus.emit("terminal-output", {
        data: outputWithCrlf.endsWith("\r\n") ? outputWithCrlf : `${outputWithCrlf}\r\n`,
      });
    }

    bus.emit("terminal-output", {
      data: `[compile] Exit code: ${result.exitCode}\r\n`,
    });
    bus.emit("status", {
      level: result.exitCode === 0 ? "info" : "error",
      message:
        result.exitCode === 0
          ? `${compilerLabel} compile finished successfully.`
          : `${compilerLabel} compile failed with exit code ${result.exitCode}.`,
    });
  };

  const compileInVm = async (tool) => {
    if (!filesystem.hasOpenFolder()) {
      bus.emit("status", {
        level: "error",
        message: "Open a folder before compiling.",
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
    const sourceInput = window.prompt(`${config.label} input file`, defaultInput);
    if (!sourceInput) {
      return;
    }
    const sourcePath = normalizePath(sourceInput);
    if (!sourcePath || sourcePath.startsWith("untitled:")) {
      bus.emit("status", {
        level: "error",
        message: "Choose a saved source file inside the opened folder.",
      });
      return;
    }
    if (!filesystem.hasFileHandle(sourcePath)) {
      bus.emit("status", {
        level: "error",
        message: `Input file is not in the opened folder: ${sourcePath}`,
      });
      return;
    }

    const includeAll = window.confirm("Include all matching files from the opened folder?");
    const outputDefault = `${basenameWithoutExtension(sourcePath)}.out`;
    const outputInput = window.prompt("Output file path", outputDefault);
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
    renderExplorerTree(dom.explorer, result.tree, openFileInEditor);
    bus.emit("status", {
      level: "info",
      message: `Opened folder ${result.rootName}`,
    });
    renderBottomBar();
    if (typeof vm.nudgeShell === "function") {
      vm.nudgeShell();
    }
    vm.setWorkingDirectory(result.rootName);
    startVmToHostAutoSync();
    mountFolderToVm().catch((error) => {
      bus.emit("status", {
        level: "error",
        message: error instanceof Error ? error.message : "Failed to mount folder into VM.",
      });
    });
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

  const handleDocumentPointerDown = (event) => {
    if (dom.settingsMenu?.dataset.open !== "true" || !dom.settingsRoot) {
      return;
    }
    if (dom.settingsRoot.contains(event.target)) {
      return;
    }
    setSettingsMenuOpen(false);
  };

  dom.explorer.addEventListener("contextmenu", handleExplorerContextMenu);
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
    bus.on("terminal-input", () => {
      lastTerminalInputAt = Date.now();
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
        label: "Sync VM -> Device",
        onSelect: syncVmToHostNow,
      },
      {
        type: "separator",
      },
      {
        label: "Clone GitHub Repo In VM",
        onSelect: cloneGithubRepoInVm,
      },
    ],
  });

  topbar.addTab({
    id: "compiler",
    label: "Compiler",
    items: [
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
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    editor.dispose();
    terminal.dispose();
    vm.dispose();
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
