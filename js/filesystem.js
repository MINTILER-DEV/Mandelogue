const DEFAULT_CONFIG = {
  maxEntries: 15000,
  maxDepth: 48,
  maxMountFiles: 2000,
  maxMountFileBytes: 768 * 1024,
  maxMountTotalBytes: 32 * 1024 * 1024,
  scanYieldEvery: 120,
  readYieldEvery: 24,
};

const BASE_IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".venv",
  "venv",
  "env",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".sass-cache",
  "coverage",
  ".gradle",
  ".cargo",
  ".terraform",
  ".serverless",
  ".aws-sam",
  "target",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
]);

const BASE_IGNORED_FILE_NAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

const BASE_IGNORED_SUFFIXES = [
  ".pyc",
  ".pyo",
  ".pyd",
  ".class",
  ".o",
  ".obj",
  ".so",
  ".dll",
  ".dylib",
  ".exe",
  ".a",
  ".lib",
  ".tmp",
  ".swp",
  ".swo",
  ".log",
];

function normalizePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function splitPath(input) {
  const normalized = normalizePath(input);
  return normalized ? normalized.split("/") : [];
}

function parentPath(input) {
  const normalized = normalizePath(input);
  if (!normalized || !normalized.includes("/")) {
    return "";
  }
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function sortChildren(children) {
  children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64Text) {
  const binary = atob(base64Text || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function cloneBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes.slice();
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes.slice(0));
  }
  return new Uint8Array(0);
}

function textToBytes(text) {
  return new TextEncoder().encode(String(text ?? ""));
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes || new Uint8Array(0));
}

function createDeferredYield() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function getBasename(path) {
  const normalized = normalizePath(path);
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("/");
  return segments[segments.length - 1] || "";
}

function buildMountIgnoreRules(filePaths) {
  const loweredPaths = filePaths.map((path) => normalizePath(path).toLowerCase());
  const hasNodeProject = loweredPaths.some((path) =>
    ["package.json", "pnpm-lock.yaml", "yarn.lock"].includes(getBasename(path))
  );
  const hasPythonProject = loweredPaths.some((path) =>
    ["pyproject.toml", "requirements.txt", "setup.py", "pipfile"].includes(getBasename(path))
  );

  const ignoredDirNames = new Set();
  for (const dirName of BASE_IGNORED_DIR_NAMES) {
    ignoredDirNames.add(dirName);
  }

  if (!hasNodeProject) {
    ignoredDirNames.delete("node_modules");
    ignoredDirNames.delete(".next");
    ignoredDirNames.delete(".nuxt");
    ignoredDirNames.delete(".turbo");
  }
  if (!hasPythonProject) {
    ignoredDirNames.delete("__pycache__");
    ignoredDirNames.delete(".pytest_cache");
    ignoredDirNames.delete(".mypy_cache");
    ignoredDirNames.delete(".ruff_cache");
    ignoredDirNames.delete(".tox");
    ignoredDirNames.delete(".nox");
  }

  return {
    ignoredDirNames,
    ignoredFileNames: BASE_IGNORED_FILE_NAMES,
    ignoredSuffixes: BASE_IGNORED_SUFFIXES,
  };
}

function buildScanIgnoreRules() {
  return {
    ignoredDirNames: new Set(BASE_IGNORED_DIR_NAMES),
    ignoredFileNames: BASE_IGNORED_FILE_NAMES,
    ignoredSuffixes: BASE_IGNORED_SUFFIXES,
  };
}

function shouldIgnoreMountPath(relativePath, rules) {
  const normalized = normalizePath(relativePath);
  if (!normalized) {
    return null;
  }

  const loweredPath = normalized.toLowerCase();
  const segments = loweredPath.split("/");
  const fileName = segments[segments.length - 1] || "";

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (rules.ignoredDirNames.has(segments[index])) {
      return `Ignored by directory rule: ${segments[index]}`;
    }
  }

  if (rules.ignoredFileNames.has(fileName)) {
    return `Ignored by file rule: ${fileName}`;
  }

  for (const suffix of rules.ignoredSuffixes) {
    if (fileName.endsWith(suffix)) {
      return `Ignored by extension rule: ${suffix}`;
    }
  }

  return null;
}

function shouldIgnoreScanPath(relativePath, kind, rules) {
  const normalized = normalizePath(relativePath);
  if (!normalized) {
    return null;
  }

  const segments = normalized.toLowerCase().split("/");
  if (kind === "directory") {
    for (const segment of segments) {
      if (rules.ignoredDirNames.has(segment)) {
        return `Ignored by directory rule: ${segment}`;
      }
    }
    return null;
  }

  return shouldIgnoreMountPath(relativePath, rules);
}

export class FileSystemService {
  constructor(bus, config = {}) {
    this.bus = bus;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.workspaceMode = "none";
    this.rootHandle = null;
    this.rootName = "";
    this.tree = null;
    this.fileHandleMap = new Map();
    this.projectFileMap = new Map();
    this.projectDirectorySet = new Set();
  }

  isSupported() {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
  }

  hasOpenFolder() {
    if (this.workspaceMode === "project") {
      return Boolean(this.rootName);
    }
    return Boolean(this.rootHandle);
  }

  getRootName() {
    return this.rootName;
  }

  getWorkspaceMode() {
    return this.workspaceMode;
  }

  isProjectMode() {
    return this.workspaceMode === "project";
  }

  isDeviceFolderMode() {
    return this.workspaceMode === "device";
  }

  getTree() {
    return this.tree;
  }

  hasFileHandle(relativePath) {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return false;
    }
    if (this.workspaceMode === "project") {
      return this.projectFileMap.has(normalized);
    }
    return this.fileHandleMap.has(normalized);
  }

  getConfigSnapshot() {
    return { ...this.config };
  }

  updateConfig(partialConfig = {}) {
    const next = { ...this.config };
    const numericKeys = [
      "maxEntries",
      "maxDepth",
      "maxMountFiles",
      "maxMountFileBytes",
      "maxMountTotalBytes",
      "scanYieldEvery",
      "readYieldEvery",
    ];
    for (const key of numericKeys) {
      if (!(key in partialConfig)) {
        continue;
      }
      const value = Number(partialConfig[key]);
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }
      next[key] = Math.floor(value);
    }
    this.config = next;
    return this.getConfigSnapshot();
  }

  async openFolder() {
    if (!this.isSupported()) {
      throw new Error("File System Access API is not available in this browser.");
    }

    const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    this.workspaceMode = "device";
    this.rootHandle = directoryHandle;
    this.rootName = directoryHandle.name;
    this.fileHandleMap.clear();
    this.projectFileMap.clear();
    this.projectDirectorySet.clear();
    this.tree = await this.scanDirectoryTree(directoryHandle);
    return { rootName: this.rootName, tree: this.tree };
  }

  openProject(projectName, files = []) {
    const name = String(projectName || "").trim() || "Project";
    this.workspaceMode = "project";
    this.rootHandle = null;
    this.rootName = name;
    this.fileHandleMap.clear();
    this.projectFileMap.clear();
    this.projectDirectorySet.clear();

    for (const entry of files) {
      const relativePath = normalizePath(entry?.relativePath || entry?.path || "");
      if (!relativePath) {
        continue;
      }
      let bytes = null;
      if (typeof entry?.base64 === "string") {
        try {
          bytes = base64ToBytes(entry.base64);
        } catch (error) {
          bytes = null;
        }
      } else if (entry?.bytes) {
        bytes = cloneBytes(entry.bytes);
      } else if (typeof entry?.content === "string") {
        bytes = textToBytes(entry.content);
      }
      this.projectFileMap.set(relativePath, bytes || new Uint8Array(0));
      this.ensureProjectParentDirectories(relativePath);
    }

    if (Array.isArray(files)) {
      for (const entry of files) {
        const rawDir = normalizePath(entry?.directoryPath || entry?.dir || "");
        if (rawDir) {
          this.projectDirectorySet.add(rawDir);
        }
      }
    }

    this.tree = this.buildProjectTreeFromPaths(
      Array.from(this.projectFileMap.keys()),
      Array.from(this.projectDirectorySet)
    );
    return { rootName: this.rootName, tree: this.tree };
  }

  createEmptyProject(projectName = "Project") {
    return this.openProject(projectName, []);
  }

  ensureProjectParentDirectories(relativePath) {
    if (this.workspaceMode !== "project") {
      return;
    }
    const normalized = normalizePath(relativePath);
    const segments = splitPath(normalized);
    let cumulative = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      cumulative = cumulative ? `${cumulative}/${segments[index]}` : segments[index];
      this.projectDirectorySet.add(cumulative);
    }
  }

  async scanDirectoryTree(rootHandle) {
    const tree = {
      type: "directory",
      name: rootHandle.name,
      path: "",
      children: [],
    };

    const queue = [{ handle: rootHandle, node: tree, depth: 0, path: "" }];
    const ignoreRules = buildScanIgnoreRules();
    let seenEntries = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      const childEntries = [];

      for await (const [name, handle] of current.handle.entries()) {
        childEntries.push({ name, handle });
      }

      childEntries.sort((left, right) => {
        if (left.handle.kind !== right.handle.kind) {
          return left.handle.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

      for (const entry of childEntries) {
        seenEntries += 1;
        if (seenEntries > this.config.maxEntries) {
          throw new Error(`Folder has more than ${this.config.maxEntries} entries; import cancelled.`);
        }

        const childPath = current.path ? `${current.path}/${entry.name}` : entry.name;
        const ignoredReason = shouldIgnoreScanPath(childPath, entry.handle.kind, ignoreRules);
        if (ignoredReason) {
          continue;
        }

        if (entry.handle.kind === "directory") {
          const directoryNode = {
            type: "directory",
            name: entry.name,
            path: childPath,
            children: [],
          };
          current.node.children.push(directoryNode);
          if (current.depth + 1 <= this.config.maxDepth) {
            queue.push({
              handle: entry.handle,
              node: directoryNode,
              depth: current.depth + 1,
              path: childPath,
            });
          }
        } else {
          const fileNode = {
            type: "file",
            name: entry.name,
            path: childPath,
          };
          current.node.children.push(fileNode);
          this.fileHandleMap.set(childPath, entry.handle);
        }

        if (seenEntries % this.config.scanYieldEvery === 0) {
          await createDeferredYield();
        }
      }
    }

    return tree;
  }

  async readFile(relativePath) {
    const normalized = normalizePath(relativePath);
    if (this.workspaceMode === "project") {
      const bytes = this.projectFileMap.get(normalized);
      if (!bytes) {
        throw new Error(`Cannot read missing file: ${normalized}`);
      }
      return bytesToText(bytes);
    }
    const handle = this.fileHandleMap.get(normalized);
    if (!handle) {
      throw new Error(`Cannot read missing file: ${normalized}`);
    }
    const file = await handle.getFile();
    return file.text();
  }

  async writeFile(relativePath, content) {
    if (!this.hasOpenFolder()) {
      throw new Error("No folder is currently open.");
    }

    const normalized = normalizePath(relativePath);
    if (this.workspaceMode === "project") {
      const existed = this.projectFileMap.has(normalized);
      this.ensureProjectParentDirectories(normalized);
      this.projectFileMap.set(normalized, textToBytes(content));
      if (!existed) {
        this.insertFileNode(normalized);
      }
      return;
    }
    const existed = this.fileHandleMap.has(normalized);
    const fileHandle = await this.getOrCreateFileHandle(normalized);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    if (!existed) {
      this.insertFileNode(normalized);
    }
  }

  async writeFileBytes(relativePath, bytes) {
    if (!this.hasOpenFolder()) {
      throw new Error("No folder is currently open.");
    }

    const normalized = normalizePath(relativePath);
    if (this.workspaceMode === "project") {
      const existed = this.projectFileMap.has(normalized);
      this.ensureProjectParentDirectories(normalized);
      this.projectFileMap.set(normalized, cloneBytes(bytes));
      if (!existed) {
        this.insertFileNode(normalized);
      }
      return;
    }
    const existed = this.fileHandleMap.has(normalized);
    const fileHandle = await this.getOrCreateFileHandle(normalized);
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    if (!existed) {
      this.insertFileNode(normalized);
    }
  }

  async createFile(relativePath) {
    if (!this.hasOpenFolder()) {
      throw new Error("Open a folder before creating files.");
    }

    const normalized = normalizePath(relativePath);
    if (this.workspaceMode === "project") {
      this.ensureProjectParentDirectories(normalized);
      if (!this.projectFileMap.has(normalized)) {
        this.projectFileMap.set(normalized, new Uint8Array(0));
      }
      this.insertFileNode(normalized);
      return normalized;
    }
    await this.getOrCreateFileHandle(normalized);
    this.insertFileNode(normalized);
    return normalized;
  }

  async createFolder(relativePath) {
    if (!this.hasOpenFolder()) {
      throw new Error("Open a folder before creating folders.");
    }

    const normalized = normalizePath(relativePath);
    if (!normalized) {
      throw new Error("Folder path must not be empty.");
    }

    if (this.workspaceMode === "project") {
      this.projectDirectorySet.add(normalized);
      this.insertDirectoryNode(normalized);
      return normalized;
    }
    await this.getOrCreateDirectoryHandle(normalized);
    this.insertDirectoryNode(normalized);
    return normalized;
  }

  async removeEntry(relativePath, options = {}) {
    if (!this.hasOpenFolder()) {
      throw new Error("No folder is currently open.");
    }

    const normalized = normalizePath(relativePath);
    if (!normalized) {
      throw new Error("Cannot remove the root folder.");
    }

    const recursive = options.recursive !== false;
    const entryType = this.getEntryType(normalized);
    if (!entryType) {
      throw new Error(`Cannot remove missing path: ${normalized}`);
    }

    if (this.workspaceMode === "project") {
      if (entryType === "file") {
        this.projectFileMap.delete(normalized);
      } else {
        for (const key of Array.from(this.projectFileMap.keys())) {
          if (key === normalized || key.startsWith(`${normalized}/`)) {
            this.projectFileMap.delete(key);
          }
        }
        for (const dirPath of Array.from(this.projectDirectorySet.values())) {
          if (dirPath === normalized || dirPath.startsWith(`${normalized}/`)) {
            this.projectDirectorySet.delete(dirPath);
          }
        }
      }
      this.removeNode(normalized);
      return entryType;
    }

    const parent = parentPath(normalized);
    const name = normalized.slice(parent.length ? parent.length + 1 : 0);
    const parentHandle = parent
      ? await this.getOrCreateDirectoryHandle(parent)
      : this.rootHandle;
    await parentHandle.removeEntry(name, { recursive });

    if (entryType === "file") {
      this.fileHandleMap.delete(normalized);
    } else {
      for (const key of Array.from(this.fileHandleMap.keys())) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          this.fileHandleMap.delete(key);
        }
      }
    }
    this.removeNode(normalized);
    return entryType;
  }

  async renameEntry(oldRelativePath, newRelativePath) {
    if (!this.hasOpenFolder()) {
      throw new Error("No folder is currently open.");
    }

    const oldPath = normalizePath(oldRelativePath);
    const newPath = normalizePath(newRelativePath);
    if (!oldPath) {
      throw new Error("Cannot rename the root folder.");
    }
    if (!newPath) {
      throw new Error("New path must not be empty.");
    }
    if (oldPath === newPath) {
      const entryType = this.getEntryType(oldPath);
      if (!entryType) {
        throw new Error(`Cannot rename missing path: ${oldPath}`);
      }
      return { type: entryType, oldPath, newPath };
    }

    const entryType = this.getEntryType(oldPath);
    if (!entryType) {
      throw new Error(`Cannot rename missing path: ${oldPath}`);
    }
    if (this.getEntryType(newPath)) {
      throw new Error(`Cannot rename to existing path: ${newPath}`);
    }
    if (entryType === "directory" && newPath.startsWith(`${oldPath}/`)) {
      throw new Error("Cannot move a folder into itself.");
    }

    if (this.workspaceMode === "project") {
      if (entryType === "file") {
        const bytes = this.projectFileMap.get(oldPath);
        this.projectFileMap.delete(oldPath);
        this.ensureProjectParentDirectories(newPath);
        this.projectFileMap.set(newPath, bytes || new Uint8Array(0));
      } else {
        const moved = [];
        for (const [path, bytes] of this.projectFileMap.entries()) {
          if (path === oldPath || path.startsWith(`${oldPath}/`)) {
            const suffix = path === oldPath ? "" : path.slice(oldPath.length + 1);
            const rewritten = suffix ? `${newPath}/${suffix}` : newPath;
            moved.push([path, rewritten, bytes]);
          }
        }
        for (const [oldKey] of moved) {
          this.projectFileMap.delete(oldKey);
        }
        for (const [, newKey, bytes] of moved) {
          this.projectFileMap.set(newKey, bytes);
        }
        const movedDirs = [];
        for (const dirPath of this.projectDirectorySet.values()) {
          if (dirPath === oldPath || dirPath.startsWith(`${oldPath}/`)) {
            const suffix = dirPath === oldPath ? "" : dirPath.slice(oldPath.length + 1);
            const rewritten = suffix ? `${newPath}/${suffix}` : newPath;
            movedDirs.push([dirPath, rewritten]);
          }
        }
        for (const [oldDir] of movedDirs) {
          this.projectDirectorySet.delete(oldDir);
        }
        for (const [, newDir] of movedDirs) {
          this.projectDirectorySet.add(newDir);
        }
      }
      this.tree = this.buildProjectTreeFromPaths(
        Array.from(this.projectFileMap.keys()),
        Array.from(this.projectDirectorySet)
      );
      return { type: entryType, oldPath, newPath };
    }

    if (entryType === "file") {
      await this.renameFileEntry(oldPath, newPath);
    } else {
      await this.renameDirectoryEntry(oldPath, newPath);
    }

    // Re-scan once after rename to keep tree and handle map accurate.
    this.fileHandleMap.clear();
    this.tree = await this.scanDirectoryTree(this.rootHandle);
    return { type: entryType, oldPath, newPath };
  }

  async getOrCreateFileHandle(relativePath) {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      throw new Error("File path must not be empty.");
    }

    if (this.fileHandleMap.has(normalized)) {
      return this.fileHandleMap.get(normalized);
    }

    const segments = splitPath(normalized);
    const fileName = segments.pop();
    let directory = this.rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    this.fileHandleMap.set(normalized, fileHandle);
    return fileHandle;
  }

  async getDirectoryHandle(relativePath) {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return this.rootHandle;
    }
    const segments = splitPath(normalized);
    let directory = this.rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment);
    }
    return directory;
  }

  async getOrCreateDirectoryHandle(relativePath) {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return this.rootHandle;
    }

    const segments = splitPath(normalized);
    let directory = this.rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    return directory;
  }

  buildProjectTreeFromPaths(filePaths = [], directoryPaths = []) {
    const tree = {
      type: "directory",
      name: this.rootName || "Project",
      path: "",
      children: [],
    };
    this.tree = tree;
    const uniqueDirs = Array.from(new Set(directoryPaths.map((path) => normalizePath(path)).filter(Boolean)));
    uniqueDirs.sort((left, right) => left.localeCompare(right));
    for (const directoryPath of uniqueDirs) {
      this.insertDirectoryNode(directoryPath);
    }
    for (const path of filePaths) {
      const normalized = normalizePath(path);
      if (!normalized) {
        continue;
      }
      this.insertFileNode(normalized);
    }
    return tree;
  }

  async exportMlpPayload() {
    if (!this.hasOpenFolder()) {
      throw new Error("No folder or project is currently open.");
    }

    let entries = [];
    if (this.workspaceMode === "project") {
      entries = Array.from(this.projectFileMap.entries()).map(([relativePath, bytes]) => ({
        path: relativePath,
        base64: bytesToBase64(bytes),
      }));
    } else {
      entries = [];
      for (const [relativePath, handle] of this.fileHandleMap.entries()) {
        try {
          const file = await handle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          entries.push({
            path: relativePath,
            base64: bytesToBase64(bytes),
          });
        } catch (error) {
          // Skip unreadable files while exporting project payload.
        }
      }
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    const directoryPaths = this.collectDirectoryPathsFromTree(this.tree);
    for (const dirPath of this.projectDirectorySet.values()) {
      directoryPaths.add(normalizePath(dirPath));
    }

    return {
      format: "mlp",
      version: 1,
      rootName: this.rootName || "Project",
      createdAt: Date.now(),
      directories: Array.from(directoryPaths).filter(Boolean).sort((a, b) => a.localeCompare(b)),
      files: entries,
    };
  }

  openMlpPayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid Mandelogue project file.");
    }
    if (payload.format !== "mlp") {
      throw new Error("Unsupported project format.");
    }
    if (Number(payload.version) !== 1) {
      throw new Error("Unsupported Mandelogue project version.");
    }

    const files = Array.isArray(payload.files) ? payload.files : [];
    const directories = Array.isArray(payload.directories)
      ? payload.directories.map((dir) => ({
          directoryPath: dir,
        }))
      : [];
    return this.openProject(payload.rootName || "Project", [...files, ...directories]);
  }

  collectDirectoryPathsFromTree(node) {
    const result = new Set();
    const visit = (current) => {
      if (!current || current.type !== "directory") {
        return;
      }
      const normalized = normalizePath(current.path || "");
      if (normalized) {
        result.add(normalized);
      }
      if (!Array.isArray(current.children)) {
        return;
      }
      for (const child of current.children) {
        if (child.type === "directory") {
          visit(child);
        }
      }
    };
    visit(node);
    return result;
  }

  async renameFileEntry(oldPath, newPath) {
    const sourceHandle = this.fileHandleMap.get(oldPath);
    if (!sourceHandle) {
      throw new Error(`Cannot rename missing file: ${oldPath}`);
    }

    const targetParentPath = parentPath(newPath);
    const targetName = getBasename(newPath);
    const targetParentHandle = targetParentPath
      ? await this.getOrCreateDirectoryHandle(targetParentPath)
      : this.rootHandle;
    const targetHandle = await targetParentHandle.getFileHandle(targetName, { create: true });
    await this.copyFileHandleContents(sourceHandle, targetHandle);

    const sourceParentPath = parentPath(oldPath);
    const sourceName = getBasename(oldPath);
    const sourceParentHandle = sourceParentPath
      ? await this.getDirectoryHandle(sourceParentPath)
      : this.rootHandle;
    await sourceParentHandle.removeEntry(sourceName, { recursive: false });
  }

  async renameDirectoryEntry(oldPath, newPath) {
    const sourceDirectoryHandle = await this.getDirectoryHandle(oldPath);
    const targetDirectoryHandle = await this.getOrCreateDirectoryHandle(newPath);
    await this.copyDirectoryContents(sourceDirectoryHandle, targetDirectoryHandle);

    const sourceParentPath = parentPath(oldPath);
    const sourceName = getBasename(oldPath);
    const sourceParentHandle = sourceParentPath
      ? await this.getDirectoryHandle(sourceParentPath)
      : this.rootHandle;
    await sourceParentHandle.removeEntry(sourceName, { recursive: true });
  }

  async copyDirectoryContents(sourceDirectoryHandle, targetDirectoryHandle) {
    const queue = [{ source: sourceDirectoryHandle, target: targetDirectoryHandle }];
    while (queue.length > 0) {
      const current = queue.shift();
      for await (const [name, handle] of current.source.entries()) {
        if (handle.kind === "directory") {
          const targetChild = await current.target.getDirectoryHandle(name, { create: true });
          queue.push({ source: handle, target: targetChild });
          continue;
        }
        const targetFile = await current.target.getFileHandle(name, { create: true });
        await this.copyFileHandleContents(handle, targetFile);
      }
    }
  }

  async copyFileHandleContents(sourceFileHandle, targetFileHandle) {
    const file = await sourceFileHandle.getFile();
    const writable = await targetFileHandle.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
  }

  insertFileNode(relativePath) {
    if (!this.tree) {
      return;
    }

    const segments = splitPath(relativePath);
    const fileName = segments.pop();
    let pointer = this.tree;
    let cumulativePath = "";

    for (const segment of segments) {
      cumulativePath = cumulativePath ? `${cumulativePath}/${segment}` : segment;
      let childDirectory = pointer.children.find(
        (item) => item.type === "directory" && item.name === segment
      );
      if (!childDirectory) {
        childDirectory = {
          type: "directory",
          name: segment,
          path: cumulativePath,
          children: [],
        };
        pointer.children.push(childDirectory);
      }
      pointer = childDirectory;
    }

    const alreadyPresent = pointer.children.some(
      (item) => item.type === "file" && item.name === fileName
    );
    if (!alreadyPresent) {
      const filePath = cumulativePath ? `${cumulativePath}/${fileName}` : fileName;
      pointer.children.push({
        type: "file",
        name: fileName,
        path: filePath,
      });
      sortChildren(pointer.children);
    }
  }

  insertDirectoryNode(relativePath) {
    if (!this.tree) {
      return;
    }

    const segments = splitPath(relativePath);
    let pointer = this.tree;
    let cumulativePath = "";

    for (const segment of segments) {
      cumulativePath = cumulativePath ? `${cumulativePath}/${segment}` : segment;
      let childDirectory = pointer.children.find(
        (item) => item.type === "directory" && item.name === segment
      );
      if (!childDirectory) {
        childDirectory = {
          type: "directory",
          name: segment,
          path: cumulativePath,
          children: [],
        };
        pointer.children.push(childDirectory);
        sortChildren(pointer.children);
      }
      pointer = childDirectory;
    }
  }

  removeNode(relativePath) {
    if (!this.tree) {
      return;
    }
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return;
    }
    const parent = parentPath(normalized);
    const nodeName = normalized.slice(parent.length ? parent.length + 1 : 0);
    const parentNode = parent ? this.getNode(parent) : this.tree;
    if (!parentNode || !Array.isArray(parentNode.children)) {
      return;
    }
    const index = parentNode.children.findIndex((child) => child.name === nodeName);
    if (index >= 0) {
      parentNode.children.splice(index, 1);
    }
  }

  getNode(relativePath) {
    if (!this.tree) {
      return null;
    }
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return this.tree;
    }

    const segments = splitPath(normalized);
    let pointer = this.tree;
    for (const segment of segments) {
      const child = pointer.children.find(
        (item) => item.type === "directory" && item.name === segment
      );
      if (!child) {
        return null;
      }
      pointer = child;
    }
    return pointer;
  }

  getEntryType(relativePath) {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
      return "directory";
    }
    if (this.workspaceMode === "project" && this.projectFileMap.has(normalized)) {
      return "file";
    }
    if (this.fileHandleMap.has(normalized)) {
      return "file";
    }
    const node = this.getNode(normalized);
    if (node && node.type === "directory") {
      return "directory";
    }
    return null;
  }

  getMountIgnoreReason(relativePath) {
    const allPaths =
      this.workspaceMode === "project"
        ? Array.from(this.projectFileMap.keys())
        : Array.from(this.fileHandleMap.keys());
    const rules = buildMountIgnoreRules(allPaths);
    return shouldIgnoreMountPath(relativePath, rules);
  }

  async collectMountableFiles() {
    const files = [];
    const skipped = [];
    const entries =
      this.workspaceMode === "project"
        ? Array.from(this.projectFileMap.entries()).sort((left, right) =>
            left[0].localeCompare(right[0])
          )
        : Array.from(this.fileHandleMap.entries()).sort((left, right) =>
            left[0].localeCompare(right[0])
          );
    const ignoreRules = buildMountIgnoreRules(entries.map(([relativePath]) => relativePath));
    let limitedCount = 0;
    let limitedByTotalBytesCount = 0;
    let mountedBytes = 0;

    for (let index = 0; index < entries.length; index += 1) {
      const [relativePath, source] = entries[index];
      try {
        const ignoredReason = shouldIgnoreMountPath(relativePath, ignoreRules);
        if (ignoredReason) {
          skipped.push({
            path: relativePath,
            reason: ignoredReason,
          });
          continue;
        }

        if (files.length >= this.config.maxMountFiles) {
          limitedCount += 1;
          continue;
        }

        let bytes = null;
        if (this.workspaceMode === "project") {
          bytes = cloneBytes(source);
        } else {
          const file = await source.getFile();
          bytes = new Uint8Array(await file.arrayBuffer());
        }
        const fileSize = bytes.byteLength;

        if (fileSize > this.config.maxMountFileBytes) {
          skipped.push({
            path: relativePath,
            reason: `Skipped files larger than ${this.config.maxMountFileBytes} bytes.`,
          });
          continue;
        }
        if (mountedBytes + fileSize > this.config.maxMountTotalBytes) {
          limitedByTotalBytesCount += 1;
          continue;
        }

        files.push({
          relativePath,
          base64: bytesToBase64(bytes),
          bytes: fileSize,
        });
        mountedBytes += fileSize;
      } catch (error) {
        skipped.push({
          path: relativePath,
          reason: error instanceof Error ? error.message : "Unknown read error.",
        });
      }

      if ((index + 1) % this.config.readYieldEvery === 0) {
        this.bus.emit("mount-read-progress", {
          processed: index + 1,
          total: entries.length,
        });
        await createDeferredYield();
      }
    }

    if (limitedCount > 0) {
      skipped.push({
        path: "",
        reason: `Skipped ${limitedCount} extra files due to mount limit.`,
      });
    }
    if (limitedByTotalBytesCount > 0) {
      skipped.push({
        path: "",
        reason: `Skipped ${limitedByTotalBytesCount} files due to ${this.config.maxMountTotalBytes} byte total mount cap.`,
      });
    }

    return {
      files,
      skipped,
      total: entries.length,
    };
  }
}
