// ==UserScript==
// @name         NotionAI++
// @namespace    https://github.com/0-V-linuxdo/NotionPP
// @version      20261007.1.1.4
// @description  Notion AI usage meter docked to the AI composer, Notion-style chat outline, and more. No cookies or tokens are read.
// @author       NotionAI++ Contributors
// @homepageURL  https://github.com/0-V-linuxdo/NotionPP
// @supportURL   https://github.com/0-V-linuxdo/NotionPP/issues
// @downloadURL  https://raw.githubusercontent.com/0-V-linuxdo/NotionPP/main/userscript/NotionPP.user.js
// @updateURL    https://raw.githubusercontent.com/0-V-linuxdo/NotionPP/main/userscript/NotionPP.user.js
// @match        https://app.notion.com/*
// @match        https://www.notion.so/*
// @match        https://notion.so/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(() => {
  // src/utils/Logger.ts
  var CAP = "color:#fff;background:#2f2f2f;font-weight:700;padding:1px 6px;border-radius:6px 0 0 6px;";
  var BODY = "background:#ededeb;color:#37352f;font-weight:600;padding:1px 6px;border-radius:0 6px 6px 0;";

  class Logger {
    name;
    constructor(name) {
      this.name = name;
    }
    emit(level, args) {
      try {
        console[level](`%cNotionAI++%c${this.name}`, CAP, BODY, ...args);
      } catch {}
    }
    log(...args) {
      this.emit("log", args);
    }
    info(...args) {
      this.emit("info", args);
    }
    warn(...args) {
      this.emit("warn", args);
    }
    error(...args) {
      this.emit("error", args);
    }
    debug(...args) {
      this.emit("debug", args);
    }
  }

  // src/utils/page.ts
  var pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  var NOTION_HOSTS = new Set(["app.notion.com", "www.notion.so", "notion.so"]);
  function isNotionUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" && NOTION_HOSTS.has(url.hostname);
    } catch {
      return false;
    }
  }
  function isTopmostNotionDocument(win = pageWindow) {
    if (!isNotionUrl(win.location.href))
      return false;
    const ancestors = win.location.ancestorOrigins;
    if (ancestors) {
      for (let index = 0;index < ancestors.length; index++) {
        if (isNotionUrl(ancestors[index]))
          return false;
      }
    }
    let current = win;
    for (let depth = 0;depth < 32; depth++) {
      let parent;
      try {
        parent = current.parent;
      } catch {
        return true;
      }
      if (!parent || parent === current)
        return true;
      try {
        if (isNotionUrl(parent.location.href))
          return false;
      } catch {
        return true;
      }
      current = parent;
    }
    return true;
  }
  var isAiRoute = (pathname = pageWindow.location.pathname) => /^\/(?:ai|chat)(?:\/|$)/i.test(pathname);
  function uiLanguage() {
    return /^zh(?:-|$)/i.test(document.documentElement?.lang ?? "") ? "zh" : "en";
  }
  var t = (zh, en) => uiLanguage() === "zh" ? zh : en;
  function trustedHtml(html) {
    const policy = globalThis.ADG_policyApi;
    try {
      if (policy && typeof policy.createHTML === "function")
        return policy.createHTML(html);
    } catch {}
    return html;
  }

  // src/api/Network.ts
  var logger = new Logger("Network");
  var SAFE_HEADERS = [
    "content-type",
    "notion-client-version",
    "x-notion-active-user-header",
    "x-notion-cell",
    "x-notion-space-id"
  ];
  var MAX_BODY_CHARS = 2000000;
  var original = typeof pageWindow.fetch === "function" ? pageWindow.fetch.bind(pageWindow) : null;
  var observers = new Set;
  var sequence = 0;
  var installed = false;
  function observeNetwork(observer) {
    installHooks();
    observers.add(observer);
    return () => void observers.delete(observer);
  }
  var nextSequence = () => ++sequence;
  function readHeader(headers, name) {
    if (!headers)
      return null;
    try {
      if (typeof headers.get === "function")
        return headers.get(name);
      if (Array.isArray(headers)) {
        const entry = headers.find((item) => Array.isArray(item) && String(item[0]).toLowerCase() === name);
        return entry ? String(entry[1]) : null;
      }
      if (typeof headers === "object") {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
        return key ? String(headers[key]) : null;
      }
    } catch {}
    return null;
  }
  function safeHeaders(headers) {
    const result = {};
    for (const name of SAFE_HEADERS) {
      const value = readHeader(headers, name);
      if (typeof value === "string" && value.length <= 512)
        result[name] = value;
    }
    return result;
  }
  function interested(url, method) {
    return [...observers].filter((observer) => {
      try {
        return observer.matches(url, method);
      } catch {
        return false;
      }
    });
  }
  function resolveUrl(raw) {
    try {
      return new URL(raw, pageWindow.location.href);
    } catch {
      return null;
    }
  }
  function dispatch(targets, exchange) {
    for (const observer of targets) {
      try {
        observer.onExchange(exchange);
      } catch (error) {
        logger.error("Network observer failed:", error);
      }
    }
  }
  var isInstance = (value, name) => {
    const ctor = pageWindow[name];
    return typeof ctor === "function" && value instanceof ctor;
  };
  function fetchBody(input, init) {
    if (init && "body" in init) {
      const { body } = init;
      if (typeof body === "string")
        return Promise.resolve(body);
      if (isInstance(body, "URLSearchParams"))
        return Promise.resolve(String(body));
      return Promise.resolve("");
    }
    if (isInstance(input, "Request")) {
      try {
        return input.clone().text().catch(() => "");
      } catch {
        return Promise.resolve("");
      }
    }
    return Promise.resolve("");
  }
  function wrapFetchResponse(response) {
    const copy = response.clone();
    return {
      ok: response.ok,
      status: response.status,
      async text() {
        const declared = Number(response.headers.get("content-length"));
        if (declared > MAX_BODY_CHARS)
          throw new Error("response-too-large");
        const text = await copy.text();
        if (text.length > MAX_BODY_CHARS)
          throw new Error("response-too-large");
        return text;
      }
    };
  }
  function installFetch() {
    const nativeFetch = pageWindow.fetch;
    if (typeof nativeFetch !== "function")
      return;
    function fetch(input, init) {
      let targets = [];
      let partial = null;
      try {
        const isRequest = isInstance(input, "Request");
        const url = resolveUrl(isRequest ? input.url : String(input));
        const method = String(init?.method ?? (isRequest ? input.method : "GET")).toUpperCase();
        targets = url ? interested(url, method) : [];
        if (url && targets.length) {
          const headers = init?.headers ?? (isRequest ? input.headers : undefined);
          partial = { url, method, sequence: nextSequence(), headers: safeHeaders(headers), body: fetchBody(input, init) };
        }
      } catch {}
      const result = Reflect.apply(nativeFetch, this, arguments);
      if (partial) {
        const response = Promise.resolve(result).then(wrapFetchResponse, () => null);
        dispatch(targets, { ...partial, response });
      }
      return result;
    }
    try {
      pageWindow.fetch = fetch;
    } catch (error) {
      logger.warn("fetch hook unavailable:", error);
    }
  }
  function installXhr() {
    const proto = pageWindow.XMLHttpRequest?.prototype;
    if (!proto)
      return;
    const { open, send, setRequestHeader } = proto;
    const meta = new WeakMap;
    proto.open = function(method, url) {
      meta.set(this, { url: resolveUrl(String(url)), method: String(method || "GET").toUpperCase(), headers: {} });
      return Reflect.apply(open, this, arguments);
    };
    proto.setRequestHeader = function(name, value) {
      const record = meta.get(this);
      const lower = String(name).toLowerCase();
      if (record && SAFE_HEADERS.includes(lower))
        record.headers[lower] = String(value);
      return Reflect.apply(setRequestHeader, this, arguments);
    };
    proto.send = function(body) {
      const record = meta.get(this);
      const targets = record?.url ? interested(record.url, record.method) : [];
      if (record?.url && targets.length) {
        const xhr = this;
        const response = new Promise((resolve) => {
          xhr.addEventListener("loadend", () => resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            async text() {
              if (xhr.responseType === "json")
                return JSON.stringify(xhr.response);
              if (xhr.responseType && xhr.responseType !== "text")
                return "";
              if (xhr.responseText.length > MAX_BODY_CHARS)
                throw new Error("response-too-large");
              return xhr.responseText;
            }
          }), { once: true });
        });
        dispatch(targets, {
          url: record.url,
          method: record.method,
          sequence: nextSequence(),
          headers: safeHeaders(record.headers),
          body: Promise.resolve(typeof body === "string" ? body : ""),
          response
        });
      }
      return Reflect.apply(send, this, arguments);
    };
  }
  function installHooks() {
    if (installed)
      return;
    installed = true;
    installFetch();
    try {
      installXhr();
    } catch (error) {
      logger.warn("XHR hook unavailable:", error);
    }
  }
  function nativeFetch() {
    return original ?? pageWindow.fetch.bind(pageWindow);
  }

  // src/utils/guards.ts
  var isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function finiteNumber(value) {
    if (typeof value === "number")
      return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim())
      return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function nonNegative(value) {
    const parsed = finiteNumber(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
  }
  var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  var SPACE_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  var isSpaceId = (value) => typeof value === "string" && SPACE_ID_RE.test(value);
  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // src/api/Settings.ts
  var logger2 = new Logger("Settings");
  var SETTINGS_KEY = "notionai-pp:settings:v1";
  var isHexColor = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  var listeners = new Set;
  function read() {
    try {
      const parsed = safeJson(localStorage.getItem(SETTINGS_KEY) ?? "");
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  var bag = read();
  function persist() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(bag));
    } catch (error) {
      logger2.warn("Settings could not be saved:", error);
    }
  }
  function getValue(plugin, key) {
    return bag[plugin]?.[key];
  }
  function setValue(plugin, key, value) {
    if (bag[plugin]?.[key] === value)
      return;
    bag = { ...bag, [plugin]: { ...bag[plugin], [key]: value } };
    persist();
    for (const listener of [...listeners]) {
      try {
        listener(plugin, key);
      } catch (error) {
        logger2.error("Settings listener failed:", error);
      }
    }
  }
  function resetValues(plugin, keys) {
    const current = bag[plugin];
    if (!current || !keys.some((key) => (key in current)))
      return;
    const next = { ...current };
    for (const key of keys)
      delete next[key];
    bag = { ...bag, [plugin]: next };
    persist();
    for (const key of keys) {
      for (const listener of [...listeners]) {
        try {
          listener(plugin, key);
        } catch (error) {
          logger2.error("Settings listener failed:", error);
        }
      }
    }
  }
  function onSettingsChange(listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }
  function reloadFromStorage(raw) {
    const parsed = safeJson(raw ?? "");
    bag = isRecord(parsed) ? parsed : {};
    for (const listener of [...listeners])
      listener("*", "*");
  }
  function definePluginSettings(def) {
    let owner = "";
    const store = new Proxy({}, {
      get: (_, key) => {
        const option = def[key];
        if (!option)
          return;
        const value = getValue(owner, key);
        if (option.type === "boolean")
          return typeof value === "boolean" ? value : option.default;
        if (option.type === "color")
          return isHexColor(value) ? value.toLowerCase() : option.default;
        if (option.type === "action")
          return;
        if (option.type === "number") {
          return typeof value === "number" && Number.isFinite(value) ? Math.min(option.max, Math.max(option.min, Math.round(value))) : option.default;
        }
        return typeof value === "string" && option.options.some((o) => o.value === value) ? value : option.default;
      },
      set: (_, key, value) => {
        setValue(owner, key, value);
        return true;
      }
    });
    return { def, store, bind: (plugin) => void (owner = plugin) };
  }

  // src/api/PluginManager.ts
  var logger3 = new Logger("PluginManager");
  var definePlugin = (def) => ({ ...def, started: false });
  var plugins = new Map;
  var allPlugins = () => [...plugins.values()];
  function isEnabled(plugin) {
    if (plugin.required)
      return true;
    const value = getValue(plugin.name, "enabled");
    return typeof value === "boolean" ? value : plugin.enabledByDefault;
  }
  function startPlugin(plugin) {
    if (plugin.started)
      return;
    try {
      plugin.start();
      plugin.started = true;
    } catch (error) {
      logger3.error(`${plugin.name} failed to start:`, error);
    }
  }
  function stopPlugin(plugin) {
    if (!plugin.started)
      return;
    plugin.started = false;
    try {
      plugin.stop();
    } catch (error) {
      logger3.error(`${plugin.name} failed to stop:`, error);
    }
  }
  function setEnabled(plugin, enabled) {
    setValue(plugin.name, "enabled", enabled);
  }
  function registerPlugins(list) {
    for (const plugin of list) {
      plugin.settings?.bind(plugin.name);
      plugins.set(plugin.name, plugin);
    }
  }
  var phase = null;
  function startPlugins(at) {
    phase = at;
    for (const plugin of plugins.values()) {
      if ((plugin.startAt ?? "DomReady" /* DomReady */) !== at && at === "DocumentStart" /* DocumentStart */)
        continue;
      if (isEnabled(plugin))
        startPlugin(plugin);
    }
  }
  onSettingsChange((name, key) => {
    for (const plugin of plugins.values()) {
      if (name !== "*" && name !== plugin.name)
        continue;
      const ready = phase === "DomReady" /* DomReady */ || plugin.startAt === "DocumentStart" /* DocumentStart */;
      if (key === "enabled" || key === "*") {
        if (isEnabled(plugin) && ready)
          startPlugin(plugin);
        else if (!isEnabled(plugin))
          stopPlugin(plugin);
      }
      if (key !== "enabled" && plugin.started)
        plugin.onSettingsChange?.(key);
    }
  });

  // src/api/DomWatch.ts
  var listeners2 = new Set;
  var observer = null;
  var queue = [];
  var scheduled = false;
  function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    for (const listener of [...listeners2]) {
      try {
        listener(batch);
      } catch {}
    }
  }
  function ensureObserver() {
    if (observer || !document.documentElement)
      return;
    observer = new MutationObserver((records) => {
      queue.push(...records);
      if (scheduled)
        return;
      scheduled = true;
      requestAnimationFrame(flush);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  function onDomChange(listener) {
    ensureObserver();
    listeners2.add(listener);
    return () => {
      listeners2.delete(listener);
      if (!listeners2.size && observer) {
        observer.disconnect();
        observer = null;
        queue = [];
      }
    };
  }

  // src/utils/icons.ts
  var Icons = {
    gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
    list: `<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>`,
    collapse: `<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>`,
    highlighter: `<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>`,
    smile: `<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>`,
    cog: `<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M12 2v2"/><path d="M12 22v-2"/><path d="m17 20.66-1-1.73"/><path d="M11 10.27 7 3.34"/><path d="m20.66 17-1.73-1"/><path d="m3.34 7 1.73 1"/><path d="M14 12h8"/><path d="M2 12h2"/><path d="m20.66 7-1.73 1"/><path d="m3.34 17 1.73-1"/><path d="m17 3.34-1 1.73"/><path d="m11 13.73-4 6.93"/>`,
    plug: `<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
    sliders: `<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>`,
    star: `<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`,
    pin: `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>`,
    x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
    info: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,
    alert: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
    lock: `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`
  };
  function svgIcon(markup, filled = false) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", filled ? "currentColor" : "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, "image/svg+xml");
    for (const child of [...doc.documentElement.childNodes])
      svg.appendChild(document.importNode(child, true));
    return svg;
  }

  // src/plugins/autoCollapseThinking/index.ts
  var TOGGLE = "[role='button'][aria-expanded][aria-controls]";
  var STEP_TITLE = ".notion-agent-tool-use-title";
  var STREAMING = "[role='status'], .nds-shimmer-text";
  var THINKING_LABEL = /^(?:\d+\s*(?:steps?|个?步骤?)|thought|thinking|reasoning|已?思考|推理)/i;
  var settings = definePluginSettings({
    mode: {
      type: "select",
      label: "折叠时机 / When to collapse",
      description: "回复完成后折叠，或生成过程中就折叠 / After the reply finishes, or while it is still streaming",
      default: "finished",
      options: [
        { value: "finished", label: "回复完成后 / When the reply finishes" },
        { value: "immediate", label: "立即（含生成中）/ Immediately, even while streaming" }
      ]
    },
    collapseHistory: {
      type: "boolean",
      label: "折叠历史回复 / Collapse earlier replies",
      description: "打开对话时，也折叠已经展开的旧回复思考 / Also collapse expanded thinking in replies already on the page",
      default: true
    }
  });
  var userOwned = new WeakSet;
  var seenAtStart = new WeakSet;
  var stopDom = null;
  var attrObserver = null;
  var scheduled2 = false;
  function panelOf(toggle) {
    const id = toggle.getAttribute("aria-controls");
    return id ? toggle.ownerDocument.getElementById(id) : null;
  }
  function labelOf(toggle) {
    return (toggle.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  var isStreaming = (toggle) => !!toggle.querySelector(STREAMING);
  function isThinkingToggle(toggle) {
    if (!toggle.matches(TOGGLE))
      return false;
    if (toggle.closest(".notion-sidebar, nav"))
      return false;
    if (toggle.querySelector(STEP_TITLE))
      return false;
    if (isStreaming(toggle))
      return true;
    if (THINKING_LABEL.test(labelOf(toggle)))
      return true;
    const panel = panelOf(toggle);
    return !!panel?.querySelector(STEP_TITLE);
  }
  function shouldCollapse(toggle) {
    if (toggle.getAttribute("aria-expanded") !== "true")
      return false;
    if (userOwned.has(toggle))
      return false;
    if (!isThinkingToggle(toggle))
      return false;
    if (seenAtStart.has(toggle) && !settings.store.collapseHistory)
      return false;
    if (settings.store.mode !== "immediate" && isStreaming(toggle))
      return false;
    return true;
  }
  function scan(root = document) {
    for (const toggle of root.querySelectorAll(TOGGLE)) {
      if (shouldCollapse(toggle))
        toggle.click();
    }
  }
  function schedule() {
    if (scheduled2)
      return;
    scheduled2 = true;
    requestAnimationFrame(() => {
      scheduled2 = false;
      scan();
    });
  }
  function claim(event) {
    if (!event.isTrusted)
      return;
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ")
      return;
    const toggle = event.target?.closest?.(TOGGLE);
    if (toggle && isThinkingToggle(toggle))
      userOwned.add(toggle);
  }
  var autoCollapseThinking_default = definePlugin({
    name: "AutoCollapseThinking",
    title: "自动折叠 AI 思考",
    description: "Notion AI 回复完成后，自动折叠它的思考步骤（“N steps”）。手动展开过的不会再被折叠。",
    icon: Icons.collapse,
    tags: ["chat"],
    enabledByDefault: true,
    settings,
    start() {
      userOwned = new WeakSet;
      seenAtStart = new WeakSet;
      for (const toggle of document.querySelectorAll(TOGGLE)) {
        if (!isStreaming(toggle))
          seenAtStart.add(toggle);
      }
      document.addEventListener("click", claim, true);
      document.addEventListener("keydown", claim, true);
      stopDom = onDomChange(schedule);
      attrObserver = new MutationObserver(schedule);
      attrObserver.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-expanded"]
      });
      scan();
    },
    stop() {
      document.removeEventListener("click", claim, true);
      document.removeEventListener("keydown", claim, true);
      stopDom?.();
      stopDom = null;
      attrObserver?.disconnect();
      attrObserver = null;
    },
    onSettingsChange() {
      scan();
    }
  });

  // src/api/Theme.ts
  var DARK_RE = /(?:^|[\s_-])dark(?:$|[\s_-])/i;
  var LIGHT_RE = /(?:^|[\s_-])light(?:$|[\s_-])/i;
  var RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i;
  function colorTheme(value) {
    const match = RGB_RE.exec(value);
    if (!match)
      return null;
    const alpha = match[4] === undefined ? 1 : Number(match[4]);
    if (!(alpha >= 0.35))
      return null;
    const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    return luminance < 0.52 ? "dark" : "light";
  }
  function currentTheme() {
    const { documentElement: html, body } = document;
    const marker = [html, body].flatMap((node) => node ? [node.className, node.getAttribute("data-theme"), node.getAttribute("data-mode")] : []).filter((value) => typeof value === "string").join(" ");
    if (DARK_RE.test(marker))
      return "dark";
    if (LIGHT_RE.test(marker))
      return "light";
    const inner = document.querySelector(".notion-app-inner");
    if (inner?.classList.contains("notion-dark-theme"))
      return "dark";
    if (inner?.classList.contains("notion-light-theme"))
      return "light";
    for (const node of [document.getElementById("notion-app"), inner, body, html]) {
      if (!node)
        continue;
      const theme = colorTheme(getComputedStyle(node).backgroundColor);
      if (theme)
        return theme;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  var listeners3 = new Set;
  var observer2 = null;
  var last = null;
  function notify() {
    const theme = currentTheme();
    if (theme === last)
      return;
    last = theme;
    for (const listener of [...listeners3])
      listener(theme);
  }
  function onThemeChange(listener) {
    listeners3.add(listener);
    if (!observer2) {
      observer2 = new MutationObserver(notify);
      const options = { attributes: true, subtree: false, attributeFilter: ["class", "data-theme", "data-mode", "lang"] };
      observer2.observe(document.documentElement, options);
      if (document.body)
        observer2.observe(document.body, options);
      const inner = document.querySelector(".notion-app-inner");
      if (inner)
        observer2.observe(inner, options);
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", notify);
    }
    last = null;
    queueMicrotask(notify);
    return () => {
      listeners3.delete(listener);
      if (!listeners3.size) {
        observer2?.disconnect();
        observer2 = null;
      }
    };
  }

  // src/api/Overlay.ts
  function createOverlay(id, css, html) {
    document.getElementById(id)?.remove();
    const host = document.createElement("div");
    host.id = id;
    host.dataset.theme = currentTheme();
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = trustedHtml(`<style>${css}</style>${html}`);
    const mount = () => {
      if (document.body && host.parentNode !== document.body)
        document.body.appendChild(host);
    };
    mount();
    const stopDom = onDomChange(() => {
      if (!host.isConnected || host.parentNode !== document.body)
        mount();
    });
    const stopTheme = onThemeChange((theme) => void (host.dataset.theme = theme));
    return {
      host,
      root,
      destroy() {
        stopDom();
        stopTheme();
        host.remove();
      }
    };
  }

  // src/api/Router.ts
  var listeners4 = new Set;
  var POLL_MS = 1000;
  var last2 = "";
  var installed2 = false;
  function check() {
    const href = pageWindow.location.href;
    if (href === last2)
      return;
    const change = { href, previous: last2 };
    last2 = href;
    for (const listener of [...listeners4]) {
      try {
        listener(change);
      } catch {}
    }
  }
  function install() {
    if (installed2)
      return;
    installed2 = true;
    last2 = pageWindow.location.href;
    const schedule = () => queueMicrotask(check);
    const nav = pageWindow.navigation;
    if (nav && typeof nav.addEventListener === "function") {
      nav.addEventListener("navigatesuccess", schedule);
      nav.addEventListener("currententrychange", schedule);
    }
    for (const method of ["pushState", "replaceState"]) {
      const native = pageWindow.history[method];
      pageWindow.history[method] = function() {
        const result = Reflect.apply(native, this, arguments);
        schedule();
        return result;
      };
    }
    pageWindow.addEventListener("popstate", schedule);
    pageWindow.addEventListener("hashchange", schedule);
    setInterval(check, POLL_MS);
  }
  function onRouteChange(listener) {
    install();
    listeners4.add(listener);
    return () => void listeners4.delete(listener);
  }

  // src/utils/dom.ts
  function boxOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  var sameBox = (a, b, tolerance = 0.5) => !!a && !!b && Math.abs(a.left - b.left) <= tolerance && Math.abs(a.top - b.top) <= tolerance && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
  function viewport() {
    const doc = document.documentElement;
    return { width: window.innerWidth || doc?.clientWidth || 0, height: window.innerHeight || doc?.clientHeight || 0 };
  }
  function visibleBox(el) {
    if (!el || !el.isConnected)
      return null;
    if (el.closest("[aria-hidden='true'], [inert]"))
      return null;
    const style = getComputedStyle(el);
    const opacity = parseFloat(style.opacity);
    if (style.display === "none" || style.visibility === "hidden" || opacity <= 0.02)
      return null;
    const box = boxOf(el);
    if (box.width <= 0 || box.height <= 0)
      return null;
    const vp = viewport();
    if (box.right <= 0 || box.bottom <= 0 || box.left >= vp.width || box.top >= vp.height)
      return null;
    return box;
  }
  function scrollParentOf(el) {
    for (let node = el.parentElement;node && node !== document.body; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight)
        return node;
    }
    return document.scrollingElement ?? document.documentElement;
  }
  var reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined)
        continue;
      if (key === "class")
        node.className = value;
      else if (key === "text")
        node.textContent = value;
      else
        node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  // src/plugins/usage/composer.ts
  var CONTAINER_SELECTOR = "[data-notion-chat-input-container]";
  var EDITOR_SELECTOR = "[role='textbox'][contenteditable='true'], [role='textbox'][contenteditable='plaintext-only'], textarea, [contenteditable='true']";
  var SEMANTIC_RE = /notion\s*ai|do anything with ai|ask\s+(?:notion\s+)?ai|ask anything|(?:用|向|让|问)\s*(?:notion\s*)?ai|ai\s*(?:助手|输入|对话|提问)/i;
  var SURFACE_MIN_RADIUS = 8;
  var MAX_CLIMB = 10;
  var IDLE_RESCAN_MS = 500;
  function hasSurface(node) {
    const style = getComputedStyle(node);
    if ((parseFloat(style.borderTopLeftRadius) || 0) < SURFACE_MIN_RADIUS)
      return false;
    const background = style.backgroundColor.replace(/\s+/g, "");
    const painted = background !== "" && background !== "transparent" && background !== "rgba(0,0,0,0)";
    return painted || style.boxShadow !== "" && style.boxShadow !== "none" || (parseFloat(style.borderTopWidth) || 0) > 0;
  }
  function surfaceFor(editor, limit) {
    let best = null;
    let node = editor;
    for (let depth = 0;node && depth < MAX_CLIMB; depth++, node = node.parentElement) {
      if (node === document.body)
        break;
      if (hasSurface(node))
        best = node;
      if (node === limit)
        break;
    }
    return best ?? limit ?? editor;
  }
  var editorText = (editor) => ["placeholder", "aria-placeholder", "data-placeholder", "aria-label"].map((name) => editor.getAttribute(name) ?? "").join(" ");
  function rank(match, box) {
    const active = document.activeElement;
    let score = box.bottom / Math.max(1, viewport().height) * 10 + box.width / Math.max(1, viewport().width) * 4;
    if (active && (match.editor === active || match.editor.contains(active) || match.surface.contains(active)))
      score += 100;
    return score;
  }
  function fromContainers() {
    const found = [];
    for (const container of document.querySelectorAll(CONTAINER_SELECTOR)) {
      const editor = container.querySelector(EDITOR_SELECTOR);
      if (!editor || !visibleBox(editor))
        continue;
      found.push({ editor, surface: surfaceFor(editor, container) });
    }
    return found;
  }
  function fromHeuristics() {
    const found = [];
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      if (!SEMANTIC_RE.test(editorText(editor)))
        continue;
      const box = visibleBox(editor);
      if (!box || box.width < 180)
        continue;
      found.push({ editor, surface: surfaceFor(editor, null) });
    }
    return found;
  }
  function locateComposer() {
    const candidates = fromContainers();
    const pool = candidates.length ? candidates : fromHeuristics();
    let best = null;
    for (const match of pool) {
      const box = visibleBox(match.surface);
      if (!box)
        continue;
      const score = rank(match, box);
      if (!best || score > best.score)
        best = { ...match, box, score };
    }
    return best;
  }

  class ComposerTracker {
    onChange;
    frame = 0;
    match = null;
    box = null;
    dirty = true;
    lastScan = 0;
    cleanups = [];
    constructor(onChange) {
      this.onChange = onChange;
    }
    start() {
      if (this.frame)
        return;
      const markDirty = () => void (this.dirty = true);
      this.cleanups = [
        onDomChange(markDirty),
        onRouteChange(markDirty)
      ];
      for (const type of ["focusin", "resize"]) {
        window.addEventListener(type, markDirty, { capture: true, passive: true });
        this.cleanups.push(() => window.removeEventListener(type, markDirty, { capture: true }));
      }
      this.dirty = true;
      this.tick();
    }
    stop() {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      for (const cleanup of this.cleanups)
        cleanup();
      this.cleanups = [];
      this.match = null;
      this.box = null;
    }
    get current() {
      return this.box;
    }
    tick = () => {
      this.frame = requestAnimationFrame(this.tick);
      if (document.hidden)
        return;
      const now = performance.now();
      let box = this.match ? visibleBox(this.match.surface) : null;
      const shouldScan = this.dirty || !box && now - this.lastScan >= IDLE_RESCAN_MS;
      if (shouldScan) {
        this.dirty = false;
        this.lastScan = now;
        const next = locateComposer();
        this.match = next;
        box = next?.box ?? null;
      }
      if (sameBox(box, this.box) || !box && !this.box)
        return;
      this.box = box;
      this.onChange(box);
    };
  }

  // src/plugins/focusHighlight/index.ts
  var PLUGIN = "FocusHighlight";
  var STYLE_ID = "notionai-pp-focus-highlight";
  var PANEL_ID = "notionai-pp-focus-panel";
  var BOX_ATTR = "data-notionai-pp-focus-box";
  var COLOR_VAR = "--notionai-pp-focus-color";
  var EDITOR = "[role='textbox'][contenteditable]:not([contenteditable='false']), textarea, [contenteditable]:not([contenteditable='false'])";
  var PROMPT_HINT = /do anything with ai|ask\s+(?:notion\s+)?ai|notion\s*ai|(?:用|向|让|问)\s*(?:notion\s*)?ai/i;
  var RIGHT_HIT_PX = 72;
  var RIGHT_HIT_Y_PAD_PX = 10;
  var DOUBLE_CLICK_MS = 450;
  var DOUBLE_CLICK_PX = 20;
  var LEGACY_KEYS = { light: "notionAiFocusHighlightColorLight", dark: "notionAiFocusHighlightColorDark" };
  var LEGACY_SHARED_KEY = "notionAiFocusHighlightColor";
  var settings2 = definePluginSettings({
    lightColor: {
      type: "color",
      label: "普通模式高亮色 / Light mode color",
      default: "#37352f"
    },
    darkColor: {
      type: "color",
      label: "黑暗模式高亮色 / Dark mode color",
      default: "#ffffff"
    }
  });
  var colorKey = (theme) => theme === "dark" ? "darkColor" : "lightColor";
  var colorFor = (theme) => settings2.store[colorKey(theme)];
  var boxes = new Set;
  var lastEditor = null;
  var lastContextMenu = null;
  var panel = null;
  var cleanups = [];
  var scheduled3 = false;
  var hint = (editor) => ["placeholder", "aria-placeholder", "data-placeholder", "aria-label"].map((name) => editor.getAttribute(name) ?? "").join(" ");
  function findPromptBoxes(root = document) {
    const found = new Set;
    for (const container of root.querySelectorAll(CONTAINER_SELECTOR)) {
      const editor = container.querySelector(EDITOR);
      if (editor)
        found.add(surfaceFor(editor, container));
    }
    for (const editor of root.querySelectorAll(EDITOR)) {
      if (editor.closest(CONTAINER_SELECTOR) || !PROMPT_HINT.test(hint(editor)))
        continue;
      found.add(surfaceFor(editor, null));
    }
    return [...found].filter((box) => box !== document.body && box !== document.documentElement);
  }
  function scan2() {
    const next = new Set(findPromptBoxes());
    for (const box of boxes)
      if (!next.has(box))
        box.removeAttribute(BOX_ATTR);
    for (const box of next)
      if (!box.hasAttribute(BOX_ATTR))
        box.setAttribute(BOX_ATTR, "");
    boxes = next;
  }
  function schedule2() {
    if (scheduled3)
      return;
    scheduled3 = true;
    requestAnimationFrame(() => {
      scheduled3 = false;
      scan2();
    });
  }
  function renderStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
    }
    if (!style.isConnected)
      (document.head ?? document.documentElement).appendChild(style);
    const color = colorFor(currentTheme());
    style.textContent = `
:root { ${COLOR_VAR}: ${color}; }
[${BOX_ATTR}] {
  outline: 1px solid var(${COLOR_VAR}) !important;
  box-shadow: 0 0 0 1px var(${COLOR_VAR}), 0 0 0 4px color-mix(in srgb, var(${COLOR_VAR}) 20%, transparent) !important;
}`;
  }
  var PANEL_CSS = `
:host { all: initial; position: fixed; top: 72px; right: 24px; z-index: 2147483647; display: block;
  --bg: #fff; --text: #37352f; --muted: #787774; --border: rgba(15,15,15,.12); --row: rgba(55,53,47,.05); --hover: rgba(55,53,47,.09);
  font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: light; }
:host([data-theme="dark"]) { --bg: #202020; --text: #f5f5f5; --muted: rgba(255,255,255,.68); --border: rgba(255,255,255,.14);
  --row: rgba(255,255,255,.07); --hover: rgba(255,255,255,.11); color-scheme: dark; }
* { box-sizing: border-box; }
.panel { width: 300px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--text);
  box-shadow: 0 12px 34px rgba(15,15,15,.22); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 14px 8px; }
h2 { margin: 0; font-size: 14px; font-weight: 650; }
.close { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font-size: 17px; cursor: pointer; }
.close:hover { background: var(--hover); color: var(--text); }
.body { display: grid; gap: 8px; padding: 0 14px 14px; }
label, .row { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 12px; min-height: 46px;
  padding: 8px 10px; border-radius: 8px; background: var(--row); }
label { cursor: pointer; } label:hover { background: var(--hover); }
.muted { color: var(--muted); font-size: 12px; font-weight: 500; }
.chip { position: relative; width: 52px; height: 30px; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.chip input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; border: 0; padding: 0; cursor: pointer; }
.value { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
`;
  function syncPanel() {
    if (!panel)
      return;
    const theme = currentTheme();
    const color = colorFor(theme);
    const { root } = panel;
    root.querySelector("h2").textContent = theme === "dark" ? t("黑暗模式高亮色", "Dark Mode Highlight") : t("普通模式高亮色", "Light Mode Highlight");
    root.querySelector("input").value = color;
    root.querySelector(".chip").style.background = color;
    root.querySelector(".value").textContent = color.toUpperCase();
  }
  function openPanel() {
    closePanel(false);
    panel = createOverlay(PANEL_ID, PANEL_CSS, `<div class="panel" role="dialog"><header><h2></h2><button class="close" type="button">×</button></header>
<div class="body"><label><span class="muted"></span><span class="chip"><input type="color"></span></label>
<div class="row"><span class="muted"></span><span class="value"></span></div></div></div>`);
    const { root } = panel;
    root.querySelector(".panel").setAttribute("aria-label", t("配置输入框高亮色", "Configure prompt highlight color"));
    const [chooseLabel, currentLabel] = root.querySelectorAll(".muted");
    chooseLabel.textContent = t("选择颜色", "Choose Color");
    currentLabel.textContent = t("当前颜色", "Current Color");
    const close = root.querySelector(".close");
    close.setAttribute("aria-label", t("关闭", "Close"));
    close.addEventListener("click", () => closePanel());
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape")
        return;
      event.stopPropagation();
      closePanel();
    });
    const input = root.querySelector("input");
    const apply = () => {
      if (isHexColor(input.value))
        settings2.store[colorKey(currentTheme())] = input.value.toLowerCase();
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
    syncPanel();
  }
  function closePanel(refocus = true) {
    if (!panel)
      return;
    panel.destroy();
    panel = null;
    if (refocus && lastEditor?.isConnected) {
      try {
        lastEditor.focus({ preventScroll: true });
      } catch {}
    }
  }
  function inRightStrip(x, y, box) {
    const rect = box.getBoundingClientRect();
    const dx = x - rect.right;
    return dx > 0 && dx <= RIGHT_HIT_PX && y >= rect.top - RIGHT_HIT_Y_PAD_PX && y <= rect.bottom + RIGHT_HIT_Y_PAD_PX;
  }
  function onContextMenu(event) {
    if (panel && event.composedPath().includes(panel.host))
      return;
    const box = [...boxes].find((b) => b.isConnected && inRightStrip(event.clientX, event.clientY, b));
    if (!box) {
      lastContextMenu = null;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const editor = box.querySelector(EDITOR);
    if (editor instanceof HTMLElement)
      lastEditor = editor;
    const now = Date.now();
    const prev = lastContextMenu;
    if (prev && prev.box === box && now - prev.time <= DOUBLE_CLICK_MS && Math.hypot(event.clientX - prev.x, event.clientY - prev.y) <= DOUBLE_CLICK_PX) {
      lastContextMenu = null;
      if (panel)
        closePanel();
      else
        openPanel();
      return;
    }
    lastContextMenu = { box, time: now, x: event.clientX, y: event.clientY };
  }
  function migrateLegacy() {
    for (const theme of ["light", "dark"]) {
      if (getValue(PLUGIN, colorKey(theme)) !== undefined)
        continue;
      let legacy = null;
      try {
        legacy = localStorage.getItem(LEGACY_KEYS[theme]) ?? (theme === "light" ? localStorage.getItem(LEGACY_SHARED_KEY) : null);
      } catch {}
      const color = legacy?.trim().replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, "#$1$1$2$2$3$3");
      if (isHexColor(color))
        setValue(PLUGIN, colorKey(theme), color.toLowerCase());
    }
  }
  var focusHighlight_default = definePlugin({
    name: PLUGIN,
    title: "输入框高亮色",
    description: "给 Notion AI 输入框描一圈自定义颜色（普通 / 黑暗模式各一种）。在输入框右侧空白处连按两次右键，可打开取色面板。",
    icon: Icons.highlighter,
    tags: ["composer", "appearance"],
    enabledByDefault: true,
    settings: settings2,
    start() {
      migrateLegacy();
      renderStyle();
      window.addEventListener("contextmenu", onContextMenu, true);
      cleanups = [
        () => window.removeEventListener("contextmenu", onContextMenu, true),
        onDomChange(schedule2),
        onRouteChange(schedule2),
        onThemeChange(() => {
          renderStyle();
          syncPanel();
        })
      ];
      scan2();
    },
    stop() {
      for (const cleanup of cleanups.splice(0))
        cleanup();
      closePanel(false);
      for (const box of boxes)
        box.removeAttribute(BOX_ATTR);
      boxes = new Set;
      lastContextMenu = null;
      document.getElementById(STYLE_ID)?.remove();
    },
    onSettingsChange() {
      renderStyle();
      syncPanel();
    }
  });

  // src/plugins/greetingCustomizer/store.ts
  var PLUGIN2 = "GreetingCustomizer";
  var MAX_LEN = 100;
  var MAX_COUNT = 30;
  var DEFAULT_GREETINGS = [
    `Ask not what your country can do for you
— ask what you can do for your country.`,
    "It always seems impossible until it is done.",
    "The best way to predict the future is to create it."
  ];
  var normalizeGreeting = (text) => text.replace(/\r\n?/g, `
`).trim();
  function validateGreeting(text) {
    const value = normalizeGreeting(text);
    if (!value)
      return "empty";
    if (value.length > MAX_LEN)
      return "tooLong";
    return null;
  }
  function loadGreetings() {
    const raw = getValue(PLUGIN2, "greetings");
    const parsed = typeof raw === "string" ? safeJson(raw) : null;
    const list = Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string" && !!normalizeGreeting(s)).slice(0, MAX_COUNT) : [];
    return list.length ? list : DEFAULT_GREETINGS.slice();
  }
  function saveGreetings(list) {
    const clean = list.map(normalizeGreeting).filter(Boolean).slice(0, MAX_COUNT);
    setValue(PLUGIN2, "greetings", JSON.stringify(clean.length ? clean : DEFAULT_GREETINGS));
  }
  function loadIndex() {
    const raw = getValue(PLUGIN2, "index");
    return typeof raw === "number" && Number.isInteger(raw) ? raw : -1;
  }
  var saveIndex = (index) => setValue(PLUGIN2, "index", index);
  function pickIndex(length, order, current, advance, random = Math.random) {
    if (length <= 1)
      return 0;
    const valid = current >= 0 && current < length;
    if (!advance)
      return valid ? current : 0;
    if (order === "random") {
      let next = Math.floor(random() * length);
      for (let guard = 0;valid && next === current && guard < 10; guard++)
        next = Math.floor(random() * length);
      if (valid && next === current)
        next = (current + 1) % length;
      return next;
    }
    return valid ? (current + 1) % length : 0;
  }
  var escapeCssContent = (text) => text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ");

  // src/plugins/greetingCustomizer/lang.ts
  var zh = /^zh\b/i.test((navigator.languages?.[0] ?? navigator.language) || "");
  var STRINGS = {
    title: ["问候语自定义 · 管理面板", "Greeting Customizer · Manager"],
    close: ["关闭", "Close"],
    newLabel: [`新问候语（支持换行，单条 ≤ ${MAX_LEN} 字符；最多 ${MAX_COUNT} 条）`, `New greeting (line breaks ok, max ${MAX_LEN} chars; up to ${MAX_COUNT} items)`],
    placeholder: ["输入问候语…（可用换行）", "Type a greeting... (line breaks allowed)"],
    add: ["添加", "Add"],
    cancelEdit: ["取消修改", "Cancel edit"],
    saveEdit: ["保存修改", "Save changes"],
    saved: ["已保存：{count}/{max} 条", "Saved: {count}/{max}"],
    edit: ["修改", "Edit"],
    delete: ["删除", "Delete"],
    empty: ["问候语不能为空（不能全是空格）。", "Greeting cannot be empty (whitespace only)."],
    tooLong: [`单条问候语不能超过 ${MAX_LEN} 字符。`, `A greeting cannot exceed ${MAX_LEN} characters.`],
    tooMany: [`最多只能保存 ${MAX_COUNT} 条问候语。`, `You can save up to ${MAX_COUNT} greetings.`],
    rotation: ["轮播设置（自动保存）", "Rotation (saved automatically)"],
    mode: ["轮播方式", "Mode"],
    modeRefresh: ["刷新/进入首页时切换", "Rotate on refresh / entering home"],
    modeInterval: ["按时间间隔自动切换", "Rotate on a timer"],
    modeManual: ["手动点击标题切换", "Click the greeting to rotate"],
    order: ["轮播顺序", "Order"],
    orderSequential: ["顺序循环", "Sequential"],
    orderRandom: ["随机选择", "Random"],
    interval: ["间隔（秒）", "Interval (seconds)"],
    tip: ["提示：手动模式下，点击首页问候语即可切换；定时模式离开首页会自动停止计时。双击右键问候语可随时打开本面板。", "Tip: in manual mode, click the home greeting to rotate. The timer stops when you leave the home page. Double right-click the greeting to open this panel."],
    done: ["完成", "Done"],
    clickHint: ["点击切换问候语", "Click to rotate greeting"],
    menu: ["\uD83D\uDCAC NotionAI++ 问候语设置", "\uD83D\uDCAC NotionAI++ greetings"]
  };
  function tr(key, vars = {}) {
    const text = STRINGS[key][zh ? 0 : 1];
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars) ? String(vars[name]) : match);
  }

  // src/plugins/greetingCustomizer/manager.ts
  var MANAGER_HOST_ID = "notionai-pp-greetings";
  var CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;
  --bg: #fff; --text: #37352f; --muted: #787774; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.05); --accent: #2383e2; --danger: #eb5757;
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
:host([data-theme="dark"]) { --bg: #252525; --text: #ebebea; --muted: #9b9b9b; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.06); }
* { box-sizing: border-box; }
.backdrop { position: absolute; inset: 0; background: rgba(15,15,15,.45); display: grid; place-items: center; padding: 16px; }
.dialog { width: min(860px, 100%); max-height: min(84vh, 860px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: 0 24px 60px rgba(0,0,0,.35); }
header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
h2 { margin: 0; font-size: 16px; }
.close { width: 28px; height: 28px; border: 0; border-radius: 6px; color: var(--muted); background: transparent; font-size: 18px; cursor: pointer; }
.close:hover { background: var(--hover); color: var(--text); }
.body { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; padding: 14px 18px; overflow: auto; }
@media (max-width: 760px) { .body { grid-template-columns: 1fr; } }
.card { display: flex; flex-direction: column; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.label { font-size: 12px; color: var(--muted); }
textarea { width: 100%; min-height: 88px; resize: vertical; font: inherit; font-size: 13px; color: var(--text); background: transparent;
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; outline: none; }
textarea:focus, select:focus, input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(35,131,226,.18); outline: none; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row.split { justify-content: space-between; }
.counter { margin-left: auto; font-size: 12px; color: var(--muted); }
.error { color: var(--danger); font-size: 12.5px; }
.hint { color: var(--muted); font-size: 12.5px; }
button.btn { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
button.btn:hover { background: var(--hover); }
button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
button.primary:hover { background: #0b6fcc; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; }
li[data-current] { border-color: var(--accent); }
li[data-editing] { background: var(--hover); }
.text { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.icon { width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent; cursor: pointer; font-size: 13px; }
.icon:hover { background: var(--hover); }
label.field { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; }
select, input[type=number] { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; }
input[type=number] { width: 80px; }
input:disabled { opacity: .5; }
footer { display: flex; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
`;
  var overlay = null;
  function closeManager() {
    overlay?.destroy();
    overlay = null;
  }
  function openManager(rotation, currentIndex) {
    closeManager();
    overlay = createOverlay(MANAGER_HOST_ID, CSS, `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true"></div></div>`);
    const { root } = overlay;
    const dialog = root.querySelector(".dialog");
    root.querySelector(".backdrop").addEventListener("click", (event) => event.target === event.currentTarget && closeManager());
    root.addEventListener("keydown", (event) => event.key === "Escape" && closeManager());
    let greetings = loadGreetings();
    let editing = -1;
    const close = el("button", { class: "close", type: "button", "aria-label": tr("close"), title: tr("close"), text: "×" });
    close.addEventListener("click", closeManager);
    const header = el("header", {}, el("h2", { text: tr("title") }), close);
    const textarea = el("textarea", { placeholder: tr("placeholder"), maxlength: String(MAX_LEN) });
    textarea.setAttribute("aria-label", tr("placeholder"));
    const error = el("div", { class: "error", role: "alert" });
    const submit = el("button", { class: "btn primary", type: "button", text: tr("add") });
    const cancel = el("button", { class: "btn", type: "button", text: tr("cancelEdit") });
    const counter = el("span", { class: "counter" });
    const saved = el("div", { class: "hint" });
    const list = el("ul");
    const left = el("div", { class: "card" }, el("div", { class: "label", text: tr("newLabel") }), textarea, error, el("div", { class: "row" }, submit, cancel, counter), saved, list);
    const setError = (key) => {
      error.textContent = key ? tr(key) : "";
      error.hidden = !key;
    };
    const syncCounter = () => void (counter.textContent = `${textarea.value.length}/${MAX_LEN}`);
    const stopEditing = () => {
      editing = -1;
      textarea.value = "";
      submit.textContent = tr("add");
      cancel.hidden = true;
      syncCounter();
    };
    function persist() {
      saveGreetings(greetings);
      greetings = loadGreetings();
    }
    function render() {
      saved.textContent = tr("saved", { count: greetings.length, max: MAX_COUNT });
      const current = currentIndex();
      list.replaceChildren(...greetings.map((greeting, index) => {
        const edit = el("button", { class: "icon", type: "button", title: tr("edit"), "aria-label": tr("edit"), text: "✍️" });
        const remove = el("button", { class: "icon", type: "button", title: tr("delete"), "aria-label": tr("delete"), text: "\uD83D\uDDD1️" });
        edit.addEventListener("click", () => {
          editing = index;
          textarea.value = greetings[index];
          submit.textContent = tr("saveEdit");
          cancel.hidden = false;
          setError(null);
          syncCounter();
          render();
          textarea.focus();
        });
        remove.addEventListener("click", () => {
          greetings.splice(index, 1);
          if (editing === index)
            stopEditing();
          else if (editing > index)
            editing--;
          persist();
          render();
        });
        const item = el("li", {}, el("div", { class: "text", text: greeting }), edit, remove);
        item.toggleAttribute("data-current", index === current);
        item.toggleAttribute("data-editing", index === editing);
        return item;
      }));
    }
    submit.addEventListener("click", () => {
      const problem = validateGreeting(textarea.value);
      if (problem)
        return setError(problem);
      if (editing < 0 && greetings.length >= MAX_COUNT)
        return setError("tooMany");
      const text = normalizeGreeting(textarea.value);
      if (editing >= 0)
        greetings[editing] = text;
      else
        greetings.push(text);
      setError(null);
      stopEditing();
      persist();
      render();
    });
    cancel.addEventListener("click", () => {
      stopEditing();
      setError(null);
      render();
    });
    textarea.addEventListener("input", syncCounter);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
        submit.click();
    });
    const values = rotation.get();
    const select = (key, options) => {
      const node = el("select");
      for (const [value, label] of options)
        node.append(el("option", { value, text: tr(label) }));
      node.value = values[key];
      node.addEventListener("change", () => {
        rotation.set(key, node.value);
        syncInterval();
      });
      return node;
    };
    const mode = select("mode", [["refresh", "modeRefresh"], ["interval", "modeInterval"], ["manual", "modeManual"]]);
    const order = select("order", [["sequential", "orderSequential"], ["random", "orderRandom"]]);
    const interval = el("input", { type: "number", min: "1", max: "3600", step: "1", value: String(values.intervalSec) });
    interval.addEventListener("change", () => {
      const value = Math.min(3600, Math.max(1, Math.round(Number(interval.value) || values.intervalSec)));
      interval.value = String(value);
      rotation.set("intervalSec", value);
    });
    const syncInterval = () => void (interval.disabled = mode.value !== "interval");
    const field = (label, control) => el("label", { class: "field" }, el("span", { text: tr(label) }), control);
    const right = el("div", { class: "card" }, el("div", { class: "label", text: tr("rotation") }), field("mode", mode), field("order", order), field("interval", interval), el("div", { class: "hint", text: tr("tip") }));
    const done = el("button", { class: "btn primary", type: "button", text: tr("done") });
    done.addEventListener("click", closeManager);
    dialog.append(header, el("div", { class: "body" }, left, right), el("footer", {}, done));
    stopEditing();
    setError(null);
    syncInterval();
    render();
    textarea.focus();
  }

  // src/plugins/greetingCustomizer/target.ts
  var TARGET_ATTR = "data-npp-greeting";
  var TARGET_SELECTOR = `[${TARGET_ATTR}="1"]`;
  var ORIGINAL_GREETING = "How can I help you today?";
  var FACE = "img[alt='Notion AI face'], [role='img'][aria-label='Notion AI face']";
  var CONTROL = "button, [role='button']";
  var INTERACTIVE = "button, a, input, textarea, select, [contenteditable='true'], [role='button'], [role='textbox']";
  var MAX_DEPTH = 6;
  var isHomePath = (pathname = location.pathname) => /^\/ai\/?$/.test(pathname);
  var normalize = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  function textSibling(container, branch) {
    const children = [...container.children];
    const at = children.indexOf(branch);
    const candidates = children.filter((child) => child !== branch && normalize(child.textContent) && !child.matches(INTERACTIVE) && !child.querySelector(INTERACTIVE));
    return candidates.find((child) => children.indexOf(child) > at) ?? candidates[0] ?? null;
  }
  function fromFace(scope) {
    for (const face of scope.querySelectorAll(FACE)) {
      const control = face.closest(CONTROL);
      if (!control)
        continue;
      let container = control.parentElement;
      for (let depth = 0;container && depth < MAX_DEPTH; depth++) {
        if (container !== scope && !scope.contains(container))
          break;
        const branch = [...container.children].find((child) => child === control || child.contains(control));
        const target = branch && textSibling(container, branch);
        if (target)
          return target;
        if (container === scope)
          break;
        container = container.parentElement;
      }
    }
    return null;
  }
  function fromOriginalText(scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode();node; node = walker.nextNode()) {
      if (normalize(node.nodeValue) !== ORIGINAL_GREETING)
        continue;
      let target = node.parentElement;
      while (target?.parentElement && target !== scope) {
        const parent = target.parentElement;
        if (normalize(parent.textContent) !== ORIGINAL_GREETING || parent.querySelector("button"))
          break;
        target = parent;
      }
      return target;
    }
    return null;
  }
  function findGreeting(scope = document.body) {
    if (!scope)
      return null;
    return fromFace(scope) ?? fromOriginalText(scope);
  }
  function clearMarks(except = null) {
    for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
      if (el !== except)
        el.removeAttribute(TARGET_ATTR);
    }
  }
  function syncMark() {
    if (!isHomePath()) {
      clearMarks();
      return null;
    }
    const target = findGreeting();
    clearMarks(target);
    if (target && target.getAttribute(TARGET_ATTR) !== "1")
      target.setAttribute(TARGET_ATTR, "1");
    return target;
  }

  // src/plugins/greetingCustomizer/index.ts
  var STYLE_ID2 = "notionai-pp-greeting-style";
  var RIGHT_DOUBLE_MS = 400;
  var settings3 = definePluginSettings({
    manage: {
      type: "action",
      label: "问候语列表 / Greetings",
      description: "添加、修改、删除问候语；也可在首页双击右键问候语打开 / Add, edit or delete greetings; double right-click the home greeting also opens it",
      button: "管理… / Manage…",
      run: () => openGreetingManager()
    },
    mode: {
      type: "select",
      label: "轮播方式 / Rotation",
      description: "手动模式：回到首页后点击标题即可切换；定时模式：离开首页会自动停止计时 / Manual: click the title on home; Timer: pauses when you leave home",
      default: "refresh",
      options: [
        { value: "refresh", label: "刷新/进入首页时切换 / On refresh or entering home" },
        { value: "interval", label: "按时间间隔切换 / On a timer" },
        { value: "manual", label: "点击问候语切换 / Click the greeting" }
      ]
    },
    order: {
      type: "select",
      label: "轮播顺序 / Order",
      default: "sequential",
      options: [
        { value: "sequential", label: "顺序循环 / Sequential" },
        { value: "random", label: "随机 / Random" }
      ]
    },
    intervalSec: {
      type: "number",
      label: "切换间隔（秒）/ Interval (seconds)",
      description: "仅“按时间间隔切换”时生效 / Only used by the timer mode",
      default: 10,
      min: 1,
      max: 3600
    }
  });
  var stopDom2 = null;
  var stopRoute = null;
  var timer = null;
  var wasHome = false;
  var lastRightClick = 0;
  var menuRegistered = false;
  var running = false;
  function upsertStyle(css) {
    let style = document.getElementById(STYLE_ID2);
    if (style?.textContent === css)
      return;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID2;
      (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css;
  }
  function buildCss(text, clickable) {
    const sel = TARGET_SELECTOR;
    return `
${sel} { font-size: 0 !important; line-height: 0 !important; text-align: center !important; }
${sel} > * { display: none !important; }
${sel}::after { content: "${escapeCssContent(text)}"; display: block !important; visibility: visible !important;
  font-size: 1.5rem !important; line-height: 1.35 !important; font-weight: 600 !important; color: currentColor !important;
  white-space: pre-wrap !important; text-align: center !important; width: 100% !important; margin: 0 auto !important; padding: 0 !important; }
${clickable ? `${sel} { cursor: pointer !important; user-select: none !important; }` : ""}
@media (max-width: 768px) { ${sel}::after { font-size: 1.25rem !important; line-height: 1.3 !important; } }
`;
  }
  function apply(advance = false) {
    const greetings = loadGreetings();
    const current = loadIndex();
    const index = pickIndex(greetings.length, settings3.store.order, current, advance);
    if (index !== current)
      saveIndex(index);
    const clickable = settings3.store.mode === "manual" && greetings.length > 1;
    upsertStyle(buildCss(greetings[index] ?? greetings[0], clickable));
    syncTitle();
  }
  function syncTitle() {
    const target = document.querySelector(TARGET_SELECTOR);
    if (!target)
      return;
    const want = settings3.store.mode === "manual" && loadGreetings().length > 1 ? tr("clickHint") : null;
    if (want)
      target.title = want;
    else
      target.removeAttribute("title");
  }
  function syncTimer() {
    const want = running && settings3.store.mode === "interval" && isHomePath() && loadGreetings().length > 1;
    if (!want) {
      if (timer)
        clearInterval(timer);
      timer = null;
      return;
    }
    if (timer)
      return;
    timer = setInterval(() => apply(true), settings3.store.intervalSec * 1000);
  }
  function restartTimer() {
    if (timer)
      clearInterval(timer);
    timer = null;
    syncTimer();
  }
  function check2() {
    const home = isHomePath();
    const marked = syncMark();
    if (home && !wasHome)
      apply(settings3.store.mode === "refresh");
    else if (marked)
      syncTitle();
    wasHome = home;
    syncTimer();
  }
  var targetOf = (event) => event.target?.closest?.(TARGET_SELECTOR) ?? null;
  function onClick(event) {
    if (event.button !== 0 || !targetOf(event))
      return;
    if (settings3.store.mode !== "manual" || loadGreetings().length <= 1)
      return;
    if (String(window.getSelection?.() ?? "").trim())
      return;
    apply(true);
  }
  function onContextMenu2(event) {
    if (!targetOf(event))
      return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastRightClick <= RIGHT_DOUBLE_MS) {
      lastRightClick = 0;
      openGreetingManager();
    } else {
      lastRightClick = now;
    }
  }
  function openGreetingManager() {
    openManager({
      get: () => ({ mode: settings3.store.mode, order: settings3.store.order, intervalSec: settings3.store.intervalSec }),
      set: (key, value) => void (settings3.store[key] = value)
    }, loadIndex);
  }
  var greetingCustomizer_default = definePlugin({
    name: "GreetingCustomizer",
    title: "自定义问候语",
    description: "把 Notion AI 首页的问候语换成你自己的文案：多条管理，顺序或随机轮播，刷新、定时或点击切换。在首页双击右键问候语可打开管理面板。",
    icon: Icons.smile,
    tags: ["home", "appearance"],
    enabledByDefault: true,
    settings: settings3,
    start() {
      running = true;
      wasHome = false;
      lastRightClick = 0;
      document.addEventListener("click", onClick, true);
      document.addEventListener("contextmenu", onContextMenu2, true);
      stopDom2 = onDomChange(check2);
      stopRoute = onRouteChange(check2);
      if (!menuRegistered && typeof GM_registerMenuCommand === "function") {
        menuRegistered = true;
        try {
          GM_registerMenuCommand(tr("menu"), () => openGreetingManager());
        } catch {}
      }
      check2();
    },
    stop() {
      running = false;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("contextmenu", onContextMenu2, true);
      stopDom2?.();
      stopRoute?.();
      stopDom2 = stopRoute = null;
      syncTimer();
      clearMarks();
      document.getElementById(STYLE_ID2)?.remove();
      closeManager();
    },
    onSettingsChange(key) {
      if (key === "index")
        return apply(false);
      apply(false);
      restartTimer();
    }
  });

  // src/utils/time.ts
  function debounce(fn, wait, maxWait = Infinity) {
    let timer;
    let firstAt = 0;
    const run = (...args) => {
      clearTimeout(timer);
      const now = Date.now();
      if (!firstAt)
        firstAt = now;
      const delay = Math.max(0, Math.min(wait, firstAt + maxWait - now));
      timer = setTimeout(() => {
        firstAt = 0;
        fn(...args);
      }, delay);
    };
    run.cancel = () => {
      clearTimeout(timer);
      firstAt = 0;
    };
    return run;
  }
  function frameThrottle(fn) {
    let pending = false;
    return () => {
      if (pending)
        return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        fn();
      });
    };
  }

  // src/plugins/navigator/effects.ts
  var EFFECTS = [
    { value: "none", zh: "无效果（纯平滑滚动）", en: "None (scroll only)", hint: "仅滚动 / scroll only" },
    { value: "border", zh: "高亮边框", en: "Highlight border", hint: "彩色边框，持续 2 秒 / 2 s" },
    { value: "pulse", zh: "脉冲光晕", en: "Pulse glow", hint: "边框脉冲闪烁，持续 2 秒 / 2 s" },
    { value: "fade", zh: "淡入淡出", en: "Fade", hint: "背景淡入淡出，持续 1.5 秒 / 1.5 s" },
    { value: "jiggle", zh: "经典抖动", en: "Classic jiggle", hint: "水平微抖动 / jiggle" }
  ];
  var running2 = new WeakMap;
  var KEYFRAMES = {
    border: {
      frames: [
        { outline: "2px solid rgba(255,196,0,.95)", outlineOffset: "4px", boxShadow: "0 0 0 0 rgba(255,196,0,.45)" },
        { outline: "2px solid rgba(255,196,0,.95)", outlineOffset: "4px", boxShadow: "0 0 0 12px rgba(255,196,0,0)", offset: 0.6 },
        { outline: "2px solid rgba(255,196,0,0)", outlineOffset: "4px", boxShadow: "0 0 0 12px rgba(255,196,0,0)" }
      ],
      duration: 2000
    },
    pulse: {
      frames: [
        { boxShadow: "0 0 0 0 rgba(59,130,246,.7)" },
        { boxShadow: "0 0 0 15px rgba(59,130,246,0)", offset: 0.5 },
        { boxShadow: "0 0 0 0 rgba(59,130,246,0)" }
      ],
      duration: 2000
    },
    fade: {
      frames: [
        { backgroundColor: "rgba(59,130,246,0)" },
        { backgroundColor: "rgba(59,130,246,.28)", offset: 0.5 },
        { backgroundColor: "rgba(59,130,246,0)" }
      ],
      duration: 1500
    },
    jiggle: {
      frames: [0, -3, 3, -3, 3, -3, 3, -3, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      duration: 400
    }
  };
  function playEffect(element, effect) {
    if (effect === "none" || typeof element.animate !== "function")
      return;
    running2.get(element)?.cancel();
    const { frames, duration } = KEYFRAMES[effect];
    const reduced = reducedMotion();
    const animation = element.animate(effect === "jiggle" && reduced ? KEYFRAMES.fade.frames : frames, {
      duration: reduced ? Math.min(duration, 1000) : duration,
      easing: "ease-in-out"
    });
    running2.set(element, animation);
  }
  var PREVIEW_ID = "notionai-pp-effect-preview";
  function previewEffect(effect) {
    document.getElementById(PREVIEW_ID)?.remove();
    const info = EFFECTS.find((item) => item.value === effect);
    const holder = document.createElement("div");
    holder.id = PREVIEW_ID;
    Object.assign(holder.style, {
      position: "fixed",
      left: "0",
      right: "0",
      top: "24px",
      zIndex: "2147483647",
      display: "flex",
      justifyContent: "center",
      pointerEvents: "none"
    });
    const card = document.createElement("div");
    card.textContent = info ? `${info.zh} / ${info.en}` : effect;
    Object.assign(card.style, {
      padding: "14px 22px",
      borderRadius: "10px",
      background: "#fff",
      color: "#37352f",
      font: "500 14px/1.4 ui-sans-serif, system-ui, sans-serif",
      boxShadow: "0 8px 30px rgba(0,0,0,.18)"
    });
    holder.append(card);
    document.body.append(holder);
    playEffect(card, effect);
    const duration = effect === "none" ? 600 : KEYFRAMES[effect].duration;
    setTimeout(() => holder.remove(), duration + 600);
  }

  // src/plugins/navigator/messages.ts
  var USER_STEP = "data-agent-chat-user-step-id";
  var LEAF = "[data-content-editable-leaf]";
  var TOGGLE2 = "[role='button'][aria-expanded]";
  var COPY_ASSISTANT = /\bcopy\s+(?:response|answer)\b|复制(?:回复|回答|响应)/i;
  var COPY_USER = /\bcopy\s+(?:text|message|prompt)\b|复制(?:文本|消息|提示词|问题)/i;
  var MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December";
  var DATE_RE = new RegExp(`^(?:Today|Yesterday|(?:${MONTHS})\\s+\\d{1,2}(?:,\\s*\\d{4})?(?:\\s+at\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM)?)?|\\d{1,2}:\\d{2}\\s*(?:AM|PM)?|\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}日?(?:\\s+\\d{1,2}:\\d{2})?|\\d{1,2}月\\d{1,2}日(?:\\s+\\d{1,2}:\\d{2})?|今天|昨天)$`, "i");
  var NOISE_RE = /^(?:\d+\s*steps?|thought(?:\s+for\s+.*)?|思考.*|noodling|contemplating|thinking|found\s+\d+\s+results?|searched the web|searching the web|loaded .*(?:skill|tools?)|loading web page:.*|updated to-dos|copy(?: text| response)?|undo|show changes|response copied to clipboard|copied to clipboard)$/i;
  function cleanLines(raw) {
    return raw.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line && !DATE_RE.test(line) && !NOISE_RE.test(line));
  }
  var isDateText = (text) => DATE_RE.test(text.replace(/\s+/g, " ").trim());
  function readText(element, skip = []) {
    if (!skip.length)
      return cleanLines(element.innerText ?? element.textContent ?? "").join(`
`);
    const parts = [];
    for (const child of element.children) {
      if (skip.some((node) => node === child || node.contains(child)))
        continue;
      if (skip.some((node) => child.contains(node)))
        parts.push(readText(child, skip));
      else
        parts.push(child.innerText ?? child.textContent ?? "");
    }
    return cleanLines(parts.join(`
`)).join(`
`);
  }
  function turnOf(step) {
    let turn = step;
    while (turn.parentElement && turn.parentElement !== document.body && turn.parentElement.querySelectorAll(`[${USER_STEP}]`).length === 1) {
      turn = turn.parentElement;
    }
    return turn;
  }
  function userBubble(step) {
    const leaf = step.querySelector(LEAF);
    if (!leaf)
      return step;
    let node = leaf;
    while (node.parentElement && node.parentElement !== step && !node.parentElement.querySelector("button, [role='button']")) {
      node = node.parentElement;
    }
    return node;
  }
  function userText(step) {
    const leaves = [...step.querySelectorAll(LEAF)].map((leaf) => leaf.textContent?.trim() ?? "").filter(Boolean);
    return leaves.length ? leaves.join(`
`) : readText(step);
  }
  function assistantBody(turn) {
    const toggles = turn.querySelectorAll(TOGGLE2);
    const column = toggles.length ? toggles[toggles.length - 1].parentElement?.parentElement : null;
    if (column && turn.contains(column)) {
      const bodies = [...column.children].filter((child) => child instanceof HTMLElement && !child.querySelector(TOGGLE2) && !child.matches(TOGGLE2) && readText(child).length > 1);
      if (bodies.length)
        return bodies[bodies.length - 1];
    }
    return turn;
  }
  function regionsOf(turn) {
    return [...turn.querySelectorAll(TOGGLE2)].map((toggle) => toggle.getAttribute("aria-controls")).map((id) => id ? document.getElementById(id) : null).filter((node) => !!node && turn.contains(node));
  }
  function assistantTurns(turn, turnSet) {
    const out = [];
    for (let sibling = turn.nextElementSibling;sibling && !turnSet.has(sibling); sibling = sibling.nextElementSibling) {
      if (sibling instanceof HTMLElement)
        out.push(sibling);
    }
    return out;
  }
  function pickedOption(turns) {
    for (let i = turns.length - 1;i >= 0; i--) {
      const leaves = turns[i].querySelectorAll(LEAF);
      const last = leaves[leaves.length - 1];
      if (last?.textContent?.trim())
        return last;
    }
    return null;
  }
  function fromUserSteps(root) {
    const steps = [...root.querySelectorAll(`[${USER_STEP}]`)].filter((step) => !step.parentElement?.closest(`[${USER_STEP}]`));
    if (!steps.length)
      return [];
    const turns = steps.map(turnOf);
    const turnSet = new Set(turns);
    const replies = turns.map((turn) => assistantTurns(turn, turnSet));
    const answers = steps.map((step, index) => !userText(step) && index > 0 ? pickedOption(replies[index - 1]) : null);
    const messages = [];
    steps.forEach((step, index) => {
      const id = step.getAttribute(USER_STEP) || `user-${index}`;
      const answer = answers[index];
      const text = answer?.textContent?.trim() || userText(step);
      if (text)
        messages.push({ id, role: "user", element: answer ?? userBubble(step), text });
      const nextAnswer = answers[index + 1];
      for (const sibling of replies[index]) {
        const skip = [...sibling.querySelectorAll(TOGGLE2), ...regionsOf(sibling), ...nextAnswer && sibling.contains(nextAnswer) ? [nextAnswer] : []];
        const body = assistantBody(sibling);
        const bodyText = readText(body, body === sibling ? skip : skip.filter((node) => body.contains(node)));
        const reply = bodyText || readText(sibling, skip);
        if (reply) {
          messages.push({ id: `${id}:assistant`, role: "assistant", element: body, text: reply });
          break;
        }
        const steps = [...sibling.querySelectorAll(TOGGLE2)].map((toggle) => toggle.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (steps.length) {
          messages.push({ id: `${id}:assistant`, role: "assistant", element: sibling, text: t(`回答已中断（${steps.join(" · ")}）`, `Reply interrupted (${steps.join(" · ")})`) });
          break;
        }
      }
    });
    return messages;
  }
  function copyRole(button) {
    const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.getAttribute("data-testid")].filter(Boolean).join(" ");
    if (COPY_ASSISTANT.test(label))
      return "assistant";
    if (COPY_USER.test(label))
      return "user";
    return null;
  }
  function fromCopyButtons(root) {
    const messages = [];
    const seen = new Set;
    root.querySelectorAll("button, [role='button']").forEach((button, index) => {
      if (button.closest("nav, aside, header, footer, form, pre, code"))
        return;
      const role = copyRole(button);
      if (!role)
        return;
      let target = null;
      if (role === "user") {
        for (let node = button;node && !target; node = node.parentElement) {
          const prev = node.previousElementSibling;
          if (prev instanceof HTMLElement && !prev.contains(button) && !prev.querySelector("button, [role='button']")) {
            const text = readText(prev);
            if (text.length >= 2 && !isDateText(text))
              target = prev;
          }
          if (node === document.body)
            break;
        }
      } else {
        for (let node = button.parentElement;node && node !== document.body && !target; node = node.parentElement) {
          const content = [...node.children].find((child) => !child.contains(button));
          if (!(content instanceof HTMLElement))
            continue;
          const parts = [...content.children].filter((child) => child instanceof HTMLElement && readText(child).length >= 8);
          const body = parts[parts.length - 1];
          if (body && ![...body.querySelectorAll("button, [role='button']")].some(copyRole))
            target = body;
        }
      }
      if (!target || seen.has(target))
        return;
      seen.add(target);
      const text = readText(target);
      if (text)
        messages.push({ id: `copy-${role}-${index}`, role, element: target, text });
    });
    return messages.sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  function collectMessages(root = document) {
    const primary = fromUserSteps(root);
    return primary.length ? primary : fromCopyButtons(root);
  }
  function summarize(text, max = 60) {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  var SHARED_PREFIX_MIN = 16;
  var LABEL_HEAD = 8;
  function outlineLabels(messages, max = 60) {
    const flat = messages.map((message) => message.text.replace(/\s+/g, " ").trim());
    return flat.map((text, index) => {
      let shared = 0;
      for (let j = 0;j < index; j++) {
        if (messages[j].role !== messages[index].role)
          continue;
        const other = flat[j];
        let k = 0;
        while (k < text.length && k < other.length && text[k] === other[k])
          k++;
        shared = Math.max(shared, k);
      }
      if (shared < SHARED_PREFIX_MIN || shared >= text.length)
        return summarize(text, max);
      const cut = Math.max(LABEL_HEAD, text.lastIndexOf(" ", shared) + 1);
      return summarize(`${text.slice(0, LABEL_HEAD)}… ${text.slice(cut)}`, max);
    });
  }

  // src/plugins/navigator/styles.ts
  var NAV_CSS = `
:host {
  all: initial;
  --bg: #f7f7f5; --text: #37352f; --subtle: #6b6b6b; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.06);
  --active: rgba(15,15,15,.1); --line: rgba(15,15,15,.28); --line-active: #37352f; --shadow: 0 10px 30px rgba(15,15,15,.18);
  position: fixed; top: var(--nav-top, 10rem); right: var(--nav-right, 20px); z-index: 2147483000; display: block;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:host([data-theme="dark"]) {
  --bg: #252525; --text: #ebebea; --subtle: #b4b4b0; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.08);
  --active: rgba(255,255,255,.13); --line: rgba(255,255,255,.35); --line-active: #e6e6e4; --shadow: 0 10px 30px rgba(0,0,0,.45);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.rail {
  position: absolute; top: 0; right: 0; max-height: calc(100vh - 12rem); overflow: hidden; padding: 4px 0;
  cursor: pointer; transition: opacity .2s ease;
}
.lines { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; transition: transform .2s ease; }
.line { width: 16px; height: 2px; border-radius: 2px; background: var(--line); transition: width .2s, background .2s; }
.line[data-role="assistant"] { width: 10px; opacity: .7; }
.line.active { width: 26px; background: var(--line-active); opacity: 1; box-shadow: 0 0 3px var(--line-active); }
.menu {
  position: absolute; top: -8px; right: -8px; width: 300px; max-height: calc(100vh - 12rem); overflow-y: auto; padding: 6px;
  border: 1px solid var(--border); border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  opacity: 0; visibility: hidden; transform: translateX(10px); transition: opacity .2s, visibility .2s, transform .2s;
  overscroll-behavior: contain;
}
:host(:hover) .menu, :host(:focus-within) .menu { opacity: 1; visibility: visible; transform: none; }
:host(:hover) .rail, :host(:focus-within) .rail { opacity: 0; }
.head { padding: 4px 8px 6px; color: var(--subtle); font-size: 12px; font-weight: 600; }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 1px; }
button.item {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px;
  color: var(--subtle); background: transparent; font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
button.item:hover { color: var(--text); background: var(--hover); }
button.item.active { color: var(--text); background: var(--active); font-weight: 600; }
button.item[data-role="assistant"] { padding-left: 22px; font-size: 12.5px; }
.label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mark { flex: 0 0 auto; width: 14px; text-align: center; opacity: .75; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .menu, .rail, .lines, .line { transition: none; } }
@media (max-width: 640px) { :host { top: 5rem; right: 8px; } .menu { width: min(300px, calc(100vw - 24px)); } }
`;
  var NAV_HTML = `
<nav class="root" aria-label="Chat outline">
  <div class="rail" aria-hidden="true"><div class="lines"></div></div>
  <div class="menu"><div class="head"></div><ul></ul></div>
</nav>`;

  // src/plugins/navigator/index.ts
  var NAV_HOST_ID = "notionai-pp-navigator";
  var RESCAN_MS = 250;
  var RESCAN_MAX_MS = 1200;
  var ACTIVE_RATIO = 0.4;
  var SCROLL_OFFSET = 72;
  var SETTLE_MS = 150;
  var RAIL_MARGIN = 20;
  var SIDE_PANELS = "[role='complementary'], aside";
  var settings4 = definePluginSettings({
    showAssistant: { type: "boolean", label: "目录显示 AI 回复 / Show AI replies", default: true },
    effect: {
      type: "select",
      label: "跳转定位效果 / Jump effect",
      default: "border",
      description: "选择后立即保存，点「预览」查看效果演示 / Saved on change; use Preview to see it",
      options: EFFECTS.map((effect) => ({ value: effect.value, label: `${effect.zh} / ${effect.en}（${effect.hint}）` }))
    },
    preview: {
      type: "action",
      label: "预览当前效果 / Preview effect",
      button: "预览 / Preview",
      run: () => previewEffect(settings4.store.effect)
    }
  });
  var overlay2 = null;
  var messages = [];
  var signature = "";
  var activeId = "";
  var cleanups2 = [];
  var panelObserver = null;
  var watchedPanels = new Set;
  var q = (selector) => overlay2.root.querySelector(selector);
  function visibleMessages(all) {
    return settings4.store.showAssistant ? all : all.filter((message) => message.role === "user");
  }
  function placeRail() {
    if (!overlay2)
      return;
    const { width } = viewport();
    let right = RAIL_MARGIN;
    for (const panel of [...watchedPanels])
      if (!panel.isConnected) {
        panelObserver?.unobserve(panel);
        watchedPanels.delete(panel);
      }
    for (const panel of document.querySelectorAll(SIDE_PANELS)) {
      if (overlay2.host.contains(panel))
        continue;
      if (panelObserver && !watchedPanels.has(panel)) {
        watchedPanels.add(panel);
        panelObserver.observe(panel);
      }
      const box = visibleBox(panel);
      if (!box || box.left < width / 2 || box.right < width - 80 || box.height < 120)
        continue;
      right = Math.max(right, Math.round(width - box.left + RAIL_MARGIN));
    }
    overlay2.host.style.setProperty("--nav-right", `${right}px`);
  }
  function build() {
    if (!overlay2)
      return;
    placeRail();
    const next = isAiRoute() ? visibleMessages(collectMessages()) : [];
    const nextSignature = next.map((m) => `${m.id}\x01${summarize(m.text)}`).join("\x02");
    const sameElements = next.length === messages.length && next.every((m, i) => m.element === messages[i].element);
    messages = next;
    overlay2.host.hidden = !next.length;
    if (nextSignature === signature) {
      if (!sameElements)
        updateActive();
      return;
    }
    signature = nextSignature;
    q(".head").textContent = t(`对话目录 · ${next.filter((m) => m.role === "user").length} 问`, `Outline · ${next.filter((m) => m.role === "user").length} prompts`);
    q(".lines").replaceChildren(...next.map((message) => {
      const line = document.createElement("div");
      line.className = "line";
      line.dataset.id = message.id;
      line.dataset.role = message.role;
      return line;
    }));
    const labels = outlineLabels(next);
    q("ul").replaceChildren(...next.map((message, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "item";
      button.dataset.id = message.id;
      button.dataset.role = message.role;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = message.role === "user" ? "❓" : "\uD83E\uDD16";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = labels[index];
      button.title = summarize(message.text, 400);
      button.append(mark, label);
      button.addEventListener("click", () => jump(message.id));
      const item = document.createElement("li");
      item.append(button);
      return item;
    }));
    activeId = "";
    updateActive();
  }
  function setActive(id) {
    if (!overlay2 || id === activeId)
      return;
    activeId = id;
    for (const node of overlay2.root.querySelectorAll("[data-id]"))
      node.classList.toggle("active", node.dataset.id === id);
    const lines = q(".lines");
    const rail = q(".rail");
    const line = lines.querySelector(".line.active");
    if (!line)
      return;
    const overflow = lines.scrollHeight - rail.clientHeight;
    const offset = overflow > 0 ? Math.min(overflow, Math.max(0, line.offsetTop - rail.clientHeight / 2)) : 0;
    lines.style.transform = `translateY(${-offset}px)`;
    const item = overlay2.root.querySelector(`button.item.active`);
    item?.scrollIntoView({ block: "nearest" });
  }
  function updateActive() {
    if (!messages.length)
      return;
    const threshold = window.innerHeight * ACTIVE_RATIO;
    let current = messages[0].id;
    for (const message of messages) {
      if (!message.element.isConnected)
        continue;
      if (message.element.getBoundingClientRect().top < threshold)
        current = message.id;
      else
        break;
    }
    setActive(current);
  }
  function jump(id) {
    const message = messages.find((m) => m.id === id);
    if (!message?.element.isConnected)
      return;
    const target = message.element;
    const scroller = scrollParentOf(target);
    const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
    const top = target.getBoundingClientRect().top - (isRoot ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop - SCROLL_OFFSET;
    setActive(id);
    let timer = 0;
    const settle = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        (isRoot ? window : scroller).removeEventListener("scroll", settle);
        playEffect(target, settings4.store.effect);
      }, SETTLE_MS);
    };
    (isRoot ? window : scroller).addEventListener("scroll", settle, { passive: true });
    scroller.scrollTo({ top, behavior: "smooth" });
    settle();
  }
  var navigator_default = definePlugin({
    name: "chatNavigator",
    title: "对话目录 / Chat navigator",
    description: "在 Notion AI 对话右侧显示 Notion 风格目录，悬停展开，点击跳到对应提问或回复。",
    icon: Icons.list,
    tags: ["chat"],
    enabledByDefault: true,
    settings: settings4,
    start() {
      overlay2 = createOverlay(NAV_HOST_ID, NAV_CSS, NAV_HTML);
      overlay2.host.hidden = true;
      const rescan = debounce(build, RESCAN_MS, RESCAN_MAX_MS);
      const onScroll = frameThrottle(updateActive);
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      const onResize = frameThrottle(() => {
        placeRail();
        updateActive();
      });
      window.addEventListener("resize", onResize, { passive: true });
      const onLayout = frameThrottle(placeRail);
      if (typeof ResizeObserver === "function") {
        panelObserver = new ResizeObserver(onLayout);
        panelObserver.observe(document.documentElement);
      }
      document.addEventListener("transitionend", onLayout, { capture: true, passive: true });
      document.addEventListener("animationend", onLayout, { capture: true, passive: true });
      cleanups2 = [
        onDomChange(onLayout),
        onDomChange(rescan),
        () => document.removeEventListener("transitionend", onLayout, { capture: true }),
        () => document.removeEventListener("animationend", onLayout, { capture: true }),
        () => {
          panelObserver?.disconnect();
          panelObserver = null;
          watchedPanels.clear();
        },
        onRouteChange(() => {
          signature = "";
          rescan();
        }),
        () => rescan.cancel(),
        () => window.removeEventListener("scroll", onScroll, { capture: true }),
        () => window.removeEventListener("resize", onResize)
      ];
      build();
    },
    stop() {
      for (const cleanup of cleanups2.splice(0))
        cleanup();
      overlay2?.destroy();
      overlay2 = null;
      messages = [];
      signature = "";
      activeId = "";
    },
    onSettingsChange() {
      signature = "";
      build();
    }
  });

  // src/api/Events.ts
  var handlers = new Map;
  function on(event, handler) {
    if (!handlers.has(event))
      handlers.set(event, new Set);
    handlers.get(event).add(handler);
    return () => void handlers.get(event)?.delete(handler);
  }
  function emit(event, payload) {
    for (const handler of [...handlers.get(event) ?? []])
      handler(payload);
  }

  // src/plugins/settings/styles.ts
  var CSS2 = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;
  --surface-base: #ffffff; --surface-l1: #ffffff; --surface-l2: #f7f7f5; --surface-hover: rgba(55,53,47,.06);
  --border-l1: rgba(55,53,47,.09); --border-l2: rgba(55,53,47,.16);
  --fg-primary: #37352f; --fg-secondary: #787774; --fg-tertiary: #a5a29a; --fg-invert: #ffffff;
  --fg-danger: #e03e3e; --fg-warning: #d9730d; --overlay: rgba(15,15,15,.45); --shadow: 0 16px 48px rgba(15,15,15,.2);
  color-scheme: light;
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg-primary); }
:host([data-theme="dark"]) {
  --surface-base: #191919; --surface-l1: #202020; --surface-l2: #252525; --surface-hover: rgba(255,255,255,.055);
  --border-l1: rgba(255,255,255,.08); --border-l2: rgba(255,255,255,.14);
  --fg-primary: #ebebea; --fg-secondary: #9b9b9b; --fg-tertiary: #6e6e6e; --fg-invert: #191919;
  --fg-danger: #ff7369; --overlay: rgba(0,0,0,.6); --shadow: 0 16px 48px rgba(0,0,0,.5);
  color-scheme: dark; }
* { box-sizing: border-box; }
svg { width: 1rem; height: 1rem; flex-shrink: 0; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--fg-primary) 55%, transparent); outline-offset: 1px; }

.layer { position: fixed; inset: 0; display: grid; place-items: center; padding: 1rem; }
.layer-root { background: var(--overlay); }
.layer-nested { background: transparent; }
.layer-confirm { background: color-mix(in srgb, var(--overlay) 60%, transparent); }

/* Buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: .375rem; height: 2rem; padding: 0 .875rem;
  border-radius: .625rem; border: 1px solid transparent; font-size: .8125rem; font-weight: 500; cursor: pointer; white-space: nowrap;
  transition: background-color .12s, border-color .12s, color .12s; }
.btn:disabled { opacity: .5; cursor: default; }
.btn-primary { background: var(--fg-primary); color: var(--fg-invert); }
.btn-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--fg-primary) 86%, var(--surface-base)); }
.btn-secondary { background: var(--surface-l1); border-color: var(--border-l2); }
.btn-secondary:hover:not(:disabled) { background: var(--surface-hover); }
.btn-tertiary { background: transparent; }
.btn-tertiary:hover:not(:disabled) { background: var(--surface-hover); }
.btn-danger { background: var(--fg-danger); color: #fff; }
.btn-danger:hover { background: color-mix(in srgb, var(--fg-danger) 85%, #000); }
.btn-square { width: 2rem; padding: 0; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 1.75rem; height: 1.75rem; padding: 0;
  border: 0; border-radius: .5rem; background: transparent; color: var(--fg-tertiary); cursor: pointer; }
.icon-btn:hover { background: var(--surface-hover); color: var(--fg-primary); }
.icon-btn.active { color: var(--fg-primary); }
.icon-btn svg { width: .9375rem; height: .9375rem; }

/* Switch (Grok/Void++ SettingsSwitch) */
.switch { position: relative; flex-shrink: 0; width: 2.25rem; height: 1.25rem; margin: 0; padding: 0; border: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--fg-primary) 22%, transparent); cursor: pointer; transition: background-color .15s; }
.switch::after { content: ""; position: absolute; top: .125rem; left: .125rem; width: 1rem; height: 1rem; border-radius: 50%;
  background: var(--surface-base); box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s; }
.switch[aria-checked="true"] { background: var(--fg-primary); }
.switch[aria-checked="true"]::after { transform: translateX(1rem); }
.switch:disabled { cursor: default; opacity: .6; }

/* Inputs */
.input, .select { height: 2.25rem; border-radius: .75rem; border: 1px solid var(--border-l2); background: var(--surface-l1);
  color: var(--fg-primary); font: inherit; font-size: .875rem; padding: 0 .75rem; }
.input::placeholder { color: var(--fg-tertiary); }
.input:focus, .select:focus { outline: none; border-color: color-mix(in srgb, var(--fg-primary) 45%, transparent); }
.select { appearance: none; padding-right: 2rem; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--fg-secondary) 50%), linear-gradient(135deg, var(--fg-secondary) 50%, transparent 50%);
  background-position: calc(100% - 1rem) 52%, calc(100% - .7rem) 52%; background-size: .3rem .3rem; background-repeat: no-repeat; }
.select option { background: var(--surface-l1); color: var(--fg-primary); }

/* Main dialog: nav + content */
.dialog { position: relative; display: flex; width: min(56rem, calc(100vw - 2rem)); height: min(40rem, calc(100vh - 2rem));
  border-radius: 1rem; border: 1px solid var(--border-l1); background: var(--surface-l1); box-shadow: var(--shadow); overflow: hidden; }
.nav { position: relative; flex: 0 0 13rem; display: flex; flex-direction: column; gap: .125rem; padding: 1rem .75rem;
  background: var(--surface-l2); border-right: 1px solid var(--border-l1); }
.nav-group { padding: .25rem .5rem .375rem; font-size: .75rem; font-weight: 500; color: var(--fg-tertiary); }
.nav-item { display: flex; align-items: center; gap: .5rem; height: 2rem; padding: 0 .625rem; border: 0; border-radius: .5rem;
  background: transparent; color: var(--fg-secondary); font-size: .875rem; text-align: left; cursor: pointer; }
.nav-item:hover { background: var(--surface-hover); color: var(--fg-primary); }
.nav-item[aria-current="page"] { background: var(--surface-hover); color: var(--fg-primary); font-weight: 500; }
.version { position: absolute; left: 0; right: 0; bottom: 0; padding: .75rem; font-size: .625rem; line-height: 1rem;
  color: var(--fg-secondary); opacity: .45; user-select: text; }
.version a { color: inherit; text-decoration: none; } .version a:hover { text-decoration: underline; }
.content { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; padding-top: 1.25rem; }
.content-head { display: flex; align-items: center; gap: .375rem; padding: 0 3.5rem 0 1.25rem; margin-bottom: 1rem; }
.content-head h2 { margin: 0; font-size: 1.125rem; font-weight: 600; }
.hint { display: inline-flex; color: var(--fg-tertiary); cursor: help; }
.hint svg { width: .875rem; height: .875rem; }
.close { position: absolute; top: 1rem; right: 1rem; z-index: 2; color: var(--fg-secondary); }
.tab-root { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 1rem; padding: 0 1.25rem; }

/* Plugins tab */
.tabs { display: flex; flex-wrap: wrap; gap: .125rem; border-bottom: 1px solid var(--border-l1); }
.tab { position: relative; height: 2rem; padding: 0 .75rem; border: 0; border-radius: .5rem .5rem 0 0; background: transparent;
  color: var(--fg-secondary); font-size: .8125rem; font-weight: 500; cursor: pointer; }
.tab:hover { color: var(--fg-primary); }
.tab.active { color: var(--fg-primary); }
.tab.active::after { content: ""; position: absolute; inset-inline: .5rem; bottom: -1px; height: 2px; border-radius: 1px; background: var(--fg-primary); }
.search-bar { display: flex; align-items: center; gap: .75rem; }
.search-bar .input { flex: 1; min-width: 0; }
.search-bar .select { width: 7.5rem; }
.list { flex: 1; min-height: 0; overflow-y: auto; margin-inline: -1.25rem; padding: .25rem 1.25rem 2rem; display: flex; flex-direction: column; gap: 1rem;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 .75rem, #000 calc(100% - 1.5rem), transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 .75rem, #000 calc(100% - 1.5rem), transparent); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
.separator { height: 1px; flex-shrink: 0; background: var(--border-l1); }
.empty { padding: 2rem 0; text-align: center; color: var(--fg-secondary); }
@media (max-width: 40rem) { .grid { grid-template-columns: minmax(0, 1fr); } .nav { display: none; } }

/* Plugin card (Void++ BaseCard) */
.card { contain: content; display: flex; flex-direction: column; min-width: 0; min-height: 7.5rem; border-radius: .5rem;
  border: 1px solid var(--border-l1); background: var(--surface-l1); overflow: hidden; }
.card.required { opacity: .4; }
.card.crashed { opacity: .5; border-color: color-mix(in srgb, var(--fg-danger) 45%, transparent); }
.card-body { flex: 1; display: flex; flex-direction: column; gap: .25rem; padding: .625rem .75rem; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.card-name { display: flex; align-items: center; gap: .375rem; flex: 1; min-width: 0; overflow: hidden; }
.card-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 1.5rem; height: 1.5rem;
  border-radius: .5rem; color: var(--fg-primary); background: color-mix(in srgb, var(--fg-primary) 10%, transparent); }
.card-icon svg { width: .875rem; height: .875rem; }
.card-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .875rem; font-weight: 500; }
.badge { display: inline-flex; color: var(--fg-tertiary); } .badge svg { width: .8125rem; height: .8125rem; }
.badge.danger { color: var(--fg-danger); }
.card-controls { display: flex; align-items: center; gap: .25rem; flex-shrink: 0; }
.card-controls .switch { margin-left: .25rem; }
.card-desc { margin-top: .25rem; font-size: .8125rem; line-height: 1.5; color: var(--fg-secondary); display: -webkit-box;
  -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-footer { display: flex; align-items: center; gap: .375rem; padding: .375rem .75rem; border-top: 1px solid var(--border-l1);
  font-size: .7rem; color: var(--fg-tertiary); min-width: 0; }
.card-footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Nested dialogs (Void++ VoidPPDialogShell) */
.sheet { position: relative; display: flex; flex-direction: column; gap: 1rem; width: min(32rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem); padding: 1.5rem; border-radius: 1rem; border: 1px solid var(--border-l1);
  background: var(--surface-l1); box-shadow: var(--shadow); overflow: hidden; }
.sheet-sm { width: min(28rem, calc(100vw - 2rem)); }
.sheet-head { padding-right: 2.5rem; }
.sheet-title { margin: 0; font-size: 1.125rem; font-weight: 600; line-height: 1.5rem; }
.sheet-desc { margin: .375rem 0 0; font-size: .875rem; color: var(--fg-secondary); }
.field { display: flex; flex-direction: column; gap: .25rem; min-height: 0; }
.field-label { font-size: .875rem; font-weight: 500; }
.field-text { margin: 0; font-size: .875rem; color: var(--fg-secondary); }
.settings-list { display: flex; flex-direction: column; gap: .75rem; min-height: 0; overflow-y: auto; padding: .25rem 0; }
.settings-list[data-off] { opacity: .55; }
.footer { display: flex; justify-content: flex-end; gap: .5rem; margin-top: auto; }

/* Setting rows (Grok SettingsRow / Void++ SettingField) */
.row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.row-body { flex: 1; min-width: 8rem; display: flex; flex-direction: column; }
.stack { display: flex; flex-direction: column; gap: .5rem; }
.s-title { font-size: .875rem; font-weight: 500; line-height: 1.25rem; color: var(--fg-primary); }
.s-desc { font-size: .75rem; line-height: 1rem; color: var(--fg-secondary); }
.color { display: flex; align-items: center; gap: .5rem; }
.color input { width: 2rem; height: 2rem; padding: .125rem; border: 1px solid var(--border-l2); border-radius: .5rem; background: transparent; cursor: pointer; }
.color input::-webkit-color-swatch-wrapper { padding: 0; } .color input::-webkit-color-swatch { border: 0; border-radius: .375rem; }
.color input::-moz-color-swatch { border: 0; border-radius: .375rem; }
.color-value { min-width: 4.5rem; font-size: .875rem; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
.number { width: 6rem; }
.row .select { flex: 0 1 auto; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dialog:focus, .sheet:focus { outline: none; }

/* About tab */
.about { display: flex; flex-direction: column; gap: .75rem; overflow-y: auto; padding-bottom: 1.5rem; }
.about p { margin: 0; color: var(--fg-secondary); font-size: .875rem; line-height: 1.6; }
.about a { color: var(--fg-primary); }
`;

  // src/plugins/settings/index.ts
  var SETTINGS_HOST_ID = "notionai-pp-settings";
  var SELF = "settings";
  var REPO_URL = "https://github.com/0-V-linuxdo/NotionPP";
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false)
        continue;
      if (key === "class")
        node.className = String(value);
      else if (key.startsWith("on") && typeof value === "function")
        node.addEventListener(key.slice(2), value);
      else if (key in node && !key.includes("-"))
        node[key] = value;
      else
        node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children)
      if (child != null && child !== false)
        node.append(child);
    return node;
  }
  var option = (value, text, selected = false) => h("option", { value, selected }, text);
  var icon = (markup, filled = false) => svgIcon(markup, filled);
  function button(variant, label, onclick, extra = "") {
    return h("button", { type: "button", class: `btn btn-${variant} ${extra}`.trim(), onclick }, label);
  }
  function iconButton(markup, label, onclick, { active = false, filled = false } = {}) {
    return h("button", { type: "button", class: active ? "icon-btn active" : "icon-btn", title: label, "aria-label": label, onclick }, icon(markup, filled));
  }
  function switchControl(checked, label, onChange, disabled = false) {
    const el = h("button", { type: "button", role: "switch", class: "switch", "aria-label": label, disabled });
    el.setAttribute("aria-checked", String(checked));
    el.addEventListener("click", () => {
      const next = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", String(next));
      onChange(next);
    });
    return el;
  }
  function readList(key) {
    const raw = getValue(SELF, key);
    return typeof raw === "string" && raw ? raw.split(",") : [];
  }
  function toggleInList(key, name) {
    const list = readList(key);
    const next = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
    setValue(SELF, key, next.join(","));
  }
  var CATEGORY_LABELS = {
    favorites: () => t("收藏", "Favorites"),
    all: () => t("全部", "All"),
    composer: () => t("输入框", "Composer"),
    chat: () => t("对话", "Chat"),
    home: () => t("首页", "Home"),
    appearance: () => t("外观", "Appearance")
  };
  var overlay3 = null;
  var layers = [];
  var cleanups3 = [];
  var settingKeys = (plugin) => Object.entries(plugin.settings?.def ?? {});
  var hasSettings = (plugin) => settingKeys(plugin).length > 0;
  function pushLayer(kind, content, onClose) {
    const el = h("div", { class: `layer layer-${kind}` }, content);
    const entry = {
      el,
      close() {
        const index = layers.indexOf(entry);
        if (index >= 0)
          layers.splice(index, 1);
        el.remove();
        onClose?.();
      }
    };
    el.addEventListener("mousedown", (event) => event.target === el && entry.close());
    overlay3.root.append(el);
    layers.push(entry);
    return entry;
  }
  function sheet(title, subtitle, onClose, size = "md") {
    const node = h("div", { class: size === "sm" ? "sheet sheet-sm" : "sheet", role: "dialog", "aria-modal": "true" }, h("div", { class: "sheet-head" }, h("h3", { class: "sheet-title" }, title), subtitle && h("p", { class: "sheet-desc" }, subtitle)));
    const close = iconButton(Icons.x, t("关闭", "Close"), onClose);
    close.classList.add("close");
    node.prepend(close);
    return node;
  }
  function confirmDialog(title, description, confirmText, onConfirm) {
    let layer;
    const node = sheet(title, description, () => layer.close(), "sm");
    const cancel = button("secondary", t("取消", "Cancel"), () => layer.close());
    node.append(h("div", { class: "footer" }, cancel, button("danger", confirmText, () => {
      layer.close();
      onConfirm();
    })));
    layer = pushLayer("confirm", node);
    node.tabIndex = -1;
    node.focus();
  }
  function label(def) {
    return h("div", { class: "row-body" }, h("div", { class: "s-title" }, def.label), def.description && h("div", { class: "s-desc" }, def.description));
  }
  function settingField(plugin, key, def) {
    const store = plugin.settings.store;
    const set = (value) => setValue(plugin.name, key, value);
    switch (def.type) {
      case "boolean":
        return h("div", { class: "row" }, label(def), switchControl(Boolean(store[key]), def.label, set));
      case "select": {
        const select = h("select", { class: "select", "aria-label": def.label, onchange: () => set(select.value) });
        for (const o of def.options)
          select.append(option(o.value, o.label, store[key] === o.value));
        return h("div", { class: "row" }, label(def), select);
      }
      case "color": {
        const value = h("span", { class: "color-value" }, String(store[key]));
        const input = h("input", { type: "color", value: String(store[key]), "aria-label": def.label });
        input.addEventListener("input", () => {
          value.textContent = input.value.toLowerCase();
          set(input.value.toLowerCase());
        });
        return h("div", { class: "row" }, label(def), h("div", { class: "color" }, input, value));
      }
      case "number": {
        const input = h("input", { type: "number", class: "input number", min: String(def.min), max: String(def.max), step: "1", value: String(store[key]), "aria-label": def.label });
        input.addEventListener("change", () => {
          const value = Math.min(def.max, Math.max(def.min, Math.round(Number(input.value) || def.default)));
          input.value = String(value);
          set(value);
        });
        return h("div", { class: "stack" }, label(def), input);
      }
      case "action":
        return h("div", { class: "row" }, label(def), button("secondary", def.button, () => def.run()));
    }
  }
  function openPluginDialog(plugin) {
    let layer;
    const node = sheet(plugin.title, plugin.description, () => layer.close());
    const entries = settingKeys(plugin);
    const list = h("div", { class: "settings-list" });
    const render = () => {
      list.replaceChildren(...entries.map(([key, def]) => settingField(plugin, key, def)));
      list.toggleAttribute("data-off", !isEnabled(plugin));
    };
    render();
    node.append(h("div", { class: "separator" }));
    node.append(h("div", { class: "field" }, h("div", { class: "field-label" }, t("设置", "Settings")), entries.length ? list : h("p", { class: "field-text" }, t("没有可配置的选项。", "No configurable settings."))));
    const storable = entries.filter(([, def]) => def.type !== "action").map(([key]) => key);
    if (storable.length) {
      node.append(h("div", { class: "footer" }, button("secondary", t("恢复默认", "Reset"), () => confirmDialog(t("恢复默认设置", "Reset settings"), t("把这个插件的设置恢复为默认值？此操作无法撤销。", "Reset this plugin's settings to defaults? This cannot be undone."), t("恢复默认", "Reset"), () => {
        resetValues(plugin.name, storable);
        render();
      }))));
    }
    layer = pushLayer("nested", node);
    node.tabIndex = -1;
    node.focus();
  }
  function pluginCard(plugin, refresh) {
    const enabled = isEnabled(plugin);
    const starred = readList("starred").includes(plugin.name);
    const pinned = readList("pinned").includes(plugin.name);
    const crashed = enabled && !plugin.started && !plugin.required;
    const cls = ["card", plugin.required && "required", crashed && "crashed"].filter(Boolean).join(" ");
    const controls = h("div", { class: "card-controls" }, iconButton(Icons.star, starred ? t("取消收藏", "Remove from favorites") : t("收藏", "Add to favorites"), () => {
      toggleInList("starred", plugin.name);
      refresh();
    }, { active: starred, filled: starred }), !plugin.required && iconButton(Icons.pin, pinned ? t("取消置顶", "Unpin from top") : t("置顶", "Pin to top"), () => {
      toggleInList("pinned", plugin.name);
      refresh();
    }, { active: pinned, filled: pinned }), hasSettings(plugin) && iconButton(Icons.sliders, t("配置", "Configure"), () => openPluginDialog(plugin)), switchControl(enabled, plugin.title, (value) => {
      setEnabled(plugin, value);
      refresh();
    }, plugin.required));
    return h("div", { class: cls, "data-plugin": plugin.name }, h("div", { class: "card-body" }, h("div", { class: "card-head" }, h("div", { class: "card-name" }, h("span", { class: "card-icon" }, icon(plugin.icon ?? Icons.plug)), h("span", { class: "card-title", title: plugin.title }, plugin.title), crashed && h("span", { class: "badge danger", title: t("此插件启动失败", "This plugin failed to start") }, icon(Icons.alert)), plugin.required && h("span", { class: "badge", title: t("NotionAI++ 运行必需", "Required for NotionAI++ to work") }, icon(Icons.lock))), controls), h("div", { class: "card-desc", title: plugin.description }, plugin.description)), h("div", { class: "card-footer" }, h("span", {}, plugin.name)));
  }
  function pluginsTab() {
    const all = allPlugins().slice().sort((a, b) => a.title.localeCompare(b.title));
    const user = all.filter((p) => !p.required);
    const required = all.filter((p) => p.required);
    const state = { category: readList("starred").length ? "favorites" : "all", search: "", filter: "all" };
    const categories = Object.keys(CATEGORY_LABELS).filter((c) => c === "favorites" || c === "all" || all.some((p) => p.tags?.includes(c)));
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const search = h("input", { type: "search", class: "input", "aria-label": t("搜索插件", "Search plugins") });
    const filter = h("select", { class: "select", "aria-label": t("筛选", "Filter") });
    for (const [value, text] of [["all", t("全部", "All")], ["enabled", t("已启用", "Enabled")], ["disabled", t("已禁用", "Disabled")]])
      filter.append(option(value, text));
    const list = h("div", { class: "list" });
    const matches = (p) => {
      if (state.filter !== "all" && isEnabled(p) !== (state.filter === "enabled"))
        return false;
      const q = state.search.trim().toLowerCase();
      return !q || `${p.title} ${p.name} ${p.description}`.toLowerCase().includes(q);
    };
    const render = () => {
      tabs.replaceChildren(...categories.map((c) => h("button", {
        type: "button",
        role: "tab",
        class: c === state.category ? "tab active" : "tab",
        "aria-selected": String(c === state.category),
        onclick: () => {
          state.category = c;
          render();
        }
      }, CATEGORY_LABELS[c]())));
      const starred = readList("starred");
      const pinned = readList("pinned");
      let top;
      let bottom = [];
      if (state.category === "favorites")
        top = all.filter((p) => starred.includes(p.name));
      else if (state.category === "all") {
        top = user;
        bottom = required;
      } else
        top = all.filter((p) => p.tags?.includes(state.category));
      top = top.filter(matches);
      bottom = bottom.filter(matches);
      if (state.category !== "favorites") {
        const rank = (p) => pinned.includes(p.name) ? pinned.indexOf(p.name) : Infinity;
        top = top.slice().sort((a, b) => rank(a) - rank(b));
      }
      search.placeholder = t(`搜索 ${user.length + required.length} 个插件…`, `Search ${user.length + required.length} plugins...`);
      const grid = (items) => h("div", { class: "grid" }, ...items.map((p) => pluginCard(p, render)));
      const children = [];
      if (top.length)
        children.push(grid(top));
      if (bottom.length)
        children.push(h("div", { class: "separator" }), grid(bottom));
      if (!children.length) {
        children.push(h("p", { class: "empty" }, state.search ? t("没有匹配的插件。", "No plugins match your search.") : state.category === "favorites" ? t("还没有收藏。点星标即可收藏插件。", "No favorites yet. Star a plugin to see it here.") : t("没有插件。", "No plugins available.")));
      }
      list.replaceChildren(...children);
    };
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });
    filter.addEventListener("change", () => {
      state.filter = filter.value;
      render();
    });
    render();
    return h("div", { class: "tab-root" }, tabs, h("div", { class: "search-bar" }, search, filter), list);
  }
  function aboutTab() {
    const version = "[20261007] v1.1.4";
    return h("div", { class: "tab-root about" }, h("p", {}, t("NotionAI++ 是 Notion AI 的增强用户脚本：用量贴在 AI 输入框上，对话目录，以及更多小插件。", "NotionAI++ is a userscript for Notion AI: a usage meter docked to the AI composer, a chat outline and more.")), h("p", {}, t("只发同源请求，不读取 Cookie、token 或 Authorization；设置只保存在本机浏览器。", "Only same-origin requests; never reads cookies, tokens or Authorization. Settings stay in this browser.")), h("p", {}, `${t("版本", "Version")} ${version} · `, h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "GitHub")));
  }
  var TABS = [
    { id: "plugins", icon: Icons.plug, title: () => t("插件", "Plugins"), hint: () => t("开关各项功能；点滑杆图标进行配置。", "Toggle features. Click the sliders icon to configure."), render: pluginsTab },
    { id: "about", icon: Icons.info, title: () => t("关于", "About"), hint: () => "", render: aboutTab }
  ];
  function close() {
    for (const layer of layers.splice(0))
      layer.el.remove();
    overlay3?.destroy();
    overlay3 = null;
  }
  function openSettings(tab = "plugins") {
    close();
    overlay3 = createOverlay(SETTINGS_HOST_ID, CSS2, "");
    const { root } = overlay3;
    const content = h("div", { class: "content" });
    const navItems = new Map;
    const select = (id) => {
      const def = TABS.find((t) => t.id === id) ?? TABS[0];
      for (const [key, item] of navItems) {
        if (key === def.id)
          item.setAttribute("aria-current", "page");
        else
          item.removeAttribute("aria-current");
      }
      const hint = def.hint();
      const closeBtn = iconButton(Icons.x, t("关闭", "Close"), close);
      closeBtn.classList.add("close");
      content.replaceChildren(closeBtn, h("div", { class: "content-head" }, h("h2", {}, def.title()), hint && h("span", { class: "hint", title: hint }, icon(Icons.info))), def.render());
    };
    const version = "[20261007] v1.1.4";
    const nav = h("nav", { class: "nav" }, h("div", { class: "nav-group" }, "NotionAI++"), ...TABS.map((def) => {
      const item = h("button", { type: "button", class: "nav-item", onclick: () => select(def.id) }, icon(def.icon), def.title());
      navItems.set(def.id, item);
      return item;
    }), h("div", { class: "version" }, h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "NotionAI++"), version && ` · ${version}`, h("br"), t("用户脚本", "Userscript")));
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": t("NotionAI++ 设置", "NotionAI++ settings") }, nav, content);
    const backdrop = h("div", { class: "layer layer-root" }, dialog);
    backdrop.addEventListener("mousedown", (event) => event.target === backdrop && close());
    root.append(backdrop);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape")
        return;
      event.stopPropagation();
      const top = layers.at(-1);
      if (top)
        top.close();
      else
        close();
    });
    select(tab);
    dialog.tabIndex = -1;
    dialog.focus();
  }
  var settings_default = definePlugin({
    name: SELF,
    title: "设置面板 / Settings",
    description: "NotionAI++ 设置面板与脚本管理器菜单命令。",
    icon: Icons.cog,
    enabledByDefault: true,
    required: true,
    start() {
      cleanups3.push(on("openSettings", () => openSettings()));
      if (typeof GM_registerMenuCommand === "function") {
        try {
          GM_registerMenuCommand(t("⚙️ NotionAI++ 设置", "⚙️ NotionAI++ settings"), () => openSettings());
        } catch {}
      }
    },
    stop() {
      for (const cleanup of cleanups3.splice(0))
        cleanup();
      close();
    }
  });

  // src/plugins/usage/billing.ts
  var PRODUCT_RANK = new Map([
    ["free", 0],
    ["student", 1],
    ["personal", 2],
    ["plus", 3],
    ["business", 4],
    ["enterprise", 5],
    ["enterprise_limited", 5]
  ]);
  var STATUSES = new Set(["active", "trialing", "past_due", "unpaid", "paused", "canceled", "incomplete", "incomplete_expired"]);
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
  var DAY_MS = 86400000;
  var MAX_TRIAL_MS = 2 * 366 * DAY_MS;
  var MAX_ITEMS = 80;
  function parseIso(value) {
    if (typeof value !== "string" || value.length < 20 || value.length > 80 || !ISO_RE.test(value))
      return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  var items = (value) => Array.isArray(value) ? value.slice(0, MAX_ITEMS) : isRecord(value) ? Object.values(value).slice(0, MAX_ITEMS) : [];
  var productOf = (item) => isRecord(item) && isRecord(item.price) && typeof item.price.product === "string" ? item.price.product : null;
  function topProduct(list) {
    let best = null;
    for (const product of list.map(productOf)) {
      if (product && PRODUCT_RANK.has(product) && (best === null || PRODUCT_RANK.get(product) > PRODUCT_RANK.get(best)))
        best = product;
    }
    return best;
  }
  var hasUnknownProduct = (list) => list.some((item) => {
    const product = productOf(item);
    return product !== null && !PRODUCT_RANK.has(product);
  });
  function planOf(product) {
    switch (product) {
      case "free":
        return "free";
      case "student":
      case "personal":
      case "plus":
        return "plus";
      case "business":
        return "business";
      case "enterprise":
      case "enterprise_limited":
        return "enterprise";
      default:
        return "unknown";
    }
  }
  function billingDataOf(payload) {
    if (!isRecord(payload))
      return null;
    if (isRecord(payload.billingData))
      return payload.billingData;
    return isRecord(payload.data) && isRecord(payload.data.billingData) ? payload.data.billingData : null;
  }
  function parseBilling(payload, now = Date.now()) {
    const data = billingDataOf(payload);
    if (!data)
      return null;
    const subscription = isRecord(data.subscription) ? data.subscription : null;
    const trial = isRecord(data.trial) ? data.trial : null;
    const subTrialEnd = typeof subscription?.trialEnd === "string";
    const sepTrialEnd = typeof trial?.endDate === "string";
    if (subTrialEnd && sepTrialEnd)
      return null;
    const serverNowAt = isRecord(data.clock) && data.clock.externalId ? parseIso(data.clock.now) : null;
    const reference = serverNowAt ?? now;
    if (subTrialEnd || sepTrialEnd) {
      const source = subTrialEnd ? subscription : trial;
      const endAt = parseIso(subTrialEnd ? source.trialEnd : source.endDate);
      const startRaw = source.startDate;
      const startAt = parseIso(startRaw);
      if (endAt === null)
        return null;
      if (typeof startRaw === "string" && (startAt === null || startAt > endAt))
        return null;
      if (endAt - reference > MAX_TRIAL_MS)
        return null;
      const list = items(source.items);
      const product = topProduct(list);
      if (endAt > reference && product === "business") {
        return {
          kind: "trial",
          plan: "business",
          startAt,
          endAt,
          autoConvert: !subTrialEnd && typeof trial.autoConvert === "boolean" ? trial.autoConvert : null,
          serverNowAt,
          updatedAt: now
        };
      }
      if (endAt > reference && (product === null || hasUnknownProduct(list)))
        return null;
    }
    if (!subscription)
      return { kind: "none", updatedAt: now };
    const list = items(subscription.items);
    const product = topProduct(list);
    if (product === "free" && !hasUnknownProduct(list))
      return { kind: "none", updatedAt: now };
    const plan = product && product !== "free" ? planOf(product) : "unknown";
    const planItem = list.find((item) => productOf(item) !== null && (!product || productOf(item) === product));
    const periodEndAt = parseIso(subscription.currentPeriodEnd) ?? (isRecord(planItem) ? parseIso(planItem.currentPeriodEnd) : null);
    return {
      kind: "subscription",
      plan,
      status: STATUSES.has(subscription.status) ? subscription.status : "unknown",
      periodEndAt,
      updatedAt: now
    };
  }
  function trialNow(trial, now = Date.now()) {
    return trial.serverNowAt === null ? now : trial.serverNowAt + Math.max(0, now - trial.updatedAt);
  }
  function trialActive(status, now = Date.now()) {
    return status?.kind === "trial" && status.endAt > trialNow(status, now);
  }
  function trialDaysLeft(trial, now = Date.now()) {
    const reference = trialNow(trial, now);
    if (trial.endAt <= reference)
      return 0;
    const midnight = new Date(reference);
    midnight.setHours(0, 0, 0, 0);
    return Math.max(0, Math.ceil((trial.endAt - midnight.getTime()) / DAY_MS));
  }
  function trialEndsToday(trial, now = Date.now()) {
    const today = new Date(trialNow(trial, now));
    const end = new Date(trial.endAt);
    return today.getFullYear() === end.getFullYear() && today.getMonth() === end.getMonth() && today.getDate() === end.getDate();
  }
  function visibleBilling(status, now = Date.now()) {
    if (!status)
      return null;
    if (status.kind === "trial")
      return trialActive(status, now) ? status : null;
    return status;
  }

  // src/plugins/usage/context.ts
  var CURRENT_PATH = "/api/v3/getCreditRateLimitStatus";
  var LEGACY_PATH = "/api/v3/getAIUsageEligibility";
  var BILLING_PATH = "/api/v3/getBillingData";
  var AI_MUTATION_RE = /\/(?:runInference|invokeAgent|submitAi|sendAi|createInference)/i;
  var SPACE_KEY = "LRU:KeyValueStore2:lastVisitedRouteSpaceId";
  var USER_KEY = "LRU:KeyValueStore2:current-user-id";
  var MAX_USER_ID = 128;
  function endpointKind(url, origin) {
    if (url.origin !== origin)
      return null;
    switch (url.pathname) {
      case CURRENT_PATH:
        return "current";
      case LEGACY_PATH:
        return "legacy";
      case BILLING_PATH:
        return "billing";
      default:
        return null;
    }
  }
  var isAiMutation = (url, method, origin) => method !== "GET" && url.origin === origin && !endpointKind(url, origin) && AI_MUTATION_RE.test(url.pathname);
  function spaceIdFrom(body, header) {
    const parsed = safeJson(body);
    if (isRecord(parsed) && isSpaceId(parsed.spaceId))
      return parsed.spaceId;
    return isSpaceId(header) ? header : null;
  }
  function validUserId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_USER_ID && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  }
  function storedValue(storage, key) {
    const parsed = safeJson(storage.getItem(key) ?? "");
    return isRecord(parsed) ? parsed.value : null;
  }
  function storedContext(storage) {
    try {
      const spaceId = storedValue(storage, SPACE_KEY);
      if (!isSpaceId(spaceId))
        return null;
      return { spaceId, userId: validUserId(storedValue(storage, USER_KEY)) };
    } catch {
      return null;
    }
  }

  // src/plugins/usage/verdict.ts
  var STATUSES2 = new Set(["within_limit", "rate_limited", "not_applicable"]);
  var PRIORITY_KEYS = ["creditRateLimitVerdict", "creditRateLimitStatus", "data", "result", "value"];
  var MAX_DEPTH2 = 6;
  var MAX_NODES = 240;
  function percentage(used, limit) {
    return limit > 0 && Number.isFinite(used) ? clamp(used / limit * 100, 0, 100) : 0;
  }
  function isVerdict(value) {
    if (!isRecord(value) || !STATUSES2.has(value.status))
      return false;
    if (value.status === "not_applicable")
      return true;
    return isRecord(value.window) && nonNegative(value.window.used) !== null && nonNegative(value.window.limit) !== null;
  }
  function findVerdict(payload) {
    const queue = [{ value: payload, depth: 0 }];
    const seen = new Set;
    for (let visited = 0;queue.length && visited < MAX_NODES; visited++) {
      const { value, depth } = queue.shift();
      if (isVerdict(value))
        return value;
      if (depth >= MAX_DEPTH2 || typeof value !== "object" || value === null || seen.has(value))
        continue;
      seen.add(value);
      const record = value;
      for (const key of PRIORITY_KEYS) {
        if (Object.hasOwn(record, key))
          queue.unshift({ value: record[key], depth: depth + 1 });
      }
      for (const child of Object.values(record)) {
        if (child && typeof child === "object")
          queue.push({ value: child, depth: depth + 1 });
      }
    }
    return null;
  }
  function rollingReset(verdict, now) {
    if (verdict.status === "within_limit") {
      const seconds = nonNegative(verdict.resetsInSeconds);
      return seconds === null ? null : now + seconds * 1000;
    }
    const retry = nonNegative(verdict.retryAfterSeconds);
    const resumes = nonNegative(verdict.resumesAtMs);
    if (verdict.limitedBy === "billing_period" && resumes !== null)
      return resumes;
    if (retry !== null)
      return now + retry * 1000;
    return resumes;
  }
  function parseUsage(payload, now = Date.now()) {
    const verdict = findVerdict(payload);
    if (!verdict)
      return null;
    const preview = verdict.enforcement === "preview";
    if (verdict.status === "not_applicable")
      return { status: "not_applicable", preview, updatedAt: now };
    const used = nonNegative(verdict.window.used);
    const limit = nonNegative(verdict.window.limit);
    const windowName = verdict.window.window;
    const raw = verdict.billingPeriodWindow;
    let monthly = null;
    if (isRecord(raw)) {
      const mUsed = nonNegative(raw.used);
      const mLimit = nonNegative(raw.limit);
      const periodEnd = nonNegative(raw.periodEndMs);
      if (mUsed !== null && mLimit !== null && periodEnd !== null && periodEnd > now) {
        monthly = { used: mUsed, limit: mLimit, percent: percentage(mUsed, mLimit), resetAt: periodEnd };
      }
    }
    return {
      status: verdict.status,
      rolling: {
        used,
        limit,
        percent: percentage(used, limit),
        window: typeof windowName === "string" && windowName.length <= 16 ? windowName : "rolling",
        resetAt: rollingReset(verdict, now)
      },
      monthly,
      limitedBy: verdict.limitedBy === "rolling" || verdict.limitedBy === "billing_period" ? verdict.limitedBy : null,
      preview,
      updatedAt: now
    };
  }
  function activeMonthly(snapshot, now = Date.now()) {
    if (snapshot.status === "not_applicable" || !snapshot.monthly)
      return null;
    return (snapshot.monthly.resetAt ?? 0) > now ? snapshot.monthly : null;
  }
  var toneOf = (percent) => percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal";
  function meterViews(snapshot, now = Date.now()) {
    if (!snapshot)
      return { rolling: { percent: null, tone: "waiting" }, monthly: { percent: null, tone: "waiting" } };
    if (snapshot.status === "not_applicable")
      return { rolling: { percent: null, tone: "neutral" }, monthly: { percent: null, tone: "neutral" } };
    const limited = snapshot.status === "rate_limited";
    const view = (meter, isLimiter) => {
      if (!meter)
        return { percent: null, tone: limited && isLimiter ? "danger" : "neutral" };
      return { percent: meter.percent, tone: limited && isLimiter ? "danger" : toneOf(meter.percent) };
    };
    return {
      rolling: view(snapshot.rolling, snapshot.limitedBy !== "billing_period"),
      monthly: view(activeMonthly(snapshot, now), snapshot.limitedBy === "billing_period")
    };
  }

  // src/plugins/usage/service.ts
  var logger4 = new Logger("Usage");
  var HEARTBEAT_MS = 30000;
  var POLL_MS2 = 60000;
  var NOT_APPLICABLE_POLL_MS = 6 * 3600000;
  var MIN_REFRESH_MS = 15000;
  var MIN_ATTEMPT_MS = 5000;
  var BILLING_EVERY_MS = 3600000;
  var TIMEOUT_MS = 12000;
  var NATIVE_GRACE_MS = 1000;
  var SEED_DELAY_MS = 1200;
  var MUTATION_DELAY_MS = 4000;
  var MAX_BACKOFF_MS = 5 * 60000;
  var FIRST_BACKOFF_MS = 15000;
  var BILLING_RETRY_MS = 15 * 60000;
  var RATE_LIMIT_RETRY_MS = 60000;

  class HttpError extends Error {
    status;
    retryAfter;
    constructor(status, retryAfter) {
      super(`HTTP ${status}`);
      this.status = status;
      this.retryAfter = retryAfter;
    }
  }
  var newTrack = () => ({
    timer: null,
    dueAt: 0,
    busy: false,
    controller: null,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    acceptedSequence: 0,
    blockedUntil: 0,
    backoff: 0,
    disabled: false,
    error: ""
  });

  class UsageService {
    snapshot = null;
    billing = null;
    spaceId = null;
    userId = null;
    headers = {};
    version = 0;
    usage = newTrack();
    bill = newTrack();
    cleanups = [];
    listeners = new Set;
    onChange(listener) {
      this.listeners.add(listener);
      return () => void this.listeners.delete(listener);
    }
    emit() {
      for (const listener of [...this.listeners])
        listener();
    }
    get state() {
      const now = Date.now();
      return {
        snapshot: this.snapshot,
        billing: this.billing,
        spaceId: this.spaceId,
        loading: this.usage.busy || this.bill.busy,
        error: [this.usage.error, this.bill.error].filter(Boolean).join(t("；", "; ")),
        canRefresh: !!this.spaceId && !this.usage.busy && !(this.usage.disabled && this.bill.disabled) && now >= Math.max(this.usage.blockedUntil, this.usage.lastSuccessAt + MIN_REFRESH_MS)
      };
    }
    start() {
      const origin = pageWindow.location.origin;
      this.cleanups.push(observeNetwork({
        matches: (url, method) => !!endpointKind(url, origin) || isAiMutation(url, method, origin),
        onExchange: (exchange) => this.observe(exchange, endpointKind(exchange.url, origin))
      }));
      const seed = setTimeout(() => this.seedFromStorage(), SEED_DELAY_MS);
      const heartbeat = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
      const onVisible = () => !document.hidden && this.heartbeat();
      document.addEventListener("visibilitychange", onVisible);
      this.cleanups.push(() => {
        clearTimeout(seed);
        clearInterval(heartbeat);
        document.removeEventListener("visibilitychange", onVisible);
        for (const track of [this.usage, this.bill]) {
          if (track.timer)
            clearTimeout(track.timer);
          track.controller?.abort();
        }
      });
    }
    stop() {
      for (const cleanup of this.cleanups.splice(0))
        cleanup();
      this.listeners.clear();
    }
    refreshNow() {
      this.refreshBilling(true);
      this.refreshUsage();
    }
    seedFromStorage() {
      if (this.spaceId)
        return;
      const stored = storedContext(pageWindow.localStorage);
      if (!stored)
        return;
      logger4.info("Using the workspace remembered by Notion until a native request arrives.");
      const headers = stored.userId ? { "x-notion-active-user-header": stored.userId } : {};
      this.acceptContext(stored.spaceId, headers, 0);
      this.schedule(this.usage, 0, () => this.refreshUsage());
      this.schedule(this.bill, 250, () => this.refreshBilling());
    }
    acceptContext(spaceId, headers, sequence) {
      const userId = validUserId(headers["x-notion-active-user-header"]);
      const changed = spaceId !== this.spaceId || !!userId && !!this.userId && userId !== this.userId;
      if (changed) {
        this.version++;
        for (const track of [this.usage, this.bill]) {
          track.controller?.abort();
          if (track.timer)
            clearTimeout(track.timer);
          Object.assign(track, newTrack());
        }
        this.snapshot = null;
        this.billing = null;
        this.headers = {};
      }
      this.spaceId = spaceId;
      this.userId = userId ?? this.userId;
      this.headers = { ...this.headers, ...headers, "content-type": "application/json", "x-notion-space-id": spaceId };
      if (changed)
        this.emit();
      return { version: this.version, sequence };
    }
    observe(exchange, kind) {
      if (!kind) {
        exchange.response.then((response) => response?.ok && this.schedule(this.usage, MUTATION_DELAY_MS, () => this.refreshUsage()));
        return;
      }
      if (kind === "current")
        this.usage.lastAttemptAt = Date.now();
      const context = exchange.body.then((body) => {
        const spaceId = spaceIdFrom(body, exchange.headers["x-notion-space-id"]);
        return spaceId ? this.acceptContext(spaceId, exchange.headers, exchange.sequence) : null;
      });
      context.then((token) => {
        if (!token)
          return;
        if (!this.snapshot) {
          const delay = kind === "current" ? NATIVE_GRACE_MS : 400;
          this.schedule(this.usage, delay, () => this.refreshUsage());
        }
        this.schedule(this.bill, kind === "billing" ? 1500 : 250, () => this.refreshBilling());
      });
      if (kind === "legacy")
        return;
      Promise.all([exchange.response, context]).then(async ([response, token]) => {
        if (!response?.ok || !token || token.version !== this.version)
          return;
        const payload = safeJson(await response.text());
        if (token.version !== this.version)
          return;
        this.accept(kind, payload, token.sequence);
      }).catch(() => logger4.debug(`Could not read native ${kind} response.`));
    }
    accept(kind, payload, sequence) {
      const track = kind === "current" ? this.usage : this.bill;
      if (sequence <= track.acceptedSequence)
        return true;
      if (kind === "current") {
        const snapshot = parseUsage(payload);
        if (!snapshot) {
          track.error = t("Notion 返回了暂不支持的用量数据结构", "Notion returned an unsupported usage schema");
          this.emit();
          return false;
        }
        this.snapshot = snapshot;
      } else {
        const billing = parseBilling(payload);
        if (!billing)
          return false;
        this.billing = billing;
      }
      Object.assign(track, { acceptedSequence: sequence, lastSuccessAt: Date.now(), backoff: 0, blockedUntil: 0, disabled: false, error: "" });
      this.emit();
      return true;
    }
    schedule(track, delay, run) {
      if (!this.spaceId || document.hidden || track.disabled)
        return;
      const now = Date.now();
      const dueAt = Math.max(now + delay, track.blockedUntil, track.lastAttemptAt ? track.lastAttemptAt + MIN_ATTEMPT_MS : 0);
      if (track.timer && track.dueAt <= dueAt)
        return;
      if (track.timer)
        clearTimeout(track.timer);
      track.dueAt = dueAt;
      track.timer = setTimeout(() => {
        track.timer = null;
        run();
      }, dueAt - now);
    }
    heartbeat() {
      this.emit();
      if (document.hidden || !this.spaceId)
        return;
      const now = Date.now();
      const trialEnded = this.billing?.kind === "trial" && !trialActive(this.billing, now);
      if (trialEnded || now - this.bill.lastSuccessAt >= BILLING_EVERY_MS)
        this.refreshBilling(trialEnded);
      const interval = this.snapshot?.status === "not_applicable" ? NOT_APPLICABLE_POLL_MS : POLL_MS2;
      if (now - Math.max(this.usage.lastSuccessAt, this.usage.lastAttemptAt) >= interval)
        this.refreshUsage();
    }
    refreshUsage() {
      if (Date.now() - this.usage.lastSuccessAt < MIN_REFRESH_MS)
        return;
      this.request(this.usage, CURRENT_PATH, "current");
    }
    refreshBilling(force = false) {
      const track = this.bill;
      if (!force && Date.now() - track.lastSuccessAt < BILLING_EVERY_MS)
        return;
      if (Date.now() - track.lastAttemptAt < MIN_REFRESH_MS)
        return;
      this.request(track, BILLING_PATH, "billing");
    }
    async request(track, path, kind) {
      const now = Date.now();
      if (!this.spaceId || track.busy || track.disabled || document.hidden || now < track.blockedUntil)
        return;
      if (kind === "current" && now - track.lastAttemptAt < MIN_ATTEMPT_MS)
        return;
      const version = this.version;
      const sequence = nextSequence();
      const controller = new AbortController;
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      Object.assign(track, { busy: true, controller, lastAttemptAt: now });
      this.emit();
      try {
        const response = await nativeFetch()(new URL(path, pageWindow.location.origin).href, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { ...this.headers },
          body: JSON.stringify({ spaceId: this.spaceId }),
          signal: controller.signal
        });
        if (!response.ok)
          throw new HttpError(response.status, Number(response.headers.get("retry-after")) || null);
        const text = await response.text();
        if (version !== this.version)
          return;
        if (!this.accept(kind, safeJson(text), sequence))
          throw new Error("unsupported-schema");
      } catch (error) {
        if (version !== this.version || sequence <= track.acceptedSequence)
          return;
        this.fail(track, kind, error);
      } finally {
        clearTimeout(timeout);
        if (track.controller === controller) {
          track.busy = false;
          track.controller = null;
        }
        this.emit();
      }
    }
    fail(track, kind, error) {
      const status = error instanceof HttpError ? error.status : 0;
      const retryAfter = error instanceof HttpError && error.retryAfter ? error.retryAfter * 1000 : null;
      const aborted = error?.name === "AbortError";
      if (status === 401 || status === 403) {
        track.disabled = true;
        track.error = kind === "current" ? t("主动读取没有权限；请打开原生用量页触发 Notion 自身请求", "Active refresh is not permitted; open the native Usage page") : t("无法读取订阅状态：当前账户没有账单数据权限", "Subscription status unavailable for this account");
        return;
      }
      if (kind === "current") {
        track.backoff = track.backoff ? Math.min(track.backoff * 2, MAX_BACKOFF_MS) : FIRST_BACKOFF_MS;
        track.blockedUntil = Date.now() + Math.max(track.backoff, retryAfter ?? 0);
        track.error = status === 429 ? t("请求过于频繁，稍后自动重试", "Too many requests; retrying later") : aborted ? t("读取用量超时", "Usage request timed out") : t("暂时无法读取 Notion AI 用量", "Unable to load Notion AI usage");
        return;
      }
      if (status === 429)
        track.blockedUntil = Date.now() + (retryAfter ?? RATE_LIMIT_RETRY_MS);
      else if (!aborted)
        track.blockedUntil = Date.now() + BILLING_RETRY_MS;
      track.error = status === 429 ? t("订阅状态请求过于频繁，稍后自动重试", "Subscription status was rate limited; retrying later") : aborted ? t("读取订阅状态超时", "Subscription status timed out") : t("暂时无法读取订阅状态", "Unable to load subscription status");
    }
  }

  // src/plugins/usage/stats.ts
  var STATS_PREFIX = "notionai-pp:usage-stats:v1:";
  var RESET_DROP = 5;
  var RESET_TOLERANCE_MS = 60000;
  var RETAIN = { min: 7, max: 180, default: 90 };
  var HOVER_DELAY = { min: 0, max: 5, default: 1 };
  var CHART_DAYS = 7;
  var CHART_FLOOR = 20;
  var DATE_RE2 = /^\d{4}-\d{2}-\d{2}$/;
  var memory = new Map;
  function read2(key) {
    try {
      return pageWindow.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }
  function write(key, value) {
    try {
      if (value === null)
        pageWindow.localStorage.removeItem(key);
      else
        pageWindow.localStorage.setItem(key, value);
    } catch {
      if (value === null)
        memory.delete(key);
      else
        memory.set(key, value);
    }
  }
  var percentOf = (value) => {
    const n = finiteNumber(value);
    return n === null ? null : clamp(n, 0, 100);
  };
  function dateKey(at) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function shiftDate(date, days) {
    const [y, m, d] = date.split("-").map(Number);
    return y && m && d ? dateKey(new Date(y, m - 1, d + days).getTime()) : date;
  }
  var emptyDay = (date, now) => ({
    date,
    first: null,
    last: null,
    resetAt: null,
    carried: 0,
    closedFirst: null,
    closedLast: null,
    updatedAt: now
  });
  function parseDay(date, raw) {
    if (!DATE_RE2.test(date) || !isRecord(raw))
      return null;
    return {
      date,
      first: percentOf(raw.first),
      last: percentOf(raw.last),
      resetAt: finiteNumber(raw.resetAt),
      carried: Math.max(0, finiteNumber(raw.carried) ?? 0),
      closedFirst: percentOf(raw.closedFirst),
      closedLast: percentOf(raw.closedLast),
      updatedAt: finiteNumber(raw.updatedAt) ?? 0
    };
  }
  function loadDays(space) {
    const days = new Map;
    if (!space)
      return days;
    const raw = safeJson(read2(STATS_PREFIX + space) ?? "");
    if (!isRecord(raw) || !isRecord(raw.days))
      return days;
    for (const [date, value] of Object.entries(raw.days)) {
      const day = parseDay(date, value);
      if (day)
        days.set(date, day);
    }
    return days;
  }
  function prune(days, retain, now) {
    const keep = clamp(Math.floor(retain), RETAIN.min, RETAIN.max);
    const cutoff = shiftDate(dateKey(now), 1 - keep);
    for (const date of [...days.keys()])
      if (date < cutoff)
        days.delete(date);
    return days;
  }
  function saveDay(space, day, retain, now) {
    const days = loadDays(space);
    days.set(day.date, day);
    prune(days, retain, now);
    write(STATS_PREFIX + space, JSON.stringify({ days: Object.fromEntries(days) }));
    return days.get(day.date) ?? day;
  }
  function closeSegment(day, percent) {
    if (day.first !== null && day.last !== null) {
      day.carried += Math.max(0, day.last - day.first);
      day.closedFirst = day.first;
      day.closedLast = day.last;
    }
    day.first = percent;
    day.last = percent;
  }
  function applySnapshot(day, percent, resetAt, now) {
    const next = { ...day, updatedAt: now };
    if (resetAt !== null && next.resetAt !== null && Math.abs(resetAt - next.resetAt) >= RESET_TOLERANCE_MS) {
      closeSegment(next, percent);
      next.resetAt = resetAt;
      return next;
    }
    if (resetAt !== null)
      next.resetAt = resetAt;
    if (percent === null)
      return next;
    if (next.last !== null && percent < next.last - RESET_DROP) {
      closeSegment(next, percent);
      return next;
    }
    if (next.first === null)
      next.first = percent;
    next.last = percent;
    return next;
  }
  function usedOn(day) {
    if (day.first === null || day.last === null)
      return day.carried > 0 ? day.carried : null;
    return day.carried + Math.max(0, day.last - day.first);
  }
  function recordSnapshot(space, percent, resetAt, retain, now = Date.now()) {
    if (!space)
      return null;
    const date = dateKey(now);
    const current = loadDays(space).get(date) ?? emptyDay(date, now);
    return saveDay(space, applySnapshot(current, percent, resetAt, now), retain, now);
  }
  function writeDay(space, day, retain, now = Date.now()) {
    return space && DATE_RE2.test(day.date) ? saveDay(space, { ...day, updatedAt: now }, retain, now) : null;
  }
  var readDay = (space, now = Date.now()) => loadDays(space).get(dateKey(now)) ?? null;
  var clearDays = (space) => void (space && write(STATS_PREFIX + space, null));
  function looksWiped(day, previous) {
    if (day.carried > 0 || day.closedLast !== null || day.first === null || day.last === null)
      return false;
    if (day.first > RESET_DROP)
      return false;
    return previous?.last != null && previous.last > day.first + RESET_DROP;
  }
  function repairWiped(day, dayStart, beforeReset, now = Date.now()) {
    const start = clamp(dayStart, 0, 100);
    const before = clamp(beforeReset, 0, 100);
    return { ...day, carried: Math.max(0, before - start), closedFirst: start, closedLast: before, updatedAt: now };
  }
  function chartDays(days, now = Date.now()) {
    const today = dateKey(now);
    let start = shiftDate(today, 1 - CHART_DAYS);
    for (const date of days.keys())
      if (date < start)
        start = date;
    const out = [];
    for (let date = start;date <= today; date = shiftDate(date, 1))
      out.push(days.get(date) ?? emptyDay(date, now));
    return out;
  }
  function chartScale(days) {
    const max = Math.max(0, ...days.map((day) => usedOn(day) ?? 0));
    return Math.max(CHART_FLOOR, Math.ceil(max / 10) * 10);
  }
  function statPercent(value) {
    if (value === null || !Number.isFinite(value))
      return "—";
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
  }
  var statDelta = (value) => value === null ? "—" : value > 0 ? `+${statPercent(value)}` : statPercent(value);
  function dayLabel(date, today = dateKey(Date.now())) {
    if (date === today)
      return t("今天", "Today");
    const [y, m, d] = date.split("-").map(Number);
    if (!y || !m || !d)
      return date;
    return new Date(y, m - 1, d).toLocaleDateString(uiLanguage() === "zh" ? "zh-CN" : "en", { weekday: "short", month: "short", day: "numeric" });
  }
  var dayNumber = (date) => String(Number(date.split("-")[2]) || date);

  // src/plugins/usage/statsDialog.ts
  var STATS_HOST_ID = "notionai-pp-usage-stats";
  var CSS3 = `${CSS2}
.sheet > .stack { gap: .875rem; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.toggle-row b { font-size: .875rem; font-weight: 500; }
.muted { margin: 0; color: var(--fg-secondary); font-size: .8125rem; }
.chart { display: flex; align-items: stretch; gap: .35rem; height: 9.25rem; overflow-x: auto; outline: none; }
.chart:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; border-radius: .5rem; }
.bar { flex: 1 0 2.5rem; min-width: 2.5rem; height: 100%; padding: .25rem .15rem .2rem; display: flex; flex-direction: column;
  align-items: center; justify-content: flex-end; gap: .3rem; border: 0; border-radius: .5rem; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.bar:hover, .bar.on { background: var(--surface-l2); }
.track { display: flex; flex: 1; align-items: flex-end; justify-content: center; width: 100%; min-height: 0; }
.fill { width: 1.1rem; min-height: 2px; border-radius: 4px 4px 0 0; background: color-mix(in srgb, var(--fg-primary) 45%, transparent); }
.bar.on .fill { background: var(--fg-primary); }
.bar.empty .fill { background: var(--border-l1); }
.bar-value, .bar-label { font-size: .6875rem; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-value { min-height: .6875rem; font-weight: 550; opacity: .85; }
.bar.empty .bar-value { opacity: 0; }
.bar-label { opacity: .7; }
.bar.on .bar-value, .bar.on .bar-label { opacity: 1; font-weight: 550; }
.detail { display: flex; flex-direction: column; gap: .4rem; padding-top: .6rem; border-top: 1px solid var(--border-l1); }
.detail-title { font-size: .875rem; font-weight: 600; }
.formula { display: flex; align-items: flex-end; gap: .6rem; font-variant-numeric: tabular-nums; }
.term { display: flex; flex-direction: column; gap: .1rem; }
.term small { color: var(--fg-secondary); font-size: .6875rem; }
.term b { font-size: .9375rem; font-weight: 600; }
.op { padding-bottom: .1rem; color: var(--fg-secondary); }
.caption { color: var(--fg-secondary); font-size: .75rem; font-variant-numeric: tabular-nums; }
.repair { display: flex; flex-direction: column; gap: .4rem; padding: .6rem; border-radius: .6rem; background: var(--surface-l2); }
.repair-row { display: flex; align-items: center; gap: .5rem; }
.repair .input { width: 6rem; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
`;
  var overlay4 = null;
  function closeStats() {
    overlay4?.destroy();
    overlay4 = null;
  }
  function iconButton2(markup, label, onclick) {
    const button = el("button", { type: "button", class: "icon-btn close", title: label, "aria-label": label });
    button.append(svgIcon(markup));
    button.addEventListener("click", onclick);
    return button;
  }
  function textButton(variant, label, onclick) {
    const button = el("button", { type: "button", class: `btn btn-${variant}`, text: label });
    button.addEventListener("click", onclick);
    return button;
  }
  function formula(day, isToday) {
    const term = (label, value) => el("span", { class: "term" }, el("small", { text: label }), el("b", { text: value }));
    const op = (sign) => el("span", { class: "op", text: sign });
    const used = statPercent(usedOn(day));
    if (day.carried <= 0) {
      return el("div", { class: "formula" }, term(isToday ? t("当前", "Current") : t("最后", "Last"), statPercent(day.last)), op("−"), term(t("开始", "Start"), statPercent(day.first)), op("="), term(t("已用", "Used"), used));
    }
    const after = day.first === null || day.last === null ? null : Math.max(0, day.last - day.first);
    const box = el("div", { class: "stack" }, el("div", { class: "formula" }, term(t("重置前", "Before"), statPercent(day.carried)), op("+"), term(t("重置后", "After"), statPercent(after)), op("="), term(t("已用", "Used"), used)));
    if (day.closedFirst !== null && day.closedLast !== null) {
      let caption = `${statPercent(day.closedFirst)} → ${statPercent(day.closedLast)}`;
      if (day.first !== null && day.last !== null)
        caption += `  +  ${statPercent(day.first)} → ${statPercent(day.last)}`;
      box.append(el("div", { class: "caption", text: caption }));
    }
    return box;
  }
  function repairBox(ctx, day, previous, rerender) {
    if (!looksWiped(day, previous))
      return null;
    const hint = previous?.last ?? null;
    const input = el("input", {
      type: "number",
      min: "0",
      max: "100",
      step: "0.1",
      class: "input",
      value: hint === null ? "" : String(hint),
      "aria-label": t("重置前的月度用量百分比", "Monthly percent before the reset")
    });
    const apply = textButton("secondary", t("修复", "Repair"), () => {
      const before = finiteNumber(input.value);
      if (before === null)
        return;
      writeDay(ctx.space(), repairWiped(day, hint ?? 0, before), ctx.retain());
      rerender();
    });
    input.addEventListener("input", () => void (apply.disabled = finiteNumber(input.value) === null));
    return el("div", { class: "repair" }, el("p", { class: "muted", text: t("月度额度在这一天开始前已重置，记录只剩 0% 左右。填入重置前的月度用量即可补回当天的用量。", "The monthly allowance reset before this day was first seen, so only ~0% was recorded. Enter the monthly usage just before the reset.") }), el("div", { class: "repair-row" }, input, apply));
  }
  function confirmClear(ctx, root, done) {
    const layer = el("div", { class: "layer layer-confirm" });
    const close = () => layer.remove();
    const sheet = el("div", { class: "sheet sheet-sm", role: "dialog", "aria-modal": "true" }, iconButton2(Icons.x, t("关闭", "Close"), close), el("div", { class: "sheet-head" }, el("h3", { class: "sheet-title", text: t("清空用量历史", "Clear usage history") }), el("p", { class: "sheet-desc", text: t("删除本设备上记录的所有每日用量？此操作无法撤销。", "Delete all daily usage recorded on this device? This cannot be undone.") })), el("div", { class: "footer" }, textButton("secondary", t("取消", "Cancel"), close), textButton("danger", t("清空", "Clear"), () => {
      clearDays(ctx.space());
      close();
      done();
    })));
    layer.append(sheet);
    layer.addEventListener("mousedown", (event) => event.target === layer && close());
    root.append(layer);
    sheet.tabIndex = -1;
    sheet.focus();
  }
  function openStats(ctx, { confirmClearNow = false } = {}) {
    closeStats();
    ctx.refresh();
    overlay4 = createOverlay(STATS_HOST_ID, CSS3, "");
    const { root } = overlay4;
    const body = el("div", { class: "stack" });
    const sheet = el("div", { class: "sheet sheet-sm", role: "dialog", "aria-modal": "true" }, iconButton2(Icons.x, t("关闭", "Close"), closeStats), el("div", { class: "sheet-head" }, el("h3", { class: "sheet-title", text: t("按日期查看用量", "Usage by date") }), el("p", { class: "sheet-desc", text: t("每天用掉的月度额度百分比，仅保存在本设备。", "Share of the monthly allowance used each day, stored on this device.") })), body);
    const backdrop = el("div", { class: "layer layer-root" }, sheet);
    backdrop.addEventListener("mousedown", (event) => event.target === backdrop && closeStats());
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape")
        return;
      const confirm = root.querySelector(".layer-confirm");
      if (confirm)
        confirm.remove();
      else
        closeStats();
    });
    root.append(backdrop);
    let selected = dateKey(Date.now());
    const render = () => {
      const space = ctx.space();
      const enabled = ctx.enabled();
      const now = Date.now();
      const today = dateKey(now);
      const days = enabled ? loadDays(space) : new Map;
      const toggle = el("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(enabled), "aria-label": t("记录每日用量", "Daily usage stats") });
      toggle.addEventListener("click", () => {
        ctx.setEnabled(!enabled);
        if (!enabled)
          ctx.refresh();
        render();
      });
      const parts = [el("div", { class: "toggle-row" }, el("b", { text: t("记录每日用量", "Daily usage stats") }), toggle)];
      if (!space) {
        parts.push(el("p", { class: "muted", text: t("等待 Notion 初始化当前工作区。", "Waiting for Notion to initialize this workspace.") }));
      } else if (!enabled) {
        parts.push(el("p", { class: "muted", text: t("开启后按天记录月度额度的使用量；悬停最小化的圆环会在延迟后显示今天的用量。", "Turn on to keep a per-day log of the monthly allowance. Hovering the minimized rings shows today after a delay.") }));
      } else if (!days.size) {
        parts.push(el("p", { class: "muted", text: t("还没有记录。统计从开启记录的那一刻开始。", "No days recorded yet. Stats start from the moment tracking is on.") }));
      } else {
        const bars = chartDays(days, now);
        const scale = chartScale(bars);
        const active = bars.find((day) => day.date === selected) ?? bars[bars.length - 1];
        const chart = el("div", { class: "chart", tabindex: "0", role: "listbox", "aria-label": t("每日用量", "Daily usage") });
        for (const day of bars) {
          const used = usedOn(day);
          const on = day.date === active.date;
          const bar = el("button", {
            type: "button",
            tabindex: "-1",
            role: "option",
            "aria-selected": String(on),
            class: ["bar", on && "on", used === null && "empty"].filter(Boolean).join(" "),
            "aria-label": `${dayLabel(day.date, today)}, ${statDelta(used)}`
          });
          const fill = el("span", { class: "fill" });
          fill.style.height = `${used === null ? 0 : Math.min(100, used / scale * 100)}%`;
          bar.append(el("span", { class: "bar-value", text: used === null ? " " : statPercent(used) }), el("span", { class: "track" }, fill), el("span", { class: "bar-label", text: day.date === today ? t("今天", "Today") : dayNumber(day.date) }));
          bar.addEventListener("click", () => {
            selected = day.date;
            render();
            root.querySelector(".chart")?.focus({ preventScroll: true });
          });
          chart.append(bar);
        }
        chart.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
            return;
          event.preventDefault();
          const index = bars.findIndex((day) => day.date === active.date);
          const next = bars[Math.min(bars.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)))];
          selected = next.date;
          render();
          root.querySelector(".chart")?.focus({ preventScroll: true });
        });
        const previous = days.get(shiftDate(active.date, -1)) ?? null;
        const detail = el("div", { class: "detail" }, el("div", { class: "detail-title", text: dayLabel(active.date, today) }), formula(active, active.date === today));
        const repair = repairBox(ctx, active, previous, render);
        if (repair)
          detail.append(repair);
        parts.push(chart, detail);
        queueMicrotask(() => {
          const on = chart.querySelector(".bar.on");
          if (on && chart.scrollWidth > chart.clientWidth)
            chart.scrollLeft = on.offsetLeft - chart.clientWidth + on.offsetWidth + 8;
        });
      }
      const stored = space ? loadDays(space).size : 0;
      const clear = textButton("secondary", t("清空历史", "Clear history"), () => confirmClear(ctx, root, render));
      clear.disabled = !stored;
      parts.push(el("div", { class: "foot" }, el("p", { class: "muted", text: t(`已记录 ${stored} 天，保留 ${ctx.retain()} 天`, `${stored} recorded day${stored === 1 ? "" : "s"}, keeping ${ctx.retain()}`) }), clear));
      body.replaceChildren(...parts);
    };
    render();
    sheet.tabIndex = -1;
    sheet.focus();
    if (confirmClearNow && ctx.space() && loadDays(ctx.space()).size)
      confirmClear(ctx, root, render);
  }

  // src/plugins/usage/format.ts
  var formatPercent = (value) => value === null ? "—" : `${Math.round(value)}%`;
  var locale = () => uiLanguage() === "zh" ? "zh-CN" : "en";
  function formatDate(time, withYear = false) {
    if (time === null || !Number.isFinite(time))
      return t("未知", "Unknown");
    return new Intl.DateTimeFormat(locale(), {
      ...withYear ? { year: "numeric" } : {},
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(time));
  }
  function formatAbsolute(time) {
    if (time === null || !Number.isFinite(time))
      return t("未知", "Unknown");
    return new Intl.DateTimeFormat(locale(), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(time));
  }
  function formatReset(resetAt, now = Date.now(), used) {
    if (resetAt === null) {
      return used === 0 ? t("暂无用量，开始使用后显示倒计时", "No usage yet; the countdown appears once you use AI") : t("重置时间未知", "Reset time unavailable");
    }
    const diff = resetAt - now;
    if (diff <= 0)
      return t("即将重置", "Resetting soon");
    const minutes = Math.max(1, Math.ceil(diff / 60000));
    if (minutes > 1440) {
      const hours = Math.floor(minutes / 60);
      const d = Math.floor(hours / 24);
      const h = hours % 24;
      return h ? t(`${d} 天 ${h} 小时后重置`, `Resets in ${d}d ${h}h`) : t(`${d} 天后重置`, `Resets in ${d}d`);
    }
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m)
      return t(`${h} 小时 ${m} 分钟后重置`, `Resets in ${h}h ${m}m`);
    if (h)
      return t(`${h} 小时后重置`, `Resets in ${h}h`);
    return t(`${m} 分钟后重置`, `Resets in ${m}m`);
  }
  function formatUpdated(time, now = Date.now()) {
    if (time === null)
      return t("尚未更新", "Not updated yet");
    const s = Math.max(0, Math.floor((now - time) / 1000));
    if (s < 10)
      return t("刚刚更新", "Updated just now");
    if (s < 60)
      return t(`${s} 秒前更新`, `Updated ${s}s ago`);
    if (s < 3600)
      return t(`${Math.floor(s / 60)} 分钟前更新`, `Updated ${Math.floor(s / 60)}m ago`);
    return t(`${Math.floor(s / 3600)} 小时前更新`, `Updated ${Math.floor(s / 3600)}h ago`);
  }
  function windowLabel(window2) {
    if (window2 === "6h")
      return t("当前窗口（6 小时）", "Current window (6h)");
    if (window2 === "24h")
      return t("当前窗口（24 小时）", "Current window (24h)");
    return t("当前窗口", "Current window");
  }
  function planName(plan) {
    switch (plan) {
      case "free":
        return "Free";
      case "plus":
        return "Plus";
      case "business":
        return "Business";
      case "enterprise":
        return "Enterprise";
      case "unknown":
        return t("未知", "Unknown");
    }
  }
  function statusName(status) {
    switch (status) {
      case "active":
        return t("有效", "Active");
      case "trialing":
        return t("试用中", "Trialing");
      case "past_due":
        return t("逾期", "Past due");
      case "unpaid":
        return t("未付款", "Unpaid");
      case "paused":
        return t("已暂停", "Paused");
      case "canceled":
        return t("已取消", "Canceled");
      case "incomplete":
        return t("未完成", "Incomplete");
      case "incomplete_expired":
        return t("已失效", "Expired");
      case "unknown":
        return t("状态未知", "Status unavailable");
    }
  }
  function billingSummary(status, now = Date.now()) {
    if (!status || status.kind === "none")
      return null;
    if (status.kind === "trial") {
      return trialEndsToday(status, now) ? t("试用 今天结束", "Trial ends today") : t(`试用 ${trialDaysLeft(status, now)}天`, `Trial ${trialDaysLeft(status, now)}d`);
    }
    return `${planName(status.plan)} · ${statusName(status.status)}`;
  }
  function billingRow(status, now = Date.now()) {
    switch (status.kind) {
      case "none":
        return { label: t("Free 套餐", "Free Plan"), value: t("未订阅", "No subscription"), detail: "", tooltip: t("Free 套餐：未订阅", "Free Plan: No subscription") };
      case "trial":
        return {
          label: t("Business 试用", "Business Trial"),
          value: trialEndsToday(status, now) ? t("今天结束", "Ends today") : t(`剩余 ${trialDaysLeft(status, now)} 天`, `${trialDaysLeft(status, now)} days left`),
          detail: t(`${formatDate(status.endAt, true)} 结束`, `Ends ${formatDate(status.endAt, true)}`),
          tooltip: t(`Business 试用：${formatAbsolute(status.startAt)} — ${formatAbsolute(status.endAt)}`, `Business Trial: ${formatAbsolute(status.startAt)} — ${formatAbsolute(status.endAt)}`)
        };
      case "subscription": {
        const label = t(`${planName(status.plan)} 套餐`, `${planName(status.plan)} Plan`);
        const value = statusName(status.status);
        const detail = status.periodEndAt === null ? "" : t(`当前周期至 ${formatDate(status.periodEndAt, true)}`, `Current period ends ${formatDate(status.periodEndAt, true)}`);
        return { label, value, detail, tooltip: detail ? t(`${label}：${value}；${detail}`, `${label}: ${value}; ${detail}`) : t(`${label}：${value}`, `${label}: ${value}`) };
      }
    }
  }

  // src/plugins/usage/geometry.ts
  var VIEWPORT_INSET = 8;
  var DOCK_BOTTOM_INSET = 7;
  function clampPoint(point, viewport, size, inset = VIEWPORT_INSET) {
    const maxLeft = Math.max(inset, viewport.width - size.width - inset);
    const maxTop = Math.max(inset, viewport.height - size.height - inset);
    return { left: clamp(point.left, inset, maxLeft), top: clamp(point.top, inset, maxTop) };
  }
  function anchorFromBox(box, viewport) {
    const left = Math.max(0, box.left);
    const right = Math.max(0, viewport.width - box.right);
    const top = Math.max(0, box.top);
    const bottom = Math.max(0, viewport.height - box.bottom);
    return {
      xEdge: left <= right ? "left" : "right",
      xOffset: Math.round(Math.min(left, right)),
      yEdge: top <= bottom ? "top" : "bottom",
      yOffset: Math.round(Math.min(top, bottom))
    };
  }
  function pointFromAnchor(anchor, viewport, size) {
    return clampPoint({
      left: anchor.xEdge === "left" ? anchor.xOffset : viewport.width - anchor.xOffset - size.width,
      top: anchor.yEdge === "top" ? anchor.yOffset : viewport.height - anchor.yOffset - size.height
    }, viewport, size);
  }
  function parseAnchor(raw) {
    if (!isRecord(raw))
      return null;
    const { xEdge, xOffset, yEdge, yOffset } = raw;
    if (xEdge !== "left" && xEdge !== "right")
      return null;
    if (yEdge !== "top" && yEdge !== "bottom")
      return null;
    if (typeof xOffset !== "number" || !(xOffset >= 0) || typeof yOffset !== "number" || !(yOffset >= 0))
      return null;
    return { xEdge, xOffset, yEdge, yOffset };
  }
  function dockPoint(composer, orb, viewport, bottomInset = DOCK_BOTTOM_INSET) {
    if (composer.width <= 0 || composer.height <= 0 || orb.width <= 0 || orb.height <= 0)
      return null;
    const side = Math.min(6, Math.max(2, composer.width / 8));
    const minLeft = composer.left + side;
    const maxLeft = Math.max(minLeft, composer.right - orb.width - side);
    const minTop = composer.top + Math.min(4, Math.max(0, composer.height - orb.height));
    const maxTop = Math.max(minTop, composer.bottom - orb.height - 4);
    return clampPoint({
      left: clamp(composer.left + (composer.width - orb.width) / 2, minLeft, maxLeft),
      top: clamp(composer.bottom - orb.height - bottomInset, minTop, maxTop)
    }, viewport, orb);
  }
  function opensUpward(handle, required, viewport) {
    const below = viewport.height - handle.bottom - VIEWPORT_INSET;
    const above = handle.top - VIEWPORT_INSET;
    if (required <= below)
      return false;
    if (required <= above)
      return true;
    return above > below;
  }
  var dragDistanceReached = (dx, dy, threshold = 4) => dx * dx + dy * dy >= threshold * threshold;

  // src/plugins/usage/styles.ts
  var USAGE_CSS = `
:host {
  all: initial;
  --text: #f7f7f5; --muted: #a8a8a8; --faint: #929292; --border: rgba(255,255,255,.14);
  --divider: rgba(255,255,255,.24); --pill: rgba(30,30,30,.94); --pill-hover: rgba(42,42,42,.97);
  --card: rgba(28,28,28,.97); --btn: rgba(255,255,255,.08); --btn-hover: rgba(255,255,255,.14);
  --row: rgba(255,255,255,.08); --bar: rgba(255,255,255,.10); --value: #c7c7c7; --billing: #d9c4ff;
  --info: #c6dfff; --info-bg: rgba(58,132,217,.14); --error: #ffc5c5; --error-bg: rgba(221,70,70,.14);
  --tip: #f7f7f5; --tip-bg: #2f2f2f; --tip-border: rgba(255,255,255,.12); --track: rgba(255,255,255,.18);
  --core: #202124; --shadow: 0 14px 42px rgba(0,0,0,.36);
  position: fixed; top: 16px; left: auto; right: 16px; z-index: 2147483646;
  display: block; width: max-content; max-width: calc(100vw - 16px);
  color: var(--text); font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
:host([data-theme="light"]) {
  --text: #252525; --muted: #686868; --faint: #787774; --border: rgba(15,15,15,.13); --divider: rgba(15,15,15,.2);
  --pill: rgba(255,255,255,.96); --pill-hover: rgba(247,247,245,.98); --card: rgba(255,255,255,.98);
  --btn: rgba(15,15,15,.06); --btn-hover: rgba(15,15,15,.11); --row: rgba(15,15,15,.09); --bar: rgba(15,15,15,.1);
  --value: #555; --billing: #6940a5; --info: #24588f; --info-bg: rgba(46,119,190,.11); --error: #a62d2f;
  --error-bg: rgba(190,46,48,.1); --tip: #252525; --tip-bg: #fff; --tip-border: rgba(15,15,15,.12);
  --track: rgba(15,15,15,.16); --shadow: 0 14px 38px rgba(15,15,15,.18);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
button { font: inherit; }
[hidden] { display: none !important; }
.shell { position: relative; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
:host([data-side="left"]) .shell { align-items: flex-start; }
:host([data-up]) .shell { flex-direction: column-reverse; }
:host([data-docked]) .shell { align-items: center; }
.summary {
  pointer-events: auto; display: inline-flex; align-items: center; min-height: 36px; padding-right: 5px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--pill);
  box-shadow: 0 7px 24px rgba(0,0,0,.2); backdrop-filter: blur(14px); cursor: grab; touch-action: none; user-select: none;
}
.summary:hover { background: var(--pill-hover); }
.toggle {
  display: inline-flex; align-items: center; gap: 10px; min-height: 34px; padding: 7px 4px 7px 12px;
  border: 0; color: inherit; background: transparent; cursor: inherit;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #808080; box-shadow: 0 0 0 3px rgba(128,128,128,.13); }
.dot[data-status="ok"] { background: #35b46f; box-shadow: 0 0 0 3px rgba(53,180,111,.15); }
.dot[data-status="error"] { background: #f05d5e; box-shadow: 0 0 0 3px rgba(240,93,94,.16); }
.dot[data-status="waiting"] { background: #d3a832; box-shadow: 0 0 0 3px rgba(211,168,50,.16); }
.text { display: inline-flex; align-items: center; white-space: nowrap; font-weight: 650; letter-spacing: .01em; }
.part[data-sep="usage"]::before { content: "·"; margin: 0 10px; color: var(--muted); }
.part[data-sep="billing"]::before {
  content: ""; display: inline-block; width: 1px; height: 14px; margin: 0 10px; vertical-align: -2px; background: var(--divider);
}
.chevron { color: var(--muted); font-size: 11px; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
  border: 0; border-radius: 7px; color: var(--muted); background: transparent; cursor: pointer;
}
.icon-btn:hover:not(:disabled) { color: var(--text); background: var(--btn-hover); }
.icon-btn:disabled { opacity: .45; cursor: default; }
.icon-btn.round { border-radius: 50%; width: 24px; height: 24px; }
svg.i { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.spin svg.i { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 2px; }
.card {
  pointer-events: auto; width: min(336px, calc(100vw - 24px)); max-height: calc(100vh - 70px); overflow: auto;
  border: 1px solid var(--border); border-radius: 14px; background: var(--card); box-shadow: var(--shadow); backdrop-filter: blur(18px);
}
.header { display: flex; align-items: center; justify-content: space-between; padding: 11px 10px 9px 14px; cursor: grab; touch-action: none; user-select: none; }
.title { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 700; }
.badge { padding: 1px 6px; border-radius: 6px; color: var(--muted); background: var(--btn); font-size: 10px; font-weight: 600; }
.actions { display: flex; gap: 4px; }
.notice { margin: 0 14px 10px; padding: 8px 9px; border-radius: 8px; color: var(--info); background: var(--info-bg); font-size: 11px; }
.notice[data-kind="error"] { color: var(--error); background: var(--error-bg); }
.metrics { padding: 0 14px 3px; }
.metric { padding: 8px 0 11px; }
.metric + .metric { border-top: 1px solid var(--row); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.label { font-weight: 620; }
.value { color: var(--value); font-variant-numeric: tabular-nums; }
.billing .value { color: var(--billing); font-weight: 650; }
.bar { height: 5px; margin: 7px 0 5px; overflow: hidden; border-radius: 99px; background: var(--bar); }
.fill { display: block; height: 100%; width: 0; border-radius: inherit; background: #3d9bff; transition: width .25s ease; }
.fill[data-tone="warning"] { background: #dfa83a; }
.fill[data-tone="danger"] { background: #ed6566; }
.sub { color: var(--faint); font-size: 11px; }
.m-today { cursor: pointer; }
.m-today .value { color: var(--text); font-weight: 650; }
.m-today:hover .sub { color: var(--text); }
.tip .tip-today { margin-top: 3px; padding-top: 4px; border-top: 1px solid var(--tip-border); color: var(--tip); }
.footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px 7px 14px;
  border-top: 1px solid var(--row); color: var(--faint); font-size: 10px;
}
.orb {
  pointer-events: auto; display: inline-flex; gap: 4px; padding: 2px; border: 0; border-radius: 999px;
  background: transparent; cursor: pointer; user-select: none;
}
.ring {
  --p: 0; --c: #35b46f; position: relative; width: 20px; height: 20px; border-radius: 50%;
  background: conic-gradient(from -90deg, var(--c) calc(var(--p) * 1%), var(--track) 0); box-shadow: 0 2px 7px rgba(0,0,0,.22);
}
.ring::after { content: ""; position: absolute; inset: 2.5px; border-radius: inherit; background: var(--core); }
.ring[data-tone="warning"] { --c: #dfa83a; }
.ring[data-tone="danger"] { --c: #ed6566; }
.ring[data-tone="waiting"], .ring[data-tone="neutral"] { --c: #8c8c8c; }
.tip {
  position: absolute; left: 50%; top: calc(100% + 8px); z-index: 3; min-width: 160px; padding: 7px 9px 8px;
  border: 1px solid var(--tip-border); border-radius: 8px; color: var(--tip); background: var(--tip-bg);
  box-shadow: 0 5px 18px rgba(0,0,0,.3); white-space: nowrap; pointer-events: none;
  opacity: 0; visibility: hidden; transform: translate(-50%, -2px); transition: opacity .12s, transform .12s, visibility .12s;
}
:host([data-tip-up]) .tip { top: auto; bottom: calc(100% + 8px); transform: translate(-50%, 2px); }
.tip b { display: block; font-size: 13px; font-weight: 600; }
.tip span { display: block; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.orb:hover + .tip, .orb:focus-visible + .tip { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
.dragging, .dragging * { cursor: grabbing !important; }
@media (prefers-reduced-motion: reduce) { .fill, .tip { transition: none; } .spin svg.i { animation: none; opacity: .55; } }
`;
  var icon2 = (paths) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  var ICONS = {
    refresh: icon2('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
    stats: icon2('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
    minimize: icon2('<path d="M6 12h12"/>'),
    external: icon2('<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/>'),
    settings: icon2('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>')
  };
  var USAGE_HTML = `
<div class="shell">
  <button class="orb" type="button" hidden><span class="ring r-rolling"></span><span class="ring r-monthly"></span></button>
  <span class="tip" role="tooltip" hidden><b class="tip-title"></b><span class="tip-detail"></span><span class="tip-today" hidden></span></span>
  <div class="summary">
    <button class="toggle" type="button" aria-expanded="false"><span class="dot" data-status="waiting"></span><span class="text"></span><span class="chevron">▾</span></button>
    <button class="icon-btn round minimize" type="button">${ICONS.minimize}</button>
  </div>
  <section class="card" hidden>
    <div class="header">
      <div class="title"><span class="title-text"></span><span class="badge" hidden>preview</span></div>
      <div class="actions">
        <button class="icon-btn stats" type="button">${ICONS.stats}</button>
        <button class="icon-btn settings" type="button">${ICONS.settings}</button>
        <button class="icon-btn refresh" type="button">${ICONS.refresh}</button>
      </div>
    </div>
    <div class="notice" hidden></div>
    <div class="metrics">
      <div class="metric m-rolling"><div class="head"><span class="label"></span><span class="value"></span></div><div class="bar"><span class="fill"></span></div><div class="sub"></div></div>
      <div class="metric m-monthly"><div class="head"><span class="label"></span><span class="value"></span></div><div class="bar"><span class="fill"></span></div><div class="sub"></div></div>
      <div class="metric m-today" role="button" tabindex="0" hidden><div class="head"><span class="label"></span><span class="value"></span></div><div class="sub"></div></div>
      <div class="metric billing"><div class="head"><span class="label"></span><span class="value"></span></div><div class="sub"></div></div>
    </div>
    <div class="footer"><span class="updated"></span><button class="icon-btn native" type="button">${ICONS.external}</button></div>
  </section>
</div>`;

  // src/plugins/usage/ui.ts
  var HOST_ID = "notionai-pp-usage";
  var KEYS = {
    anchor: "notionai-pp:usage:anchor:v1",
    expanded: "notionai-pp:usage:expanded:v1",
    minimized: "notionai-pp:usage:minimized:v1",
    legacyAnchor: "notion-ai-usage:position:v2"
  };
  var DEFAULT_ANCHOR = { xEdge: "right", xOffset: 16, yEdge: "top", yOffset: 16 };
  var TIP_SPACE = 64;
  var CARD_GAP = 7;
  var CLICK_GUARD_MS = 500;
  var TICK_MS = 15000;
  function readFlag(key) {
    try {
      return pageWindow.localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }
  function writeFlag(key, value) {
    try {
      pageWindow.localStorage.setItem(key, value ? "1" : "0");
    } catch {}
  }
  function readAnchor() {
    try {
      const storage = pageWindow.localStorage;
      return parseAnchor(safeJson(storage.getItem(KEYS.anchor) ?? "")) ?? parseAnchor(safeJson(storage.getItem(KEYS.legacyAnchor) ?? ""));
    } catch {
      return null;
    }
  }

  class UsageWidget {
    service;
    stats;
    overlay;
    q;
    expanded = readFlag(KEYS.expanded);
    minimized = readFlag(KEYS.minimized);
    anchor = readAnchor() ?? DEFAULT_ANCHOR;
    dragging = false;
    suppressClickUntil = 0;
    tracker = new ComposerTracker((box) => this.layout(box));
    cleanups = [];
    tipToday = false;
    tipTimer = 0;
    constructor(service, stats) {
      this.service = service;
      this.stats = stats;
      this.overlay = createOverlay(HOST_ID, USAGE_CSS, USAGE_HTML);
      const { root } = this.overlay;
      this.q = (selector) => root.querySelector(selector);
      this.bind();
      this.applyMode();
      this.render();
      this.cleanups.push(service.onChange(() => this.render()));
      this.cleanups.push(onRouteChange(() => this.layout()));
      this.tracker.start();
      const tick = setInterval(() => this.render(), TICK_MS);
      const onResize = () => this.layout();
      const onStorage = (event) => this.onStorage(event);
      pageWindow.addEventListener("resize", onResize, { passive: true });
      pageWindow.addEventListener("storage", onStorage);
      this.cleanups.push(() => {
        clearInterval(tick);
        clearTimeout(this.tipTimer);
        pageWindow.removeEventListener("resize", onResize);
        pageWindow.removeEventListener("storage", onStorage);
      });
    }
    destroy() {
      this.tracker.stop();
      for (const cleanup of this.cleanups.splice(0))
        cleanup();
      this.overlay.destroy();
    }
    get host() {
      return this.overlay.host;
    }
    bind() {
      const toggle = this.q(".toggle");
      toggle.addEventListener("click", () => {
        if (Date.now() < this.suppressClickUntil)
          return;
        this.setExpanded(!this.expanded);
      });
      this.q(".minimize").addEventListener("click", () => {
        this.setMinimized(true);
        this.q(".orb").focus({ preventScroll: true });
      });
      this.q(".orb").addEventListener("click", () => {
        this.setMinimized(false);
        toggle.focus({ preventScroll: true });
      });
      const orb = this.q(".orb");
      const showToday = (value) => {
        clearTimeout(this.tipTimer);
        if (!value || !this.stats.enabled())
          return void this.setTipToday(false);
        const delay = this.stats.hoverDelay();
        if (delay <= 0)
          this.setTipToday(true);
        else
          this.tipTimer = setTimeout(() => this.setTipToday(true), delay * 1000);
      };
      orb.addEventListener("pointerenter", () => showToday(true));
      orb.addEventListener("pointerleave", () => showToday(false));
      orb.addEventListener("focus", () => showToday(true));
      orb.addEventListener("blur", () => showToday(false));
      const today = this.q(".m-today");
      today.addEventListener("click", () => openStats(this.stats));
      today.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ")
          return;
        event.preventDefault();
        openStats(this.stats);
      });
      this.q(".stats").addEventListener("click", () => openStats(this.stats));
      this.q(".refresh").addEventListener("click", () => this.service.refreshNow());
      this.q(".settings").addEventListener("click", () => emit("openSettings", undefined));
      this.q(".native").addEventListener("click", () => {
        const url = new URL(pageWindow.location.href);
        url.searchParams.set("target", "aiusage");
        pageWindow.location.assign(url.href);
      });
      this.installDrag(this.q(".summary"), ".minimize");
      this.installDrag(this.q(".header"), "button");
    }
    setTipToday(value) {
      if (value)
        this.stats.refresh();
      this.tipToday = value;
      this.render();
    }
    todayText() {
      if (!this.stats.enabled())
        return null;
      const day = readDay(this.stats.space());
      return day ? statDelta(usedOn(day) ?? 0) : null;
    }
    setExpanded(value) {
      this.expanded = value;
      writeFlag(KEYS.expanded, value);
      this.applyMode();
    }
    setMinimized(value) {
      this.minimized = value;
      writeFlag(KEYS.minimized, value);
      this.applyMode();
    }
    applyMode() {
      this.q(".orb").hidden = !this.minimized;
      this.q(".tip").hidden = !this.minimized;
      this.q(".summary").hidden = this.minimized;
      this.q(".card").hidden = this.minimized || !this.expanded;
      const toggle = this.q(".toggle");
      toggle.setAttribute("aria-expanded", String(this.expanded));
      this.q(".chevron").textContent = this.expanded ? "▴" : "▾";
      this.layout();
    }
    place(point) {
      const { host } = this.overlay;
      host.style.left = `${Math.round(point.left)}px`;
      host.style.top = `${Math.round(point.top)}px`;
      host.style.right = "auto";
    }
    layout(composer = this.tracker.current) {
      if (this.dragging)
        return;
      const { host } = this.overlay;
      host.hidden = isAiRoute() && !composer;
      if (host.hidden)
        return;
      const vp = viewport();
      if (this.minimized) {
        const orb = boxOf(this.q(".orb"));
        const point = composer ? dockPoint(composer, orb, vp) : null;
        host.toggleAttribute("data-docked", !!point);
        host.removeAttribute("data-up");
        if (point) {
          host.dataset.side = "left";
          this.place(point);
          host.toggleAttribute("data-tip-up", vp.height - (point.top + orb.height) < TIP_SPACE);
          return;
        }
      } else {
        host.removeAttribute("data-docked");
      }
      const handle = this.q(this.minimized ? ".orb" : ".summary");
      host.dataset.side = this.anchor.xEdge;
      const handleSize = boxOf(handle);
      const target = pointFromAnchor(this.anchor, vp, handleSize);
      const cardHeight = this.expanded && !this.minimized ? boxOf(this.q(".card")).height + CARD_GAP : 0;
      const handleBox = { ...target, right: target.left + handleSize.width, bottom: target.top + handleSize.height, width: handleSize.width, height: handleSize.height };
      host.toggleAttribute("data-up", cardHeight > 0 && opensUpward(handleBox, cardHeight, vp));
      host.toggleAttribute("data-tip-up", vp.height - handleBox.bottom < TIP_SPACE);
      this.place({ left: 0, top: 0 });
      const hostBox = boxOf(host);
      const handleNow = boxOf(handle);
      this.place({ left: target.left - (handleNow.left - hostBox.left), top: target.top - (handleNow.top - hostBox.top) });
    }
    installDrag(handle, ignore) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary || this.minimized)
          return;
        if (event.target.closest(ignore))
          return;
        const { host } = this.overlay;
        const start = { x: event.clientX, y: event.clientY };
        const origin = boxOf(host);
        const shell = this.q(".shell");
        let moved = false;
        const move = (e) => {
          if (e.pointerId !== event.pointerId)
            return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (!moved && !dragDistanceReached(dx, dy))
            return;
          moved = true;
          this.dragging = true;
          shell.classList.add("dragging");
          const vp = viewport();
          this.place({
            left: Math.min(Math.max(8, origin.left + dx), Math.max(8, vp.width - origin.width - 8)),
            top: Math.min(Math.max(8, origin.top + dy), Math.max(8, vp.height - origin.height - 8))
          });
        };
        const end = (e) => {
          if (e instanceof PointerEvent && e.pointerId !== event.pointerId)
            return;
          pageWindow.removeEventListener("pointermove", move, true);
          pageWindow.removeEventListener("pointerup", end, true);
          pageWindow.removeEventListener("pointercancel", end, true);
          shell.classList.remove("dragging");
          this.dragging = false;
          if (!moved)
            return;
          this.suppressClickUntil = Date.now() + CLICK_GUARD_MS;
          if (e.type === "pointerup") {
            this.anchor = anchorFromBox(boxOf(this.q(".summary")), viewport());
            try {
              pageWindow.localStorage.setItem(KEYS.anchor, JSON.stringify(this.anchor));
            } catch {}
          }
          this.layout();
        };
        pageWindow.addEventListener("pointermove", move, true);
        pageWindow.addEventListener("pointerup", end, true);
        pageWindow.addEventListener("pointercancel", end, true);
      });
    }
    onStorage(event) {
      if (event.key === KEYS.anchor) {
        const anchor = parseAnchor(safeJson(event.newValue ?? ""));
        if (anchor && !this.dragging) {
          this.anchor = anchor;
          this.layout();
        }
      }
    }
    renderMeter(selector, meter, label, now) {
      const row = this.q(selector);
      row.hidden = !meter;
      if (!meter)
        return;
      row.querySelector(".label").textContent = label;
      row.querySelector(".value").textContent = t(`${formatPercent(meter.percent)} 已使用`, `${formatPercent(meter.percent)} used`);
      row.querySelector(".sub").textContent = formatReset(meter.resetAt, now, meter.used);
      const fill = row.querySelector(".fill");
      fill.style.width = `${meter.percent}%`;
      fill.dataset.tone = toneOf(meter.percent);
      row.title = t(`${meter.used} / ${meter.limit}；重置时间：${formatAbsolute(meter.resetAt)}`, `${meter.used} / ${meter.limit}; resets: ${formatAbsolute(meter.resetAt)}`);
    }
    renderSummary(parts) {
      const container = this.q(".text");
      const signature = parts.map((p) => `${p.sep ?? ""}:${p.text}`).join("|");
      if (container.dataset.signature === signature)
        return;
      container.dataset.signature = signature;
      container.replaceChildren(...parts.map((part) => {
        const span = document.createElement("span");
        span.className = "part";
        if (part.sep)
          span.dataset.sep = part.sep;
        span.textContent = part.text;
        return span;
      }));
      this.layout();
    }
    render() {
      const now = Date.now();
      const { snapshot, loading, error, canRefresh, spaceId } = this.service.state;
      const billing = visibleBilling(this.service.state.billing, now);
      const billingPart = billingSummary(billing, now);
      const views = meterViews(snapshot, now);
      this.q(".title-text").textContent = t("Notion AI 用量", "Notion AI Usage");
      const badge = this.q(".badge");
      badge.hidden = !snapshot?.preview;
      badge.title = t("Notion 当前将此额度标记为 preview。", "Notion currently marks this allowance as preview.");
      const refresh = this.q(".refresh");
      refresh.disabled = !canRefresh;
      refresh.classList.toggle("spin", loading);
      refresh.setAttribute("aria-label", loading ? t("正在读取", "Loading") : t("刷新", "Refresh"));
      refresh.title = refresh.getAttribute("aria-label");
      for (const [selector, zh, en] of [
        [".minimize", "最小化至输入框底部", "Minimize to the composer"],
        [".settings", "NotionAI++ 设置", "NotionAI++ settings"],
        [".stats", "按日期查看用量", "Usage by date"],
        [".native", "打开原生用量页", "Open native Usage page"]
      ]) {
        const button = this.q(selector);
        button.setAttribute("aria-label", t(zh, en));
        button.title = t(zh, en);
      }
      for (const [selector, view] of [[".r-rolling", views.rolling], [".r-monthly", views.monthly]]) {
        const ring = this.q(selector);
        ring.style.setProperty("--p", String(view.percent ?? 0));
        ring.dataset.tone = view.tone;
      }
      const rollingText = formatPercent(views.rolling.percent);
      const monthlyText = formatPercent(views.monthly.percent);
      this.q(".tip-title").textContent = t("AI 用量", "AI usage");
      this.q(".tip-detail").textContent = t(`6 小时 ${rollingText} · 月度 ${monthlyText}`, `6h ${rollingText} · Monthly ${monthlyText}`);
      const todayText = this.todayText();
      const tipToday = this.q(".tip-today");
      tipToday.hidden = !this.tipToday || todayText === null;
      tipToday.textContent = t(`今天 ${todayText} 月度额度`, `Today ${todayText} of monthly allowance`);
      const todayRow = this.q(".m-today");
      todayRow.hidden = todayText === null || !snapshot || snapshot.status === "not_applicable" || !activeMonthly(snapshot, now);
      todayRow.querySelector(".label").textContent = t("今日用量", "Used today");
      todayRow.querySelector(".value").textContent = t(`${todayText} 月度额度`, `${todayText} of monthly`);
      todayRow.querySelector(".sub").textContent = t("点击按日期查看用量 →", "Click for usage by date →");
      this.q(".orb").setAttribute("aria-label", !snapshot ? t("AI 用量：6 小时与月度等待读取，点击恢复", "AI usage: 6h and Monthly waiting, click to restore") : snapshot.status === "not_applicable" ? t("AI 用量：6 小时与月度均不适用，点击恢复", "AI usage: 6h and Monthly are not applicable, click to restore") : snapshot.status === "rate_limited" ? t(`AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，已达上限，点击恢复`, `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, limit reached, click to restore`) : t(`AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，点击恢复`, `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, click to restore`));
      const notice = this.q(".notice");
      const dot = this.q(".dot");
      const billingPiece = billingPart ? [{ text: billingPart, sep: "billing" }] : [];
      let noticeText = "";
      let noticeKind = error ? "error" : "info";
      if (!snapshot) {
        this.renderSummary([{ text: loading ? t("读取中", "Loading") : t("等待", "Waiting") }, ...billingPiece]);
        dot.dataset.status = error ? "error" : "waiting";
        noticeText = error || (spaceId ? t("正在读取 Notion AI 用量…", "Loading Notion AI usage…") : t("等待 Notion 初始化当前工作区；也可以打开原生用量页触发读取。", "Waiting for Notion to initialize this workspace. You can also open the native Usage page."));
        this.renderMeter(".m-rolling", null, "", now);
        this.renderMeter(".m-monthly", null, "", now);
      } else if (snapshot.status === "not_applicable") {
        this.renderSummary([{ text: t("不适用", "Not applicable") }, ...billingPiece]);
        dot.dataset.status = "neutral";
        noticeText = error || t("Notion 返回 not_applicable：当前账户或套餐没有可展示的 AI 用量窗口。", "Notion returned not_applicable: this account or plan has no AI usage window to display.");
        this.renderMeter(".m-rolling", null, "", now);
        this.renderMeter(".m-monthly", null, "", now);
      } else {
        const monthly = activeMonthly(snapshot, now);
        this.renderSummary([
          { text: formatPercent(snapshot.rolling.percent) },
          ...monthly ? [{ text: formatPercent(monthly.percent), sep: "usage" }] : [],
          ...billingPiece
        ]);
        dot.dataset.status = snapshot.status === "rate_limited" || error ? "error" : "ok";
        this.renderMeter(".m-rolling", snapshot.rolling, windowLabel(snapshot.rolling.window), now);
        this.renderMeter(".m-monthly", monthly, t("月度用量", "Monthly usage"), now);
        if (snapshot.status === "rate_limited") {
          noticeKind = "error";
          noticeText = snapshot.limitedBy === "billing_period" ? t("已达到月度额度上限。", "The monthly allowance has been reached.") : t("已达到当前滚动窗口的额度上限。", "The rolling-window allowance has been reached.");
          if (error)
            noticeText += ` ${error}`;
        } else if (error) {
          noticeText = t(`${error}（继续显示最后一次有效数据）`, `${error} (showing the last valid data)`);
        }
      }
      notice.hidden = !noticeText;
      notice.dataset.kind = noticeKind;
      notice.textContent = noticeText;
      const billingRowEl = this.q(".billing");
      billingRowEl.hidden = !billing;
      if (billing) {
        const row = billingRow(billing, now);
        billingRowEl.querySelector(".label").textContent = row.label;
        billingRowEl.querySelector(".value").textContent = row.value;
        const sub = billingRowEl.querySelector(".sub");
        sub.textContent = row.detail;
        sub.hidden = !row.detail;
        billingRowEl.dataset.kind = billing.kind;
        billingRowEl.title = row.tooltip;
      }
      const updatedAt = Math.max(snapshot?.updatedAt ?? 0, billing?.updatedAt ?? 0) || null;
      this.q(".updated").textContent = updatedAt ? t(`${formatUpdated(updatedAt, now)} · Notion 同源接口`, `${formatUpdated(updatedAt, now)} · Notion same-origin API`) : t("尚未取得有效数据", "No valid data yet");
      if (!this.minimized)
        this.layout();
    }
  }

  // src/plugins/usage/index.ts
  var settings5 = definePluginSettings({
    usageStats: {
      type: "boolean",
      label: "记录每日用量 / Daily usage stats",
      description: "按天记录月度额度的使用量；悬停最小化圆环显示今天，点卡片里的统计按钮查看历史 / Log monthly-allowance use per day; hover the minimized rings for today, open history from the card",
      default: true
    },
    hoverStatsDelay: {
      type: "number",
      label: "悬停显示今日用量的延迟（秒） / Hover delay for today (seconds)",
      default: HOVER_DELAY.default,
      min: HOVER_DELAY.min,
      max: HOVER_DELAY.max
    },
    retainDays: {
      type: "number",
      label: "保留历史天数 / Days of history to keep",
      default: RETAIN.default,
      min: RETAIN.min,
      max: RETAIN.max
    },
    openStats: {
      type: "action",
      label: "按日期查看用量 / Usage by date",
      button: "打开 / Open",
      run: () => openStats(stats)
    },
    clearStats: {
      type: "action",
      label: "清空用量历史 / Clear usage history",
      description: "删除本设备上记录的每日用量 / Delete the daily usage recorded on this device",
      button: "清空… / Clear…",
      run: () => openStats(stats, { confirmClearNow: true })
    }
  });
  var service = null;
  var widget = null;
  var stopRecording = null;
  function record() {
    const snapshot = service?.snapshot;
    const space = service?.spaceId;
    if (!settings5.store.usageStats || !space || !snapshot || snapshot.status === "not_applicable")
      return;
    const monthly = activeMonthly(snapshot);
    if (monthly)
      recordSnapshot(space, monthly.percent, monthly.resetAt, settings5.store.retainDays);
  }
  var stats = {
    space: () => service?.spaceId ?? "",
    enabled: () => settings5.store.usageStats,
    setEnabled: (value) => void (settings5.store.usageStats = value),
    retain: () => settings5.store.retainDays,
    hoverDelay: () => settings5.store.hoverStatsDelay,
    refresh: record
  };
  function mount() {
    if (!service || widget || !document.body)
      return;
    widget = new UsageWidget(service, stats);
  }
  var usage_default = definePlugin({
    name: "usageMeter",
    title: "AI 用量 / AI usage",
    description: "显示 Notion AI 6 小时与月度用量、套餐与试用状态，并按天统计月度额度的使用量；最小化后双圆环贴在 AI 输入框底部中央。",
    icon: Icons.gauge,
    tags: ["composer"],
    enabledByDefault: true,
    startAt: "DocumentStart" /* DocumentStart */,
    settings: settings5,
    start() {
      service = new UsageService;
      stopRecording = service.onChange(record);
      service.start();
      if (document.body)
        mount();
      else
        document.addEventListener("DOMContentLoaded", mount, { once: true });
    },
    stop() {
      document.removeEventListener("DOMContentLoaded", mount);
      stopRecording?.();
      closeStats();
      widget?.destroy();
      service?.stop();
      stopRecording = null;
      widget = null;
      service = null;
    },
    onSettingsChange() {
      record();
      widget?.render();
    }
  });

  // src/index.ts
  var FLAG = "__notionAiPlusPlus";
  var logger5 = new Logger("Core");
  function boot() {
    const win = pageWindow;
    if (win[FLAG] || !isTopmostNotionDocument())
      return;
    win[FLAG] = "[20261007] v1.1.4";
    installHooks();
    registerPlugins([settings_default, usage_default, navigator_default, autoCollapseThinking_default, focusHighlight_default, greetingCustomizer_default]);
    startPlugins("DocumentStart" /* DocumentStart */);
    const ready = () => startPlugins("DomReady" /* DomReady */);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", ready, { once: true });
    else
      ready();
    pageWindow.addEventListener("storage", (event) => event.key === SETTINGS_KEY && reloadFromStorage(event.newValue));
    logger5.info(`NotionAI++ ${"[20261007] v1.1.4"} started`);
  }
  boot();
})();
