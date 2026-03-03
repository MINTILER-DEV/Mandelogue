const DEFAULT_VM_CONFIG = {
  memoryMb: 512,
  vgaMemoryMb: 16,
  autostart: true,
  // jsDelivr provides permissive CORS headers required by localhost dev servers.
  v86ScriptUrl: "https://cdn.jsdelivr.net/npm/v86@0.5.319+g62fd36e/build/libv86.js",
  wasmUrl: "https://cdn.jsdelivr.net/npm/v86@0.5.319+g62fd36e/build/v86.wasm",
  biosUrl: "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin",
  vgaBiosUrl: "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin",
  // Keep blank by default: some hosts hotlink-block or return incompatible state blobs.
  initialStateUrl: "",
  filesystemBaseUrl: "https://i.copy.sh/arch/",
  filesystemIndexUrl: "https://i.copy.sh/fs.json",
  bootFromFilesystem: true,
  enableSnapshots: true,
  autoLoadDefaultSnapshot: true,
  defaultSnapshotKey: "default",
  snapshotDbName: "mandelogue-vm",
  snapshotStoreName: "snapshots",
  cmdline:
    "rw apm=off vga=0x344 video=vesafb:ypan,vremap:8 root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose mitigations=off audit=0 init_on_free=on tsc=reliable random.trust_cpu=on nowatchdog init=/usr/bin/init-openrc net.ifnames=0 biosdevname=0",
};

const MOUNT_BATCH_COMMAND_LIMIT = 24;
const MOUNT_BATCH_COMMAND_LIMIT_MIN = 8;
const MOUNT_BATCH_COMMAND_LIMIT_MAX = 64;
const MOUNT_BATCH_CHAR_LIMIT = 16000;
const MOUNT_BATCH_CHAR_LIMIT_MIN = 4000;
const MOUNT_BATCH_CHAR_LIMIT_MAX = 32000;
const MOUNT_BASE64_CHUNK_SIZE = 768;
const MOUNT_BASE64_CHUNK_MIN = 128;
const MOUNT_BASE64_CHUNK_MAX = 2048;

let sharedV86ScriptPromise = null;

class VmSnapshotStore {
  constructor(dbName, storeName) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.dbPromise = null;
  }

  isSupported() {
    return typeof indexedDB !== "undefined";
  }

  async open() {
    if (!this.isSupported()) {
      throw new Error("IndexedDB is unavailable in this browser.");
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open snapshot database."));
    });

    return this.dbPromise;
  }

  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Failed to read snapshot."));
    });
  }

  async put(record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to store snapshot."));
      tx.onabort = () => reject(tx.error || new Error("Snapshot write transaction aborted."));
    });
  }

  async remove(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Failed to delete snapshot."));
      tx.onabort = () => reject(tx.error || new Error("Snapshot delete transaction aborted."));
    });
  }
}

function loadScript(url) {
  if (sharedV86ScriptPromise) {
    return sharedV86ScriptPromise;
  }

  sharedV86ScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load v86 runtime script."));
    document.head.appendChild(script);
  });

  return sharedV86ScriptPromise;
}

function getV86Constructor() {
  if (typeof window.V86Starter === "function") {
    return {
      constructor: window.V86Starter,
      runtimeName: "V86Starter",
    };
  }
  if (typeof window.V86 === "function") {
    return {
      constructor: window.V86,
      runtimeName: "V86",
    };
  }
  return null;
}

function createDeferredYield() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function normalizeVmPath(path) {
  const cleaned = String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/?/, "/")
    .replace(/\/$/, "");
  return cleaned || "/";
}

function dirname(path) {
  const normalized = normalizeVmPath(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}

function shellQuote(input) {
  return `'${String(input).replace(/'/g, `'\"'\"'`)}'`;
}

function encodeUtf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64Utf8(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function toSerialCharacter(data) {
  if (typeof data === "string") {
    return data;
  }
  if (typeof data === "number") {
    return String.fromCharCode(data);
  }
  return "";
}

function pickNumber(source, keys) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function pickString(source, keys) {
  if (!source || typeof source !== "object") {
    return "";
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function humanBytes(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function basenameFromUrl(value) {
  if (!value) {
    return "";
  }
  const trimmed = value.split("?", 1)[0];
  const segments = trimmed.split("/");
  return segments[segments.length - 1] || trimmed;
}

function suggestRepoDirectory(input) {
  const match = String(input || "").trim().match(/\/([^/]+?)(?:\.git)?(?:[#?].*)?$/);
  if (!match) {
    return "repo";
  }
  return match[1] || "repo";
}

function buildBase64WriteCommands(targetPath, payload, uniqueId, chunkSize) {
  const encoded = typeof payload === "string" ? payload : "";
  const targetQuoted = shellQuote(targetPath);
  const requestedChunkSize = Number(chunkSize) || MOUNT_BASE64_CHUNK_SIZE;
  const safeChunkSize = Math.max(
    MOUNT_BASE64_CHUNK_MIN,
    Math.min(MOUNT_BASE64_CHUNK_MAX, Math.floor(requestedChunkSize))
  );

  if (encoded.length <= safeChunkSize) {
    return [`printf '%s' ${shellQuote(encoded)} | base64 -d > ${targetQuoted}`];
  }

  const tempPath = normalizeVmPath(`/tmp/.mandelogue_${uniqueId}.b64`);
  const tempQuoted = shellQuote(tempPath);
  const commands = [`rm -f ${tempQuoted}`];
  for (let offset = 0; offset < encoded.length; offset += safeChunkSize) {
    const slice = encoded.slice(offset, offset + safeChunkSize);
    commands.push(`printf '%s' ${shellQuote(slice)} >> ${tempQuoted}`);
  }
  commands.push(`base64 -d < ${tempQuoted} > ${targetQuoted}`);
  commands.push(`rm -f ${tempQuoted}`);
  return commands;
}

function findStandaloneMarker(buffer, marker) {
  if (!buffer || !marker) {
    return null;
  }
  let offset = 0;
  while (offset < buffer.length) {
    const index = buffer.indexOf(marker, offset);
    if (index < 0) {
      return null;
    }

    const beforeIndex = index - 1;
    const startsAtLine =
      index === 0 || buffer[beforeIndex] === "\n" || buffer[beforeIndex] === "\r";
    if (!startsAtLine) {
      offset = index + 1;
      continue;
    }

    const afterIndex = index + marker.length;
    if (afterIndex > buffer.length) {
      return null;
    }
    if (afterIndex === buffer.length) {
      return {
        start: index,
        end: afterIndex,
      };
    }

    let suffixLength = 0;
    if (buffer.startsWith("\r\n", afterIndex)) {
      suffixLength = 2;
    } else if (buffer[afterIndex] === "\n" || buffer[afterIndex] === "\r") {
      suffixLength = 1;
    }

    if (suffixLength > 0) {
      return {
        start: index,
        end: afterIndex + suffixLength,
      };
    }

    offset = index + 1;
  }
  return null;
}

function stripLeadingShellPrompts(chunk, maxPrompts = Number.POSITIVE_INFINITY) {
  let remaining = String(chunk || "");
  let removed = 0;
  const promptPattern =
    /^(?:\r?\n|\r)*(?:\x1b\[[0-9;?]*[ -/]*[@-~])*[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\r\n]*?[#$] (?:\x1b\[[0-9;?]*[ -/]*[@-~])*/;

  while (removed < maxPrompts && remaining) {
    const match = remaining.match(promptPattern);
    if (!match || !match[0]) {
      break;
    }
    remaining = remaining.slice(match[0].length);
    removed += 1;
  }

  return { remaining, removed };
}

function chunkContainsShellPrompt(chunk) {
  if (!chunk) {
    return false;
  }
  const promptPattern = /(?:^|[\r\n])[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\r\n]*?[#$] /;
  return promptPattern.test(String(chunk));
}

function parseDownloadProgress(payload) {
  const loaded = pickNumber(payload, ["loaded", "bytes_loaded"]);
  const total = pickNumber(payload, ["total", "bytes_total"]);
  const fileIndexRaw = pickNumber(payload, ["file_index", "Lf"]);
  const fileCount = pickNumber(payload, ["file_count", "Kf"]);
  const asset = basenameFromUrl(
    pickString(payload, ["file_name", "name", "url", "rg", "filename"])
  );

  let percent = null;
  if (typeof loaded === "number" && typeof total === "number" && total > 0) {
    percent = (loaded / total) * 100;
  } else if (typeof fileIndexRaw === "number" && typeof fileCount === "number" && fileCount > 0) {
    percent = ((fileIndexRaw + 1) / fileCount) * 100;
  }

  let message = "VM: downloading assets...";
  if (typeof loaded === "number" && typeof total === "number" && total > 0) {
    message = `VM: downloading ${humanBytes(loaded)} / ${humanBytes(total)}`;
  }
  if (typeof fileIndexRaw === "number" && typeof fileCount === "number" && fileCount > 0) {
    message += ` [${fileIndexRaw + 1}/${fileCount}]`;
  }
  if (asset) {
    message += ` ${asset}`;
  }

  return { message, percent };
}

export class VMService {
  constructor(bus, options = {}) {
    this.bus = bus;
    this.screenContainer = options.screenContainer;
    this.config = { ...DEFAULT_VM_CONFIG, ...(options.config || {}) };
    this.emulator = null;
    this.commandQueue = [];
    this.bootOutputBuffer = "";
    this.shellReady = false;
    this.bootWarmupTimer = null;
    this.bootStartedAt = 0;
    this.promptProbeInterval = null;
    this.busUnsubscribers = [];
    this.activeCapture = null;
    this.internalShellConfigured = false;
    this.captureQueue = Promise.resolve();
    this.suppressPromptNoise = false;
    this.lastPromptSeenAt = 0;
    this.mountBatchCommandLimit = Math.max(
      MOUNT_BATCH_COMMAND_LIMIT_MIN,
      Math.min(
        MOUNT_BATCH_COMMAND_LIMIT_MAX,
        Number(this.config.mountBatchCommandLimit) || MOUNT_BATCH_COMMAND_LIMIT
      )
    );
    this.mountBatchCharLimit = Math.max(
      MOUNT_BATCH_CHAR_LIMIT_MIN,
      Math.min(
        MOUNT_BATCH_CHAR_LIMIT_MAX,
        Number(this.config.mountBatchCharLimit) || MOUNT_BATCH_CHAR_LIMIT
      )
    );
    this.mountBase64ChunkSize = Math.max(
      MOUNT_BASE64_CHUNK_MIN,
      Math.min(
        MOUNT_BASE64_CHUNK_MAX,
        Number(this.config.mountBase64ChunkSize) || MOUNT_BASE64_CHUNK_SIZE
      )
    );
    this.snapshotStore = new VmSnapshotStore(
      this.config.snapshotDbName,
      this.config.snapshotStoreName
    );
  }

  async init() {
    this.emitVmProgress("VM: loading v86 runtime script...");
    await loadScript(this.config.v86ScriptUrl);
    this.emitVmProgress("VM: runtime script loaded. Preparing VM...");
    const runtime = getV86Constructor();
    if (!runtime) {
      throw new Error(
        "v86 runtime loaded but neither V86Starter nor V86 constructor was found on window."
      );
    }

    const hasInitialState =
      typeof this.config.initialStateUrl === "string" && this.config.initialStateUrl.length > 0;
    const defaultSnapshotKey = this.config.defaultSnapshotKey || "default";
    let localSnapshotRecord = null;

    if (
      this.config.enableSnapshots &&
      this.config.autoLoadDefaultSnapshot &&
      !hasInitialState
    ) {
      this.emitVmProgress("VM: checking local default snapshot...");
      try {
        localSnapshotRecord = await this.snapshotStore.get(defaultSnapshotKey);
      } catch (error) {
        this.bus.emit("status", {
          level: "error",
          message: error instanceof Error ? error.message : "Could not read local snapshot.",
        });
      }
    }

    const vmOptions = {
      wasm_path: this.config.wasmUrl,
      memory_size: this.config.memoryMb * 1024 * 1024,
      vga_memory_size: this.config.vgaMemoryMb * 1024 * 1024,
      screen_container: this.screenContainer,
      serial_container: null,
      autostart: this.config.autostart,
      bios: { url: this.config.biosUrl },
      vga_bios: { url: this.config.vgaBiosUrl },
      cmdline: this.config.cmdline,
      disable_audio: true,
    };

    const filesystem = {};
    if (this.config.filesystemBaseUrl) {
      filesystem.baseurl = this.config.filesystemBaseUrl;
    }
    if (!hasInitialState && this.config.filesystemIndexUrl) {
      filesystem.basefs = { url: this.config.filesystemIndexUrl };
      if (this.config.bootFromFilesystem) {
        vmOptions.bzimage_initrd_from_filesystem = true;
      }
    }
    if (Object.keys(filesystem).length > 0) {
      vmOptions.filesystem = filesystem;
    }
    if (localSnapshotRecord && localSnapshotRecord.data) {
      vmOptions.initial_state = { buffer: localSnapshotRecord.data };
      this.emitVmProgress(
        `VM: loading local snapshot (${humanBytes(localSnapshotRecord.bytes || 0)}).`,
        100
      );
    } else if (hasInitialState) {
      vmOptions.initial_state = { url: this.config.initialStateUrl };
    }

    this.emulator = new runtime.constructor(vmOptions);
    this.emitVmProgress("VM: fetching boot assets...", null);

    const onSerialOutput = (value) => {
      const chunk = toSerialCharacter(value);
      if (!chunk) {
        return;
      }
      this.handleSerialOutput(chunk);
    };

    // Current libv86 emits serial0-output-byte; keep char fallback for older builds.
    this.emulator.add_listener("serial0-output-byte", onSerialOutput);
    this.emulator.add_listener("serial0-output-char", onSerialOutput);
    this.emulator.add_listener("download-progress", (payload) => {
      const parsed = parseDownloadProgress(payload);
      this.emitVmProgress(parsed.message, parsed.percent);
    });
    this.emulator.add_listener("emulator-loaded", () => {
      this.emitVmProgress("VM: assets loaded. Booting kernel...", 100);
    });

    this.emulator.add_listener("emulator-ready", () => {
      this.emitVmProgress("VM: emulator ready. Waiting for shell prompt...");
      this.bus.emit("status", {
        level: "info",
        message: `v86 VM is running (${runtime.runtimeName}).`,
      });
      this.warmupShell();
    });

    this.busUnsubscribers.push(
      this.bus.on("terminal-input", ({ data }) => {
        this.sendInput(data);
      })
    );
  }

  async saveSnapshot(key = this.config.defaultSnapshotKey || "default") {
    if (!this.config.enableSnapshots) {
      throw new Error("Snapshots are disabled by configuration.");
    }
    if (!this.emulator || typeof this.emulator.save_state !== "function") {
      throw new Error("VM is not ready to save a snapshot.");
    }

    this.emitVmProgress("VM: saving snapshot...");
    const stateBuffer = await this.emulator.save_state();
    await this.snapshotStore.put({
      key,
      data: stateBuffer,
      bytes: stateBuffer.byteLength || 0,
      createdAt: Date.now(),
    });
    this.bus.emit("status", {
      level: "info",
      message: `Saved VM snapshot "${key}" (${humanBytes(stateBuffer.byteLength)}).`,
    });
    this.emitVmProgress("VM: snapshot saved.", 100, 1600);
    return true;
  }

  async loadSnapshot(key = this.config.defaultSnapshotKey || "default") {
    if (!this.config.enableSnapshots) {
      throw new Error("Snapshots are disabled by configuration.");
    }
    if (!this.emulator || typeof this.emulator.restore_state !== "function") {
      throw new Error("VM is not ready to load a snapshot.");
    }

    const record = await this.snapshotStore.get(key);
    if (!record || !record.data) {
      return false;
    }

    this.emitVmProgress("VM: restoring local snapshot...");
    await this.emulator.restore_state(record.data);
    this.shellReady = false;
    this.bootOutputBuffer = "";
    this.warmupShell();
    this.bus.emit("status", {
      level: "info",
      message: `Loaded VM snapshot "${key}" (${humanBytes(record.bytes || 0)}).`,
    });
    return true;
  }

  async clearSnapshot(key = this.config.defaultSnapshotKey || "default") {
    if (!this.config.enableSnapshots) {
      throw new Error("Snapshots are disabled by configuration.");
    }
    await this.snapshotStore.remove(key);
    this.bus.emit("status", {
      level: "info",
      message: `Removed VM snapshot "${key}".`,
    });
  }

  async hasSnapshot(key = this.config.defaultSnapshotKey || "default") {
    if (!this.config.enableSnapshots) {
      return false;
    }
    const record = await this.snapshotStore.get(key);
    return Boolean(record && record.data);
  }

  async exportSnapshotBuffer() {
    if (!this.emulator || typeof this.emulator.save_state !== "function") {
      throw new Error("VM is not ready to export a snapshot.");
    }
    this.emitVmProgress("VM: exporting snapshot...");
    const stateBuffer = await this.emulator.save_state();
    this.emitVmProgress("VM: snapshot export complete.", 100, 1200);
    return stateBuffer;
  }

  async importSnapshotBuffer(stateBuffer, options = {}) {
    if (!this.emulator || typeof this.emulator.restore_state !== "function") {
      throw new Error("VM is not ready to import a snapshot.");
    }

    let normalizedBuffer = null;
    if (stateBuffer instanceof ArrayBuffer) {
      normalizedBuffer = stateBuffer;
    } else if (ArrayBuffer.isView(stateBuffer)) {
      const view = stateBuffer;
      normalizedBuffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    } else {
      throw new Error("Snapshot import expects an ArrayBuffer.");
    }

    const snapshotBytes = normalizedBuffer.byteLength || 0;
    if (snapshotBytes <= 0) {
      throw new Error("Snapshot file is empty.");
    }

    const sourceLabel = String(options.sourceLabel || "uploaded snapshot");
    this.emitVmProgress(`VM: importing ${sourceLabel}...`);
    await this.emulator.restore_state(normalizedBuffer);
    this.shellReady = false;
    this.bootOutputBuffer = "";
    this.warmupShell();
    this.bus.emit("status", {
      level: "info",
      message: `Imported VM snapshot (${humanBytes(snapshotBytes)}).`,
    });
    this.emitVmProgress("VM: snapshot import complete.", 100, 1800);
    return true;
  }

  warmupShell() {
    this.bootStartedAt = Date.now();
    this.internalShellConfigured = false;
    this.suppressPromptNoise = false;
    this.lastPromptSeenAt = 0;
    this.sendInput("\n", { isInternal: true });
    this.emitVmProgress("VM: booting guest system. Waiting for shell prompt...");

    if (this.promptProbeInterval) {
      clearInterval(this.promptProbeInterval);
      this.promptProbeInterval = null;
    }
    this.promptProbeInterval = setInterval(() => {
      if (this.shellReady) {
        clearInterval(this.promptProbeInterval);
        this.promptProbeInterval = null;
        return;
      }
      this.sendInput("\n", { isInternal: true });
    }, 3500);

    if (this.bootWarmupTimer) {
      clearTimeout(this.bootWarmupTimer);
    }
    this.bootWarmupTimer = setTimeout(() => {
      if (this.shellReady) {
        return;
      }
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - this.bootStartedAt) / 1000));
      this.emitVmProgress(
        `VM: still booting (${elapsedSeconds}s). This can take a while without a saved state.`,
        null
      );
    }, 10000);
  }

  observeBootOutput(textChunk) {
    this.bootOutputBuffer += textChunk;
    if (this.bootOutputBuffer.length > 4096) {
      this.bootOutputBuffer = this.bootOutputBuffer.slice(-4096);
    }
    if (chunkContainsShellPrompt(textChunk)) {
      this.lastPromptSeenAt = Date.now();
    }
    if (!this.shellReady && /(?:\n|^).*[#$] $/m.test(this.bootOutputBuffer)) {
      this.shellReady = true;
      if (this.promptProbeInterval) {
        clearInterval(this.promptProbeInterval);
        this.promptProbeInterval = null;
      }
      this.resetInteractiveTty();
      this.configureInternalShell();
      this.emitVmProgress("VM: shell prompt detected.", 100, 1800);
      this.flushCommandQueue();
    }
  }

  resetInteractiveTty() {
    this.queueSilentBatch([
      "stty sane >/dev/null 2>&1 || true",
      "stty echo >/dev/null 2>&1 || true",
    ]);
  }

  configureInternalShell() {
    if (this.internalShellConfigured) {
      return;
    }
    this.internalShellConfigured = true;
    this.queueSilentBatch([
      "export HISTCONTROL=ignoreboth",
      "export HISTIGNORE='*__CAPTURE_START_*:stty -echo:stty echo:set +o history*:set -o history*'",
      "__mandelogue_mark_exec(){ out=''; prev=''; for arg in \"$@\"; do if [ \"$prev\" = '-o' ]; then out=\"$arg\"; break; fi; prev=\"$arg\"; done; if [ -z \"$out\" ]; then out='a.out'; fi; [ -f \"$out\" ] && chmod +x \"$out\" >/dev/null 2>&1 || true; }",
      "gcc(){ command gcc \"$@\"; s=$?; [ $s -eq 0 ] && __mandelogue_mark_exec \"$@\"; return $s; }",
      "g++(){ command g++ \"$@\"; s=$?; [ $s -eq 0 ] && __mandelogue_mark_exec \"$@\"; return $s; }",
      "rustc(){ command rustc \"$@\"; s=$?; [ $s -eq 0 ] && __mandelogue_mark_exec \"$@\"; return $s; }",
    ]);
  }

  emitVmProgress(message, percent = null, autoHideMs = 0) {
    this.bus.emit("vm-progress", {
      message,
      percent,
      visible: true,
      autoHideMs,
    });
  }

  cancelActiveCapture(reason = "Internal VM capture cancelled.") {
    if (!this.activeCapture) {
      return;
    }
    const capture = this.activeCapture;
    this.activeCapture = null;
    clearTimeout(capture.timeoutId);
    try {
      capture.reject(new Error(reason));
    } catch (error) {
      // Ignore cancellation errors.
    }
  }

  emitSerialToTerminal(chunk) {
    if (!chunk) {
      return;
    }
    this.bus.emit("terminal-output", { data: chunk });
    this.observeBootOutput(chunk);
  }

  handleSerialOutput(chunk) {
    if (!this.activeCapture) {
      if (this.suppressPromptNoise) {
        if (chunkContainsShellPrompt(chunk)) {
          this.lastPromptSeenAt = Date.now();
        }
        // Hidden/background VM captures share the same interactive serial stream.
        // Ignore all serial echo/noise until the next real user keystroke.
        return;
      }
      if (chunkContainsShellPrompt(chunk)) {
        const stripped = stripLeadingShellPrompts(chunk);
        if (stripped.removed > 0) {
          this.lastPromptSeenAt = Date.now();
          if (!stripped.remaining) {
            return;
          }
          this.emitSerialToTerminal(stripped.remaining);
          return;
        }
      }
      this.emitSerialToTerminal(chunk);
      return;
    }

    const capture = this.activeCapture;
    capture.buffer += chunk;

    while (capture.buffer.length > 0 && this.activeCapture === capture) {
      if (!capture.started) {
        const startMatch = findStandaloneMarker(capture.buffer, capture.startMarker);
        if (!startMatch) {
          const tailLength = Math.max(0, capture.startMarker.length + 4);
          if (capture.buffer.length > tailLength) {
            capture.buffer = capture.buffer.slice(capture.buffer.length - tailLength);
          }
          break;
        }

        const beforeMarker = capture.buffer.slice(0, startMatch.start);
        if (beforeMarker && !capture.suppressTerminal) {
          this.emitSerialToTerminal(beforeMarker);
        }
        capture.buffer = capture.buffer.slice(startMatch.end);
        capture.started = true;
      }

      const endMatch = findStandaloneMarker(capture.buffer, capture.endMarker);
      if (!endMatch) {
        const tailLength = Math.max(0, capture.endMarker.length + 4);
        if (capture.buffer.length > tailLength) {
          capture.captured += capture.buffer.slice(0, capture.buffer.length - tailLength);
          capture.buffer = capture.buffer.slice(capture.buffer.length - tailLength);
        }
        break;
      }

      capture.captured += capture.buffer.slice(0, endMatch.start);
      const afterMarker = capture.buffer.slice(endMatch.end);
      const { resolve } = capture;
      clearTimeout(capture.timeoutId);
      this.activeCapture = null;
      resolve(capture.captured);

      if (capture.suppressTerminal) {
        this.suppressPromptNoise = true;
      }
      if (afterMarker && !capture.suppressTerminal) {
        this.handleSerialOutput(afterMarker);
      }
      break;
    }
  }

  async waitForShellReady(timeoutMs = 45000) {
    if (this.shellReady) {
      return;
    }
    const timeout = Math.max(1000, timeoutMs);
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const interval = setInterval(() => {
        if (this.shellReady) {
          clearInterval(interval);
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeout) {
          clearInterval(interval);
          reject(new Error("VM shell did not become ready in time."));
        }
      }, 80);
    });
  }

  async executeCapturedCommand(command, options = {}) {
    if (!command || typeof command !== "string") {
      throw new Error("A non-empty shell command is required.");
    }
    if (!this.emulator) {
      throw new Error("VM is not initialized.");
    }
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 45000);
    await this.waitForShellReady(timeoutMs);
    if (this.activeCapture) {
      throw new Error("VM capture is busy; try again.");
    }

    const captureId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const startMarker = `__CAPTURE_START_${captureId}__`;
    const endMarker = `__CAPTURE_END_${captureId}__`;
    const wrappedCommand = [
      `printf %s\\\\n ${shellQuote(startMarker)}`,
      command,
      `printf %s\\\\n ${shellQuote(endMarker)}`,
    ].join("; ");

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.activeCapture && this.activeCapture.startMarker === startMarker) {
          this.activeCapture = null;
          reject(new Error("Timed out while waiting for VM command output."));
        }
      }, timeoutMs);

      this.activeCapture = {
        startMarker,
        endMarker,
        started: false,
        buffer: "",
        captured: "",
        suppressTerminal: true,
        timeoutId,
        resolve,
        reject,
      };

      // Leading space keeps bash history clean when HISTCONTROL=ignoreboth.
      this.sendInput("\n", { isInternal: true });
      this.sendInput(` ${wrappedCommand}\n`, { isInternal: true });
    });
  }

  runCapturedCommand(command, options = {}) {
    const task = this.captureQueue.then(() => this.executeCapturedCommand(command, options));
    this.captureQueue = task.catch(() => {});
    return task;
  }

  async runCapturedCommandWithExitCode(command, options = {}) {
    if (!command || typeof command !== "string") {
      throw new Error("A non-empty shell command is required.");
    }

    const markerId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const exitMarker = `__CAPTURE_EXIT_${markerId}__`;
    const wrapped = [
      "set +e",
      command,
      "__mandelogue_exit_code=$?",
      `printf %s\\\\n ${shellQuote(exitMarker)}\"$__mandelogue_exit_code\"`,
    ].join("; ");

    const output = await this.runCapturedCommand(wrapped, options);
    const lines = output.split(/\r?\n/);
    let exitCode = 0;
    let markerFound = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = String(lines[index] || "").trim();
      if (!line.startsWith(exitMarker)) {
        continue;
      }
      const numericPart = line.slice(exitMarker.length).trim();
      const parsed = Number.parseInt(numericPart, 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        exitCode = parsed;
      }
      lines.splice(index, 1);
      markerFound = true;
      break;
    }

    return {
      output: lines.join("\n").replace(/\s+$/, ""),
      exitCode,
      markerFound,
    };
  }

  async exportFolderSnapshot(rootName) {
    const root = normalizeVmPath(`/home/user/${rootName || ""}`);
    const command = [
      `if [ ! -d ${shellQuote(root)} ]; then`,
      "  echo '__SYNC_ERROR__MISSING_ROOT'",
      "else",
      `  cd ${shellQuote(root)}`,
      "  find . -type f -print | while IFS= read -r p; do",
      "    rel=\"${p#./}\"",
      "    path64=$(printf '%s' \"$rel\" | base64 | tr -d '\\n')",
      "    data64=$(base64 \"$p\" | tr -d '\\n')",
      "    printf '__SYNC_FILE__%s:%s\\n' \"$path64\" \"$data64\"",
      "  done",
      "fi",
    ].join("\n");

    const output = await this.runCapturedCommand(command, { timeoutMs: 120000 });
    if (output.includes("__SYNC_ERROR__MISSING_ROOT")) {
      return [];
    }

    const files = [];
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("__SYNC_FILE__")) {
        continue;
      }
      const payload = line.slice("__SYNC_FILE__".length);
      const separatorIndex = payload.indexOf(":");
      if (separatorIndex <= 0) {
        continue;
      }
      const path64 = payload.slice(0, separatorIndex);
      const data64 = payload.slice(separatorIndex + 1);
      try {
        const relativePath = decodeBase64Utf8(path64).replace(/^\/+/, "");
        if (!relativePath) {
          continue;
        }
        files.push({ relativePath, base64: data64 });
      } catch (error) {
        // Ignore malformed sync rows.
      }
    }
    return files;
  }

  sendInput(data, options = {}) {
    if (!this.emulator || typeof data !== "string") {
      return;
    }
    const isInternal = options.isInternal === true;
    if (!isInternal && this.activeCapture && data.length > 0) {
      this.cancelActiveCapture("Internal VM task cancelled due to terminal input.");
    }
    if (!isInternal && data.length > 0) {
      this.suppressPromptNoise = false;
    }
    this.emulator.serial0_send(data);
  }

  nudgeShell() {
    if (!this.emulator) {
      return;
    }
    this.sendInput("\n", { isInternal: true });
  }

  isLikelyAtPrompt(maxAgeMs = 2500) {
    if (!this.shellReady) {
      return false;
    }
    if (!Number.isFinite(this.lastPromptSeenAt) || this.lastPromptSeenAt <= 0) {
      return false;
    }
    return Date.now() - this.lastPromptSeenAt <= Math.max(250, Number(maxAgeMs) || 2500);
  }

  queueCommand(command) {
    if (!command) {
      return;
    }
    this.suppressPromptNoise = false;
    this.commandQueue.push(command);
    if (this.shellReady) {
      this.flushCommandQueue();
    }
  }

  flushCommandQueue() {
    if (!this.shellReady) {
      return;
    }
    while (this.commandQueue.length > 0) {
      const command = this.commandQueue.shift();
      this.sendInput(`${command}\n`, { isInternal: true });
    }
  }

  queueSilentBatch(commands) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return Promise.resolve(false);
    }
    const filtered = commands
      .filter((command) => typeof command === "string" && command.trim())
      .map((command) => command.trim());
    if (filtered.length === 0) {
      return Promise.resolve(false);
    }
    const batchCommand = filtered.join("\n");
    return this.runCapturedCommand(batchCommand, { timeoutMs: 120000 }).then(
      () => true,
      (error) => {
        const message = error instanceof Error ? error.message : "";
        if (message.toLowerCase().includes("cancelled")) {
          return false;
        }
        this.bus.emit("status", {
          level: "error",
          message: message || "Internal VM command failed.",
        });
        return false;
      }
    );
  }

  async mountFolder(rootName, files) {
    if (!Array.isArray(files) || files.length === 0) {
      return;
    }
    const root = normalizeVmPath(`/home/user/${rootName}`);
    this.bus.emit("vm-mount-progress", {
      processed: 0,
      total: files.length,
    });
    let batchCommands = [];
    let batchCommandChars = 0;

    const flushBatch = async () => {
      if (batchCommands.length === 0) {
        return true;
      }
      const chunk = batchCommands;
      batchCommands = [];
      batchCommandChars = 0;
      return this.queueSilentBatch(chunk);
    };

    const queueBatchCommand = async (command) => {
      if (!command) {
        return true;
      }
      const commandChars = command.length + 2;
      if (
        batchCommands.length >= this.mountBatchCommandLimit ||
        batchCommandChars + commandChars > this.mountBatchCharLimit
      ) {
        await flushBatch();
      }
      batchCommands.push(command);
      batchCommandChars += commandChars;
      return true;
    };

    await queueBatchCommand(`mkdir -p ${shellQuote(root)}`);
    await queueBatchCommand("command -v base64 >/dev/null 2>&1");

    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      const targetPath = normalizeVmPath(`${root}/${entry.relativePath}`);
      const targetDir = dirname(targetPath);
      const payload =
        typeof entry.base64 === "string" && entry.base64.length > 0
          ? entry.base64
          : encodeUtf8ToBase64(entry.content || "");
      await queueBatchCommand(`mkdir -p ${shellQuote(targetDir)}`);

      const uniqueId = `${Date.now().toString(36)}_${index.toString(36)}`;
      const writeCommands = buildBase64WriteCommands(
        targetPath,
        payload,
        uniqueId,
        this.mountBase64ChunkSize
      );
      for (const command of writeCommands) {
        await queueBatchCommand(command);
      }

      if ((index + 1) % 80 === 0) {
        await flushBatch();
        this.bus.emit("vm-mount-progress", {
          processed: index + 1,
          total: files.length,
        });
        this.bus.emit("status", {
          level: "info",
          message: `Mounting files into VM: ${index + 1}/${files.length}`,
        });
        await createDeferredYield();
      }
    }

    await flushBatch();
    await this.queueSilentBatch([`cd ${shellQuote(root)}`]);
    this.bus.emit("vm-mount-progress", {
      processed: files.length,
      total: files.length,
    });
  }

  setWorkingDirectory(rootName) {
    if (!rootName) {
      return;
    }
    const root = normalizeVmPath(`/home/user/${rootName}`);
    this.queueSilentBatch([`mkdir -p ${shellQuote(root)}`, `cd ${shellQuote(root)}`]);
  }

  getMountTuning() {
    return {
      mountBatchCommandLimit: this.mountBatchCommandLimit,
      mountBatchCharLimit: this.mountBatchCharLimit,
      mountBase64ChunkSize: this.mountBase64ChunkSize,
    };
  }

  updateMountTuning(options = {}) {
    const nextCommandLimit = Number(options.mountBatchCommandLimit);
    if (Number.isFinite(nextCommandLimit) && nextCommandLimit >= MOUNT_BATCH_COMMAND_LIMIT_MIN) {
      this.mountBatchCommandLimit = Math.max(
        MOUNT_BATCH_COMMAND_LIMIT_MIN,
        Math.min(MOUNT_BATCH_COMMAND_LIMIT_MAX, Math.floor(nextCommandLimit))
      );
    }
    const nextCharLimit = Number(options.mountBatchCharLimit);
    if (Number.isFinite(nextCharLimit) && nextCharLimit >= MOUNT_BATCH_CHAR_LIMIT_MIN) {
      this.mountBatchCharLimit = Math.max(
        MOUNT_BATCH_CHAR_LIMIT_MIN,
        Math.min(MOUNT_BATCH_CHAR_LIMIT_MAX, Math.floor(nextCharLimit))
      );
    }
    const nextChunkSize = Number(options.mountBase64ChunkSize);
    if (Number.isFinite(nextChunkSize) && nextChunkSize >= MOUNT_BASE64_CHUNK_MIN) {
      this.mountBase64ChunkSize = Math.max(
        MOUNT_BASE64_CHUNK_MIN,
        Math.min(MOUNT_BASE64_CHUNK_MAX, Math.floor(nextChunkSize))
      );
    }
    return this.getMountTuning();
  }

  cloneGithubRepository(repoUrl, targetDirectory = "") {
    const trimmedUrl = String(repoUrl || "").trim();
    if (!trimmedUrl) {
      throw new Error("Repository URL is required.");
    }
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?(?:[?#].*)?$/i.test(trimmedUrl)) {
      throw new Error("Use a valid GitHub URL (https://github.com/owner/repo[.git]).");
    }

    const destination = String(targetDirectory || "").trim() || suggestRepoDirectory(trimmedUrl);
    if (destination.split("/").some((segment) => segment === "..")) {
      throw new Error("Repository destination cannot contain '..' segments.");
    }
    const targetPath = normalizeVmPath(`/home/user/${destination}`);
    const parent = dirname(targetPath);
    const repoQuoted = shellQuote(trimmedUrl);
    const targetQuoted = shellQuote(targetPath);
    const parentQuoted = shellQuote(parent);

    this.queueCommand("command -v git >/dev/null 2>&1 || echo '[git] git not found in VM'");
    this.queueCommand(`mkdir -p ${parentQuoted}`);
    this.queueCommand(`if [ -d ${targetQuoted} ]; then echo '[git] target exists: ${targetPath}'; fi`);
    this.queueCommand(`if [ ! -d ${targetQuoted} ]; then git clone ${repoQuoted} ${targetQuoted}; fi`);
    this.queueCommand(`cd ${targetQuoted}`);
    this.queueCommand("pwd");
    this.queueCommand("ls -la");
  }

  async syncSingleFile(rootName, relativePath, content) {
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${relativePath}`);
    const targetDir = dirname(targetPath);
    const payload = encodeUtf8ToBase64(content);
    await this.queueSilentBatch([
      `mkdir -p ${shellQuote(targetDir)}`,
      `printf '%s' ${shellQuote(payload)} | base64 -d > ${shellQuote(targetPath)}`,
    ]);
  }

  async createDirectory(rootName, relativePath) {
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${relativePath}`);
    await this.queueSilentBatch([`mkdir -p ${shellQuote(targetPath)}`]);
  }

  async removePath(rootName, relativePath, isDirectory = false) {
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${relativePath}`);
    if (isDirectory) {
      await this.queueSilentBatch([`rm -rf ${shellQuote(targetPath)}`]);
      return;
    }
    await this.queueSilentBatch([`rm -f ${shellQuote(targetPath)}`]);
  }

  dispose() {
    if (this.bootWarmupTimer) {
      clearTimeout(this.bootWarmupTimer);
      this.bootWarmupTimer = null;
    }
    if (this.promptProbeInterval) {
      clearInterval(this.promptProbeInterval);
      this.promptProbeInterval = null;
    }
    if (this.activeCapture) {
      clearTimeout(this.activeCapture.timeoutId);
      this.activeCapture = null;
    }
    this.suppressPromptNoise = false;

    for (const unsubscribe of this.busUnsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        // Ignore listener disposal errors.
      }
    }
    this.busUnsubscribers = [];

    if (this.emulator) {
      try {
        if (typeof this.emulator.stop === "function") {
          this.emulator.stop();
        }
      } catch (error) {
        // Ignore stop errors.
      }
      try {
        if (typeof this.emulator.destroy === "function") {
          this.emulator.destroy();
        }
      } catch (error) {
        // Ignore destroy errors.
      }
      this.emulator = null;
    }
  }
}
