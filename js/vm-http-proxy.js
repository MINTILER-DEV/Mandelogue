const PROXY_PREFIX = "/__vm_proxy__";
const RESPONSE_MARKER = "__VM_PROXY_RESPONSE_B64__";
const ERROR_MARKER = "__VM_PROXY_TRANSPORT_ERR__";

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'\"'\"'`)}'`;
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

function decodeLatin1(bytes) {
  try {
    return new TextDecoder("latin1").decode(bytes);
  } catch (error) {
    let text = "";
    for (let index = 0; index < bytes.length; index += 1) {
      text += String.fromCharCode(bytes[index]);
    }
    return text;
  }
}

function sanitizeHeaderName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "")
    .trim();
}

function sanitizeHeaderValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function findHeaderSeparator(bytes) {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return { index, width: 4 };
    }
  }
  for (let index = 0; index <= bytes.length - 2; index += 1) {
    if (bytes[index] === 10 && bytes[index + 1] === 10) {
      return { index, width: 2 };
    }
  }
  return null;
}

function parseRawHttpResponse(rawBytes) {
  const separator = findHeaderSeparator(rawBytes);
  if (!separator) {
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      bodyBase64: bytesToBase64(rawBytes),
    };
  }

  const headerBytes = rawBytes.slice(0, separator.index);
  const bodyBytes = rawBytes.slice(separator.index + separator.width);
  const headerText = decodeLatin1(headerBytes);
  const lines = headerText.replace(/\r/g, "").split("\n");
  const statusLine = lines.shift() || "HTTP/1.1 200 OK";
  const statusMatch = statusLine.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+(.*))?$/i);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 200;
  const statusText = statusMatch ? String(statusMatch[2] || "").trim() : "OK";

  const headers = {};
  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    if (["transfer-encoding", "content-encoding", "connection"].includes(key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(headers, key)) {
      headers[key] = `${headers[key]}, ${value}`;
    } else {
      headers[key] = value;
    }
  }

  return {
    status: Number.isInteger(status) ? status : 200,
    statusText: statusText || "OK",
    headers,
    bodyBase64: bytesToBase64(bodyBytes),
  };
}

function normalizePreviewPath(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "/";
  }
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash;
}

export class VmHttpProxyBridge {
  constructor(bus, vm, options = {}) {
    this.bus = bus;
    this.vm = vm;
    this.defaultPort = Number.isInteger(options.defaultPort) ? options.defaultPort : 8080;
    this.requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) ? options.requestTimeoutMs : 45000;
    this.proxyPort = this.defaultPort;
    this.enabled = false;
    this.initialized = false;
    this.swListenerAttached = false;
    this.handleServiceWorkerMessage = this.handleServiceWorkerMessage.bind(this);
  }

  getProxyPrefix() {
    return PROXY_PREFIX;
  }

  getState() {
    return {
      enabled: this.enabled,
      port: this.proxyPort,
      initialized: this.initialized,
    };
  }

  setPort(port) {
    const parsed = Number.parseInt(String(port || "").trim(), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error("Proxy port must be an integer between 1 and 65535.");
    }
    this.proxyPort = parsed;
    return this.proxyPort;
  }

  buildProxyUrl(path = "/") {
    const previewPath = normalizePreviewPath(path);
    return `${PROXY_PREFIX}${previewPath}`;
  }

  async init() {
    if (this.initialized) {
      return true;
    }

    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return false;
    }

    try {
      await navigator.serviceWorker.register("/vm-proxy-sw.js", {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      if (!this.swListenerAttached) {
        navigator.serviceWorker.addEventListener("message", this.handleServiceWorkerMessage);
        this.swListenerAttached = true;
      }
      this.initialized = true;
      return true;
    } catch (error) {
      return false;
    }
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  isEnabled() {
    return this.enabled;
  }

  async handleServiceWorkerMessage(event) {
    const data = event?.data;
    if (!data || data.type !== "vm-proxy-request") {
      return;
    }
    const replyPort = event.ports && event.ports[0] ? event.ports[0] : null;
    if (!replyPort) {
      return;
    }

    if (!this.enabled) {
      replyPort.postMessage({
        ok: false,
        status: 503,
        error: "VM proxy is disabled.",
      });
      return;
    }

    try {
      const forwarded = await this.forwardSerializedRequest(data.payload || {});
      replyPort.postMessage(forwarded);
    } catch (error) {
      replyPort.postMessage({
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : "VM proxy request failed.",
      });
    }
  }

  buildVmProxyCommand(payload) {
    const method = String(payload.method || "GET").toUpperCase();
    const path = normalizePreviewPath(payload.path || "/");
    const query = String(payload.query || "");
    const urlPath = `${path}${query}`;
    const targetUrl = `http://127.0.0.1:${this.proxyPort}${urlPath}`;
    const bodyBase64 = String(payload.bodyBase64 || "");
    const hasBody = bodyBase64.length > 0 && method !== "GET" && method !== "HEAD";

    const hopByHopIgnored = new Set([
      "host",
      "content-length",
      "connection",
      "accept-encoding",
    ]);
    const headerPairs = [];
    const inputHeaders = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
    for (const [rawName, rawValue] of Object.entries(inputHeaders)) {
      const name = sanitizeHeaderName(rawName);
      const value = sanitizeHeaderValue(rawValue);
      if (!name || !value || hopByHopIgnored.has(name)) {
        continue;
      }
      headerPairs.push(`${rawName}: ${value}`);
    }
    const headerArgs = headerPairs.map((header) => `-H ${shellQuote(header)}`).join(" ");

    const requestId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const bodyPath = `/tmp/.mand_proxy_${requestId}.body`;
    const responsePath = `/tmp/.mand_proxy_${requestId}.resp`;
    const errorPath = `/tmp/.mand_proxy_${requestId}.err`;
    const dataArg = hasBody ? `--data-binary @${shellQuote(bodyPath)}` : "";

    const commands = [
      "set +e",
      `__mp_body=${shellQuote(bodyPath)}`,
      `__mp_resp=${shellQuote(responsePath)}`,
      `__mp_err=${shellQuote(errorPath)}`,
      "rm -f \"$__mp_body\" \"$__mp_resp\" \"$__mp_err\"",
      hasBody ? `printf '%s' ${shellQuote(bodyBase64)} | base64 -d > "$__mp_body"` : "true",
      "if ! command -v curl >/dev/null 2>&1; then",
      `  printf '%s\\n' ${shellQuote(`${ERROR_MARKER}curl_not_found`)}`,
      "  exit 127",
      "fi",
      `curl -sS -i --http1.1 --max-time 30 -X ${shellQuote(method)} ${headerArgs} ${dataArg} ${shellQuote(targetUrl)} > "$__mp_resp" 2> "$__mp_err"`,
      "__mp_code=$?",
      "if [ \"$__mp_code\" -ne 0 ]; then",
      "  __mp_msg=$(tr '\\n' ' ' < \"$__mp_err\" 2>/dev/null)",
      `  printf '${ERROR_MARKER}%s\\n' \"$__mp_msg\"`,
      "  rm -f \"$__mp_body\" \"$__mp_resp\" \"$__mp_err\"",
      "  exit \"$__mp_code\"",
      "fi",
      `printf '${RESPONSE_MARKER}%s\\n' \"$(base64 \"$__mp_resp\" | tr -d '\\n')\"`,
      "rm -f \"$__mp_body\" \"$__mp_resp\" \"$__mp_err\"",
    ];

    return commands.join("; ");
  }

  async forwardSerializedRequest(payload) {
    const command = this.buildVmProxyCommand(payload);
    const result = await this.vm.runBackgroundCapturedCommandWithExitCode(command, {
      timeoutMs: this.requestTimeoutMs,
      allowUserFallback: true,
    });

    const output = String(result.output || "");
    const lines = output.split(/\r?\n/);
    let encodedResponse = "";
    let transportError = "";
    for (const rawLine of lines) {
      const line = String(rawLine || "");
      if (line.startsWith(RESPONSE_MARKER)) {
        encodedResponse = line.slice(RESPONSE_MARKER.length).trim();
        continue;
      }
      if (line.startsWith(ERROR_MARKER)) {
        transportError = line.slice(ERROR_MARKER.length).trim() || "VM transport error.";
      }
    }

    if (transportError) {
      return {
        ok: false,
        status: 502,
        error: transportError,
      };
    }

    if (!encodedResponse) {
      return {
        ok: false,
        status: 502,
        error: "VM proxy response marker was not found.",
      };
    }

    try {
      const rawBytes = base64ToBytes(encodedResponse);
      const parsed = parseRawHttpResponse(rawBytes);
      return {
        ok: true,
        status: parsed.status,
        statusText: parsed.statusText,
        headers: parsed.headers,
        bodyBase64: parsed.bodyBase64,
      };
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: "Failed to decode VM HTTP response.",
      };
    }
  }

  dispose() {
    if (this.swListenerAttached && typeof navigator !== "undefined" && navigator.serviceWorker) {
      try {
        navigator.serviceWorker.removeEventListener("message", this.handleServiceWorkerMessage);
      } catch (error) {
        // Ignore listener cleanup errors.
      }
      this.swListenerAttached = false;
    }
  }
}
