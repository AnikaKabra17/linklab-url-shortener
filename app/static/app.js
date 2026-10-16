// LinkLab frontend: shared helpers + one small initializer per page.
// All data comes from the real API on the same origin. User-controlled values
// are only ever written with textContent / attributes, never parsed as HTML.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const ICONS = "/static/icons.svg";

  // ---------------------------------------------------------------- helpers

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `${ICONS}#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  class ApiError extends Error {
    constructor(status, detail, errors) {
      super(detail);
      this.status = status;
      this.errors = errors || [];
    }
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      });
    } catch {
      throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
    }
    if (response.status === 204) return null;
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON body */ }
    if (!response.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Request failed (${response.status}).`;
      throw new ApiError(response.status, detail, data && data.errors);
    }
    return data;
  }

  const numberFmt = new Intl.NumberFormat();
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const plural = (n, one, many) => `${numberFmt.format(n)} ${n === 1 ? one : many}`;
  const withoutScheme = (url) => url.replace(/^https?:\/\//i, "");
  const qrPath = (code) => `/url/${encodeURIComponent(code)}/qr`;

  function relative(iso) {
    const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(seconds);
    if (abs < 45) return seconds <= 0 ? "just now" : "in a few seconds";
    const units = [["minute", 60], ["hour", 3600], ["day", 86400], ["month", 2592000], ["year", 31536000]];
    let unit = units[0];
    for (const u of units) if (abs >= u[1]) unit = u;
    return relFmt.format(Math.round(seconds / unit[1]), unit[0]);
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }

  function toast(message, kind = "success") {
    const box = $("toasts");
    if (!box) return;
    const node = el("div", { class: `toast${kind === "error" ? " is-error" : ""}` },
      [icon(kind === "error" ? "alert" : "check"), el("span", { text: message })]);
    while (box.children.length >= 2) box.firstElementChild.remove();
    box.append(node);
    setTimeout(() => node.remove(), 3000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to legacy path */ }
    const area = el("textarea", { readonly: "", class: "visually-hidden" });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }

  async function copyWithFeedback(text, button) {
    if (!(await copyText(text))) {
      toast("Couldn't copy. Select the link and copy it manually.", "error");
      return;
    }
    if (!button) { toast("Copied to clipboard"); return; } // buttons show their own "Copied" state
    const label = button.querySelector("span");
    const use = button.querySelector("use");
    const prev = label && label.textContent;
    if (use) use.setAttribute("href", `${ICONS}#i-check`);
    if (label) label.textContent = "Copied";
    clearTimeout(button._t);
    button._t = setTimeout(() => {
      if (use) use.setAttribute("href", `${ICONS}#i-copy`);
      if (label) label.textContent = prev;
    }, 1600);
  }

  function linkIdentity(link) {
    const host = hostOf(link.original_url);
    const prefix = withoutScheme(link.short_url).slice(0, -link.short_code.length);
    const code = el("a", { class: "code-link", href: link.short_url, target: "_blank", rel: "noopener noreferrer", title: `Open ${link.short_url}` },
      [el("span", { class: "host", text: prefix }), link.short_code]);
    const dest = el("button", { type: "button", class: "dest", "aria-expanded": "false", title: "Show full long URL" },
      [icon("corner"), el("span", { class: "dest-text", text: withoutScheme(link.original_url) })]);
    dest.addEventListener("click", () => {
      const open = dest.getAttribute("aria-expanded") !== "true";
      dest.setAttribute("aria-expanded", String(open));
      dest.title = open ? "Collapse" : "Show full long URL";
    });
    return el("div", { class: "link-cell" }, [
      el("span", { class: "favicon", "aria-hidden": "true", text: host[0] || "?" }),
      el("div", { class: "link-text" }, [code, dest]),
    ]);
  }

  // ------------------------------------------------------- shared: chrome

  function initTheme() {
    const btn = $("theme-toggle");
    if (!btn) return;
    const root = document.documentElement;
    const current = () => root.getAttribute("data-theme")
      || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const sync = () => btn.setAttribute("aria-label", current() === "dark" ? "Switch to light mode" : "Switch to dark mode");
    btn.addEventListener("click", () => {
      const next = current() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("linklab-theme", next); } catch { /* not persisted */ }
      sync();
    });
    sync();
  }

  async function checkHealth() {
    const pill = $("health");
    if (!pill) return null;
    const text = pill.querySelector(".label-text");
    try {
      const h = await api("/health");
      pill.dataset.state = "ok";
      text.textContent = "Online";
      pill.title = "Service and database are healthy";
      return h;
    } catch {
      pill.dataset.state = "down";
      text.textContent = "Offline";
      pill.title = "The service is not responding";
      return null;
    }
  }

  // ------------------------------------------------------------ page: home

  function initHome() {
    const els = {
      form: $("shorten-form"), bar: $("url-bar"), url: $("url-input"), urlError: $("url-error"),
      alias: $("alias-input"), aliasError: $("alias-error"), aliasPrefix: $("alias-prefix"),
      expiry: $("expiry-select"), advanced: $("advanced"), toggle: $("advanced-toggle"),
      submit: $("submit-btn"), formError: $("form-error"), result: $("result"),
      recent: $("recent-list"), flowHost: $("flow-host"),
    };
    let submitting = false;
    let lastCreated = null;

    function setFieldError(input, node, message) {
      const wrapper = input === els.url ? els.bar : null;
      if (message) {
        node.replaceChildren(icon("alert"), el("span", { text: message }));
        node.hidden = false;
        input.setAttribute("aria-invalid", "true");
        if (wrapper) wrapper.classList.add("is-invalid");
      } else {
        node.replaceChildren();
        node.hidden = true;
        input.removeAttribute("aria-invalid");
        if (wrapper) wrapper.classList.remove("is-invalid");
      }
    }
    const showFormError = (m) => { els.formError.querySelector("span").textContent = m || ""; els.formError.hidden = !m; };
    const setAdvanced = (open) => { els.advanced.hidden = !open; els.toggle.setAttribute("aria-expanded", String(open)); };

    function validateLocally(url, alias) {
      let ok = true;
      if (!url) {
        setFieldError(els.url, els.urlError, "Paste a long URL to shorten.");
        ok = false;
      } else {
        let parsed = null;
        try { parsed = new URL(url); } catch { /* invalid */ }
        if (!parsed) {
          const hint = /^[\w-]+(\.[\w-]+)+/.test(url) ? ` Try https://${url}` : "";
          setFieldError(els.url, els.urlError, `Enter a complete URL.${hint}`);
          ok = false;
        } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          setFieldError(els.url, els.urlError, "Only http:// and https:// URLs can be shortened.");
          ok = false;
        }
      }
      if (alias && !/^[A-Za-z0-9_-]{3,30}$/.test(alias)) {
        setAdvanced(true);
        setFieldError(els.alias, els.aliasError, "Use 3–30 letters, numbers, - or _ (no spaces).");
        ok = false;
      }
      return ok;
    }

    function setSubmitting(busy) {
      submitting = busy;
      els.submit.disabled = busy;
      els.submit.classList.toggle("is-loading", busy);
      els.submit.querySelector(".btn-label").textContent = busy ? "Shortening" : "Shorten";
      els.form.setAttribute("aria-busy", String(busy));
    }

    function handleError(error) {
      if (error.status === 409) {
        setAdvanced(true);
        setFieldError(els.alias, els.aliasError, `${error.message} Choose another alias.`);
        els.alias.focus();
        return;
      }
      if (error.status === 422 || error.status === 400) {
        let placed = false;
        for (const err of error.errors.length ? error.errors : [{ field: "url", message: error.message }]) {
          if (err.field === "custom_alias") {
            setAdvanced(true);
            setFieldError(els.alias, els.aliasError, err.message);
            placed = true;
          } else if (err.field === "url" || error.status === 400) {
            setFieldError(els.url, els.urlError, err.message);
            placed = true;
          }
        }
        if (!placed) showFormError(error.message);
        return;
      }
      showFormError(error.message || "Something went wrong. Please try again.");
    }

    function showResult(link) {
      lastCreated = link;
      const longLen = link.original_url.length;
      const shortLen = link.short_url.length;
      const saved = longLen - shortLen;

      $("result-domain").textContent = `Redirects to ${hostOf(link.original_url)}`;
      const a = $("result-link");
      a.textContent = withoutScheme(link.short_url);
      a.href = link.short_url;
      a.title = link.short_url;
      $("result-open").href = link.short_url;
      const dest = $("result-dest");
      dest.textContent = link.original_url;
      dest.title = link.original_url;
      $("result-short-text").textContent = link.short_url;
      $("result-long-count").textContent = plural(longLen, "char", "chars");
      $("result-short-count").textContent = plural(shortLen, "char", "chars");

      const fill = $("savings-fill");
      const text = $("savings-text");
      fill.style.width = "0";
      if (saved > 0) {
        const pct = Math.round((saved / longLen) * 100);
        text.replaceChildren(el("strong", { text: `${pct}% shorter` }));
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pct}%`; }));
      } else {
        text.textContent = "Already short";
      }
      $("result-expiry").textContent = link.expires_at
        ? `Expires ${relative(link.expires_at)} · ${dateFmt.format(new Date(link.expires_at))}`
        : "Never expires";

      const qr = $("result-qr");
      qr.src = qrPath(link.short_code);
      qr.alt = `QR code for ${link.short_url}`;
      const dl = $("result-qr-download");
      dl.href = qrPath(link.short_code);
      dl.setAttribute("download", `linklab-${link.short_code}.svg`);
      els.result.hidden = false;
      els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    async function loadRecent() {
      try {
        const data = await api("/urls?limit=5");
        if (!data.items.length) {
          els.recent.replaceChildren(el("p", { class: "list-empty", text: "No short links yet. Your first one will appear here." }));
          return;
        }
        els.recent.replaceChildren(...data.items.map((link) => {
          const copy = el("button", { type: "button", class: "btn btn-copy", "aria-label": `Copy ${link.short_url}` },
            [icon("copy"), el("span", { text: "Copy" })]);
          copy.addEventListener("click", () => copyWithFeedback(link.short_url, copy));
          return el("div", { class: "mini-row" }, [
            linkIdentity(link),
            el("span", { class: "mini-visits", text: plural(link.clicks, "visit", "visits") }),
            copy,
          ]);
        }));
      } catch (error) {
        els.recent.replaceChildren(el("p", { class: "list-empty", text: error.message }));
      }
    }

    els.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting) return; // no duplicate submissions
      setFieldError(els.url, els.urlError, null);
      setFieldError(els.alias, els.aliasError, null);
      showFormError(null);

      const url = els.url.value.trim();
      const alias = els.alias.value.trim();
      if (!validateLocally(url, alias)) {
        (els.url.getAttribute("aria-invalid") ? els.url : els.alias).focus();
        return;
      }
      const body = { url };
      if (alias) body.custom_alias = alias;
      if (els.expiry.value) body.expires_in_minutes = Number(els.expiry.value);

      setSubmitting(true);
      try {
        const link = await api("/shorten", { method: "POST", body: JSON.stringify(body) });
        showResult(link); // the result card itself is the confirmation
        els.form.reset();
        setAdvanced(false);
        loadRecent();
      } catch (error) {
        handleError(error);
      } finally {
        setSubmitting(false);
      }
    });

    els.toggle.addEventListener("click", () => setAdvanced(els.advanced.hidden));
    els.url.addEventListener("input", () => setFieldError(els.url, els.urlError, null));
    els.alias.addEventListener("input", () => setFieldError(els.alias, els.aliasError, null));
    $("result-copy").addEventListener("click", () => lastCreated && copyWithFeedback(lastCreated.short_url, $("result-copy")));
    $("result-new").addEventListener("click", () => { els.result.hidden = true; els.url.focus(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadRecent(); });

    els.aliasPrefix.textContent = `${location.host}/`;
    els.flowHost.textContent = `GET ${location.host}/spring-sale`;
    loadRecent();
  }

  // ------------------------------------------------------- page: dashboard

  function initDashboard() {
    const els = {
      grid: $("stat-grid"), total: $("stat-total"), totalSub: $("stat-total-sub"), clicks: $("stat-clicks"),
      recent: $("stat-recent"), top: $("stat-top"), topSub: $("stat-top-sub"),
      search: $("search"), sort: $("sort"), refresh: $("refresh"), count: $("links-count"),
      state: $("table-state"), table: $("links-table"), body: $("links-body"),
      del: $("delete-dialog"), delCode: $("delete-code"), qr: $("qr-dialog"),
    };
    const state = { links: [], total: 0, loaded: false, error: null, pendingDelete: null };

    async function loadSummary() {
      try {
        const s = await api("/api/analytics/summary");
        els.total.textContent = numberFmt.format(s.total_links);
        els.totalSub.textContent = s.expired_links > 0
          ? `${numberFmt.format(s.active_links)} active · ${numberFmt.format(s.expired_links)} expired`
          : "Stored in SQLite";
        els.clicks.textContent = numberFmt.format(s.total_clicks);
        els.recent.textContent = numberFmt.format(s.links_created_24h);
        if (s.top_link) {
          els.top.textContent = `/${s.top_link.short_code}`;
          els.top.title = s.top_link.original_url;
          els.topSub.textContent = plural(s.top_link.clicks, "visit", "visits");
        } else {
          els.top.textContent = "—";
          els.top.removeAttribute("title");
          els.topSub.textContent = "No visits yet";
        }
        els.grid.setAttribute("aria-busy", "false");
      } catch {
        els.totalSub.textContent = "Couldn't load totals";
      }
    }

    async function loadLinks(manual = false) {
      if (manual) els.refresh.classList.add("spinning");
      try {
        const data = await api("/urls");
        state.links = data.items;
        state.total = data.total;
        state.error = null;
      } catch (error) {
        state.error = error.message;
      } finally {
        state.loaded = true;
        setTimeout(() => els.refresh.classList.remove("spinning"), manual ? 400 : 0);
        render();
      }
    }

    const refreshAll = (manual) => Promise.all([loadLinks(manual), loadSummary()]);

    function visible() {
      const q = els.search.value.trim().toLowerCase();
      const items = q
        ? state.links.filter((l) => l.short_code.toLowerCase().includes(q) || l.original_url.toLowerCase().includes(q))
        : state.links.slice();
      const by = els.sort.value;
      items.sort((a, b) => {
        if (by === "oldest") return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
        if (by === "clicks") return b.clicks - a.clicks || (a.created_at < b.created_at ? 1 : -1);
        if (by === "alias") return a.short_code.localeCompare(b.short_code, undefined, { sensitivity: "base" });
        return 0; // API already returns newest first
      });
      return items;
    }

    function renderState(kind, title, message, action) {
      els.state.replaceChildren();
      els.state.classList.toggle("is-error", kind === "error");
      if (kind === "loading") {
        els.state.append(el("div", { class: "skeleton" }, [1, 2, 3].map(() => el("div", { class: "skeleton-row" }))),
          el("span", { class: "visually-hidden", text: "Loading links" }));
        return;
      }
      els.state.append(el("div", { class: "state-icon" }, icon({ empty: "link", nomatch: "search", error: "alert" }[kind])),
        el("strong", { text: title }), el("p", { text: message }));
      if (action) els.state.append(action);
    }

    function badge(link) {
      if (link.is_expired) return el("span", { class: "badge badge-expired", text: "Expired", title: "No longer redirects" });
      if (link.expires_at) {
        return el("span", { class: "badge badge-expiring", text: `Expires ${relative(link.expires_at)}`,
          title: dateFmt.format(new Date(link.expires_at)) });
      }
      return el("span", { class: "badge badge-active", text: "Active", title: "Redirecting visitors" });
    }

    function tool(name, tip, label, onClick, extra = "") {
      const b = el("button", { type: "button", class: `btn btn-tool ${extra}`.trim(), "aria-label": label, "data-tip": tip }, icon(name));
      b.addEventListener("click", onClick);
      return b;
    }

    function row(link, max) {
      const bar = el("span");
      bar.style.width = max > 0 ? `${Math.max(link.clicks ? 6 : 0, (link.clicks / max) * 100)}%` : "0";
      const copy = el("button", { type: "button", class: "btn btn-copy", "aria-label": `Copy /${link.short_code}` },
        [icon("copy"), el("span", { text: "Copy" })]);
      copy.addEventListener("click", () => copyWithFeedback(link.short_url, copy));
      const open = el("a", { class: "btn btn-tool", href: link.short_url, target: "_blank", rel: "noopener noreferrer",
        "aria-label": `Open /${link.short_code}`, "data-tip": link.is_expired ? "Expired" : "Open" }, icon("external"));
      if (link.is_expired) open.setAttribute("aria-disabled", "true");

      return el("tr", { class: link.is_expired ? "is-expired" : undefined }, [
        el("td", { class: "col-link" }, linkIdentity(link)),
        el("td", { class: "col-visits" }, el("div", { class: "visits" }, [
          el("span", { class: "visits-num", text: numberFmt.format(link.clicks) }),
          el("span", { class: "visits-bar", "aria-hidden": "true" }, bar),
        ])),
        el("td", { class: "col-created created" }, el("time", { datetime: link.created_at,
          title: dateFmt.format(new Date(link.created_at)), text: relative(link.created_at) })),
        el("td", { class: "col-status" }, badge(link)),
        el("td", { class: "col-actions" }, el("div", { class: "row-actions" }, [
          copy,
          tool("qr", "QR code", `QR code for /${link.short_code}`, () => openQr(link)),
          open,
          tool("trash", "Delete", `Delete /${link.short_code}`, () => confirmDelete(link), "danger"),
        ])),
      ]);
    }

    function render() {
      if (!state.loaded) { els.table.hidden = true; renderState("loading"); return; }
      if (state.error) {
        els.table.hidden = true;
        els.count.textContent = "Unavailable";
        const retry = el("button", { type: "button", class: "btn btn-secondary" }, [icon("refresh"), "Try again"]);
        retry.addEventListener("click", () => loadLinks(true));
        renderState("error", "Couldn't load links", state.error, retry);
        return;
      }
      if (!state.links.length) {
        els.table.hidden = true;
        els.count.textContent = "0 links";
        renderState("empty", "No short links yet", "Create one and it will appear here with its visits.",
          el("a", { class: "btn btn-primary", href: "/" }, [icon("plus"), "New short link"]));
        return;
      }
      const items = visible();
      const capped = state.total > state.links.length ? ` · showing newest ${numberFmt.format(state.links.length)}` : "";
      els.count.textContent = els.search.value.trim()
        ? `${numberFmt.format(items.length)} of ${plural(state.links.length, "link", "links")}`
        : `${plural(state.total, "link", "links")}${capped}`;
      if (!items.length) {
        els.table.hidden = true;
        const clear = el("button", { type: "button", class: "btn btn-secondary", text: "Clear search" });
        clear.addEventListener("click", () => { els.search.value = ""; render(); els.search.focus(); });
        renderState("nomatch", "No matches", "No alias or long URL contains that text.", clear);
        return;
      }
      els.state.replaceChildren();
      els.state.classList.remove("is-error");
      const max = Math.max(0, ...state.links.map((l) => l.clicks));
      els.body.replaceChildren(...items.map((l) => row(l, max)));
      els.table.hidden = false;
    }

    function openQr(link) {
      const img = $("qr-image");
      img.src = qrPath(link.short_code);
      img.alt = `QR code for ${link.short_url}`;
      $("qr-url").textContent = withoutScheme(link.short_url);
      const dl = $("qr-download");
      dl.href = qrPath(link.short_code);
      dl.setAttribute("download", `linklab-${link.short_code}.svg`);
      els.qr.showModal();
    }

    function confirmDelete(link) {
      state.pendingDelete = link;
      els.delCode.textContent = withoutScheme(link.short_url);
      els.del.returnValue = "";
      els.del.showModal();
    }

    els.del.addEventListener("close", async () => {
      const link = state.pendingDelete;
      state.pendingDelete = null;
      if (!link || els.del.returnValue !== "confirm") return;
      try {
        await api(`/url/${encodeURIComponent(link.short_code)}`, { method: "DELETE" });
        toast(`Deleted /${link.short_code}`);
      } catch (error) {
        toast(error.status === 404 ? "That link was already deleted." : error.message, "error");
      }
      refreshAll();
    });

    els.search.addEventListener("input", render);
    els.sort.addEventListener("change", render);
    els.refresh.addEventListener("click", () => { refreshAll(true); checkHealth(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshAll(); });
    render();
    refreshAll();
  }

  // ---------------------------------------------------- page: how it works

  async function initHow() {
    const [health, summary] = await Promise.all([
      checkHealth(),
      api("/api/analytics/summary").catch(() => null),
    ]);
    $("live-dot").className = `dot ${health ? "ok" : "down"}`;
    $("live-health").textContent = health ? "Online" : "Offline";
    $("live-storage").textContent = health ? (health.storage === "sqlite-in-memory" ? "SQLite · in memory" : health.storage) : "—";
    $("live-links").textContent = health ? numberFmt.format(health.links) : "—";
    $("live-visits").textContent = summary ? numberFmt.format(summary.total_clicks) : "—";
  }

  // -------------------------------------------------------------------- boot

  initTheme();
  const page = document.body.dataset.page;
  if (page === "home") initHome();
  if (page === "dashboard") initDashboard();
  if (page === "how") initHow();
  else checkHealth();
  setInterval(checkHealth, 30000);
})();
