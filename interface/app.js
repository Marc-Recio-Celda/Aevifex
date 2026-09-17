// Aevifex & NEXUS Operations Cockpit Dashboard
// Read-only views derived from /api/model snapshots and entity deltas.
// Live polling via /api/stamp every 2s (AX-7).

const STORAGE_KEYS = {
  TASKS: "mlabs_nexus_tasks_v3",
  IDEAS: "mlabs_nexus_ideas_v3"
};

let STATE = {
  activeFront: null,
  fronts: [],
  projects: [],
  tasks: [],
  livePlan: [],
  livePlanMeta: null,
  plans: [],
  mailbox: [],
  ideas: [],
  decisions: [],
  skills: [],
  problems: [],
  loaded: false,
  error: null,
  currentView: "cockpit",
  selectedProject: "",
  selectedSubtab: "overview",
  taskFilterProj: "",
  taskSearch: "",
  globalSearchQuery: ""
};

let STAMP = null;
let MODEL = null;

// `esc`, `inline` y `jsq` viven en `render/escape.js`, que `index.html` carga antes que
// este fichero. Están en un fichero propio porque son el borde entre contenido y código:
// un solo sitio que auditar, y un solo sitio que la prueba con planta puede cargar.

window.copyToClipboard = function(text, msg, evt) {
  if (!text) return;
  const target = evt?.currentTarget || (typeof event !== "undefined" ? event?.currentTarget : null);

  const fallbackCopy = (str) => {
    const textArea = document.createElement("textarea");
    textArea.value = str;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.warn('execCommand copy error', err);
    }
    document.body.removeChild(textArea);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }

  if (target) {
    target.classList.add("copied-pulse");
    setTimeout(() => target.classList.remove("copied-pulse"), 1200);
  }
  showToast(msg || `Copiado: ${text.slice(0, 45)}`);
};

function renderDate(dateStr, isInferred = false) {
  if (!dateStr) return "";
  if (isInferred) {
    return `<span class="tag-pill tag-inferred" title="Fecha imputada del contexto, no leída explícitamente (date_inferred: true)">📅 ${esc(dateStr)} <em class="inferred-marker">~inferred</em></span>`;
  }
  return `<span class="tag-pill">📅 ${esc(dateStr)}</span>`;
}

function renderOrigin(originStr, isInferred = false) {
  if (!originStr) return "";
  if (isInferred) {
    return `<span class="tag-pill tag-inferred" title="Origen imputado del contexto, no leído explícitamente (origin_inferred: true)">👤 ${esc(originStr)} <em class="inferred-marker">~inferred</em></span>`;
  }
  return `<span class="tag-pill">👤 ${esc(originStr)}</span>`;
}

// Helper to generate dynamic ramified project block workflows from real project state & decisions
function generateProjectRamifiedWorkflow(pName, decCount, pState, projectTasks = [], projectDecs = []) {
  const openTasks = projectTasks.filter(t => t.status !== "✅" && t.status !== "⚫");
  const closedTasks = projectTasks.filter(t => t.status === "✅");
  const decIds = (projectDecs || []).map(d => d.id);

  // If real blocks were parsed from state.md, use them!
  if (pState && Array.isArray(pState.blocks) && pState.blocks.length > 0) {
    return pState.blocks.map((b, bIdx) => {
      const status = b.status || "pending";
      const statusLabel = status === "completed" ? "✓ Listo" : (status === "active" ? "▶ En Curso" : "⏳ Pendiente");
      
      const subblocks = (b.subblocks || []).map(sub => {
        // Find tasks matching this subblock ID (e.g. "B8.2" or "A1.1")
        const matchingTasks = projectTasks.filter(t => t.title.includes(sub.id) || (t.why && t.why.includes(sub.id)));
        const subTasks = matchingTasks.length ? matchingTasks : (sub.status === "active" ? openTasks : []);
        
        return {
          id: sub.id,
          kind: sub.kind || "🔨",
          title: sub.title,
          desc: sub.desc || sub.title,
          status: sub.status || "pending",
          tasks: subTasks
        };
      });

      return {
        id: b.id,
        title: b.title,
        status,
        statusLabel,
        summary: b.summary || b.title,
        decisions: decIds.slice(bIdx * 2, (bIdx + 1) * 2),
        subblocks
      };
    });
  }

  // ⛔ Aquí había un fallback que INVENTABA cuatro bloques cuando el `state.md` no
  // declaraba ninguno: títulos escritos a mano, estados fijados a `completed`, y las
  // decisiones del proyecto repartidas entre ellos por `slice(bIdx*2, …)` — es decir,
  // atribuidas a bloques que no existen, por posición. Salía una hoja de ruta completa
  // con su barra de progreso, indistinguible de una leída del fichero.
  //
  // ⚠️ Y lo que un lector hace con eso es creérselo. Un vacío honesto se puede rellenar;
  // una ficción con aspecto de dato hay que descubrirla primero. Sin bloques declarados,
  // esto devuelve cero bloques y la vista dice por qué.
  return [];
}

function projectViewModel(entities, fronts = []) {
  return entities.filter(e => e.kind === "project-state" && e.project).map(p => ({
    name: p.project, lab: p.lab || "Otros proyectos", definition: p.definition || "",
    ambiguous: Boolean(p.ambiguous), documents: p.documents || [], projectRoot: p.project_root,
    file: p.file || "", workflow: p.blocks || [],
    nextAction: p.next_action || null, lastUpdated: p.last_updated || null,
    integratedThrough: p.integrated_through || null, status: p.status || null,
    totalBlocks: (p.blocks || []).length,
    completedBlocks: (p.blocks || []).filter(b => b.status === "completed").length,
    progress: null, decisionsCount: null,
    activeTasks: fronts.filter(f => f.project === p.project && f.active && !f.in_bin)
  })).sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}

// Ingest typed model from server
function ingestModel(model, changed = null) {
  const before = {...STATE};
  const has = (...kinds) => !changed || kinds.some(kind => changed.has(kind));
  const entities = model.entities || [];
  STATE.problems = model.problems || [];

  
  if (has('front')) {
    // Fronts & Active Front
    STATE.fronts = entities.filter(e => e.kind === "front");
    STATE.activeFront = STATE.fronts.find(e => e.active) || (STATE.fronts[0] || null);

  }

  if (has('plan-item', 'plan-section', 'live-plan-meta')) {
    // Live Plan items & metadata
    STATE.livePlan = entities.filter(e => e.kind === "plan-item").map(e => ({
      id: e.id,
      index: e.index,
      line: e.line,
      text: e.text || "",
      struck: Boolean(e.struck),
      destination: e.destination || "",
      outcome: e.outcome || null,
      section: e.section || null,
      subsection: e.subsection || null,
      ordered: e.ordered !== false,
      author: e.author || null,
      date: e.date || null,
      project: e.project || "cross"
    }));
    STATE.planSections = entities.filter(e => e.kind === "plan-section").map(e => ({
      level: e.level, title: e.title, section: e.section, subsection: e.subsection, line: e.line
    }));
    STATE.livePlanMeta = entities.find(e => e.kind === "live-plan-meta") || null;

  }

  if (has('plan')) {
    // Persistent Plans (from data/plans/*.json)
    STATE.plans = entities.filter(e => e.kind === "plan").map(e => ({
      id: e._record_id || e.id || "",
      project: e.project || "nexus",
      title: e.title || e.task || "",
      task: e.task || e.title || "",
      block: e.block || "",
      sub_block: e.sub_block || "",
      status: e.status || "closed",
      date: e.date || "",
      closed_on: e.closed_on || e.closed_date || null,
      author: e.author || e.origin || "Operator",
      order_why: e.order_why || "",
      closing_note: e.closing_note || "",
      items: Array.isArray(e.items) ? e.items.map((it, idx) => ({
        index: it.n || it.index || idx + 1,
        text: it.text || "",
        status: (it.outcome === "done" || it.status === "done" || it.status === "closed" || Boolean(it.struck)) ? "done" : "open",
        destination: it.destination || it.outcome || (it.note ? it.note : (it.struck ? "✅ resolved" : "")),
        completed_at: it.completed_at || it.date || null
      })) : []
    }));

  }

  if (has('decision', 'method-decision')) {
    // Decisions (all decision and method-decision records)
    const rawDecisions = entities.filter(e => e.kind === "decision" || e.kind === "method-decision");
    
    // Build project-scoped supersedes map
    const supersededByMap = new Map();
    for (const d of rawDecisions) {
      const proj = String(d.project || "nexus").trim();
      const thisId = String(d._record_id || d.id || "").trim();
      const target = String(d.supersedes || "").trim();
      if (target) {
        const targetKey = `${proj}:${target}`;
        if (!supersededByMap.has(targetKey)) supersededByMap.set(targetKey, []);
        supersededByMap.get(targetKey).push(thisId);
      }
  }

  STATE.decisions = rawDecisions.map(d => {
    const proj = String(d.project || "nexus").trim();
    const thisId = String(d._record_id || d.id || "D").trim();
    const thisKey = `${proj}:${thisId}`;
    const newerReplacements = supersededByMap.get(thisKey);
    const isSuperseded = Boolean(newerReplacements && newerReplacements.length);

    return {
      id: thisId,
      project: d.project || "nexus",
      title: d.decision || d.title || "Decisión",
      why: d.why || "",
      discarded: d.discarded || null,
      date: d.date || "",
      date_inferred: Boolean(d.date_inferred),
      origin: d.origin || d.author || "Operator",
      origin_inferred: Boolean(d.origin_inferred),
      supersedes: d.supersedes || null,
      isSuperseded,
      supersededBy: newerReplacements || [],
      frozen: Boolean(d.frozen),
      mirror_of: d.mirror_of || null,
      file: d.file || ""
    };
  });

  }

  if (has('mailbox-entry')) {
    // Mailbox
    STATE.mailbox = entities.filter(e => e.kind === "mailbox-entry").map(e => ({
      id: e.id,
      title: e.title || "",
      project: e.project || "cross",
      state: e.state || "open",
      destination: e.destination || "inbox",
      // Los cuatro de `AX-46`. `prose` es lo que sobra del cuerpo una vez sacados.
      serves: e.serves || null,
      what: e.what || null,
      asks: e.asks || null,
      affects: e.affects || null,
      stale: Boolean(e.stale),
      prose: e.prose || "",
      body: e.body || "",
      line: e.line,
      file: e.file || "",
      author: e.author || e.origin || "Agent",
      date: e.date || "",
      date_inferred: Boolean(e.date_inferred),
      origin_inferred: Boolean(e.origin_inferred)
    }));

  }

  if (has('idea')) {
    // Ideas
    STATE.ideas = entities.filter(e => e.kind === "idea").map(e => ({
      id: e.id,
      title: e.title || "",
      body: e.body || "",
      project: e.project || "nexus",
      scope: e.scope || "system",
      section: e.section || "General",
      origin: e.origin || "Operator",
      date_inferred: Boolean(e.date_inferred),
      origin_inferred: Boolean(e.origin_inferred),
      // La fuente lo declaró caducado y el aviso se pinta con esto.
      stale: Boolean(e.stale),
      source: e.source || ""
    }));

  }

  if (has('skill')) {
    // Skills
    // ⛔ Aquí había un caso especial que forzaba `rnd` a `event` y, si su `when` no le
    // gustaba, **escribía uno inventado** que no aparece en ningún fichero. La descripción
    // de `rnd` dice literalmente «on request» y «Use when the operator is stuck…»: el parser
    // la lee bien y la vista la corregía hacia lo contrario, presentando texto fabricado con
    // el mismo aspecto que el leído del disco. Una excepción por nombre en la capa de
    // presentación es una segunda copia de un hecho, y ésta además era falsa.
    //
    // ⚠️ Un `trigger` que no viene se queda como `unclear`, no como `request`: el parser
    // distingue expresamente lo que pudo probar de lo que no, y ese matiz es el valor.
    STATE.skills = entities.filter(e => e.kind === "skill").map(e => ({
      id: e.id,
      title: e.title || "",
      trigger: e.trigger || "unclear",
      summary: e.summary || "",
      when: e.when || "",
      evidence: e.evidence || ""
    }));

  }

  if (has('task')) {
    // Tasks (from model + local overrides for comments/discards)
    const localTasks = JSON.parse(localStorage.getItem(STORAGE_KEYS.TASKS) || "[]");
    const modelTasks = entities.filter(e => e.kind === "task").map(e => ({
      id: e.id_raw || e.id || "T",
      title: e.title || "",
      project: e.project || "cross",
      // Los cinco de `FLOW.md`, si la tarea los declara. `status` es el emoji del
      // vocabulario anterior y sigue conviviendo: ninguno se deriva del otro.
      state: e.state || null,
      plan: e.plan || null,
      block: e.block || null,
      sub_block: e.sub_block || null,
      status: e.status || "⬜",
      why: e.why || "",
      author: e.author || e.origin || "Operator",
      date: e.date || new Date().toISOString().slice(0, 10),
      date_inferred: Boolean(e.date_inferred),
      origin_inferred: Boolean(e.origin_inferred),
      file: e.file || "",
      stale: Boolean(e.stale),
      source: e.source || "",
      comments: [],
      discardReason: null
    }));

    const combinedTasksMap = new Map();
    for (const t of modelTasks) combinedTasksMap.set(t.id, t);
    for (const t of localTasks) {
      if (combinedTasksMap.has(t.id)) {
        const existing = combinedTasksMap.get(t.id);
        existing.comments = t.comments || [];
        if (t.discardReason) existing.discardReason = t.discardReason;
        if (t.status) existing.status = t.status;
      } else {
        combinedTasksMap.set(t.id, t);
      }
  }
  STATE.tasks = Array.from(combinedTasksMap.values());

  }

  if (has("project-state", "front")) STATE.projects = projectViewModel(entities, STATE.fronts);
  for (const key of ['fronts', 'livePlan', 'plans', 'decisions', 'mailbox', 'ideas', 'skills', 'tasks', 'projects']) {
    STATE[key] = LiveModel.reuse(before[key], STATE[key], row => key === 'projects' ? row.name : key === 'decisions' ? JSON.stringify([row.project,row.id,row.file]) : row.id);
  }
  STATE.activeFront = STATE.fronts.find(e => e.active) || STATE.fronts[0] || null;
  if (has('front')) for (const front of STATE.fronts) {
      if (before.fronts?.find(f => f.id === front.id) !== front && STATE.taskSheets?.[front.id]) STATE.taskSheets[front.id].stale = true;
  }
  if (has('project-state')) for (const project of STATE.projects) {
      if (before.projects?.find(p => p.name === project.name) !== project && STATE.projectCatalogs?.[project.name]) STATE.projectCatalogs[project.name].stale = true;
  }

  if (!STATE.selectedProject && STATE.projects.length && STATE.currentView !== "project-detail") {
    STATE.selectedProject = STATE.projects[0].name;
  }

  STATE.loaded = true;
  updateHUD();
}

function updateHUD() {
  const frontEl = document.getElementById("hudActiveFront");
  if (frontEl) {
    const count = STATE.fronts.filter(f => f.active && !f.in_bin).length;
    LiveModel.paint(frontEl, `<span class="front-marker">OFICINA</span>
      <span class="front-title">${count} tareas activas</span>`);
  }

  // Update Sidebar Badges
  const badgeProjects = document.getElementById("badgeProjects");
  if (badgeProjects) badgeProjects.textContent = STATE.projects.length;

  const badgeMailbox = document.getElementById("badgeMailbox");
  if (badgeMailbox) {
    const open = (STATE.mailbox || []).filter(e => Mailbox.isPending(e)).length;
    badgeMailbox.textContent = open;
    badgeMailbox.classList.toggle("warn-badge", open > 0);
  }
  const badgeNotebook = document.getElementById("badgeNotebook");
  if (badgeNotebook) badgeNotebook.textContent = STATE.tree?.notebook?.available ? Notebook.files(STATE.tree).length : '…';

  const badgeDecisions = document.getElementById("badgeDecisions");
  if (badgeDecisions) badgeDecisions.textContent = liveDecisions().length;

  const badgeLibrary = document.getElementById("badgeLibrary");
  // ⚠️ La cuenta es la del vault, no la del árbol entero: la sala responde «qué sabe esta
  // empresa», y los cartuchos de proyecto y el sistema no son conocimiento, son estado.
  if (badgeLibrary) {
    const t = STATE.tree;
    badgeLibrary.textContent = t && t.available
      ? libraryFiles().length : "…";
  }
  const badgeSkills = document.getElementById("badgeSkills");
  if (badgeSkills) badgeSkills.textContent = STATE.skills.length;

  // Update Project Filter Dropdown in sidebar footer
  const projSelect = document.getElementById("projectFilter");
  if (projSelect) {
    const cur = projSelect.value || "ALL";
    LiveModel.paint(projSelect, `<option value="ALL">Todos los proyectos (${STATE.projects.length})</option>` +
      STATE.projects.map(p => `<option value="${esc(p.name)}" ${p.name === cur ? "selected" : ""}>${esc(p.name)}</option>`).join(""));
  }

  // Update dynamic modal project dropdowns
  const taskProjSelect = document.getElementById("taskProject");
  if (taskProjSelect) {
    taskProjSelect.innerHTML = STATE.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("") +
      `<option value="cross">cross (General)</option>`;
  }

  const ideaProjSelect = document.getElementById("ideaProject");
  if (ideaProjSelect) {
    ideaProjSelect.innerHTML = STATE.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("") +
      `<option value="nexus">nexus (Sistema)</option>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEW ROUTER & PERSISTENCE (URL HASH + LOCAL STORAGE)
// ─────────────────────────────────────────────────────────────────────────────

function syncUrlHash() {
  if (!STATE.loaded || STATE.currentView === "reference-redirect") return;
  let hash = "";
  const view = STATE.currentView || "overview";

  if (view === "project-detail") {
    hash = projectRoute(STATE.selectedProject || "", STATE.projectSubtab || "objectives", STATE.projectFile || "", STATE.projectAnchor || "");
  } else if (view === "notebook") {
    hash = Notebook.route(notebookLocation());
  } else if (view === "library") {
    hash = Library.route(libraryLocation());
  } else if (view === "skill") {
    hash = `#/skill/${encodeURIComponent(STATE.skillOpen?.name || "")}`;
  } else if (view === "clause") {
    hash = `#/clause/${encodeURIComponent(STATE.clauseId || "")}`;
  } else if (view === "doc") {
    hash = `#/doc/${encodeURIComponent(STATE.docId || "")}`;
  } else if (view === "desk") {
    hash = `#/desk/${encodeURIComponent(STATE.deskCardId || "")}`;
  } else if (view === "cockpit") {
    // ⚠️ Guardaba `front=` y `filter=` del cockpit, que ya no lee nadie. Ahora guarda los
    // filtros que la Oficina usa de verdad, así que un recargado no te devuelve al mural
    // entero cuando estabas mirando un proyecto.
    hash = `#/cockpit`;
    const params = [];
    if (STATE.officeFilterProj && STATE.officeFilterProj !== "ALL") {
      params.push(`proyecto=${encodeURIComponent(STATE.officeFilterProj)}`);
    }
    if (STATE.officeFilterState && STATE.officeFilterState !== "active") {
      params.push(`estado=${encodeURIComponent(STATE.officeFilterState)}`);
    }
    if (params.length) hash += `?${params.join("&")}`;
  } else if (view === "skills") {
    hash = `#/skills`;
    if (STATE.skillFilterType && STATE.skillFilterType !== "ALL") {
      hash += `?filter=${encodeURIComponent(STATE.skillFilterType)}`;
    }
  } else if (view === "inbox") {
    hash = Mailbox.route(mailboxLocation());
  } else {
    hash = `#/${view}`;
  }

  if (window.location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
  try {
    localStorage.setItem("nexus_last_route", hash);
  } catch (e) {}
}

function restoreRouteFromUrl() {
  const hash = window.location.hash && !["#", "#/"].includes(window.location.hash)
    ? window.location.hash : "#/cockpit";

  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const params = new URLSearchParams(queryPart || "");

  const mainView = segments[0] || "overview";

  if (mainView === "project" || mainView === "project-detail") {
    STATE.currentView = "project-detail";
    STATE.selectedProject = decodeURIComponent(segments[1] || "");
    const legacy = { workflow: "plan", state: "plan", architecture: "definition", guide: "files", skills: "files", repos: "files" };
    STATE.projectSubtab = legacy[segments[2]] || segments[2] || "objectives";
    STATE.projectFile = params.get("file") || "";
    STATE.projectAnchor = params.get("section") || "";
  } else if (mainView === "notebook" || mainView === "ideas") {
    STATE.currentView = "notebook";
    STATE.notebookLocation = Notebook.location(params);
    STATE.notebookLegacyProject = mainView === 'ideas' ? params.get('project') || '' : '';
  } else if (mainView === "library") {
    STATE.currentView = "library";
    STATE.libShelf = params.get("root") || "";
    STATE.libFolder = params.get("folder") || "";
    STATE.libNote = params.get("note") ? {root:STATE.libShelf, path:params.get("note")} : null;
    STATE.libAnchor = params.get("anchor") || "";
    STATE.libSearchAll = params.get("all") === "1";
    STATE.libSearchRoot = params.get("note") ? params.get("searchRoot") || "" : STATE.libShelf;
    const q = params.get("q") || "";
    const searchKey = JSON.stringify([q, STATE.libSearchAll, STATE.libNote ? STATE.libSearchRoot || "" : STATE.libShelf]);
    if (!STATE.libNote) STATE.libSearchRoot = STATE.libShelf;
    STATE.searchQ = q;
    if (q && (STATE.searchKey !== searchKey || !STATE.search)) { STATE.searchKey = searchKey; setTimeout(() => loadSearch(q), 0); }
    if (!q) STATE.search = null;
    STATE.libLimit = 24;
  } else if (mainView === "skill" && segments[1]) {
    // ⚠️ Restaurar esta ruta no es sólo fijar la vista: su contenido se pide al servidor,
    // así que hay que relanzar la petición o la página queda en blanco tras una recarga.
    const n = decodeURIComponent(segments[1]);
    STATE.currentView = "skill";
    if (!STATE.skillOpen || STATE.skillOpen.name !== n) {
      STATE.skillOpen = { name: n, loading: true };
      setTimeout(() => window.openSkill(n), 0);
    }
  } else if (mainView === "clause") {
    STATE.currentView = "clause";
    if (segments[1]) STATE.clauseId = decodeURIComponent(segments[1]);
  } else if (mainView === "doc") {
    STATE.currentView = "doc";
    if (segments[1]) STATE.docId = decodeURIComponent(segments[1]);
  } else if (mainView === "desk") {
    STATE.currentView = "desk";
    if (segments[1]) STATE.deskCardId = decodeURIComponent(segments[1]);
  } else if (mainView === "cockpit") {
    STATE.currentView = "cockpit";
    STATE.officeFilterProj = params.get("proyecto") || "ALL";
    STATE.officeFilterState = params.get("estado") || "active";
  } else if (mainView === "cheatsheet") {
    STATE.currentView = "reference-redirect";
    STATE.legacyReference = params.get("tab") || "session";
  } else if (mainView === "skills") {
    STATE.currentView = "skills";
    if (params.has("filter")) {
      STATE.skillFilterType = decodeURIComponent(params.get("filter"));
    }
  } else if (mainView === "decisions") {
    // La vista se retiró (`interface:I14.2`) y la ruta sobrevive redirigida: un marcador
    // viejo aterriza en el hub, que es donde las decisiones viven ahora, y con el proyecto
    // ya seleccionado si el enlace lo traía.
    STATE.currentView = "projects";
    if (params.has("project")) {
      STATE.selectedProject = decodeURIComponent(params.get("project"));
    }
  } else if (mainView === "inbox") {
    STATE.currentView = "inbox";
    STATE.mailLocation = Mailbox.location(params);
  } else if (["overview", "projects", "library", "dashboard"].includes(mainView)) {
    STATE.currentView = mainView;
  }

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === STATE.currentView);
  });
}

window.addEventListener("hashchange", () => {
  if (STATE.loaded) {
    restoreRouteFromUrl();
    renderView();
  }
});

window.addEventListener("popstate", () => {
  if (STATE.loaded) {
    restoreRouteFromUrl();
    renderView();
  }
});

window.navigateTo = function(viewName) {
  if (viewName === "ideas") viewName = "notebook";
  if (viewName === "cheatsheet") {viewName="reference-redirect";STATE.legacyReference="session";}
  if (STATE.currentView !== viewName) history.pushState(null, "", `#/${viewName}`);
  STATE.currentView = viewName;
  if (viewName === "inbox") STATE.mailLocation = Mailbox.location(new URLSearchParams());
  if (viewName === "notebook") STATE.notebookLocation = Notebook.location(new URLSearchParams());
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
  });
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
};


// A row shows a short line and opens for the rest. Long text read in full is text
// read once and then skipped — and the live plan is the file that most needs reading.
function summarise(text, max = 110) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return { head: t, rest: null };
  // cut at a sentence end if one is near, else at a word
  const dot = t.slice(0, max + 40).search(/[.;:]\s/);
  const cut = dot > 40 ? dot + 1 : t.lastIndexOf(" ", max);
  return { head: t.slice(0, cut > 40 ? cut : max).trim(), rest: t.slice(cut > 40 ? cut : max).trim() };
}

// ⚠️ `summarise` returns a pair, not a string — interpolating it gives `[object Object]`,
// which is what every card on the first office build showed. This is the string form, for
// the places that cannot open (a card whose whole surface is already a link).
function cut(text, max = 110) {
  const { head, rest } = summarise(text, max);
  return inline(head) + (rest ? "…" : "");
}

function expandable(text, cls = "") {
  const { head, rest } = summarise(text);
  if (!rest) return `<span class="${cls}">${inline(head)}</span>`;
  return `<span class="${cls}">${inline(head)}` +
    `<button class="more-toggle" onclick="this.parentElement.classList.toggle('open')">…</button>` +
    `<span class="more-body">${inline(rest)}</span></span>`;
}


// The compass honours the project filter too. Focusing on one project means the file
// you read to decide what is next, not only the queues.
// A front with no project is cross-project by design and always shows: hiding it would
// hide exactly the dependencies that belong to no single project.
function visibleFronts() {
  const p = STATE.frontFilterProj;
  return !p ? STATE.fronts : STATE.fronts.filter(f => !f.project || f.project === p);
}


// Counts exclude the sealed mirror by field. A frozen copy is a declared photograph
// (AX-20), so it belongs behind a toggle in the list and in no headline — 274 against
// a real 172 is a 59% overstatement on the metric the page exists to show.
function liveDecisions() {
  return (STATE.decisions || []).filter(d => !d.frozen);
}

const PROJECT_READING = (() => {
  try { return JSON.parse(sessionStorage.getItem("project-reading") || "{}"); } catch { return {}; }
})();

function rememberProjectReading(main) {
  const route = main.dataset.route || "";
  if (!(route.startsWith("#/project/") || route.startsWith("#/library") || route.startsWith("#/inbox") || route.startsWith("#/notebook") || route.startsWith("desk/")) || main.dataset.readerReady !== "true") return;
  const saved = PROJECT_READING[route] || (PROJECT_READING[route] = { details: {} });
  saved.scroll = main.scrollTop;
  main.querySelectorAll("details[id]").forEach(detail => { saved.details[detail.id] = detail.open; });
  try { sessionStorage.setItem("project-reading", JSON.stringify(PROJECT_READING)); } catch {}
}

function paintView(container, html) {
  if (container.dataset.live === "true") LiveModel.paint(container, html);
  else container.innerHTML = html;
}

function renderView(live = false) {
  const main = document.getElementById("mainContent");
  if (!main) return;

  if (!STATE.loaded && !STATE.error) {
    main.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <h3>Cargando modelo de operaciones...</h3>
        <p>Sincronizando entidades desde <code>/api/model</code></p>
      </div>
    `;
    return;
  }

  if (STATE.error) {
    const red = STATE.errorKind !== "vista";
    main.innerHTML = `
      <div class="error-state">
        <div class="error-icon">⚠️</div>
        <h3>${red ? "No se pudo hablar con el servidor"
                  : `La vista <code>${esc(STATE.errorWhere || "")}</code> falló al pintarse`}</h3>
        <p>${esc(STATE.error)}</p>
        ${red ? `<p class="error-hint">El modelo no llegó. Comprueba que <code>server.py</code>
                   sigue en pie y que el adaptador apunta a donde crees.</p>`
              : `<p class="error-hint">El modelo llegó bien: el fallo es del código de la vista,
                   no de la red ni del adaptador.</p>
                 ${STATE.errorStack ? `<pre class="error-stack">${esc(STATE.errorStack)}</pre>` : ""}`}
        <button class="btn-retry" onclick="window.retryLoad()">Reintentar</button>
      </div>
    `;
    return;
  }

  if (STATE.currentView === 'reference-redirect') {
    if (!STATE.tree) {main.innerHTML='<p role="status">Buscando la referencia…</p>';return;}
    history.replaceState(null,'',References.redirect(STATE.tree.references,STATE.legacyReference));
    restoreRouteFromUrl();
  }

  const route = STATE.currentView === "desk" ? `desk/${STATE.deskCardId}` : STATE.currentView === "project-detail"
    ? projectRoute(STATE.selectedProject, STATE.projectSubtab, STATE.projectFile) : STATE.currentView === "library" ? Library.route({...libraryLocation(), anchor:""}) : STATE.currentView === "notebook" ? Notebook.route({...notebookLocation(),anchor:""}) : STATE.currentView === "inbox" ? Mailbox.route(mailboxLocation()) : STATE.currentView;
  rememberProjectReading(main);
  STATE.readingPositions = STATE.readingPositions || {};
  if (main.dataset.route) STATE.readingPositions[main.dataset.route] = main.scrollTop;
  const sameRoute = main.dataset.route === route;
  main.dataset.live = String(live && sameRoute);
  const openDetails = sameRoute ? [...main.querySelectorAll("details[id][open]")].map(d => d.id) : [];
  const savedReading = PROJECT_READING[route];
  const scrollTop = savedReading?.scroll ?? STATE.readingPositions[route] ?? 0;
  switch (STATE.currentView) {
    case "overview": renderOverview(main); break;
    case "projects": renderProjectsHub(main); break;
    case "project-detail": renderProjectDetailPage(main); break;
    case "cockpit": renderOffice(main); break;
    case "desk": renderDesk(main); break;
    case "clause": renderClause(main); break;
    case "doc": renderDoc(main); break;
    case "dashboard": renderDashboard(main); break;
    case "skill": renderSkillPage(main); break;
    case "inbox": renderInbox(main); break;
    case "notebook": renderNotebook(main); break;
    case "skills": renderSkills(main); break;
    case "library": renderLibrary(main); break;
    default: renderOverview(main); break;
  }

  main.dataset.route = route;
  const secondaryNavigation=document.getElementById('secondaryNavigation');
  if(secondaryNavigation && ['overview','skills','skill','dashboard'].includes(STATE.currentView)) secondaryNavigation.open=true;
  const sidebarFilter = document.getElementById('projectFilter')?.closest('.filter-group');
  if (sidebarFilter) sidebarFilter.style.display = ['inbox','notebook'].includes(STATE.currentView) ? 'none' : '';
  openDetails.forEach(id => { const node = document.getElementById(id); if (node) node.open = true; });
  main.dataset.readerReady = String(Boolean(main.querySelector(".project-page, .project-file-index, .library-browser, .mailbox-room, .notebook-browser, .quiet-desk")));
  if (STATE.currentView === 'desk') main.dataset.readerReady = String(Boolean(STATE.taskSheets?.[STATE.deskCardId] && !STATE.taskSheets[STATE.deskCardId].loading));
  if (STATE.currentView === 'notebook' && notebookLocation().path) main.dataset.readerReady = String(STATE.notes?.[Library.key({root:STATE.tree?.notebook?.root,path:notebookLocation().path})]?.body !== undefined);
  Object.entries(savedReading?.details || {}).forEach(([id, open]) => {
    const detail = document.getElementById(id); if (detail) detail.open = open;
  });
  main.scrollTop = scrollTop;
  if (STATE.currentView === "project-detail" && STATE.projectAnchor !== "" && STATE.projectAnchor != null) {
    const heading = document.getElementById(`project-heading-${STATE.projectAnchor}`);
    if (heading && (PROJECT_READING[route]?.anchor !== STATE.projectAnchor || main.dataset.anchor !== `${route}/${STATE.projectAnchor}` && !savedReading)) {
      if (heading.tagName === "DETAILS") heading.open = true;
      heading.scrollIntoView({ block: "start" });
      main.dataset.anchor = `${route}/${STATE.projectAnchor}`;
      PROJECT_READING[route] = { ...(PROJECT_READING[route] || { details: {} }), anchor: STATE.projectAnchor };
    }
  } else if (STATE.currentView === "notebook") {
    restoreNotebookTarget(main, savedReading);
  } else if (STATE.currentView === "library" && STATE.libAnchor) {
    const anchor = "note-heading-" + Library.slug(STATE.libAnchor);
    const heading = document.getElementById(anchor) || document.getElementById("library-missing-anchor");
    if (heading && main.dataset.anchor !== `${route}/${STATE.libAnchor}`) {
      heading.scrollIntoView({block:"start"}); main.dataset.anchor = `${route}/${STATE.libAnchor}`;
    }
  } else { main.dataset.anchor = ""; }
  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.view === (STATE.currentView === "desk" ? "cockpit" : STATE.currentView === "project-detail" ? "projects" : STATE.currentView));
  });
  rememberProjectReading(main);
  syncUrlHash();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. OVERVIEW & ARCHITECTURE VIEW (Chuleta Garnatxa Editorial Design)
// ─────────────────────────────────────────────────────────────────────────────
function renderOverview(container) {
  const activeWf = STATE.selectedWorkflowTab || "project";
  const isCollapsed = (id) => Boolean(STATE.collapsedSections && STATE.collapsedSections[id]);
  const ax = D().axioms, cl = D().clauses;

  paintView(container, `
    <div class="overview-container">
      <!-- EL PROPILEO: la puerta -->
      <header class="propylaea">
        <div class="propylaea-fluting" aria-hidden="true"></div>
        <div class="propylaea-inner">
          <div class="kicker">ΜΗΧΑΝΗ · Aevifex & NEXUS</div>
          <h1>Aevifex <span class="accent">&amp; NEXUS</span></h1>
          <p class="header-lead">
            <strong>Aevifex es la constitución. La centralita de operaciones es el país.</strong><br>
            Aquí están las reglas; el trabajo y su registro entero viven allí. Un agente que sólo
            haya leído Aevifex conoce todas las reglas y nada de lo que ha pasado nunca.
          </p>
          <div class="specs">
            <span class="spec-pill" onclick="openClause('PH-0')"><strong>🏛️ Cláusulas:</strong> ${cl.length || "—"}</span>
            <span class="spec-pill" onclick="navigateTo('dashboard')"><strong>⚖️ Axiomas:</strong> ${ax.length || "—"}</span>
            <span class="spec-pill" onclick="navigateTo('skills')"><strong>🏺 Skills:</strong> ${STATE.skills.length}</span>
            <span class="spec-pill" onclick="navigateTo('projects')"><strong>🚀 Proyectos:</strong> ${STATE.projects.length}</span>
            <span class="spec-pill" onclick="navigateTo('inbox')"><strong>📬 Buzón:</strong> ${(STATE.mailbox || []).filter(e => Mailbox.isPending(e)).length} sin cerrar</span>
            <span class="spec-pill active-pill" onclick="navigateTo('cockpit')"><strong>▶ Frente activo:</strong> ${STATE.activeFront ? esc(cutText(STATE.activeFront.name, 34)) : "ninguno"}</span>
          </div>
        </div>
      </header>

      <nav class="toc-bar">
        <button class="toc-pill" onclick="jumpToSection('sec-governance')"><span>🏛️</span> 01 · El templo</button>
        <button class="toc-pill" onclick="jumpToSection('sec-levels')"><span>🪜</span> 02 · Los tres niveles</button>
        <button class="toc-pill" onclick="jumpToSection('sec-structure')"><span>📜</span> 03 · Los ficheros troncales</button>
        <button class="toc-pill" onclick="jumpToSection('sec-routing')"><span>🧭</span> 04 · ¿Dónde va esto?</button>
        <button class="toc-pill" onclick="jumpToSection('sec-workflows')"><span>🔄</span> 05 · Los flujos</button>
        <button class="toc-pill" onclick="jumpToSection('sec-ecosystem')"><span>🗺️</span> 06 · El ecosistema</button>
      </nav>

      <!-- 01 · EL TEMPLO -->
      <section class="doc-section" id="sec-governance">
        <div class="section-head" onclick="toggleOverviewSection('sec-governance')">
          <h2><span class="num">01</span> <span class="sec-greek">ΝΑΟΣ</span> El templo — para qué existe la empresa</h2>
          <button class="section-toggle">${isCollapsed("sec-governance") ? "▶ Desplegar" : "▼ Plegar"}</button>
        </div>
        <div class="section-body ${isCollapsed("sec-governance") ? "collapsed" : ""}">
          <p class="section-lead">
            <code>PH-0</code> es el objetivo y sostiene el frontón; las seis columnas son las
            <strong>maneras concretas de perderlo</strong>, cada una cerrada por su cláusula.
            Pulsa una columna para leerla entera con los axiomas que la sirven.
            <strong>Todo esto se lee de <code>PHILOSOPHY.md</code> y <code>AXIOMS.md</code>; la
            página no guarda copia.</strong>
          </p>
          ${renderPediment()}
          ${renderRefusals()}
        </div>
      </section>

      <!-- 02 · LOS TRES NIVELES -->
      <section class="doc-section" id="sec-levels">
        <div class="section-head" onclick="toggleOverviewSection('sec-levels')">
          <h2><span class="num">02</span> <span class="sec-greek">ΒΑΘΜΟΙ</span> Los tres niveles, y nada puede difuminarlos</h2>
          <button class="section-toggle">${isCollapsed("sec-levels") ? "▶ Desplegar" : "▼ Plegar"}</button>
        </div>
        <div class="section-body ${isCollapsed("sec-levels") ? "collapsed" : ""}">
          ${renderEntablature()}
        </div>
      </section>

      <!-- 03 · LOS FICHEROS TRONCALES -->
      ${renderStructuralFiles(isCollapsed("sec-structure"))}

      <!-- 04 · LA TABLA DE ENRUTADO -->
      ${renderRouting(isCollapsed("sec-routing"))}

      <!-- 05 · LOS FLUJOS -->
      <section class="doc-section" id="sec-workflows">
        <div class="section-head" onclick="toggleOverviewSection('sec-workflows')">
          <h2><span class="num">05</span> <span class="sec-greek">ΕΡΓΑ</span> Los cinco flujos de trabajo</h2>
          <button class="section-toggle">${isCollapsed("sec-workflows") ? "▶ Desplegar" : "▼ Plegar"}</button>
        </div>
        <div class="section-body ${isCollapsed("sec-workflows") ? "collapsed" : ""}">
          <p class="section-lead">
            ⚠️ <strong>Esto es una lectura del método, no el método.</strong> A diferencia de todo
            lo anterior, estos cinco flujos no salen de ningún fichero: son una interpretación
            escrita a mano y pueden derivar. Lo que manda es
            <button class="inline-link" onclick="openDoc('METHOD')">METHOD.md</button>.
          </p>
          <div class="wf-tabs">
            <button class="wf-tab ${activeWf === 'project' ? 'active' : ''}" onclick="setWorkflowTab('project')">🚀 1. Trabajar en Proyecto</button>
            <button class="wf-tab ${activeWf === 'environment' ? 'active' : ''}" onclick="setWorkflowTab('environment')">🛠️ 2. Mejorar Entorno</button>
            <button class="wf-tab ${activeWf === 'knowledge' ? 'active' : ''}" onclick="setWorkflowTab('knowledge')">📚 3. Añadir Temario</button>
            <button class="wf-tab ${activeWf === 'cartridge' ? 'active' : ''}" onclick="setWorkflowTab('cartridge')">🏗️ 4. Crear / Redefinir</button>
            <button class="wf-tab ${activeWf === 'coursework' ? 'active' : ''}" onclick="setWorkflowTab('coursework')">🎓 5. Formación & Corrección</button>
          </div>
          ${renderWorkflowDetail(activeWf)}
        </div>
      </section>

      <!-- 06 · EL ECOSISTEMA -->
      <section class="doc-section" id="sec-ecosystem">
        <div class="section-head" onclick="toggleOverviewSection('sec-ecosystem')">
          <h2><span class="num">06</span> <span class="sec-greek">ΑΓΟΡΑ</span> El ecosistema — dónde se trabaja</h2>
          <button class="section-toggle">${isCollapsed("sec-ecosystem") ? "▶ Desplegar" : "▼ Plegar"}</button>
        </div>
        <div class="section-body ${isCollapsed("sec-ecosystem") ? "collapsed" : ""}">
          <div class="eco-grid">
            ${[
              ["cockpit", "🗂️", "Oficina", "El mural de todo lo que hay abierto. Una tarjeta por tarea; se clica y se entra en su despacho.", `${officeCards().length} tarjetas`],
              ["inbox", "📬", "Buzón", "Los asuntos que necesitan tu criterio, con su contexto y su proyecto.", `${(STATE.mailbox||[]).filter(Mailbox.isPending).length} pendientes`],
              ["dashboard", "📐", "Dashboard", "Lo que se mide y lo que todavía no. Cada medida con su denominador y su fuente.", "PH-6"],
              ["skills", "🏺", "Ágora", "Las skills, agrupadas por cómo las alcanza el modelo.", `${STATE.skills.length} skills`],
              ["projects", "🚀", "Projects Hub", "Cada proyecto, un cartucho soberano con su propio ciclo de vida — su definición, sus objetivos, su plan, sus axiomas y <strong>su registro de decisiones</strong>.", `${STATE.projects.length} proyectos · ${liveDecisions().length} decisiones vivas`],
              ["notebook", "🗒️", "Notebook", "Tus notas e ideas, reunidas por proyecto.", `${Notebook.files(STATE.tree).length} documentos`],

            ].map(([view, icon, title, desc, tag]) => `
              <div class="eco-card-doc" onclick="navigateTo('${view}')">
                <div class="eco-card-head"><span class="eco-icon">${icon}</span><h3>${title}</h3></div>
                <p>${desc}</p>
                <div class="eco-foot"><span class="eco-tag">${esc(tag)}</span><span class="eco-link">abrir →</span></div>
              </div>`).join("")}
          </div>
        </div>
      </section>
    </div>
  `);
}

// ── 02 · el entablamento: los tres niveles, uno encima de otro ───────────────
function renderEntablature() {
  const ax = D().axioms, cl = D().clauses;
  const runnable = ax.filter(a => a.check_state === "$").length;
  const levels = [
    { n: 1, greek: "ΛΟΓΟΣ", tone: "tone-gold", band: "cornisa",
      title: "Filosofía", file: "PHILOSOPHY.md",
      what: "Para qué existe la empresa y qué rechaza. <strong>Rompe todo empate</strong>: cuando dos axiomas chocan decide la cláusula que sirven, y cuando chocan dos cláusulas decide <code>PH-0</code>.",
      who: "Cambia casi nunca, y sólo el operador. Ningún rol puede enmendarla — la señal va al operador y muere ahí si no la recoge.",
      count: `${cl.length || "—"} cláusulas`,
      go: `openClause('PH-0')`, goLabel: "abrir el frontón →" },
    { n: 2, greek: "ΝΟΜΟΣ", tone: "tone-aegean", band: "friso",
      title: "Axiomas", file: "AXIOMS.md",
      what: "Las reglas que la implementan y no se violan nunca. Una fila es una regla completa en sí misma; si no cabe en dos frases, son dos axiomas o es una decisión.",
      who: "Los auditores comprueban, nunca editan. I+D propone. El operador decide.",
      count: `${ax.length || "—"} axiomas · ${runnable} con check que corre`,
      go: `navigateTo('dashboard')`, goLabel: "ver cuánto se hacen cumplir →" },
    { n: 3, greek: "ΠΡΑΞΙΣ", tone: "tone-grape", band: "arquitrabe",
      title: "Decisiones", file: "la centralita, nunca aquí",
      what: "Concretas, con autor, fecha y razonamiento — <strong>y con lo que se descartó</strong>, que es la parte que no deja rastro en ningún otro sitio si nadie la escribe.",
      who: "Se toman trabajando. Se escriben en el momento: una decisión sin escribir vuelve como debate abierto.",
      count: `${liveDecisions().length} vivas`,
      go: `navigateTo('projects')`, goLabel: "abrir el hub, que es donde viven →" }
  ];
  return `
    <p class="section-lead">
      Y <strong>los mismos tres se repiten un piso más abajo dentro de cada proyecto</strong>,
      con su propio auditor, sus propios axiomas y su propio log. Lo que separa los niveles no es
      la importancia sino <em>quién puede cambiarlos y con qué</em>.
    </p>
    <div class="entablature">
      ${levels.map(l => `
        <button class="entab-band ${l.tone}" onclick="${l.go}">
          <span class="entab-rank">
            <span class="entab-greek">${l.greek}</span>
            <span class="entab-n">${l.n}</span>
            <span class="entab-band-name">${l.band}</span>
          </span>
          <span class="entab-main">
            <span class="entab-title">${l.title}
              <code class="entab-file">${esc(l.file)}</code>
            </span>
            <span class="entab-what">${l.what}</span>
            <span class="entab-who">${l.who}</span>
          </span>
          <span class="entab-side">
            <span class="entab-count">${esc(l.count)}</span>
            <span class="entab-go">${l.goLabel}</span>
          </span>
        </button>`).join("")}
      <div class="entab-stylobate">
        <span>Y debajo de todo, el trabajo: proyectos, tareas y planes — que es lo que la
              centralita guarda y este repositorio nunca ve.</span>
      </div>
    </div>`;
}

// ── 04 · la tabla de enrutado, leída de METHOD.md §7 ─────────────────────────
function renderRouting(collapsed) {
  const sec = docSection("METHOD", "7. Routing table");
  const { header, rows } = mdTable(sec);
  // La coda del §7 es una regla, no un pie de tabla, y ocupa un párrafo entero: cogerla
  // línea a línea la cortaba a mitad de frase — «Redefine the» y ahí se acababa.
  let coda = "";
  const at = sec.findIndex(l => l.trim().startsWith("**If something fits nowhere"));
  if (at >= 0) {
    const out = [];
    for (let i = at; i < sec.length && sec[i].trim(); i++) out.push(sec[i].trim());
    coda = out.join(" ");
  }
  const q = (STATE.routingQuery || "").toLowerCase().trim();
  const shown = q ? rows.filter(r => r.join(" ").toLowerCase().includes(q)) : rows;

  return `
    <section class="doc-section" id="sec-routing">
      <div class="section-head" onclick="toggleOverviewSection('sec-routing')">
        <h2><span class="num">04</span> <span class="sec-greek">ΟΔΟΣ</span> Tengo esto, ¿dónde va?</h2>
        <button class="section-toggle">${collapsed ? "▶ Desplegar" : "▼ Plegar"}</button>
      </div>
      <div class="section-body ${collapsed ? "collapsed" : ""}">
        ${rows.length ? `
          <p class="section-lead">
            La tabla de enrutado del método, <strong>leída de <code>METHOD.md</code> §7 en vivo</strong>.
            Es la pregunta que más veces se hace al día, así que vive en la portada y no en un manual.
          </p>
          <div class="routing-search">
            <input type="text" class="custom-input" placeholder="Filtrar: decisión, hallazgo, regla, idea, tarea…"
                   value="${esc(STATE.routingQuery || "")}" oninput="setRoutingQuery(this.value)">
            <span class="routing-count">${shown.length} de ${rows.length}</span>
          </div>
          <div class="routing-table">
            <div class="routing-head">
              <span>${esc(header ? header[0] : "Lo que tienes")}</span>
              <span>${esc(header ? header[1] : "Dónde va")}</span>
            </div>
            ${shown.length ? shown.map(r => `
              <div class="routing-row">
                <span class="routing-have">${inline(r[0])}</span>
                <span class="routing-goes">${inline(r[1])}</span>
              </div>`).join("") : `
              <div class="routing-row routing-none">
                <span>Nada encaja con «${esc(STATE.routingQuery || "")}».</span>
                <span>Y si algo no encaja en ninguna fila, <strong>lo que está mal es la
                      estructura, no el elemento</strong>.</span>
              </div>`}
          </div>
          ${coda ? `<div class="callout callout-danger"><span class="callout-icon">⛔</span>
            <div class="callout-content">${inline(coda)}</div></div>` : ""}
        ` : `
          <div class="empty-state"><div class="empty-icon">🧭</div>
            <h3>La tabla de enrutado no ha cargado</h3>
            <p>Sale de <code>METHOD.md</code> §7. Si el fichero no está en la raíz del motor,
               esta sección se queda vacía en vez de inventarse una tabla.</p></div>`}
      </div>
    </section>`;
}

window.setRoutingQuery = function (v) {
  STATE.routingQuery = v;
  const box = document.querySelector("#sec-routing .routing-table");
  const cnt = document.querySelector("#sec-routing .routing-count");
  if (!box) return renderView();
  // ⚠️ Se repinta sólo la tabla: un `renderView()` completo por cada tecla pierde el foco
  // del campo y el cursor salta al principio, que es la manera clásica de hacer un
  // buscador inservible.
  const { rows } = mdTable(docSection("METHOD", "7. Routing table"));
  const q = v.toLowerCase().trim();
  const shown = q ? rows.filter(r => r.join(" ").toLowerCase().includes(q)) : rows;
  if (cnt) cnt.textContent = `${shown.length} de ${rows.length}`;
  box.querySelectorAll(".routing-row").forEach(el => el.remove());
  box.insertAdjacentHTML("beforeend", shown.length ? shown.map(r => `
    <div class="routing-row">
      <span class="routing-have">${inline(r[0])}</span>
      <span class="routing-goes">${inline(r[1])}</span>
    </div>`).join("") : `
    <div class="routing-row routing-none">
      <span>Nada encaja con «${esc(v)}».</span>
      <span>Y si algo no encaja en ninguna fila, <strong>lo que está mal es la estructura,
            no el elemento</strong>.</span>
    </div>`);
};

// WORKFLOW DETAILS RENDERER
// ─────────────────────────────────────────────────────────────────────────────
function renderWorkflowDetail(type) {
  switch (type) {
    case "environment":
      return `
        <div class="workflow-detail-card">
          <p class="lead" style="margin-bottom: 14px;">
            <strong>Objetivo:</strong> Auditar, refinar y evolucionar la metodología y los axiomas de la empresa sin derivar en dogma ni degradar el contexto.
          </p>

          <div class="wf-stepper">
            <div class="wf-node">
              <span class="wf-node-step">1</span>
              <div class="wf-node-title">Detección de Tensión</div>
              <p class="wf-node-desc">Se detecta una contradicción en logs, desacoplamiento o residuo en MAILBOX.md.</p>
              <span class="card-badge" style="margin-top:auto; align-self:flex-start;">MAILBOX.md</span>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">2</span>
              <div class="wf-node-title">Pensamiento Lateral</div>
              <p class="wf-node-desc">Explora 3 a 5 ángulos no examinados y costea honestamente cada trade-off.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('rnd')">⚡ Skill: rnd</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">3</span>
              <div class="wf-node-title">Auditoría Estructural</div>
              <p class="wf-node-desc">Verifica que ningún axioma se viole y comprueba la alineación con la filosofía.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('company-auditor')">⚡ company-auditor</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">4</span>
              <div class="wf-node-title">Promoción Append-Only</div>
              <p class="wf-node-desc">Si se aprueba, se añade el nuevo axioma AX-x o se registra la decisión M-xxx.</p>
              <span class="card-badge badge-gold" style="margin-top:auto; align-self:flex-start;">AXIOMS.md</span>
            </div>
          </div>

          <div class="callout tip" style="margin-top: 14px; padding: 10px 14px;">
            <strong>Regla clave:</strong> Un axioma retirado <strong>sale del fichero entero</strong> y el log
            registra a dónde fue: el hueco en la numeración es la traza (<code>AX-31</code>). Lo append-only
            son los <em>Records</em> — logs, ledger y decisiones —, no los documentos Standing, que se
            reescriben para seguir siendo verdad.
          </div>
        </div>
      `;

    case "knowledge":
      return `
        <div class="workflow-detail-card">
          <p class="lead" style="margin-bottom: 14px;">
            <strong>Objetivo:</strong> Ingerir y modularizar nueva teoría externa o <strong>destilar los aprendizajes técnicos generados en los propios proyectos</strong> hacia la base de conocimiento permanente.
          </p>

          <div class="wf-stepper">
            <div class="wf-node">
              <span class="wf-node-step">1</span>
              <div class="wf-node-title">Ingestión / Fuente</div>
              <p class="wf-node-desc">Documentación externa, paper o lecciones técnicas extraídas de un bloque de proyecto.</p>
              <span class="card-badge" style="margin-top:auto; align-self:flex-start;">Proyecto / Paper</span>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">2</span>
              <div class="wf-node-title">Estructuración Modular</div>
              <p class="wf-node-desc">Define el árbol temático y descompone el temario en módulos interconectados antes de redactar.</p>
              <span class="card-badge badge-grape" style="margin-top:auto; align-self:flex-start;">💡 estructurar-temario</span>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">3</span>
              <div class="wf-node-title">Creación Atómica</div>
              <p class="wf-node-desc">Redacta e inserta cada nota atómica sobre la estructura previa del árbol temático.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('create-note')">⚡ Skill: create-note</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">4</span>
              <div class="wf-node-title">Auditoría & Coherencia</div>
              <p class="wf-node-desc">Comprueba la integridad de wikilinks, actualiza los índices del dominio y verifica coherencia.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('instance-auditor')">⚡ instance-auditor</button>
            </div>
          </div>

          <div class="callout tip" style="margin-top: 14px; padding: 10px 14px;">
            <strong>Regla clave:</strong> Estructurar primero, sobre fronteras dibujadas por dueño y no por temática
            (<code>PH-1</code>); y auditar coherencia y wikilinks antes de dar por cerrado, porque cada afirmación
            arrastra su evidencia (<code>PH-4</code>).
          </div>
        </div>
      `;

    case "cartridge":
      return `
        <div class="workflow-detail-card">
          <p class="lead" style="margin-bottom: 14px;">
            <strong>Objetivo:</strong> Inicializar un nuevo cartridge de proyecto soberano o redefinir su definición y estado cuando la realidad del trabajo haya variado.
          </p>

          <div class="wf-stepper">
            <div class="wf-node">
              <span class="wf-node-step">1</span>
              <div class="wf-node-title">Génesis del Cartridge</div>
              <p class="wf-node-desc">Crea definición, axiomas locales, log de decisiones, estado y fila en el compass.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('structure-project')">⚡ structure-project</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">2</span>
              <div class="wf-node-title">Detección de Deriva</div>
              <p class="wf-node-desc">El trabajo se anticipa al plan o los bloques ya no reflejan la realidad.</p>
              <span class="card-badge badge-rust" style="margin-top:auto; align-self:flex-start;">state.md desincronizado</span>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">3</span>
              <div class="wf-node-title">Redefinición Quirúrgica</div>
              <p class="wf-node-desc">Reescribe definition.md y state.md y añade una decisión sin tocar otros proyectos.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('redefine-project')">⚡ redefine-project</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">4</span>
              <div class="wf-node-title">Soberanía de Estado</div>
              <p class="wf-node-desc">El proyecto queda listo para ejecutar su siguiente bloque B_n en tiempo real.</p>
              <span class="card-badge badge-vine" style="margin-top:auto; align-self:flex-start;">state.md actualizado</span>
            </div>
          </div>

          <div class="callout tip" style="margin-top: 14px; padding: 10px 14px;">
            <strong>Regla clave:</strong> Cada proyecto es un repositorio soberano; jamás se acoplan por temática (PH-1).
          </div>
        </div>
      `;

    case "coursework":
      return `
        <div class="workflow-detail-card">
          <p class="lead" style="margin-bottom: 14px;">
            <strong>Objetivo:</strong> Abordar problemas, asignaciones o coursework académico asegurando el entendimiento completo del operador (PH-2) antes de entregar.
          </p>

          <div class="wf-stepper">
            <div class="wf-node">
              <span class="wf-node-step">1</span>
              <div class="wf-node-title">Enunciado & Guía</div>
              <p class="wf-node-desc">Analiza el problema y genera una guía estructurada de resolución y razonamiento.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('learn')">⚡ Skill: learn</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">2</span>
              <div class="wf-node-title">Ejecución Consciente</div>
              <p class="wf-node-desc">Se implementa la solución paso a paso asegurando que el operador asimila cada concepto.</p>
              <span class="card-badge badge-grape" style="margin-top:auto; align-self:flex-start;">💡 crear-guia</span>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">3</span>
              <div class="wf-node-title">Corrección Multinivel</div>
              <p class="wf-node-desc">Revisión exhaustiva de rigor matemático, robustez de código y calidad técnica.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('correct-exercise')">⚡ correct-exercise</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">4</span>
              <div class="wf-node-title">Consolidación</div>
              <p class="wf-node-desc">Se archiva el deliverable en 97_COURSEWORK y se destila la teoría relevante.</p>
              <span class="card-badge badge-vine" style="margin-top:auto; align-self:flex-start;">97_COURSEWORK/</span>
            </div>
          </div>

          <div class="callout tip" style="margin-top: 14px; padding: 10px 14px;">
            <strong>Regla clave:</strong> El entendimiento prevalece sobre la velocidad; cero soluciones no asimiladas (PH-2).
          </div>
        </div>
      `;

    case "project":
    default:
      return `
        <div class="workflow-detail-card">
          <p class="lead" style="margin-bottom: 14px;">
            <strong>Objetivo:</strong> Ejecutar trabajo real en cualquier cartridge de proyecto con preparación de tareas, brújula COMPASS, plan numérico en vuelo y auditoría de cierre.
          </p>

          <div class="wf-stepper">
            <div class="wf-node">
              <span class="wf-node-step">1</span>
              <div class="wf-node-title">Orientar (Compass)</div>
              <p class="wf-node-desc">Lee COMPASS.md y mailbox.md. Fija el único frente activo (▶).</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('open-session')">⚡ open-session</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">2</span>
              <div class="wf-node-title">Planificar en Vuelo</div>
              <p class="wf-node-desc">Construye el plan numérico del sub-bloque antes de tocar ningún archivo.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('current-plan')">⚡ current-plan</button>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">3</span>
              <div class="wf-node-title">Ejecutar Bloque B_n</div>
              <p class="wf-node-desc">Modifica código, datos y tests guiado por el hero de Next Action de state.md.</p>
              <span class="card-badge" style="margin-top:auto; align-self:flex-start;">state.md (B_n)</span>
            </div>
            <div class="wf-arrow">→</div>

            <div class="wf-node">
              <span class="wf-node-step">4</span>
              <div class="wf-node-title">Auditar & Cerrar</div>
              <p class="wf-node-desc">project-auditor valida el diff; se registran decisiones D_n y se actualiza state.md.</p>
              <button class="wf-node-btn" onclick="openSkillInCatalog('project-auditor')">⚡ project-auditor</button>
            </div>
          </div>

          <div class="callout tip" style="margin-top: 14px; padding: 10px 14px;">
            <strong>Regla clave:</strong> Toda tarea que cierra tacha su plan con destino obligatorio y audita antes de vaciar (METHOD §2).
          </div>
        </div>
      `;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW INTERACTION HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
window.toggleOverviewSection = function(sectionId) {
  STATE.collapsedSections = STATE.collapsedSections || {};
  STATE.collapsedSections[sectionId] = !STATE.collapsedSections[sectionId];
  renderView();
};

window.setWorkflowTab = function(tabKey) {
  STATE.selectedWorkflowTab = tabKey;
  renderView();
};

window.jumpToSection = function(sectionId) {
  if (STATE.collapsedSections && STATE.collapsedSections[sectionId]) {
    STATE.collapsedSections[sectionId] = false;
    renderView();
  }
  const el = document.getElementById(sectionId);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
};

// ⚠️ Buscaba `#skillSearchInput`, un id que el Ágora ya no tiene: el botón navegaba y
// luego no encontraba el campo, dejando la vista sin filtrar y sin decir nada. Un enlace a
// una skill concreta debe abrir esa skill, no dejar al lector buscándola en una lista.
window.openSkillInCatalog = function (skillName) {
  if ((STATE.skills || []).some(s => s.title === skillName)) return window.openSkill(skillName);
  // Si esa skill no está declarada por el adaptador, se va al Ágora con la búsqueda puesta
  // — que es lo más cerca que se puede llegar, y se ve por qué.
  STATE.skillSearch = skillName;
  navigateTo("skills");
};



// ─────────────────────────────────────────────────────────────────────────────
// 2. PROJECTS HUB & SOVEREIGN PROJECT DEDICATED WEBS
// ─────────────────────────────────────────────────────────────────────────────
function getProjectLab(p) {
  if (p.lab && p.lab !== "General") return p.lab;
  if (p.file) {
    const parts = p.file.replace(/\\/g, "/").split("/");
    const nIdx = parts.lastIndexOf("nexus");
    if (nIdx >= 2) {
      return parts[nIdx - 2];
    }
  }
  return "Workspaces";
}

function projectRoute(name, section = "objectives", file = "", anchor = "") {
  const params = new URLSearchParams();
  if (file) params.set("file", file);
  if (anchor) params.set("section", anchor);
  return `#/project/${encodeURIComponent(name)}/${section}${params.size ? "?" + params : ""}`;
}

function renderProjectsHub(container) {
  const projects = STATE.projects.filter(p => !STATE.taskFilterProj || p.name === STATE.taskFilterProj);
  const groups = [...new Set(projects.map(p => p.lab))];
  paintView(container, `<section class="project-room">
    <header class="quiet-heading"><p class="quiet-eyebrow">PROYECTOS</p>
      <h1>Un lugar para cada proyecto</h1><p>Sus objetivos, su plan y los documentos que explican el trabajo.</p></header>
    ${groups.map(group => `<section class="project-group" data-live-key="${esc(group)}"><h2>${esc(group)}</h2><div class="project-shelves">
      ${projects.filter(p => p.lab === group).map(p => `<article class="project-bookmark" data-live-key="${esc(p.name)}">
        <a class="project-title-link" href="${esc(projectRoute(p.name))}"><h3>${esc(p.name)}</h3></a>
        ${p.definition ? `<p class="project-intent">${inline(p.definition)}</p>` : ""}
        <div class="project-door-links"><a href="${esc(projectRoute(p.name))}">Objetivos</a>
          <a href="${esc(projectRoute(p.name, "plan"))}">Plan</a><a href="${esc(projectRoute(p.name, "files"))}">Archivos</a></div>
        <p class="project-source-facts">${p.ambiguous ? "El nombre corresponde a varios proyectos" : `${p.totalBlocks} bloques de plan · ${p.activeTasks.length} tareas activas`}</p>
      </article>`).join("")}</div></section>`).join("") || '<p>No hay proyectos declarados con este filtro.</p>'}
  </section>`);
}

function renderLabSection(labName, projects) {
  // ⛔ Aquí se etiquetaba cada laboratorio con una de dos frases fijas, elegida según si su
  // nombre contenía «proj». Ninguna salía de ningún fichero: eran afirmaciones sobre el
  // dominio de trabajo de alguien, inventadas por la vista — y una de ellas nombraba una
  // disciplina científica concreta, incrustada en un motor que `interface:AX-1` obliga a ser
  // genérico. Una fuga que el gate sólo habría visto si esa palabra estuviera en la denylist
  // de la instancia, y las palabras que uno inventa no suelen estar en ella.
  //
  // Un laboratorio es una carpeta. Lo único que la vista sabe es su nombre, así que es lo
  // único que dice.
  const icon = "🏛️";
  const badgeLabel = "agrupación por carpeta";
  const badgeClass = "tag-pill";
  const totalDecs = projects.reduce((acc, p) => acc + (p.decisionsCount || 0), 0);

  return `
    <div class="lab-group-container">
      <div class="lab-group-header">
        <div class="lab-title-group">
          <span class="lab-icon-bubble">${icon}</span>
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <h2 class="lab-title">${esc(labName)}</h2>
              <span class="tag-pill ${badgeClass}">${esc(badgeLabel)}</span>
            </div>
            <p class="lab-subtitle">Los proyectos que viven bajo <code>${esc(labName)}</code>. El agrupamiento
            es el de las carpetas: la interfaz no sabe nada más sobre este laboratorio, y no lo inventa.</p>
          </div>
        </div>
        <div class="lab-stats-pills">
          <span class="tag-pill">${projects.length} proyectos</span>
          <span class="tag-pill">📜 ${totalDecs} decisiones</span>
        </div>
      </div>

      <div class="projects-matrix-grid">
        ${projects.map(p => `
          <div class="project-card" onclick="openProjectDetail(${jsq(p.name)})">
            <div class="card-top">
              <div class="project-name-group">
                <span class="project-rank">${esc(p.rank)}</span>
                <h3 class="project-name">${esc(p.name)}</h3>
              </div>
              <span class="status-chip ${p.status === 'ACTIVE' ? 'status-active' : 'status-paused'}">${esc(p.status)}</span>
            </div>

            <p class="project-card-def-snippet">
              ${inline(p.definition)}
            </p>

            ${p.progress === null ? `
              <div class="progress-section progress-none"
                   title="El state.md de este proyecto no declara bloques. Una barra aquí sería un número inventado.">
                <span>Bloques — <strong>sin declarar</strong> en su <code>state.md</code></span>
              </div>` : `
              <div class="progress-section">
                <div class="progress-labels">
                  <span>Progreso de bloques</span>
                  <strong>${p.completedBlocks}/${p.totalBlocks} (${p.progress}%)</strong>
                </div>
                <div class="progress-bar-track">
                  <div class="progress-bar-fill" style="width: ${p.progress}%;"></div>
                </div>
              </div>`}

            <div class="card-meta-row">
              <span class="meta-item">📜 ${p.decisionsCount} decisiones</span>
              <span class="meta-item">⚖️ Cartridge Soberano</span>
              <span class="card-footer-action-inline">Explorar →</span>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOVEREIGN PROJECT DEDICATED PAGE
// ─────────────────────────────────────────────────────────────────────────────

function getRemoteHttpUrl(remote) {
  if (!remote) return "";
  let url = String(remote).trim();
  if (url.startsWith("git@github.com:")) {
    url = "https://github.com/" + url.slice("git@github.com:".length);
  }
  if (url.endsWith(".git")) {
    url = url.slice(0, -4);
  }
  return url.startsWith("http") ? url : "";
}

window.toggleRepoDropdown = function(event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const menu = document.getElementById("repoDropdownMenu");
  const btn = document.querySelector(".repo-dropdown-btn");
  if (!menu) return;
  const isShowing = menu.classList.contains("show");
  if (isShowing) {
    menu.classList.remove("show");
    btn?.classList.remove("active");
  } else {
    menu.classList.add("show");
    btn?.classList.add("active");
  }
};

document.addEventListener("click", (e) => {
  const wrapper = document.getElementById("repoDropdownWrapper");
  if (wrapper && !wrapper.contains(e.target)) {
    const menu = document.getElementById("repoDropdownMenu");
    const btn = document.querySelector(".repo-dropdown-btn");
    menu?.classList.remove("show");
    btn?.classList.remove("active");
  }
});

const PROJECT_ROLES = { objectives: "Objetivos", plan: "Plan", definition: "Definición", axioms: "Reglas", decisions: "Decisiones", log: "Registro de trabajo", contract: "Instrucciones" };

async function loadProjectResource(project, path = null) {
  const catalogs = STATE.projectCatalogs || (STATE.projectCatalogs = {});
  const documents = STATE.projectDocuments || (STATE.projectDocuments = {});
  const cache = path === null ? catalogs : documents;
  const key = path === null ? project : JSON.stringify([project, path]);
  cache[key] = { ...cache[key], loading: true, stale: false };
  const params = new URLSearchParams({ project });
  if (path !== null) params.set("path", path);
  try {
    const response = await fetch(`/api/project-${path === null ? "files" : "file"}?${params}`);
    const result = await response.json();
    if (!response.ok && !result.why) throw new Error(`HTTP ${response.status}`);
    cache[key] = result;
  } catch (error) {
    cache[key] = { available: false, why: "No se pudo leer el documento. " + error.message };
  }
  if (cache === (path === null ? STATE.projectCatalogs : STATE.projectDocuments)
      && STATE.currentView === "project-detail" && STATE.selectedProject === project) renderView(true);
}

function selectedProjectFile(project, catalog) {
  if (STATE.projectFile) return STATE.projectFile;
  const role = STATE.projectSubtab || "objectives";
  const file = (catalog?.files || []).find(f => f.role === role && f.primary);
  const definition = role === "objectives" && !(catalog?.files || []).some(f => f.role === "objectives")
    ? (catalog?.files || []).find(f => f.role === "definition" && f.primary) : null;
  return (file || definition)?.path || null;
}

function projectFileRows(project, files, query = "") {
  const needle = query.trim().toLocaleLowerCase();
  const matches = files.filter(f => !needle || `${f.title} ${f.path} ${PROJECT_ROLES[f.role] || ""}`.toLocaleLowerCase().includes(needle));
  return matches.map(f => `<a class="project-file-row" href="${esc(projectRoute(project.name, "files", f.path))}">
    <span>${f.primary ? `<strong>${esc(PROJECT_ROLES[f.role] || f.title)}</strong>` : `<strong>${esc(f.title)}</strong>`}
      <small>${esc(f.path)}</small></span><span aria-hidden="true">→</span></a>`).join("") || '<p class="quiet-empty">No hay documentos con ese texto.</p>';
}

window.filterProjectFiles = function(value) {
  STATE.projectFileQuery = value;
  const project = STATE.projects.find(p => p.name === STATE.selectedProject);
  const list = document.getElementById("projectFileList");
  if (project && list) list.innerHTML = projectFileRows(project, STATE.projectCatalogs?.[project.name]?.files || [], value);
};

function projectDocumentContent(doc) {
  const source = `<details class="project-original" id="project-original"><summary>Leer documento completo</summary><div class="project-markdown readme-markdown-body">${renderMarkdownBody(splitFrontmatter(doc.body).body)}</div></details>`;
  if (doc.objectives?.length) {
    const labels = { "Why": "Por qué", "Why it is an objective and not a task": "Por qué", "Met when": "Se cumple cuando" };
    return `<div class="project-objectives">${doc.objectives.map(objective => {
      const [first, ...rest] = objective.fields;
      return `<section class="project-objective" id="project-heading-${esc(objective.id)}"><span class="objective-id">${esc(objective.id)}</span>
        <div><h3>${inline(first?.[1] || "")}</h3><details id="objective-${esc(objective.id)}"><summary>Qué significa y cómo se cumple</summary>
          ${rest.map(([label, value]) => `<h4>${esc(labels[label] || label)}</h4><p>${inline(value)}</p>`).join("")}</details></div></section>`;
    }).join("")}</div>${source}`;
  }
  if (doc.blocks?.length) {
    return `<div class="project-plan-blocks">${doc.blocks.map(block => `<details id="project-heading-${esc(block.id)}" class="project-plan-block">
      <summary><span class="objective-id">${esc(block.id)}</span><span>${inline(block.title)}</span></summary>
      <div class="project-subblocks">${block.subblocks?.length ? block.subblocks.map(sub => `<section class="project-subblock"><h4>${esc(sub.id)}</h4><p>${inline(sub.title)}</p>
        ${sub.status_text ? `<p class="project-status-source"><strong>Estado:</strong> ${inline(sub.status_text)}</p>` : ""}
        ${sub.waits_on ? `<p class="project-status-source"><strong>Depende de:</strong> ${inline(sub.waits_on)}</p>` : ""}</section>`).join("") : '<p>Este bloque no tiene pasos desglosados en el plan.</p>'}</div>
    </details>`).join("")}</div>${source}`;
  }
  return `<div class="project-markdown readme-markdown-body">${renderMarkdownBody(splitFrontmatter(doc.body).body)}</div>`;
}

function projectNextLinks(project, doc) {
  const ids = new Set((project.nextAction || "").match(/\b[A-Z]+\d+(?:\.\d+[a-z]?)?\b/g) || []);
  return (doc.blocks || []).filter(b => ids.has(b.id) || (b.subblocks || []).some(s => ids.has(s.id)))
    .map(b => `<a href="${esc(projectRoute(project.name, STATE.projectSubtab, STATE.projectFile || "", b.id))}">Ir a ${esc(b.id)} →</a>`).join(" ");
}

function renderProjectDetailPage(container) {
  const project = STATE.projects.find(p => p.name === STATE.selectedProject);
  if (!project || project.ambiguous) {
    paintView(container, `<section class="project-room"><a class="quiet-back" href="#/projects">← Proyectos</a>
      <h1>${project ? "Este nombre corresponde a varios proyectos" : "Proyecto no encontrado"}</h1>
      <p>Vuelve a la lista para elegir un proyecto con sus propios documentos.</p></section>`);
    return;
  }
  const catalog = STATE.projectCatalogs?.[project.name];
  if (!catalog || catalog.stale) loadProjectResource(project.name);
  const section = STATE.projectSubtab || "objectives";
  const path = selectedProjectFile(project, catalog);
  const doc = path ? STATE.projectDocuments?.[JSON.stringify([project.name, path])] : null;
  if (path && (!doc || doc.stale)) loadProjectResource(project.name, path);
  const file = catalog?.files?.find(f => f.path === path);
  const role = file?.role || section;
  const title = PROJECT_ROLES[role] || file?.title || "Documento";
  let content;
  if ((!catalog || catalog.loading) && !catalog?.files && !path) {
    content = '<p class="quiet-loading" role="status">Leyendo los archivos del proyecto…</p>';
  } else if (catalog && !catalog.available && !catalog.loading) {
    content = `<p class="quiet-empty">${esc(catalog.why)}</p>`;
  } else if (section === "files" && !path) {
    content = `<section class="project-file-index"><h2>Archivos del proyecto</h2>
      <label class="project-file-search">Buscar documento<input type="search" value="${esc(STATE.projectFileQuery || "")}" oninput="filterProjectFiles(this.value)" placeholder="Título o nombre del archivo"></label>
      <p class="project-source-facts">${catalog?.files?.length || 0} documentos de lectura</p>
      <div id="projectFileList">${projectFileRows(project, catalog?.files || [], STATE.projectFileQuery || "")}</div></section>`;
  } else if (!path) {
    content = `<section class="project-missing"><h2>${esc(title)}</h2><p>No hay un documento único de ${esc(title.toLowerCase())} enlazado a este proyecto.</p>
      <a href="${esc(projectRoute(project.name, "files"))}">Ver los archivos disponibles →</a></section>`;
  } else if (!doc || (doc.loading && !doc.body)) {
    content = '<p class="quiet-loading" role="status">Abriendo el documento…</p>';
  } else if (!doc.available && !doc.loading) {
    content = `<p class="quiet-empty">${esc(doc.why)}</p>`;
  } else {
    const structured = Boolean(doc.objectives?.length || doc.blocks?.length);
    const outline = doc.objectives?.length ? doc.objectives.map(o => ({ key: o.id, title: o.id, level: 2 }))
      : doc.blocks?.length ? doc.blocks.map(b => ({ key: b.id, title: `${b.id} · ${b.title}`, level: 2 }))
      : (doc.outline || []).filter(h => h.level > 1 && h.level <= 3).map((h, i) => ({ ...h, key: String(i) }));
    content = `<div class="project-reading-layout">
      <aside class="project-outline" aria-label="Índice del documento"><details id="project-outline"><summary>En este documento</summary>
        ${outline.map((h, i) => `<a class="outline-level-${h.level}" href="${esc(projectRoute(project.name, section, STATE.projectFile || "", h.key))}">${esc(h.title)}</a>`).join("")}</details></aside>
      <article class="project-page" data-project-document="${esc(path)}">
        <header class="project-document-heading"><h2>${esc(title)}</h2>
          <span class="project-source-path">${esc(path)}</span>
          ${doc.loading ? '<span class="quiet-loading">Actualizando…</span>' : ""}</header>
        ${section === "objectives" && role === "definition" ? '<p class="project-next">Este proyecto aún no tiene un documento separado de objetivos. Puedes consultar su definición completa aquí.</p>' : ""}
        ${role === "plan" && project.nextAction ? `<div class="project-next"><strong>Siguiente acción declarada</strong><p>${inline(project.nextAction)}</p>${projectNextLinks(project, doc)}</div>` : ""}
        ${projectDocumentContent(doc)}
      </article></div>`;
  }
  paintView(container, `<section class="project-room project-detail-room">
    <div class="project-sticky-nav">
      <div class="project-reading-header"><a class="quiet-back" href="#/projects">← Proyectos</a>
        <label>Cambiar proyecto<select aria-label="Cambiar proyecto" onchange="openProjectDetail(this.value)">
          ${STATE.projects.map(p => `<option value="${esc(p.name)}" ${p.name === project.name ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label></div>
      <div class="project-reading-title"><h1>${esc(project.name)}</h1><span>${esc(project.lab)}</span></div>
      <nav class="project-primary-nav" aria-label="Documentos del proyecto">
        ${[["objectives", "Objetivos"], ["plan", "Plan"], ["files", "Archivos"]].map(([key, label]) => `<a ${section === key ? 'aria-current="page"' : ""} href="${esc(projectRoute(project.name, key))}">${label}</a>`).join("")}
        <details id="project-more"><summary>Más</summary><div>${[["definition", "Definición"], ["axioms", "Reglas"], ["decisions", "Decisiones"], ["log", "Registro de trabajo"]].map(([key, label]) => `<a href="${esc(projectRoute(project.name, key))}">${label}</a>`).join("")}</div></details>
      </nav>
    </div>
    ${referenceLinks("project:"+project.name)}
    ${content}
  </section>`);
  // The outline is tied to visible headings, not a guessed source summary.
  if (!doc?.objectives?.length && !doc?.blocks?.length) {
    container.querySelectorAll(".project-markdown h3, .project-markdown h4").forEach((heading, index) => {
      heading.id = `project-heading-${index}`;
    });
  }
}

function renderProjectSubtabContent(proj, tab, projectTasks, projectDecs) {
  switch (tab) {
    case "workflow": return renderProjectWorkflowTab(proj, projectTasks, projectDecs);
    case "state": return renderProjectStateTab(proj, projectTasks, projectDecs);
    case "architecture": return renderProjectArchitectureTab(proj);
    case "decisions": return renderProjectDecisionsTab(proj, projectDecs);
    case "skills": return renderProjectSkillsTab(proj);
    case "repos": return renderProjectReposTab(proj);
    case "guide": return renderProjectGuideTab(proj);
    default: return renderProjectWorkflowTab(proj, projectTasks, projectDecs);
  }
}

// ── TAB 1: WORKFLOW RAMIFICADO (Bloques, Subbloques y Log de Tareas) ──
function renderProjectWorkflowTab(proj, projectTasks, projectDecs) {
  const workflow = proj.workflow || [];

  // ⚠️ Sin bloques declarados esta pestaña enseñaba cuatro inventados. Ahora dice qué falta
  // y dónde se arregla, que es lo único que la interfaz sabe de verdad.
  if (!workflow.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon">🗺️</div>
        <h3>Este proyecto no declara bloques</h3>
        <p>Su <code>state.md</code> no lleva la lista de bloques, así que aquí no hay hoja de
           ruta que enseñar — y <strong>inventarla es peor que no tenerla</strong>, porque un
           lector no puede distinguir una hoja generada de una leída.</p>
        <p class="empty-hint">Se arregla escribiendo los bloques en el <code>state.md</code> del
           proyecto, o invocando <code>redefine-project</code>, que es la skill que existe para
           volver a alinear la definición con lo que el trabajo se ha convertido.</p>
        ${projectTasks.length ? `<p class="empty-hint">Mientras tanto, tiene
           <strong>${projectTasks.length}</strong> tarea${projectTasks.length === 1 ? "" : "s"}
           en la cola, que sí están declaradas.</p>` : ""}
      </div>`;
  }

  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">01</span> Mapa Ramificado de Fases, Bloques y Subbloques</h2>
      </div>
      <p class="lead">
        Secuencia estructurada de ejecución. Cada bloque maestro engloba sus subbloques ramificados, verificaciones y tareas vivas.
      </p>

      <div class="ramified-workflow-container">
        ${workflow.map((block, bIdx) => `
          <div class="wf-master-block ${block.status}">
            <div class="wf-master-header">
              <div class="wf-master-title-row">
                <span class="wf-master-id">${esc(block.id)}</span>
                <div>
                  <h3 class="wf-master-title">${esc(block.title)}</h3>
                  <p class="wf-master-summary">${inline(block.summary)}</p>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                <span class="card-badge ${block.status === 'completed' ? 'badge-vine' : (block.status === 'active' ? 'badge-gold' : '')}">${esc(block.statusLabel)}</span>
                ${block.decisions && block.decisions.length ? `
                  <span class="card-badge badge-grape" title="Decisiones asociadas: ${esc(block.decisions.join(', '))}">📜 ${block.decisions.length} Decs</span>
                ` : ''}
              </div>
            </div>

            <!-- SUBBLOCKS RAMIFICATION -->
            <div class="wf-subblocks-tree">
              ${block.subblocks && block.subblocks.length ? block.subblocks.map((sub, sIdx) => {
                const subTasks = sub.tasks || [];
                return `
                  <div class="wf-subblock-node ${sub.status}">
                    <div class="wf-subblock-connector"></div>
                    <div class="wf-subblock-card">
                      <div class="wf-subblock-header">
                        <div style="display: flex; align-items: center; gap: 8px;">
                          <span class="wf-subblock-id">${esc(sub.id)}</span>
                          <h4 class="wf-subblock-title">${esc(sub.title)}</h4>
                        </div>
                        <span class="card-badge ${sub.status === 'completed' ? 'badge-vine' : (sub.status === 'active' ? 'badge-gold' : '')}">
                          ${sub.status === 'completed' ? '✓ Listo' : (sub.status === 'active' ? '▶ En Curso' : '⏳ Pendiente')}
                        </span>
                      </div>
                      <p class="wf-subblock-desc">${inline(sub.desc)}</p>

                      <!-- SUBBLOCK EMBEDDED TASKS -->
                      ${subTasks.length ? `
                        <div class="wf-subblock-tasks">
                          <div class="wf-tasks-title">📋 Tareas en este subbloque (${subTasks.length}):</div>
                          <div class="tickets-list" style="margin-top: 8px;">
                            ${subTasks.map(t => `
                              <div class="ticket-card ${t.status === '✅' ? 'completed' : (t.status === '⚫' ? 'discarded' : '')}" style="background: #ffffff; padding: 12px 14px;">
                                <div class="ticket-top">
                                  <div style="display: flex; align-items: center; gap: 6px;">
                                    <span class="tag-pill tag-purple">${esc(t.id)}</span>
                                    <span class="tag-pill">${esc(t.status)}</span>
                                    <strong style="font-size: 13px;">${inline(t.title)}</strong>
                                  </div>
                                  ${renderDate(t.date, t.date_inferred)}
                                </div>
                                <p style="font-size: 12px; color: var(--ink-soft); margin: 4px 0 0;"><strong>Why:</strong> ${inline(t.why)}</p>                              </div>
                            `).join("")}
                          </div>
                        </div>
                      ` : ''}
                    </div>
                  </div>
                `;
              }).join("") : `
                <div style="font-size: 12px; color: var(--ink-muted); padding: 8px 16px;">Sin subbloques detallados.</div>
              `}
            </div>
          </div>
        `).join("")}
      </div>

      <!-- COMPLETE TASK LIST FOR THE PROJECT -->
      <div style="margin-top: 32px; border-top: 2px solid var(--line); padding-top: 24px;">
        <div class="section-subhead">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>📋</span> <strong>Log Completo de Tareas de ${esc(proj.name)} (${projectTasks.length})</strong>
          </div>
        </div>

        ${projectTasks.length ? `
          <div class="tickets-list" style="margin-top: 14px;">
            ${projectTasks.map(t => `
              <div class="ticket-card ${t.status === '✅' ? 'completed' : (t.status === '⚫' ? 'discarded' : '')}">
                <div class="ticket-top">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="tag-pill tag-purple" style="font-weight: 700;">${esc(t.id)}</span>
                    <span class="tag-pill">${esc(t.status)}</span>
                    <h3 class="ticket-title" style="${t.status === '✅' ? 'opacity: 0.88;' : ''}">${inline(t.title)}</h3>
                  </div>
                  ${renderDate(t.date, t.date_inferred)}
                </div>
                <p style="font-size: 13px; color: var(--ink-soft); line-height: 1.5; margin-top: 4px;">
                  <strong>Why:</strong> ${inline(t.why)}
                </p>              </div>
            `).join("")}
          </div>
        ` : `
          <div class="empty-state" style="padding: 24px; margin-top: 12px;">
            <p>No hay tareas registradas para <strong>${esc(proj.name)}</strong>.</p>
          </div>
        `}
      </div>
    </div>
  `;
}

// ── TAB 2: ESTADO VIVO (State Snapshot & Next Action) ──
function renderProjectStateTab(proj, projectTasks, projectDecs) {
  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">02</span> Estado Vivo del Cartridge (state.md)</h2>
      </div>
      <p class="lead">
        Instantánea en tiempo presente de la posición técnica verificada. <em>¿Seguiría siendo cierto si el trabajo se detuviera hoy?</em>
      </p>

      <!-- NEXT ACTION HERO BANNER -->
      <div class="next-action-hero-card" style="margin-bottom: 24px;">
        <span class="hero-icon">🎯</span>
        <div class="hero-content">
          <div class="hero-label">ACCIÓN SIGUIENTE INMEDIATA (NEXT ACTION)</div>
          <div class="hero-text">${inline(proj.nextAction)}</div>
          <div style="margin-top: 10px; display: flex; gap: 8px;">
            <button class="gov-link-btn" onclick="copyToClipboard(${jsq("claude -p 'execute next action on " + proj.name + "'")}, 'Comando de ejecución copiado')">
              ⚡ Ejecutar Acción con Agente
            </button>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="gov-bottom-card">
          <div class="gov-bottom-card-head">
            <span class="gov-level-badge badge-vine">SYNCHRONIZATION &amp; REPO</span>
          </div>
          <h3>Topología y Sincronía</h3>
          <div style="font-size: 13px; color: var(--ink-soft); line-height: 1.6; display: flex; flex-direction: column; gap: 8px;">
            <div><strong>Laboratorio / Entorno:</strong> ${esc(proj.lab)}</div>
            <div><strong>Sincronizado hasta:</strong> <span class="card-badge badge-gold">${esc(proj.integratedThrough)}</span></div>
            <div><strong>Última verificación:</strong> ${esc(proj.lastUpdated)}</div>
            <div><strong>Archivo de Estado:</strong> <code>${esc(proj.file || "nexus/state.md")}</code></div>
          </div>
        </div>

        <div class="gov-bottom-card">
          <div class="gov-bottom-card-head">
            <span class="gov-level-badge badge-grape">HEALTH &amp; GOVERNANCE</span>
          </div>
          <h3>Salud del Cartridge</h3>
          <div class="gov-stat-grid" style="margin: 4px 0;">
            <div class="gov-stat-box">
              <span class="gov-stat-val">${proj.completedBlocks}/${proj.totalBlocks}</span>
              <span class="gov-stat-lbl">Bloques</span>
            </div>
            <div class="gov-stat-box">
              <span class="gov-stat-val">${proj.decisionsCount}</span>
              <span class="gov-stat-lbl">Decisiones</span>
            </div>
            <div class="gov-stat-box">
              <span class="gov-stat-val">${projectTasks.length}</span>
              <span class="gov-stat-lbl">Tareas</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── TAB 3: ARQUITECTURA & DEFINICIÓN (Definition, MVP & Scope) ──
function renderProjectArchitectureTab(proj) {
  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">03</span> Arquitectura, Objetivos y Límites (definition.md)</h2>
      </div>
      <p class="lead">
        Definición inmutable de la iteración: qué es el proyecto, a quién pertenece, qué conforma el MVP y qué queda expresamente fuera de alcance.
      </p>

      <div class="gov-philosophy-panel" style="margin-bottom: 20px;">
        <div class="gov-panel-header">
          <div class="gov-panel-title">
            <span class="gov-level-badge badge-vine">PROPÓSITO &amp; MVP</span>
            <h3>Definición del Proyecto ${esc(proj.name)}</h3>
          </div>
        </div>
        <p style="font-size: 13.5px; color: var(--ink-soft); line-height: 1.6; margin-bottom: 16px;">
          ${inline(proj.definition)}
        </p>

        <div class="callout tip" style="margin-top: 12px;">
          <div class="callout-title"><span>🎯</span> Criterio de Éxito del MVP</div>
          <p style="margin: 0; font-size: 13px;">El MVP se considera completo cuando el flujo principal puede ejecutarse de principio a fin de forma determinista y verificada contra sus gates de auditoría.</p>
        </div>
      </div>

      <div class="grid-2">
        <div class="gov-bottom-card">
          <div class="gov-bottom-card-head">
            <span class="gov-level-badge badge-gold">ENTREGABLES</span>
          </div>
          <h3>Entregables Principales</h3>
          <div style="font-size: 12.5px; color: var(--ink-soft); line-height: 1.6;">
            <div>• Código modular bajo ramas de trabajo independientes (ej. <code>feature/*</code> o rama activa).</div>
            <div>• Registro de decisiones con justificación y alternativas descartadas.</div>
            <div>• Documentación de arquitectura y contratos de agente verificables.</div>
          </div>
        </div>

        <div class="gov-bottom-card">
          <div class="gov-bottom-card-head">
            <span class="gov-level-badge badge-rust">FUERA DE ALCANCE (OUT OF SCOPE)</span>
          </div>
          <h3>Límites y Restricciones</h3>
          <div style="font-size: 12.5px; color: var(--ink-soft); line-height: 1.6;">
            <div>🚫 Nunca acoplar el backend a estados volátiles de la interfaz.</div>
            <div>🚫 No pusher a ramas productivas sin autorización explícita del operador.</div>
            <div>🚫 Evitar optimizaciones prematuras antes de verificar los invariantes clave.</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── TAB 4: DECISIONES (D_n Log) ──
function renderProjectDecisionsTab(proj, projectDecs) {
  const liveDecs = projectDecs.filter(d => !d.isSuperseded);
  const supersededDecs = projectDecs.filter(d => d.isSuperseded);

  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">04</span> Registro de Decisiones de ${esc(proj.name)} (${projectDecs.length})</h2>
      </div>
      <p class="lead">
        Historial append-only de decisiones técnicas tomadas en este proyecto, con su razonamiento (Why), fecha, autor y estado de vivacidad.
      </p>

      <div class="gov-stat-grid" style="margin-bottom: 20px;">
        <div class="gov-stat-box">
          <span class="gov-stat-val">${liveDecs.length}</span>
          <span class="gov-stat-lbl">Decisiones Vivas</span>
        </div>
        <div class="gov-stat-box">
          <span class="gov-stat-val">${supersededDecs.length}</span>
          <span class="gov-stat-lbl">Reemplazadas</span>
        </div>
        <div class="gov-stat-box">
          <span class="gov-stat-val">${projectDecs.length}</span>
          <span class="gov-stat-lbl">Total Registrado</span>
        </div>
      </div>

      ${projectDecs.length ? `
        <div class="tickets-list">
          ${projectDecs.map(d => `
            <div class="ticket-card decision-card ${d.isSuperseded ? 'discarded' : ''}">
              <div class="ticket-top">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <span class="tag-pill tag-purple" style="font-weight: 700;">${esc(d.id)}</span>
                  ${d.isSuperseded ? `
                    <span class="tag-pill tag-superseded">🔄 Reemplazada por ${esc(d.supersededBy.join(", "))}</span>
                  ` : `
                    <span class="tag-pill tag-alive">🟢 VIVA</span>
                  `}
                  <strong style="font-size: 14px;">${inline(d.title)}</strong>
                </div>
                ${renderDate(d.date, d.date_inferred)}
              </div>
              ${(d.why || d.discarded) ? `
                <details class="decision-details">
                  <summary>
                    <span class="toggle-icon">▶</span>
                    <span>Ver razonamiento (Why)${d.discarded ? ' y descartados' : ''}</span>
                  </summary>
                  <div class="decision-body-content">
                    ${d.why ? `
                      <div class="decision-why-text">
                        <strong>Por qué (Why):</strong> ${inline(d.why)}
                      </div>
                    ` : ''}
                    ${d.discarded ? `
                      <div class="task-discard-callout" style="margin-top: 4px;">
                        <strong>⚫ Alternativa descartada (PH-3):</strong> ${inline(d.discarded)}
                      </div>
                    ` : ''}
                  </div>
                </details>
              ` : ''}
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="empty-state">
          <p>No hay decisiones registradas aún para <strong>${esc(proj.name)}</strong>.</p>
        </div>
      `}
    </div>
  `;
}

// ── TAB 5: SKILLS & OPERACIONES ──
function renderProjectSkillsTab(proj) {
  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">05</span> Skills &amp; Operaciones sobre ${esc(proj.name)}</h2>
      </div>
      <p class="lead">
        Capacidades y roles especializados para auditar, evolucionar o corregir este proyecto de forma determinista.
      </p>

      <div class="grid-2">
        <div class="doc-card">
          <div class="doc-card-head">
            <span class="card-badge badge-vine">AUDITORÍA</span>
            <span class="card-badge">project-auditor</span>
          </div>
          <h3>Auditar Proyecto</h3>
          <p>Verifica los cambios y el diff del proyecto contra sus propios axiomas de proyecto y reglas de higiene.</p>
          <button class="gov-link-btn" style="margin-top: auto;" onclick="copyToClipboard(${jsq("claude -p 'run project-auditor on " + proj.name + "'")}, 'Comando copiado')">
            📋 Copiar: claude -p 'run project-auditor on ${esc(proj.name)}'
          </button>
        </div>

        <div class="doc-card">
          <div class="doc-card-head">
            <span class="card-badge badge-gold">ESTADO &amp; DERIVA</span>
            <span class="card-badge">redefine-project</span>
          </div>
          <h3>Redefinir / Resincronizar</h3>
          <p>Reescribe definition.md y state.md cuando el proyecto ha derivado o avanzado varias decisiones sin actualizar.</p>
          <button class="gov-link-btn" style="margin-top: auto;" onclick="copyToClipboard(${jsq("claude -p 'run redefine-project on " + proj.name + "'")}, 'Comando copiado')">
            📋 Copiar: claude -p 'run redefine-project on ${esc(proj.name)}'
          </button>
        </div>

        <div class="doc-card">
          <div class="doc-card-head">
            <span class="card-badge badge-grape">SESIÓN</span>
            <span class="card-badge">open-session</span>
          </div>
          <h3>Abrir Sesión en Proyecto</h3>
          <p>Fija el frente activo en este proyecto, prepara el plan numérico en vuelo y abre el ciclo de trabajo.</p>
          <button class="gov-link-btn" style="margin-top: auto;" onclick="copyToClipboard(${jsq("claude -p 'open-session on " + proj.name + "'")}, 'Comando copiado')">
            📋 Copiar: claude -p 'open-session on ${esc(proj.name)}'
          </button>
        </div>

        <div class="doc-card">
          <div class="doc-card-head">
            <span class="card-badge badge-cyan">LIMPIEZA</span>
            <span class="card-badge">code-cleanup</span>
          </div>
          <h3>Limpieza Previa a Release</h3>
          <p>Elimina comentarios arqueológicos, vocabulario privado y wikilinks antes de compartir o proponer PR.</p>
          <button class="gov-link-btn" style="margin-top: auto;" onclick="copyToClipboard(${jsq("claude -p 'run code-cleanup on " + proj.name + "'")}, 'Comando copiado')">
            📋 Copiar: claude -p 'run code-cleanup on ${esc(proj.name)}'
          </button>
        </div>
      </div>
    </div>
  `;
}

window.updateLabFilter = function(lab) {
  STATE.selectedLabFilter = lab;
  renderView();
};

window.openProjectDetail = function(name) {
  window.location.hash = projectRoute(name).slice(1);
};

window.setProjectSubtab = function(section) {
  window.location.hash = projectRoute(STATE.selectedProject, section).slice(1);
};

window.selectProject = function(name) {
  openProjectDetail(name);
};


// ── TAB 6: REPOS & GIT DASHBOARD (CON GUÍA CHEATSHEET DESPLEGABLE) ──
function renderProjectReposTab(proj) {
  const remoteHttp = getRemoteHttpUrl(proj.remoteUrl);
  const activeBranch = proj.gitBranch || "dev";

  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">06</span> Repositorios, Workspace y Control de Versiones</h2>
        ${proj.gitBranch ? `<span class="tag-pill tag-live">🌿 Rama activa: ${esc(proj.gitBranch)}</span>` : '<span class="tag-pill tag-alive">🌿 Ramas estándar: master · ${esc(activeBranch)}</span>'}
      </div>
      <p class="lead">
        Ubicaciones soberanas de código fuente, repositorio remoto en GitHub, directorio de trabajo local y cartridge de gobernanza desacoplado en NEXUS.
      </p>

      <!-- REPOSITORIES & LOCATIONS GRID -->
      <div class="repo-cards-grid">
        <!-- 1. GITHUB REMOTE -->
        <div class="repo-loc-card">
          <div class="repo-loc-header">
            <div class="repo-loc-title-group">
              <span class="repo-loc-icon">🐙</span>
              <h3 class="repo-loc-title">Repositorio Remoto</h3>
            </div>
            <span class="card-badge ${proj.remoteUrl ? 'badge-vine' : ''}">${proj.remoteUrl ? 'GitHub Conectado' : 'Sin Remote'}</span>
          </div>

          <p style="font-size: 13px; color: var(--ink-soft); margin: 0; line-height: 1.5;">
            Repositorio en GitHub sincronizado con el ciclo de vida del proyecto.
          </p>

          <div class="repo-path-box">
            <code>${esc(proj.remoteUrl || 'No configurado en state.md')}</code>
          </div>

          ${proj.remoteUrl ? `
            <div class="repo-actions-row">
              <button class="btn-repo-action" onclick="copyToClipboard(${jsq(proj.remoteUrl)}, 'URL de GitHub copiada', event)">
                <span>📋 Copiar URL</span>
              </button>
              ${remoteHttp ? `
                <a href="${esc(remoteHttp)}" target="_blank" rel="noopener noreferrer" class="btn-repo-action" style="color: var(--vine-deep); border-color: var(--vine-border);">
                  <span>↗️ Abrir en GitHub</span>
                </a>
              ` : ''}
              <button class="btn-repo-action" onclick="copyToClipboard(${jsq("git clone " + proj.remoteUrl)}, 'Comando git clone copiado', event)">
                <span>💻 Copiar git clone</span>
              </button>
            </div>
          ` : ''}
        </div>

        <!-- 2. LOCAL WORKSPACE & COMMIT -->
        <div class="repo-loc-card">
          <div class="repo-loc-header">
            <div class="repo-loc-title-group">
              <span class="repo-loc-icon">💻</span>
              <h3 class="repo-loc-title">Workspace Local (Directorio de Código)</h3>
            </div>
            ${proj.gitBranch ? `<span class="tag-pill tag-purple" style="font-weight: 700;">${esc(proj.gitBranch)}</span>` : '<span class="card-badge">Local</span>'}
          </div>

          <p style="font-size: 13px; color: var(--ink-soft); margin: 0; line-height: 1.5;">
            Árbol de trabajo en la máquina local donde se ejecutan los scripts, tests y builds.
          </p>

          <div class="repo-path-box">
            <code>${esc(proj.codeRepo || '~/Documents/' + proj.name)}</code>
          </div>

          ${proj.gitCommit ? `
            <div class="repo-commit-box">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span class="tag-pill tag-purple" style="font-weight: 800; font-family: var(--font-mono);">${esc(proj.gitCommit)}</span>
                <strong style="font-size: 13px; color: var(--ink);">${inline(proj.gitCommitMsg || 'Commit activo')}</strong>
              </div>
              ${proj.gitCommitDate ? `<span style="font-size: 11.5px; color: var(--ink-muted); margin-top: 4px; display: block;">📅 Fecha del commit: ${esc(proj.gitCommitDate)}</span>` : ''}
            </div>
          ` : ''}

          <div class="repo-actions-row">
            <button class="btn-repo-action" onclick="copyToClipboard(${jsq(proj.codeRepo)}, 'Ruta del workspace copiada', event)">
              <span>📋 Copiar Ruta</span>
            </button>
            <button class="btn-repo-action" onclick="copyToClipboard(${jsq("cd " + proj.codeRepo)}, 'Comando cd copiado', event)">
              <span>💻 Copiar cd</span>
            </button>
          </div>
        </div>

        <!-- 3. NEXUS CARTRIDGE -->
        <div class="repo-loc-card">
          <div class="repo-loc-header">
            <div class="repo-loc-title-group">
              <span class="repo-loc-icon">🏛️</span>
              <h3 class="repo-loc-title">Cartridge de Gobernanza (NEXUS)</h3>
            </div>
            <span class="card-badge badge-gold">Desacoplado</span>
          </div>

          <p style="font-size: 13px; color: var(--ink-soft); margin: 0; line-height: 1.5;">
            Estructura de metadatos, estado vivo, definición arquitectónica y log append-only de decisiones (PH-1).
          </p>

          <div class="repo-path-box">
            <code>${esc(proj.name)}/nexus/ (state.md · Decision_Log.md · definition.md)</code>
          </div>

          <div class="repo-actions-row">
            <button class="btn-repo-action" onclick="copyToClipboard(${jsq(proj.name + '/nexus/state.md')}, 'Ruta state.md copiada', event)">
              <span>🎯 Copiar state.md</span>
            </button>
            <button class="btn-repo-action" onclick="copyToClipboard(${jsq(proj.name + '/nexus/Decision_Log.md')}, 'Ruta Decision_Log.md copiada', event)">
              <span>📜 Copiar Decision_Log.md</span>
            </button>
          </div>
        </div>
      </div>

      <!-- GUÍA OPERATIVA & CHEATSHEET GITHUB (DESPLEGABLE) -->
      <div style="margin-top: 28px;">
        <div class="section-head" style="cursor: default; margin-bottom: 8px;">
          <h3><span>📖</span> Guía Operativa de Comandos Git &amp; GitHub (master ⇄ ${esc(activeBranch)})</h3>
          <span class="card-badge badge-vine">CheatSheet Integrada</span>
        </div>
        <p class="lead" style="font-size: 13px; margin-bottom: 16px;">
          Comandos esenciales de la chuleta de <code>GitHub Workflow Guide</code> contextualizados para <strong>${esc(proj.name)}</strong> con copiado rápido en 1 clic.
        </p>

        <div class="git-guide-container">
          <!-- SECCIÓN 1: FLUJO DIARIO EN RAMA ACTIVA -->
          <details class="git-guide-accordion" open>
            <summary>
              <div class="accordion-title">
                <span>🌿</span>
                <span>1. Flujo Diario de Trabajo en Rama Activa (<code>${esc(activeBranch)}</code>)</span>
              </div>
              <span class="accordion-chevron">▼</span>
            </summary>
            <div class="git-guide-content">
              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("cd " + proj.codeRepo + " && git switch " + activeBranch + " && git pull origin " + activeBranch)}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">1. Cambiar a rama de trabajo y actualizar</span>
                  <code class="git-cmd-code">cd ${esc(proj.codeRepo)} && git switch ${esc(activeBranch)} && git pull origin ${esc(activeBranch)}</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("cd " + proj.codeRepo + " && git status -s")}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">2. Revisar cambios en el árbol de trabajo</span>
                  <code class="git-cmd-code">git status -s</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git add -A && git commit -m 'feat(" + proj.name + "): avance en sub-bloque activo'")}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">3. Preparar commit estructurado</span>
                  <code class="git-cmd-code">git add -A && git commit -m "feat(${esc(proj.name)}): avance en sub-bloque activo"</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git push origin " + activeBranch)}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">4. Subir cambios a la rama de trabajo</span>
                  <code class="git-cmd-code">git push origin ${esc(activeBranch)}</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>
            </div>
          </details>

          <!-- SECCIÓN 2: MERGE SEGURO HACIA MASTER -->
          <details class="git-guide-accordion">
            <summary>
              <div class="accordion-title">
                <span>🔀</span>
                <span>2. Integración y Merge Seguro de <code>${esc(activeBranch)}</code> hacia <code>master</code></span>
              </div>
              <span class="accordion-chevron">▼</span>
            </summary>
            <div class="git-guide-content">
              <div class="git-cmd-box" onclick="copyToClipboard('git switch master && git pull origin master', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">1. Cambiar a master y sincronizar con remoto</span>
                  <code class="git-cmd-code">git switch master && git pull origin master</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git merge --no-ff " + activeBranch + " -m 'merge: integrate " + activeBranch + " branch updates into master'")}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">2. Merge explícito sin fast-forward (burbuja de commit)</span>
                  <code class="git-cmd-code">git merge --no-ff ${esc(activeBranch)} -m "merge: integrate ${esc(activeBranch)} branch updates into master"</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git push origin master && git switch " + activeBranch)}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">3. Pushear master limpio y volver a la rama de trabajo</span>
                  <code class="git-cmd-code">git push origin master && git switch ${esc(activeBranch)}</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>
            </div>
          </details>

          <!-- SECCIÓN 3: INICIALIZAR NUEVO REPO & PRIMER COMMIT -->
          <details class="git-guide-accordion">
            <summary>
              <div class="accordion-title">
                <span>🚀</span>
                <span>3. Inicialización de un Nuevo Repositorio &amp; Primer Commit</span>
              </div>
              <span class="accordion-chevron">▼</span>
            </summary>
            <div class="git-guide-content">
              <div class="git-cmd-box" onclick="copyToClipboard('git init && git branch -M main', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">1. Inicializar repositorio y fijar rama principal</span>
                  <code class="git-cmd-code">git init && git branch -M main</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard('git add .gitignore && git commit -m \'chore: initial gitignore\'', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">2. Commitear .gitignore antes que cualquier archivo ⭐</span>
                  <code class="git-cmd-code">git add .gitignore && git commit -m "chore: initial gitignore"</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard('git count-objects -vH', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">3. Comprobar peso del repositorio antes de subir</span>
                  <code class="git-cmd-code">git count-objects -vH</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git remote add origin " + (proj.remoteUrl || "git@github.com:organization/" + proj.name + ".git") + " && git push -u origin main")}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">4. Vincular remoto en GitHub y subir upstream</span>
                  <code class="git-cmd-code">git remote add origin ${esc(proj.remoteUrl || 'git@github.com:organization/' + proj.name + '.git')} && git push -u origin main</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>
            </div>
          </details>

          <!-- SECCIÓN 4: WORKTREES & AISLAMIENTO DE AGENTES -->
          <details class="git-guide-accordion">
            <summary>
              <div class="accordion-title">
                <span>🌳</span>
                <span>4. Gestión de Worktrees (Aislamiento de Agentes)</span>
              </div>
              <span class="accordion-chevron">▼</span>
            </summary>
            <div class="git-guide-content">
              <div class="git-cmd-box" onclick="copyToClipboard('git worktree list', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">1. Listar worktrees activos</span>
                  <code class="git-cmd-code">git worktree list</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git worktree add .claude/worktrees/task-1 -b task/" + proj.name + "-1")}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">2. Crear worktree aislado para tarea</span>
                  <code class="git-cmd-code">git worktree add .claude/worktrees/task-1 -b task/${esc(proj.name)}-1</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard('git worktree remove .claude/worktrees/task-1 && git worktree prune', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">3. Eliminar worktree y podar referencias</span>
                  <code class="git-cmd-code">git worktree remove .claude/worktrees/task-1 && git worktree prune</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>
            </div>
          </details>

          <!-- SECCIÓN 5: CUENTAS SSH MULTI-USUARIO -->
          <details class="git-guide-accordion">
            <summary>
              <div class="accordion-title">
                <span>🔑</span>
                <span>5. Diagnóstico de Cuentas SSH / GitHub en la Máquina</span>
              </div>
              <span class="accordion-chevron">▼</span>
            </summary>
            <div class="git-guide-content">
              <div class="git-cmd-box" onclick="copyToClipboard('ssh -T git@github.com', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">1. Comprobar qué cuenta responde en GitHub</span>
                  <code class="git-cmd-code">ssh -T git@github.com</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard(${jsq("git clone git@github-work:" + proj.name + ".git")}, 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">2. Clonar usando alias SSH personal (~/.ssh/config)</span>
                  <code class="git-cmd-code">git clone git@github-work:${esc(proj.name)}.git</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>
            </div>
          </details>

          <!-- SECCIÓN 6: HOOKS & GATES -->
          <details class="git-guide-accordion">
            <summary>
              <div class="accordion-title">
                <span>🛠️</span>
                <span>6. Resolución de Bloqueos en Commits (Linters &amp; Gate)</span>
              </div>
              <span class="accordion-chevron">▼</span>
            </summary>
            <div class="git-guide-content">
              <div class="git-cmd-box" onclick="copyToClipboard('ruff check --fix .', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">1. Autocorregir formato y linting con ruff</span>
                  <code class="git-cmd-code">ruff check --fix .</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard('pre-commit run --all-files', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">2. Probar hooks de pre-commit manualmente sin commit</span>
                  <code class="git-cmd-code">pre-commit run --all-files</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>

              <div class="git-cmd-box" onclick="copyToClipboard('tools/gate.sh', 'Comando copiado', event)">
                <div class="git-cmd-left">
                  <span class="git-cmd-label">3. Ejecutar gate de integridad de Aevifex</span>
                  <code class="git-cmd-code">tools/gate.sh</code>
                </div>
                <span class="git-cmd-copy-hint">Copiar 📋</span>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  `;
}


// ⛔ Esto era un mapa de palabra-clave a icono, y entre sus palabras había términos que
// sólo pueden venir de mirar los nombres reales de los proyectos de una instancia. Eso es
// exactamente lo que `interface:AX-1` prohíbe: el motor es público y genérico, y no puede
// saber nada de la centralita de nadie. Además adivinaba mal la mayoría de las veces.
//
// ⚠️ Y el gate no lo habría visto: sólo mira nombres que estén en la denylist de la
// instancia, y una palabra que la propia interfaz inventa no está en ninguna lista.
//
// Un proyecto puede DECLARAR su icono en su `state.md`. Si no lo declara, lleva el neutro.
function getProjectIcon(nameOrState) {
  const declared = nameOrState && typeof nameOrState === "object" ? nameOrState.icon : null;
  return declared || "📦";
}

// ── TAB 7: GUÍA DE USO & README VISUAL ──
function renderProjectGuideTab(proj) {
  // Available documents for this project
  const docsList = [];

  // 1. Primary README or guide
  if (proj.readmeContent && proj.readmeContent.trim().length > 0) {
    let label = "📖 README.md";
    if (proj.readmeType === "guide") label = "📖 Guía de Uso";
    else if (proj.readmeType === "how-to-use") label = "📖 HOW-TO-USE.md";
    // ⚠️ No es una guía: es lo que se enseña a falta de una. Una definición dice QUÉ ES
    // esto; una guía dice CÓMO SE USA. Servir la primera con la etiqueta de la segunda es
    // el mismo defecto que enseñar el README de otro, una capa más abajo.
    else if (proj.readmeType === "definition") label = "📋 Sin guía — se muestra la definición";

    docsList.push({
      id: "primary",
      label: label,
      path: proj.readmePath ? proj.readmePath.split("/").slice(-2).join("/") : "README.md",
      content: proj.readmeContent,
      type: proj.readmeType || "readme"
    });
  }

  // 2. Definition doc (if different from primary)
  if (proj.definitionContent && proj.definitionContent.trim().length > 0 && proj.readmeType !== "definition") {
    docsList.push({
      id: "definition",
      label: "📋 Especificación (definition.md)",
      path: "nexus/definition.md",
      content: proj.definitionContent,
      type: "definition"
    });
  }

  // 3. Architecture doc
  if (proj.architectureContent && proj.architectureContent.trim().length > 0) {
    docsList.push({
      id: "architecture",
      label: "🏛️ Arquitectura (architecture.md)",
      path: "nexus/architecture.md",
      content: proj.architectureContent,
      type: "architecture"
    });
  }

  // 4. Extra guides (e.g. audit_usage, shortcuts)
  if (proj.extraGuides && typeof proj.extraGuides === "object") {
    for (const [gKey, gContent] of Object.entries(proj.extraGuides)) {
      docsList.push({
        id: "guide_" + gKey,
        label: "🛠️ " + gKey.replace(/_/g, " ").toUpperCase(),
        path: "nexus/Guides/" + gKey + ".md",
        content: gContent,
        type: "guide"
      });
    }
  }

  // Default fallback if no docs exist
  if (docsList.length === 0) {
    docsList.push({
      id: "primary",
      label: "📄 Todavía no hay guía",
      // ⚠️ Decía `state.md`, que `M-135` retiró en favor de `plan.md`. Ahora no nombra
      // ningún fichero, porque en este caso no se está leyendo ninguno.
      path: "—",
      content: proj.definition
        || "**Todavía no hay guía de uso para este proyecto.**\n\nEl Hub busca, por este "
         + "orden, `guide.md`, `usage.md` y `README.md` **dentro del proyecto**, y no sale de "
         + "él: hasta 2026-09-06 subía a la carpeta de grupo y acababa sirviendo el README "
         + "del centro como guía de seis proyectos distintos.",
      type: "empty"
    });
  }

  // Current active doc
  STATE.guideActiveDoc = STATE.guideActiveDoc || {};
  const activeDocId = STATE.guideActiveDoc[proj.name] || docsList[0].id;
  const currentDoc = docsList.find(d => d.id === activeDocId) || docsList[0];

  // Quickstart commands
  const quickInstallCmd = proj.quickInstall || `cd ${esc(proj.codeRepo || '~/Documents/' + proj.name)} && npm install`;
  const quickRunCmd = proj.quickRun || `cd ${esc(proj.codeRepo || '~/Documents/' + proj.name)} && npm run dev`;
  const quickTestCmd = proj.quickTest || `cd ${esc(proj.codeRepo || '~/Documents/' + proj.name)} && npm test`;

  return `
    <div class="doc-section">
      <div class="section-head" style="cursor: default;">
        <h2><span class="num">07</span> Guía de Uso, Quickstart &amp; Documentación Visual</h2>
        <span class="tag-pill tag-live">📖 Visual README</span>
      </div>
      <p class="lead">
        Documentación técnica interactiva, especificaciones de arquitectura, quickstarts de instalación y manuales operativos renderizados visualmente en tiempo real.
      </p>

      <!-- HERO BANNER -->
      <div class="proj-guide-hero">
        <div class="guide-hero-top">
          <div class="guide-hero-title-group">
            <div class="guide-hero-icon">${getProjectIcon(proj)}</div>
            <div>
              <h3 class="guide-hero-title">${esc(proj.name)}</h3>
              <div style="font-size: 12px; color: var(--gold, #d8b26a); font-family: var(--font-mono); margin-top: 2px;">
                ${esc(currentDoc.path)}
              </div>
            </div>
          </div>
          <div class="guide-hero-badges">
            <span class="card-badge badge-vine">${esc(proj.techStack || 'Aevifex Pipeline')}</span>
            <span class="tag-pill tag-purple">${esc(proj.currentPhase || 'Producción')}</span>
          </div>
        </div>

        <p class="guide-hero-desc">
          ${inline(proj.definition || 'Módulo y solución soberana de software diseñada bajo los principios y arquitectura de Aevifex.')}
        </p>
      </div>

      <!-- QUICKSTART 3-STEP SEQUENCE -->
      <div class="quickstart-steps-container">
        <div class="quickstart-step-card">
          <div class="step-card-header">
            <span class="step-num-badge">1</span>
            <h4 class="step-card-title">Instalación / Entorno</h4>
          </div>
          <p style="font-size: 12px; color: var(--ink-soft); margin: 0;">Preparar dependencias y entorno de ejecución local.</p>
          <div class="repo-path-box" onclick="copyToClipboard(${jsq(quickInstallCmd)}, 'Comando copiado', event)" style="cursor: pointer;" title="Clic para copiar">
            <code>${esc(quickInstallCmd)}</code>
          </div>
        </div>

        <div class="quickstart-step-card">
          <div class="step-card-header">
            <span class="step-num-badge">2</span>
            <h4 class="step-card-title">Ejecución / Dev Server</h4>
          </div>
          <p style="font-size: 12px; color: var(--ink-soft); margin: 0;">Lanzar el servicio, servidor o pipeline en desarrollo.</p>
          <div class="repo-path-box" onclick="copyToClipboard(${jsq(quickRunCmd)}, 'Comando copiado', event)" style="cursor: pointer;" title="Clic para copiar">
            <code>${esc(quickRunCmd)}</code>
          </div>
        </div>

        <div class="quickstart-step-card">
          <div class="step-card-header">
            <span class="step-num-badge">3</span>
            <h4 class="step-card-title">Tests &amp; Verificación</h4>
          </div>
          <p style="font-size: 12px; color: var(--ink-soft); margin: 0;">Comprobar integridad antes de commitear cambios.</p>
          <div class="repo-path-box" onclick="copyToClipboard(${jsq(quickTestCmd)}, 'Comando copiado', event)" style="cursor: pointer;" title="Clic para copiar">
            <code>${esc(quickTestCmd)}</code>
          </div>
        </div>
      </div>

      <!-- DOCUMENT SWITCHER (IF MULTIPLE DOCS EXIST) -->
      ${docsList.length > 1 ? `
        <div class="guide-doc-switcher">
          <span style="font-size: 12px; font-weight: 800; color: var(--ink-muted); margin-right: 6px; text-transform: uppercase;">Explorar Documentos:</span>
          ${docsList.map(d => `
            <button class="guide-doc-pill ${d.id === currentDoc.id ? 'active' : ''}" onclick="setGuideActiveDoc(${jsq(proj.name)}, ${jsq(d.id)})">
              <span>${esc(d.label)}</span>
              <span class="guide-doc-badge">${esc(d.path.split('/').pop())}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}

      <!-- VISUAL README / DOCUMENTATION BODY -->
      <div class="readme-rendered-card">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
          <h3 style="margin: 0; font-size: 15px; display: flex; align-items: center; gap: 8px;">
            <span>📄</span> <span>${esc(currentDoc.label)}</span>
          </h3>
          <button class="btn-repo-action" onclick="copyToClipboard(decodeURIComponent(${jsq(encodeURIComponent(currentDoc.content))}), 'Documento completo copiado', event)">
            <span>📋 Copiar Markdown Completo</span>
          </button>
        </div>

        <div class="readme-markdown-body">
          ${renderMarkdownBody(currentDoc.content)}
        </div>
      </div>
    </div>
  `;
}

window.setGuideActiveDoc = function(projName, docId) {
  STATE.guideActiveDoc = STATE.guideActiveDoc || {};
  STATE.guideActiveDoc[projName] = docId;
  renderView();
};

// Enhanced Markdown parser helper for README and Guide body
function renderMarkdownBody(text) {
  if (!text) return "<p>Sin contenido.</p>";

  const lines = text.split("\n");
  let html = "";
  let inCode = false;
  let codeBuffer = [];
  let codeLang = "";
  let inTable = false;
  let tableBuffer = [];
  let inList = false;
  let listType = "ul";
  let inBlockquote = false;
  let blockquoteBuffer = [];
  // ⛔ A paragraph is a RUN of non-blank lines, not one paragraph per line. Emitting a
  // `<p>` per source line turned every hard-wrapped paragraph into a stack of blocks with
  // gaps between them — which is what every mailbox entry looked like, because a mailbox
  // entry is prose wrapped at 100 columns like the rest of these files.
  let paraBuffer = [];
  function flushPara() {
    if (!paraBuffer.length) return;
    html += `<p>${inline(paraBuffer.join(" "))}</p>`;
    paraBuffer = [];
  }

  function flushBlockquote() {
    if (!inBlockquote) return;
    const bText = blockquoteBuffer.join(" ").trim();
    blockquoteBuffer = [];
    inBlockquote = false;

    // Detect Callout type
    if (bText.startsWith("⚠️") || bText.toLowerCase().startsWith("[!warning]")) {
      const cleanText = bText.replace(/^⚠️\s*|^\[!warning\]\s*/i, "");
      html += `<div class="callout callout-warning"><span class="callout-icon">⚠️</span><div class="callout-content">${inline(cleanText)}</div></div>`;
    } else if (bText.startsWith("🚀") || bText.toLowerCase().startsWith("[!tip]") || bText.startsWith("🎯")) {
      const cleanText = bText.replace(/^[🚀🎯]\s*|^\[!tip\]\s*/i, "");
      html += `<div class="callout callout-tip"><span class="callout-icon">🚀</span><div class="callout-content">${inline(cleanText)}</div></div>`;
    } else if (bText.startsWith("🧊") || bText.toLowerCase().startsWith("[!note]")) {
      const cleanText = bText.replace(/^🧊\s*|^\[!note\]\s*/i, "");
      html += `<div class="callout callout-note"><span class="callout-icon">🧊</span><div class="callout-content">${inline(cleanText)}</div></div>`;
    } else if (bText.startsWith("🚫") || bText.startsWith("⚫") || bText.toLowerCase().startsWith("[!caution]")) {
      const cleanText = bText.replace(/^[🚫⚫]\s*|^\[!caution\]\s*/i, "");
      html += `<div class="callout callout-danger"><span class="callout-icon">🚫</span><div class="callout-content">${inline(cleanText)}</div></div>`;
    } else {
      html += `<blockquote>${inline(bText)}</blockquote>`;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Anything that is not plain prose ends the paragraph that was accumulating. ⚠️ The
    // test lists what STARTS a block, so a construct added below without being added here
    // would swallow its own opening line into the previous paragraph.
    const isPlainText = trimmed.length > 0 && !inCode
      && !trimmed.startsWith("```") && !trimmed.startsWith("|") && !trimmed.startsWith("#")
      && !trimmed.startsWith(">") && !trimmed.startsWith("- ") && !trimmed.startsWith("* ")
      && !trimmed.startsWith("---") && !/^\d+\.\s+/.test(trimmed);
    if (!isPlainText) flushPara();

    // Code blocks (```lang ... ```)
    if (trimmed.startsWith("```")) {
      flushBlockquote();
      if (inCode) {
        const fullCode = codeBuffer.join("\n");
        html += `
          <div class="code-block-container">
            <div class="code-block-header">
              <span>${esc(codeLang || 'snippet')}</span>
              <button class="btn-code-copy" onclick="copyToClipboard(decodeURIComponent(${jsq(encodeURIComponent(fullCode))}), 'Código copiado', event)">Copiar</button>
            </div>
            <pre><code>${esc(fullCode)}</code></pre>
          </div>
        `;
        codeBuffer = [];
        codeLang = "";
        inCode = false;
      } else {
        if (inList) { html += `</${listType}>`; inList = false; }
        inCode = true;
        codeLang = trimmed.slice(3).trim();
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    // Blockquotes & Callouts
    if (trimmed.startsWith(">")) {
      if (inList) { html += `</${listType}>`; inList = false; }
      if (inTable) { html += renderMarkdownTable(tableBuffer); tableBuffer = []; inTable = false; }
      inBlockquote = true;
      blockquoteBuffer.push(trimmed.slice(1).trim());
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // Markdown Tables
    // ⛔ Aquí también exigía `endsWith("|")`, y era peor que en el renderizador: una fila sin
    // pipe de cierre no se perdía sola — **caía al `else if (inTable)` y cerraba la tabla**,
    // así que se llevaba consigo todas las filas siguientes. Medido: de una tabla de cuatro
    // filas con una sin cerrar en la segunda, se pintaban dos.
    if (trimmed.startsWith("|")) {
      if (!inTable) {
        if (inList) { html += `</${listType}>`; inList = false; }
        inTable = true;
        tableBuffer = [];
      }
      tableBuffer.push(trimmed);
      continue;
    } else if (inTable) {
      html += renderMarkdownTable(tableBuffer);
      tableBuffer = [];
      inTable = false;
    }

    // Checklist items: - [x] or - [ ]
    const chkMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (chkMatch) {
      if (!inList || listType !== "ul") {
        if (inList) html += `</${listType}>`;
        html += '<ul class="readme-checklist">';
        inList = true;
        listType = "ul";
      }
      const isDone = chkMatch[1].toLowerCase() === "x";
      const chkText = chkMatch[2];
      html += `
        <li class="checklist-item ${isDone ? 'done' : 'pending'}">
          <span class="chk-icon">${isDone ? '✅' : '⬜'}</span>
          <span>${inline(chkText)}</span>
        </li>
      `;
      continue;
    }

    // Headings
    if (line.startsWith("# ")) {
      if (inList) { html += `</${listType}>`; inList = false; }
      html += `<h2>${inline(line.slice(2))}</h2>`;
    } else if (line.startsWith("## ")) {
      if (inList) { html += `</${listType}>`; inList = false; }
      html += `<h3>${inline(line.slice(3))}</h3>`;
    } else if (line.startsWith("### ")) {
      if (inList) { html += `</${listType}>`; inList = false; }
      html += `<h4>${inline(line.slice(4))}</h4>`;
    } else if (line.startsWith("#### ")) {
      if (inList) { html += `</${listType}>`; inList = false; }
      html += `<h5>${inline(line.slice(5))}</h5>`;
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (!inList || listType !== "ul") {
        if (inList) html += `</${listType}>`;
        html += "<ul>";
        inList = true;
        listType = "ul";
      }
      html += `<li>${inline(trimmed.slice(2))}</li>`;
    } else if (trimmed.match(/^\d+\.\s+(.+)$/)) {
      const m = trimmed.match(/^\d+\.\s+(.+)$/);
      if (!inList || listType !== "ol") {
        if (inList) html += `</${listType}>`;
        html += "<ol>";
        inList = true;
        listType = "ol";
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if (trimmed.length === 0) {
      if (inList) { html += `</${listType}>`; inList = false; }
    } else if (trimmed.startsWith("---")) {
      if (inList) { html += `</${listType}>`; inList = false; }
      html += '<hr style="border: 0; border-top: 1px solid var(--line); margin: 20px 0;">';
    } else {
      if (inList) { html += `</${listType}>`; inList = false; }
      paraBuffer.push(trimmed);
    }
  }

  flushPara();
  flushBlockquote();
  if (inCode) html += `<pre><code>${esc(codeBuffer.join("\n"))}</code></pre>`;
  if (inTable) html += renderMarkdownTable(tableBuffer);
  if (inList) html += `</${listType}>`;

  return html;
}

function renderMarkdownTable(lines) {
  if (!lines || lines.length < 2) return "";

  let html = '<div style="overflow-x: auto; margin: 16px 0 20px;"><table class="doc-table">';
  let hasHeader = false;

  // ⛔ Antes exigía que la fila empezara Y acabara con `|`, y descartaba en silencio la que
  // no. Una tabla a la que se le olvida el pipe de cierre — que es la que se escribe a mano
  // y la que más se edita — perdía filas sin decirlo, y una tabla con una fila menos se lee
  // como una tabla completa. **Basta con que empiece**; el cierre es opcional.
  let width = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row.startsWith("|")) continue;
    if (row.includes("---") && row.replace(/[|\s-:]/g, "").length === 0) {
      hasHeader = true;
      continue;
    }

    // `slice(1)` quita el hueco vacío de antes del primer `|`; el de después del último
    // sólo existe si la fila cierra, y por eso se quita mirando en vez de contando.
    const parts = row.split("|").slice(1);
    if (row.endsWith("|")) parts.pop();
    const cells = parts.map(c => c.trim());
    // ⚠️ Una fila corta se rellena en vez de descuadrar la tabla, y una larga no se recorta:
    // perder un campo es el mismo defecto que perder una fila, un nivel más abajo.
    if (!width) width = cells.length;
    while (cells.length < width) cells.push("");
    if (i === 0 || !hasHeader) {
      html += "<thead><tr>";
      cells.forEach(c => { html += `<th>${inline(c)}</th>`; });
      html += "</tr></thead><tbody>";
      hasHeader = true;
    } else {
      html += "<tr>";
      cells.forEach(c => { html += `<td>${inline(c)}</td>`; });
      html += "</tr>";
    }
  }

  html += "</tbody></table></div>";
  return html;
}

function initAppListeners() {
  // This reader restores a scroll container after lazy document loading.
  // Browser history restoration races that render and overwrites its position.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  const reader = document.getElementById("mainContent");
  reader?.addEventListener("scroll", () => rememberProjectReading(reader), { passive: true });
  reader?.addEventListener("toggle", () => rememberProjectReading(reader), true);

  ["taskTitle", "taskProject", "taskStatus", "taskWhy"].forEach(id => {
  });

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view");
      if (view) navigateTo(view);
    });
  });

  document.getElementById("projectFilter")?.addEventListener("change", e => {
    const val = e.target.value;
    if (STATE.currentView === "inbox") {
      location.hash = Mailbox.route({...mailboxLocation(), id:'', project:val === 'ALL' ? '' : val});
      return;
    }
    if (val === "ALL") {
      STATE.taskFilterProj = "";
    } else {
      STATE.taskFilterProj = val;
      STATE.selectedProject = val;
    }
    renderView();
  });

  document.getElementById("globalSearch")?.addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    STATE.taskSearch = q;
    renderView();
  });

  // ⛔ Al teclear se filtra lo que ya está en memoria; **al pulsar Enter se busca en el
  // disco**. Son dos cosas distintas y se separan a propósito: buscar en 326 ficheros en
  // cada pulsación sería una petición por tecla, y filtrar la vista actual es lo que se
  // quiere el 90 % de las veces. ⚠️ Es la función concreta por la que se abre Obsidian, así
  // que va donde ya estaba la mano del operador en vez de en un sitio nuevo.
  document.getElementById("globalSearch")?.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim();
    if (q.length < 2) return;
    location.hash = Library.route({q, all:true});
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAppListeners);
} else {
  initAppListeners();
}

async function loadModel(background = false) {
  // ⛔ Fetch y render se atrapan POR SEPARADO. Juntos, un `ReferenceError` dentro de una
  // vista salía por pantalla como «No se pudo conectar con el servidor» — y con eso el
  // fallo real (`SKILL_ICONS is not defined`) mandaba a mirar la red, el adaptador y el
  // puerto, que estaban perfectos. Un diagnóstico que apunta al sitio equivocado cuesta
  // más que no dar ninguno.
  let modelData;
  try {
    const res = await fetch("/api/model" + (MODEL?.revision ? `?since=${encodeURIComponent(MODEL.revision)}` : ""));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    modelData = await res.json();
  } catch (err) {
    if (background && STATE.loaded) throw err;
    STATE.error = `No se pudo conectar con el servidor: ${err.message}`;
    STATE.errorKind = "red";
    renderView();
    return;
  }
  try {
    STATE.error = null;
    STATE.errorKind = null;
    const result = LiveModel.apply(MODEL, modelData);
    ingestModel(result.model, MODEL ? result.changed : null);
    MODEL = result.model;
    if (!background) { restoreRouteFromUrl(); renderView(); }
  } catch (err) {
    if (background && STATE.loaded) { MODEL = null; throw err; }
    STATE.error = err.message;
    STATE.errorKind = "vista";
    STATE.errorWhere = STATE.currentView;
    STATE.errorStack = String(err.stack || "").split("\n").slice(0, 4).join("\n");
    renderView();
    return;
  }
  // ⚠️ La doctrina se carga una vez: son ficheros del propio motor, no estado vivo, y
  // volver a pedirlos en cada latido gastaría una petición por segundo para nada.
  if (STATE.doctrine === undefined) loadDoctrine();
  if (STATE.metrics === undefined) loadMetrics();
  if (STATE.tree === undefined && !background) await loadTree();
  loadRecent();
  return true;
}

function referenceLinks(context, title='Guías y referencias') {
  const links=References.links(STATE.tree?.references,context);
  return links.length ? `<details class="context-references"><summary>${esc(title)}</summary><nav aria-label="${esc(title)}">${links.map(item=>`<a href="${esc(item.href)}">${esc(item.label)}</a>`).join('')}</nav></details>` : '';
}

// Helper to find persistent plan associated with a compass front
function findPlanForFront(front) {
  if (!front || !STATE.plans || !STATE.plans.length) return null;
  const fName = (front.name || "").toLowerCase();
  const fDesc = (front.described_in || "").toLowerCase();
  const fMoves = (front.moves_when || "").toLowerCase();
  const fWaits = (front.waits_on || "").toLowerCase();
  const fText = `${fName} ${fDesc} ${fMoves} ${fWaits}`.toLowerCase();

  // 1. Exact plan ID in text (e.g. nexus-p2 in moves_when)
  for (const p of STATE.plans) {
    const pId = (p.id || "").toLowerCase();
    if (pId && (fMoves.includes(pId) || fDesc.includes(pId) || fName.includes(pId) || fWaits.includes(pId))) {
      return p;
    }
  }

  // 2. Exact sub-block (e.g. X1.7 or X7.2)
  for (const p of STATE.plans) {
    const pSub = (p.sub_block || "").toLowerCase();
    if (pSub && pSub.length >= 2 && new RegExp(`\\b${pSub}\\b`, "i").test(fText)) {
      return p;
    }
  }

  // 3. Exact board block in described_in (e.g. board X1)
  for (const p of STATE.plans) {
    const pBlock = (p.block || "").toLowerCase();
    if (pBlock && pBlock.length >= 2 && new RegExp(`\\bboard\\s+${pBlock}\\b`, "i").test(fDesc)) {
      return p;
    }
  }

  // 4. Title phrase match
  for (const p of STATE.plans) {
    const pTitle = (p.title || "").toLowerCase().split(" - ")[0].split(" — ")[0].trim();
    if (pTitle.length >= 5 && fName.includes(pTitle)) {
      return p;
    }
  }

  return null;
}

// ⛔ Aquí vivía `renderCockpit`, 335 líneas que ya no llamaba nadie desde que `cockpit`
// enruta a `renderOffice`. Se va entera: una copia muerta del render vivo es la que sigue
// contestando cuando alguien la resucita sin mirar, y mientras tanto la mantiene nadie.
// `findPlanForFront` NO se va — la usa `planForCard`, que es lo que devolvió al Despacho
// la capacidad de enseñar la hoja de una tarea en pausa.


// El aviso de fuente caducada. ⛔ Va EN el panel, nunca en un tooltip: un aviso que hay que
// buscar no avisa. El adapter marca una fuente `stale` — una vista generada cuyo generador
// no existe, por ejemplo — y hasta 2026-09-06 ese flag no salía del JSON, así que estos
// paneles se pintaban como si estuvieran vivos. **Un panel caducado que no dice que lo está
// es cómo se deja de confiar en la pantalla entera** (`interface:I3.8`).
// ⚠️ Cuenta las entidades marcadas, no las fuentes: si sólo una parte de lo que se ve viene
// de la fuente caducada, el aviso lo dice en vez de teñirlo todo.
function staleBanner(entities, queSon) {
  const n = (entities || []).filter(e => e && e.stale).length;
  if (!n) return "";
  const total = (entities || []).length;
  const fuentes = [...new Set((entities || []).filter(e => e.stale).map(e => e.source))];
  return `
    <div class="stale-banner" role="status">
      <span class="stale-mark">⛔</span>
      <div class="stale-body">
        <strong>${n} de ${total} ${esc(queSon)} vienen de una fuente que el adaptador
          declara caducada.</strong>
        <span>Lo que ves aquí puede no ser lo que hay en disco. El adaptador lo dice así:</span>
        <ul>${fuentes.map(f => `<li><code>${esc(f)}</code></li>`).join("")}</ul>
      </div>
    </div>`;
}

// ⛔ `renderDecisions` vivía aquí y se retira 2026-09-06 (`interface:I14.2`). Una decisión
// pertenece a su proyecto y se lee dentro de él: la pantalla de proyecto ya tiene su pestaña
// de decisiones, filtrada y con vivas contra totales, así que la vista suelta era una segunda
// respuesta a la misma pregunta sin ganador declarado (`Aevifex:AX-20`).
// ⚠️ La ruta `#/decisions` NO se borra: redirige al hub. Un marcador que el operador tiene en
// la cabeza no deja de existir porque la vista sí.

function notebookLocation() { return STATE.notebookLocation || {folder:'',path:'',q:'',anchor:'',line:0}; }
function notebookLink(text, loc, className = '') { return `<a class="${className}" href="${esc(Notebook.route(loc))}">${esc(text)}</a>`; }
window.notebookSearch = function(event) {
  event.preventDefault(); const form=event.currentTarget;
  location.hash=Notebook.route({folder:form.elements.folder.value,q:form.elements.query.value.trim()});
};
let notebookSearchRequest=0;
async function loadNotebookSearch(q, key, root) {
  const request=++notebookSearchRequest;
  STATE.notebookSearch={key,loading:true}; renderView();
  try {
    const result=await api('GET',`/api/search?documents=1&root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`);
    if(request!==notebookSearchRequest) return;
    STATE.notebookSearch={key,...(result.available?result:{error:result.why})};
  } catch(e) { if(request!==notebookSearchRequest) return; STATE.notebookSearch={key,error:e.message}; }
  renderView();
}
function renderNotebook(container) {
  const tree=STATE.tree, config=tree?.notebook;
  if(!tree) {container.innerHTML='<p role="status">Abriendo Notebook…</p>';return;}
  if(!tree.available || !config?.available) {container.innerHTML=`<h1>Notebook</h1><p role="status">${esc(tree.why || config?.why || 'Notebook no tiene una fuente configurada.')}</p><button onclick="loadTree()">Reintentar</button>`;return;}
  const files=Notebook.files(tree), groups=Notebook.groups(files,config,STATE.projects);
  const loc=notebookLocation();
  if(STATE.notebookLegacyProject) {
    const matches=groups.filter(g=>g.project?.name===STATE.notebookLegacyProject);
    if(matches.length===1) loc.folder=matches[0].path;
    STATE.notebookLegacyProject='';
  }
  const searchKey=JSON.stringify([config.root,loc.q,files.map(f=>[f.path,f.version])]);
  if(loc.q.length>=2 && STATE.notebookSearch?.key!==searchKey) {
    STATE.notebookSearch={key:searchKey,loading:true};
    setTimeout(()=>loadNotebookSearch(loc.q,searchKey,config.root),0);
  }
  const results=loc.q ? STATE.notebookSearch : null;
  const note=loc.path ? STATE.notes?.[Library.key({root:config.root,path:loc.path})] : null;
  const signature=JSON.stringify([loc,config,files.map(f=>[f.path,f.aliases]),note?.version,note?.stale,note?.error,note?.body===undefined?note?.loading:false,results]);
  if(container.dataset.notebookSignature===signature && container.querySelector('.notebook-browser')) return;
  container.dataset.notebookSignature=signature;
  const oldInput=container.dataset.route===Notebook.route({...loc,anchor:''}) && container.querySelector('#notebook-query');
  const draft=oldInput?{value:oldInput.value,focused:document.activeElement===oldInput,start:oldInput.selectionStart,end:oldInput.selectionEnd}:null;
  const header=`<header class="library-header"><div><h1>Notebook</h1><p>Notas e ideas por proyecto · ${files.length} documentos</p></div>${files.some(f=>f.path===config.guide)?notebookLink('Cómo se organiza',{path:config.guide},'quiet-back'):''}</header>
    <form class="notebook-search" role="search" aria-label="Buscar en Notebook" onsubmit="notebookSearch(event)"><label for="notebook-folder">Dónde buscar<select id="notebook-folder" name="folder" onchange="this.form.requestSubmit()"><option value="">Todo Notebook</option>${groups.map(g=>`<option value="${esc(g.path)}" ${g.path===loc.folder?'selected':''}>${esc(g.label)}${g.context?' · '+esc(g.context):''}</option>`).join('')}</select></label><label for="notebook-query">Texto o identificador<input type="search" id="notebook-query" name="query" value="${esc(loc.q)}" placeholder="Una idea, un tema, N-55…" minlength="2"></label><button type="submit">Buscar</button>${loc.q || loc.folder?notebookLink('Ver todo',{}):''}</form>`;
  let body;
  if(loc.path) {
    const file=files.find(f=>f.path===loc.path);
    if(!file) body=`${notebookLink('← Notebook',{})}<h2>Esta hoja ya no está en Notebook</h2><p>Puede haberse movido. Búscala por su nombre o por el identificador de una nota.</p>`;
    else {
      const group=groups.find(g=>g.path===Notebook.folder(file));
      const back=notebookLink(loc.q?'← Volver a los resultados':loc.folder?'← Volver al grupo':'← Notebook',{...loc,path:'',anchor:'',line:0},'quiet-back');
      const project=group?.project && STATE.projects.filter(p=>p.name===group.project.name).length===1 ? group.project : null;
      const top=`<div class="notebook-reader-bar">${back}<span>${esc(group?.label || 'Guía')} / ${esc(Notebook.label(file,config))}</span>${project?`<nav aria-label="Proyecto de la hoja"><a href="${esc(projectRoute(project.name,'objectives'))}">Objetivos</a><a href="${esc(projectRoute(project.name,'plan'))}">Plan del proyecto</a></nav>`:''}</div>`;
      body=renderNote({note:{root:config.root,path:loc.path},location:loc,link:notebookLink,top,cache:'renderedNotebook',navigation:{sourceLines:true,noteRoute:target=>target.root===config.root?Notebook.route({path:target.path,anchor:target.anchor}):Library.route(target)}});
      if(loc.line && loc.q && note?.body!==undefined && !Notebook.matchLine(note.body,loc.q,loc.line)) body='<p role="status">El texto buscado ya no aparece en esta hoja. Se muestra su contenido actual.</p>'+body;
    }
  } else if(loc.q) {
    const matches=Notebook.results(files,config,loc,results?.hits);
    body=`<div class="library-intro"><h2>Resultados para «${esc(loc.q)}»</h2><p>${matches.length} ${matches.length===1?'hoja':'hojas'}${results?.loading?' · buscando en el texto…':''}</p></div>${loc.q.length<2?'<p>Escribe al menos dos caracteres.</p>':''}${results?.error?`<p role="alert">No se ha podido buscar en el texto: ${esc(results.error)}.</p>`:''}${results?.capped?'<p>Hay más coincidencias. Afina el texto para encontrarlas.</p>':''}<div class="library-results">${matches.map(({file,hit})=>`<a href="${esc(Notebook.route({...loc,path:file.path,line:hit?.line||0}))}"><strong>${esc(Notebook.label(file,config))}</strong><small>${esc(file.path)}</small>${hit?`<p>${esc(hit.text)}</p>`:''}</a>`).join('')}</div>${!matches.length && !results?.loading?'<p>No se han encontrado hojas con ese texto.</p>':''}`;
  } else {
    const shown=groups.filter(g=>!loc.folder || g.path===loc.folder);
    body=`<div class="notebook-groups">${shown.map(g=>`<section class="notebook-group" data-live-key="${esc(g.path)}"><header><div>${g.context?`<small>${esc(g.context)}</small>`:''}<h2>${esc(g.label)}</h2></div><span>${g.files.length} ${g.files.length===1?'hoja':'hojas'}</span></header>${g.description?`<p>${esc(g.description)}</p>`:''}<div>${g.files.map(f=>`<a data-live-key="${esc(f.path)}" class="notebook-sheet" href="${esc(Notebook.route({...loc,path:f.path}))}"><strong>${esc(Notebook.label(f,config))}</strong><span aria-hidden="true">↗</span></a>`).join('')}</div></section>`).join('')}</div>${!shown.length?'<p>No hay hojas en este grupo.</p>':''}`;
  }
  paintView(container, `<section class="notebook-browser">${header}${referenceLinks("notebook")}${body}</section>`);
  if(draft) {const input=container.querySelector('#notebook-query');input.value=draft.value;if(draft.focused){input.focus({preventScroll:true});input.setSelectionRange(draft.start,draft.end);}}
  container.querySelectorAll('[data-reference]').forEach(link=>link.onclick=event=>{
    event.preventDefault();const details=container.querySelector('#library-references');if(details){details.open=true;container.querySelector(`#library-reference-${link.dataset.reference}`)?.scrollIntoView({block:'center'});}
  });
  if(loc.path && note?.body!==undefined) enhanceLibraryDiagrams(container);
}
function restoreNotebookTarget(container, saved) {
  const loc=notebookLocation();
  if(!loc.path || container.dataset.readerReady!=='true') return;
  let target;
  if(loc.anchor) target=container.querySelector('#note-heading-'+CSS.escape(Library.slug(loc.anchor))) || container.querySelector('#library-missing-anchor');
  else if(loc.line) {
    const source=STATE.notes?.[Library.key({root:STATE.tree?.notebook?.root,path:loc.path})]?.body || '';
    const line=Notebook.matchLine(source,loc.q,loc.line);
    const lines=[...container.querySelectorAll('[data-source-line]')];
    container.querySelectorAll('.notebook-match').forEach(e=>e.classList.remove('notebook-match'));
    target=lines.filter(e=>Number(e.dataset.sourceLine)<=line && Number(e.dataset.sourceEnd)>=line).at(-1);
    target?.classList.add('notebook-match');
  }
  if(target) {
    const marker=JSON.stringify([loc.path,loc.anchor,loc.line]);
    if(saved?.target!==marker) target.scrollIntoView({block:'center'});
    const route=container.dataset.route;
    PROJECT_READING[route]={...(PROJECT_READING[route]||{details:{}}),target:marker};
  }
}

function mailboxLocation() { return STATE.mailLocation || {view:'pending',project:'',q:'',id:''}; }
function mailboxLink(label, loc, className = '') {
  return `<a class="${className}" href="${esc(Mailbox.route(loc))}">${esc(label)}</a>`;
}
window.mailboxSearch = function(event) {
  event.preventDefault();
  const form = event.currentTarget;
  location.hash = Mailbox.route({...mailboxLocation(), id:'', project:form.elements.project.value, q:form.elements.query.value.trim()});
};
function renderInbox(container) {
  const loc = mailboxLocation(), all = STATE.mailbox || [];
  const catalog = loc.id ? (STATE.tree?.files || []).map(f=>[f.root,f.path,f.aliases]) : null;
  const signature = JSON.stringify([loc,all,STATE.projects.map(p=>p.name),catalog]);
  if (container.dataset.mailboxSignature === signature && container.querySelector('.mailbox-room')) return;
  container.dataset.mailboxSignature = signature;
  const queryInput = container.dataset.route === Mailbox.route(loc) && container.querySelector('#mailbox-query');
  const draft = queryInput ? {value:queryInput.value, focused:document.activeElement === queryInput, start:queryInput.selectionStart, end:queryInput.selectionEnd} : null;
  const pending = all.filter(Mailbox.isPending).length, archive = all.length-pending;
  const shown = Mailbox.filter(all,loc), archiveView = loc.view === 'archive';
  const base = {...loc,id:''};
  let content;
  if (loc.id) {
    const selected = Mailbox.select(all,loc.id);
    content = `${mailboxLink(archiveView ? '← Volver al archivo' : '← Volver a pendientes',base,'quiet-back')}`;
    if (selected.kind !== 'entry') {
      content += `<h1>${selected.kind === 'ambiguous' ? 'Este enlace corresponde a varios asuntos' : 'No se encuentra este asunto'}</h1><p>Vuelve a la lista para consultar las entradas disponibles.</p>`;
    } else {
      const e = selected.entry, index = shown.findIndex(item=>item.id===e.id), state = Mailbox.state(e);
      const request = Mailbox.isPending(e) ? Mailbox.request(e.body) : null;
      const source = request ? `## Qué necesitas decidir\n\n${request.text}\n\n## Contexto y alcance\n\n${request.remainder}` : e.body;
      const files = STATE.tree?.files || [];
      const sourceFiles = files.filter(f=>`${f.root}/${f.path}` === e.file);
      const rendered = Library.render(source, sourceFiles.length === 1 ? sourceFiles[0] : null, files);
      const project = STATE.projects.find(p=>p.name === e.project);
      content += `<article class="mailbox-matter" aria-label="Asunto del buzón">
        <div class="mailbox-meta"><span class="mailbox-state ${Mailbox.isPending(e)?'is-pending':''}">${esc(state.label)}</span><span>${esc(e.project)}</span><span>${esc(e.date || 'Sin fecha')}</span></div>
        <h1>${esc(e.title)}</h1>
        <p class="mailbox-author">De ${esc(e.author)}${e.origin_inferred ? ' (autor inferido)' : ''}</p>
        ${project ? `<nav class="mailbox-project" aria-label="Proyecto del asunto"><span>Consultar ${esc(e.project)}</span><a href="${esc(projectRoute(e.project,'objectives'))}">Objetivos</a><a href="${esc(projectRoute(e.project,'plan'))}">Plan</a><a href="${esc(projectRoute(e.project,'files'))}">Archivos</a></nav>` : ''}
        <div class="mailbox-proposal"><span>Destino propuesto</span><strong>${esc(e.destination || 'Sin especificar')}</strong></div>
        ${!Mailbox.isPending(e) ? '<p class="mailbox-archive-note">Este asunto está cerrado. Su argumento y resolución se conservan debajo.</p>' : ''}
        <div class="note-prose mailbox-prose" aria-label="Contenido del asunto">${rendered.html || '<p>Esta entrada sólo contiene el título.</p>'}</div>
        ${rendered.problems.length ? `<details id="mailbox-references" class="library-references"><summary>Referencias por localizar (${rendered.problems.length})</summary>${rendered.problems.map((p,i)=>`<div id="library-reference-${i}"><strong>${esc(p.target)}</strong><p>${p.kind === 'ambiguous' ? 'Hay varios documentos con este nombre:' : 'No se encuentra en las carpetas navegables.'}</p>${(p.matches || []).map(f=>libraryLink(f.path,{root:f.root,path:f.path,anchor:p.anchor})).join('')}</div>`).join('')}</details>` : ''}
        <details id="mailbox-source" class="library-original"><summary>Fuente y texto original</summary><p><code>${esc(e.file)}${e.line?':'+e.line:''}</code></p><pre><code>${esc(e.body)}</code></pre></details>
      </article>
      <nav class="mailbox-sequence" aria-label="Otros asuntos">${index > 0 ? mailboxLink('← Anterior',{...loc,id:shown[index-1].id}) : '<span></span>'}<span>${index >= 0 ? `${index+1} de ${shown.length}` : 'Fuera del filtro actual'}</span>${index >= 0 && index < shown.length-1 ? mailboxLink('Siguiente →',{...loc,id:shown[index+1].id}) : '<span></span>'}</nav>`;
    }
  } else {
    const projects = [...new Set(all.map(e=>e.project).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    if (loc.project && !projects.includes(loc.project)) projects.push(loc.project);
    content = `<header class="mailbox-heading"><div><h1>Buzón</h1><p>Asuntos que necesitan tu criterio.</p></div><a class="quiet-back" href="#/cockpit">Ir a las tareas →</a></header>
      <nav class="mailbox-tabs" aria-label="Buzón y archivo">${mailboxLink(`Pendientes · ${pending}`,{...base,view:'pending'},!archiveView?'selected':'')}${mailboxLink(`Archivo · ${archive}`,{...base,view:'archive'},archiveView?'selected':'')}</nav>
      <form class="mailbox-search" role="search" aria-label="Buscar asuntos" onsubmit="mailboxSearch(event)"><label for="mailbox-project">Proyecto<select id="mailbox-project" name="project" onchange="this.form.requestSubmit()"><option value="">Todos los proyectos</option>${projects.map(p=>`<option value="${esc(p)}" ${p===loc.project?'selected':''}>${esc(p)}</option>`).join('')}</select></label><label for="mailbox-query">Buscar en ${archiveView?'el archivo':'pendientes'}<input id="mailbox-query" type="search" name="query" placeholder="Título, texto o autor…" value="${esc(loc.q)}"></label><button type="submit">Buscar</button>${loc.q || loc.project ? mailboxLink('Quitar filtros',{view:loc.view}) : ''}</form>
      <div class="mailbox-list-heading"><h2>${archiveView?'Asuntos cerrados':'Por revisar'} <span>${shown.length}</span></h2><span>En el orden de la fuente</span></div>
      ${staleBanner(all, 'entradas')}
      <div class="mailbox-list">${shown.length ? shown.map(e=>`<a class="mailbox-row" data-live-key="${esc(e.id)}" href="${esc(Mailbox.route({...base,id:e.id}))}"><div class="mailbox-meta"><span>${esc(e.project)}</span><span>${esc(e.date || 'Sin fecha')}</span>${e.state !== 'open' ? `<span>${esc(Mailbox.state(e).label)}</span>` : ''}</div><h3>${esc(e.title)}</h3><span class="mailbox-open">Leer asunto <span aria-hidden="true">→</span></span></a>`).join('') : `<div class="mailbox-empty"><h3>${loc.q || loc.project ? 'No hay asuntos con estos filtros' : archiveView ? 'El archivo está vacío' : 'No hay asuntos pendientes'}</h3><p>${loc.q || loc.project ? 'Prueba otro texto o consulta todos los proyectos.' : archiveView ? 'Aquí podrás consultar los asuntos resueltos y archivados.' : 'Puedes volver a la Oficina para continuar con tus tareas.'}</p></div>`}</div>`;
  }
  paintView(container, `<section class="mailbox-room">${content}${referenceLinks('mailbox')}</section>`);
  const restoredInput = container.querySelector('#mailbox-query');
  if (draft && restoredInput) {
    restoredInput.value = draft.value;
    if (draft.focused) { restoredInput.focus({preventScroll:true}); restoredInput.setSelectionRange(draft.start,draft.end); }
  }
  container.querySelectorAll('.note-unresolved').forEach(link=>link.onclick=event=>{
    event.preventDefault();
    const details = container.querySelector('#mailbox-references');
    if (details) { details.open = true; container.querySelector(`#library-reference-${link.dataset.reference}`)?.scrollIntoView({block:'center'}); }
  });
  // Rare diagram entries share the same local reader as documents.
  enhanceLibraryDiagrams(container);
}

// ═════════════════════════════════════════════════════════════════════════════
// EL ÁGORA — las skills, y los roles entre ellas
//
// ⛔ `SKILL_ICONS` se usaba aquí y no estaba definida en ninguna parte. Con la lista vacía
// el `.map` no llega a correr y la vista parece sana; en cuanto la instancia declara sus
// skills, la primera tarjeta lanza un `ReferenceError` y la vista entera desaparece. Por
// eso el icono de una skill se DERIVA de cómo el modelo la alcanza, que es un dato que sí
// existe, en vez de salir de una tabla escrita a mano que hay que mantener en paralelo.
//
// ⚠️ Y `unclear` ya no se convierte en `request`. El parser distingue expresamente lo que
// pudo probar de lo que no — su propio comentario dice que una clasificación segura y
// equivocada es peor que una que admite no saber — y la vista anterior tiraba esa
// distinción, presentando como capacidad invocable cualquier cosa que no supo leer.
// ═════════════════════════════════════════════════════════════════════════════

// Las tres maneras en que un modelo alcanza una skill, según `AGENTS.md` §4, más la
// cuarta que es no haberlo podido determinar.
const STOAS = {
  event: {
    greek: "ΚΑΙΡΟΣ", name: "La ocasión",
    glyph: "◷", tone: "tone-olive",
    rule: "Su descripción nombra <strong>un momento</strong>. El modelo lo reconoce y <strong>lo dice</strong>; el operador la invoca.",
    warn: "Una ocasión nombrada en prosa es una señal para hablar, no un permiso para actuar."
  },
  request: {
    greek: "ΚΛΗΣΙΣ", name: "La llamada",
    glyph: "✋", tone: "tone-aegean",
    rule: "Su descripción nombra <strong>una petición</strong>. El modelo la ofrece cuando lo que se pidió encaja con lo que hace.",
    warn: null
  },
  locked: {
    greek: "ΚΛΕΙΣ", name: "Bajo llave",
    glyph: "🔒", tone: "tone-gold",
    rule: "<code>disable-model-invocation: true</code>. El operador la llama por su nombre y nadie más.",
    warn: "Su descripción sale del contexto entera: es donde se guarda lo que sólo él debe poder alcanzar."
  },
  unclear: {
    greek: "ΑΔΗΛΟΝ", name: "Sin determinar",
    glyph: "?", tone: "tone-ink",
    rule: "El parser <strong>no pudo probar</strong> cómo se alcanza esta skill, y lo dice en vez de adivinarlo.",
    warn: "Cada una de éstas es una descripción que hay que reescribir, no un fallo del lector."
  }
};
const STOA_ORDER = ["event", "request", "locked", "unclear"];

// Los auditores comparten un contrato (`skills/audit/`), y saberlo cambia cómo se leen:
// no son cuatro roles sueltos sino uno con cuatro departamentos.
const IS_AUDITOR = n => /auditor$|^audit$/.test(n);

function renderSkills(container) {
  const q = (STATE.skillSearch || "").toLowerCase().trim();
  const all = (STATE.skills || []).map(s => ({
    ...s,
    stoa: STOAS[s.trigger] ? s.trigger : "unclear",
    auditor: IS_AUDITOR(s.title)
  }));
  const focus = STATE.skillFilterType && STATE.skillFilterType !== "ALL" ? STATE.skillFilterType : null;
  const match = s => !q || [s.title, s.summary, s.when, s.evidence]
    .some(v => (v || "").toLowerCase().includes(q));
  const inStoa = k => all.filter(s => s.stoa === k && match(s));

  if (!all.length) {
    paintView(container, `
      <div class="view-header"><div class="view-title-group">
        <h1><span>🏺</span> El Ágora</h1>
        <p class="view-subtitle">Las skills de la empresa, y los roles entre ellas.</p>
      </div></div>
      <div class="empty-state"><div class="empty-icon">🏺</div>
        <h3>El ágora está vacía</h3>
        <p>Ninguna fuente del adaptador declara <code>kind: "skills"</code>, así que no hay
           descripciones que leer. Es un adaptador sin esa fuente, no una empresa sin skills.</p>
      </div>`);
    return;
  }

  paintView(container, `
    <div class="view-header">
      <div class="view-title-group">
        <h1><span>🏺</span> El Ágora</h1>
        <p class="view-subtitle">
          Las skills de la empresa, agrupadas por <strong>cómo las alcanza el modelo</strong> —
          que es lo que decide su forma, y es independiente de si son roles.
        </p>
      </div>
      <div class="header-stats-bar">
        <span class="spec-pill"><strong>${all.length}</strong> skills</span>
        <span class="spec-pill"><strong>${all.filter(s => s.auditor).length}</strong> auditores</span>
        ${inStoa("unclear").length ? `<span class="spec-pill tone-ink" style="border-color:var(--gold-border);color:var(--gold-deep);background:var(--gold-bg)">
          <strong>${all.filter(s => s.stoa === "unclear").length}</strong> sin determinar</span>` : ""}
      </div>
    </div>

    <!-- LOS DOS EJES, QUE NO SON EL MISMO -->
    <div class="agora-axes">
      <div class="axis-card">
        <span class="axis-greek">ΑΡΧΩΝ</span>
        <strong>Un rol es una skill con un log y un criterio de despido.</strong>
        <span>Eso es todo, y va de rendir cuentas. Su criterio y su vigencia viven en el
          registro de contratación de la centralita, fuera de la vista del propio rol.</span>
      </div>
      <div class="axis-arrow">⇄ independientes</div>
      <div class="axis-card">
        <span class="axis-greek">ΜΟΡΦΗ</span>
        <strong>La forma de una descripción decide otra cosa: cómo la alcanza el modelo.</strong>
        <span>Un rol puede nombrar una petición, y una skill sin log ni criterio puede nombrar
          una ocasión. Confundir los dos ejes es lo que llena la vista de roles inventados.</span>
      </div>
    </div>

    <div class="view-toolbar agora-toolbar">
      <div class="toolbar-group search-group" style="flex:1">
        <input type="text" class="custom-input" placeholder="Buscar por nombre, objetivo, condición o la frase que la clasificó…"
               value="${esc(STATE.skillSearch || "")}" oninput="updateSkillSearch(this.value)">
      </div>
      <div class="toolbar-group">
        <button class="chip-filter ${!focus ? "active" : ""}" onclick="updateSkillFilter('ALL')">todas</button>
        ${STOA_ORDER.filter(k => all.some(s => s.stoa === k)).map(k => `
          <button class="chip-filter ${focus === k ? "active" : ""} ${STOAS[k].tone}"
                  onclick="updateSkillFilter('${k}')">${STOAS[k].glyph} ${STOAS[k].name}</button>`).join("")}
      </div>
    </div>

    ${STOA_ORDER.filter(k => !focus || focus === k).map(k => {
      const list = inStoa(k);
      if (!list.length && (focus !== k)) return "";
      const st = STOAS[k];
      return `
        <section class="stoa ${st.tone}">
          <header class="stoa-head">
            <div class="stoa-columns" aria-hidden="true">
              ${"<span></span>".repeat(7)}
            </div>
            <div class="stoa-plate">
              <span class="stoa-greek">${st.greek}</span>
              <h2>${st.glyph} ${st.name}</h2>
              <span class="stoa-n">${list.length}</span>
            </div>
            <p class="stoa-rule">${st.rule}</p>
            ${st.warn ? `<p class="stoa-warn">⚠️ ${st.warn}</p>` : ""}
          </header>

          <div class="stoa-floor">
            ${list.length ? list.map(sk => `
              <article class="persona ${sk.auditor ? "persona-auditor" : ""}" onclick="openSkill(${jsq(sk.title)})">
                <header class="persona-top">
                  <span class="persona-glyph">${st.glyph}</span>
                  <h3>${esc(sk.title)}</h3>
                  ${sk.auditor ? `<span class="persona-tag" title="Los auditores comparten un contrato en skills/audit/">auditor</span>` : ""}
                </header>
                <p class="persona-sum">${inline(sk.summary || "")}</p>
                ${sk.when ? `<p class="persona-when">${inline(cut(sk.when, 190))}</p>` : ""}
                <footer class="persona-foot">
                  ${sk.evidence
                    ? `<span class="persona-ev" title="La frase de su propia descripción por la que quedó clasificada aquí. Se lee, no se adivina.">
                         “${esc(cutText(sk.evidence, 90))}”</span>`
                    : `<span class="persona-ev persona-ev-none">su descripción no dio ninguna frase que la clasificara</span>`}
                  <span class="persona-go">leer entera →</span>
                </footer>
              </article>`).join("") : `
              <div class="stoa-empty">Ninguna skill llega al modelo por esta vía${q ? " con esa búsqueda" : ""}.</div>`}
          </div>
        </section>`;
    }).join("")}`);
}

// Igual que `cut`, pero devuelve texto plano: va dentro de un atributo y de comillas.
function cutText(t, max) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max).replace(/\s\S*$/, "") + "…";
}

// ═════════════════════════════════════════════════════════════════════════════
// LA MESA DE TRIAJE — sólo en una tarea que declara qué cola drena
//
// ⛔ Aparece únicamente si la tarea escribe `**Drains** mailbox`. Enseñar treinta entradas
// ajenas mientras arreglas un bug es la saturación que esta vista existe para evitar, y una
// tarea que no drena nada no tiene nada que hacer con el buzón.
//
// ⚠️ Verde es `resolved`/`archived` — el estado que el fichero declara, no lo que este
// navegador recuerda haber hecho. Una sesión que se recarga sigue viendo lo mismo, y lo que
// enrutó otro agente también cuenta. La marca de «tocada hoy» viene de git y es un extra:
// si el árbol no es un repo, simplemente no aparece.
// ═════════════════════════════════════════════════════════════════════════════

const MAIL_DONE = ["resolved", "archived"];

// ⛔ La mesa estaba SÓLO detrás de `**Drains**`, y el muro real no escribe ese campo: la
// tarea de triaje dice «it is a drain» en prosa. Resultado — la vista existía y no la veía
// nadie, que es peor que no haberla hecho. Una puerta que los ficheros de verdad no abren
// es una puerta cerrada.
//
// ⚠️ Así que hay DOS vías, y la vista dice por cuál entró. Declarado es exacto; inferido es
// una conjetura sobre el texto, y una conjetura que no se anuncia es la clase de invención
// que este proyecto lleva toda la semana quitando.
function drainReason(card) {
  const declared = String(card.drains || "");
  if (/mailbox|buz[oó]n|notebook|libreta|inbox/i.test(declared)) {
    return { how: "declarado", detail: declared };
  }
  const hay = [card.title, card.serves, card.why, card.affects].filter(Boolean).join(" · ");
  const m = hay.match(/\b(mailbox|buz[oó]n|notebook|libreta|triage|triaje|drain|drena\w*)\b/i);
  if (m) return { how: "inferido", detail: m[0], where: hay };
  return null;
}

function renderTriageBench(card) {
  const why = drainReason(card);
  if (!why) return "";

  const all = STATE.mailbox || [];
  const scoped = all.filter(e =>
    card.project === "cross" || !card.project || e.project === card.project || e.project === "cross");
  const done = scoped.filter(e => MAIL_DONE.includes(e.state));
  const open = scoped.filter(e => !MAIL_DONE.includes(e.state));
  const pct = scoped.length ? Math.round(done.length / scoped.length * 100) : 0;
  const touched = STATE.recentLines || {};

  const entry = (e, resolved) => {
    const isNew = (touched[e.file] || []).some(([a, b]) => e.line >= a && e.line <= b);
    // ⚠️ Sólo sobre lo abierto. A una entrada cerrada no se le pide nada: ya se actuó sobre
    // ella, y marcarle campos que faltan es ruido sobre trabajo terminado — el parser ya
    // hace esa misma distinción, y la vista tenía que hacerla igual.
    const miss = resolved ? [] :
      [["serves", "Serves"], ["what", "What"], ["asks", "Asks"], ["affects", "Affects"]]
        .filter(([k]) => !e[k]).map(([, n]) => n);
    return `
      <article class="tri ${resolved ? "tri-done" : "tri-open"}">
        <header class="tri-top">
          <span class="tri-mark">${resolved ? "✓" : "○"}</span>
          <h4>${inline(e.title)}</h4>
          ${isNew ? `<span class="tri-fresh" title="Su bloque cambió en el trabajo sin commitear o en los commits de hoy — leído de git, no recordado por el navegador.">tocada hoy</span>` : ""}
          <span class="tri-dest" title="Destino propuesto por quien la escribió">→ ${esc(e.destination)}</span>
        </header>

        ${e.serves ? `
          <div class="tri-serves">
            <span class="tri-k">sirve a</span>
            <span class="tri-v">${inline(e.serves)}</span>
          </div>` : ""}

        ${e.what ? `<p class="tri-what">${inline(cut(e.what, 260))}</p>`
                 : e.prose ? `<p class="tri-what tri-prose">${inline(cut(e.prose, 220))}</p>` : ""}

        ${!resolved && e.asks ? `
          <div class="tri-asks">
            <span class="tri-asks-k">te pide decidir</span>
            <span class="tri-asks-v">${inline(e.asks)}</span>
          </div>` : ""}

        <footer class="tri-foot">
          ${e.affects ? `<span class="tri-affects" title="Qué se mueve si se mueve">${inline(cut(e.affects, 90))}</span>` : ""}
          <span class="tri-src"><code>${esc(e.file || "")}${e.line ? `:${e.line}` : ""}</code></span>
          ${miss.length && !resolved ? `
            <span class="tri-gap" title="AX-46 pide los cuatro campos y a ésta le faltan. Nombrados, no contados: se sabe cuáles.">
              faltan ${miss.join(" · ")}
            </span>` : ""}
        </footer>
      </article>`;
  };

  return `
    <section class="bench">
      <header class="bench-head">
        <div class="bench-title">
          <span class="bench-greek">ΔΙΑΛΟΓΗ</span>
          <h3>Mesa de triaje</h3>
          <span class="bench-scope">${esc(card.project || "cross")} · ${scoped.length} entrada${scoped.length === 1 ? "" : "s"}</span>
          ${why.how === "inferido" ? `
            <span class="bench-guess" title="Esta tarea no declara **Drains**. La mesa sale porque su texto nombra «${esc(why.detail)}». Escribe **Drains** mailbox en su bloque del muro y deja de ser una conjetura.">
              ⚠ inferido de «${esc(why.detail)}»
            </span>`
          : `<span class="bench-declared" title="La tarea declara **Drains** ${esc(why.detail)}">
              ✓ declarado
            </span>`}
        </div>
        <div class="bench-meter" role="img" aria-label="${done.length} de ${scoped.length} enrutadas">
          <div class="bench-bar"><div class="bench-fill" style="width:${pct}%"></div></div>
          <span class="bench-n"><strong>${done.length}</strong> de ${scoped.length} enrutadas</span>
        </div>
      </header>

      <div class="bench-cols">
        <div class="bench-col bench-col-open">
          <div class="bench-col-head">
            <span class="bench-dot dot-open"></span>
            <strong>Por resolver</strong>
            <span class="bench-col-n">${open.length}</span>
          </div>
          ${open.length ? open.map(e => entry(e, false)).join("") : `
            <p class="bench-empty">Ninguna. Un buzón que entra lleno y sale lleno significa que la
               sesión no cerró nada — éste no es el caso.</p>`}
        </div>

        <div class="bench-col bench-col-done">
          <div class="bench-col-head">
            <span class="bench-dot dot-done"></span>
            <strong>Resueltas</strong>
            <span class="bench-col-n">${done.length}</span>
          </div>
          ${done.length ? (() => {
            // ⚠️ Con treinta y cinco entradas, la columna de resueltas empuja lo abierto
            // fuera de la pantalla — y lo abierto es lo que se trabaja. Se enseñan las
            // últimas y el resto se despliega: plegar lo hecho es distinto de esconderlo,
            // porque la cuenta sigue a la vista.
            const CAP = 8;
            const shownDone = STATE.benchAll ? done : done.slice(-CAP);
            const hidden = done.length - shownDone.length;
            return shownDone.map(e => entry(e, true)).join("") + (hidden > 0 ? `
              <button class="bench-more" onclick="STATE.benchAll = true; renderView()">
                ver las ${hidden} anteriores
              </button>` : "") + (STATE.benchAll && done.length > CAP ? `
              <button class="bench-more" onclick="STATE.benchAll = false; renderView()">
                plegar
              </button>` : "");
          })() : `
            <p class="bench-empty">Todavía ninguna en este filtro.</p>`}
        </div>
      </div>

      <p class="bench-note">
        El verde sale del <strong>estado que la entrada declara</strong> en <code>MAILBOX.md</code>,
        no de lo que este navegador recuerde: sobrevive a un recargado y cuenta también lo que
        enrutó otro agente. <strong>Nadie vacía la cola que llena</strong> — el destino que trae
        cada entrada es una propuesta, y confirmarla es tuyo.
      </p>
    </section>`;
}

// ── una skill, entera ────────────────────────────────────────────────────────
window.openSkill = async function (name) {
  STATE.skillOpen = { name, loading: true };
  STATE.currentView = "skill";
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
  try {
    const d = await api("GET", `/api/skill?name=${encodeURIComponent(name)}`);
    STATE.skillOpen = { name, ...d, loading: false };
  } catch (e) {
    STATE.skillOpen = { name, error: e.message, loading: false };
  }
  if (STATE.currentView === "skill") renderView();
};

function renderSkillPage(container) {
  const o = STATE.skillOpen || {};
  const meta = (STATE.skills || []).find(s => s.title === o.name);
  const st = STOAS[meta && STOAS[meta.trigger] ? meta.trigger : "unclear"];
  paintView(container, `
    <div class="desk-plate clause-plate ${st.tone}">
      <button class="crumb-link" onclick="navigateTo('skills')">🏺 Ágora</button>
      <span class="crumb-sep">›</span>
      <span class="crumb-here">${esc(o.name || "")}</span>
      ${o.file ? `<span class="clause-file"><code>${esc(o.file)}</code></span>` : ""}
    </div>

    <header class="clause-hero ${st.tone}">
      <div class="clause-hero-mark">
        <span class="clause-greek">${st.greek}</span>
        <span class="clause-id">${st.glyph}</span>
      </div>
      <div class="clause-hero-main">
        <h1>${esc(o.name || "")}</h1>
        ${meta ? `<blockquote class="clause-epigraph">${inline(meta.summary || "")}</blockquote>` : ""}
        <p class="clause-objective-note">
          <strong>${st.name}.</strong> ${st.rule}
          ${meta && meta.evidence
            ? ` Clasificada por esta frase de su propia descripción: <em>“${esc(meta.evidence)}”</em>.`
            : " Ninguna frase de su descripción permitió clasificarla."}
        </p>
      </div>
    </header>

    <div class="clause-grid">
      <section class="doc-reader">
        ${o.loading ? `<div class="loading-state"><div class="spinner"></div><p>Leyendo <code>${esc(o.name)}</code>…</p></div>`
          : o.error ? `<div class="empty-state"><div class="empty-icon">🏺</div>
              <h3>No se pudo leer</h3><p>${esc(o.error)}</p></div>`
          : renderMarkdownBody(o.body || "")}
      </section>
      <aside class="clause-rail">
        ${o.siblings && o.siblings.length ? `
          <div class="rail-panel">
            <div class="rail-head"><strong>Ficheros que la acompañan</strong></div>
            <p class="rail-note" style="margin-top:0">Una skill que trae más que su
               <code>SKILL.md</code> guarda ahí lo que no cabe en una descripción.</p>
            ${o.siblings.map(f => `
              <button class="clause-jump ${st.tone}" onclick="toggleSibling(${jsq(f.name)})">
                <span class="cj-id">📄</span><span class="cj-title">${esc(f.name)}</span>
                <span class="cj-n">${Math.round(f.body.length / 1024)} KB</span>
              </button>
              <div class="sibling-body" id="sib-${esc(f.name.replace(/\W/g, "_"))}" hidden>
                ${renderMarkdownBody(f.body)}
              </div>`).join("")}
          </div>` : ""}
        <div class="rail-panel">
          <div class="rail-head"><strong>Las otras de esta estoa</strong></div>
          ${(STATE.skills || []).filter(s => s.title !== o.name &&
              (STOAS[s.trigger] ? s.trigger : "unclear") === (meta && STOAS[meta.trigger] ? meta.trigger : "unclear"))
            .map(s => `
              <button class="clause-jump ${st.tone}" onclick="openSkill(${jsq(s.title)})">
                <span class="cj-id">${st.glyph}</span><span class="cj-title">${esc(s.title)}</span>
              </button>`).join("") || `<p class="rail-note" style="margin-top:0">Es la única.</p>`}
        </div>
      </aside>
    </div>`);
}

window.toggleSibling = function (name) {
  const el = document.getElementById("sib-" + name.replace(/\W/g, "_"));
  if (el) el.hidden = !el.hidden;
};


function showToast(msg) {
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toastMsg");
  if (toast && toastMsg) {
    toastMsg.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2600);
  }
}


function autoScrollPlanContainer(smooth = true) {
  requestAnimationFrame(() => {
    const container = document.querySelector(".plan-items-container");
    if (!container) return;

    const completedItems = container.querySelectorAll(".plan-item-row.completed");
    if (completedItems.length > 0) {
      const lastCompleted = completedItems[completedItems.length - 1];
      const targetTop = lastCompleted.offsetTop;
      if (smooth) {
        container.scrollTo({
          top: Math.max(0, targetTop - 4),
          behavior: "smooth"
        });
      } else {
        container.scrollTop = Math.max(0, targetTop - 4);
      }
    } else {
      container.scrollTop = 0;
    }
  });
}

function classifySkill(s) {
  const name = s.title.toLowerCase();
  if (name.includes("auditor") || s.trigger === "event") {
    return {
      type: "event",
      label: "🔔 Rol de Evento",
      badgeClass: "tag-live",
      typeDesc: "Disparado automáticamente al cerrar tareas o modificar archivos estructurales"
    };
  }
  if (s.trigger === "locked" || name === "release-cut") {
    return {
      type: "locked",
      label: "🔒 Gobernanza / Release",
      badgeClass: "tag-supersedes",
      typeDesc: "Invocación restringida de gobierno o corte de release público"
    };
  }
  return {
    type: "request",
    label: "🛠️ Capacidad Invocable",
    badgeClass: "tag-purple",
    typeDesc: "Invocada por nombre o comando directo por el operador"
  };
}

// ⚠️ The two project selects were `<!-- populated dynamically -->` and nothing populated
// them, so both modals submitted an empty `project` — the one field `AX-24` and every
// filter in this interface depend on, and the one nothing else can infer.
function fillProjectSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const names = [...new Set([
    ...STATE.projects.map(p => p.name),
    ...STATE.tasks.map(t => t.project),
    ...STATE.fronts.map(f => f.project),
    ...STATE.ideas.map(i => i.project)
  ].filter(Boolean))].sort();
  const keep = sel.value;
  sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")
    + `<option value="cross">cross — vale para varios proyectos</option>`;
  if (keep && names.includes(keep)) sel.value = keep;
  else if (STATE.deskCardId) {
    const c = officeCards().find(c => c.id === STATE.deskCardId);
    if (c && names.includes(c.project)) sel.value = c.project;
  }
}


window.updateSkillFilter = function(type) {
  STATE.skillFilterType = type;
  renderView();
};

window.updateSkillSearch = function(q) {
  STATE.skillSearch = q;
  renderView();
};

window.retryLoad = () => {
  STATE.error = null;
  renderView();
  loadModel();
};

let isPolling = false;

async function watchStamp() {
  if (isPolling) return;
  isPolling = true;
  try {
    const res = await fetch("/api/stamp");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const newStamp = data.stamp;
    if (!STATE.loaded || newStamp !== STAMP) {
      if (!(await loadModel(STATE.loaded))) throw new Error("Modelo no disponible");
      await loadTree(false);
      renderView(true);
      // The model response owns the stamp: a later disk edit must trigger another pass.
      STAMP = MODEL?.stamp ?? newStamp;
    }
    const syncStatus = document.getElementById("syncStatus");
    if (syncStatus) { syncStatus.textContent = "Al día"; syncStatus.title = "Actualización automática cada 2 segundos"; }
  } catch {
    const syncStatus = document.getElementById("syncStatus");
    if (syncStatus) { syncStatus.textContent = "Sin conexión"; syncStatus.title = "Se conserva la última lectura; se reintentará automáticamente"; }
  } finally {
    isPolling = false;
  }
}

// Initial boot & periodic watcher
loadModel().then(() => { STAMP = MODEL?.stamp ?? null; return watchStamp(); });
setInterval(watchStamp, 2000);


// ═════════════════════════════════════════════════════════════════════════════
// OFICINA (el mural) y DESPACHO (la mesa de una tarea)
//
// Read-only wall and task desk. The source files own every state and plan.
// ═════════════════════════════════════════════════════════════════════════════

// `FLOW.md`'s four, in one place. ⚠️ The view paints by outcome and the writer spells the
// destination; if these two lists ever disagree, an item is written with a destination no
// view can colour — so the vocabulary is defined once and both sides import it.
const OUTCOMES = {
  done:      { label: "hecho",      icon: "✅", cls: "out-done",      hint: "resuelto aquí y ahora" },
  mailbox:   { label: "al buzón",   icon: "📬", cls: "out-mailbox",   hint: "hay que debatirlo" },
  ideas:     { label: "a ideas",    icon: "💡", cls: "out-ideas",     hint: "interesante, no ahora" },
  discarded: { label: "descartado", icon: "⚫", cls: "out-discarded", hint: "con su motivo" }
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* a body that is not JSON is still a status */ }
  if (!res.ok) {
    const err = new Error(data.msg || `${res.status} ${res.statusText}`);
    err.stale = res.status === 409;
    err.status = res.status;
    throw err;
  }
  return data;
}




// ───────────────────────────────────────────────── the unified card
//
// ⛔ A compass row and a task list entry are the SAME THING under `FLOW.md`: every
// sub-block is a task. They arrive from two files because two files is how the instance
// keeps them, and the board that shows them twice is showing one piece of work as two.
// The merge is by title, which is what the operator wrote in both places.
function normaliseTitle(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[`*_~]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Parecido por raíces: se cortan las palabras a cinco letras para que «migrar» y
// «migración» cuenten como la misma, y se ignoran las cortas, que son partículas. Es
// deliberadamente tosco: sólo tiene que ser bastante bueno para levantar una bandera.
function titleRoots(t) {
  return new Set(normaliseTitle(t).split(" ").filter(w => w.length >= 4).map(w => w.slice(0, 5)));
}
function similarTitles(a, b) {
  const A = titleRoots(a), B = titleRoots(b);
  if (A.size < 2 || B.size < 2) return false;
  const shared = [...A].filter(w => B.has(w)).length;
  return shared / Math.min(A.size, B.size) >= 0.8;
}

function officeCards() {
  // The wall owns commitments. Historical queue entries are readable in their room,
  // but cannot create or merge wall tasks by a similar title.
  return STATE.fronts.filter(f => f.row !== "board").map(f => ({
    id: f.id, title: f.name, project: f.project || "cross", marker: f.marker,
    active: Boolean(f.active), declared: f.state || null, inBin: Boolean(f.in_bin),
    serves: f.serves || "", description: f.description || "", why: f.why || "",
    affects: f.affects || "", planId: f.sheet || f.described_in || null,
    described_in: f.described_in || "", moves_when: f.moves_when || "",
    waits_on: f.waits_on || "", returns_when: f.returns_when || "",
    drains: f.drains || "", file: f.file, line: f.line
  }));
}

// The five states of `FLOW.md`, derived rather than stored — ⚠️ a second place holding
// "what is happening now" is the thing that rule exists to prevent.
function cardState(c) {
  // ⛔ El estado lo declara la TAREA (`FLOW.md`: «las cinco viven en la tarea»). El marcador
  // del compás es una vista sobre eso, no la fuente — y sólo se usa cuando la tarea no lo
  // dice, que es el caso de una instancia que aún no ha migrado el vocabulario.
  if (c.declared) return c.declared;
  if (c.active) return "active";
  if (c.marker === "⏸") return "paused";
  // ⛔ Los marcadores del muro que sí son inequívocos, leídos del MARCADOR y no del status.
  // Medido 2026-09-06: una fila con `✖` y sin estado declarado caía a `pending` — se veía
  // en cola una tarea cancelada. ⚠️ `✖` es U+2716, el que escriben el muro y `parse.py`;
  // `STATE_META` pinta `✕` U+2715, que es otro carácter y sólo sirve para dibujar. **Un
  // desajuste que no se ve leyendo es el argumento del check, no el de releer.**
  if (c.marker === "✖") return "cancelled";
  if (c.marker === "⤴") return "deferred";
  // El respaldo para una instancia que aún no declara estados: el emoji del vocabulario
  // anterior. ⚠️ Sólo se traducen los dos terminales, que son los únicos donde el emoji
  // dice inequívocamente cuál es — un ⬜ puede ser `pending` o `paused` y no se adivina.
  if (c.status === "✅") return "done";
  if (c.status === "⚫") return "cancelled";
  return "pending";
}

// A task's sheet is loaded by its identity, never by activity or title similarity.
function planForCard(card) {
  return card ? (STATE.taskSheets || {})[card.id] || null : null;
}

async function loadTaskSheet(card) {
  const cache = STATE.taskSheets || (STATE.taskSheets = {});
  cache[card.id] = { ...cache[card.id], loading: true, stale: false };
  try {
    const response = await fetch(`/api/task-sheet?id=${encodeURIComponent(card.id)}`);
    const sheet = await response.json();
    if (!response.ok && !sheet.why) throw new Error(`HTTP ${response.status}`);
    cache[card.id] = sheet;
  } catch (error) {
    cache[card.id] = { available: false, why: "No se pudo leer la hoja. " + error.message };
  }
  if (STATE.taskSheets === cache && STATE.currentView === "desk" && STATE.deskCardId === card.id) {
    renderView(true);
  }
}

// La misma clasificación que hace el parser, para los destinos que llegan de un registro.
function outcomeOfDestination(d) {
  if (!d) return null;
  const t = String(d).toLowerCase();
  if (t.includes("discard") || t.includes("⚫")) return "discarded";
  if (t.includes("mailbox") || t.includes("integrated") || t.includes("task")) return "mailbox";
  if (t.includes("idea") || t.includes("park")) return "ideas";
  return "done";
}
// Los cinco de `FLOW.md`, y son cinco. ⚠️ `cancelled` y `done` son terminales y no salen
// al mural — pero existen aquí porque una tarjeta puede llegar con uno de ellos y pintarla
// como «en cola» sería decir que sigue abierta.
const STATE_META = {
  active:    { label: "activa",     icon: "▶", cls: "st-active",
               hint: "trabajo en marcha, con su propia hoja" },
  paused:    { label: "en pausa",   icon: "⏸", cls: "st-paused",
               hint: "ha estado activa: su hoja está llena y se conserva, por eso reanudarla cuesta leer" },
  pending:   { label: "en cola",    icon: "○", cls: "st-pending",
               hint: "abierta y nunca activa todavía. Su hoja existe y puede estar vacía" },
  paused_r:  { label: "en pausa",   icon: "⏸", cls: "st-paused", hint: "" },
  deferred:  { label: "aplazada",   icon: "⤴", cls: "st-terminal",
               hint: "terminal: dejó la cola para más adelante" },
  cancelled: { label: "cancelada",  icon: "✕", cls: "st-terminal",
               hint: "terminal: sale de la cola" },
  done:      { label: "hecha",      icon: "✓", cls: "st-done",
               hint: "terminal: sale de la cola" }
};
delete STATE_META.paused_r;

// ───────────────────────────────────────────────── the plan, in sections
//
// Items keep the order the file gives them; sections group them, and an UNORDERED section
// carries no sequence at all. ⚠️ Numbering an unordered group is how a plan reads as a
// chain of dependencies that were never there — and then it gets worked in that order.
function planTree(items, sections) {
  const groups = [];
  const at = (sec, sub) => {
    const k = `${sec || ""}⇢${sub || ""}`;
    let g = groups.find(g => g.key === k);
    if (!g) {
      g = { key: k, section: sec, subsection: sub, items: [], ordered: true };
      groups.push(g);
    }
    return g;
  };
  for (const s of sections || []) at(s.section, s.level === 3 ? s.subsection : null);
  for (const it of items) {
    const g = at(it.section, it.subsection);
    g.items.push(it);
    if (it.ordered === false) g.ordered = false;
  }
  return groups.filter(g => g.items.length);
}

function renderPlanItem(item, editable) {
  const meta = item.outcome ? OUTCOMES[item.outcome] : null;
  const routed = Boolean(item.struck || meta);
  const marker = item.ordered === false ? "•" : (item.index ?? "·");
  return `
    <div class="pi ${routed ? "pi-routed" : "pi-open"} ${meta ? meta.cls : ""}">
      <div class="pi-marker">${routed ? (meta ? meta.icon : "✓") : esc(String(marker))}</div>
      <div class="pi-main">
        <div class="pi-text">${inline(item.text)}</div>
        <div class="pi-meta">
          ${meta ? `<span class="pi-outcome ${meta.cls}">${meta.icon} ${meta.label}</span>` : ""}
          ${item.author ? `<span class="pi-author">✍ ${esc(item.author)}${item.date ? ` · ${esc(item.date)}` : ""}</span>` : ""}
          ${item.line ? `<span class="pi-line" title="Línea en PLAN.md">L${item.line}</span>` : ""}
        </div>
      </div>
      ${!routed && item.line ? `
        <span class="pi-unrouted" title="Un item tachado sin destino es un cierre fallido: el parser lo reporta">sin destino</span>` : ""}
    </div>`;
}


// ───────────────────────────────────────────────── OFICINA — the board
const TERMINAL = ["done", "cancelled", "deferred"];

function renderOffice(container) {
  const all = officeCards();
  const live = all.filter(c => !c.inBin && !TERMINAL.includes(cardState(c)));
  const history = all.filter(c => c.inBin || TERMINAL.includes(cardState(c)));
  const fs = STATE.officeFilterState || "active";
  const fp = STATE.officeFilterProj || "ALL";
  const states = [["active", "Activas"], ["paused", "En pausa"], ["pending", "Pendientes"], ["bin", "Historial"]];
  const pool = fs === "bin" ? history : live.filter(c => fs === "ALL" || cardState(c) === fs);
  const shown = pool.filter(c => fp === "ALL" || c.project === fp);
  const projects = [...new Set(all.map(c => c.project))].sort();
  const activeCount = live.filter(c => cardState(c) === "active").length;
  paintView(container, `
    <section class="office-quiet">
      <header class="quiet-heading">
        <p class="quiet-eyebrow">OFICINA</p>
        <h1>Tu trabajo en marcha</h1>
        <p>${activeCount} tarea${activeCount === 1 ? " activa" : "s activas"}. Elige una para continuar.</p>
      </header>
      <div class="quiet-controls">
        <nav class="quiet-tabs" aria-label="Estado de las tareas">
          ${states.map(([state, label]) => `<button class="quiet-tab ${fs === state ? "selected" : ""}"
            aria-pressed="${fs === state}" onclick="setOfficeFilter('state','${state}')">${label}
            <span>${state === "bin" ? history.length : live.filter(c => cardState(c) === state).length}</span></button>`).join("")}
        </nav>
        <label class="quiet-project-filter">Proyecto
          <select onchange="setOfficeFilter('proj',this.value)">
            <option value="ALL">Todos</option>
            ${projects.map(project => `<option value="${esc(project)}" ${fp === project ? "selected" : ""}>${esc(project)}</option>`).join("")}
          </select>
        </label>
      </div>
      ${referenceLinks("office","Cómo trabajar")}
      <div class="quiet-wall">
        ${shown.length ? shown.map(c => `<a data-live-key="${esc(c.id)}" class="quiet-task" href="#/desk/${encodeURIComponent(c.id)}">
          <div class="quiet-task-meta"><span>${esc(c.project)}</span><span>${STATE_META[cardState(c)]?.label || esc(cardState(c))}</span></div>
          <h2>${inline(c.title)}</h2>
          ${c.serves ? `<p>${inline(c.serves)}</p>` : ""}
          <span class="quiet-task-open">Abrir tarea <span aria-hidden="true">→</span></span>
        </a>`).join("") : `<p class="quiet-empty">${fs === "active" ? "No hay tareas activas con este filtro." : "No hay tareas en este apartado."}</p>`}
      </div>
    </section>`);
}

function renderDesk(container) {
  const card = officeCards().find(c => c.id === STATE.deskCardId);
  if (!card) {
    paintView(container, `<section class="office-quiet"><a class="quiet-back" href="#/cockpit">← Volver al muro</a>
      <h1>No se encuentra esta tarea</h1><p>El enlace ya no corresponde a una tarea del muro.</p></section>`);
    return;
  }
  const sheet = planForCard(card);
  if (!sheet || sheet.stale) loadTaskSheet(card);
  const items = sheet?.items || [];
  const remaining = items.filter(i => !i.struck && !i.outcome);
  const done = items.filter(i => i.struck || i.outcome);
  const paragraphs = (card.description || "").split(/\n\s*\n/).filter(Boolean);
  const project = STATE.projects.find(p => p.name === card.project);
  const now = sheet?.current || paragraphs[0] || "Esta tarea no tiene una actividad actual descrita.";
  const list = entries => `<ol class="quiet-steps">${entries.map(i => `<li value="${Number(i.index) || 1}">
    ${inline(i.text)}${i.destination ? `<span class="quiet-outcome">${inline(i.destination)}</span>` : ""}</li>`).join("")}</ol>`;
  paintView(container, `
    <article class="quiet-desk">
      <a class="quiet-back" href="#/cockpit">← Volver al muro</a>
      <header class="quiet-desk-heading">
        <p class="quiet-eyebrow">${esc(card.project)} <span>· ${STATE_META[cardState(card)]?.label || esc(cardState(card))}</span></p>
        <h1>${inline(card.title)}</h1>
        ${card.serves ? `<p class="quiet-purpose">${inline(card.serves)}</p>` : ""}
        ${project ? `<nav class="project-door-links" aria-label="Documentos de este proyecto">
          <a href="${esc(projectRoute(project.name, 'objectives'))}">Objetivos</a>
          <a href="${esc(projectRoute(project.name, 'plan'))}">Plan</a>
          <a href="${esc(projectRoute(project.name, 'files'))}">Archivos del proyecto</a>
        </nav>` : ''}
      </header>
      <section class="quiet-now" aria-label="Actividad actual">
        <h2>${cardState(card) === "active" ? "Ahora" : "Situación"}</h2>
        <div>${inline(now)}</div>
        ${card.waits_on ? `<p class="quiet-blocker">Espera a: ${inline(card.waits_on)}</p>` : ""}
      </section>
      ${!sheet || sheet.loading ? `<p class="quiet-loading" role="status">Leyendo la hoja de esta tarea…</p>` : ""}
      ${sheet && !sheet.loading && !sheet.available ? `<p class="quiet-source-note">${esc(sheet.why)}</p>` : ""}
      <div class="quiet-folds">
        ${items.length ? `
          <details id="desk-remaining"><summary>Lo que queda <span>${remaining.length}</span></summary>
            ${remaining.length ? list(remaining) : "<p>Todos los pasos de esta hoja tienen salida.</p>"}
          </details>
          <details id="desk-done"><summary>Lo que ya hemos hecho <span>${done.length}</span></summary>
            ${done.length ? list(done) : "<p>Todavía no hay pasos cerrados en esta hoja.</p>"}
          </details>` : ""}
        <details id="desk-context"><summary>Contexto y plan</summary>
          ${paragraphs.slice(sheet?.current ? 0 : 1).map(p => `<p>${inline(p)}</p>`).join("")}
          ${card.why ? `<h3>Por qué lo hacemos</h3><p>${inline(card.why)}</p>` : ""}
          ${card.affects ? `<h3>Qué afecta</h3><p>${inline(card.affects)}</p>` : ""}
          ${card.returns_when ? `<h3>Cuándo vuelve</h3><p>${inline(card.returns_when)}</p>` : ""}
          ${sheet?.order_why ? `<h3>Por qué este orden</h3><p>${inline(sheet.order_why)}</p>` : ""}
          ${sheet?.available ? `<details id="desk-source" class="quiet-source"><summary>Leer la hoja original</summary>
            <p class="quiet-source-path">${esc(sheet.reference)}</p>
            <div class="md-body">${renderMarkdownBody(sheet.body)}</div></details>` : ""}
        </details>
      </div>
    </article>`);
}

// ───────────────────────────────────────────────── acciones de la oficina
window.setOfficeFilter = function (which, val) {
  if (which === "proj") STATE.officeFilterProj = val; else STATE.officeFilterState = val;
  renderView();
};

window.openDesk = function (cardId) {
  history.pushState(null, "", `#/desk/${encodeURIComponent(cardId)}`);
  STATE.deskCardId = cardId;
  STATE.currentView = "desk";
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
};



// ───────────────────────────────────────────────── los handlers que faltaban
//
// ⛔ `index.html` called all of these and none of them existed. The modals opened and
// could not close; submitting a form threw and reloaded the page, so the entry was lost




// ═════════════════════════════════════════════════════════════════════════════
// DOCTRINA — la filosofía, los axiomas y los ficheros estructurales
//
// ⛔ Nothing here is transcribed. `/api/doctrine` parses Aevifex' own files and this layer
// paints what comes back, so the page cannot state a clause the file does not. The build
// before this one hard-coded six clauses: it named `PH-0` as something it had stopped
// being, described `PH-1` as a clause that was never written, omitted `PH-6` entirely, and
// printed "30 axiomas activos" against a real 34. Every one of those looked authoritative.
// `AX-20` names the duplicate and `AX-36` names the hand-typed count.
// ═════════════════════════════════════════════════════════════════════════════

// Qué se ha tocado hoy, de git. ⚠️ Falla en silencio a propósito: es una marca de ayuda
// sobre un dato que ya está completo sin ella, así que un árbol que no es repositorio da una
// vista igual de correcta, sólo sin la marca.
async function loadRecent() {
  try {
    const d = await api("GET", "/api/recent");
    STATE.recentLines = d.lines || {};
  } catch (_) { STATE.recentLines = {}; }
}

// ⛔ `interface:I3.1` — las firings de los roles eran la única medida de la salud del
// sistema que esta interfaz no podía pintar, y el script que las calcula llevaba escrito
// desde antes. **El trabajo es una vista, no un parser**: esto pide el JSON y no recalcula
// nada, porque dos cosas que cuentan lo mismo acaban discrepando (`Aevifex:AX-20`).
// ⚠️ Se carga una vez, como la doctrina: el script barre el árbol y no es estado vivo.
// The tree carries document metadata; bodies are loaded only when opened.
function invalidateReaders(previous, next) {
  const files = tree => new Map((tree?.files || []).map(f => [`${f.root}/${f.path}`.replace(/^(?:\.\/)+/, ""), f.version]));
  const old = files(previous), fresh = files(next);
  const changed = new Set([...old.keys(), ...fresh.keys()].filter(path => old.get(path) !== fresh.get(path)));
  for (const sheet of Object.values(STATE.taskSheets || {})) {
    if (!sheet.path || changed.has(sheet.path)) sheet.stale = true;
  }
  for (const project of STATE.projects) {
    const prefix = project.projectRoot + '/';
    if ([...changed].some(path => path.startsWith(prefix))) {
      const catalog = STATE.projectCatalogs?.[project.name];
      if (catalog) catalog.stale = true;
    }
  }
  for (const [key, doc] of Object.entries(STATE.projectDocuments || {})) {
    const [name, path] = JSON.parse(key);
    const project = STATE.projects.find(p => p.name === name);
    if (!project || changed.has(`${project.projectRoot}/${path}`)) doc.stale = true;
  }
}

async function loadTree(render = true) {
  try {
    const tree = await api("GET", "/api/tree");
    if (JSON.stringify(tree) !== JSON.stringify(STATE.tree)) {
      invalidateReaders(STATE.tree, tree);
      STATE.tree = tree; STATE.libraryRevision = (STATE.libraryRevision || 0) + 1;
      for (const [key, note] of Object.entries(STATE.notes || {})) {
        const file = tree.files?.find(f => Library.key(f) === key);
        if (!file || file.version !== note.version) note.stale = true;
        delete note.renderedNotebook;
        delete note.rendered; // Link destinations may have changed even when this body did not.
      }
      if (STATE.libNote) {
        const note = STATE.notes?.[Library.key(STATE.libNote)];
        if (note?.stale) loadNote(STATE.libNote.root, STATE.libNote.path);
      }
      if (STATE.searchQ) loadSearch(STATE.searchQ);
    }
  } catch (e) { if (!render) throw e; if (!STATE.tree) STATE.tree = {available:false, why:e.message}; }
  updateHUD(); if (render) renderView(true);
}
async function loadNote(root, path, retry = false) {
  const key = Library.key({root,path}); STATE.notes ||= {};
  const old = STATE.notes[key];
  if (old?.loading || (old && !old.stale && !retry)) return;
  const version = STATE.tree?.files?.find(f => Library.key(f) === key)?.version;
  STATE.notes[key] = {...old, loading:true, stale:false}; renderView(true);
  try {
    const d = await api("GET", `/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
    STATE.notes[key] = d.available ? {body:d.body, version} : {...old, version, error:d.why || "No se pudo leer", loading:false, stale:false};
  } catch (e) { STATE.notes[key] = {...old, version, error:e.message, loading:false, stale:false}; }
  renderView(true);
}
let librarySearchRequest = 0;
async function loadSearch(q) {
  const request = ++librarySearchRequest;
  if (!q || q.trim().length < 2) { STATE.search = null; renderView(); return; }
  const root = STATE.libNote ? STATE.libSearchRoot || "" : STATE.libShelf || "";
  STATE.search = {loading:true}; renderView();
  try {
    const result = await api("GET", `/api/search?q=${encodeURIComponent(q)}${STATE.libSearchAll ? "" : "&library=1"}${root ? "&root=" + encodeURIComponent(root) : ""}`);
    if (request !== librarySearchRequest || STATE.searchQ !== q) return;
    STATE.search = result.available ? result : {error:result.why};
  } catch (e) { if (request === librarySearchRequest && STATE.searchQ === q) STATE.search = {error:e.message}; }
  renderView();
}

async function loadMetrics() {
  try {
    STATE.metrics = await api("GET", "/api/metrics");
  } catch (e) {
    // No hay fuente y se dice, que no es lo mismo que cero (`interface:AX-5`).
    STATE.metrics = { available: false, why: e.message };
  }
  renderView();
}

async function loadDoctrine() {
  try {
    const d = await api("GET", "/api/doctrine");
    const of = k => (d.entities || []).filter(e => e.kind === k);
    STATE.doctrine = {
      clauses:  of("clause"),
      axioms:   of("axiom"),
      coverage: of("coverage"),
      refusals: of("refusal"),
      docs:     of("doc"),
      problems: d.problems || [],
      root: d.root
    };
  } catch (e) {
    // ⚠️ A doctrine that will not load says so. The alternative is a page that quietly
    // falls back to a copy, which is the failure this whole layer exists to remove.
    STATE.doctrine = { error: e.message, clauses: [], axioms: [], coverage: [],
                       refusals: [], docs: [], problems: [] };
  }
  if (["overview", "clause", "doc", "dashboard"].includes(STATE.currentView)) renderView();
}

const D = () => STATE.doctrine || { clauses: [], axioms: [], coverage: [], refusals: [], docs: [] };
const clauseOf = id => D().clauses.find(c => c.id === id) || null;
const axiomsOf = id => D().axioms.filter(a => (a.serves || []).includes(id));
const coverageOf = id => D().coverage.find(c => c.id === id) || null;

// Los estados del check, que `AXIOMS.md` prohíbe expresamente sumar como uno solo.
const CHECKS = {
  "$":    { icon: "▶", label: "ejecutable", cls: "chk-run",
            hint: "un comando que corre hoy y devuelve un veredicto — y puede bajar" },
  owed:   { icon: "⊘", label: "en deuda", cls: "chk-owed",
            hint: "hay check nombrado y no corre: AX-7 roto, declarado" },
  none:   { icon: "·", label: "sin check", cls: "chk-none",
            hint: "el vacío honesto" }
};

// Una cláusula, un color. ⚠️ Es vocabulario, no adorno: el mismo color identifica la
// cláusula en el frontón, en su columna, en su página y en el dashboard.
const CLAUSE_TONE = {
  "PH-0": "tone-gold", "PH-1": "tone-aegean", "PH-2": "tone-olive",
  "PH-3": "tone-terracotta", "PH-4": "tone-grape", "PH-5": "tone-ink",
  "PH-6": "tone-cyan"
};

// El título griego de cada cláusula. ⚠️ Es decoración tipográfica y NO una traducción:
// el nombre que manda es el del fichero, que se pinta al lado en todas partes.
const CLAUSE_GREEK = {
  "PH-0": "ΔΙΑΜΟΝΗ", "PH-1": "ΑΥΞΗΣΙΣ", "PH-2": "ΑΝΤΟΧΗ", "PH-3": "ΜΝΗΜΗ",
  "PH-4": "ΑΡΧΗ", "PH-5": "ΠΡΟΣΟΧΗ", "PH-6": "ΜΕΤΡΟΝ"
};

// El cuerpo de una cláusula lleva marcadores que son estructura, no énfasis: `⛔` es un
// límite y `⚠️` una trampa. Se separan para que la página los pueda tratar distinto.
function clauseParts(body) {
  const out = { lead: [], stops: [], warns: [] };
  for (const para of String(body || "").split(/\n\s*\n/)) {
    const t = para.trim();
    if (!t) continue;
    if (t.startsWith("⛔")) out.stops.push(t);
    else if (t.startsWith("⚠️")) out.warns.push(t);
    else out.lead.push(t);
  }
  return out;
}

// ───────────────────────────────────────────────── el frontón y las columnas
function renderPediment() {
  const ph0 = clauseOf("PH-0");
  if (!ph0) {
    return `<div class="empty-state"><div class="empty-icon">🏛️</div>
      <h3>La doctrina no ha cargado</h3>
      <p>${esc(D().error || "PHILOSOPHY.md no está en la raíz del motor.")}
         Esta página se lee de los ficheros; no lleva copia.</p></div>`;
  }
  const cls = D().clauses.filter(c => !c.objective);
  return `
    <section class="temple">
      <svg class="pediment" viewBox="0 0 1000 132" preserveAspectRatio="none" aria-hidden="true">
        <!-- ⚠️ El frontón es adorno y nada más: quítalo y la portada sigue diciendo lo
             mismo, porque todo el texto vive en las columnas y en la placa. -->
        <defs>
          <linearGradient id="marble" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#fbf8ef"/><stop offset="1" stop-color="#e9e2d1"/>
          </linearGradient>
        </defs>
        <polygon points="500,4 998,116 2,116" fill="url(#marble)" stroke="#c2b79c" stroke-width="2"/>
        <rect x="0" y="116" width="1000" height="16" fill="#efe9da" stroke="#cfc4a8" stroke-width="1.5"/>
        <polygon points="500,26 946,112 54,112" fill="none" stroke="#d5cab0" stroke-width="1.4"/>
        <circle cx="500" cy="80" r="13" fill="none" stroke="#c8bda2" stroke-width="1.8"/>
        <circle cx="500" cy="80" r="5" fill="#dfd6bf"/>
      </svg>

      <div class="architrave">
        <div class="ph0-plate tone-gold">
          <span class="ph0-greek">${CLAUSE_GREEK["PH-0"]}</span>
          <span class="ph0-id">PH-0 · ${esc(ph0.title)}</span>
          <blockquote class="ph0-slogan">${inline(ph0.epigraph || "")}</blockquote>
          <p class="ph0-gloss">
            Esto es <strong>para lo que existe la empresa</strong>. Ningún axioma la sirve
            directamente: la sirven las cláusulas, y cada una cierra una manera concreta de
            perderla.
          </p>
        </div>
      </div>

      <div class="colonnade">
        ${cls.map(c => {
          const cov = coverageOf(c.id);
          const ax = axiomsOf(c.id);
          const runnable = ax.filter(a => a.check_state === "$").length;
          return `
            <button class="column ${CLAUSE_TONE[c.id] || ""}" onclick="openClause(${jsq(c.id)})"
                    title="${esc(c.epigraph || c.title)}">
              <span class="capital"></span>
              <span class="shaft">
                <span class="col-greek">${CLAUSE_GREEK[c.id] || ""}</span>
                <span class="col-id">${c.id}</span>
                <span class="col-title">${esc(c.title)}</span>
                ${c.epigraph ? `<span class="col-epigraph">${esc(c.epigraph)}</span>` : ""}
              </span>
              <span class="base">
                <span class="base-n">${cov ? esc(cov.count) : ax.length}</span>
                <span class="base-l">axioma${ax.length === 1 ? "" : "s"}${runnable ? ` · ${runnable} con check` : ""}</span>
              </span>
            </button>`;
        }).join("")}
      </div>
      <div class="stylobate"></div>
    </section>`;
}

// ───────────────────────────────────────────────── una cláusula, entera
function renderClause(container) {
  const c = clauseOf(STATE.clauseId);
  if (!c) {
    paintView(container, `<div class="empty-state"><div class="empty-icon">🏛️</div>
      <h3>Cláusula no encontrada</h3>
      <p>${esc(STATE.clauseId || "")} no está en <code>PHILOSOPHY.md</code>.</p>
      <button class="btn-retry" onclick="navigateTo('overview')">Volver a la portada</button></div>`);
    return;
  }
  const tone = CLAUSE_TONE[c.id] || "";
  const parts = clauseParts(c.body);
  const ax = axiomsOf(c.id);
  const cov = coverageOf(c.id);
  const byCheck = s => ax.filter(a => a.check_state === s);
  const others = D().clauses.filter(x => !x.objective && x.id !== c.id);

  paintView(container, `
    <div class="desk-plate clause-plate ${tone}">
      <button class="crumb-link" onclick="navigateTo('overview')">🏛️ Portada</button>
      <span class="crumb-sep">›</span>
      <span class="crumb-here">${c.id} · ${esc(c.title)}</span>
      <span class="clause-file"><code>PHILOSOPHY.md:${c.line}</code></span>
    </div>

    <header class="clause-hero ${tone}">
      <div class="clause-hero-mark">
        <span class="clause-greek">${CLAUSE_GREEK[c.id] || ""}</span>
        <span class="clause-id">${c.id}</span>
      </div>
      <div class="clause-hero-main">
        <h1>${esc(c.title)}</h1>
        ${c.epigraph ? `<blockquote class="clause-epigraph">${inline(c.epigraph)}</blockquote>` : ""}
        ${c.objective ? `<p class="clause-objective-note">
            Ésta no es una cláusula: es <strong>el objetivo</strong>. Las demás existen para
            protegerla, y por eso ningún axioma la sirve directamente.</p>` : ""}
      </div>
    </header>

    <div class="clause-grid">
      <section class="clause-body">
        ${parts.lead.map(t => `<div class="clause-para">${renderMarkdownBody(t)}</div>`).join("")}
        ${parts.warns.map(t => `
          <div class="callout callout-warning"><span class="callout-icon">⚠️</span>
            <div class="callout-content">${inline(t.replace(/^⚠️\s*/, ""))}</div></div>`).join("")}
        ${parts.stops.map(t => `
          <div class="callout callout-danger"><span class="callout-icon">⛔</span>
            <div class="callout-content">${inline(t.replace(/^⛔\s*/, ""))}</div></div>`).join("")}

        <div class="clause-axioms">
          <div class="clause-axioms-head">
            <h2>Axiomas que la sirven</h2>
            <span class="tag-pill tag-live">${ax.length}</span>
            ${cov && cov.count !== String(ax.length) ? `
              <span class="cov-mismatch" title="La tabla de cobertura de AXIOMS.md y las filas leídas no dan el mismo número">
                ⚠️ la tabla de cobertura dice ${esc(cov.count)}
              </span>` : ""}
          </div>
          ${ax.length ? `
            <div class="check-summary">
              ${Object.entries(CHECKS).map(([k, m]) => `
                <span class="chk-pill ${m.cls}" title="${m.hint}">
                  ${m.icon} ${byCheck(k).length} ${m.label}
                </span>`).join("")}
            </div>
            <div class="axiom-list">
              ${ax.map(a => renderAxiomRow(a, c.id)).join("")}
            </div>` : `
            <p class="clause-zero">
              ${c.objective
                ? "Cero, por diseño. <code>PH-0</code> la sirven las cláusulas, no los axiomas — y una tabla de cobertura que esperase una regla aquí reportaría un hueco que no existe."
                : "Ninguno. Una cláusula sin axioma detrás es un valor sin dientes."}
            </p>`}
        </div>
      </section>

      <aside class="clause-rail">
        <div class="rail-panel">
          <div class="rail-head"><strong>Las otras cláusulas</strong></div>
          ${others.map(o => `
            <button class="clause-jump ${CLAUSE_TONE[o.id] || ""}" onclick="openClause(${jsq(o.id)})">
              <span class="cj-id">${o.id}</span>
              <span class="cj-title">${esc(o.title)}</span>
              <span class="cj-n">${axiomsOf(o.id).length}</span>
            </button>`).join("")}
        </div>
        <div class="rail-panel">
          <div class="rail-head"><strong>Los tres niveles</strong></div>
          <ol class="levels-list">
            <li><strong>Filosofía</strong><em>para qué existe · rompe todo empate</em></li>
            <li><strong>Axiomas</strong><em>las reglas que la implementan · nunca se violan</em></li>
            <li><strong>Decisiones</strong><em>con autor, fecha y razón · viven en la centralita</em></li>
          </ol>
          <p class="rail-note">Los mismos tres niveles se repiten un piso más abajo dentro de
             cada proyecto, con su propio auditor.</p>
        </div>
      </aside>
    </div>`);
}

function renderAxiomRow(a, highlightClause) {
  const m = CHECKS[a.check_state] || CHECKS.none;
  return `
    <article class="axiom-row ${m.cls}">
      <div class="axiom-row-head">
        <span class="axiom-id">${esc(a.id)}</span>
        <span class="axiom-status ${a.status === "in-force" ? "st-force" : "st-proposed"}">
          ${a.status === "in-force" ? "🟢 en vigor" : "🟡 propuesto"}
        </span>
        <span class="chk-pill ${m.cls}" title="${m.hint}">${m.icon} ${m.label}</span>
        <span class="axiom-serves">
          ${(a.serves || []).map(s => `
            <button class="serves-chip ${s === highlightClause ? "is-here" : ""} ${CLAUSE_TONE[s] || ""}"
                    onclick="event.stopPropagation(); openClause(${jsq(s)})">${s}</button>`).join("")}
        </span>
      </div>
      <div class="axiom-text">${inline(a.text)}</div>
      ${a.check && a.check !== "—" ? `<div class="axiom-check">${inline(a.check)}</div>` : ""}
    </article>`;
}

// ───────────────────────────────────────────────── los ficheros estructurales
const DOC_META = {
  PHILOSOPHY: { icon: "🏛️", greek: "ΛΟΓΟΣ", tone: "tone-gold",
    q: "¿Para qué existe esta empresa y qué rechaza?",
    role: "Nivel 1. Rompe todo empate. Cambia casi nunca, y sólo el operador." },
  AXIOMS: { icon: "⚖️", greek: "ΝΟΜΟΣ", tone: "tone-aegean",
    q: "¿Qué reglas no se violan nunca?",
    role: "Nivel 2. Una regla por fila, con la cláusula que sirve y su check." },
  AGENTS: { icon: "🗺️", greek: "ΤΑΞΙΣ", tone: "tone-olive",
    q: "¿Quién hace qué, y en qué ocasión?",
    role: "La orquestación: los roles, los invariantes y la regla de contratar y despedir." },
  METHOD: { icon: "🔁", greek: "ΟΔΟΣ", tone: "tone-terracotta",
    q: "¿Cómo fluye el trabajo, de verdad, cada día?",
    role: "El bucle, las dos colas y la tabla de enrutado. Es el que se usa a diario." },
  FLOW: { icon: "🧬", greek: "ΜΟΡΦΗ", tone: "tone-grape",
    q: "¿Qué forma tiene el trabajo?",
    role: "El anidamiento y los estados. Es el fichero a cambiar para otro flujo de trabajo." },
  README: { icon: "🚪", greek: "ΠΥΛΗ", tone: "tone-cyan",
    q: "¿Por dónde entra alguien que llega de cero?",
    role: "La puerta de entrada pública del repositorio." }
};
// El orden de lectura que `AGENTS.md` §1 declara, y que no es el alfabético.
const DOC_ORDER = ["PHILOSOPHY", "AXIOMS", "AGENTS", "METHOD", "FLOW", "README"];

function renderStructuralFiles(collapsed) {
  const docs = D().docs;
  const have = id => docs.find(d => d.id === id);
  const rows = DOC_ORDER.map(id => {
    const d = have(id);
    const meta = DOC_META[id] || {};
    const own = id === "PHILOSOPHY" || id === "AXIOMS";
    const inner = id === "PHILOSOPHY" ? `${D().clauses.length} cláusulas`
                : id === "AXIOMS" ? `${D().axioms.length} axiomas`
                : d ? `${d.outline.length} secciones` : "—";
    const words = d ? `${d.words.toLocaleString("es")} palabras` : own ? "" : "no encontrado";
    const go = id === "PHILOSOPHY" ? `openClause('PH-0')`
             : id === "AXIOMS" ? `navigateTo('dashboard')` : `openDoc('${id}')`;
    const goLabel = id === "PHILOSOPHY" ? "abrir el frontón →"
                  : id === "AXIOMS" ? "ver los checks →" : "leer entero →";
    return `
      <button class="stele ${meta.tone || ""}" onclick="${go}" ${!d && !own ? "disabled" : ""}>
        <span class="stele-top">
          <span class="stele-icon">${meta.icon || "📄"}</span>
          <span class="stele-greek">${meta.greek || ""}</span>
        </span>
        <span class="stele-name">${id}.md</span>
        <span class="stele-q">${esc(meta.q || "")}</span>
        <span class="stele-role">${esc(meta.role || "")}</span>
        <span class="stele-foot">
          <span class="stele-n">${inner}</span>
          ${words ? `<span class="stele-w">${words}</span>` : ""}
          <span class="stele-go">${goLabel}</span>
        </span>
      </button>`;
  }).join("");

  return `
    <section class="doc-section" id="sec-structure">
      <div class="section-head" onclick="toggleOverviewSection('sec-structure')">
        <h2><span class="num">03</span> <span class="sec-greek">ΣΤΗΛΑΙ</span> Los ficheros troncales</h2>
        <button class="section-toggle">${collapsed ? "▶ Desplegar" : "▼ Plegar"}</button>
      </div>
      <div class="section-body ${collapsed ? "collapsed" : ""}">
        <p class="section-lead">
          Se leen en este orden: <strong>filosofía</strong>, para qué → <strong>axiomas</strong>,
          las reglas que se derivan → <strong>este mapa</strong>, quién hace qué →
          <strong>el método</strong>, que es el que se usa todos los días → <strong>la forma</strong>
          que toma el trabajo. Cada uno abre su página entera con índice.
        </p>
        <div class="stelae">${rows}</div>

        ${renderNesting()}
        ${renderCloseLadder()}

        ${D().problems && D().problems.length ? `
          <div class="callout callout-warning"><span class="callout-icon">⚠️</span>
            <div class="callout-content"><strong>La doctrina cargó con incidencias.</strong>
            ${D().problems.map(x => `<div><code>${esc(x.file || "")}</code> — ${esc(x.why || "")}</div>`).join("")}</div>
          </div>` : ""}
      </div>
    </section>`;
}

// El anidamiento que declara `FLOW.md`. ⚠️ Los cinco niveles y sus glosas se escriben aquí
// porque `FLOW.md` los dibuja en un bloque de código ASCII, que no es una estructura que se
// pueda leer sin adivinar. Es la única transcripción que queda en esta página, y va marcada.
const NESTING = [
  ["project",   "proyecto",  "un repositorio soberano, con su propio ciclo de vida"],
  ["block",     "bloque",    "propuesto por adelantado — la forma del trabajo"],
  ["sub-block", "sub-bloque","definido al llegar, no antes. Una <em>pieza del plan</em>, todavía no un compromiso"],
  ["↓ promoción","promoción", "<strong>alguien decide que es su momento</strong>, y sólo entonces sale al muro"],
  ["task",      "tarea",     "en el muro, con su propia hoja. <strong>Una tarea es un compromiso</strong>"],
  ["item",      "item",      "y los items engendran items, que se escriben en el acto"]
];

function renderNesting() {
  const flow = D().docs.find(d => d.id === "FLOW");
  return `
    <div class="sub-block-pair">
      <div class="sub-panel">
        <div class="sub-panel-head">
          <span class="sub-greek">ΜΟΡΦΗ</span>
          <h3>La forma que toma el trabajo</h3>
          ${flow ? `<button class="inline-link" onclick="openDoc('FLOW')">FLOW.md →</button>` : ""}
        </div>
        <div class="nesting">
          ${NESTING.map(([en, es, gloss], i) => `
            <div class="nest-row" style="--depth:${i}">
              <span class="nest-rail" aria-hidden="true"></span>
              <span class="nest-name">${es}<code>${en}</code></span>
              <span class="nest-gloss">${gloss}</span>
            </div>`).join("")}
        </div>
        <p class="sub-note">
          <strong>Un sub-bloque no es una tarea hasta que alguien lo dice.</strong> Es una pieza
          de un plan; una tarea es un compromiso. Al promoverlo <em>no cambia nada más de él</em>:
          conserva su dirección en el plan, y la tarea nombra esa dirección. Una tarea que llegó
          entera no tiene bloque encima y escribe <code>block</code> vacío, porque un campo
          ausente no puede decir eso.
        </p>
        <p class="sub-note sub-note-warn">
          ⚠️ Este esquema es la única transcripción que queda en la portada: <code>FLOW.md</code>
          lo dibuja en un bloque ASCII y eso no se puede leer sin adivinar. Si cambias el
          anidamiento, esta caja hay que cambiarla a mano.
        </p>
      </div>

      <div class="sub-panel">
        <div class="sub-panel-head">
          <span class="sub-greek">ΤΕΛΟΣ</span>
          <h3>Los cuatro destinos de un item</h3>
        </div>
        <div class="dest-grid">
          ${Object.entries(OUTCOMES).map(([k, o]) => `
            <div class="dest-cell ${o.cls}">
              <span class="dest-icon">${o.icon}</span>
              <strong>${o.label}</strong>
              <span>${o.hint}</span>
            </div>`).join("")}
        </div>
        <p class="sub-note">
          Un item, al llegarle su turno, se va por una de esas cuatro y <strong>ninguna otra</strong>.
          Un tachado sin destino es un <em>cierre fallido</em>, y el parser lo reporta como tal.
        </p>
        <p class="sub-note">
          <strong>Un estado no es un destino</strong>, y los dos conjuntos tienen tamaños
          distintos: una <em>tarea</em> lleva uno de cinco estados
          (<code>pending · active · paused · cancelled · done</code>); un <em>item</em> se va con
          uno de estos cuatro.
        </p>
      </div>
    </div>`;
}

// El orden del cierre, leído de `METHOD.md` §2. El orden ES el contenido: el paso 3
// (la auditoría) tiene que ir antes del 4 (cerrar el plan), o el auditor lee un fichero
// vacío creyendo que ha leído el razonamiento.
function renderCloseLadder() {
  const sec = docSection("METHOD", "2. The loop");
  const steps = [];
  for (let i = 0; i < sec.length; i++) {
    const m = sec[i].match(/^(\d+b?)\.\s+(.*)$/);
    if (!m) continue;
    let body = m[2];
    for (let j = i + 1; j < sec.length && /^\s{2,}\S/.test(sec[j]); j++) body += " " + sec[j].trim();
    steps.push({ n: m[1], text: body });
  }
  if (!steps.length) return "";
  return `
    <div class="sub-panel close-panel">
      <div class="sub-panel-head">
        <span class="sub-greek">ΚΛΕΙΣΙΣ</span>
        <h3>Cerrar una tarea — y el orden es el contenido</h3>
        <button class="inline-link" onclick="openDoc('METHOD')">METHOD.md §2 →</button>
      </div>
      <ol class="close-ladder">
        ${steps.map(st => `
          <li class="close-step">
            <span class="close-n">${esc(st.n)}</span>
            <div class="close-text">${expandable(st.text)}</div>
          </li>`).join("")}
      </ol>
      <p class="sub-note">
        Leído de <code>METHOD.md</code> §2 en vivo: ${steps.length} pasos. La auditoría va
        <strong>antes</strong> de cerrar el plan, siempre — al revés, el auditor lee un fichero en
        blanco creyendo que ha leído el razonamiento de la ronda.
      </p>
    </div>`;
}

function renderRefusals() {
  const r = D().refusals;
  if (!r.length) return "";
  return `
    <section class="frieze">
      <div class="frieze-head">
        <span class="frieze-greek">ΟΥΚ</span>
        <h2>Lo que esta empresa rechaza</h2>
      </div>
      <div class="frieze-rows">
        ${r.map(x => `
          <div class="frieze-row">
            <span class="frieze-mark">✕</span>
            <div><strong>${esc(x.title)}</strong><span>${inline(x.body)}</span></div>
          </div>`).join("")}
      </div>
    </section>`;
}

// ───────────────────────────────────────────────── el lector de documentos
function renderDoc(container) {
  const d = D().docs.find(x => x.id === STATE.docId);
  if (!d) {
    paintView(container, `<div class="empty-state"><div class="empty-icon">📄</div>
      <h3>Documento no cargado</h3>
      <p>${esc(STATE.docId || "")} no está en la raíz del motor.</p>
      <button class="btn-retry" onclick="navigateTo('overview')">Volver a la portada</button></div>`);
    return;
  }
  const meta = DOC_META[d.id] || {};
  paintView(container, `
    <div class="desk-plate clause-plate ${meta.tone || ""}">
      <button class="crumb-link" onclick="navigateTo('overview')">🏛️ Portada</button>
      <span class="crumb-sep">›</span>
      <span class="crumb-here">${esc(d.id)}.md</span>
      <span class="clause-file"><code>${d.lines} líneas · ${d.words.toLocaleString("es")} palabras</code></span>
    </div>

    <header class="clause-hero ${meta.tone || ""}">
      <div class="clause-hero-mark">
        <span class="clause-greek">${meta.greek || ""}</span>
        <span class="clause-id">${meta.icon || "📄"}</span>
      </div>
      <div class="clause-hero-main">
        <h1>${esc(d.title)}</h1>
        <blockquote class="clause-epigraph">${esc(meta.q || "")}</blockquote>
        <p class="clause-objective-note">${esc(meta.role || "")}</p>
      </div>
    </header>

    <div class="clause-grid">
      <section class="doc-reader">${renderMarkdownBody(d.body)}</section>
      <aside class="clause-rail">
        <div class="rail-panel">
          <div class="rail-head"><strong>En este documento</strong></div>
          <nav class="doc-toc">
            ${d.outline.map((o, i) => `
              <button class="toc-item toc-l${o.level}" onclick="scrollToHeading(${i})">
                ${esc(o.title)}
              </button>`).join("")}
          </nav>
        </div>
        <div class="rail-panel">
          <div class="rail-head"><strong>Los otros</strong></div>
          ${DOC_ORDER.filter(x => x !== d.id && D().docs.find(y => y.id === x)).map(x => `
            <button class="clause-jump ${DOC_META[x]?.tone || ""}" onclick="openDoc('${x}')">
              <span class="cj-id">${DOC_META[x]?.icon || "📄"}</span>
              <span class="cj-title">${x}.md</span>
            </button>`).join("")}
        </div>
      </aside>
    </div>`);
}

window.scrollToHeading = function (i) {
  const reader = document.querySelector(".doc-reader");
  if (!reader) return;
  const hs = reader.querySelectorAll("h1, h2, h3");
  if (hs[i]) hs[i].scrollIntoView({ behavior: "smooth", block: "start" });
};

window.openClause = function (id) {
  STATE.clauseId = id;
  STATE.currentView = "clause";
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.openDoc = function (id) {
  STATE.docId = id;
  STATE.currentView = "doc";
  renderView();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD — PH-6
//
// ⛔ Every tile here declares which of `PH-6`'s two purposes it serves — **steer**, a
// decision changes when it moves, or **prove**, evidence for someone with no reason to
// believe us. A number that serves neither is a dashboard, and a dashboard is
// accumulation wearing a chart. That sentence is the clause's, and it is the standard this
// page is held to rather than a decoration on it.
//
// ⚠️ Encoding note. The three check states are NOT three identities — they are one ordinal
// scale of *how enforced a rule is*: it runs (`$`) → it is named and does not run (`⊘`) →
// there is none (`—`). Painted as a categorical trio, good-vs-serious measured ΔE 5.6 under
// protanopia and good-vs-critical ΔE 4.1 under deuteranopia: the classic red/green pair,
// unreadable for the readers who most need the signal. One hue, light→dark, validated
// against this page's own surface (`#f2efe6`), and every segment carries its icon and its
// number as well as its colour.
// ═════════════════════════════════════════════════════════════════════════════

const ENFORCE = {
  "$":  { step: "#2c4527", label: "corre",     icon: "▶", ink: "#fbfaf5",
          hint: "un comando que se ejecuta hoy y devuelve un veredicto — y puede bajar" },
  owed: { step: "#66875c", label: "en deuda",  icon: "⊘", ink: "#fbfaf5",
          hint: "hay check nombrado y no corre: AX-7 roto, y declarado" },
  none: { step: "#94ab8a", label: "sin check", icon: "·", ink: "#14231b",
          hint: "no hay check — el vacío honesto, ni bueno ni malo por sí solo" }
};
const ENFORCE_ORDER = ["$", "owed", "none"];

// Un dato es una medida cuando lleva su denominador y de dónde se leyó (`AX-36`).
function metric({ id, purpose, title, n, of, unit, source, bad, note, tone }) {
  const pct = of ? Math.round(n / of * 100) : null;
  return `
    <article class="metric ${tone || ""}">
      <header class="metric-head">
        <span class="metric-purpose purpose-${purpose}" title="${
          purpose === "steer" ? "Para gobernar: cuando se mueve, cambia una decisión"
                              : "Para probar: es evidencia para quien no tiene motivos para creernos"}">
          ${purpose === "steer" ? "gobernar" : "probar"}
        </span>
        <h3>${esc(title)}</h3>
      </header>
      <div class="metric-figure">
        <span class="metric-n">${n}</span>
        ${of ? `<span class="metric-of">de ${of}</span>` : ""}
        ${unit ? `<span class="metric-unit">${esc(unit)}</span>` : ""}
        ${pct !== null ? `<span class="metric-pct">${pct}%</span>` : ""}
      </div>
      ${of ? `<div class="metric-bar" role="img" aria-label="${n} de ${of}">
                <div class="metric-bar-fill" style="width:${pct}%"></div>
              </div>` : ""}
      ${note ? `<p class="metric-note">${inline(note)}</p>` : ""}
      <footer class="metric-foot">
        <span class="metric-bad" title="La dirección mala. Una medida que no puede moverse hacia ella es un marcador, no una medida.">↓ mal: ${esc(bad)}</span>
        <span class="metric-src" title="Medido del registro, nunca recordado">${esc(source)}</span>
      </footer>
    </article>`;
}

// Las auditorías, que es lo único de este tablero que el modelo no puede calcular: sale de
// `metrics.py` a través de `/api/metrics`, **verbatim** (`interface:I3.1`).
// ⛔ Sin fuente NO se pinta un cero. Un cero aquí se leería como «ninguna auditoría ha
// encontrado nada», que es lo contrario de «no lo hemos medido» (`Aevifex:AX-36`).
function renderAuditMetrics() {
  const m = STATE.metrics;
  if (m === undefined) {
    return `<section class="dash-block"><div class="dash-block-head">
      <h2>Los roles y lo que encuentran</h2><p>Midiendo…</p></div></section>`;
  }
  if (!m.available) {
    return `<section class="dash-block"><div class="dash-block-head">
      <h2>Los roles y lo que encuentran</h2>
      <p>⛔ <strong>Sin fuente, y por eso no hay cifras aquí</strong> — un cero se leería como
         <em>ninguna auditoría encontró nada</em>, que es lo contrario de <em>no medido</em>.</p>
      </div>
      <div class="callout callout-warning"><span class="callout-icon">⚠️</span>
        <div class="callout-content">${inline(m.why || "sin razón declarada")}
        ${m.how ? `<br><code>${esc(m.how)}</code>` : ""}</div></div>
    </section>`;
  }
  const audits = (m.data && m.data.audits) || {};
  const roles = Object.keys(audits).sort();
  if (!roles.length) {
    return `<section class="dash-block"><div class="dash-block-head">
      <h2>Los roles y lo que encuentran</h2>
      <p>El script corre y no devuelve auditorías. <strong>Se dice, no se rellena.</strong></p>
      </div></section>`;
  }
  return `
    <section class="dash-block">
      <div class="dash-block-head">
        <h2>Los roles y lo que encuentran</h2>
        <p>Leído de <code>${esc(m.source || "el script declarado")}</code>, sin recalcular nada.
           <strong>Un rol se juzga por las ocasiones que lo justificaban contra las veces que se
           invocó</strong>, y un log vacío dice que las ocasiones no han llegado.</p>
      </div>
      <div class="dash-grid">
        ${roles.map(r => {
          const a = audits[r] || {};
          const st = a.by_status || {};
          const abiertos = Number(st.open || 0);
          const hallazgos = Number(a.findings || 0);
          const rep = a.repeat_rate_pct;
          return `
            ${metric({ purpose: "steer", title: `${r} — hallazgos sin cerrar`,
                       n: abiertos, of: hallazgos || null, unit: hallazgos ? "" : "hallazgos",
                       bad: "sube: se encuentra y no se arregla",
                       source: "metrics.py --json",
                       note: `**${a.firings || 0} firings.** ${Object.entries(st).map(([k, v]) =>
                         `\`${k}\` ${v}`).join(" · ") || "sin desglose"}` })}
            ${rep === undefined ? "" : metric({ purpose: "prove", title: `${r} — repetición`,
                       n: Number(a.repeats || 0), of: hallazgos || null,
                       bad: "sube: el mismo hallazgo vuelve, así que no se arregló la causa",
                       source: "metrics.py --json",
                       note: `**${rep} %** de los hallazgos son repeticiones. ⚠️ Una tasa de
                              repetición alta mide la corrección, no la auditoría.` })}`;
        }).join("")}
      </div>
    </section>`;
}

// ═══ La Biblioteca ═════════════════════════════════════════════════════════════════════
//
// La sala responde UNA pregunta (`interface:AX-10`): **qué sabe esta empresa**. Y su prueba
// es la de `I9`: *un día entero con esta pestaña abierta sin abrir el explorador; si se abre,
// falta una puerta.*
//
// ⛔ **Las decisiones de diseño, escritas para que se puedan cambiar** (`O2` · `AX-13`):
//
//   · **Dos columnas, con las estanterías siempre visibles.** No es decoración: si al abrir
//     una nota desaparece el mapa, cada nota es un callejón sin salida y se vuelve al
//     explorador — que es exactamente lo que esta sala existe para evitar.
//   · **La columna de lectura mide ~68 caracteres** (`--read-measure`). Es la decisión
//     tipográfica de mayor efecto y la más fácil de tocar: por encima de ~75 el ojo pierde
//     el principio de la línea al saltar, y esto es prosa que se lee, no una tabla que se
//     escanea.
//   · **Las estanterías van en el orden del router, no alfabético.** Los dominios están
//     numerados `01_`–`08_` porque ese orden lo decidió el operador; ordenarlos por nombre
//     tira esa información.
//   · **Cada estantería lleva su cuenta, incluidas las de uno.** Una estantería vacía es
//     información — `07_BigData` tiene una nota —, y esconderla es adular al vault.
//
// El tema Bodleian se afina encima de esto, con referencias. La estructura no lo espera.

// Section taxonomy comes only from the adapter; folders come from the document catalog.
function libraryLocation() {
  return {root: STATE.libShelf || '', folder: STATE.libFolder || '', path: STATE.libNote?.path || '',
    q: STATE.searchQ || '', anchor: STATE.libAnchor || '', all: Boolean(STATE.libSearchAll), searchRoot:STATE.libSearchRoot || ""};
}
function libFiles(root) { return (STATE.tree?.files || []).filter(f => f.root === root); }
function libraryFiles() {
  const roots = new Set((STATE.tree?.sections || []).map(s => s.root));
  return (STATE.tree?.files || []).filter(f => roots.has(f.root));
}
function sectionLabel(root) { return STATE.tree?.sections?.find(s => s.root === root)?.label || root; }
function folderLabel(name) { return name.replace(/^\d+(?:[._]\d+)*[-_]?/, '').replace(/[-_]/g, ' ').trim() || name; }
window.openShelf = function(root, folder = '') { location.hash = Library.route({root, folder}); };
window.openNote = function(root, path) { location.hash = Library.route({root, path, q: STATE.searchQ || '', all: STATE.libSearchAll, searchRoot:STATE.libSearchRoot}); };
window.closeNote = window.backToHits = function() {
  const loc = libraryLocation(); location.hash = Library.route({...loc, path: '', anchor: ''});
};
window.clearSearch = function() { location.hash = Library.route({root: STATE.libShelf || ''}); };
window.librarySearch = function(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const q = form.elements.query.value.trim(), root = form.elements.scope.value;
  location.hash = Library.route({root: root === '*' ? '' : root, q});
};
window.libraryLayout = function(layout) { STATE.libLayout = layout; renderView(); };
window.libraryMore = function() { STATE.libLimit = (STATE.libLimit || 24) + 24; renderView(); };
function libraryLink(text, loc, className = '') {
  return `<a class="${className}" href="${esc(Library.route(loc))}">${esc(text)}</a>`;
}
function libraryBreadcrumb(root, folder, note) {
  let html = libraryLink('Biblioteca', {});
  if (root) html += ' <span>/</span> ' + libraryLink(sectionLabel(root), {root});
  const parts = (folder || (note ? note.split('/').slice(0, -1).join('/') : '')).split('/').filter(Boolean);
  parts.forEach((part, i) => { html += ' <span>/</span> ' + libraryLink(folderLabel(part), {root, folder: parts.slice(0, i + 1).join('/')}); });
  return `<nav class="library-breadcrumb" aria-label="Ruta de lectura">${html}</nav>`;
}
function renderLibrary(container) {
  const t = STATE.tree;
  if (!t) { container.innerHTML = '<p class="library-status" role="status">Abriendo la biblioteca…</p>'; return; }
  if (!t.available) { container.innerHTML = `<p class="library-status">${esc(t.why)} <button onclick="loadTree()">Reintentar</button></p>`; return; }
  const loc = libraryLocation(), sections = t.sections || [], files = libraryFiles();
  const note = loc.path ? (STATE.notes || {})[Library.key({root: loc.root, path: loc.path})] : null;
  // Unrelated model loads must not replace a document or rerun its diagrams.
  const signature = JSON.stringify([loc, STATE.libraryRevision, note?.version, note?.error, note?.body === undefined ? note?.loading : false, STATE.search, STATE.libLayout, STATE.libLimit]);
  if (container.dataset.librarySignature === signature && container.querySelector('.library-browser')) return;
  container.dataset.librarySignature = signature;
  const header = `<header class="library-header"><div><h1>Biblioteca</h1><p>${files.length} documentos · ${sections.length} secciones</p></div>
    <form class="library-search" onsubmit="librarySearch(event)" role="search" aria-label="Buscar documentos">
      <label class="sr-only" for="library-query">Título, alias o texto</label><input id="library-query" name="query" type="search" placeholder="Buscar un tema, título o frase…" value="${esc(loc.q)}" minlength="2" required>
      <label class="sr-only" for="library-scope">Dónde buscar</label><select id="library-scope" name="scope"><option value="*">Toda la biblioteca</option>${sections.map(s => `<option value="${esc(s.root)}" ${loc.root === s.root ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select><button type="submit">Buscar</button>
    </form></header>`;
  let body;
  if (loc.path) body = renderNote();
  else if (loc.q) body = renderSearchHits();
  else if (loc.root) body = renderShelf(loc.root);
  else body = `${referenceLinks("library")}<div class="library-intro"><h2>¿Qué quieres consultar?</h2><p>Elige una sección y después un tema, o busca directamente un documento.</p></div>
    <div class="library-sections">${sections.map(s => {
      const fs = libFiles(s.root), group = Library.groups(fs, s.root);
      const preview = group.folders.map(f => folderLabel(f.name)).slice(0, 3).join(' · ');
      return `<a data-live-key="${esc(s.root)}" class="library-section" href="${esc(Library.route({root:s.root}))}"><span class="library-section-count">${fs.length} ${fs.length === 1 ? "documento" : "documentos"}</span><h2>${esc(s.label)}</h2><p>${esc(preview || fs.slice(0, 2).map(Library.title).join(' · '))}</p><span class="library-section-open">Explorar →</span></a>`;
    }).join('')}</div>${sections.length ? '' : '<p>No hay secciones de biblioteca declaradas en el adaptador.</p>'}`;
  paintView(container, `<div class="library-browser">${header}${body}</div>`);
  if (loc.path && note?.body !== undefined) {
    container.querySelectorAll('[data-reference]').forEach(link => link.onclick = event => {
      event.preventDefault();
      const panel = document.getElementById('library-references');
      if (panel) panel.open = true;
      document.getElementById('library-reference-' + link.dataset.reference)?.scrollIntoView({block:'center'});
    });
    enhanceLibraryDiagrams(container);
  }
}
function renderShelf(root) {
  const folder = STATE.libFolder || '', {docs, folders} = Library.groups(STATE.tree.files, root, folder);
  const limit = STATE.libLimit || 24, layout = STATE.libLayout || 'list';
  return `${libraryBreadcrumb(root, folder)}<div class="library-intro"><h2>${esc(folder ? folderLabel(folder.split('/').pop()) : sectionLabel(root))}</h2><p>${folders.length ? 'Elige un tema para ver sus documentos.' : `${docs.length} documentos en este tema.`}</p></div>
    ${folders.length ? `<div class="library-subjects">${folders.map(f => `<a href="${esc(Library.route({root, folder:f.path}))}"><strong>${esc(folderLabel(f.name))}</strong><span>${f.count} ${f.count === 1 ? "documento" : "documentos"} →</span></a>`).join('')}</div>` : ''}
    ${docs.length ? `<div class="library-list-heading"><h3>${folders.length ? 'Documentos generales de la sección' : 'Documentos'}</h3><div role="group" aria-label="Presentación de documentos"><button aria-pressed="${layout === 'list'}" onclick="libraryLayout('list')">Lista</button><button aria-pressed="${layout === 'books'}" onclick="libraryLayout('books')">Lomos</button></div></div>
    ${layout === 'books' ? `<div class="shelf"><div class="shelf-books">${docs.slice(0, limit).map(f => book(root, f)).join('')}</div><div class="shelf-plank"></div></div>` : `<div class="library-documents">${docs.slice(0, limit).map(f => `<a data-live-key="${esc(f.path)}" class="library-document" href="${esc(Library.route({root, path:f.path}))}"><span class="library-document-spine" aria-hidden="true" style="width:${Math.min(18, 5 + Math.sqrt(f.bytes / 1024))}px"></span><span><strong>${esc(Library.title(f))}</strong><small>${esc(f.path.split('/').pop())} · ${Math.max(1, Math.round(f.bytes / 1024))} KB</small></span><span aria-hidden="true">↗</span></a>`).join('')}</div>`}
    ${docs.length > limit ? `<button class="library-more" onclick="libraryMore()">Mostrar más (${docs.length - limit} restantes)</button>` : ''}` : !folders.length ? '<p>No hay documentos en esta ubicación.</p>' : ''}`;
}
function renderSearchHits() {
  const q = STATE.searchQ || '', root = STATE.libShelf || '', all = STATE.libSearchAll;
  const catalog = (all ? STATE.tree.files : libraryFiles()).filter(f => !root || f.root === root);
  const titleMatches = catalog.filter(f => Library.normalize([Library.title(f), f.path, ...(f.aliases || [])].join(' ')).includes(Library.normalize(q)));
  const result = STATE.search, matches = new Map(titleMatches.map(f => [Library.key(f), {file:f, title:true}]));
  for (const hit of result?.hits || []) {
    const file = catalog.find(f => f.root === hit.root && f.path === hit.path);
    if (file && !matches.has(Library.key(file))) matches.set(Library.key(file), {file, hit});
  }
  return `${libraryBreadcrumb(root)}<div class="library-intro"><h2>Resultados para «${esc(q)}»</h2><p>${matches.size} documentos${all ? ' · todas las carpetas navegables' : root ? ' · ' + esc(sectionLabel(root)) : ' · toda la biblioteca'}${result?.loading ? ' · buscando en el texto…' : ''}</p>${libraryLink('Limpiar búsqueda', {root})}</div>
    ${result?.error ? `<p role="alert">La búsqueda en el texto ha fallado: ${esc(result.error)}. Se muestran coincidencias por título. <button onclick="loadSearch(STATE.searchQ)">Reintentar</button></p>` : ''}
    ${result?.capped ? '<p>Hay más resultados de texto. Afina la búsqueda para acotarlos.</p>' : ''}
    <div class="library-results">${[...matches.values()].map(({file, hit}) => `<a href="${esc(Library.route({root:file.root, path:file.path, q, all, searchRoot:root}))}"><strong>${esc(Library.title(file))}</strong><small>${esc(sectionLabel(file.root))} · ${esc(file.path)}</small>${hit ? `<p>${esc(hit.text)}</p>` : ''}</a>`).join('')}</div>
    ${!matches.size && !result?.loading ? '<p>No se han encontrado documentos. Prueba otra palabra o amplía la sección.</p>' : ''}`;
}
function renderNote(options = {}) {
  const loc = options.location || libraryLocation(), link = options.link || libraryLink;
  const {root, path} = options.note || STATE.libNote, key = Library.key({root, path});
  const file = STATE.tree.files.find(f => f.root === root && f.path === path);
  const n = (STATE.notes || {})[key];
  if (!n || n.stale) setTimeout(() => loadNote(root, path), 0);
  const top = options.top ?? libraryBreadcrumb(root, '', path) + (STATE.searchQ ? libraryLink('← Volver a los resultados', {root:STATE.libSearchRoot || '', q:STATE.searchQ, all:STATE.libSearchAll}, 'library-return') : '');
  if (n?.body === undefined) return `${top}<p class="library-status" role="status">${n?.error ? esc(n.error) : 'Abriendo documento…'}</p>${n?.error ? `<button onclick="loadNote(${jsq(root)},${jsq(path)},true)">Reintentar</button>` : ''}`;
  const source = splitFrontmatter(n.body);
  const cache = options.cache || 'rendered';
  const rendered = n[cache] || (n[cache] = Library.render(source.body, {root,path}, STATE.tree.files, globalThis, {...options.navigation, lineOffset:n.body.slice(0,n.body.length-source.body.length).split('\n').length-1}));
  const missingAnchor = loc.anchor && !rendered.outline.some(h => h.id === "note-heading-" + Library.slug(loc.anchor));
  return `${top}<div class="library-reading-layout"><aside class="library-outline"><details id="library-outline"><summary>En este documento <span>${rendered.outline.length}</span></summary><nav aria-label="Índice del documento">${rendered.outline.map(h => link(h.text, {...loc, anchor:h.anchor, line:0}, `outline-level-${h.level}`)).join('')}</nav></details></aside>
    <div class="library-paper">${missingAnchor ? `<p id="library-missing-anchor" class="library-format-note" role="alert">No se encuentra el apartado «${esc(loc.anchor)}» en este documento. Usa su índice para elegir un apartado actual.</p>` : ''}${n.error ? `<p role="alert">No se ha podido actualizar: ${esc(n.error)}. Se conserva la última lectura.</p>` : ''}
    <div class="library-source-name">${esc(file?.path || path)}</div>${renderMeta(source.meta)}
    <article class="note-prose" aria-label="Contenido del documento">${rendered.html || '<p>Este documento está vacío.</p>'}</article>
    ${rendered.html.includes('class="katex-error"') ? '<p class="library-format-note">Alguna fórmula contiene sintaxis que no se puede representar. Se muestra su texto original.</p>' : ''}
    ${rendered.problems.length ? `<details id="library-references" class="library-references"><summary>${rendered.problems.length} referencias sin destino único</summary><p>Estos enlaces necesitan un destino existente o una ruta más precisa en el documento original.</p>${rendered.problems.map((p,i) => `<div id="library-reference-${i}"><strong>${esc(p.target)}</strong><p>${p.kind === 'ambiguous' ? 'Hay varios documentos con ese nombre:' : 'No se encuentra en las carpetas navegables.'}</p>${(p.matches || []).map(f => `<a href="${esc((options.navigation?.noteRoute || Library.route)({root:f.root,path:f.path,anchor:p.anchor}))}">${esc(sectionLabel(f.root))} / ${esc(f.path)}</a>`).join('')}</div>`).join('')}</details>` : ''}
    <details id="library-source" class="library-original"><summary>Ver Markdown original</summary><pre><code>${esc(n.body)}</code></pre></details></div></div>`;
}
let mermaidLoader;
const libraryDiagramCache = new Map();
let diagramSequence = 0;
async function enhanceLibraryDiagrams(container) {
  const figures = [...container.querySelectorAll('.note-diagram')].filter(figure => !figure.querySelector('.diagram-output[aria-busy="false"]'));
  if (!figures.length) return;
  const location = STATE.currentView === 'notebook' ? notebookLocation() : libraryLocation();
  const readingRoute = STATE.currentView === 'notebook' ? Notebook.route({...location,anchor:''}) : STATE.currentView === "inbox" ? Mailbox.route(mailboxLocation()) : Library.route({...location, anchor:""});
  const isLibrary = ['library','notebook'].includes(STATE.currentView);
  const intendedScroll = PROJECT_READING[readingRoute]?.scroll;
  const needsAnchor = isLibrary && location.anchor && container.dataset.anchor !== `${readingRoute}/${location.anchor}`;
  let interacted = false;
  const interaction = () => { interacted = true; };
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  events.forEach(name => container.addEventListener(name, interaction, {passive:true}));
  mermaidLoader ||= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'vendor/mermaid/mermaid.min.js';
    script.onload = () => { window.mermaid.initialize({startOnLoad:false, securityLevel:'strict', theme:'neutral', suppressErrorRendering:true, maxTextSize:100000}); resolve(window.mermaid); };
    script.onerror = () => { mermaidLoader = null; reject(new Error('No se ha podido cargar el lector de diagramas.')); };
    document.head.appendChild(script);
  });
  try { for (const [index, figure] of figures.entries()) {
    const output = figure.querySelector('.diagram-output'), source = figure.querySelector('code').textContent;
    try {
      const cacheKey = JSON.stringify([STATE.libNote, index, source]);
      let svg = libraryDiagramCache.get(cacheKey);
      if (!svg) {
        const mermaid = await mermaidLoader;
        if (!figure.isConnected) break;
        // Rendering is serialized by Mermaid; keep source directives from changing security settings.
        const result = await mermaid.render('library-diagram-' + (++diagramSequence), source);
        svg = result.svg; libraryDiagramCache.set(cacheKey, svg);
        if (libraryDiagramCache.size > 80) libraryDiagramCache.delete(libraryDiagramCache.keys().next().value);
      }
      if (figure.isConnected) {
        output.innerHTML = svg; output.setAttribute('aria-busy','false');
        const enlarge = document.createElement('button');
        enlarge.className = 'diagram-enlarge'; enlarge.textContent = 'Ampliar diagrama';
        enlarge.onclick = () => openLibraryDiagram(output.querySelector('svg'));
        figure.appendChild(enlarge);
      }
    } catch {
      if (figure.isConnected) { output.textContent = 'No se ha podido representar este diagrama. Su código está disponible debajo.'; output.setAttribute('aria-busy','false'); figure.querySelector('details').open = true; }
    }
  } } finally {
    events.forEach(name => container.removeEventListener(name, interaction));
    // Diagram layout is asynchronous. Restore only if the reader has not started interacting.
    queueMicrotask(() => {
      if (interacted || container.dataset.route !== readingRoute || !figures[0].isConnected) return;
      const heading = needsAnchor && (document.getElementById('note-heading-' + Library.slug(location.anchor)) || document.getElementById('library-missing-anchor'));
      if (heading) heading.scrollIntoView({block:'start'});
      else if (intendedScroll != null) container.scrollTop = intendedScroll;
      rememberProjectReading(container);
    });
  }
}

function openLibraryDiagram(svg) {
  if (!svg) return;
  const dialog = document.createElement('dialog'); dialog.className = 'library-diagram-dialog';
  dialog.setAttribute('aria-label', 'Diagrama ampliado');
  const close = document.createElement('button'); close.textContent = 'Cerrar diagrama';
  close.onclick = () => dialog.close();
  const canvas = document.createElement('div'); canvas.className = 'library-diagram-canvas';
  const enlarged = svg.cloneNode(true);
  enlarged.style.width = Math.max(1000, svg.viewBox.baseVal.width) + 'px';
  enlarged.style.maxWidth = 'none';
  canvas.appendChild(enlarged); dialog.append(close, canvas); document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove(), {once:true}); dialog.showModal();
}

// Un lomo. ⛔ **Alto y ancho salen del tamaño real de la nota**, no de un aleatorio: un
// estante en el que los libros gordos se ven gordos dice algo verdadero de un vistazo, y uno
// con medidas inventadas es decoración que además miente.
//   · ancho  22–52 px sobre el tamaño en KB — el ancho es el que se percibe como «grosor»
//   · alto   76–100 % del estante, por el título — variar el alto es lo que hace que un
//            estante parezca un estante y no una barra de progreso
//   · color  el tono de la materia, en pasos del mismo token; **una sola familia**, porque
//            ocho paletas es lo que `AX-11` prohíbe
function book(root, f) {
  const kb = Math.max(1, Math.round(f.bytes / 1024));
  const ancho = Math.min(52, 22 + Math.round(Math.sqrt(kb) * 4));
  const largo = (f.title || f.path).length;
  // ⛔ Esto era `76 + (largo % 25)`, y el módulo destruía exactamente la relación que el
  // comentario de arriba afirmaba: un título de 26 caracteres salía más bajo que uno de 24.
  // **Ahora es monótono** — más título, más alto —, acotado para que el estante siga siendo
  // un estante. Un título que aun así no cabe se corta con puntos suspensivos, que es honesto.
  const alto = Math.min(100, Math.max(66, 52 + largo * 1.5));
  const tono = ((root.charCodeAt(0) * 7 + root.length * 3 + largo) % 5) + 1;
  const titulo = f.title || f.path.split("/").pop().replace(/\.md$/, "");
  return `
    <button class="book tone-${tono}" style="--w:${ancho}px;--h:${alto}%"
            title="${esc(titulo)} · ${kb} KB"
            onclick="openNote(${jsq(root)}, ${jsq(f.path)})">
      <span class="book-spine">${esc(titulo)}</span>
      <span class="book-foot">${kb}</span>
    </button>`;
}

// ⛔ El frontmatter YAML se pintaba como si fuera texto, así que **cada nota del vault abría
// con un bloque de `tags:`, `aliases:` y `status:`** antes de su primera frase. Obsidian lo
// esconde, y ésa era una de las razones concretas para seguir abriéndolo.
// ⚠️ No se esconde: se **saca del flujo de lectura**. Las etiquetas son útiles para saber de
// qué va una nota; lo que no puede es competir con la primera línea de prosa.
function splitFrontmatter(md) {
  const t = String(md || "");
  const front = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(t);
  if (!front) return {meta:null, body:t};
  const crudo = front[1], resto = t.slice(front[0].length);
  // The metadata panel accepts simple fields and lists; unrecognized YAML stays visible.
  const campos = [];
  let clave = null;
  for (const ln of crudo.split("\n")) {
    const m = ln.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) { clave = { k: m[1], v: m[2].trim() ? [m[2].trim()] : [] }; campos.push(clave); }
    else if (clave && /^\s*-\s+/.test(ln)) clave.v.push(ln.replace(/^\s*-\s+/, "").trim());
    else if (ln.trim()) campos.push({ k: "", v: [ln.trim()] });
  }
  return { meta: campos.filter(c => c.v.length), body: resto };
}

function renderMeta(meta) {
  if (!meta || !meta.length) return "";
  return `
    <details class="note-meta">
      <summary>
        ${meta.filter(c => /tag/i.test(c.k)).flatMap(c => c.v).slice(0, 6)
             .map(v => `<span class="meta-tag">${esc(v)}</span>`).join("")
          || `<span class="meta-tag meta-tag-none">sin etiquetas</span>`}
        <span class="meta-more">${meta.length} campos</span>
      </summary>
      <dl>${meta.map(c => `
        <dt>${esc(c.k || "—")}</dt><dd>${c.v.map(v => esc(v)).join(" · ")}</dd>`).join("")}</dl>
    </details>`;
}

function renderDashboard(container) {
  const ax = D().axioms;
  const clauses = D().clauses.filter(c => !c.objective);
  const total = ax.length;
  const by = s => ax.filter(a => a.check_state === s).length;
  const runnable = by("$"), owed = by("owed"), none = by("none");

  // Filas del gráfico: una por cláusula, segmentadas por cuánto se hace cumplir.
  const rows = clauses.map(c => {
    const mine = axiomsOf(c.id);
    const seg = ENFORCE_ORDER.map(k => ({ k, n: mine.filter(a => a.check_state === k).length }));
    return { id: c.id, title: c.title, total: mine.length, seg,
             cov: coverageOf(c.id), enforced: seg[0].n };
  });
  const widest = Math.max(1, ...rows.map(r => r.total));

  // ⚠️ Los axiomas que sirven a dos cláusulas cuentan en las dos, así que las filas suman
  // más que el total. Decirlo es parte de la medida; callarlo la invalida.
  const rowSum = rows.reduce((s, r) => s + r.total, 0);

  // Lo que el registro vivo puede responder hoy, sin instrumentar nada más.
  const mbAll = STATE.mailbox || [];
  const mbOpen = mbAll.filter(e => Mailbox.isPending(e)).length;
  const plan = STATE.livePlan || [];
  const planRouted = plan.filter(i => i.struck || i.outcome).length;
  const planDiscarded = plan.filter(i => i.outcome === "discarded").length;
  const tasks = STATE.tasks || [];
  const tasksWithProject = tasks.filter(t => t.project && t.project !== "cross").length;
  const probs = (STATE.problems || []).length;
  const covMismatch = rows.filter(r => r.cov && r.cov.count !== String(r.total));

  paintView(container, `
    <div class="view-header">
      <div class="view-title-group">
        <h1><span>📐</span> Dashboard <span class="clause-chip tone-cyan" onclick="openClause('PH-6')">PH-6 · Measurement</span></h1>
        <p class="view-subtitle">
          Cada medida declara <strong>a cuál de los dos propósitos sirve</strong> —
          <em>gobernar</em>, si al moverse cambia una decisión, o <em>probar</em>, si es evidencia
          para quien no tiene motivos para creernos. Todo lo de aquí se lee del registro; nada se
          recuerda.
        </p>
      </div>
    </div>

    <section class="dash-block">
      <div class="dash-block-head">
        <h2>Hasta dónde se hacen cumplir las reglas</h2>
        <p>Un axioma sin check es una regla que nadie comprueba. Ésta es la medida que más
           fácilmente se disfraza: la exactitud de un check puede mantenerse perfecta mientras su
           cobertura se hunde, y sólo el denominador lo enseña.</p>
      </div>

      <div class="metric-row">
        ${metric({ purpose: "prove", title: "Axiomas con check que se ejecuta",
                   n: runnable, of: total, source: "AXIOMS.md · columna Check",
                   bad: "baja al añadir axiomas sin check",
                   note: "La única de las tres que **puede bajar**, y por eso es la que se mira." })}
        ${metric({ purpose: "steer", title: "Checks en deuda", n: owed, of: total,
                   source: "AXIOMS.md · marca `⊘`", tone: "metric-warn",
                   bad: "sube",
                   note: "`AX-7` roto **y declarado**. Cada uno es una deuda con dirección." })}
        ${metric({ purpose: "prove", title: "Axiomas sin check ninguno", n: none, of: total,
                   source: "AXIOMS.md · marca `—`",
                   bad: "sube",
                   note: "El vacío honesto. No es un fallo por sí solo — es el techo de lo que hoy se puede verificar." })}
      </div>

      <figure class="chart">
        <figcaption class="chart-title">Axiomas por cláusula, según cuánto se hacen cumplir</figcaption>
        <div class="chart-legend">
          ${ENFORCE_ORDER.map(k => `
            <span class="lg-item" title="${ENFORCE[k].hint}">
              <span class="lg-swatch" style="background:${ENFORCE[k].step}"></span>
              <span class="lg-icon">${ENFORCE[k].icon}</span> ${ENFORCE[k].label}
            </span>`).join("")}
        </div>
        <div class="chart-rows">
          ${rows.map(r => `
            <div class="chart-row">
              <button class="cr-label ${CLAUSE_TONE[r.id] || ""}" onclick="openClause(${jsq(r.id)})"
                      title="Abrir ${r.id} · ${esc(r.title)}">
                <span class="cr-id">${r.id}</span>
                <span class="cr-title">${esc(r.title)}</span>
              </button>
              <div class="cr-track">
                ${r.seg.filter(s => s.n).map(s => `
                  <span class="cr-seg" style="width:${s.n / widest * 100}%; background:${ENFORCE[s.k].step}; color:${ENFORCE[s.k].ink}"
                        title="${r.id} · ${s.n} ${ENFORCE[s.k].label} — ${ENFORCE[s.k].hint}">
                    ${s.n >= 2 ? `<span class="cr-seg-n">${ENFORCE[s.k].icon} ${s.n}</span>` : ""}
                  </span>`).join("")}
              </div>
              <span class="cr-total">${r.total}</span>
            </div>`).join("")}
        </div>
        <figcaption class="chart-note">
          Las filas suman <strong>${rowSum}</strong> y los axiomas son <strong>${total}</strong>:
          uno que sirve a dos cláusulas cuenta en las dos. Leído de
          <code>AXIOMS.md</code> fila a fila, no de la tabla de cobertura.
          ${covMismatch.length ? `
            <span class="chart-flag">⚠️ ${covMismatch.length} cláusula${covMismatch.length > 1 ? "s no cuadran" : " no cuadra"}
              con la tabla de cobertura: ${covMismatch.map(r => `${r.id} (tabla ${esc(r.cov.count)}, filas ${r.total})`).join(" · ")}.
              La tabla se regenera, nunca se transcribe (<code>AX-2</code>).</span>`
            : `<span class="chart-ok">✓ Cuadra con la tabla de cobertura de <code>AXIOMS.md</code> en las ${rows.length} cláusulas.</span>`}
        </figcaption>
      </figure>
    </section>

    ${renderAuditMetrics()}

    <section class="dash-block">
      <div class="dash-block-head">
        <h2>El registro vivo</h2>
        <p>Lo que la centralita conectada puede responder ahora mismo. Si no hay adaptador, estas
           medidas salen a cero — y un cero aquí significa <em>no medido</em>, no <em>bien</em>.</p>
      </div>
      <div class="metric-row">
        ${metric({ purpose: "steer", title: "Buzón sin cerrar", n: mbOpen, of: mbAll.length || 0,
                   source: "MAILBOX.md", bad: "sube y se queda",
                   tone: mbOpen > 0 ? "metric-warn" : "",
                   note: "Un buzón que entra lleno y sale lleno significa que la sesión no cerró nada." })}
        ${metric({ purpose: "steer", title: "Items del plan enrutados", n: planRouted, of: plan.length,
                   source: "PLAN.md", bad: "se estanca con el plan abierto",
                   note: "Un item tachado sin destino es un cierre fallido y el parser lo reporta." })}
        ${metric({ purpose: "prove", title: "Items descartados **con su motivo**",
                   n: planDiscarded, of: plan.length, source: "PLAN.md · destino `discarded`",
                   bad: "cae a cero — un registro sin descartes es un registro sin auditar",
                   note: "La cuenta poco favorecedora es **parte** de la medida, no un apéndice." })}
        ${metric({ purpose: "prove", title: "Tareas con `project:` propio",
                   n: tasksWithProject, of: tasks.length, source: "TASKS.md",
                   bad: "baja", note: "El campo del que dependen todos los filtros y que nada más puede inferir." })}
        ${metric({ purpose: "steer", title: "Entradas que el parser no supo colocar", n: probs,
                   source: "/api/model · problems", bad: "sube", tone: probs ? "metric-warn" : "",
                   note: "Un parser que descarta lo que no entiende convierte un registro sin pérdidas en uno con ellas, sin decirlo." })}
      </div>
    </section>

    <section class="dash-block">
      <div class="dash-block-head">
        <h2>Lo que todavía no se mide</h2>
        <p>Nombrado aquí en lugar de omitido. <strong>Un hueco declarado es una deuda con
           dirección; un hueco callado es una métrica que nadie echa de menos.</strong></p>
      </div>
      <div class="gap-list">
        ${[
          ["Hallazgos de auditoría aceptados sobre propuestos",
           "Necesita que cada auditoría escriba su resultado como registro, no como prosa en el informe de sesión."],
          ["Coste de atención por tarea",
           "`PH-5` dice que se mide, no que se sienta. Falta el dato: qué se cargó para hacer lo siguiente."],
          ["Decisiones retomadas",
           "Una decisión que vuelve como debate abierta es la señal de que su porqué no se escribió."],
          ["Vida media de una entrada de buzón",
           "Cuánto tarda en enrutarse. Necesita fecha de entrada y de salida; hoy sólo hay la de entrada."],
          ["Qué medida no ha cambiado nunca una decisión",
           "`PH-6` retira medidas con la misma facilidad con la que las añade, y ésta es la pregunta que lo hace."]
        ].map(([t, why]) => `
          <div class="gap-row">
            <span class="gap-mark">○</span>
            <div><strong>${esc(t)}</strong><span>${inline(why)}</span></div>
          </div>`).join("")}
      </div>
      <div class="callout callout-note">
        <span class="callout-icon">🧊</span>
        <div class="callout-content">
          <strong>Este panel está a medias a propósito.</strong> Sólo se pinta lo que sale del
          registro tal como está hoy. Cuando una medida nueva tenga su dato escrito en el momento
          en que ocurre — que es lo que <code>PH-6</code> exige y <code>PH-3</code> paga —
          entra aquí; hasta entonces vive en la lista de arriba.
        </div>
      </div>
    </section>`);
}


// ═════════════════════════════════════════════════════════════════════════════
// LEER UNA SECCIÓN CONCRETA DE UN FICHERO TRONCAL
//
// ⛔ La portada enseña la tabla de enrutado y el orden del cierre. Ninguna de las dos se
// teclea aquí: se sacan de `METHOD.md` por su encabezado, así que cambiar el método cambia
// la portada. Copiarlas sería exactamente lo que le pasó a la filosofía — una segunda copia
// con aspecto de autoridad que deriva sin que nada lo diga (`AX-20`).
// ═════════════════════════════════════════════════════════════════════════════

function docBody(id) {
  return (D().docs.find(d => d.id === id) || {}).body || "";
}

// Las líneas bajo un encabezado, hasta el siguiente del mismo nivel o superior.
function docSection(id, headingPrefix) {
  const lines = docBody(id).split("\n");
  const norm = s => s.toLowerCase().replace(/[`*]/g, "").trim();
  const want = norm(headingPrefix);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    if (start === -1 && norm(m[2]).startsWith(want)) { start = i + 1; level = m[1].length; continue; }
    if (start !== -1 && m[1].length <= level) return lines.slice(start, i);
  }
  return start === -1 ? [] : lines.slice(start);
}

// La primera tabla markdown de un bloque de líneas, como filas de celdas.
// ⚠️ Devuelve la cabecera aparte: leer por posición es lo que hace que una columna
// insertada mueva todos los campos en silencio, y aquí la cabecera es el contrato.
function mdTable(lines) {
  const rows = [];
  let header = null;
  for (const ln of lines) {
    const t = ln.trim();
    if (!t.startsWith("|")) { if (rows.length) break; else continue; }
    if (/^\|[\s:|-]+\|$/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    if (!header) header = cells; else rows.push(cells);
  }
  return { header, rows };
}
