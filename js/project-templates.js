function entry(relativePath, content) {
  return { relativePath, content };
}

export const PROJECT_TEMPLATES = [
  {
    id: "c-console",
    label: "C Console App",
    defaultProjectName: "C Console App",
    preferredOpenFile: "main.c",
    files: [
      entry(
        "README.md",
        `# C Console App

This template is a minimal C project for Mandelogue VM builds.

## Files
- \`main.c\`: Hello World source file.
- \`Makefile\`: Build and run helpers.

## VM Commands
\`\`\`sh
make
./main
\`\`\`

Or directly:
\`\`\`sh
gcc -O2 -std=c11 main.c -o main
./main
\`\`\`
`
      ),
      entry(
        "main.c",
        `#include <stdio.h>

int main(void) {
  // Starter output for quick compile/run checks.
  printf("Hello, World from C!\\n");
  return 0;
}
`
      ),
      entry(
        "Makefile",
        `CC := gcc
CFLAGS := -O2 -std=c11 -Wall -Wextra
TARGET := main
SRC := main.c

.PHONY: all clean run

all: $(TARGET)

$(TARGET): $(SRC)
\t$(CC) $(CFLAGS) $(SRC) -o $(TARGET)

run: $(TARGET)
\t./$(TARGET)

clean:
\trm -f $(TARGET)
`
      ),
    ],
  },
  {
    id: "cpp-app",
    label: "C++ App",
    defaultProjectName: "C++ App",
    preferredOpenFile: "main.cpp",
    files: [
      entry(
        "README.md",
        `# C++ App

This template uses CMake for a clean C++ build flow in the VM.

## Files
- \`main.cpp\`: Hello World C++ source file.
- \`CMakeLists.txt\`: Build configuration.

## VM Commands
\`\`\`sh
mkdir -p build
cd build
cmake ..
cmake --build .
./cpp_app
\`\`\`
`
      ),
      entry(
        "main.cpp",
        `#include <iostream>

int main() {
  // Starter output for quick compile/run checks.
  std::cout << "Hello, World from C++!" << std::endl;
  return 0;
}
`
      ),
      entry(
        "CMakeLists.txt",
        `cmake_minimum_required(VERSION 3.10)
project(cpp_app LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(cpp_app main.cpp)
`
      ),
    ],
  },
  {
    id: "python-script",
    label: "Python Script",
    defaultProjectName: "Python Script",
    preferredOpenFile: "main.py",
    files: [
      entry(
        "README.md",
        `# Python Script

Minimal Python starter for Mandelogue VM runs.

## Files
- \`main.py\`: Hello World script.
- \`requirements.txt\`: Optional dependencies.

## VM Commands
\`\`\`sh
python3 main.py
\`\`\`

If \`python3\` is unavailable:
\`\`\`sh
python main.py
\`\`\`
`
      ),
      entry(
        "main.py",
        `def main() -> None:
    # Starter output for quick run checks.
    print("Hello, World from Python!")


if __name__ == "__main__":
    main()
`
      ),
      entry(
        "requirements.txt",
        `# Optional dependencies go here, one per line.
# Example:
# requests==2.32.0
`
      ),
    ],
  },
  {
    id: "web-project",
    label: "Web Project",
    defaultProjectName: "Web Project",
    preferredOpenFile: "index.html",
    files: [
      entry(
        "README.md",
        `# Web Project

Starter frontend + optional Node/Express backend for VM preview.

## Files
- \`index.html\`, \`style.css\`, \`script.js\`: Frontend.
- \`live-reload.js\`: Lightweight polling reload helper.
- \`server.js\`: Minimal Express static server.
- \`package.json\`: Node scripts and Express dependency.

## VM Commands
\`\`\`sh
npm install
npm run start
\`\`\`

Default server URL inside VM:
\`\`\`
http://127.0.0.1:8080
\`\`\`

## Mandelogue Preview Route
When VM HTTP proxy is enabled in Tools, preview through:
\`\`\`
/__vm_proxy__/
\`\`\`

Or for specific pages:
\`\`\`
/__vm_proxy__/index.html
\`\`\`
`
      ),
      entry(
        "index.html",
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mandelogue Web Project</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main class="app">
    <h1>Mandelogue Web Project</h1>
    <p id="status">Loading...</p>
    <button id="ping-btn" type="button">Ping Backend</button>
    <pre id="result"></pre>
  </main>

  <script src="./live-reload.js"></script>
  <script src="./script.js"></script>
</body>
</html>
`
      ),
      entry(
        "style.css",
        `:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #161b24;
  --line: #2a3342;
  --text: #d7deea;
  --muted: #93a2be;
  --accent: #4f8cff;
}

* {
  box-sizing: border-box;
  font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(circle at 20% 0%, #1b2332, var(--bg) 45%);
  color: var(--text);
  display: grid;
  place-items: center;
  padding: 20px;
}

.app {
  width: min(680px, 100%);
  padding: 18px;
  border: 1px solid var(--line);
  background: var(--panel);
}

h1 {
  margin: 0 0 10px;
  font-size: 24px;
}

p {
  margin: 0 0 12px;
  color: var(--muted);
}

button {
  border: 1px solid var(--line);
  background: #1d2532;
  color: var(--text);
  padding: 8px 12px;
  cursor: pointer;
}

button:hover {
  background: #243043;
}

pre {
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--line);
  background: #10151f;
  min-height: 80px;
  overflow: auto;
}
`
      ),
      entry(
        "script.js",
        `const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const pingBtn = document.getElementById("ping-btn");

statusEl.textContent = "Frontend ready.";

async function pingBackend() {
  resultEl.textContent = "Calling /api/ping ...";
  try {
    const response = await fetch("./api/ping");
    const body = await response.text();
    resultEl.textContent = body;
  } catch (error) {
    resultEl.textContent = "Backend request failed. Is server.js running in the VM?";
  }
}

pingBtn.addEventListener("click", () => {
  pingBackend();
});
`
      ),
      entry(
        "live-reload.js",
        `(() => {
  // Simple polling-based reload helper for preview sessions.
  // Works best through /__vm_proxy__/ where server headers are visible.
  let lastTag = "";

  const check = async () => {
    try {
      const response = await fetch(window.location.href, {
        method: "HEAD",
        cache: "no-store",
      });
      const tag =
        response.headers.get("etag") ||
        response.headers.get("last-modified") ||
        String(response.status);
      if (!lastTag) {
        lastTag = tag;
        return;
      }
      if (tag && tag !== lastTag) {
        window.location.reload();
      }
    } catch (error) {
      // Ignore transient polling errors.
    }
  };

  setInterval(check, 2000);
})();
`
      ),
      entry(
        "server.js",
        `// Minimal Express server for Mandelogue VM preview.
const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 8080);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.resolve(__dirname)));

app.get("/api/ping", (_req, res) => {
  res.type("text/plain").send("pong from VM Express server");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("[web] server listening on port", PORT);
});
`
      ),
      entry(
        "package.json",
        `{
  "name": "mandelogue-web-project",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
`
      ),
    ],
  },
];

export function getProjectTemplateById(templateId) {
  return PROJECT_TEMPLATES.find((template) => template.id === templateId) || null;
}

export function createProjectTemplateFiles(templateId) {
  const template = getProjectTemplateById(templateId);
  if (!template) {
    return [];
  }
  return template.files.map((file) => ({
    relativePath: file.relativePath,
    content: file.content,
  }));
}
