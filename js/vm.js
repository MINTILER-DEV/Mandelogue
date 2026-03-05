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
  bundledDefaultSnapshotUrl: "./bin/default.bin",
  bundledDefaultSnapshotFallbackUrl: "./bin/devault.bin",
  filesystemBaseUrl: "https://i.copy.sh/arch/",
  filesystemIndexUrl: "https://i.copy.sh/fs.json",
  bootFromFilesystem: true,
  enableSnapshots: true,
  autoLoadSavedSnapshot: false,
  autoLoadDefaultSnapshot: true,
  defaultSnapshotKey: "default",
  snapshotDbName: "mandelogue-vm",
  snapshotStoreName: "snapshots",
  networkRelayUrl: "wss://relay.widgetry.org/",
  netDeviceType: "virtio",
  preferNetworkOverBundledSnapshot: true,
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
const MOUNT_BATCH_TIMEOUT_MS = 300000;
const MOUNT_BATCH_RETRY_COUNT = 2;
const MOUNT_ARCHIVE_MIN_FILES = 8;
const MOUNT_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const INTERNAL_SERIAL_PROMPT = "__MAND_INT_PROMPT__# ";
const INTERNAL_SERIAL_READY_MARKER = "__MAND_INTERNAL_READY__";

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

async function resolveBundledSnapshotUrl(primaryUrl, fallbackUrl = "") {
  const candidates = [primaryUrl, fallbackUrl]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (candidates.length === 0) {
    return "";
  }

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: "HEAD",
        cache: "no-store",
      });
      if (response.ok || response.status === 405) {
        return candidate;
      }
    } catch (error) {
      // Try next candidate.
    }
  }

  return candidates[0];
}

async function awaitIfPromise(value) {
  if (value && typeof value.then === "function") {
    await value;
  }
  return value;
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

function basenamePath(path) {
  const normalized = normalizeVmPath(path);
  if (!normalized || normalized === "/") {
    return "";
  }
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function shellQuote(input) {
  return `'${String(input).replace(/'/g, `'\"'\"'`)}'`;
}

function encodeUtf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  return encodeBytesToBase64(bytes);
}

function encodeBytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < view.length; index += chunkSize) {
    binary += String.fromCharCode(...view.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64Utf8(base64Text) {
  return new TextDecoder().decode(decodeBase64ToBytes(base64Text));
}

function decodeBase64ToBytes(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function normalizeNetDeviceType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "ne2k" || type === "virtio") {
    return type;
  }
  return "virtio";
}

function isSnapshotNetworkCompatible(record, requiredDeviceType) {
  if (!record || !record.data) {
    return false;
  }
  const meta = record.meta && typeof record.meta === "object" ? record.meta : null;
  if (!meta) {
    return false;
  }
  if (meta.networkRelayConfigured !== true) {
    return false;
  }
  const snapshotDeviceType = normalizeNetDeviceType(meta.netDeviceType);
  return snapshotDeviceType === normalizeNetDeviceType(requiredDeviceType);
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

function normalizeTarPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function splitTarNameAndPrefix(path) {
  const normalized = normalizeTarPath(path);
  if (!normalized) {
    return null;
  }
  const encoder = new TextEncoder();
  const wholeBytes = encoder.encode(normalized);
  if (wholeBytes.length <= 100) {
    return {
      nameBytes: wholeBytes,
      prefixBytes: new Uint8Array(0),
    };
  }
  if (wholeBytes.length > 255 || !normalized.includes("/")) {
    return null;
  }
  const segments = normalized.split("/");
  for (let split = segments.length - 1; split > 0; split -= 1) {
    const prefix = segments.slice(0, split).join("/");
    const name = segments.slice(split).join("/");
    const prefixBytes = encoder.encode(prefix);
    const nameBytes = encoder.encode(name);
    if (prefixBytes.length <= 155 && nameBytes.length <= 100) {
      return { nameBytes, prefixBytes };
    }
  }
  return null;
}

function writeTarOctalField(header, offset, length, value) {
  const safeValue = Math.max(0, Math.floor(Number(value) || 0));
  const digits = Math.max(1, length - 1);
  const octal = safeValue.toString(8);
  const trimmed = octal.length > digits ? octal.slice(octal.length - digits) : octal;
  const padded = trimmed.padStart(digits, "0");
  for (let index = 0; index < digits; index += 1) {
    header[offset + index] = padded.charCodeAt(index);
  }
  header[offset + digits] = 0;
}

function writeTarChecksumField(header, checksum) {
  const octal = Math.max(0, Math.floor(checksum)).toString(8).padStart(6, "0").slice(-6);
  for (let index = 0; index < 6; index += 1) {
    header[148 + index] = octal.charCodeAt(index);
  }
  header[154] = 0;
  header[155] = 0x20;
}

function buildTarHeader(path, size, mtimeSeconds = Math.floor(Date.now() / 1000)) {
  const split = splitTarNameAndPrefix(path);
  if (!split) {
    return null;
  }
  const header = new Uint8Array(512);
  header.set(split.nameBytes, 0);
  writeTarOctalField(header, 100, 8, 0o644);
  writeTarOctalField(header, 108, 8, 0);
  writeTarOctalField(header, 116, 8, 0);
  writeTarOctalField(header, 124, 12, size);
  writeTarOctalField(header, 136, 12, mtimeSeconds);
  for (let index = 148; index < 156; index += 1) {
    header[index] = 0x20;
  }
  header[156] = "0".charCodeAt(0);
  if (split.prefixBytes.length > 0) {
    header.set(split.prefixBytes, 345);
  }
  header.set([0x75, 0x73, 0x74, 0x61, 0x72, 0x00], 257); // ustar\0
  header.set([0x30, 0x30], 263); // version 00
  header.set([0x72, 0x6f, 0x6f, 0x74, 0x00], 265); // uname root
  header.set([0x72, 0x6f, 0x6f, 0x74, 0x00], 297); // gname root

  let checksum = 0;
  for (let index = 0; index < 512; index += 1) {
    checksum += header[index];
  }
  writeTarChecksumField(header, checksum);
  return header;
}

function buildTarArchiveFromEntries(files) {
  const entries = [];
  let totalSize = 0;
  for (const file of files) {
    const relativePath = normalizeTarPath(file?.relativePath || "");
    if (!relativePath) {
      continue;
    }
    const dataBytes =
      typeof file?.base64 === "string" && file.base64.length > 0
        ? decodeBase64ToBytes(file.base64)
        : new TextEncoder().encode(file?.content || "");
    const header = buildTarHeader(relativePath, dataBytes.byteLength);
    if (!header) {
      return null;
    }
    const paddedBytes = Math.ceil(dataBytes.byteLength / 512) * 512;
    entries.push({
      header,
      dataBytes,
      paddedBytes,
    });
    totalSize += 512 + paddedBytes;
  }
  totalSize += 1024; // EOF blocks
  const tar = new Uint8Array(totalSize);
  let offset = 0;
  for (const entry of entries) {
    tar.set(entry.header, offset);
    offset += 512;
    tar.set(entry.dataBytes, offset);
    offset += entry.paddedBytes;
  }
  return tar;
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

function stripInternalShellNoise(chunk) {
  let text = String(chunk || "");
  if (!text) {
    return "";
  }

  // Hide internal capture wrappers and helper function chatter if it leaks to the user terminal.
  text = text.replace(
    /(^|[\r\n])[^\r\n]*(?:__CAPTURE_(?:START|END|EXIT)_[A-Za-z0-9_]+__|__mandelogue_|history -d \$\(\(HISTCMD-1\)\)|set [+-]o history|unset HISTFILE|__mandelogue_prev_histfile|__mandelogue_had_histfile)[^\r\n]*/g,
    "$1"
  );
  text = text.replace(/__CAPTURE_(?:START|END|EXIT)_[A-Za-z0-9_]+__/g, "");
  text = text.replace(/(?:\r?\n){3,}/g, "\r\n\r\n");
  return text;
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

function summarizeInternalCommand(command, maxChars = 320) {
  const lines = String(command || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }
  let text = lines.slice(0, 3).join(" ; ");
  if (lines.length > 3) {
    text += ` ; ... (+${lines.length - 3} lines)`;
  }
  text = text
    .replace(/'([A-Za-z0-9+/=]{64,})'/g, (_, payload) => `'<base64:${payload.length}>'`)
    .replace(/__C?I?CAPTURE_(?:START|END|EXIT)_[A-Za-z0-9_]+__/g, "<marker>")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > maxChars) {
    return `${text.slice(0, Math.max(24, maxChars - 3))}...`;
  }
  return text;
}

function hasSecondarySerialApi(emulator) {
  if (!emulator || typeof emulator !== "object") {
    return false;
  }
  return (
    typeof emulator.serial1_send === "function" ||
    typeof emulator.serial_send_bytes === "function"
  );
}

function isRecoverableCaptureFailureMessage(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("cancelled by user")) {
    return false;
  }
  return (
    text.includes("timed out") ||
    text.includes("busy") ||
    text.includes("cancelled") ||
    text.includes("did not become ready")
  );
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
    this.networkConfiguredOnce = false;
    this.captureQueue = Promise.resolve();
    this.suppressPromptNoise = false;
    this.internalNoiseSuppressUntil = 0;
    this.lastPromptSeenAt = 0;
    this.captureInputBlockedNoticeAt = 0;
    this.internalSerialReady = false;
    this.internalSerialLastPromptSeenAt = 0;
    this.internalSerialBuffer = "";
    this.internalSerialActiveCapture = null;
    this.internalSerialCaptureQueue = Promise.resolve();
    this.internalSerialInitPromise = null;
    this.internalSerialReadyNoticeShown = false;
    this.internalSerialUnavailableNoticeShown = false;
    this.internalSerialSupported = false;
    this.archiveMountSupport = null;
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

    const configuredInitialStateUrl =
      typeof this.config.initialStateUrl === "string" ? this.config.initialStateUrl.trim() : "";
    const configuredNetworkRelayUrl =
      typeof this.config.networkRelayUrl === "string" ? this.config.networkRelayUrl.trim() : "";
    const netDeviceType = normalizeNetDeviceType(this.config.netDeviceType);
    const networkRequired = configuredNetworkRelayUrl.length > 0;
    const hasConfiguredInitialState = configuredInitialStateUrl.length > 0;
    const defaultSnapshotKey = this.config.defaultSnapshotKey || "default";
    let localSnapshotRecord = null;
    let bundledDefaultSnapshotUrl = "";

    if (
      this.config.enableSnapshots &&
      this.config.autoLoadSavedSnapshot === true &&
      !hasConfiguredInitialState
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

    if (networkRequired && localSnapshotRecord && !isSnapshotNetworkCompatible(localSnapshotRecord, netDeviceType)) {
      localSnapshotRecord = null;
      this.bus.emit("status", {
        level: "info",
        message:
          "Skipped local snapshot because it does not include current VM network hardware. Save a new snapshot after boot.",
      });
    }

    const hasLocalSnapshot = Boolean(localSnapshotRecord && localSnapshotRecord.data);
    if (!hasConfiguredInitialState && this.config.autoLoadDefaultSnapshot) {
      bundledDefaultSnapshotUrl = await resolveBundledSnapshotUrl(
        this.config.bundledDefaultSnapshotUrl,
        this.config.bundledDefaultSnapshotFallbackUrl
      );
    }

    const hasAnyInitialState =
      hasLocalSnapshot || hasConfiguredInitialState || bundledDefaultSnapshotUrl.length > 0;

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
    if (configuredNetworkRelayUrl) {
      vmOptions.network_relay_url = configuredNetworkRelayUrl;
    }
    vmOptions.net_device = {
      type: netDeviceType,
      relay_url: configuredNetworkRelayUrl || undefined,
    };
    vmOptions.preserve_mac_from_state_image = false;

    const filesystem = {};
    if (this.config.filesystemBaseUrl) {
      filesystem.baseurl = this.config.filesystemBaseUrl;
    }
    if (!hasAnyInitialState && this.config.filesystemIndexUrl) {
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
    } else if (hasConfiguredInitialState) {
      vmOptions.initial_state = { url: configuredInitialStateUrl };
    } else if (bundledDefaultSnapshotUrl) {
      vmOptions.initial_state = { url: bundledDefaultSnapshotUrl };
      this.emitVmProgress(`VM: loading bundled default snapshot (${bundledDefaultSnapshotUrl})...`, 100);
    }

    this.emulator = new runtime.constructor(vmOptions);
    this.internalSerialSupported = hasSecondarySerialApi(this.emulator);
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
    const onInternalSerialOutput = (value) => {
      const chunk = toSerialCharacter(value);
      if (!chunk) {
        return;
      }
      this.handleInternalSerialOutput(chunk);
    };
    // Best-effort second serial line for background tasks.
    this.emulator.add_listener("serial1-output-byte", onInternalSerialOutput);
    this.emulator.add_listener("serial1-output-char", onInternalSerialOutput);
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
    const relayConfigured =
      typeof this.config.networkRelayUrl === "string" && this.config.networkRelayUrl.trim().length > 0;
    const netDeviceType = normalizeNetDeviceType(this.config.netDeviceType);
    await this.snapshotStore.put({
      key,
      data: stateBuffer,
      bytes: stateBuffer.byteLength || 0,
      createdAt: Date.now(),
      meta: {
        netDeviceType,
        networkRelayConfigured: relayConfigured,
      },
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
    const relayConfigured =
      typeof this.config.networkRelayUrl === "string" && this.config.networkRelayUrl.trim().length > 0;
    if (relayConfigured) {
      const netDeviceType = normalizeNetDeviceType(this.config.netDeviceType);
      if (!isSnapshotNetworkCompatible(record, netDeviceType)) {
        throw new Error(
          "Snapshot is incompatible with current VM networking. Boot once, then save a new snapshot."
        );
      }
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
    this.networkConfiguredOnce = false;
    this.suppressPromptNoise = false;
    this.lastPromptSeenAt = 0;
    this.internalSerialReady = false;
    this.internalSerialLastPromptSeenAt = 0;
    this.internalSerialBuffer = "";
    if (this.internalSerialActiveCapture) {
      clearTimeout(this.internalSerialActiveCapture.timeoutId);
      this.internalSerialActiveCapture = null;
    }
    this.internalSerialCaptureQueue = Promise.resolve();
    this.internalSerialInitPromise = null;
    this.internalSerialReadyNoticeShown = false;
    this.internalSerialUnavailableNoticeShown = false;
    this.internalSerialSupported = hasSecondarySerialApi(this.emulator);
    this.archiveMountSupport = null;
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
      this.configureGuestNetworking();
      this.emitVmProgress("VM: shell prompt detected.", 100, 1800);
      this.flushCommandQueue();
      this.ensureInternalSerialReady(12000).catch(() => {
        // Keep user terminal functional even if background channel setup fails.
      });
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
      "export HISTIGNORE='*__CAPTURE_START_*:*__CAPTURE_END_*:*__CAPTURE_EXIT_*:stty -echo:stty echo:set +o history*:set -o history*:__mandelogue_*'",
      "__mandelogue_mark_exec(){ out=''; prev=''; for arg in \"$@\"; do if [ \"$prev\" = '-o' ]; then out=\"$arg\"; break; fi; prev=\"$arg\"; done; if [ -z \"$out\" ]; then out='a.out'; fi; [ -f \"$out\" ] && chmod +x \"$out\" >/dev/null 2>&1 || true; }",
      "gcc(){ command gcc \"$@\"; s=$?; [ $s -eq 0 ] && __mandelogue_mark_exec \"$@\"; return $s; }",
      "g++(){ command g++ \"$@\"; s=$?; [ $s -eq 0 ] && __mandelogue_mark_exec \"$@\"; return $s; }",
      "rustc(){ command rustc \"$@\"; s=$?; [ $s -eq 0 ] && __mandelogue_mark_exec \"$@\"; return $s; }",
    ]);
  }

  configureGuestNetworking() {
    if (this.networkConfiguredOnce) {
      return;
    }
    this.networkConfiguredOnce = true;
    this.queueSilentBatch([
      "IFACE=''",
      "if command -v ip >/dev/null 2>&1; then IFACE=$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | grep -E -v '^(lo|sit|ip6tnl|docker|veth)$' | head -n1); fi",
      "if [ -z \"$IFACE\" ] && command -v ifconfig >/dev/null 2>&1; then IFACE=$(ifconfig -a 2>/dev/null | awk -F: '/^[A-Za-z0-9._-]+:/{print $1}' | grep -v '^lo$' | head -n1); fi",
      "if [ -n \"$IFACE\" ] && command -v ip >/dev/null 2>&1; then ip link set \"$IFACE\" up >/dev/null 2>&1 || true; fi",
      "if [ -n \"$IFACE\" ] && command -v udhcpc >/dev/null 2>&1; then udhcpc -n -q -t 4 -T 3 -i \"$IFACE\" >/dev/null 2>&1 || true; fi",
      "if [ -n \"$IFACE\" ] && command -v dhcpcd >/dev/null 2>&1; then dhcpcd -n \"$IFACE\" >/dev/null 2>&1 || true; fi",
      "if [ -n \"$IFACE\" ] && command -v dhclient >/dev/null 2>&1; then dhclient -1 \"$IFACE\" >/dev/null 2>&1 || true; fi",
      "if [ ! -s /etc/resolv.conf ] || ! grep -Eq '^nameserver[[:space:]]+' /etc/resolv.conf 2>/dev/null; then printf '%s\\n' 'nameserver 1.1.1.1' 'nameserver 8.8.8.8' > /etc/resolv.conf 2>/dev/null || true; fi",
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
    this.internalNoiseSuppressUntil = Date.now() + 2500;
    clearTimeout(capture.timeoutId);
    try {
      capture.reject(new Error(reason));
    } catch (error) {
      // Ignore cancellation errors.
    }
    if (this.emulator) {
      this.sendInput("\u0003", { isInternal: true });
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
      let filteredChunk = stripInternalShellNoise(chunk);
      if (!filteredChunk) {
        return;
      }
      if (this.suppressPromptNoise) {
        if (chunkContainsShellPrompt(filteredChunk)) {
          this.lastPromptSeenAt = Date.now();
        }
        // Hidden/background VM captures share the same interactive serial stream.
        // Ignore all serial echo/noise until the next real user keystroke.
        return;
      }
      if (this.internalNoiseSuppressUntil > Date.now()) {
        filteredChunk = stripLeadingShellPrompts(filteredChunk, 1).remaining;
        if (!filteredChunk) {
          return;
        }
      }
      if (chunkContainsShellPrompt(filteredChunk)) {
        const stripped = stripLeadingShellPrompts(filteredChunk);
        if (stripped.removed > 0) {
          this.lastPromptSeenAt = Date.now();
          if (!stripped.remaining) {
            return;
          }
          this.emitSerialToTerminal(stripped.remaining);
          return;
        }
      }
      this.emitSerialToTerminal(filteredChunk);
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

  handleInternalSerialOutput(chunk) {
    if (!chunk) {
      return;
    }

    this.internalSerialBuffer += chunk;
    if (this.internalSerialBuffer.length > 4096) {
      this.internalSerialBuffer = this.internalSerialBuffer.slice(-4096);
    }
    if (
      chunk.includes(INTERNAL_SERIAL_READY_MARKER) ||
      chunk.includes(INTERNAL_SERIAL_PROMPT) ||
      chunkContainsShellPrompt(chunk)
    ) {
      this.internalSerialReady = true;
      this.internalSerialLastPromptSeenAt = Date.now();
      if (!this.internalSerialReadyNoticeShown) {
        this.internalSerialReadyNoticeShown = true;
        this.bus.emit("status", {
          level: "info",
          message: "Background VM channel ready (ttyS1).",
        });
      }
    }

    if (!this.internalSerialActiveCapture) {
      return;
    }

    const capture = this.internalSerialActiveCapture;
    capture.buffer += chunk;

    while (capture.buffer.length > 0 && this.internalSerialActiveCapture === capture) {
      if (!capture.started) {
        const startMatch = findStandaloneMarker(capture.buffer, capture.startMarker);
        if (!startMatch) {
          const tailLength = Math.max(0, capture.startMarker.length + 4);
          if (capture.buffer.length > tailLength) {
            capture.buffer = capture.buffer.slice(capture.buffer.length - tailLength);
          }
          break;
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
      clearTimeout(capture.timeoutId);
      this.internalSerialActiveCapture = null;
      capture.resolve(capture.captured);
      break;
    }
  }

  sendInternalInput(data) {
    if (!this.emulator || typeof data !== "string") {
      return;
    }
    if (typeof this.emulator.serial1_send === "function") {
      this.emulator.serial1_send(data);
      return;
    }
    if (typeof this.emulator.serial_send_bytes === "function") {
      const payload = new TextEncoder().encode(data);
      this.emulator.serial_send_bytes(1, payload);
      return;
    }
    // Fallback only when a second serial device is unavailable.
    this.sendInput(data, { isInternal: true });
  }

  async waitForInternalSerialReady(timeoutMs = 10000) {
    if (this.internalSerialReady) {
      return true;
    }
    const timeout = Math.max(600, Number(timeoutMs) || 10000);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      this.sendInternalInput("\n");
      await new Promise((resolve) => setTimeout(resolve, 140));
      if (this.internalSerialReady) {
        return true;
      }
    }
    return this.internalSerialReady;
  }

  async bootstrapInternalSerialShell() {
    if (!hasSecondarySerialApi(this.emulator)) {
      this.internalSerialSupported = false;
      if (!this.internalSerialUnavailableNoticeShown) {
        this.internalSerialUnavailableNoticeShown = true;
        this.bus.emit("status", {
          level: "info",
          message:
            "Background VM channel unavailable in this runtime (no serial1 input API).",
        });
      }
      return false;
    }
    this.internalSerialSupported = true;
    if (!this.shellReady) {
      return false;
    }
    if (this.internalSerialReady) {
      return true;
    }

    const launcherScript = [
      "exec </dev/ttyS1 >/dev/ttyS1 2>&1",
      "export PS1='__MAND_INT_PROMPT__# '",
      "export HISTFILE=/dev/null",
      "set +o history >/dev/null 2>&1 || true",
      "echo __MAND_INTERNAL_READY__",
      "exec /bin/sh -i",
    ].join("; ");
    const command = [
      "if [ -c /dev/ttyS1 ]; then",
      `(setsid /bin/sh -c ${shellQuote(launcherScript)} </dev/null >/dev/null 2>&1 &) || true;`,
      "fi",
    ].join(" ");

    try {
      await this.runCapturedCommand(command, { timeoutMs: 18000 });
    } catch (error) {
      this.internalSerialSupported = false;
      if (!this.internalSerialUnavailableNoticeShown) {
        this.internalSerialUnavailableNoticeShown = true;
        this.bus.emit("status", {
          level: "info",
          message:
            "Background VM channel setup failed; using primary terminal channel for this boot.",
        });
      }
      return false;
    }

    const ready = await this.waitForInternalSerialReady(9000);
    if (!ready) {
      this.internalSerialSupported = false;
      if (!this.internalSerialUnavailableNoticeShown) {
        this.internalSerialUnavailableNoticeShown = true;
        this.bus.emit("status", {
          level: "info",
          message:
            "Background VM channel did not respond; using primary terminal channel for this boot.",
        });
      }
      return false;
    }
    try {
      await this.runInternalCapturedCommand(
        "export HISTFILE=/dev/null; set +o history >/dev/null 2>&1 || true",
        { timeoutMs: 6000 }
      );
    } catch (error) {
      // Channel is usable even if shell tuning fails.
    }
    return true;
  }

  async ensureInternalSerialReady(timeoutMs = 12000) {
    if (this.internalSerialReady) {
      return true;
    }
    if (!this.emulator || !this.shellReady || !this.internalSerialSupported) {
      return false;
    }

    if (!this.internalSerialInitPromise) {
      this.internalSerialInitPromise = this.bootstrapInternalSerialShell().finally(() => {
        this.internalSerialInitPromise = null;
      });
    }

    const timeout = Math.max(600, Number(timeoutMs) || 12000);
    await Promise.race([
      this.internalSerialInitPromise.catch(() => false),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);
    return this.internalSerialReady;
  }

  supportsBackgroundChannel() {
    return this.internalSerialSupported === true;
  }

  isBackgroundChannelReady() {
    return this.internalSerialReady === true;
  }

  getSharedFilesystemApi() {
    if (!this.emulator) {
      return null;
    }
    const fs = this.emulator.fs9p;
    if (
      !fs ||
      typeof this.emulator.create_file !== "function" ||
      typeof this.emulator.read_file !== "function" ||
      typeof fs.SearchPath !== "function" ||
      typeof fs.read_dir !== "function" ||
      typeof fs.IsDirectory !== "function" ||
      typeof fs.CreateDirectory !== "function" ||
      typeof fs.DeleteNode !== "function" ||
      typeof fs.Rename !== "function"
    ) {
      return null;
    }
    return { fs };
  }

  supportsSharedFilesystem() {
    return this.getSharedFilesystemApi() !== null;
  }

  sharedFsPathExists(path) {
    const api = this.getSharedFilesystemApi();
    if (!api) {
      return false;
    }
    const info = api.fs.SearchPath(normalizeVmPath(path));
    return Boolean(info && info.id !== -1);
  }

  async ensureSharedDirectory(path) {
    const api = this.getSharedFilesystemApi();
    if (!api) {
      throw new Error("Shared filesystem API unavailable.");
    }
    const fs = api.fs;
    const normalized = normalizeVmPath(path);
    if (normalized === "/") {
      return true;
    }
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = `${current}/${part}`;
      const currentInfo = fs.SearchPath(current);
      if (currentInfo && currentInfo.id !== -1) {
        if (!fs.IsDirectory(currentInfo.id)) {
          throw new Error(`Shared path exists as file: ${current}`);
        }
        continue;
      }
      const parentPath = dirname(current);
      const parentInfo = fs.SearchPath(parentPath);
      if (!parentInfo || parentInfo.id === -1 || !fs.IsDirectory(parentInfo.id)) {
        throw new Error(`Missing shared parent directory: ${parentPath}`);
      }
      await awaitIfPromise(fs.CreateDirectory(part, parentInfo.id));
    }
    return true;
  }

  async writeSharedFile(path, bytesLike) {
    const api = this.getSharedFilesystemApi();
    if (!api) {
      throw new Error("Shared filesystem API unavailable.");
    }
    const fs = api.fs;
    const targetPath = normalizeVmPath(path);
    await this.ensureSharedDirectory(dirname(targetPath));
    const existing = fs.SearchPath(targetPath);
    if (existing && existing.id !== -1) {
      await awaitIfPromise(fs.DeleteNode(targetPath));
    }
    let payload = null;
    if (bytesLike instanceof Uint8Array) {
      payload = bytesLike;
    } else if (ArrayBuffer.isView(bytesLike)) {
      payload = new Uint8Array(
        bytesLike.buffer.slice(bytesLike.byteOffset, bytesLike.byteOffset + bytesLike.byteLength)
      );
    } else if (bytesLike instanceof ArrayBuffer) {
      payload = new Uint8Array(bytesLike.slice(0));
    } else {
      payload = new Uint8Array(0);
    }
    await this.emulator.create_file(targetPath, payload);
  }

  async listSharedFiles(root) {
    const api = this.getSharedFilesystemApi();
    if (!api) {
      throw new Error("Shared filesystem API unavailable.");
    }
    const fs = api.fs;
    const rootPath = normalizeVmPath(root);
    const rootInfo = fs.SearchPath(rootPath);
    if (!rootInfo || rootInfo.id === -1 || !fs.IsDirectory(rootInfo.id)) {
      return [];
    }
    const files = [];
    const walk = async (dirPath, relativePrefix) => {
      const children = fs.read_dir(dirPath) || [];
      children.sort((left, right) => String(left).localeCompare(String(right)));
      for (const name of children) {
        const childName = String(name || "");
        if (!childName) {
          continue;
        }
        const childPath = dirPath === "/" ? `/${childName}` : `${dirPath}/${childName}`;
        const childInfo = fs.SearchPath(childPath);
        if (!childInfo || childInfo.id === -1) {
          continue;
        }
        const childRelative = relativePrefix ? `${relativePrefix}/${childName}` : childName;
        if (fs.IsDirectory(childInfo.id)) {
          await walk(childPath, childRelative);
          continue;
        }
        const bytes = await this.emulator.read_file(childPath);
        const payload =
          bytes instanceof Uint8Array
            ? bytes
            : ArrayBuffer.isView(bytes)
              ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              : bytes instanceof ArrayBuffer
                ? new Uint8Array(bytes)
                : new Uint8Array(0);
        files.push({
          relativePath: childRelative,
          base64: encodeBytesToBase64(payload),
        });
      }
    };
    await walk(rootPath, "");
    return files;
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
      "__mandelogue_prev_histfile=''",
      "__mandelogue_had_histfile=0",
      "if [ -n \"${HISTFILE+x}\" ]; then __mandelogue_had_histfile=1; __mandelogue_prev_histfile=\"$HISTFILE\"; fi",
      "unset HISTFILE",
      "set +o history >/dev/null 2>&1 || true",
      `printf %s\\\\n ${shellQuote(startMarker)}`,
      command,
      `printf %s\\\\n ${shellQuote(endMarker)}`,
      "history -d $((HISTCMD-1)) >/dev/null 2>&1 || true",
      "set -o history >/dev/null 2>&1 || true",
      "if [ \"$__mandelogue_had_histfile\" = '1' ]; then export HISTFILE=\"$__mandelogue_prev_histfile\"; else unset HISTFILE; fi",
      "unset __mandelogue_prev_histfile __mandelogue_had_histfile",
    ].join("; ");

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.activeCapture && this.activeCapture.startMarker === startMarker) {
          this.cancelActiveCapture("Timed out while waiting for VM command output.");
          this.nudgeShell();
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

  async executeInternalCapturedCommand(command, options = {}) {
    if (!command || typeof command !== "string") {
      throw new Error("A non-empty shell command is required.");
    }
    if (!this.emulator) {
      throw new Error("VM is not initialized.");
    }
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 45000);
    await this.waitForShellReady(timeoutMs);
    const internalReady = await this.ensureInternalSerialReady(Math.min(timeoutMs, 12000));
    if (!internalReady) {
      throw new Error("Background VM channel is not ready.");
    }
    if (this.internalSerialActiveCapture) {
      throw new Error("Background VM channel is busy; try again.");
    }

    const captureId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const startMarker = `__ICAPTURE_START_${captureId}__`;
    const endMarker = `__ICAPTURE_END_${captureId}__`;
    const wrappedCommand = [
      "__mandelogue_prev_histfile=''",
      "__mandelogue_had_histfile=0",
      "if [ -n \"${HISTFILE+x}\" ]; then __mandelogue_had_histfile=1; __mandelogue_prev_histfile=\"$HISTFILE\"; fi",
      "unset HISTFILE",
      "set +o history >/dev/null 2>&1 || true",
      `printf %s\\\\n ${shellQuote(startMarker)}`,
      command,
      `printf %s\\\\n ${shellQuote(endMarker)}`,
      "history -d $((HISTCMD-1)) >/dev/null 2>&1 || true",
      "set -o history >/dev/null 2>&1 || true",
      "if [ \"$__mandelogue_had_histfile\" = '1' ]; then export HISTFILE=\"$__mandelogue_prev_histfile\"; else unset HISTFILE; fi",
      "unset __mandelogue_prev_histfile __mandelogue_had_histfile",
    ].join("; ");

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.internalSerialActiveCapture && this.internalSerialActiveCapture.startMarker === startMarker) {
          this.internalSerialActiveCapture = null;
          this.sendInternalInput("\u0003");
          reject(new Error("Timed out while waiting for background VM command output."));
        }
      }, timeoutMs);

      this.internalSerialActiveCapture = {
        startMarker,
        endMarker,
        started: false,
        buffer: "",
        captured: "",
        timeoutId,
        resolve,
        reject,
      };

      this.sendInternalInput("\n");
      this.sendInternalInput(` ${wrappedCommand}\n`);
    });
  }

  runInternalCapturedCommand(command, options = {}) {
    const task = this.internalSerialCaptureQueue.then(() =>
      this.executeInternalCapturedCommand(command, options)
    );
    this.internalSerialCaptureQueue = task.catch(() => {});
    return task;
  }

  async runBackgroundCapturedCommand(command, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 45000);
    const allowUserFallback = options.allowUserFallback !== false;
    const summary = summarizeInternalCommand(command);
    const ready = await this.ensureInternalSerialReady(Math.min(timeoutMs, 12000));
    if (ready) {
      if (summary) {
        this.bus.emit("vm-internal-command", {
          ts: Date.now(),
          channel: "ttyS1",
          summary,
        });
      }
      return this.runInternalCapturedCommand(command, options);
    }
    if (!allowUserFallback) {
      if (summary) {
        this.bus.emit("vm-internal-command", {
          ts: Date.now(),
          channel: "blocked",
          summary,
        });
      }
      throw new Error("Background VM channel is not ready.");
    }
    if (summary) {
      this.bus.emit("vm-internal-command", {
        ts: Date.now(),
        channel: "ttyS0 fallback",
        summary,
      });
    }
    return this.runCapturedCommand(command, options);
  }

  async runBackgroundCapturedCommandWithExitCode(command, options = {}) {
    if (!command || typeof command !== "string") {
      throw new Error("A non-empty shell command is required.");
    }

    const markerId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const exitMarker = `__CAPTURE_EXIT_BG_${markerId}__`;
    const wrapped = [
      "set +e",
      command,
      "__mandelogue_exit_code=$?",
      `printf %s\\\\n ${shellQuote(exitMarker)}\"$__mandelogue_exit_code\"`,
    ].join("; ");

    const output = await this.runBackgroundCapturedCommand(wrapped, options);
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
    if (this.supportsSharedFilesystem()) {
      try {
        return await this.listSharedFiles(root);
      } catch (error) {
        // Fall back to shell capture path when direct shared read fails.
      }
    }
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

    const output = await this.runBackgroundCapturedCommand(command, {
      timeoutMs: 120000,
      allowUserFallback: false,
    });
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
      if (data.includes("\u0003")) {
        this.cancelActiveCapture("Internal VM task cancelled by user.");
      } else {
        const now = Date.now();
        if (now - this.captureInputBlockedNoticeAt > 1200) {
          this.captureInputBlockedNoticeAt = now;
          this.bus.emit("status", {
            level: "info",
            message: "VM task running. Input is paused until it finishes.",
          });
        }
      }
      return;
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

  async probeShellReady(timeoutMs = 2600) {
    if (!this.emulator || !this.shellReady || this.activeCapture) {
      return false;
    }
    try {
      await this.runCapturedCommand(":", {
        timeoutMs: Math.max(1000, Number(timeoutMs) || 2600),
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  isLikelyAtPrompt(maxAgeMs = 2500) {
    if (!this.shellReady) {
      return false;
    }
    // After hidden internal captures we intentionally suppress prompt echo.
    // In that state, treat the shell as prompt-ready unless another capture is active.
    if (this.suppressPromptNoise && !this.activeCapture) {
      return true;
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

  async queueSilentBatch(commands, options = {}) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return false;
    }
    const filtered = commands
      .filter((command) => typeof command === "string" && command.trim())
      .map((command) => command.trim());
    if (filtered.length === 0) {
      return false;
    }
    const timeoutMs = Math.max(8000, Number(options.timeoutMs) || 120000);
    const retries = Math.max(0, Number(options.retries) || 0);
    const silentError = options.silentError === true;
    const channel = String(options.channel || "user").trim().toLowerCase();
    const allowUserFallback = options.allowUserFallback !== false;
    const batchCommand = filtered.join("\n");
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        if (channel === "internal") {
          await this.runBackgroundCapturedCommand(batchCommand, {
            timeoutMs,
            allowUserFallback,
          });
        } else if (channel === "auto") {
          await this.runBackgroundCapturedCommand(batchCommand, {
            timeoutMs,
            allowUserFallback: true,
          });
        } else {
          await this.runCapturedCommand(batchCommand, { timeoutMs });
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const canRetry =
          attempt < retries && isRecoverableCaptureFailureMessage(message);
        if (canRetry) {
          this.internalNoiseSuppressUntil = Date.now() + 1800;
          this.nudgeShell();
          await createDeferredYield();
          await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 160));
          continue;
        }
        if (!silentError && !message.toLowerCase().includes("cancelled")) {
          this.bus.emit("status", {
            level: "error",
            message: message || "Internal VM command failed.",
          });
        }
        return false;
      }
    }
    return false;
  }

  async mountFolderWithSharedFilesystem(root, files) {
    if (!this.supportsSharedFilesystem()) {
      return false;
    }
    const rootPath = normalizeVmPath(root);
    await this.ensureSharedDirectory(rootPath);
    this.bus.emit("vm-mount-progress", {
      processed: 0,
      total: files.length,
    });
    const progressEvery = files.length <= 300 ? 12 : 64;
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      const relativePath = String(entry?.relativePath || "").replace(/^\/+/, "");
      if (!relativePath) {
        continue;
      }
      const targetPath = normalizeVmPath(`${rootPath}/${relativePath}`);
      let bytes = null;
      if (typeof entry?.base64 === "string" && entry.base64.length > 0) {
        bytes = decodeBase64ToBytes(entry.base64);
      } else {
        bytes = new TextEncoder().encode(String(entry?.content || ""));
      }
      await this.writeSharedFile(targetPath, bytes);
      if ((index + 1) % progressEvery === 0 || index + 1 === files.length) {
        this.bus.emit("vm-mount-progress", {
          processed: index + 1,
          total: files.length,
        });
        await createDeferredYield();
      }
    }
    const cdOk = await this.queueSilentBatch(
      [`cd ${shellQuote(rootPath)}`],
      {
        timeoutMs: 90000,
        retries: 1,
        silentError: true,
        channel: "user",
      }
    );
    if (!cdOk) {
      throw new Error("Shared filesystem mount completed, but changing VM directory failed.");
    }
    return true;
  }

  async checkArchiveMountSupport() {
    if (this.archiveMountSupport === true) {
      return true;
    }
    if (this.archiveMountSupport === false) {
      return false;
    }
    const probe = await this.runBackgroundCapturedCommand(
      "if command -v tar >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1; then echo '__MOUNT_ARCHIVE_OK__'; else echo '__MOUNT_ARCHIVE_NO__'; fi",
      {
        timeoutMs: 12000,
        allowUserFallback: true,
      }
    );
    this.archiveMountSupport = probe.includes("__MOUNT_ARCHIVE_OK__");
    return this.archiveMountSupport;
  }

  async mountFolderWithArchive(root, files) {
    if (!Array.isArray(files) || files.length < MOUNT_ARCHIVE_MIN_FILES) {
      return false;
    }

    const totalBytes = files.reduce(
      (sum, entry) => sum + Math.max(0, Number(entry?.bytes) || 0),
      0
    );
    if (totalBytes <= 0 || totalBytes > MOUNT_ARCHIVE_MAX_BYTES) {
      return false;
    }

    const archiveSupported = await this.checkArchiveMountSupport();
    if (!archiveSupported) {
      return false;
    }

    const tarBytes = buildTarArchiveFromEntries(files);
    if (!tarBytes || tarBytes.byteLength === 0) {
      return false;
    }

    const payload = encodeBytesToBase64(tarBytes);
    const mountId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const tarPath = normalizeVmPath(`/tmp/.mandelogue_${mountId}.tar`);
    const writeCommands = buildBase64WriteCommands(
      tarPath,
      payload,
      `tar_${mountId}`,
      this.mountBase64ChunkSize
    );

    const batchRunOptions = {
      timeoutMs: MOUNT_BATCH_TIMEOUT_MS,
      retries: MOUNT_BATCH_RETRY_COUNT,
      silentError: true,
      channel: "internal",
      allowUserFallback: true,
    };
    const totalSteps = writeCommands.length + 2;
    let processedSteps = 0;
    this.bus.emit("vm-mount-progress", {
      processed: processedSteps,
      total: totalSteps,
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
      const ok = await this.queueSilentBatch(chunk, batchRunOptions);
      if (!ok) {
        throw new Error("Archive transfer to VM failed.");
      }
      processedSteps += chunk.length;
      this.bus.emit("vm-mount-progress", {
        processed: Math.min(totalSteps, processedSteps),
        total: totalSteps,
      });
      return true;
    };

    for (const command of writeCommands) {
      const commandChars = command.length + 2;
      if (
        batchCommands.length >= this.mountBatchCommandLimit ||
        batchCommandChars + commandChars > this.mountBatchCharLimit
      ) {
        await flushBatch();
      }
      batchCommands.push(command);
      batchCommandChars += commandChars;
    }
    await flushBatch();

    const extractResult = await this.runBackgroundCapturedCommandWithExitCode(
      [
        "set -e",
        `mkdir -p ${shellQuote(root)}`,
        `tar -xf ${shellQuote(tarPath)} -C ${shellQuote(root)}`,
        `rm -f ${shellQuote(tarPath)}`,
      ].join("; "),
      {
        timeoutMs: MOUNT_BATCH_TIMEOUT_MS,
        allowUserFallback: true,
      }
    );
    processedSteps += 1;
    this.bus.emit("vm-mount-progress", {
      processed: Math.min(totalSteps, processedSteps),
      total: totalSteps,
    });
    if (extractResult.exitCode !== 0) {
      throw new Error(
        extractResult.output
          ? `Archive extract failed: ${extractResult.output}`
          : "Archive extract failed inside VM."
      );
    }

    const cdOk = await this.queueSilentBatch(
      [`cd ${shellQuote(root)}`],
      {
        timeoutMs: 90000,
        retries: 1,
        silentError: true,
        channel: "user",
      }
    );
    if (!cdOk) {
      throw new Error("Archive mounted, but changing VM directory failed.");
    }
    this.bus.emit("vm-mount-progress", {
      processed: totalSteps,
      total: totalSteps,
    });
    return true;
  }

  async mountFolderWithFileWrites(root, files) {
    this.bus.emit("vm-mount-progress", {
      processed: 0,
      total: files.length,
    });
    const batchRunOptions = {
      timeoutMs: MOUNT_BATCH_TIMEOUT_MS,
      retries: MOUNT_BATCH_RETRY_COUNT,
      silentError: true,
      channel: "internal",
      allowUserFallback: true,
    };
    const progressEvery = files.length <= 300 ? 12 : 80;
    let batchCommands = [];
    let batchCommandChars = 0;

    const flushBatch = async () => {
      if (batchCommands.length === 0) {
        return true;
      }
      const chunk = batchCommands;
      batchCommands = [];
      batchCommandChars = 0;
      const ok = await this.queueSilentBatch(chunk, batchRunOptions);
      if (!ok) {
        throw new Error("Mount failed while copying files into VM.");
      }
      return true;
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

      if ((index + 1) % progressEvery === 0) {
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
    const cdOk = await this.queueSilentBatch(
      [`cd ${shellQuote(root)}`],
      {
        timeoutMs: 90000,
        retries: 1,
        silentError: true,
        channel: "user",
      }
    );
    if (!cdOk) {
      throw new Error("Mount completed, but changing VM directory failed.");
    }
    this.bus.emit("vm-mount-progress", {
      processed: files.length,
      total: files.length,
    });
    return true;
  }

  async mountFolder(rootName, files) {
    if (!Array.isArray(files) || files.length === 0) {
      return;
    }
    const root = normalizeVmPath(`/home/user/${rootName}`);

    try {
      const mountedShared = await this.mountFolderWithSharedFilesystem(root, files);
      if (mountedShared) {
        this.bus.emit("status", {
          level: "info",
          message: `Mounted ${files.length} files via shared filesystem.`,
        });
        return;
      }
    } catch (error) {
      this.bus.emit("status", {
        level: "info",
        message: "Shared filesystem mount failed, falling back to transfer pipeline.",
      });
    }

    try {
      const mountedByArchive = await this.mountFolderWithArchive(root, files);
      if (mountedByArchive) {
        this.bus.emit("status", {
          level: "info",
          message: `Mounted ${files.length} files via archive pipeline.`,
        });
        return;
      }
    } catch (error) {
      this.bus.emit("status", {
        level: "info",
        message: "Archive mount failed, falling back to per-file transfer.",
      });
    }

    await this.mountFolderWithFileWrites(root, files);
  }

  setWorkingDirectory(rootName) {
    if (!rootName) {
      return;
    }
    const root = normalizeVmPath(`/home/user/${rootName}`);
    this.queueSilentBatch([`mkdir -p ${shellQuote(root)}`, `cd ${shellQuote(root)}`], {
      timeoutMs: 90000,
      retries: 1,
      silentError: true,
      channel: "user",
    });
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

  async testInternetConnection(options = {}) {
    const pingHost = String(options.pingHost || "1.1.1.1").trim() || "1.1.1.1";
    const dnsHost = String(options.dnsHost || "google.com").trim() || "google.com";
    const httpUrl = String(options.httpUrl || "https://example.com").trim() || "https://example.com";
    const markerPingOk = "__NET_RESULT__PING_OK";
    const markerPingFail = "__NET_RESULT__PING_FAIL";
    const markerPingSkip = "__NET_RESULT__PING_SKIP";
    const markerDnsOk = "__NET_RESULT__DNS_OK";
    const markerDnsFail = "__NET_RESULT__DNS_FAIL";
    const markerDnsSkip = "__NET_RESULT__DNS_SKIP";
    const markerHttpOk = "__NET_RESULT__HTTP_OK";
    const markerHttpFail = "__NET_RESULT__HTTP_FAIL";
    const markerHttpSkip = "__NET_RESULT__HTTP_SKIP";

    this.configureGuestNetworking();

    const command = [
      "echo '[net] interface snapshot:'",
      "if command -v ip >/dev/null 2>&1; then ip -o link show 2>/dev/null; ip -o -4 addr show 2>/dev/null; ip route 2>/dev/null; elif command -v ifconfig >/dev/null 2>&1; then ifconfig 2>/dev/null; route -n 2>/dev/null || true; else echo '[net] no ip/ifconfig tool'; fi",
      `if command -v ping >/dev/null 2>&1; then ping -c 1 -W 3 ${shellQuote(pingHost)} >/dev/null 2>&1 && echo ${shellQuote(markerPingOk)} || echo ${shellQuote(markerPingFail)}; else echo ${shellQuote(markerPingSkip)}; fi`,
      `if command -v getent >/dev/null 2>&1; then getent hosts ${shellQuote(dnsHost)} >/dev/null 2>&1 && echo ${shellQuote(markerDnsOk)} || echo ${shellQuote(markerDnsFail)}; elif command -v nslookup >/dev/null 2>&1; then nslookup ${shellQuote(dnsHost)} >/dev/null 2>&1 && echo ${shellQuote(markerDnsOk)} || echo ${shellQuote(markerDnsFail)}; elif command -v ping >/dev/null 2>&1; then ping -c 1 -W 3 ${shellQuote(dnsHost)} >/dev/null 2>&1 && echo ${shellQuote(markerDnsOk)} || echo ${shellQuote(markerDnsFail)}; else echo ${shellQuote(markerDnsSkip)}; fi`,
      `if command -v wget >/dev/null 2>&1; then wget -q -O /dev/null --timeout=8 ${shellQuote(httpUrl)} && echo ${shellQuote(markerHttpOk)} || echo ${shellQuote(markerHttpFail)}; elif command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 8 ${shellQuote(httpUrl)} >/dev/null && echo ${shellQuote(markerHttpOk)} || echo ${shellQuote(markerHttpFail)}; else echo ${shellQuote(markerHttpSkip)}; fi`,
    ].join("; ");

    const result = await this.runCapturedCommandWithExitCode(command, { timeoutMs: 90000 });
    const lines = String(result.output || "").split(/\r?\n/);
    let ping = "unknown";
    let dns = "unknown";
    let http = "unknown";
    const filtered = [];

    for (const rawLine of lines) {
      const line = String(rawLine || "").trim();
      if (line === markerPingOk) {
        ping = "ok";
        continue;
      }
      if (line === markerPingFail) {
        ping = "fail";
        continue;
      }
      if (line === markerPingSkip) {
        ping = "skip";
        continue;
      }
      if (line === markerDnsOk) {
        dns = "ok";
        continue;
      }
      if (line === markerDnsFail) {
        dns = "fail";
        continue;
      }
      if (line === markerDnsSkip) {
        dns = "skip";
        continue;
      }
      if (line === markerHttpOk) {
        http = "ok";
        continue;
      }
      if (line === markerHttpFail) {
        http = "fail";
        continue;
      }
      if (line === markerHttpSkip) {
        http = "skip";
        continue;
      }
      filtered.push(rawLine);
    }

    const ok = ping === "ok" || http === "ok";
    return {
      ok,
      ping,
      dns,
      http,
      output: filtered.join("\n").replace(/\s+$/, ""),
      exitCode: result.exitCode,
    };
  }

  async syncSingleFile(rootName, relativePath, content) {
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${relativePath}`);
    if (this.supportsSharedFilesystem()) {
      const bytes = new TextEncoder().encode(String(content || ""));
      try {
        await this.writeSharedFile(targetPath, bytes);
        return;
      } catch (error) {
        // Fall through to shell write path when direct shared write fails.
      }
    }
    const targetDir = dirname(targetPath);
    const payload = encodeUtf8ToBase64(content);
    await this.queueSilentBatch([
      `mkdir -p ${shellQuote(targetDir)}`,
      `printf '%s' ${shellQuote(payload)} | base64 -d > ${shellQuote(targetPath)}`,
    ], {
      timeoutMs: 120000,
      retries: 1,
      channel: "internal",
      allowUserFallback: true,
    });
  }

  async createDirectory(rootName, relativePath) {
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${relativePath}`);
    if (this.supportsSharedFilesystem()) {
      try {
        await this.ensureSharedDirectory(targetPath);
        return;
      } catch (error) {
        // Fall through to shell mkdir path when direct shared mkdir fails.
      }
    }
    await this.queueSilentBatch([`mkdir -p ${shellQuote(targetPath)}`], {
      timeoutMs: 90000,
      retries: 1,
      channel: "internal",
      allowUserFallback: true,
    });
  }

  async renamePath(rootName, oldRelativePath, newRelativePath) {
    const sourcePath = normalizeVmPath(`/home/user/${rootName}/${oldRelativePath}`);
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${newRelativePath}`);
    if (this.supportsSharedFilesystem()) {
      const api = this.getSharedFilesystemApi();
      const fs = api.fs;
      const sourceInfo = fs.SearchPath(sourcePath);
      if (!sourceInfo || sourceInfo.id === -1) {
        return;
      }
      const sourceName = basenamePath(sourcePath);
      const targetParent = dirname(targetPath);
      await this.ensureSharedDirectory(targetParent);
      const targetParentInfo = fs.SearchPath(targetParent);
      if (!targetParentInfo || targetParentInfo.id === -1 || !fs.IsDirectory(targetParentInfo.id)) {
        throw new Error("Failed to resolve target parent directory in shared filesystem.");
      }
      const targetName = basenamePath(targetPath);
      await fs.Rename(sourceInfo.parentid, sourceName, targetParentInfo.id, targetName);
      return;
    }
    const targetParent = dirname(targetPath);
    const success = await this.queueSilentBatch([
      `[ -e ${shellQuote(sourcePath)} ] || exit 0`,
      `mkdir -p ${shellQuote(targetParent)}`,
      `mv ${shellQuote(sourcePath)} ${shellQuote(targetPath)}`,
    ], {
      channel: "internal",
      allowUserFallback: true,
    });
    if (!success) {
      throw new Error("Failed to rename path inside VM.");
    }
  }

  async removePath(rootName, relativePath, isDirectory = false) {
    const targetPath = normalizeVmPath(`/home/user/${rootName}/${relativePath}`);
    if (this.supportsSharedFilesystem()) {
      try {
        const api = this.getSharedFilesystemApi();
        await awaitIfPromise(api.fs.DeleteNode(targetPath));
        const info = api.fs.SearchPath(targetPath);
        if (!info || info.id === -1) {
          return;
        }
      } catch (error) {
        // Fall through to shell delete path when direct shared remove fails.
      }
    }
    if (isDirectory) {
      await this.queueSilentBatch([`rm -rf ${shellQuote(targetPath)}`], {
        channel: "internal",
        allowUserFallback: true,
      });
      return;
    }
    await this.queueSilentBatch([`rm -f ${shellQuote(targetPath)}`], {
      channel: "internal",
      allowUserFallback: true,
    });
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
    if (this.internalSerialActiveCapture) {
      clearTimeout(this.internalSerialActiveCapture.timeoutId);
      this.internalSerialActiveCapture = null;
    }
    this.suppressPromptNoise = false;
    this.internalSerialReady = false;
    this.internalSerialInitPromise = null;

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
