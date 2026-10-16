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
    advancedToggle: $("advanced-toggle"),
    submit: $("submit-btn"),
    formError: $("form-error"),
    result: $("result"),
    resultDomain: $("result-domain"),
    resultLink: $("result-link"),
    resultDest: $("result-dest"),
    resultShortText: $("result-short-text"),
    resultLongCount: $("result-long-count"),
    resultShortCount: $("result-short-count"),
    savings: $("savings"),
    savingsFill: $("savings-fill"),
    savingsText: $("savings-text"),
    resultExpiry: $("result-expiry"),
    resultCopy: $("result-copy"),
    resultOpen: $("result-open"),
    resultNew: $("result-new"),
    resultQr: $("result-qr"),
    resultQrDownload: $("result-qr-download"),
    demoShort: $("demo-short"),
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
    lastCreated: null,
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
      throw new ApiError(0, "We couldn't reach the server. Check your connection and try again.");
    }
    if (response.status === 204) return null;
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON body */ }
    if (!response.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : `Something went wrong (error ${response.status}).`;
      throw new ApiError(response.status, detail, data && data.errors);
    }
    return data;
  }

  const numberFmt = new Intl.NumberFormat();
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const plural = (n, one, many) => `${numberFmt.format(n)} ${n === 1 ? one : many}`;

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

  const withoutScheme = (url) => url.replace(/^https?:\/\//i, "");

  function avatarClass(host) {
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `av-${hash % 6}`;
  }

  function toast(message, kind = "success") {
    const node = el("div", { class: `toast${kind === "error" ? " is-error" : ""}` }, [
      el("span", { class: "toast-icon" }, icon(kind === "error" ? "alert" : "check")),
      el("span", { text: message }),
    ]);
    while (els.toasts.children.length >= 2) els.toasts.firstElementChild.remove();
    els.toasts.append(node);
    setTimeout(() => node.remove(), 3200);
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
    if (!ok) {
      toast("Couldn't copy automatically. Select the link and copy it manually.", "error");
      return;
    }
    toast("Link copied. Paste it anywhere to share.");
    if (!button) return;
    const label = button.querySelector("span");
    const use = button.querySelector("use");
    const prev = label && label.textContent;
    if (use) use.setAttribute("href", "#i-check");
    if (label) label.textContent = "Copied!";
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => {
      if (use) use.setAttribute("href", "#i-copy");
      if (label) label.textContent = prev;
    }, 1800);
  }

  const qrPath = (code) => `/url/${encodeURIComponent(code)}/qr`;

  // ------------------------------------------------------------- validation

  function setFieldError(input, errorNode, message) {
    if (message) {
      errorNode.replaceChildren(icon("alert"), el("span", { text: message }));
      errorNode.hidden = false;
      input.setAttribute("aria-invalid", "true");
    } else {
      errorNode.replaceChildren();
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

  function setAdvanced(open) {
    els.advanced.hidden = !open;
    els.advancedToggle.setAttribute("aria-expanded", String(open));
  }

  // Quick client-side checks for instant feedback; the API remains the authority.
  function validateLocally(url, alias) {
    let ok = true;
    if (!url) {
      setFieldError(els.url, els.urlError, "Paste the link you want to shorten.");
      ok = false;
    } else {
      let parsed = null;
      try { parsed = new URL(url); } catch { /* invalid */ }
      if (!parsed) {
        const hint = /^[\w-]+(\.[\w-]+)+/.test(url) ? ` Try https://${url}` : "";
        setFieldError(els.url, els.urlError, `That doesn't look like a complete web address.${hint}`);
        ok = false;
      } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setFieldError(els.url, els.urlError, "Only web addresses starting with http:// or https:// can be shortened.");
        ok = false;
      }
    }
    if (alias && !/^[A-Za-z0-9_-]{3,30}$/.test(alias)) {
      setAdvanced(true);
      setFieldError(els.alias, els.aliasError, "Use 3–30 letters, numbers, hyphens or underscores (no spaces).");
      ok = false;
    }
    return ok;
  }

  // ------------------------------------------------------------- shortening

  function setSubmitting(busy) {
    state.submitting = busy;
    els.submit.disabled = busy;
    els.submit.classList.toggle("is-loading", busy);
    els.submit.querySelector(".btn-label").textContent = busy ? "Shortening…" : "Shorten link";
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
      toast("Your short link is ready");
      els.form.reset();
      setAdvanced(false);
      refreshAll();
    } catch (error) {
      handleCreateError(error);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCreateError(error) {
    if (error.status === 409) {
      setAdvanced(true);
      setFieldError(els.alias, els.aliasError, `${error.message} Try another name, or leave it empty for a random one.`);
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
    state.lastCreated = link;
    const shortText = withoutScheme(link.short_url);
    const longLen = link.original_url.length;
    const shortLen = link.short_url.length;
    const saved = longLen - shortLen;

    els.resultDomain.textContent = hostOf(link.original_url);
    els.resultLink.textContent = shortText;
    els.resultLink.href = link.short_url;
    els.resultLink.title = link.short_url;
    els.resultOpen.href = link.short_url;

    els.resultDest.textContent = link.original_url;
    els.resultDest.title = link.original_url;
    els.resultShortText.textContent = link.short_url;
    els.resultLongCount.textContent = plural(longLen, "character", "characters");
    els.resultShortCount.textContent = plural(shortLen, "character", "characters");

    els.savingsFill.style.width = "0";
    if (saved > 0) {
      const pct = Math.round((saved / longLen) * 100);
      els.savingsText.replaceChildren(el("strong", { text: `${pct}% shorter` }), ` · ${plural(saved, "character", "characters")} saved`);
      requestAnimationFrame(() => requestAnimationFrame(() => { els.savingsFill.style.width = `${pct}%`; }));
    } else {
      els.savingsText.textContent = "Your link was already short. The new one is easier to share and track.";
    }

    els.resultExpiry.textContent = link.expires_at
      ? `Stops working ${relative(link.expires_at)} (${dateFmt.format(new Date(link.expires_at))})`
      : "Never expires";

    els.resultQr.src = qrPath(link.short_code);
    els.resultQr.alt = `QR code that opens ${link.short_url}`;
    els.resultQrDownload.href = qrPath(link.short_code);
    els.resultQrDownload.setAttribute("download", `linklab-${link.short_code}.svg`);
    els.result.hidden = false;
    els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // -------------------------------------------------------------- dashboard

  async function loadSummary() {
    try {
      const s = await api("/api/analytics/summary");
      els.statTotal.textContent = numberFmt.format(s.total_links);
      els.statTotalSub.textContent = s.total_links === 0
        ? "Links created so far"
        : s.expired_links > 0
          ? `${numberFmt.format(s.active_links)} working · ${numberFmt.format(s.expired_links)} expired`
          : s.total_links === 1 ? "Working" : "All working";
      els.statClicks.textContent = numberFmt.format(s.total_clicks);
      els.statRecent.textContent = numberFmt.format(s.links_created_24h);
      if (s.top_link) {
        els.statTop.textContent = `/${s.top_link.short_code}`;
        els.statTop.title = `${s.top_link.short_url} → ${s.top_link.original_url}`;
        els.statTopSub.textContent = plural(s.top_link.clicks, "visit", "visits");
      } else {
        els.statTop.textContent = "—";
        els.statTop.removeAttribute("title");
        els.statTopSub.textContent = "No visits yet";
      }
      els.statGrid.setAttribute("aria-busy", "false");
    } catch {
      els.statTotalSub.textContent = "Couldn't load numbers";
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
      setTimeout(() => els.refresh.classList.remove("spinning"), manual ? 400 : 0);
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
      els.tableState.append(
        el("div", { class: "skeleton" }, [el("div", { class: "skeleton-row" }), el("div", { class: "skeleton-row" }), el("div", { class: "skeleton-row" })]),
        el("span", { class: "visually-hidden", text: "Loading links…" }),
      );
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
    if (link.is_expired) {
      return el("span", { class: "badge badge-expired", text: "Expired", title: "This link no longer redirects" });
    }
    if (link.expires_at) {
      return el("span", { class: "badge badge-expiring", text: `Ends ${relative(link.expires_at)}`,
        title: `Stops working on ${dateFmt.format(new Date(link.expires_at))}` });
    }
    return el("span", { class: "badge badge-active", text: "Working", title: "Visitors are redirected" });
  }

  function toolButton(iconName, label, onClick, extraClass = "") {
    const btn = el("button", { type: "button", class: `btn btn-tool ${extraClass}`.trim(), "aria-label": label, "data-tip": label.split(" /")[0] },
      icon(iconName));
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderRow(link, maxClicks) {
    const expired = link.is_expired;
    const host = hostOf(link.original_url);
    const shortHost = withoutScheme(link.short_url).slice(0, -link.short_code.length);

    const codeLink = el("a", { class: "code-link", href: link.short_url, target: "_blank", rel: "noopener noreferrer",
      title: `Open ${link.short_url}` }, [el("span", { class: "host", text: shortHost }), link.short_code]);

    const dest = el("button", { type: "button", class: "dest", "aria-expanded": "false", title: "Show the full destination" },
      [icon("corner"), el("span", { class: "dest-text", text: withoutScheme(link.original_url) })]);
    dest.addEventListener("click", () => {
      const open = dest.getAttribute("aria-expanded") !== "true";
      dest.setAttribute("aria-expanded", String(open));
      dest.title = open ? "Collapse" : "Show the full destination";
    });

    const linkCell = el("div", { class: "link-cell" }, [
      el("span", { class: `avatar ${avatarClass(host)}`, "aria-hidden": "true", text: (host[0] || "?") }),
      el("div", { class: "link-text" }, [codeLink, dest]),
    ]);

    const bar = el("span");
    bar.style.width = maxClicks > 0 ? `${Math.max(link.clicks ? 6 : 0, (link.clicks / maxClicks) * 100)}%` : "0";
    const visits = el("div", { class: "visits", title: plural(link.clicks, "visit", "visits") }, [
      el("span", { class: "visits-num", text: numberFmt.format(link.clicks) }),
      el("span", { class: "visits-bar", "aria-hidden": "true" }, bar),
    ]);

    const time = el("time", { datetime: link.created_at, title: dateFmt.format(new Date(link.created_at)),
      text: relative(link.created_at) });

    const copy = el("button", { type: "button", class: "btn btn-copy", "aria-label": `Copy /${link.short_code}` },
      [icon("copy"), el("span", { text: "Copy" })]);
    copy.addEventListener("click", () => copyWithFeedback(link.short_url, copy));

    const open = el("a", { class: "btn btn-tool", href: link.short_url, target: "_blank", rel: "noopener noreferrer",
      "aria-label": `Open /${link.short_code} in a new tab`, "data-tip": expired ? "Expired" : "Open" }, icon("external"));
    if (expired) open.setAttribute("aria-disabled", "true");

    const actions = el("div", { class: "row-actions" }, [
      copy,
      toolButton("qr", `QR code /${link.short_code}`, () => openQr(link)),
      open,
      toolButton("trash", `Delete /${link.short_code}`, () => confirmDelete(link), "danger"),
    ]);

    return el("tr", { class: expired ? "is-expired" : undefined }, [
      el("td", { class: "col-link" }, linkCell),
      el("td", { class: "col-visits" }, visits),
      el("td", { class: "col-created created" }, time),
      el("td", { class: "col-status" }, statusBadge(link)),
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
      els.linksCount.textContent = "Couldn't load links";
      const retry = el("button", { type: "button", class: "btn btn-secondary" }, [icon("refresh"), "Try again"]);
      retry.addEventListener("click", () => loadLinks({ manual: true }));
      renderState("error", "We couldn't load your links", state.loadError, retry);
      return;
    }
    if (state.links.length === 0) {
      els.table.hidden = true;
      els.linksCount.textContent = "No links yet";
      const start = el("button", { type: "button", class: "btn btn-primary" }, [icon("scissors"), "Shorten your first link"]);
      start.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
        els.url.focus({ preventScroll: true });
      });
      renderState("empty", "No short links yet",
        "Shorten a link above and it will appear here, along with how many times it has been opened.", start);
      return;
    }

    const items = visibleLinks();
    const shownNote = state.total > state.links.length ? ` (showing newest ${numberFmt.format(state.links.length)})` : "";
    els.linksCount.textContent = els.search.value.trim()
      ? `${numberFmt.format(items.length)} of ${plural(state.links.length, "link", "links")} match your search`
      : `${plural(state.total, "link", "links")}${shownNote}`;

    if (items.length === 0) {
      els.table.hidden = true;
      const clear = el("button", { type: "button", class: "btn btn-secondary", text: "Clear search" });
      clear.addEventListener("click", () => { els.search.value = ""; renderLinks(); els.search.focus(); });
      renderState("nomatch", "No matching links", "No short link or destination contains that text.", clear);
      return;
    }
    els.tableState.replaceChildren();
    els.tableState.classList.remove("is-error");
    const maxClicks = Math.max(0, ...state.links.map((l) => l.clicks));
    els.tbody.replaceChildren(...items.map((l) => renderRow(l, maxClicks)));
    els.table.hidden = false;
  }

  // ---------------------------------------------------------------- dialogs

  function openQr(link) {
    els.qrImage.src = qrPath(link.short_code);
    els.qrImage.alt = `QR code that opens ${link.short_url}`;
    els.qrUrl.textContent = withoutScheme(link.short_url);
    els.qrDownload.href = qrPath(link.short_code);
    els.qrDownload.setAttribute("download", `linklab-${link.short_code}.svg`);
    els.qrDialog.showModal();
  }

  function confirmDelete(link) {
    state.pendingDelete = link;
    els.deleteCode.textContent = withoutScheme(link.short_url);
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
      if (state.lastCreated && state.lastCreated.short_code === link.short_code) els.result.hidden = true;
    } catch (error) {
      toast(error.status === 404 ? "That link was already deleted." : error.message, "error");
    }
    refreshAll();
  });

  // ------------------------------------------------------------------ health

  async function checkHealth() {
    const text = els.health.querySelector(".health-text");
    try {
      await api("/health");
      els.health.dataset.state = "ok";
      text.textContent = "Online";
      els.health.title = "The service is up and ready to shorten links";
    } catch {
      els.health.dataset.state = "down";
      text.textContent = "Offline";
      els.health.title = "The service is not responding right now";
    }
  }

  // -------------------------------------------------------------------- init

  els.aliasPrefix.textContent = `${location.host}/`;
  els.demoShort.textContent = `${location.host}/trip-plan`;
  els.form.addEventListener("submit", onSubmit);
  els.advancedToggle.addEventListener("click", () => setAdvanced(els.advanced.hidden));
  els.url.addEventListener("input", () => setFieldError(els.url, els.urlError, null));
  els.alias.addEventListener("input", () => setFieldError(els.alias, els.aliasError, null));
  els.resultCopy.addEventListener("click", () => state.lastCreated && copyWithFeedback(state.lastCreated.short_url, els.resultCopy));
  els.resultNew.addEventListener("click", () => {
    els.result.hidden = true;
    els.url.focus();
  });
  els.search.addEventListener("input", renderLinks);
  els.sort.addEventListener("change", renderLinks);
  els.refresh.addEventListener("click", () => { refreshAll({ manual: true }); checkHealth(); });

  // Visit counts change when people use links in other tabs; refresh on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAll();
  });
  setInterval(checkHealth, 30000);

  renderLinks();
  refreshAll();
  checkHealth();
})();
