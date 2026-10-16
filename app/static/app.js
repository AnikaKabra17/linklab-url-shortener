// LinkLab frontend. All data comes from the real API on the same origin.
// User-controlled values are only ever written with textContent / attributes,
// never parsed as HTML.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    form: $("shorten-form"),
    url: $("url-input"),
    urlError: $("url-error"),
    alias: $("alias-input"),
    aliasError: $("alias-error"),
    aliasPrefix: $("alias-prefix"),
    expiry: $("expiry-select"),
    advanced: $("advanced"),
    submit: $("submit-btn"),
    formError: $("form-error"),
    result: $("result"),
    resultLink: $("result-link"),
    resultDest: $("result-dest"),
    resultExpiry: $("result-expiry"),
    resultCopy: $("result-copy"),
    resultOpen: $("result-open"),
    resultQr: $("result-qr"),
    resultQrDownload: $("result-qr-download"),
    health: $("health"),
    statGrid: $("stat-grid"),
    statTotal: $("stat-total"),
    statTotalSub: $("stat-total-sub"),
    statClicks: $("stat-clicks"),
    statRecent: $("stat-recent"),
    statTop: $("stat-top"),
    statTopSub: $("stat-top-sub"),
    search: $("search"),
    sort: $("sort"),
    refresh: $("refresh"),
    linksCount: $("links-count"),
    tableState: $("table-state"),
    table: $("links-table"),
    tbody: $("links-body"),
    deleteDialog: $("delete-dialog"),
    deleteCode: $("delete-code"),
    qrDialog: $("qr-dialog"),
    qrImage: $("qr-image"),
    qrUrl: $("qr-url"),
    qrDownload: $("qr-download"),
    toasts: $("toasts"),
  };

  const state = {
    links: [],
    total: 0,
    loaded: false,
    loadError: null,
    submitting: false,
    pendingDelete: null,
  };

  // ---------------------------------------------------------------- helpers

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
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
    for (const child of [].concat(children)) if (child) node.append(child);
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
      throw new ApiError(0, "Cannot reach the server. Check that the service is running and try again.");
    }
    if (response.status === 204) return null;
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON body */ }
    if (!response.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Request failed (HTTP ${response.status}).`;
      throw new ApiError(response.status, detail, data && data.errors);
    }
    return data;
  }

  const numberFmt = new Intl.NumberFormat();
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  function relative(iso) {
    const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
    const abs = Math.abs(seconds);
    if (abs < 45) return seconds <= 0 ? "just now" : "in a few seconds";
    const units = [["minute", 60], ["hour", 3600], ["day", 86400], ["month", 2592000], ["year", 31536000]];
    let unit = units[0];
    for (const u of units) if (abs >= u[1]) unit = u;
    return relFmt.format(Math.round(seconds / unit[1]), unit[0]);
  }

  function toast(message, kind = "success") {
    const node = el("div", { class: `toast${kind === "error" ? " is-error" : ""}` },
      [icon(kind === "error" ? "alert" : "check"), el("span", { text: message })]);
    els.toasts.append(node);
    setTimeout(() => node.remove(), 3500);
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
    const ok = await copyText(text);
    if (ok) {
      toast("Short link copied to clipboard");
      if (button) {
        const label = button.querySelector("span");
        const use = button.querySelector("use");
        const prevLabel = label && label.textContent;
        if (use) use.setAttribute("href", "#i-check");
        if (label) label.textContent = "Copied";
        setTimeout(() => {
          if (use) use.setAttribute("href", "#i-copy");
          if (label) label.textContent = prevLabel;
        }, 1600);
      }
    } else {
      toast("Couldn't access the clipboard — select the link and copy it manually.", "error");
    }
  }

  const qrPath = (code) => `/url/${encodeURIComponent(code)}/qr`;

  // ------------------------------------------------------------- validation

  function setFieldError(input, errorNode, message) {
    if (message) {
      errorNode.textContent = message;
      errorNode.hidden = false;
      input.setAttribute("aria-invalid", "true");
    } else {
      errorNode.textContent = "";
      errorNode.hidden = true;
      input.removeAttribute("aria-invalid");
    }
  }

  function showFormError(message) {
    els.formError.querySelector("span").textContent = message || "";
    els.formError.hidden = !message;
  }

  function clearErrors() {
    setFieldError(els.url, els.urlError, null);
    setFieldError(els.alias, els.aliasError, null);
    showFormError(null);
  }

  // Quick client-side checks for instant feedback; the API remains the authority.
  function validateLocally(url, alias) {
    let ok = true;
    if (!url) {
      setFieldError(els.url, els.urlError, "Enter the URL you want to shorten.");
      ok = false;
    } else {
      let parsed = null;
      try { parsed = new URL(url); } catch { /* invalid */ }
      if (!parsed) {
        const hint = /^[\w-]+(\.[\w-]+)+/.test(url) ? ` Did you mean https://${url} ?` : "";
        setFieldError(els.url, els.urlError, `That doesn't look like a complete URL.${hint}`);
        ok = false;
      } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setFieldError(els.url, els.urlError, "Only http:// and https:// links can be shortened.");
        ok = false;
      }
    }
    if (alias && !/^[A-Za-z0-9_-]{3,30}$/.test(alias)) {
      els.advanced.open = true;
      setFieldError(els.alias, els.aliasError, "Use 3–30 letters, numbers, hyphens or underscores.");
      ok = false;
    }
    return ok;
  }

  // ------------------------------------------------------------- shortening

  function setSubmitting(busy) {
    state.submitting = busy;
    els.submit.disabled = busy;
    els.submit.classList.toggle("is-loading", busy);
    els.submit.querySelector(".btn-label").textContent = busy ? "Shortening…" : "Shorten URL";
    els.form.setAttribute("aria-busy", String(busy));
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.submitting) return; // guard against double submission
    clearErrors();

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
      showResult(link);
      toast("Short link created");
      els.form.reset();
      refreshAll();
    } catch (error) {
      handleCreateError(error);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCreateError(error) {
    if (error.status === 409) {
      els.advanced.open = true;
      setFieldError(els.alias, els.aliasError, `${error.message} Try a different alias, or leave it empty for a random one.`);
      els.alias.focus();
      return;
    }
    if (error.status === 422 || error.status === 400) {
      let placed = false;
      for (const err of error.errors.length ? error.errors : [{ field: "url", message: error.message }]) {
        if (err.field === "custom_alias") {
          els.advanced.open = true;
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
    if (error.status === 429) {
      showFormError(error.message);
      return;
    }
    showFormError(error.message || "Something went wrong. Please try again.");
  }

  function showResult(link) {
    els.resultLink.textContent = link.short_url;
    els.resultLink.href = link.short_url;
    els.resultOpen.href = link.short_url;
    els.resultDest.textContent = link.original_url;
    els.resultExpiry.textContent = link.expires_at
      ? `${dateFmt.format(new Date(link.expires_at))} (${relative(link.expires_at)})`
      : "Never";
    els.resultQr.src = qrPath(link.short_code);
    els.resultQr.alt = `QR code for ${link.short_url}`;
    els.resultQrDownload.href = qrPath(link.short_code);
    els.resultQrDownload.setAttribute("download", `linklab-${link.short_code}.svg`);
    els.resultCopy.onclick = () => copyWithFeedback(link.short_url, els.resultCopy);
    els.result.hidden = false;
  }

  // -------------------------------------------------------------- dashboard

  async function loadSummary() {
    try {
      const s = await api("/api/analytics/summary");
      els.statTotal.textContent = numberFmt.format(s.total_links);
      els.statTotalSub.textContent = `${numberFmt.format(s.active_links)} active · ${numberFmt.format(s.expired_links)} expired`;
      els.statClicks.textContent = numberFmt.format(s.total_clicks);
      els.statRecent.textContent = numberFmt.format(s.links_created_24h);
      if (s.top_link) {
        els.statTop.textContent = `/${s.top_link.short_code}`;
        els.statTop.title = s.top_link.original_url;
        els.statTopSub.textContent = `${numberFmt.format(s.top_link.clicks)} ${s.top_link.clicks === 1 ? "click" : "clicks"}`;
      } else {
        els.statTop.textContent = "—";
        els.statTop.removeAttribute("title");
        els.statTopSub.textContent = "No clicks recorded yet";
      }
      els.statGrid.setAttribute("aria-busy", "false");
    } catch {
      els.statTotalSub.textContent = "Couldn't load statistics";
    }
  }

  // ------------------------------------------------------------ links table

  async function loadLinks({ manual = false } = {}) {
    if (manual) els.refresh.classList.add("spinning");
    try {
      const data = await api("/urls");
      state.links = data.items;
      state.total = data.total;
      state.loadError = null;
    } catch (error) {
      state.loadError = error.message;
    } finally {
      state.loaded = true;
      els.refresh.classList.remove("spinning");
      renderLinks();
    }
  }

  function refreshAll(opts) {
    return Promise.all([loadLinks(opts), loadSummary()]);
  }

  function visibleLinks() {
    const q = els.search.value.trim().toLowerCase();
    const items = q
      ? state.links.filter((l) => l.short_code.toLowerCase().includes(q) || l.original_url.toLowerCase().includes(q))
      : state.links.slice();
    const by = els.sort.value;
    const created = (l) => l.created_at;
    items.sort((a, b) => {
      switch (by) {
        case "oldest": return created(a) < created(b) ? -1 : created(a) > created(b) ? 1 : 0;
        case "clicks": return b.clicks - a.clicks || (created(a) < created(b) ? 1 : -1);
        case "alias": return a.short_code.localeCompare(b.short_code, undefined, { sensitivity: "base" });
        default: return 0; // API already returns newest first
      }
    });
    return items;
  }

  function renderState(kind, title, message, action) {
    els.tableState.replaceChildren();
    els.tableState.classList.toggle("is-error", kind === "error");
    if (kind === "loading") {
      els.tableState.append(el("div", { class: "skeleton-row" }), el("div", { class: "skeleton-row" }),
        el("span", { class: "visually-hidden", text: "Loading links…" }));
      return;
    }
    const iconName = { empty: "link", nomatch: "search", error: "alert" }[kind];
    els.tableState.append(
      el("div", { class: "state-icon" }, icon(iconName)),
      el("strong", { text: title }),
      el("p", { text: message }),
    );
    if (action) els.tableState.append(action);
  }

  function statusBadge(link) {
    if (link.is_expired) return el("span", { class: "badge badge-expired", text: "Expired" });
    if (link.expires_at) {
      return el("span", { class: "badge badge-expiring", text: `Expires ${relative(link.expires_at)}`,
        title: dateFmt.format(new Date(link.expires_at)) });
    }
    return el("span", { class: "badge badge-active", text: "Active" });
  }

  function actionButton(iconName, label, onClick, extraClass = "") {
    const btn = el("button", { type: "button", class: `btn ${extraClass}`.trim(), "aria-label": label, title: label }, icon(iconName));
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderRow(link) {
    const expired = link.is_expired;
    const codeLink = el("a", { class: "code-link", href: link.short_url, target: "_blank", rel: "noopener noreferrer",
      title: link.short_url, text: `/${link.short_code}` });

    const dest = el("button", { type: "button", class: "dest", "aria-expanded": "false",
      title: "Show full destination", text: link.original_url });
    dest.addEventListener("click", () => {
      const open = dest.getAttribute("aria-expanded") !== "true";
      dest.setAttribute("aria-expanded", String(open));
      dest.title = open ? "Collapse destination" : "Show full destination";
    });

    const time = el("time", { datetime: link.created_at, title: dateFmt.format(new Date(link.created_at)),
      text: relative(link.created_at) });

    const open = el("a", { class: "btn", href: link.short_url, target: "_blank", rel: "noopener noreferrer",
      "aria-label": `Open /${link.short_code} in a new tab`, title: expired ? "Expired — no longer redirects" : "Open short link" },
      icon("external"));
    if (expired) open.setAttribute("aria-disabled", "true");

    const actions = el("div", { class: "row-actions" }, [
      actionButton("copy", `Copy /${link.short_code}`, () => copyWithFeedback(link.short_url)),
      open,
      actionButton("qr", `Show QR code for /${link.short_code}`, () => openQr(link)),
      actionButton("trash", `Delete /${link.short_code}`, () => confirmDelete(link), "danger"),
    ]);

    return el("tr", { class: expired ? "is-expired" : undefined }, [
      el("td", { class: "col-code" }, codeLink),
      el("td", { class: "col-dest" }, dest),
      el("td", { class: "col-created created" }, time),
      el("td", { class: "col-status" }, statusBadge(link)),
      el("td", { class: "col-clicks num", text: numberFmt.format(link.clicks) }),
      el("td", { class: "col-actions" }, actions),
    ]);
  }

  function renderLinks() {
    if (!state.loaded) {
      els.table.hidden = true;
      renderState("loading");
      return;
    }
    if (state.loadError) {
      els.table.hidden = true;
      els.linksCount.textContent = "Unavailable";
      const retry = el("button", { type: "button", class: "btn btn-secondary", text: "Try again" });
      retry.addEventListener("click", () => loadLinks({ manual: true }));
      renderState("error", "Couldn't load links", state.loadError, retry);
      return;
    }
    if (state.links.length === 0) {
      els.table.hidden = true;
      els.linksCount.textContent = "No links yet";
      const start = el("button", { type: "button", class: "btn btn-secondary", text: "Create your first link" });
      start.addEventListener("click", () => els.url.focus());
      renderState("empty", "No short links yet",
        "Links you create appear here with their click counts. Stored in memory, so they reset when the service restarts.", start);
      return;
    }

    const items = visibleLinks();
    const shownNote = state.total > state.links.length ? ` (showing newest ${numberFmt.format(state.links.length)})` : "";
    els.linksCount.textContent = els.search.value.trim()
      ? `${numberFmt.format(items.length)} of ${numberFmt.format(state.links.length)} links match`
      : `${numberFmt.format(state.total)} ${state.total === 1 ? "link" : "links"} stored${shownNote}`;

    if (items.length === 0) {
      els.table.hidden = true;
      const clear = el("button", { type: "button", class: "btn btn-secondary", text: "Clear search" });
      clear.addEventListener("click", () => { els.search.value = ""; renderLinks(); els.search.focus(); });
      renderState("nomatch", "No matching links", "No alias or destination contains that text.", clear);
      return;
    }
    els.tableState.replaceChildren();
    els.tableState.classList.remove("is-error");
    els.tbody.replaceChildren(...items.map(renderRow));
    els.table.hidden = false;
  }

  // ---------------------------------------------------------------- dialogs

  function openQr(link) {
    els.qrImage.src = qrPath(link.short_code);
    els.qrImage.alt = `QR code for ${link.short_url}`;
    els.qrUrl.textContent = link.short_url;
    els.qrDownload.href = qrPath(link.short_code);
    els.qrDownload.setAttribute("download", `linklab-${link.short_code}.svg`);
    els.qrDialog.showModal();
  }

  function confirmDelete(link) {
    state.pendingDelete = link;
    els.deleteCode.textContent = `/${link.short_code}`;
    els.deleteDialog.returnValue = "";
    els.deleteDialog.showModal();
  }

  els.deleteDialog.addEventListener("close", async () => {
    const link = state.pendingDelete;
    state.pendingDelete = null;
    if (!link || els.deleteDialog.returnValue !== "confirm") return;
    try {
      await api(`/url/${encodeURIComponent(link.short_code)}`, { method: "DELETE" });
      toast(`Deleted /${link.short_code}`);
      if (els.resultLink.textContent === link.short_url) els.result.hidden = true;
    } catch (error) {
      toast(error.status === 404 ? "That link was already deleted." : error.message, "error");
    }
    refreshAll();
  });

  // ------------------------------------------------------------------ health

  async function checkHealth() {
    const text = els.health.querySelector(".health-text");
    try {
      const h = await api("/health");
      els.health.dataset.state = "ok";
      text.textContent = "Service online";
      els.health.title = `Database: ${h.database} (${h.storage}), ${h.links} links stored`;
    } catch {
      els.health.dataset.state = "down";
      text.textContent = "Service unavailable";
      els.health.title = "The API or its database is not responding";
    }
  }

  // -------------------------------------------------------------------- init

  els.aliasPrefix.textContent = `${location.host}/`;
  els.form.addEventListener("submit", onSubmit);
  els.url.addEventListener("input", () => setFieldError(els.url, els.urlError, null));
  els.alias.addEventListener("input", () => setFieldError(els.alias, els.aliasError, null));
  els.search.addEventListener("input", renderLinks);
  els.sort.addEventListener("change", renderLinks);
  els.refresh.addEventListener("click", () => { refreshAll({ manual: true }); checkHealth(); });

  // Click counts change when people use links in other tabs; refresh on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAll();
  });
  setInterval(checkHealth, 30000);

  renderLinks();
  refreshAll();
  checkHealth();
})();
