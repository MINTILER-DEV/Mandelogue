const PROXY_PREFIX = "/__vm_proxy__";
const REQUEST_TIMEOUT_MS = 45000;

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

async function serializeRequestBody(request) {
  const method = String(request.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return "";
  }
  const buffer = await request.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

function chooseBridgeClients(clients) {
  if (!Array.isArray(clients) || clients.length === 0) {
    return [];
  }
  const nonProxy = [];
  const proxy = [];
  for (const client of clients) {
    try {
      const url = new URL(client.url);
      if (!url.pathname.startsWith(PROXY_PREFIX)) {
        nonProxy.push(client);
      } else {
        proxy.push(client);
      }
    } catch (error) {
      nonProxy.push(client);
    }
  }
  return [...nonProxy, ...proxy];
}

async function resolveBridgeClients(eventClientId) {
  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  if (!allClients || allClients.length === 0) {
    return [];
  }

  const ordered = chooseBridgeClients(allClients);
  if (eventClientId) {
    const exactIndex = ordered.findIndex((client) => client.id === eventClientId);
    if (exactIndex >= 0) {
      const [exact] = ordered.splice(exactIndex, 1);
      try {
        const exactUrl = new URL(exact.url);
        if (!exactUrl.pathname.startsWith(PROXY_PREFIX)) {
          ordered.unshift(exact);
          return ordered;
        }
      } catch (error) {
        ordered.unshift(exact);
        return ordered;
      }
    }
  }

  return ordered;
}

function requestProxyFromClient(client, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        channel.port1.close();
      } catch (error) {
        // Ignore close errors.
      }
      reject(new Error("VM proxy bridge timed out."));
    }, timeoutMs);

    channel.port1.onmessage = (event) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      try {
        channel.port1.close();
      } catch (error) {
        // Ignore close errors.
      }
      resolve(event.data || null);
    };

    try {
      client.postMessage(
        {
          type: "vm-proxy-request",
          payload,
        },
        [channel.port2]
      );
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

async function requestProxyFromAnyClient(clients, payload) {
  const list = Array.isArray(clients) ? clients : [];
  if (list.length === 0) {
    throw new Error("VM proxy unavailable: no bridge client.");
  }

  let lastError = null;
  const perClientTimeoutMs = Math.max(3000, Math.min(12000, Math.floor(REQUEST_TIMEOUT_MS / 2)));
  for (const client of list) {
    try {
      const response = await requestProxyFromClient(client, payload, perClientTimeoutMs);
      if (response) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("VM proxy bridge did not respond.");
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }
  if (!requestUrl.pathname.startsWith(PROXY_PREFIX)) {
    return;
  }
  event.respondWith(
    (async () => {
      const bridgeClients = await resolveBridgeClients(event.clientId);
      if (!bridgeClients || bridgeClients.length === 0) {
        return new Response("VM proxy unavailable: no bridge client.", {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }

      const headers = {};
      event.request.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const path = requestUrl.pathname.slice(PROXY_PREFIX.length) || "/";
      const query = requestUrl.search || "";
      const bodyBase64 = await serializeRequestBody(event.request.clone());

      let proxied = null;
      try {
        proxied = await requestProxyFromAnyClient(bridgeClients, {
          method: event.request.method,
          path,
          query,
          headers,
          bodyBase64,
        });
      } catch (error) {
        return new Response("VM proxy bridge did not respond.", {
          status: 504,
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }

      if (!proxied || proxied.ok !== true) {
        return new Response(
          (proxied && proxied.error) || "VM proxy request failed.",
          {
            status:
              proxied && Number.isInteger(proxied.status) ? proxied.status : 502,
            headers: {
              "content-type": "text/plain; charset=utf-8",
            },
          }
        );
      }

      const responseHeaders = new Headers(proxied.headers || {});
      responseHeaders.set("x-mandelogue-proxy", "v86");
      responseHeaders.set("cache-control", "no-store");
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/octet-stream");
      }
      const responseBody = base64ToBytes(proxied.bodyBase64 || "");
      return new Response(responseBody, {
        status: Number.isInteger(proxied.status) ? proxied.status : 200,
        statusText: String(proxied.statusText || ""),
        headers: responseHeaders,
      });
    })()
  );
});
