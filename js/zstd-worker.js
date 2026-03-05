let apiPromise = null;
let moduleUrl = "";
let wasmUrl = "";

async function getApi() {
  if (!moduleUrl) {
    throw new Error("zstd worker is not initialized.");
  }
  if (!apiPromise) {
    apiPromise = import(moduleUrl).then(async (mod) => {
      if (typeof mod.init !== "function") {
        throw new Error("zstd module init() is unavailable.");
      }
      await mod.init(wasmUrl || undefined);
      if (typeof mod.compress !== "function" || typeof mod.decompress !== "function") {
        throw new Error("zstd module missing compress/decompress.");
      }
      return mod;
    });
  }
  return apiPromise;
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === "init") {
    moduleUrl = String(data.moduleUrl || "").trim();
    wasmUrl = String(data.wasmUrl || "").trim();
    apiPromise = null;
    return;
  }

  const id = data.id;
  const operation = data.operation;
  const inputBuffer = data.buffer;
  const level = Number(data.level) || 1;
  if (!id || !(inputBuffer instanceof ArrayBuffer)) {
    return;
  }

  try {
    const api = await getApi();
    const input = new Uint8Array(inputBuffer);
    let output = null;

    if (operation === "compress") {
      output = api.compress(input, level);
    } else if (operation === "decompress") {
      output = api.decompress(input);
    } else {
      throw new Error("Unsupported zstd operation.");
    }

    if (!(output instanceof Uint8Array) || output.byteLength <= 0) {
      throw new Error("zstd worker returned invalid output.");
    }

    self.postMessage(
      {
        id,
        ok: true,
        buffer: output.buffer,
        byteOffset: output.byteOffset,
        byteLength: output.byteLength,
      },
      [output.buffer]
    );
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
