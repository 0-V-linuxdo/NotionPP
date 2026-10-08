// ==UserScript==
// @name         NotionAI++
// @namespace    https://github.com/0-V-linuxdo/NotionPP
// @version      20261007.1.5.0
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
  var logger = new Logger("Settings");
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
      logger.warn("Settings could not be saved:", error);
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
        logger.error("Settings listener failed:", error);
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
          logger.error("Settings listener failed:", error);
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
    const chosen = getValue("settings", "language");
    if (chosen === "zh" || chosen === "en")
      return chosen;
    return /^zh(?:-|$)/i.test(document.documentElement?.lang ?? "") ? "zh" : "en";
  }
  var t = (zh, en) => uiLanguage() === "zh" ? zh : en;
  var tr = (text) => typeof text === "string" ? text : t(text.zh, text.en);
  function trustedHtml(html) {
    const policy = globalThis.ADG_policyApi;
    try {
      if (policy && typeof policy.createHTML === "function")
        return policy.createHTML(html);
    } catch {}
    return html;
  }

  // src/api/Network.ts
  var logger2 = new Logger("Network");
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
        logger2.error("Network observer failed:", error);
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
      logger2.warn("fetch hook unavailable:", error);
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
      logger2.warn("XHR hook unavailable:", error);
    }
  }
  function nativeFetch() {
    return original ?? pageWindow.fetch.bind(pageWindow);
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
    pencil: `<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>`,
    trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
    check: `<path d="M20 6 9 17l-5-5"/>`,
    chevronDown: `<path d="m6 9 6 6 6-6"/>`,
    bell: `<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>`,
    browser: `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>`,
    history: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
    width: `<path d="M21 12H3"/><path d="m15 6 6 6-6 6"/><path d="m9 18-6-6 6-6"/>`,
    shareOff: `<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m2 2 20 20"/>`,
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
      label: { zh: "折叠时机", en: "When to collapse" },
      description: { zh: "回复完成后折叠，或生成过程中就折叠", en: "After the reply finishes, or while it is still writing" },
      default: "finished",
      options: [
        { value: "finished", label: { zh: "回复完成后", en: "After the reply" } },
        { value: "immediate", label: { zh: "立即（含生成中）", en: "Immediately" } }
      ]
    },
    collapseHistory: {
      type: "boolean",
      label: { zh: "折叠历史回复", en: "Collapse earlier replies" },
      description: { zh: "打开对话时，也折叠已经展开的旧回复思考", en: "Also collapse expanded thinking in replies already on the page" },
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
    title: { zh: "自动折叠 AI 思考", en: "Auto-collapse AI thinking" },
    description: {
      zh: "Notion AI 回复完成后，自动折叠它的思考步骤（“N steps”）。手动展开过的不会再被折叠。",
      en: `Collapses Notion AI's thinking steps ("N steps") once a reply finishes. Steps you expand stay open.`
    },
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
      label: { zh: "普通模式", en: "Light mode" },
      default: "#37352f"
    },
    darkColor: {
      type: "color",
      label: { zh: "黑暗模式", en: "Dark mode" },
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
    title: { zh: "输入框高亮色", en: "Composer highlight" },
    description: {
      zh: "给 Notion AI 输入框描一圈自定义颜色（普通、黑暗模式各一种）。在输入框右侧空白处连按两次右键，可打开取色面板。",
      en: "Outlines the Notion AI composer in a color of your choice, one for light mode and one for dark. Double right-click the empty right side of the composer to pick a color."
    },
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
  var STRINGS = {
    title: ["管理问候语", "Manage greetings"],
    subtitle: ["首页问候语会在这些文案之间轮播。在首页双击右键问候语也能打开这里。", "The home greeting rotates through these lines. Double right-click the greeting on home to open this too."],
    close: ["关闭", "Close"],
    newSection: ["添加问候语", "Add a greeting"],
    editSection: ["修改问候语", "Edit greeting"],
    placeholder: [`输入问候语，可换行，最多 ${MAX_LEN} 字`, `Type a greeting. Line breaks are fine, up to ${MAX_LEN} characters`],
    add: ["添加", "Add"],
    cancelEdit: ["取消", "Cancel"],
    saveEdit: ["保存", "Save"],
    listSection: ["问候语（{count}/{max}）", "Greetings ({count}/{max})"],
    current: ["当前", "Current"],
    edit: ["修改", "Edit"],
    delete: ["删除", "Delete"],
    empty: ["问候语不能为空。", "A greeting can't be empty."],
    tooLong: [`单条问候语不能超过 ${MAX_LEN} 字。`, `A greeting can't be longer than ${MAX_LEN} characters.`],
    tooMany: [`最多只能保存 ${MAX_COUNT} 条问候语。`, `You can save up to ${MAX_COUNT} greetings.`],
    rotation: ["轮播", "Rotation"],
    done: ["完成", "Done"],
    clickHint: ["点击切换问候语", "Click to switch the greeting"]
  };
  function tr2(key, vars = {}) {
    const [zh, en] = STRINGS[key];
    return t(zh, en).replace(/\{(\w+)\}/g, (match, name) => (name in vars) ? String(vars[name]) : match);
  }

  // src/plugins/settings/styles.ts
  var CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block;
  --surface-base: #ffffff; --surface-l1: #ffffff; --surface-l2: #fbfbfa; --surface-hover: rgba(55,53,47,.06);
  --surface-field: rgba(242,241,238,.6);
  --border-l1: rgba(55,53,47,.09); --border-l2: rgba(55,53,47,.16);
  --fg-primary: #37352f; --fg-secondary: #787774; --fg-tertiary: #a5a29a; --fg-invert: #ffffff;
  --accent: #2383e2; --accent-hover: #0077d4; --switch-off: rgba(135,131,120,.3);
  --fg-danger: #eb5757; --fg-warning: #d9730d; --overlay: rgba(15,15,15,.6);
  --shadow: 0 0 0 1px rgba(15,15,15,.05), 0 24px 48px rgba(15,15,15,.2);
  color-scheme: light;
  font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg-primary); }
:host([data-theme="dark"]) {
  --surface-base: #191919; --surface-l1: #202020; --surface-l2: #252525; --surface-hover: rgba(255,255,255,.055);
  --surface-field: rgba(255,255,255,.055);
  --border-l1: rgba(255,255,243,.082); --border-l2: rgba(255,255,235,.1);
  --fg-primary: #f0efed; --fg-secondary: #ada9a3; --fg-tertiary: #7d7a75; --fg-invert: #191919;
  --accent: #2783de; --accent-hover: #3b8fe2; --switch-off: rgba(202,204,206,.3);
  --fg-danger: #ff7369; --overlay: rgba(0,0,0,.6);
  --shadow: 0 0 0 1px #383836, 0 24px 48px rgba(25,25,25,.64);
  color-scheme: dark; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
svg { width: 1rem; height: 1rem; flex-shrink: 0; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--fg-primary) 55%, transparent); outline-offset: 1px; }

.layer { position: fixed; inset: 0; display: grid; place-items: center; padding: 1rem; }
.layer-root { background: var(--overlay); }
.layer-nested { background: transparent; }
.layer-confirm { background: color-mix(in srgb, var(--overlay) 60%, transparent); }

/* Buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: .375rem; height: 28px; padding: 0 10px;
  border-radius: 6px; border: 1px solid transparent; font-size: 14px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  transition: background-color .12s, border-color .12s, color .12s; }
.btn:disabled { opacity: .5; cursor: default; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-secondary { background: transparent; border-color: var(--border-l2); }
.btn-secondary:hover:not(:disabled) { background: var(--surface-hover); }
.btn-tertiary { background: transparent; }
.btn-tertiary:hover:not(:disabled) { background: var(--surface-hover); }
.btn-danger { background: transparent; color: var(--fg-danger); border-color: color-mix(in srgb, var(--fg-danger) 50%, transparent); }
.btn-danger:hover { background: color-mix(in srgb, var(--fg-danger) 10%, transparent); }
.btn-square { width: 28px; padding: 0; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 1.75rem; height: 1.75rem; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-tertiary); cursor: pointer; }
.icon-btn:hover { background: var(--surface-hover); color: var(--fg-primary); }
.icon-btn.active { color: var(--fg-primary); }
.icon-btn svg { width: .9375rem; height: .9375rem; }

/* Switch (Notion: 30×18 track, 14px thumb, blue when on) */
.switch { position: relative; flex-shrink: 0; width: 30px; height: 18px; margin: 0; padding: 0; border: 0; border-radius: 44px;
  background: var(--switch-off); cursor: pointer; transition: background-color .2s; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(15,15,15,.2); transition: transform .2s ease-out; }
.switch[aria-checked="true"] { background: var(--accent); }
.switch[aria-checked="true"]::after { transform: translateX(12px); }
.switch:disabled { cursor: default; opacity: .6; }

/* Inputs */
.input { height: 32px; border-radius: 6px; border: 1px solid var(--border-l2); background: var(--surface-field);
  color: var(--fg-primary); font: inherit; font-size: 14px; padding: 0 10px; }
.input::placeholder { color: var(--fg-tertiary); }
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

/* Main dialog: nav + content */
.dialog { position: relative; display: flex; width: min(56rem, calc(100vw - 2rem)); height: min(40rem, calc(100vh - 2rem));
  border-radius: 12px; border: 0; background: var(--surface-l1); box-shadow: var(--shadow); overflow: hidden; }
.nav { position: relative; flex: 0 0 13rem; display: flex; flex-direction: column; gap: .125rem; padding: 1rem .75rem;
  background: var(--surface-l2); border-right: 1px solid var(--border-l1); }
.nav-group { padding: .25rem .5rem .375rem; font-size: .75rem; font-weight: 500; color: var(--fg-tertiary); }
.nav-item { display: flex; align-items: center; gap: .5rem; height: 28px; padding: 0 6px; border: 0; border-radius: 6px;
  background: transparent; color: var(--fg-secondary); font-size: 14px; font-weight: 500; text-align: left; cursor: pointer; }
.nav-item:hover { background: var(--surface-hover); color: var(--fg-primary); }
.nav-item[aria-current="page"] { background: var(--surface-hover); color: var(--fg-primary); font-weight: 500; }
.version { position: absolute; left: 0; right: 0; bottom: 0; padding: .75rem; font-size: .625rem; line-height: 1rem;
  color: var(--fg-secondary); opacity: .45; user-select: text; }
.version a { color: inherit; text-decoration: none; } .version a:hover { text-decoration: underline; }
.content { position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; padding-top: 1.25rem; }
.content-head { display: flex; align-items: center; gap: .375rem; padding: 0 3.5rem 0 1.25rem; margin-bottom: 1rem; }
.content-head h2 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
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
.search-bar .dropdown-field { flex-shrink: 0; min-width: 7.5rem; }
.list { flex: 1; min-height: 0; overflow-y: auto; margin-inline: -1.25rem; padding: .25rem 1.25rem 2rem; display: flex; flex-direction: column; gap: 1rem;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 .75rem, #000 calc(100% - 1.5rem), transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 .75rem, #000 calc(100% - 1.5rem), transparent); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
.separator { height: 1px; flex-shrink: 0; background: var(--border-l1); }
.empty { padding: 2rem 0; text-align: center; color: var(--fg-secondary); }
@media (max-width: 40rem) {
  .grid { grid-template-columns: minmax(0, 1fr); }
  .dialog { flex-direction: column; }
  .nav { flex: 0 0 auto; flex-direction: row; flex-wrap: wrap; padding: .5rem .75rem; border-right: 0; border-bottom: 1px solid var(--border-l1); }
  .nav-group, .version { display: none; }
}

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
.card-title { min-width: 0; flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 20px; font-weight: 500; }
.badge { display: inline-flex; color: var(--fg-tertiary); } .badge svg { width: .8125rem; height: .8125rem; }
.badge.danger { color: var(--fg-danger); }
.card-controls { display: flex; align-items: center; gap: .375rem; flex-shrink: 0; }
.card-controls .icon-btn { width: 1.5rem; height: 1.5rem; } .card-controls .icon-btn svg { width: .875rem; height: .875rem; }

.card-desc { margin-top: .25rem; font-size: 13px; line-height: 1.5; color: var(--fg-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-footer { display: flex; align-items: center; gap: .375rem; padding: .375rem .75rem; border-top: 1px solid var(--border-l1); min-width: 0; }
.card-author { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .7rem; color: var(--fg-tertiary); }

/* Nested dialogs (Void++ VoidPPDialogShell, Notion metrics) */
.sheet { position: relative; display: flex; flex-direction: column; gap: 20px; width: min(36rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem); padding: 28px 32px 24px; border-radius: 12px; border: 0;
  background: var(--surface-l1); box-shadow: var(--shadow); overflow: hidden; }
.sheet-sm { width: min(28rem, calc(100vw - 2rem)); gap: 16px; padding: 24px; }
.sheet-head { padding-right: 2rem; }
.sheet-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; }
.sheet-desc { margin: 4px 0 0; font-size: 14px; line-height: 20px; color: var(--fg-secondary); }
.sheet-body { display: flex; flex-direction: column; gap: 28px; min-height: 0; overflow-y: auto; margin: 0 -32px -24px; padding: 0 32px 24px; }
.sheet > .close { top: 18px; right: 18px; }
.field { display: flex; flex-direction: column; gap: .25rem; min-height: 0; }
.field-label { font-size: 14px; font-weight: 500; }
.field-text { margin: 0; font-size: 14px; color: var(--fg-secondary); }
.footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }

/* Sections and rows (Notion Settings: section title over a hairline, 24px between rows) */
.section { display: flex; flex-direction: column; }
.section-title { margin: 0 0 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-l1);
  font-size: 16px; line-height: 24px; font-weight: 500; color: var(--fg-primary); }
.settings-list { display: flex; flex-direction: column; gap: 24px; }
.settings-list[data-off] { opacity: .55; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 28px; }
.row-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.row-control { flex: 0 1 auto; min-width: 0; max-width: 50%; display: flex; justify-content: flex-end; }
.stack { display: flex; flex-direction: column; gap: .5rem; }
.s-title { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--fg-primary); }
.s-desc { font-size: 13px; line-height: 18px; color: var(--fg-secondary); }
.color { display: flex; align-items: center; gap: 8px; }
.color input { width: 28px; height: 28px; padding: 2px; border: 1px solid var(--border-l2); border-radius: 6px; background: transparent; cursor: pointer; }
.color input::-webkit-color-swatch-wrapper { padding: 0; } .color input::-webkit-color-swatch { border: 0; border-radius: 4px; }
.color input::-moz-color-swatch { border: 0; border-radius: 4px; }
.color-value { font-size: 14px; color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
.number { width: 5rem; text-align: right; }

/* Dropdown (Notion: borderless value + chevron, options in a popup menu) */
.dropdown { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 28px; padding: 0 6px 0 8px; border: 0;
  border-radius: 6px; background: transparent; color: var(--fg-primary); font-size: 14px; font-weight: 500; cursor: pointer; }
.dropdown:hover, .dropdown[aria-expanded="true"] { background: var(--surface-hover); }
.dropdown-field { justify-content: space-between; height: 32px; padding: 0 8px 0 10px; border: 1px solid var(--border-l2);
  background: var(--surface-field); font-weight: 400; }
.dropdown-field:hover, .dropdown-field[aria-expanded="true"] { background: var(--surface-field); border-color: color-mix(in srgb, var(--fg-primary) 30%, transparent); }
.dropdown-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dropdown svg { width: 14px; height: 14px; color: var(--fg-tertiary); }
.layer-menu { display: block; padding: 0; background: transparent; }
.menu { position: fixed; display: flex; flex-direction: column; gap: 1px; max-width: min(20rem, calc(100vw - 16px));
  max-height: min(20rem, calc(100vh - 16px)); overflow-y: auto; padding: 4px; border-radius: 10px; background: var(--surface-l1);
  box-shadow: var(--shadow); }
.menu-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; padding: 4px 8px;
  border: 0; border-radius: 6px; background: transparent; color: var(--fg-primary); font-size: 14px; line-height: 20px; text-align: left; cursor: pointer; }
.menu-item:hover, .menu-item:focus-visible { background: var(--surface-hover); outline: none; }
.menu-label { white-space: normal; }
.menu-item svg { width: 14px; height: 14px; color: var(--fg-primary); }
.row .input { height: 28px; }
.dialog:focus, .sheet:focus { outline: none; }
.prefs { gap: 0; padding-top: .25rem; }
@media (max-width: 32rem) {
  .sheet { padding: 20px 20px 16px; }
  .sheet-body { margin: 0 -20px -16px; padding: 0 20px 16px; }
  .row { flex-wrap: wrap; gap: 8px 16px; }
  .row-control { max-width: 100%; }
  .row-control .dropdown { margin-left: -8px; }
}

/* About tab */
.about { display: flex; flex-direction: column; gap: .75rem; overflow-y: auto; padding-bottom: 1.5rem; }
.about p { margin: 0; color: var(--fg-secondary); font-size: .875rem; line-height: 1.6; }
.about a { color: var(--fg-primary); }
`;

  // src/utils/kit.ts
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
  function row(title, description, control) {
    return h("div", { class: "row" }, h("div", { class: "row-body" }, h("div", { class: "s-title" }, title), description && h("div", { class: "s-desc" }, description)), h("div", { class: "row-control" }, control));
  }
  function section(title, ...children) {
    return h("section", { class: "section" }, h("h4", { class: "section-title" }, title), ...children);
  }
  function selectControl(label, options, value, onChange, variant = "plain") {
    let current = value;
    const text = h("span", { class: "dropdown-value" });
    const trigger = h("button", { type: "button", class: variant === "field" ? "dropdown dropdown-field" : "dropdown", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": label }, text, icon(Icons.chevronDown));
    const sync = () => {
      const chosen = options.find((o) => o.value === current) ?? options[0];
      text.textContent = chosen?.label ?? "";
      trigger.title = chosen?.label ?? "";
    };
    sync();
    trigger.addEventListener("click", () => {
      const pick = (next) => {
        close();
        trigger.focus();
        if (next === current)
          return;
        current = next;
        sync();
        onChange(next);
      };
      const items = options.map((o) => h("button", {
        type: "button",
        role: "option",
        class: "menu-item",
        "aria-selected": String(o.value === current),
        "data-value": o.value,
        onclick: () => pick(o.value)
      }, h("span", { class: "menu-label" }, o.label), o.value === current && icon(Icons.check)));
      const menu = h("div", { class: "menu", role: "listbox", "aria-label": label }, ...items);
      const layer = h("div", { class: "layer layer-menu" }, menu);
      const close = () => {
        layer.remove();
        trigger.setAttribute("aria-expanded", "false");
      };
      layer.addEventListener("mousedown", (event) => event.target === layer && close());
      menu.addEventListener("keydown", (event) => {
        const { key } = event;
        if (key === "Escape" || key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger.focus();
          return;
        }
        if (key !== "ArrowDown" && key !== "ArrowUp")
          return;
        event.preventDefault();
        const index = items.indexOf(menu.querySelector(".menu-item:focus") ?? items[0]);
        items[(index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      });
      trigger.getRootNode().append?.(layer);
      if (!layer.isConnected)
        document.body.append(layer);
      trigger.setAttribute("aria-expanded", "true");
      placeMenu(menu, trigger.getBoundingClientRect());
      (items.find((item) => item.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
    });
    return trigger;
  }
  var MENU_GAP = 4;
  function placeMenu(menu, anchor) {
    const width = Math.max(anchor.width, menu.offsetWidth);
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    const below = anchor.bottom + MENU_GAP;
    const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, anchor.top - MENU_GAP - menu.offsetHeight) : below;
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px`, minWidth: `${anchor.width}px` });
  }
  function optionRow(def, value, set) {
    const title = tr(def.label);
    const description = def.description && tr(def.description);
    switch (def.type) {
      case "boolean":
        return row(title, description, switchControl(Boolean(value), title, set));
      case "select":
        return row(title, description, selectControl(title, def.options.map((o) => ({ value: o.value, label: tr(o.label) })), String(value), set));
      case "color": {
        const text = h("span", { class: "color-value" }, String(value));
        const input = h("input", { type: "color", value: String(value), "aria-label": title });
        input.addEventListener("input", () => {
          text.textContent = input.value.toLowerCase();
          set(input.value.toLowerCase());
        });
        return row(title, description, h("div", { class: "color" }, text, input));
      }
      case "number": {
        const input = h("input", { type: "number", class: "input number", min: String(def.min), max: String(def.max), step: "1", value: String(value), "aria-label": title });
        input.addEventListener("change", () => {
          const next = Math.min(def.max, Math.max(def.min, Math.round(Number(input.value) || def.default)));
          input.value = String(next);
          set(next);
        });
        return row(title, description, input);
      }
      case "action":
        return row(title, description, button("secondary", tr(def.button), () => def.run()));
    }
  }

  // src/plugins/greetingCustomizer/manager.ts
  var MANAGER_HOST_ID = "notionai-pp-greetings";
  var CSS2 = `${CSS}
.layer-root { background: var(--overlay); }
.textarea { width: 100%; min-height: 84px; resize: vertical; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-l2);
  background: var(--surface-field); color: var(--fg-primary); font: inherit; font-size: 14px; line-height: 20px; }
.textarea::placeholder { color: var(--fg-tertiary); }
.textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.editor { display: flex; flex-direction: column; gap: 8px; }
.editor-actions { display: flex; align-items: center; gap: 8px; }
.counter { margin-right: auto; font-size: 12px; color: var(--fg-tertiary); font-variant-numeric: tabular-nums; }
.error { font-size: 13px; line-height: 18px; color: var(--fg-danger); }
.greetings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.greetings li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 4px 8px 0; border-bottom: 1px solid var(--border-l1); }
.greetings li:last-child { border-bottom: 0; }
.greetings li[data-editing] { background: var(--surface-hover); border-radius: 6px; padding-left: 8px; }
.greeting-text { flex: 1; min-width: 0; padding-top: 4px; font-size: 14px; line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tag { flex-shrink: 0; margin-top: 4px; padding: 0 6px; border-radius: 4px; font-size: 12px; line-height: 20px;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.greetings .icon-btn { flex-shrink: 0; }
`;
  var overlay = null;
  function closeManager() {
    overlay?.destroy();
    overlay = null;
  }
  function openManager(rotation, currentIndex) {
    closeManager();
    overlay = createOverlay(MANAGER_HOST_ID, CSS2, "");
    const { root } = overlay;
    root.addEventListener("keydown", (event) => event.key === "Escape" && closeManager());
    let greetings = loadGreetings();
    let editing = -1;
    const textarea = h("textarea", { class: "textarea", placeholder: tr2("placeholder"), maxLength: MAX_LEN, "aria-label": tr2("newSection") });
    const error = h("div", { class: "error", role: "alert" });
    const counter = h("span", { class: "counter" });
    const submit = button("primary", tr2("add"), () => submitGreeting());
    const cancel = button("secondary", tr2("cancelEdit"), () => {
      stopEditing();
      setError(null);
      render();
    });
    const editorTitle = h("h4", { class: "section-title" });
    const editor = h("section", { class: "section" }, editorTitle, h("div", { class: "editor" }, textarea, error, h("div", { class: "editor-actions" }, counter, cancel, submit)));
    const listTitle = h("h4", { class: "section-title" });
    const list = h("ul", { class: "greetings" });
    const setError = (key) => {
      error.textContent = key ? tr2(key) : "";
      error.hidden = !key;
    };
    const syncCounter = () => void (counter.textContent = `${textarea.value.length}/${MAX_LEN}`);
    const stopEditing = () => {
      editing = -1;
      textarea.value = "";
      syncEditor();
    };
    const syncEditor = () => {
      editorTitle.textContent = tr2(editing >= 0 ? "editSection" : "newSection");
      submit.textContent = tr2(editing >= 0 ? "saveEdit" : "add");
      cancel.hidden = editing < 0;
      syncCounter();
    };
    function persist() {
      saveGreetings(greetings);
      greetings = loadGreetings();
    }
    function render() {
      listTitle.textContent = tr2("listSection", { count: greetings.length, max: MAX_COUNT });
      const current = currentIndex();
      list.replaceChildren(...greetings.map((greeting, index) => {
        const item = h("li", {}, h("div", { class: "greeting-text" }, greeting), index === current && h("span", { class: "tag" }, tr2("current")), iconButton(Icons.pencil, tr2("edit"), () => {
          editing = index;
          textarea.value = greetings[index];
          setError(null);
          syncEditor();
          render();
          textarea.focus();
        }), iconButton(Icons.trash, tr2("delete"), () => {
          greetings.splice(index, 1);
          if (editing === index)
            stopEditing();
          else if (editing > index)
            editing--;
          persist();
          render();
        }));
        item.toggleAttribute("data-editing", index === editing);
        return item;
      }));
    }
    function submitGreeting() {
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
    }
    textarea.addEventListener("input", syncCounter);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
        submitGreeting();
    });
    const rotationList = h("div", { class: "settings-list" });
    const renderRotation = () => {
      const keys = ["mode", "order", "intervalSec"];
      rotationList.replaceChildren(...keys.map((key) => optionRow(rotation.defs[key], rotation.get(key), (value) => {
        rotation.set(key, value);
        if (key === "mode")
          renderRotation();
      })));
      const interval = rotationList.querySelector("input[type=number]");
      if (interval)
        interval.disabled = rotation.get("mode") !== "interval";
    };
    renderRotation();
    const close = iconButton(Icons.x, tr2("close"), closeManager);
    close.classList.add("close");
    const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": tr2("title") }, close, h("div", { class: "sheet-head" }, h("h3", { class: "sheet-title" }, tr2("title")), h("p", { class: "sheet-desc" }, tr2("subtitle"))), h("div", { class: "sheet-body" }, editor, h("section", { class: "section" }, listTitle, list), section(tr2("rotation"), rotationList), h("div", { class: "footer" }, button("primary", tr2("done"), closeManager))));
    const layer = h("div", { class: "layer layer-root" }, sheet);
    layer.addEventListener("mousedown", (event) => event.target === layer && closeManager());
    root.append(layer);
    stopEditing();
    setError(null);
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
      label: { zh: "问候语列表", en: "Greetings" },
      description: { zh: "添加、修改或删除问候语", en: "Add, edit or delete greetings" },
      button: { zh: "管理…", en: "Manage…" },
      run: () => openGreetingManager()
    },
    mode: {
      type: "select",
      label: { zh: "轮播方式", en: "Rotation" },
      description: { zh: "定时切换在离开首页时会暂停", en: "The timer pauses while you are away from home" },
      default: "refresh",
      options: [
        { value: "refresh", label: { zh: "刷新或进入首页时", en: "On refresh or visit" } },
        { value: "interval", label: { zh: "按时间间隔", en: "On a timer" } },
        { value: "manual", label: { zh: "点击问候语时", en: "On click" } }
      ]
    },
    order: {
      type: "select",
      label: { zh: "轮播顺序", en: "Order" },
      default: "sequential",
      options: [
        { value: "sequential", label: { zh: "顺序循环", en: "Sequential" } },
        { value: "random", label: { zh: "随机", en: "Random" } }
      ]
    },
    intervalSec: {
      type: "number",
      label: { zh: "切换间隔（秒）", en: "Interval in seconds" },
      description: { zh: "仅在按时间间隔切换时生效", en: "Only used when switching on a timer" },
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
    const want = settings3.store.mode === "manual" && loadGreetings().length > 1 ? tr2("clickHint") : null;
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
    const store = settings3.store;
    openManager({
      defs: { mode: settings3.def.mode, order: settings3.def.order, intervalSec: settings3.def.intervalSec },
      get: (key) => store[key],
      set: (key, value) => void (store[key] = value)
    }, loadIndex);
  }
  var greetingCustomizer_default = definePlugin({
    name: "GreetingCustomizer",
    title: { zh: "自定义问候语", en: "Custom greetings" },
    description: {
      zh: "把 Notion AI 首页的问候语换成你自己的文案：多条管理，顺序或随机轮播，刷新、定时或点击切换。在首页双击右键问候语可打开管理面板。",
      en: "Replaces the Notion AI home greeting with your own lines, shown in order or at random, switched on refresh, on a timer or by click. Double right-click the greeting to manage them."
    },
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

  // src/plugins/hideShare/index.ts
  var STYLE_ID3 = "notionai-pp-hide-share";
  var CHAT_SHARE = "[data-testid='share-chat-button']";
  var PAGE_SHARE = ".notion-topbar-share-menu";
  var settings4 = definePluginSettings({
    pages: {
      type: "boolean",
      label: { zh: "同时隐藏页面的分享按钮", en: "Also hide Share on pages" },
      description: { zh: "普通 Notion 页面右上角的「分享」按钮", en: "The Share button at the top right of ordinary Notion pages" },
      default: false
    }
  });
  function css(pages) {
    const selectors = [CHAT_SHARE, ...pages ? [PAGE_SHARE] : []];
    return `${selectors.join(", ")} { display: none !important; }`;
  }
  function apply2() {
    let style = document.getElementById(STYLE_ID3);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID3;
      (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css(settings4.store.pages);
  }
  var hideShare_default = definePlugin({
    name: "hideShare",
    title: { zh: "隐藏分享按钮", en: "Hide Share button" },
    description: {
      zh: "隐藏 Notion AI 对话右上角的分享按钮，避免误点把对话分享出去。也可以顺带隐藏普通页面的分享按钮。",
      en: "Hides the Share button at the top right of Notion AI chats so a chat is not shared by accident. Can also hide Share on ordinary pages."
    },
    icon: Icons.shareOff,
    tags: ["appearance"],
    enabledByDefault: true,
    settings: settings4,
    start() {
      apply2();
    },
    stop() {
      document.getElementById(STYLE_ID3)?.remove();
    },
    onSettingsChange() {
      apply2();
    }
  });

  // src/plugins/inputHistory/index.ts
  var STORE_KEY = "notionai-pp:input-history:v1";
  var COMPOSER = "[data-notion-chat-input-container]";
  var EDITOR2 = `${COMPOSER} [contenteditable='true']`;
  var SEND = "[data-testid='agent-send-message-button']";
  var POPUP = "[role='listbox'], [role='menu'], .notion-mention-menu";
  var settings5 = definePluginSettings({
    max: {
      type: "number",
      label: { zh: "最多保存条数", en: "Prompts to keep" },
      default: 100,
      min: 10,
      max: 500
    },
    clear: {
      type: "action",
      label: { zh: "清空输入历史", en: "Clear prompt history" },
      button: { zh: "清空", en: "Clear" },
      run: () => save([])
    }
  });
  function load() {
    try {
      const list = safeJson(pageWindow.localStorage.getItem(STORE_KEY) ?? "");
      return Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  function save(list) {
    try {
      pageWindow.localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {}
  }
  function remember(list, text, max) {
    const value = text.trim();
    if (!value)
      return list;
    return [...list.filter((item) => item !== value), value].slice(-max);
  }
  var textOf = (editor) => (editor.innerText ?? "").replace(/\n$/, "");
  function caretAt(editor, edge) {
    const selection = document.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode))
      return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    const caret = selection.getRangeAt(0);
    if (edge === "start")
      range.setEnd(caret.startContainer, caret.startOffset);
    else
      range.setStart(caret.endContainer, caret.endOffset);
    return range.toString().length === 0;
  }
  function fill(editor, text) {
    editor.focus();
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (text)
      document.execCommand("insertText", false, text);
    else
      document.execCommand("delete");
    const end = document.createRange();
    end.selectNodeContents(editor);
    end.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(end);
  }
  var browsing = -1;
  var draft = "";
  var browsingEditor = null;
  function reset() {
    browsing = -1;
    draft = "";
    browsingEditor = null;
  }
  function record(editor) {
    if (!editor)
      return;
    save(remember(load(), textOf(editor), settings5.store.max));
    reset();
  }
  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  var popupOpen = () => [...document.querySelectorAll(POPUP)].some((node) => node.getClientRects().length > 0);
  function onKeyDown(event) {
    const editor = event.target?.closest?.(EDITOR2);
    if (!editor || event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (event.key === "Enter" && !event.shiftKey) {
      if (!popupOpen())
        record(editor);
      return;
    }
    if (event.shiftKey || popupOpen())
      return;
    if (browsingEditor && browsingEditor !== editor)
      reset();
    const list = load();
    if (event.key === "ArrowUp") {
      const empty = !textOf(editor).trim();
      if (!list.length || !empty && !caretAt(editor, "start"))
        return;
      if (browsing === -1) {
        draft = textOf(editor);
        browsing = list.length;
        browsingEditor = editor;
      }
      consume(event);
      if (browsing === 0)
        return;
      browsing--;
      fill(editor, list[browsing]);
    } else if (event.key === "ArrowDown" && browsing !== -1) {
      if (!caretAt(editor, "end"))
        return;
      consume(event);
      browsing++;
      if (browsing >= list.length) {
        fill(editor, draft);
        reset();
      } else
        fill(editor, list[browsing]);
    } else if (event.key === "Escape" && browsing !== -1) {
      consume(event);
      fill(editor, draft);
      reset();
    }
  }
  function onClick2(event) {
    const send = event.target?.closest?.(SEND);
    if (!send || send.getAttribute("aria-disabled") === "true")
      return;
    record(send.closest(COMPOSER)?.querySelector("[contenteditable='true']") ?? null);
  }
  var inputHistory_default = definePlugin({
    name: "inputHistory",
    title: { zh: "输入历史", en: "Prompt history" },
    description: {
      zh: "在 AI 输入框里按 ↑ / ↓ 调出以前发过的提问，像终端一样；Esc 恢复刚才的草稿。只保存在本浏览器。",
      en: "Press ↑ / ↓ in the AI composer to recall prompts you sent before, like a shell; Esc restores your draft. Kept in this browser only."
    },
    icon: Icons.history,
    tags: ["composer"],
    enabledByDefault: true,
    settings: settings5,
    start() {
      document.addEventListener("keydown", onKeyDown, true);
      document.addEventListener("click", onClick2, true);
    },
    stop() {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick2, true);
      reset();
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

  // src/api/Reply.ts
  var STOP_BUTTON = "[data-testid='agent-stop-inference-button']";
  var INFERENCE_PATH = /\/api\/v3\/runInferenceTranscript$/;
  var state = "idle";
  var failed = false;
  var chatId = "";
  var users = 0;
  var stopDom3 = null;
  var stopNet = null;
  var currentChatId = () => new URL(pageWindow.location.href).searchParams.get("t") ?? "";
  function check3() {
    const streaming = !!document.querySelector(STOP_BUTTON);
    if (streaming && state === "idle") {
      state = "streaming";
      failed = false;
      chatId = currentChatId();
      emit("replyStart", { chatId });
    } else if (!streaming && state === "streaming") {
      state = "idle";
      emit("replyEnd", { chatId: currentChatId() || chatId, error: failed });
    }
  }
  function watchReplies() {
    if (users++ === 0) {
      stopDom3 = onDomChange(check3);
      stopNet = observeNetwork({
        matches: (url, method) => method === "POST" && INFERENCE_PATH.test(url.pathname),
        onExchange(exchange) {
          exchange.response.then((response) => {
            if (!response?.ok)
              failed = true;
          });
        }
      });
      check3();
    }
    let released = false;
    return () => {
      if (released)
        return;
      released = true;
      if (--users > 0)
        return;
      stopDom3?.();
      stopNet?.();
      stopDom3 = stopNet = null;
      state = "idle";
    };
  }

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

  // src/plugins/navigator/effects.ts
  var EFFECTS = [
    { value: "none", zh: "无（只滚动）", en: "None (scroll only)" },
    { value: "border", zh: "高亮边框", en: "Highlight border" },
    { value: "pulse", zh: "脉冲光晕", en: "Pulse glow" },
    { value: "fade", zh: "淡入淡出", en: "Fade" },
    { value: "jiggle", zh: "经典抖动", en: "Classic jiggle" }
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
    card.textContent = info ? t(info.zh, info.en) : effect;
    const dark = currentTheme() === "dark";
    Object.assign(card.style, {
      padding: "12px 20px",
      borderRadius: "10px",
      background: dark ? "#202020" : "#fff",
      color: dark ? "#f0efed" : "#37352f",
      font: "500 14px/20px ui-sans-serif, -apple-system, system-ui, sans-serif",
      boxShadow: dark ? "0 0 0 1px #383836, 0 12px 32px rgba(0,0,0,.5)" : "0 0 0 1px rgba(15,15,15,.05), 0 12px 32px rgba(15,15,15,.18)"
    });
    holder.append(card);
    document.body.append(holder);
    playEffect(card, effect);
    const duration = effect === "none" ? 600 : KEYFRAMES[effect].duration;
    setTimeout(() => holder.remove(), duration + 600);
  }

  // src/plugins/navigator/styles.ts
  var NAV_CSS = `
:host {
  all: initial;
  --bg: #f7f7f5; --text: #37352f; --subtle: #6b6b6b; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.06);
  --active: rgba(15,15,15,.1); --line: rgba(15,15,15,.28); --line-active: #37352f; --shadow: 0 10px 30px rgba(15,15,15,.18);
  position: fixed; top: var(--nav-top, 4rem); height: var(--nav-height, calc(100vh - 12rem)); right: var(--nav-right, 20px);
  width: 0; z-index: 2147483000; display: block; pointer-events: none;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:host([data-theme="dark"]) {
  --bg: #252525; --text: #ebebea; --subtle: #b4b4b0; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.08);
  --active: rgba(255,255,255,.13); --line: rgba(255,255,255,.35); --line-active: #e6e6e4; --shadow: 0 10px 30px rgba(0,0,0,.45);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
/* Like Void++: the rail is centered in the space between the chat header and the composer. */
.rail {
  position: absolute; top: 50%; right: 0; max-height: 100%; overflow: hidden; padding: 4px 0; transform: translateY(-50%);
  cursor: pointer; transition: opacity .2s ease; pointer-events: auto;
}
.lines { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; transition: transform .2s ease; }
.line { width: 16px; height: 2px; border-radius: 2px; background: var(--line); transition: width .2s, background .2s; }
.line[data-role="assistant"] { width: 10px; opacity: .7; }
.line.starred { background: #d9730d; opacity: 1; }
.line.active { width: 26px; background: var(--line-active); opacity: 1; box-shadow: 0 0 3px var(--line-active); }
.line.starred.active { background: #d9730d; box-shadow: 0 0 3px #d9730d; }
.menu {
  position: absolute; top: 50%; right: -8px; width: 300px; max-height: 100%; overflow-y: auto; padding: 6px; pointer-events: auto;
  border: 1px solid var(--border); border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  opacity: 0; visibility: hidden; pointer-events: none; transform: translate(10px, -50%); transition: opacity .2s, visibility .2s, transform .2s;
  overscroll-behavior: contain;
}
:host(:hover) .menu, :host(:focus-within) .menu { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(0, -50%); }
:host(:hover) .rail, :host(:focus-within) .rail { opacity: 0; }
.head { padding: 4px 10px 6px; color: var(--subtle); font-size: 12px; line-height: 1.4; letter-spacing: -.2px; font-variant-numeric: tabular-nums; }
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
@media (max-width: 640px) { :host { right: 8px; } .menu { width: min(300px, calc(100vw - 24px)); } }
`;
  var NAV_HTML = `
<nav class="root" aria-label="Chat outline">
  <div class="rail" aria-hidden="true"><div class="lines"></div></div>
  <div class="menu"><div class="head"></div><ul></ul></div>
</nav>`;

  // src/plugins/messageStars/store.ts
  var STARS_KEY = "notionai-pp:stars:v1";
  var active = false;
  var starsActive = () => active;
  function setStarsActive(value) {
    if (active === value)
      return;
    active = value;
    emit("starsChanged", undefined);
  }
  function readAll() {
    try {
      const data = safeJson(pageWindow.localStorage.getItem(STARS_KEY) ?? "");
      if (!isRecord(data))
        return {};
      const out = {};
      for (const [chat, ids] of Object.entries(data)) {
        if (Array.isArray(ids))
          out[chat] = ids.filter((id) => typeof id === "string");
      }
      return out;
    } catch {
      return {};
    }
  }
  var starsOf = (chatId) => new Set(chatId ? readAll()[chatId] ?? [] : []);
  function toggleStar(chatId, id) {
    if (!chatId)
      return false;
    const all = readAll();
    const ids = new Set(all[chatId] ?? []);
    const starred = !ids.delete(id);
    if (starred)
      ids.add(id);
    if (ids.size)
      all[chatId] = [...ids];
    else
      delete all[chatId];
    try {
      pageWindow.localStorage.setItem(STARS_KEY, JSON.stringify(all));
    } catch {}
    emit("starsChanged", undefined);
    return starred;
  }

  // src/plugins/navigator/index.ts
  var NAV_HOST_ID = "notionai-pp-navigator";
  var RESCAN_MS = 250;
  var RESCAN_MAX_MS = 1200;
  var ACTIVE_RATIO = 0.4;
  var SCROLL_OFFSET = 72;
  var SETTLE_MS = 150;
  var RAIL_MARGIN = 20;
  var SIDE_PANELS = "[role='complementary'], aside";
  var COMPOSER2 = "[data-notion-chat-input-container]";
  var SPAN_GAP = 12;
  var MIN_SPAN = 120;
  var settings6 = definePluginSettings({
    showAssistant: { type: "boolean", label: { zh: "目录显示 AI 回复", en: "Show AI replies" }, default: true },
    effect: {
      type: "select",
      label: { zh: "跳转定位效果", en: "Jump effect" },
      default: "border",
      description: { zh: "跳转到消息后用什么方式标出它", en: "How a message is marked after jumping to it" },
      options: EFFECTS.map((effect) => ({ value: effect.value, label: { zh: effect.zh, en: effect.en } }))
    },
    preview: {
      type: "action",
      label: { zh: "预览效果", en: "Preview effect" },
      button: { zh: "预览", en: "Preview" },
      run: () => previewEffect(settings6.store.effect)
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
    return settings6.store.showAssistant ? all : all.filter((message) => message.role === "user");
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
    const span = railSpan();
    if (span) {
      overlay2.host.style.setProperty("--nav-top", `${span.top}px`);
      overlay2.host.style.setProperty("--nav-height", `${span.height}px`);
    }
  }
  function railSpan() {
    const first = messages.find((m) => m.element.isConnected)?.element;
    if (!first)
      return null;
    const { height } = viewport();
    const pane = scrollParentOf(first);
    const isRoot = pane === document.scrollingElement || pane === document.documentElement;
    const paneBox = isRoot ? { top: 0, bottom: height } : pane.getBoundingClientRect();
    const composer = document.querySelector(COMPOSER2)?.getBoundingClientRect();
    const top = Math.max(0, paneBox.top) + SPAN_GAP;
    const bottom = Math.min(paneBox.bottom, composer && composer.height ? composer.top : height) - SPAN_GAP;
    return bottom - top >= MIN_SPAN ? { top: Math.round(top), height: Math.round(bottom - top) } : { top: Math.round(top), height: MIN_SPAN };
  }
  function build() {
    if (!overlay2)
      return;
    const next = isAiRoute() ? visibleMessages(collectMessages()) : [];
    const stars = starsActive() ? starsOf(currentChatId()) : new Set;
    const nextSignature = next.map((m) => `${m.id}\x01${summarize(m.text)}\x01${stars.has(m.id) ? 1 : 0}`).join("\x02");
    const sameElements = next.length === messages.length && next.every((m, i) => m.element === messages[i].element);
    messages = next;
    overlay2.host.hidden = !next.length;
    placeRail();
    if (nextSignature === signature) {
      if (!sameElements)
        updateActive();
      return;
    }
    signature = nextSignature;
    q(".lines").replaceChildren(...next.map((message) => {
      const line = document.createElement("div");
      line.className = "line";
      line.dataset.id = message.id;
      line.dataset.role = message.role;
      line.classList.toggle("starred", stars.has(message.id));
      return line;
    }));
    const labels = outlineLabels(next);
    q("ul").replaceChildren(...next.map((message, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "item";
      button.dataset.id = message.id;
      button.dataset.role = message.role;
      button.classList.toggle("starred", stars.has(message.id));
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = stars.has(message.id) ? "⭐" : message.role === "user" ? "❓" : "\uD83E\uDD16";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = summarize(message.text);
      if (labels[index] !== label.textContent)
        label.dataset.compact = labels[index];
      button.title = summarize(message.text, 400);
      button.append(mark, label);
      button.addEventListener("click", () => jump(message.id));
      const item = document.createElement("li");
      item.append(button);
      return item;
    }));
    compactOverflowing();
    activeId = "";
    updateActive();
  }
  function compactOverflowing() {
    if (!overlay2)
      return;
    for (const label of overlay2.root.querySelectorAll(".label[data-compact]")) {
      if (label.scrollWidth > label.clientWidth + 1)
        label.textContent = label.dataset.compact;
    }
  }
  function updateHead() {
    if (!overlay2)
      return;
    const index = Math.max(0, messages.findIndex((m) => m.id === activeId));
    q(".head").textContent = `${Math.min(index + 1, Math.max(messages.length, 1))} / ${messages.length}`;
  }
  function setActive(id) {
    if (!overlay2 || id === activeId)
      return;
    activeId = id;
    updateHead();
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
  function jumpTo(id) {
    if (!overlay2 || !messages.some((m) => m.id === id && m.element.isConnected))
      return false;
    jump(id);
    return true;
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
        playEffect(target, settings6.store.effect);
      }, SETTLE_MS);
    };
    (isRoot ? window : scroller).addEventListener("scroll", settle, { passive: true });
    scroller.scrollTo({ top, behavior: "smooth" });
    settle();
  }
  var navigator_default = definePlugin({
    name: "chatNavigator",
    title: { zh: "对话目录", en: "Chat navigator" },
    description: {
      zh: "在 Notion AI 对话右侧显示 Notion 风格目录，悬停展开，点击跳到对应提问或回复。",
      en: "Shows a Notion-style outline beside Notion AI chats. Hover to expand it and click to jump to a prompt or reply."
    },
    icon: Icons.list,
    tags: ["chat"],
    enabledByDefault: true,
    settings: settings6,
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
        on("starsChanged", () => {
          signature = "";
          build();
        }),
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

  // src/plugins/messageStars/list.ts
  var LIST_MARK = "data-npp-star-list";
  var HOST_ID = "notionai-pp-star-list";
  var PANEL_TOGGLE = "[data-testid='agent-chat-side-panel-toggle']";
  var STAR_COLOR = "#d9730d";
  var HOVER_OPEN_MS = 120;
  var HOVER_CLOSE_MS = 180;
  var SCROLL_OFFSET2 = 72;
  var CSS3 = `
:host {
  all: initial;
  --bg: #ffffff; --text: #37352f; --subtle: #787774; --border: rgba(15,15,15,.1); --hover: rgba(15,15,15,.06);
  --shadow: 0 10px 30px rgba(15,15,15,.16);
  position: fixed; top: 0; left: 0; z-index: 2147483000; display: block;
  font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
:host([data-theme="dark"]) {
  --bg: #252525; --text: #ebebea; --subtle: #9b9a97; --border: rgba(255,255,255,.1); --hover: rgba(255,255,255,.08);
  --shadow: 0 10px 30px rgba(0,0,0,.45);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.panel {
  width: min(300px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 64px)); overflow-y: auto; padding: 6px;
  border: 1px solid var(--border); border-radius: 12px; color: var(--text); background: var(--bg); box-shadow: var(--shadow);
  overscroll-behavior: contain;
}
.head { display: flex; align-items: center; gap: 6px; padding: 4px 8px 6px; color: var(--subtle); font-size: 12px; line-height: 1.4; letter-spacing: -.2px; }
.head svg { width: 14px; height: 14px; color: ${STAR_COLOR}; fill: currentColor; flex: none; }
.count { margin-left: auto; font-variant-numeric: tabular-nums; }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 1px; }
.row { display: flex; align-items: center; gap: 2px; border-radius: 6px; }
.row:hover, .row:focus-within { background: var(--hover); }
button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.jump { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; padding: 6px 4px 6px 8px; font-size: 13px; text-align: left; }
.role { flex: none; min-width: 22px; color: var(--subtle); font-size: 11px; }
.snip { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.row.missing .snip { color: var(--subtle); font-style: italic; }
.unstar { display: flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; margin-right: 2px; border-radius: 5px; color: ${STAR_COLOR}; }
.unstar:hover { background: var(--hover); }
.unstar svg { width: 14px; height: 14px; fill: currentColor; }
.empty { padding: 6px 8px 8px; color: var(--subtle); font-size: 13px; }
:focus-visible { outline: 2px solid #4e9cff; outline-offset: 1px; }
`;
  var overlay3 = null;
  var button2 = null;
  var pinned = false;
  var hovering = false;
  var hoverTimer = 0;
  var cleanups3 = [];
  function starEntries(ids, messages) {
    const shown = messages.filter((m) => ids.has(m.id)).map((m) => ({ id: m.id, role: m.role, text: m.text }));
    const seen = new Set(shown.map((entry) => entry.id));
    const rest = [...ids].filter((id) => !seen.has(id)).map((id) => ({ id, role: id.endsWith(":assistant") ? "assistant" : "user", text: null }));
    return [...shown, ...rest];
  }
  function controlRow(root = document) {
    const toggle = root.querySelector(PANEL_TOGGLE);
    const wrapper = toggle?.parentElement;
    return wrapper?.parentElement ?? null;
  }
  function placeButton(row, wrapper) {
    const first = row.firstElementChild;
    const group = first && first !== wrapper && !first.hasAttribute("data-popup-origin") && !first.querySelector(PANEL_TOGGLE) ? first : null;
    const parent = group ?? row;
    const before = [...parent.children].find((child) => child !== wrapper && child.querySelector("[role='button'], button")) ?? null;
    if (wrapper.parentElement !== parent || wrapper.nextElementSibling !== before)
      parent.insertBefore(wrapper, before);
  }
  function headerIcon(native) {
    const svg = svgIcon(Icons.star);
    svg.setAttribute("stroke-width", "1.5");
    const classes = native?.getAttribute("class")?.split(/\s+/).filter((name) => /^x[0-9a-z]+$/.test(name));
    if (classes?.length)
      svg.setAttribute("class", classes.join(" "));
    const ink = native?.style.fill || "currentColor";
    svg.style.cssText = `width:20px;height:20px;display:block;flex-shrink:0;fill:none;stroke:${ink}`;
    svg.dataset.ink = ink;
    return svg;
  }
  function paintButton() {
    if (!button2)
      return;
    const count = starsOf(currentChatId()).size;
    const svg = button2.querySelector("svg");
    if (svg) {
      svg.style.stroke = count ? STAR_COLOR : svg.dataset.ink ?? "currentColor";
      svg.style.fill = count ? STAR_COLOR : "none";
    }
    const label = count ? t(`已加星标的消息（${count}）`, `Starred messages (${count})`) : t("已加星标的消息", "Starred messages");
    button2.setAttribute("aria-label", label);
    button2.setAttribute("aria-expanded", String(isOpen()));
    button2.title = label;
  }
  function makeButton(row) {
    const sample = row.querySelector("[aria-label='Pin chat'], [role='button'][aria-label]");
    const sampleWrapper = sample?.parentElement;
    if (!sample || !sampleWrapper)
      return null;
    const wrapper = sampleWrapper.cloneNode(false);
    wrapper.removeAttribute("data-popup-origin");
    wrapper.setAttribute(LIST_MARK, "");
    const btn = sample.cloneNode(false);
    for (const name of ["id", "aria-pressed", "aria-expanded", "aria-haspopup", "data-testid"])
      btn.removeAttribute(name);
    btn.setAttribute("aria-haspopup", "dialog");
    btn.append(headerIcon(sample.querySelector("svg")));
    btn.addEventListener("pointerenter", () => hoverSoon(true));
    btn.addEventListener("pointerleave", () => hoverSoon(false));
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      pinned = !isOpen() || !pinned;
      hovering = pinned;
      render();
    });
    btn.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ")
        return;
      event.preventDefault();
      btn.click();
    });
    wrapper.append(btn);
    button2 = btn;
    return wrapper;
  }
  var isOpen = () => pinned || hovering;
  function hoverSoon(open) {
    clearTimeout(hoverTimer);
    if (!open && pinned)
      return;
    hoverTimer = window.setTimeout(() => {
      hovering = open;
      render();
    }, open ? HOVER_OPEN_MS : HOVER_CLOSE_MS);
  }
  function close() {
    pinned = false;
    hovering = false;
    clearTimeout(hoverTimer);
    render();
  }
  function scrollToMessage(id) {
    if (jumpTo(id))
      return;
    const target = collectMessages().find((m) => m.id === id)?.element;
    if (!target)
      return;
    const scroller = scrollParentOf(target);
    const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
    const top = target.getBoundingClientRect().top - (isRoot ? 0 : scroller.getBoundingClientRect().top) + scroller.scrollTop - SCROLL_OFFSET2;
    scroller.scrollTo({ top, behavior: "smooth" });
  }
  function ensureOverlay() {
    if (overlay3)
      return overlay3;
    overlay3 = createOverlay(HOST_ID, CSS3, `<div class="panel" role="dialog"></div>`);
    overlay3.host.hidden = true;
    overlay3.host.addEventListener("pointerenter", () => hoverSoon(true));
    overlay3.host.addEventListener("pointerleave", () => hoverSoon(false));
    return overlay3;
  }
  function fillPanel(panel) {
    const entries = starEntries(starsOf(currentChatId()), collectMessages());
    const head = document.createElement("div");
    head.className = "head";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(entries.length);
    head.append(svgIcon(Icons.star), document.createTextNode(t("已加星标", "Starred")), count);
    const list = document.createElement("ul");
    for (const entry of entries) {
      const row = document.createElement("li");
      row.className = entry.text === null ? "row missing" : "row";
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "jump";
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = entry.role === "user" ? t("你", "You") : "AI";
      const snip = document.createElement("span");
      snip.className = "snip";
      snip.textContent = entry.text === null ? t("（未加载，向上滚动后可跳转）", "(not loaded yet; scroll up to reach it)") : summarize(entry.text, 80);
      if (entry.text)
        jump.title = summarize(entry.text, 400);
      jump.append(role, snip);
      jump.addEventListener("click", () => {
        scrollToMessage(entry.id);
        close();
      });
      const unstar = document.createElement("button");
      unstar.type = "button";
      unstar.className = "unstar";
      unstar.title = t("取消星标", "Unstar");
      unstar.setAttribute("aria-label", unstar.title);
      unstar.append(svgIcon(Icons.star));
      unstar.addEventListener("click", () => toggleStar(currentChatId(), entry.id));
      row.append(jump, unstar);
      list.append(row);
    }
    if (entries.length)
      panel.replaceChildren(head, list);
    else {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = t("这个对话还没有加星标的消息。悬停消息，点工具栏里的星标即可加入。", "No starred messages in this chat yet. Hover a message and click the star in its toolbar.");
      panel.replaceChildren(head, empty);
    }
  }
  function render() {
    paintButton();
    const open = isOpen() && !!button2?.isConnected;
    if (!open) {
      if (overlay3)
        overlay3.host.hidden = true;
      return;
    }
    const { host, root } = ensureOverlay();
    fillPanel(root.querySelector(".panel"));
    host.hidden = false;
    const anchor = button2.getBoundingClientRect();
    const panel = root.querySelector(".panel");
    const width = panel.offsetWidth || 300;
    const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(anchor.bottom + 6)}px`;
  }
  function sync() {
    const row = currentChatId() ? controlRow() : null;
    let wrapper = document.querySelector(`[${LIST_MARK}]`);
    if (!row) {
      wrapper?.remove();
      button2 = null;
      if (isOpen())
        close();
      return;
    }
    if (wrapper && !row.contains(wrapper)) {
      wrapper.remove();
      wrapper = null;
    }
    wrapper ??= makeButton(row);
    if (!wrapper)
      return;
    placeButton(row, wrapper);
    paintButton();
  }
  function startList() {
    const resync = debounce(sync, 150, 600);
    const onKey = (event) => event.key === "Escape" && isOpen() && close();
    const onDown = (event) => {
      if (!isOpen())
        return;
      const path = event.composedPath();
      if (button2 && path.includes(button2) || overlay3 && path.includes(overlay3.host))
        return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    cleanups3 = [
      onDomChange((mutations) => {
        if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((node) => node instanceof Element && (node.hasAttribute(LIST_MARK) || node.id === HOST_ID))))
          return;
        resync();
      }),
      on("starsChanged", () => isOpen() ? render() : paintButton()),
      onRouteChange(() => {
        close();
        resync();
      }),
      () => resync.cancel(),
      () => document.removeEventListener("keydown", onKey, true),
      () => document.removeEventListener("pointerdown", onDown, true)
    ];
    sync();
  }
  function stopList() {
    for (const cleanup of cleanups3.splice(0))
      cleanup();
    clearTimeout(hoverTimer);
    pinned = false;
    hovering = false;
    document.querySelector(`[${LIST_MARK}]`)?.remove();
    button2 = null;
    overlay3?.destroy();
    overlay3 = null;
  }

  // src/plugins/messageStars/index.ts
  var MARK = "data-npp-star";
  var STAR_COLOR2 = "#d9730d";
  var RESCAN_MS2 = 200;
  var cleanups4 = [];
  var settings7 = definePluginSettings({
    headerList: {
      type: "boolean",
      label: { zh: "右上角显示星标列表", en: "Starred list in the top bar" },
      description: { zh: "在对话右上角按钮的左边放一个星标按钮，悬停或点击列出本对话加星的消息", en: "A star left of the chat's top-right buttons; hover or click it to list this chat's starred messages" },
      default: true
    }
  });
  function topSteps() {
    return [...document.querySelectorAll(`[${USER_STEP}]`)].filter((step) => !step.parentElement?.closest(`[${USER_STEP}]`));
  }
  function messageIdFor(button, steps) {
    const role = copyRole(button);
    if (role === "user")
      return button.closest(`[${USER_STEP}]`)?.getAttribute(USER_STEP) ?? null;
    if (role !== "assistant")
      return null;
    let owner = null;
    for (const step of steps) {
      if (step.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING)
        owner = step;
      else
        break;
    }
    const id = owner?.getAttribute(USER_STEP);
    return id ? `${id}:assistant` : null;
  }
  var STROKE = "1.8";
  function starIcon(native) {
    const svg = svgIcon(Icons.star);
    svg.setAttribute("stroke-width", STROKE);
    const classes = native?.getAttribute("class")?.split(/\s+/).filter((name) => name && !/Small$|Large$/.test(name));
    if (classes?.length)
      svg.setAttribute("class", classes.join(" "));
    const size = native?.getBoundingClientRect();
    const px = size && size.height ? Math.round(size.height) : 16;
    svg.style.cssText = `${native?.getAttribute("style") ?? ""};width:${px}px;height:${px}px;display:block;flex-shrink:0;fill:none;stroke:currentColor`;
    return svg;
  }
  function paint(button, starred) {
    button.setAttribute("aria-pressed", String(starred));
    const label = starred ? t("取消星标", "Unstar") : t("加星标", "Star");
    button.setAttribute("aria-label", label);
    button.title = label;
    const svg = button.querySelector("svg");
    if (!svg)
      return;
    svg.style.color = starred ? STAR_COLOR2 : "";
    svg.style.fill = starred ? "currentColor" : "none";
  }
  var mirrors = new WeakMap;
  function mirror(copy, button) {
    const sync = () => {
      if (button.className !== copy.className)
        button.className = copy.className;
      if (button.style.opacity !== copy.style.opacity)
        button.style.opacity = copy.style.opacity;
    };
    sync();
    const observer = new MutationObserver(() => {
      if (!button.isConnected)
        return observer.disconnect();
      sync();
    });
    observer.observe(copy, { attributes: true, attributeFilter: ["class", "style"] });
    mirrors.get(button)?.disconnect();
    mirrors.set(button, observer);
  }
  function makeButton2(copy, id) {
    const wrapper = copy.parentElement?.cloneNode(false) ?? document.createElement("div");
    wrapper.removeAttribute("data-popup-origin");
    wrapper.setAttribute(MARK, id);
    const button = copy.cloneNode(false);
    button.removeAttribute("id");
    button.append(starIcon(copy.querySelector("svg")));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      paint(button, toggleStar(currentChatId(), id));
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ")
        return;
      event.preventDefault();
      button.click();
    });
    wrapper.append(button);
    mirror(copy, button);
    return wrapper;
  }
  function place(row, copyWrapper, star) {
    let after = copyWrapper;
    for (let next = after.nextElementSibling;next && next !== star; next = next.nextElementSibling) {
      if (!isIconWrapper(next))
        break;
      after = next;
    }
    if (after.nextElementSibling !== star)
      row.insertBefore(star, after.nextElementSibling);
    if (row.style.width.endsWith("px"))
      row.style.width = "auto";
  }
  var isIconWrapper = (node) => !(node instanceof HTMLElement && /flex:\s*1/.test(node.getAttribute("style") ?? "")) && !!node.querySelector("[role='button'][aria-label], button[aria-label]") && !node.textContent?.trim();
  function scan3() {
    const chatId = currentChatId();
    const stars = starsOf(chatId);
    const steps = topSteps();
    for (const copy of document.querySelectorAll("[role='button'][aria-label], button[aria-label]")) {
      if (copy.closest(`[${MARK}]`))
        continue;
      const row = copy.parentElement?.parentElement;
      if (!row || !copyRole(copy))
        continue;
      const id = chatId ? messageIdFor(copy, steps) : null;
      let ours = [...row.children].find((child) => child.hasAttribute(MARK)) ?? null;
      if (ours && (!id || ours.getAttribute(MARK) !== id)) {
        ours.remove();
        ours = null;
      }
      if (!id)
        continue;
      if (ours) {
        const button = ours.firstElementChild;
        if (button.className !== copy.className || button.style.opacity !== copy.style.opacity)
          mirror(copy, button);
      }
      ours ??= makeButton2(copy, id);
      place(row, copy.parentElement, ours);
      paint(ours.firstElementChild, stars.has(id));
    }
  }
  function removeAll() {
    for (const node of document.querySelectorAll(`[${MARK}]`))
      node.remove();
  }
  var messageStars_default = definePlugin({
    name: "messageStars",
    title: { zh: "消息星标", en: "Message stars" },
    description: {
      zh: "在每条提问和回复的悬停工具栏里加一个星标按钮。加星的消息在右侧对话目录里显示为橙色，右上角的星标按钮可列出本对话所有星标并跳转。",
      en: "Adds a star to the hover toolbar of every prompt and reply. Starred messages show in orange in the chat navigator, and the star in the top bar lists them for jumping back."
    },
    settings: settings7,
    icon: Icons.star,
    tags: ["chat"],
    enabledByDefault: true,
    start() {
      setStarsActive(true);
      const rescan = debounce(scan3, RESCAN_MS2, RESCAN_MS2 * 4);
      const onStorage = (event) => event.key === STARS_KEY && scan3();
      pageWindow.addEventListener("storage", onStorage);
      cleanups4 = [
        onDomChange((mutations) => {
          if (mutations.every((m) => [...m.addedNodes, ...m.removedNodes].every((node) => node instanceof Element && node.hasAttribute(MARK))))
            return;
          rescan();
        }),
        on("starsChanged", scan3),
        () => rescan.cancel(),
        () => pageWindow.removeEventListener("storage", onStorage)
      ];
      scan3();
      if (settings7.store.headerList)
        startList();
    },
    stop() {
      stopList();
      for (const cleanup of cleanups4.splice(0))
        cleanup();
      removeAll();
      setStarsActive(false);
    },
    onSettingsChange() {
      stopList();
      if (settings7.store.headerList)
        startList();
    }
  });

  // src/plugins/replyNotification/index.ts
  var settings8 = definePluginSettings({
    sound: {
      type: "boolean",
      label: { zh: "播放提示音", en: "Play a sound" },
      default: true
    },
    volume: {
      type: "number",
      label: { zh: "提示音音量", en: "Sound volume" },
      default: 60,
      min: 0,
      max: 100
    },
    desktop: {
      type: "boolean",
      label: { zh: "系统通知", en: "System notification" },
      description: { zh: "弹出浏览器通知，点击回到这个标签页", en: "Show a browser notification; click it to return to this tab" },
      default: false
    },
    onlyHidden: {
      type: "boolean",
      label: { zh: "仅在标签页不在前台时提醒", en: "Only when the tab is in the background" },
      default: true
    },
    test: {
      type: "action",
      label: { zh: "试听 / 授权通知", en: "Test / allow notifications" },
      description: { zh: "播放一次提醒；开启了系统通知时会先请求浏览器授权", en: "Plays the alert once, asking the browser for notification permission first if needed" },
      button: { zh: "试一下", en: "Test" },
      run: () => void test()
    }
  });
  var audio = null;
  var cleanups5 = [];
  function chime(volume = settings8.store.volume) {
    const gain = Math.max(0, Math.min(100, volume)) / 100;
    if (!gain)
      return;
    try {
      audio ??= new AudioContext;
      if (audio.state === "suspended")
        audio.resume();
      const now = audio.currentTime;
      [660, 880].forEach((frequency, index) => {
        const start = now + index * 0.14;
        const osc = audio.createOscillator();
        const env = audio.createGain();
        osc.type = "sine";
        osc.frequency.value = frequency;
        env.gain.setValueAtTime(0, start);
        env.gain.linearRampToValueAtTime(0.25 * gain, start + 0.015);
        env.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
        osc.connect(env).connect(audio.destination);
        osc.start(start);
        osc.stop(start + 0.34);
      });
    } catch {}
  }
  var chatTitle = () => document.title.replace(/\s*\|\s*Notion\s*$/, "").trim() || "Notion AI";
  function lastReply() {
    const messages = collectMessages();
    const reply = [...messages].reverse().find((message) => message.role === "assistant");
    return reply ? summarize(reply.text, 120) : "";
  }
  function desktop(error) {
    if (typeof Notification !== "function" || Notification.permission !== "granted")
      return;
    try {
      const note = new Notification(error ? t(`回复出错 · ${chatTitle()}`, `Reply failed · ${chatTitle()}`) : chatTitle(), {
        body: error ? t("Notion AI 没能完成这次回复", "Notion AI could not finish this reply") : lastReply() || t("Notion AI 已回复完成", "Notion AI has finished replying"),
        tag: "notionai-pp-reply",
        silent: settings8.store.sound
      });
      note.onclick = () => {
        pageWindow.focus();
        note.close();
      };
    } catch {}
  }
  function notify2({ error }) {
    if (settings8.store.onlyHidden && document.visibilityState === "visible" && document.hasFocus())
      return;
    if (settings8.store.sound)
      chime();
    if (settings8.store.desktop)
      desktop(error);
  }
  async function test() {
    if (settings8.store.desktop && typeof Notification === "function" && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (settings8.store.sound)
      chime();
    if (settings8.store.desktop)
      desktop(false);
  }
  var replyNotification_default = definePlugin({
    name: "replyNotification",
    title: { zh: "回复完成提醒", en: "Reply notification" },
    description: {
      zh: "Notion AI 回复完成时播放提示音，也可以弹出系统通知。默认只在标签页不在前台时提醒。",
      en: "Plays a sound, and optionally shows a system notification, when Notion AI finishes a reply. By default only while the tab is in the background."
    },
    icon: Icons.bell,
    tags: ["chat"],
    enabledByDefault: true,
    settings: settings8,
    start() {
      cleanups5 = [watchReplies(), on("replyEnd", notify2)];
    },
    stop() {
      for (const cleanup of cleanups5.splice(0))
        cleanup();
      audio?.close();
      audio = null;
    },
    onSettingsChange(key) {
      if (key === "desktop" && settings8.store.desktop && typeof Notification === "function" && Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  });

  // src/plugins/settings/index.ts
  var SETTINGS_HOST_ID = "notionai-pp-settings";
  var SELF = "settings";
  var REPO_URL = "https://github.com/0-V-linuxdo/NotionPP";
  var both = (text) => typeof text === "string" ? text : `${text.zh} ${text.en}`;
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
  var overlay4 = null;
  var layers = [];
  var cleanups6 = [];
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
    overlay4.root.append(el);
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
  function settingField(plugin, key, def) {
    const store = plugin.settings.store;
    return optionRow(def, store[key], (value) => setValue(plugin.name, key, value));
  }
  function openPluginDialog(plugin) {
    let layer;
    const node = sheet(tr(plugin.title), tr(plugin.description), () => layer.close());
    const entries = settingKeys(plugin);
    const list = h("div", { class: "settings-list" });
    const render = () => {
      list.replaceChildren(...entries.map(([key, def]) => settingField(plugin, key, def)));
      list.toggleAttribute("data-off", !isEnabled(plugin));
    };
    render();
    const body = h("div", { class: "sheet-body" }, section(t("设置", "Settings"), entries.length ? list : h("p", { class: "field-text" }, t("没有可配置的选项。", "No configurable settings."))));
    const storable = entries.filter(([, def]) => def.type !== "action").map(([key]) => key);
    if (storable.length) {
      body.append(section(t("重置", "Reset"), row(t("恢复默认设置", "Reset to defaults"), t("把这个插件的设置恢复为默认值", "Restore this plugin's settings to their defaults"), button("secondary", t("恢复默认", "Reset"), () => confirmDialog(t("恢复默认设置", "Reset settings"), t("把这个插件的设置恢复为默认值？此操作无法撤销。", "Reset this plugin's settings to defaults? This cannot be undone."), t("恢复默认", "Reset"), () => {
        resetValues(plugin.name, storable);
        render();
      })))));
    }
    node.append(body);
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
    const actions = h("div", { class: "card-controls" }, iconButton(Icons.star, starred ? t("取消收藏", "Remove from favorites") : t("收藏", "Add to favorites"), () => {
      toggleInList("starred", plugin.name);
      refresh();
    }, { active: starred, filled: starred }), !plugin.required && iconButton(Icons.pin, pinned ? t("取消置顶", "Unpin from top") : t("置顶", "Pin to top"), () => {
      toggleInList("pinned", plugin.name);
      refresh();
    }, { active: pinned, filled: pinned }), hasSettings(plugin) && iconButton(Icons.sliders, t("配置", "Configure"), () => openPluginDialog(plugin)));
    const title = tr(plugin.title);
    const description = tr(plugin.description);
    actions.append(switchControl(enabled, title, (value) => {
      setEnabled(plugin, value);
      refresh();
    }, plugin.required));
    return h("div", { class: cls, "data-plugin": plugin.name }, h("div", { class: "card-body" }, h("div", { class: "card-head" }, h("div", { class: "card-name" }, h("span", { class: "card-icon" }, icon(plugin.icon ?? Icons.plug)), h("span", { class: "card-title", title }, title), crashed && h("span", { class: "badge danger", title: t("此插件启动失败", "This plugin failed to start") }, icon(Icons.alert)), plugin.required && h("span", { class: "badge", title: t("NotionAI++ 运行必需", "Required for NotionAI++ to work") }, icon(Icons.lock))), actions), h("div", { class: "card-desc", title: description }, description)), h("div", { class: "card-footer" }, h("span", { class: "card-author" }, plugin.authors?.join(", ") || "NotionAI++ Contributors")));
  }
  function pluginsTab() {
    const all = allPlugins().slice().sort((a, b) => tr(a.title).localeCompare(tr(b.title)));
    const user = all.filter((p) => !p.required);
    const required = all.filter((p) => p.required);
    const state = { category: readList("starred").length ? "favorites" : "all", search: "", filter: "all" };
    const categories = Object.keys(CATEGORY_LABELS).filter((c) => c === "favorites" || c === "all" || all.some((p) => p.tags?.includes(c)));
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const search = h("input", { type: "search", class: "input", "aria-label": t("搜索插件", "Search plugins") });
    const filter = selectControl(t("筛选", "Filter"), [
      { value: "all", label: t("全部", "All") },
      { value: "enabled", label: t("已启用", "Enabled") },
      { value: "disabled", label: t("已禁用", "Disabled") }
    ], state.filter, (value) => {
      state.filter = value;
      render();
    }, "field");
    const list = h("div", { class: "list" });
    const matches = (p) => {
      if (state.filter !== "all" && isEnabled(p) !== (state.filter === "enabled"))
        return false;
      const q = state.search.trim().toLowerCase();
      return !q || [p.title, p.name, p.description].map(both).join(" ").toLowerCase().includes(q);
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
    render();
    return h("div", { class: "tab-root" }, tabs, h("div", { class: "search-bar" }, search, filter), list);
  }
  var LANGUAGE_KEY = "language";
  function preferencesTab() {
    const current = String(getValue(SELF, LANGUAGE_KEY) ?? "auto");
    const language = selectControl(t("界面语言", "Language"), [
      { value: "auto", label: t("跟随 Notion", "Same as Notion") },
      { value: "zh", label: "中文" },
      { value: "en", label: "English" }
    ], current, (value) => {
      setValue(SELF, LANGUAGE_KEY, value);
      openSettings("preferences");
    });
    return h("div", { class: "tab-root prefs" }, section(t("语言", "Language"), row(t("界面语言", "Language"), t("NotionAI++ 的设置、提示和面板使用的语言", "The language of NotionAI++'s settings, tooltips and panels"), language)));
  }
  function aboutTab() {
    const version = "[20261007] v1.5.0";
    return h("div", { class: "tab-root about" }, h("p", {}, t("NotionAI++ 是 Notion AI 的增强用户脚本：用量贴在 AI 输入框上，对话目录，以及更多小插件。", "NotionAI++ is a userscript for Notion AI: a usage meter docked to the AI composer, a chat outline and more.")), h("p", {}, t("只发同源请求，不读取 Cookie、token 或 Authorization；设置只保存在本机浏览器。", "Only same-origin requests; never reads cookies, tokens or Authorization. Settings stay in this browser.")), h("p", {}, `${t("版本", "Version")} ${version} · `, h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "GitHub")));
  }
  var TABS = [
    { id: "plugins", icon: Icons.plug, title: () => t("插件", "Plugins"), hint: () => t("开关各项功能；点滑杆图标进行配置。", "Toggle features. Click the sliders icon to configure."), render: pluginsTab },
    { id: "preferences", icon: Icons.sliders, title: () => t("偏好设置", "Preferences"), hint: () => "", render: preferencesTab },
    { id: "about", icon: Icons.info, title: () => t("关于", "About"), hint: () => "", render: aboutTab }
  ];
  function close2() {
    for (const layer of layers.splice(0))
      layer.el.remove();
    overlay4?.destroy();
    overlay4 = null;
  }
  function openSettings(tab = "plugins") {
    close2();
    overlay4 = createOverlay(SETTINGS_HOST_ID, CSS, "");
    const { root } = overlay4;
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
      const closeBtn = iconButton(Icons.x, t("关闭", "Close"), close2);
      closeBtn.classList.add("close");
      content.replaceChildren(closeBtn, h("div", { class: "content-head" }, h("h2", {}, def.title()), hint && h("span", { class: "hint", title: hint }, icon(Icons.info))), def.render());
    };
    const version = "[20261007] v1.5.0";
    const nav = h("nav", { class: "nav" }, h("div", { class: "nav-group" }, "NotionAI++"), ...TABS.map((def) => {
      const item = h("button", { type: "button", class: "nav-item", onclick: () => select(def.id) }, icon(def.icon), def.title());
      navItems.set(def.id, item);
      return item;
    }), h("div", { class: "version" }, h("a", { href: REPO_URL, target: "_blank", rel: "noreferrer" }, "NotionAI++"), version && ` · ${version}`, h("br"), t("用户脚本", "Userscript")));
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": t("NotionAI++ 设置", "NotionAI++ settings") }, nav, content);
    const backdrop = h("div", { class: "layer layer-root" }, dialog);
    backdrop.addEventListener("mousedown", (event) => event.target === backdrop && close2());
    root.append(backdrop);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape")
        return;
      event.stopPropagation();
      const top = layers.at(-1);
      if (top)
        top.close();
      else
        close2();
    });
    select(tab);
    dialog.tabIndex = -1;
    dialog.focus();
  }
  var settings_default = definePlugin({
    name: SELF,
    title: { zh: "设置面板", en: "Settings" },
    description: { zh: "NotionAI++ 设置面板与脚本管理器菜单命令。", en: "The NotionAI++ settings panel and its userscript manager menu command." },
    icon: Icons.cog,
    enabledByDefault: true,
    required: true,
    start() {
      cleanups6.push(on("openSettings", () => openSettings()));
      if (typeof GM_registerMenuCommand === "function") {
        try {
          GM_registerMenuCommand(t("⚙️ NotionAI++ 设置", "⚙️ NotionAI++ settings"), () => openSettings());
        } catch {}
      }
    },
    stop() {
      for (const cleanup of cleanups6.splice(0))
        cleanup();
      close2();
    }
  });

  // src/plugins/tabStatus/index.ts
  var SIZE = 32;
  var SPIN_MS = 120;
  var COLORS = { done: "#2383e2", error: "#e03e3e", streaming: "#2383e2" };
  var settings9 = definePluginSettings({
    showDone: {
      type: "boolean",
      label: { zh: "回复完成后显示蓝点", en: "Blue dot when a reply is done" },
      description: { zh: "回到这个标签页后自动消失", en: "Clears when you come back to the tab" },
      default: true
    }
  });
  var state2 = "idle";
  var original2 = null;
  var base = null;
  var ours = "";
  var angle = 0;
  var timer2 = 0;
  var cleanups7 = [];
  var iconLink = () => document.querySelector("link[rel~='icon']");
  function remember2() {
    const link = iconLink();
    if (!link || link.href === ours)
      return;
    original2 = { link, href: link.href };
    base = null;
  }
  function loadBase() {
    if (base?.complete)
      return Promise.resolve(base);
    if (!original2)
      return Promise.resolve(null);
    const image = new Image;
    image.src = original2.href;
    base = image;
    return new Promise((resolve) => {
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
    });
  }
  function drawBadge(ctx, kind, turn = 0) {
    if (kind === "idle")
      return;
    const r = 7;
    const cx = SIZE - r - 1;
    const cy = SIZE - r - 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    if (kind === "streaming") {
      ctx.beginPath();
      ctx.arc(cx, cy, r - 1.5, turn, turn + Math.PI * 1.4);
      ctx.strokeStyle = COLORS.streaming;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[kind];
    ctx.fill();
  }
  async function paint2() {
    remember2();
    const link = original2?.link;
    if (!link)
      return;
    if (state2 === "idle") {
      if (original2 && link.href !== original2.href)
        link.href = original2.href;
      return;
    }
    const image = await loadBase();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx)
      return;
    if (image)
      ctx.drawImage(image, 0, 0, SIZE, SIZE);
    drawBadge(ctx, state2, angle);
    try {
      ours = canvas.toDataURL("image/png");
      link.href = ours;
    } catch {}
  }
  function setState(next) {
    state2 = next;
    clearInterval(timer2);
    if (next === "streaming") {
      timer2 = setInterval(() => {
        angle = (angle + Math.PI / 4) % (Math.PI * 2);
        paint2();
      }, SPIN_MS);
    }
    paint2();
  }
  function seen() {
    if (document.visibilityState === "visible" && (state2 === "done" || state2 === "error"))
      setState("idle");
  }
  var tabStatus_default = definePlugin({
    name: "tabStatus",
    title: { zh: "标签页图标状态", en: "Tab icon status" },
    description: {
      zh: "在标签页图标上显示 Notion AI 的状态：生成中转圈，完成显示蓝点，出错显示红点，回到标签页后消失。",
      en: "Shows Notion AI's state on the tab icon: a spinner while writing, a blue dot when done and a red dot on errors, cleared when you return to the tab."
    },
    icon: Icons.browser,
    tags: ["chat"],
    enabledByDefault: true,
    settings: settings9,
    start() {
      remember2();
      const onVisible = () => seen();
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
      cleanups7 = [
        watchReplies(),
        on("replyStart", () => setState("streaming")),
        on("replyEnd", ({ error }) => {
          const away = document.visibilityState !== "visible" || !document.hasFocus();
          setState(error ? away ? "error" : "idle" : away && settings9.store.showDone ? "done" : "idle");
        }),
        onDomChange(() => {
          const link = iconLink();
          if (state2 !== "idle" && link && link.href !== ours)
            paint2();
        }),
        () => document.removeEventListener("visibilitychange", onVisible),
        () => window.removeEventListener("focus", onVisible)
      ];
    },
    stop() {
      for (const cleanup of cleanups7.splice(0))
        cleanup();
      setState("idle");
      original2 = null;
      base = null;
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
  var CSS4 = `${CSS}
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
  var overlay5 = null;
  function closeStats() {
    overlay5?.destroy();
    overlay5 = null;
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
    overlay5 = createOverlay(STATS_HOST_ID, CSS4, "");
    const { root } = overlay5;
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
  function formatCountdown(resetAt, now = Date.now(), used) {
    if (resetAt === null)
      return used === 0 ? t("未开始计时", "not started") : "—";
    const diff = resetAt - now;
    if (diff <= 0)
      return t("即将重置", "resetting");
    const minutes = Math.max(1, Math.ceil(diff / 60000));
    const hours = Math.floor(minutes / 60);
    if (minutes > 1440) {
      const d = Math.floor(hours / 24);
      const h = hours % 24;
      return h ? t(`${d} 天 ${h} 小时后重置`, `resets in ${d}d ${h}h`) : t(`${d} 天后重置`, `resets in ${d}d`);
    }
    const m = minutes % 60;
    if (hours && m)
      return t(`${hours} 小时 ${m} 分后重置`, `resets in ${hours}h ${m}m`);
    if (hours)
      return t(`${hours} 小时后重置`, `resets in ${hours}h`);
    return t(`${m} 分钟后重置`, `resets in ${m}m`);
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

  // src/plugins/usage/styles.ts
  var USAGE_CSS = `
:host {
  all: initial;
  --ring: #ada9a3; --orb-hover: rgba(255,255,255,.055); --warn: #d8a32f; --danger: #e56458;
  position: fixed; top: 16px; left: auto; right: 16px; z-index: 2147483646;
  display: block; width: max-content; max-width: calc(100vw - 16px);
  font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none;
}
:host([data-theme="light"]) { --ring: #7d7a75; --orb-hover: rgba(55,53,47,.06); }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
button { font: inherit; }
[hidden] { display: none !important; }
.shell { position: relative; display: flex; flex-direction: column; align-items: flex-end; }
:host([data-side="left"]) .shell { align-items: flex-start; }
:host([data-docked]) .shell { align-items: center; }
.orb {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 5px;
  border: 0; border-radius: 6px; color: var(--ring); background: transparent; cursor: pointer; user-select: none;
  transition: background .1s ease;
}
.orb:hover, .orb:focus-visible { background: var(--orb-hover); }
.ring { display: block; width: 18px; height: 18px; color: inherit; overflow: visible; }
.ring-track { fill: none; stroke: currentColor; stroke-opacity: .28; stroke-width: 2; }
.ring-fill { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; transition: stroke-dashoffset .3s ease; }
.ring[data-empty] .ring-fill { visibility: hidden; }
.ring[data-tone="warning"] { color: var(--warn); }
.ring[data-tone="danger"] { color: var(--danger); }
.tip {
  position: absolute; left: 50%; top: calc(100% + 6px); z-index: 3; width: max-content; min-width: 176px; max-width: 280px;
  display: flex; flex-direction: column; gap: 8px; padding: 8px 10px;
  border-radius: 6px; color: #f0efed; background: #2c2c2b;
  box-shadow: 0 4px 12px -2px rgba(0,0,0,.16), inset 0 0 0 1px rgba(255,255,255,.05);
  font: 400 12px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; white-space: nowrap; pointer-events: none;
  opacity: 0; visibility: hidden; transform: translateX(-50%); transition: opacity 50ms ease-out, visibility 50ms;
}
:host([data-tip-up]) .tip { top: auto; bottom: calc(100% + 6px); }
:host(:not([data-docked])) .tip { left: auto; right: 0; transform: none; }
:host(:not([data-docked])[data-side="left"]) .tip { left: 0; right: auto; }
.blk { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lbl { font-size: 11px; color: #ada9a3; }
.val { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.sub { color: #ada9a3; font-variant-numeric: tabular-nums; }
.meters { display: grid; grid-template-columns: 1fr 1fr; column-gap: 20px; }
.today { padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,.09); }
.plan, .tip-note { padding-top: 8px; border-top: 1px solid rgba(255,255,255,.09); }
.tip-note { white-space: normal; color: #ada9a3; }
.tip-note[data-kind="error"] { color: #ff9b94; }
.orb:hover + .tip, .orb:focus-visible + .tip { opacity: 1; visibility: visible; }
@media (prefers-reduced-motion: reduce) { .tip, .ring-fill { transition: none; } }
`;
  var RING_RADIUS = 7;
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  var RING = `<svg class="ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="ring-track" cx="9" cy="9" r="${RING_RADIUS}"/><circle class="ring-fill" cx="9" cy="9" r="${RING_RADIUS}" transform="rotate(-90 9 9)" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"/></svg>`;
  var USAGE_HTML = `
<div class="shell">
  <button class="orb" type="button">${RING.replace("ring", "ring r-rolling")}${RING.replace("ring", "ring r-monthly")}</button>
  <span class="tip" role="tooltip">
    <div class="blk today" hidden><div class="lbl tip-l-today"></div><div class="val tip-v-today"></div></div>
    <div class="meters">
      <div class="blk"><div class="lbl tip-l-rolling"></div><div class="val tip-v-rolling"></div><div class="sub tip-w-rolling"></div></div>
      <div class="blk"><div class="lbl tip-l-monthly"></div><div class="val tip-v-monthly"></div><div class="sub tip-w-monthly"></div></div>
    </div>
    <div class="blk plan" hidden><div class="lbl tip-l-plan"></div><div class="val tip-v-plan"></div><div class="sub tip-w-plan"></div></div>
    <div class="tip-note" hidden></div>
  </span>
</div>`;

  // src/plugins/usage/ui.ts
  var HOST_ID2 = "notionai-pp-usage";
  var KEYS = {
    anchor: "notionai-pp:usage:anchor:v1",
    legacyAnchor: "notion-ai-usage:position:v2"
  };
  var DEFAULT_ANCHOR = { xEdge: "right", xOffset: 16, yEdge: "top", yOffset: 16 };
  var TIP_SPACE = 140;
  var TICK_MS = 15000;
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
    anchor = readAnchor() ?? DEFAULT_ANCHOR;
    tracker = new ComposerTracker((box) => this.layout(box));
    cleanups = [];
    tipToday = false;
    tipTimer = 0;
    constructor(service, stats) {
      this.service = service;
      this.stats = stats;
      this.overlay = createOverlay(HOST_ID2, USAGE_CSS, USAGE_HTML);
      const { root } = this.overlay;
      this.q = (selector) => root.querySelector(selector);
      this.bind();
      this.render();
      this.cleanups.push(service.onChange(() => this.render()));
      this.cleanups.push(onRouteChange(() => this.layout()));
      this.tracker.start();
      const tick = setInterval(() => this.render(), TICK_MS);
      const onResize = () => this.layout();
      const onStorage = (event) => {
        if (event.key !== KEYS.anchor)
          return;
        const anchor = parseAnchor(safeJson(event.newValue ?? ""));
        if (anchor) {
          this.anchor = anchor;
          this.layout();
        }
      };
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
      const orb = this.q(".orb");
      orb.addEventListener("click", () => {
        if (this.service.state.canRefresh)
          this.service.refreshNow();
        openStats(this.stats);
      });
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
    place(point) {
      const { host } = this.overlay;
      host.style.left = `${Math.round(point.left)}px`;
      host.style.top = `${Math.round(point.top)}px`;
      host.style.right = "auto";
    }
    layout(composer = this.tracker.current) {
      const { host } = this.overlay;
      host.hidden = isAiRoute() && !composer;
      if (host.hidden)
        return;
      const vp = viewport();
      const orb = this.q(".orb");
      const size = boxOf(orb);
      const point = composer ? dockPoint(composer, size, vp) : null;
      host.toggleAttribute("data-docked", !!point);
      host.dataset.side = point ? "left" : this.anchor.xEdge;
      const target = point ?? pointFromAnchor(this.anchor, vp, size);
      host.toggleAttribute("data-tip-up", vp.height - (target.top + size.height) < TIP_SPACE);
      this.place({ left: 0, top: 0 });
      const hostBox = boxOf(host);
      const orbNow = boxOf(orb);
      this.place({ left: target.left - (orbNow.left - hostBox.left), top: target.top - (orbNow.top - hostBox.top) });
    }
    setText(selector, text) {
      const el = this.q(selector);
      el.textContent = text;
      el.hidden = !text;
    }
    render() {
      const now = Date.now();
      const { snapshot, loading, error, spaceId } = this.service.state;
      const billing = visibleBilling(this.service.state.billing, now);
      const views = meterViews(snapshot, now);
      for (const [selector, view] of [[".r-rolling", views.rolling], [".r-monthly", views.monthly]]) {
        const ring = this.q(selector);
        const percent = Math.min(100, Math.max(0, view.percent ?? 0));
        ring.querySelector(".ring-fill").setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - percent / 100)));
        ring.toggleAttribute("data-empty", view.percent == null || view.percent <= 0);
        ring.dataset.tone = view.tone;
      }
      const applicable = !!snapshot && snapshot.status !== "not_applicable";
      const rolling = applicable ? snapshot.rolling : null;
      const monthly = applicable ? activeMonthly(snapshot, now) : null;
      const rollingText = formatPercent(views.rolling.percent);
      const monthlyText = formatPercent(views.monthly.percent);
      const used = (text) => text === "—" ? text : t(`已用 ${text}`, `${text} used`);
      this.q(".tip-l-rolling").textContent = t("6 小时", "6-hour");
      this.q(".tip-v-rolling").textContent = used(rollingText);
      this.setText(".tip-w-rolling", rolling ? formatCountdown(rolling.resetAt, now, rolling.used) : "");
      this.q(".tip-l-monthly").textContent = t("月度", "Monthly");
      this.q(".tip-v-monthly").textContent = used(monthlyText);
      this.setText(".tip-w-monthly", monthly ? formatCountdown(monthly.resetAt, now, monthly.used) : "");
      const todayText = this.todayText();
      this.q(".today").hidden = !(this.tipToday && todayText !== null && !!monthly);
      this.q(".tip-l-today").textContent = t("今天", "Today");
      this.q(".tip-v-today").textContent = todayText === null ? "" : t(`占月度额度 ${todayText}`, `${todayText} of monthly`);
      const plan = this.stats.showPlan() && billing ? billingRow(billing, now) : null;
      this.q(".plan").hidden = !plan;
      if (plan && billing) {
        const planWhen = billing.kind === "subscription" && billing.periodEndAt !== null ? t(`周期至 ${formatDate(billing.periodEndAt)}`, `until ${formatDate(billing.periodEndAt)}`) : billing.kind === "trial" ? t(`${formatDate(billing.endAt)} 结束`, `ends ${formatDate(billing.endAt)}`) : "";
        this.q(".tip-l-plan").textContent = plan.label;
        this.q(".tip-v-plan").textContent = plan.value;
        this.setText(".tip-w-plan", planWhen);
      }
      let note = "";
      let kind = error ? "error" : "info";
      if (!snapshot) {
        note = error || (loading || spaceId ? t("正在读取 Notion AI 用量…", "Loading Notion AI usage…") : t("等待 Notion 初始化当前工作区", "Waiting for Notion to set up this workspace"));
      } else if (snapshot.status === "not_applicable") {
        note = error || t("当前账户或套餐没有 AI 用量窗口", "This account or plan has no AI usage window");
      } else if (snapshot.status === "rate_limited") {
        kind = "error";
        note = snapshot.limitedBy === "billing_period" ? t("已达到月度额度上限", "The monthly allowance has been reached") : t("已达到 6 小时额度上限", "The 6-hour allowance has been reached");
      } else if (error) {
        note = t(`${error}（显示最后一次有效数据）`, `${error} (showing the last valid data)`);
      }
      const noteEl = this.q(".tip-note");
      noteEl.textContent = note;
      noteEl.hidden = !note;
      noteEl.dataset.kind = kind;
      this.q(".orb").setAttribute("aria-label", !applicable ? t("AI 用量，点击按日期查看", "AI usage, click for usage by date") : t(`AI 用量：6 小时 ${rollingText}，月度 ${monthlyText}，点击按日期查看`, `AI usage: 6h ${rollingText}, Monthly ${monthlyText}, click for usage by date`));
      this.layout();
    }
  }

  // src/plugins/usage/index.ts
  var settings10 = definePluginSettings({
    usageStats: {
      type: "boolean",
      label: { zh: "记录每日用量", en: "Daily usage stats" },
      description: { zh: "按天记录月度额度的使用量", en: "Log how much of the monthly allowance is used each day" },
      default: true
    },
    showPlan: {
      type: "boolean",
      label: { zh: "悬停时显示套餐", en: "Show plan on hover" },
      description: { zh: "在悬停提示里显示套餐和周期截止日期", en: "Show the plan and its period end date in the hover tooltip" },
      default: false
    },
    hoverStatsDelay: {
      type: "number",
      label: { zh: "悬停显示今日用量的延迟（秒）", en: "Delay before showing today on hover, in seconds" },
      default: HOVER_DELAY.default,
      min: HOVER_DELAY.min,
      max: HOVER_DELAY.max
    },
    retainDays: {
      type: "number",
      label: { zh: "保留历史天数", en: "Days of history to keep" },
      default: RETAIN.default,
      min: RETAIN.min,
      max: RETAIN.max
    },
    openStats: {
      type: "action",
      label: { zh: "按日期查看用量", en: "Usage by date" },
      button: { zh: "打开", en: "Open" },
      run: () => openStats(stats)
    },
    clearStats: {
      type: "action",
      label: { zh: "清空用量历史", en: "Clear usage history" },
      description: { zh: "删除本设备上记录的每日用量", en: "Delete the daily usage recorded on this device" },
      button: { zh: "清空…", en: "Clear…" },
      run: () => openStats(stats, { confirmClearNow: true })
    }
  });
  var service = null;
  var widget = null;
  var stopRecording = null;
  function record2() {
    const snapshot = service?.snapshot;
    const space = service?.spaceId;
    if (!settings10.store.usageStats || !space || !snapshot || snapshot.status === "not_applicable")
      return;
    const monthly = activeMonthly(snapshot);
    if (monthly)
      recordSnapshot(space, monthly.percent, monthly.resetAt, settings10.store.retainDays);
  }
  var stats = {
    space: () => service?.spaceId ?? "",
    enabled: () => settings10.store.usageStats,
    setEnabled: (value) => void (settings10.store.usageStats = value),
    retain: () => settings10.store.retainDays,
    hoverDelay: () => settings10.store.hoverStatsDelay,
    showPlan: () => settings10.store.showPlan,
    refresh: record2
  };
  function mount() {
    if (!service || widget || !document.body)
      return;
    widget = new UsageWidget(service, stats);
  }
  var usage_default = definePlugin({
    name: "usageMeter",
    title: { zh: "AI 用量", en: "AI usage" },
    description: {
      zh: "在 AI 输入框底部中央用两个圆环显示 6 小时与月度用量，悬停查看百分比和重置时间，点击按日期查看用量。",
      en: "Two rings at the bottom center of the AI composer show 6-hour and monthly usage. Hover for percentages and reset times; click for usage by date."
    },
    icon: Icons.gauge,
    tags: ["composer"],
    enabledByDefault: true,
    startAt: "DocumentStart" /* DocumentStart */,
    settings: settings10,
    start() {
      service = new UsageService;
      stopRecording = service.onChange(record2);
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
      record2();
      widget?.render();
    }
  });

  // src/plugins/widerChat/index.ts
  var STYLE_ID4 = "notionai-pp-wider-chat";
  var MARK2 = "data-npp-chat-column";
  var COMPOSER3 = "[data-notion-chat-input-container]";
  var COMPOSER_INSET = 56;
  var settings11 = definePluginSettings({
    width: {
      type: "number",
      label: { zh: "对话最大宽度（像素）", en: "Maximum chat width (px)" },
      description: { zh: "Notion 默认 798", en: "Notion's default is 798" },
      default: 1100,
      min: 600,
      max: 2400
    }
  });
  var stopDom4 = null;
  function columnOf(step) {
    for (let node = step.parentElement;node && node !== document.body; node = node.parentElement) {
      const cap = node.style.maxWidth;
      if (cap && cap.endsWith("px"))
        return node;
    }
    return null;
  }
  function mark() {
    const step = document.querySelector(`[${USER_STEP}]`);
    const column = step ? columnOf(step) : null;
    if (column && !column.hasAttribute(MARK2)) {
      for (const old of document.querySelectorAll(`[${MARK2}]`))
        old.removeAttribute(MARK2);
      column.setAttribute(MARK2, "");
    }
  }
  function css2(width) {
    return `[${MARK2}] { max-width: ${width}px !important; }
${COMPOSER3} { max-width: ${width - COMPOSER_INSET}px !important; }`;
  }
  function apply3() {
    let style = document.getElementById(STYLE_ID4);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID4;
      (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css2(settings11.store.width);
  }
  var widerChat_default = definePlugin({
    name: "widerChat",
    title: { zh: "对话宽度", en: "Wider chat" },
    description: {
      zh: "调节 Notion AI 对话区和输入框的最大宽度，适合大屏。",
      en: "Sets the maximum width of the Notion AI chat and composer, for large screens."
    },
    icon: Icons.width,
    tags: ["appearance"],
    enabledByDefault: true,
    settings: settings11,
    start() {
      apply3();
      mark();
      stopDom4 = onDomChange(mark);
    },
    stop() {
      stopDom4?.();
      stopDom4 = null;
      document.getElementById(STYLE_ID4)?.remove();
      for (const node of document.querySelectorAll(`[${MARK2}]`))
        node.removeAttribute(MARK2);
    },
    onSettingsChange() {
      apply3();
    }
  });

  // src/index.ts
  var FLAG = "__notionAiPlusPlus";
  var logger5 = new Logger("Core");
  function boot() {
    const win = pageWindow;
    if (win[FLAG] || !isTopmostNotionDocument())
      return;
    win[FLAG] = "[20261007] v1.5.0";
    installHooks();
    registerPlugins([
      settings_default,
      usage_default,
      navigator_default,
      messageStars_default,
      replyNotification_default,
      tabStatus_default,
      inputHistory_default,
      widerChat_default,
      hideShare_default,
      autoCollapseThinking_default,
      focusHighlight_default,
      greetingCustomizer_default
    ]);
    startPlugins("DocumentStart" /* DocumentStart */);
    const ready = () => startPlugins("DomReady" /* DomReady */);
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", ready, { once: true });
    else
      ready();
    pageWindow.addEventListener("storage", (event) => event.key === SETTINGS_KEY && reloadFromStorage(event.newValue));
    logger5.info(`NotionAI++ ${"[20261007] v1.5.0"} started`);
  }
  boot();
})();
