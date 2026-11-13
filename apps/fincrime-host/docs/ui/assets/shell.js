/* ==========================================================================
   Shell + behaviours for the static mockups.
   In production this is the P0 application chrome owned by the host app —
   never agent-composable (addendum §5.4).
   ========================================================================== */
(function () {
  "use strict";

  /* ---------- Icon sprite ------------------------------------------------ */
  const P = {
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><path d="M14 4v4M8 10v4M16 16v4"/>',
    layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 4.5 9-4.5"/>',
    stack: '<rect x="4" y="5" width="16" height="4" rx="2"/><path d="M4 13h16M4 17h16"/>',
    fingerprint: '<path d="M12 11v3a8 8 0 0 1-1.5 4.6"/><path d="M8.5 9.5A4 4 0 0 1 16 11v1.5"/><path d="M5.5 14.5c.3-1.1.5-2.3.5-3.5a6 6 0 0 1 9-5.2"/><path d="M18 9a6 6 0 0 1 0 2v1a12 12 0 0 1-.8 4.3"/><path d="M8.6 18.8A10 10 0 0 0 10 14"/>',
    sitemap: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z"/>',
    shieldcheck: '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2A5 5 0 0 1 21 19"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    checkcircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
    alert: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4M12 17v.01"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
    xcircle: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
    searchcheck: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4M8.5 11l1.8 1.8L13.5 9.5"/>',
    chevr: '<path d="m9 6 6 6-6 6"/>', chevd: '<path d="m6 9 6 6 6-6"/>', chevl: '<path d="m15 6-6 6 6 6"/>',
    arrowr: '<path d="M5 12h14M13 6l6 6-6 6"/>', arrowl: '<path d="M19 12H5M11 6l-6 6 6 6"/>', arrowd: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    play: '<path d="M7 5v14l11-7L7 5Z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 14 3.5-4.5"/>',
    scale: '<path d="M12 4v16M7 20h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0L5 7ZM19 7l-3 6a3 3 0 0 0 6 0l-3-6Z"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M2 13v2M22 13v2"/>',
    workflow: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M6.5 10v4a3 3 0 0 0 3 3H14"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    panelr: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    panell: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="m6 6 12 12M18 6 6 18"/>',
    hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13v4H6a2 2 0 0 1-2-2Z"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    signal: '<path d="M2 14c2 0 2.5-6 5-6s3 10 5.5 10S15 6 17.5 6 20 14 22 14"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/>',
    graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="m8.2 7.2 7.6 0M7 8.4l1.4 7.2M16.5 10l-5.7 6.4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="11.5" cy="11.5" r="3"/><path d="m16 16-2.3-2.3"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6l2.5-8Z"/>',
    building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Z"/><path d="M10 21h4"/>',
    send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
    package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    gavel: '<path d="m14 5 5 5M11 8l5 5M9.5 9.5 4 15l3 3 5.5-5.5M12.5 6.5l5 5"/><path d="M13 21h8"/>',
    flight: '<path d="M3 17h18M5 17l2-6h4l2-5h3l-1 5h3l2 6"/>',
    beaker: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 14h9"/>',
    pin: '<path d="M12 21s7-6.3 7-12a7 7 0 0 0-14 0c0 5.7 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    watch: '<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6l1-3h4l1 3M9 18l1 3h4l1-3"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'
  };
  const sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
    Object.entries(P).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join("") + "</svg>";
  document.body.insertAdjacentHTML("afterbegin", sprite);
  window.icon = (n, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  /* ---------- P0 chrome ------------------------------------------------- */
  const root = "root" in document.body.dataset ? document.body.dataset.root : "../";
  const studio = document.body.dataset.studio || "";
  const role = document.body.dataset.role || "CDD / KYB Analyst";
  const who = document.body.dataset.user || "R. Okafor";
  const initials = who.split(/\s|\./).filter(Boolean).map(s => s[0]).join("").slice(0, 2);
  const studios = [
    ["workspace", "Workspace", "inbox", "mockups/biz-01-my-workspace.html"],
    ["agents", "Agent Studio", "bot", "mockups/agt-01-workforce-atlas.html"],
    ["context", "Contextboard", "stack", "mockups/cxt-01-contextboard.html"],
    ["assurance", "Assurance", "flight", "mockups/asr-02-flight-recorder.html"],
    ["admin", "Admin", "cpu", "index.html#admin"]
  ];
  const chrome = document.querySelector("[data-shell=chrome]");
  if (chrome) {
    chrome.classList.add("chrome");
    chrome.setAttribute("role", "banner");
    chrome.innerHTML = `
      <a class="brand" href="${root}index.html" aria-label="Platform home">
        <span class="brand__tile">${icon("sliders")}</span>
        <span class="brand__name">FinCrime Platform</span>
      </a>
      <nav class="studio-nav" aria-label="Studios">
        ${studios.map(([k, l, ic, href]) => `<a href="${root}${href}" ${k === studio ? 'aria-current="page"' : ""}>${icon(ic, "i--sm")}<span class="lbl">${l}</span></a>`).join("")}
      </nav>
      <div class="chrome__search" role="search">${icon("search")}<span>Search cases, skills, executions…</span><kbd>⌘K</kbd></div>
      <span class="env-pill env-pill--synthetic" title="All records carry synthetic:true — no real-world verification">${icon("beaker", "i--sm")} Synthetic · tenant-synthetic</span>
      <span class="env-pill env-pill--policy">${icon("book", "i--sm")} policy synthetic-neutral 0.1.0</span>
      <button class="btn btn--quiet btn--icon" aria-label="Notifications">${icon("bell")}</button>
      <div class="row"><span class="avatar" aria-hidden="true">${initials}</span><span class="role-pill"><b>${who}</b>${role}</span></div>`;
  }

  /* ---------- Generic behaviours --------------------------------------- */
  // Tabs: [role=tablist] > [role=tab][aria-controls]
  document.querySelectorAll('[role="tablist"]').forEach(list => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const select = t => {
      tabs.forEach(x => { const on = x === t; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1;
        const p = document.getElementById(x.getAttribute("aria-controls")); if (p) p.hidden = !on; });
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", e => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) { e.preventDefault(); const n = tabs[(i + d + tabs.length) % tabs.length]; n.focus(); select(n); }
      });
    });
  });

  // Single-select groups: [data-select-group] > [aria-pressed] or [aria-selected]
  document.querySelectorAll("[data-select-group]").forEach(g => {
    const attr = g.dataset.selectAttr || "aria-pressed";
    const items = [...g.querySelectorAll(`[${attr}]`)];
    items.forEach((el, i) => {
      el.addEventListener("click", () => {
        items.forEach(x => x.setAttribute(attr, x === el));
        g.dispatchEvent(new CustomEvent("select", { detail: el }));
      });
      el.addEventListener("keydown", e => {
        const cols = +g.dataset.cols || 1;
        const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
        if (map[e.key] !== undefined) { e.preventDefault(); const n = items[Math.min(items.length - 1, Math.max(0, i + map[e.key]))]; n.focus(); }
      });
    });
  });

  // Switches (configuration drafts only)
  document.querySelectorAll(".switch").forEach(s => s.addEventListener("click", () => {
    s.setAttribute("aria-checked", s.getAttribute("aria-checked") !== "true");
    document.dispatchEvent(new CustomEvent("draft-change"));
  }));

  // Activity rail expand
  document.querySelectorAll("[data-rail-toggle]").forEach(b => b.addEventListener("click", () => {
    const r = b.closest(".rail"); const on = r.dataset.expanded !== "true";
    r.dataset.expanded = on; b.setAttribute("aria-expanded", on);
  }));

  // Region toggles
  document.querySelectorAll("[data-toggle-region]").forEach(b => b.addEventListener("click", () => {
    const app = document.querySelector(".app"); const cls = b.dataset.toggleRegion;
    app.classList.toggle(cls); b.setAttribute("aria-pressed", app.classList.contains(cls));
  }));

  // Density
  document.querySelectorAll("[data-density-toggle]").forEach(b => b.addEventListener("click", () => {
    const d = document.documentElement; const c = d.dataset.density === "compact";
    d.dataset.density = c ? "" : "compact"; b.setAttribute("aria-pressed", !c);
  }));

  // View switch (graph ⇄ table alternative)
  document.querySelectorAll("[data-view-switch]").forEach(g => {
    g.querySelectorAll("button[data-view]").forEach(b => b.addEventListener("click", () => {
      g.querySelectorAll("button[data-view]").forEach(x => x.setAttribute("aria-pressed", x === b));
      document.querySelectorAll(`[data-view-of="${g.dataset.viewSwitch}"]`).forEach(v => v.hidden = v.dataset.viewName !== b.dataset.view);
    }));
  });

  // Sheets (dialogs) with simple focus trap + Esc
  let lastFocus = null;
  window.openSheet = id => {
    const s = document.getElementById(id); if (!s) return;
    lastFocus = document.activeElement; s.dataset.open = "true";
    const f = s.querySelector("[autofocus], button, input, a"); f && f.focus();
  };
  window.closeSheet = id => { const s = document.getElementById(id); s.dataset.open = "false"; lastFocus && lastFocus.focus(); };
  document.querySelectorAll("[data-open-sheet]").forEach(b => b.addEventListener("click", () => openSheet(b.dataset.openSheet)));
  document.querySelectorAll("[data-close-sheet]").forEach(b => b.addEventListener("click", () => closeSheet(b.closest(".sheet-scrim").id)));
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    document.querySelectorAll('.sheet-scrim[data-open="true"]').forEach(s => closeSheet(s.id));
  });
  document.addEventListener("keydown", e => {
    const s = document.querySelector('.sheet-scrim[data-open="true"]'); if (!s || e.key !== "Tab") return;
    const f = [...s.querySelectorAll("button:not([disabled]), input, a, [tabindex]:not([tabindex='-1'])")];
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Fill [data-icon] placeholders
  document.querySelectorAll("[data-icon]").forEach(el => el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, el.dataset.iconClass || "")));
})();
