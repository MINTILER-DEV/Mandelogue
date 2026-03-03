const XTERM_MODULE_URL = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm";
const XTERM_FIT_MODULE_URL = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm";

const MIN_TERMINAL_HEIGHT = 130;
const FIT_STABILIZE_INTERVAL_MS = 120;
const FIT_STABILIZE_DEFAULT_MS = 900;
const FIT_STABILIZE_LONG_MS = 1800;
const FALLBACK_ROW_HEIGHT_PX = 17;
const FALLBACK_COL_WIDTH_PX = 9;

export class TerminalService {
  constructor(bus, options) {
    this.bus = bus;
    this.container = options.container;
    this.panelElement = options.panelElement;
    this.resizeHandle = options.resizeHandle;
    this.layoutElement = options.layoutElement;

    this.terminal = null;
    this.fitAddon = null;
    this.inputDisposable = null;
    this.busUnsubscribers = [];
    this.resizeObserver = null;
    this.fitStabilizeTimer = null;
    this.fitStabilizeUntil = 0;
    this.recoveryTimer = null;

    this.isDragging = false;
    this.pointerId = null;
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundWindowResize = this.onWindowResize.bind(this);
    this.boundResizeHandleKeydown = this.onResizeHandleKeydown.bind(this);
  }

  async init() {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import(XTERM_MODULE_URL),
      import(XTERM_FIT_MODULE_URL),
    ]);

    this.terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "\"IBM Plex Mono\", Consolas, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#101010",
        foreground: "#d5d5d5",
        cursor: "#f5f5f5",
      },
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.container);
    this.scheduleFit(FIT_STABILIZE_LONG_MS);
    if (document.fonts && typeof document.fonts.ready?.then === "function") {
      document.fonts.ready.then(() => {
        this.scheduleFit(FIT_STABILIZE_DEFAULT_MS);
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.scheduleFit(FIT_STABILIZE_DEFAULT_MS);
      });
      this.resizeObserver.observe(this.container);
      if (this.panelElement) {
        this.resizeObserver.observe(this.panelElement);
      }
    }

    this.inputDisposable = this.terminal.onData((data) => {
      this.bus.emit("terminal-input", { data });
    });

    this.busUnsubscribers.push(
      this.bus.on("terminal-output", ({ data }) => {
        if (typeof data === "string" && data.length > 0) {
          this.terminal.write(data);
        }
      })
    );

    this.busUnsubscribers.push(
      this.bus.on("terminal-layout-changed", () => {
        this.scheduleFit(FIT_STABILIZE_LONG_MS);
      })
    );

    this.resizeHandle.addEventListener("pointerdown", (event) => {
      this.onPointerDown(event);
    });
    this.resizeHandle.addEventListener("keydown", this.boundResizeHandleKeydown);
    window.addEventListener("pointermove", this.boundPointerMove);
    window.addEventListener("pointerup", this.boundPointerUp);
    window.addEventListener("resize", this.boundWindowResize);
  }

  fit() {
    if (!this.fitAddon) {
      return;
    }
    try {
      this.fitAddon.fit();
      this.maybeRecoverCollapsedRows();
      this.bus.emit("terminal-resized", {
        rows: this.terminal.rows,
        cols: this.terminal.cols,
      });
    } catch (error) {
      // Fit can fail while DOM is hidden; this is safe to ignore.
    }
  }

  scheduleFit(stabilizeMs = FIT_STABILIZE_DEFAULT_MS) {
    this.fit();
    requestAnimationFrame(() => {
      this.fit();
    });

    const until = Date.now() + Math.max(0, stabilizeMs);
    if (until > this.fitStabilizeUntil) {
      this.fitStabilizeUntil = until;
    }

    if (this.fitStabilizeTimer) {
      return;
    }

    this.fitStabilizeTimer = window.setInterval(() => {
      this.fit();
      if (Date.now() >= this.fitStabilizeUntil) {
        clearInterval(this.fitStabilizeTimer);
        this.fitStabilizeTimer = null;
      }
    }, FIT_STABILIZE_INTERVAL_MS);
  }

  maybeRecoverCollapsedRows() {
    if (!this.terminal || this.terminal.rows > 1) {
      return;
    }

    const hostRect = this.container.getBoundingClientRect();
    if (hostRect.height < MIN_TERMINAL_HEIGHT - 20) {
      return;
    }

    if (this.recoveryTimer) {
      return;
    }

    // When fit runs during a transient layout, xterm can get stuck at one row.
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.terminal || !this.fitAddon) {
        return;
      }
      const rect = this.container.getBoundingClientRect();
      const fallbackRows = Math.max(4, Math.floor(rect.height / FALLBACK_ROW_HEIGHT_PX));
      const fallbackCols = Math.max(20, Math.floor(rect.width / FALLBACK_COL_WIDTH_PX));
      this.terminal.resize(fallbackCols, fallbackRows);
      this.fit();
      this.scheduleFit(FIT_STABILIZE_DEFAULT_MS);
    }, 90);
  }

  onWindowResize() {
    this.scheduleFit(FIT_STABILIZE_DEFAULT_MS);
  }

  onPointerDown(event) {
    event.preventDefault();
    this.isDragging = true;
    this.pointerId = event.pointerId;
    this.resizeHandle.classList.add("is-dragging");
    try {
      this.resizeHandle.setPointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture support can vary and is optional here.
    }
  }

  onPointerMove(event) {
    if (!this.isDragging) {
      return;
    }
    const viewportHeight = window.innerHeight;
    const nextHeight = Math.max(MIN_TERMINAL_HEIGHT, viewportHeight - event.clientY);
    const maxHeight = Math.floor(viewportHeight * 0.75);
    const clampedHeight = Math.min(nextHeight, maxHeight);
    this.layoutElement.style.setProperty("--terminal-height", `${clampedHeight}px`);
    this.scheduleFit(FIT_STABILIZE_DEFAULT_MS);
  }

  onPointerUp(event) {
    if (!this.isDragging || event.pointerId !== this.pointerId) {
      return;
    }
    this.isDragging = false;
    this.pointerId = null;
    this.resizeHandle.classList.remove("is-dragging");
    try {
      this.resizeHandle.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Ignore if capture was not set.
    }
  }

  onResizeHandleKeydown(event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    const computed = getComputedStyle(this.layoutElement).getPropertyValue("--terminal-height").trim();
    const currentHeight = computed.endsWith("px")
      ? Number.parseInt(computed.slice(0, -2), 10)
      : Math.floor(window.innerHeight * 0.3);
    const delta = event.key === "ArrowUp" ? 24 : -24;
    const nextHeight = Math.max(MIN_TERMINAL_HEIGHT, currentHeight + delta);
    const maxHeight = Math.floor(window.innerHeight * 0.75);
    this.layoutElement.style.setProperty("--terminal-height", `${Math.min(nextHeight, maxHeight)}px`);
    this.scheduleFit(FIT_STABILIZE_DEFAULT_MS);
  }

  dispose() {
    window.removeEventListener("pointermove", this.boundPointerMove);
    window.removeEventListener("pointerup", this.boundPointerUp);
    window.removeEventListener("resize", this.boundWindowResize);
    this.resizeHandle.removeEventListener("keydown", this.boundResizeHandleKeydown);

    for (const unsubscribe of this.busUnsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        // Ignore remove errors.
      }
    }
    this.busUnsubscribers = [];

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this.fitStabilizeTimer) {
      clearInterval(this.fitStabilizeTimer);
      this.fitStabilizeTimer = null;
    }

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    if (this.inputDisposable) {
      this.inputDisposable.dispose();
      this.inputDisposable = null;
    }

    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }
}
