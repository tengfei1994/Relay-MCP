(() => {
  const file = decodeURIComponent(window.location.pathname.split(/[\\/]/).pop() || "");
  const isAdmin = document.body.classList.contains("admin-shell") || Boolean(document.querySelector(".admin-badge")) || file.includes("admin-");
  const page = (href) => `./${href}`;
  const icons = {
    overview: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"></rect><rect x="9" y="2" width="5" height="5" rx="1"></rect><rect x="2" y="9" width="5" height="5" rx="1"></rect><rect x="9" y="9" width="5" height="5" rx="1"></rect></svg>',
    projects: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h4l1.5 2H14v6.5H2z"></path><path d="M2 4.5V3h4l1.5 2"></path></svg>',
    servers: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4" rx="1"></rect><rect x="2.5" y="9.5" width="11" height="4" rx="1"></rect><path d="M5 4.5h.01M5 11.5h.01"></path></svg>',
    instances: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 5 3v6l-5 3-5-3V5z"></path><path d="m3 5 5 3 5-3M8 8v6"></path></svg>',
    tools: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 2.5 4 4M8 4l4 4M3 13l4.5-4.5M2.5 13.5l2 0 6-6-2-2-6 6z"></path></svg>',
    knowledge: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h7.5A2.5 2.5 0 0 1 13 5v8.5H5A2 2 0 0 1 3 11.5z"></path><path d="M5.5 5.5h5M5.5 8h4"></path></svg>',
    wiki: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 4 5-2 5 2-5 2zM3 4v7l5 2 5-2V4M8 6v7"></path></svg>',
    memory: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5c2.8 0 5 1.5 5 3.5v4c0 2-2.2 3.5-5 3.5s-5-1.5-5-3.5V6c0-2 2.2-3.5 5-3.5Z"></path><path d="M3 6c0 2 2.2 3.5 5 3.5S13 8 13 6M3 10c0 2 2.2 3.5 5 3.5S13 12 13 10"></path></svg>',
    tokens: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="8.5" r="2.5"></circle><path d="m7.5 7 5.5-5.5M10 4l2 2M8.5 6.5l2 2"></path></svg>',
    users: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5.5" r="2.5"></circle><path d="M2.5 13c.3-2.2 1.5-3.5 3.5-3.5s3.2 1.3 3.5 3.5M11 3.5a2.2 2.2 0 0 1 0 4.3M10.5 9.8c1.7.2 2.7 1.2 3 3.2"></path></svg>',
    audit: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8v11H4z"></path><path d="M6 5.5h4M6 8h4M6 10.5h2"></path></svg>',
    account: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="5" r="2.5"></circle><path d="M3.5 13c.5-2.2 2-3.5 4.5-3.5s4 1.3 4.5 3.5"></path></svg>',
    operations: '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12.5 6 9l2.2 2 4.8-5"></path><path d="M10.5 6H13v2.5"></path></svg>',
  };
  const userPages = {
    overview: "relay-website-user-preview-v1.html",
    projects: "relay-website-user-projects-preview-v1.html",
    activity: "relay-website-user-activity-preview-v1.html",
    servers: "relay-website-user-servers-preview-v1.html",
    instances: "relay-website-user-instances-preview-v1.html",
    tools: "relay-website-user-tools-preview-v1.html",
    knowledge: "relay-website-user-knowledge-preview-v1.html",
    integrated: "relay-website-user-knowledge-integrated-preview-v1.html",
    wiki: "relay-website-user-knowledge-wiki-preview-v1.html",
    productDocs: "relay-website-user-knowledge-product-docs-preview-v1.html",
    solutions: "relay-website-user-knowledge-solutions-preview-v1.html",
    memory: "relay-website-user-memory-preview-v1.html",
    sessions: "relay-website-user-knowledge-sessions-preview-v1.html",
    evidence: "relay-website-user-knowledge-evidence-preview-v1.html",
    observations: "relay-website-user-knowledge-observations-preview-v1.html",
    candidates: "relay-website-user-knowledge-candidates-preview-v1.html",
    cases: "relay-website-user-knowledge-cases-preview-v1.html",
    patterns: "relay-website-user-knowledge-patterns-preview-v1.html",
    playbooks: "relay-website-user-knowledge-playbooks-preview-v1.html",
    operations: "relay-website-user-knowledge-operations-preview-v1.html",
    operationsCapture: "relay-website-user-knowledge-operations-capture-preview-v1.html",
    operationsIngest: "relay-website-user-knowledge-operations-ingest-preview-v1.html",
    operationsIndex: "relay-website-user-knowledge-operations-index-preview-v1.html",
    tokens: "relay-website-user-tokens-preview-v1.html",
    mcpTokens: "relay-website-user-mcp-tokens-preview-v1.html",
    agentTokens: "relay-website-user-agent-tokens-preview-v1.html",
    account: "relay-website-user-account-preview-v1.html",
  };
  const adminPages = {
    overview: "relay-website-admin-preview-v1.html",
    requests: "relay-website-admin-requests-preview-v1.html",
    users: "relay-website-admin-users-preview-v1.html",
    knowledge: "relay-website-admin-knowledge-preview-v1.html",
    audit: "relay-website-admin-audit-preview-v1.html",
  };
  const userPrimary = [
    ["Projects", userPages.projects, "projects"], ["Servers", userPages.servers, "servers"], ["Instances", userPages.instances, "instances"],
    ["Tools", userPages.tools, "tools"], ["Knowledge", userPages.knowledge, "knowledge"], ["Tokens", userPages.tokens, "tokens"],
  ];
  const adminPrimary = [...userPrimary, ["Users", adminPages.users, "users"]];
  const knowledgeLinks = [
    ["Overview", userPages.knowledge, "knowledge"], ["Control plane", userPages.integrated, "integrated"], ["Wiki", userPages.wiki, "wiki"],
    ["Product docs", userPages.productDocs, "productDocs"], ["Solutions", userPages.solutions, "solutions"], ["Memory", userPages.memory, "memory"],
    ["Playbooks", userPages.playbooks, "playbooks"], ["Operations", userPages.operations, "operations"],
  ];
  const active = (href) => {
    const [target, hash] = href.split("#");
    return file === target && (!hash || window.location.hash === `#${hash}`);
  };
  const primaryActive = (href) => active(href)
    || (!isAdmin && href === userPages.projects && file === userPages.overview)
    || (!isAdmin && href === userPages.knowledge && (file.includes("relay-website-user-knowledge-") || file === userPages.memory))
    || (!isAdmin && href === userPages.tokens && [userPages.mcpTokens, userPages.agentTokens].includes(file));
  const link = (href, label, icon, extra = "") => `<a class="rail-link ${active(href) ? "is-route-active" : ""}" href="${page(href)}"${active(href) ? ' aria-current="page"' : ""}><span>${icons[icon] ?? ""}${label}</span>${extra}</a>`;
  const group = (label, items) => `<nav class="rail-group" aria-label="${label}"><span class="rail-label">${label}</span>${items.join("")}</nav>`;
  const contextNote = (label, text) => `<div style="display:grid;gap:7px;padding:0 11px;color:var(--muted);font-size:11px;line-height:1.5"><span class="rail-label">${label}</span><p style="color:var(--soft)">${text}</p></div>`;
  const knowledgeItem = ([label, href, icon]) => link(href, label, icon === "integrated" ? "operations" : icon === "productDocs" || icon === "solutions" ? "knowledge" : icon);
  const memoryLinks = [
    ["Workspace", userPages.memory, "memory"], ["Sessions", userPages.sessions, "operations"], ["Evidence", userPages.evidence, "knowledge"],
    ["Observations", userPages.observations, "operations"], ["Candidate insights", userPages.candidates, "knowledge"],
    ["Confirmed memory", `${userPages.memory}#confirmed`, "memory"], ["Submissions", `${userPages.memory}#submissions`, "memory"],
  ];
  const operationLinks = [
    ["Operations overview", userPages.operations, "operations"], ["Capture", userPages.operationsCapture, "operations"],
    ["Ingest", userPages.operationsIngest, "operations"], ["Index and providers", userPages.operationsIndex, "knowledge"],
  ];
  const isMemoryPage = [userPages.memory, userPages.sessions, userPages.evidence, userPages.observations, userPages.candidates, userPages.cases, userPages.patterns].includes(file);
  const isOperationsPage = [userPages.operations, userPages.operationsCapture, userPages.operationsIngest, userPages.operationsIndex].includes(file);
  const isKnowledgePage = file === userPages.knowledge || file.includes("relay-website-user-knowledge-") || isMemoryPage;
  const isTokenPage = [userPages.tokens, userPages.mcpTokens, userPages.agentTokens].includes(file);
  const userGroups = isMemoryPage
    ? [group("Memory sections", memoryLinks.map(([label, href, icon]) => link(href, label, icon)))]
    : isOperationsPage
      ? [group("Operations", operationLinks.map(([label, href, icon]) => link(href, label, icon)))]
      : isKnowledgePage
        ? [group("Knowledge sections", knowledgeLinks.map(knowledgeItem))]
        : isTokenPage
          ? [group("Token types", [link(userPages.mcpTokens, "MCP Access Tokens", "tokens"), link(userPages.agentTokens, "Relay Agent Tokens", "servers")])]
          : [group("Workspace", [link(userPages.overview, "Overview", "overview"), link(userPages.activity, "Activity", "operations")])];
  const adminGroups = file === adminPages.knowledge
    ? [group("Review sections", [
        link(`${adminPages.knowledge}#candidates`, "Candidate insights", "knowledge", '<em>07</em>'),
        link(`${adminPages.knowledge}#classification`, "Product classification", "knowledge"),
        link(`${adminPages.knowledge}#submissions`, "Memory submissions", "memory", '<em>03</em>'),
        link(`${adminPages.knowledge}#providers`, "Providers and Wiki", "wiki"),
        link(adminPages.audit, "Audit log", "audit"),
      ])]
    : [adminPages.overview, adminPages.requests, adminPages.users, adminPages.audit].includes(file)
      ? [group("Control plane", [link(adminPages.requests, "Access requests", "audit", '<em>04</em>'), link(adminPages.knowledge, "Knowledge review", "knowledge", '<em>07</em>'), link(adminPages.audit, "Audit log", "audit")])]
      : isKnowledgePage
        ? userGroups
        : isTokenPage
          ? [group("Token types", [link(userPages.mcpTokens, "MCP Access Tokens", "tokens"), link(userPages.agentTokens, "Relay Agent Tokens", "servers")])]
          : [contextNote("Primary navigation", "Use the top bar to switch between Projects, Servers, Instances, Tools, Knowledge, Tokens and Users.")];

  const primary = isAdmin ? adminPrimary : userPrimary;
  const global = document.querySelector(".global-nav");
  if (global) {
    global.innerHTML = primary.map(([label, href]) => `<a href="${page(href)}"${primaryActive(href) ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  }
  const rail = document.querySelector("#side-rail");
  if (rail) {
    const railGroups = isAdmin ? adminGroups : userGroups;
    const railContext = !railGroups.length ? contextNote("Primary navigation", "Use the top bar to switch between the main console sections.") : railGroups.join("");
    const mobilePrimary = `<nav class="rail-group rail-mobile-primary" aria-label="Mobile primary navigation" style="display:none;gap:8px;padding-bottom:18px;border-bottom:1px solid var(--line)"><span class="rail-label">Primary navigation</span>${primary.map(([label, href, icon]) => link(href, label, icon)).join("")}</nav>`;
    rail.innerHTML = `<div class="rail-heading"><span>${isAdmin ? "Relay control plane" : "Selected workspace"}</span><strong>${isAdmin ? "Keep the boundary clear." : "Northstar Diagnostics"}</strong></div>${mobilePrimary}${railContext}<div class="rail-footer"><div class="rail-footer-row"><span>Relay API</span><span class="status-dot"></span></div><div class="rail-footer-row"><span>${isAdmin ? "policy" : "scope"}</span><code>${isAdmin ? "enforced" : "project: northstar"}</code></div></div>`;
    const syncMobilePrimary = () => {
      const mobile = rail.querySelector(".rail-mobile-primary");
      if (mobile) mobile.style.display = window.innerWidth <= 1060 ? "grid" : "none";
    };
    syncMobilePrimary();
    window.addEventListener("resize", syncMobilePrimary, { passive: true });
    rail.querySelectorAll(".rail-link").forEach((item) => item.addEventListener("click", () => {
      const toggle = document.querySelector("#menu-toggle");
      if (window.innerWidth <= 1060 && toggle) { rail.classList.remove("is-open"); toggle.setAttribute("aria-expanded", "false"); }
    }));
  }
  const sideOwnsPageNavigation = isMemoryPage || isOperationsPage
    || [userPages.knowledge, userPages.integrated, userPages.wiki, userPages.solutions, userPages.playbooks].includes(file)
    || (isAdmin && file === adminPages.knowledge);
  if (sideOwnsPageNavigation) document.querySelectorAll(".subnav").forEach((item) => { item.hidden = true; item.style.display = "none"; });
  if (file === userPages.memory) {
    const memoryTabs = {
      "Sessions": userPages.sessions,
      "Evidence": userPages.evidence,
      "Observations": userPages.observations,
      "Candidate insights": userPages.candidates,
      "Confirmed memory": `${userPages.memory}#confirmed`,
      "Submissions": `${userPages.memory}#submissions`,
    };
    document.querySelectorAll(".subnav a").forEach((item) => {
      const target = memoryTabs[item.textContent.trim()];
      if (target) item.href = page(target);
    });
  }
  if (file === userPages.playbooks) {
    const projectTabs = { "#evidence": userPages.evidence, "#cases": userPages.cases, "#patterns": userPages.patterns };
    document.querySelectorAll("a[href^='#']").forEach((item) => {
      const target = projectTabs[item.getAttribute("href") ?? ""];
      if (target) item.href = page(target);
    });
  }
  if ([userPages.operations, userPages.operationsCapture, userPages.operationsIngest, userPages.operationsIndex].includes(file)) {
    const operationTabs = {
      "Capture": userPages.operationsCapture,
      "Ingest": userPages.operationsIngest,
      "Index and providers": userPages.operationsIndex,
    };
    document.querySelectorAll(".subnav a").forEach((item) => {
      const label = item.textContent.trim();
      const target = Object.entries(operationTabs).find(([name]) => label.startsWith(name))?.[1];
      if (target) item.href = page(target);
    });
  }
  const accountLink = document.querySelector(".account-menu a");
  if (accountLink) accountLink.href = page(userPages.account);
})();
