// Design data stays in this preview. No administrative API requests are made here.
const users = [
  { id: 'maya', name: 'maya.chen', role: 'Admin', state: 'Active', knowledge: true, joined: '2025-04-12' },
  { id: 'liam', name: 'liam.wu', role: 'User', state: 'Active', knowledge: true, joined: '2025-05-03' },
  { id: 'sophie', name: 'sophie.ramos', role: 'User', state: 'Pending', knowledge: false, joined: '2025-06-18' },
  { id: 'alex', name: 'alex.johnson', role: 'User', state: 'Active', knowledge: true, joined: '2025-02-21' },
  { id: 'jordan', name: 'jordan.kim', role: 'User', state: 'Disabled', knowledge: true, joined: '2025-03-11' },
];
const projects = [
  { id: 'northstar', name: 'Northstar validation', owner: 'maya', size: 42, folders: 18, files: 2431, runtime: '2 connected', state: 'Healthy', updated: '2 min ago', editors: 4, retention: 90, entries: [['evidence', 1144, 18], ['runs', 824, 15], ['artifacts', 463, 9]] },
  { id: 'atlas', name: 'Atlas migration', owner: 'liam', size: 31, folders: 11, files: 1824, runtime: '1 connected', state: 'Healthy', updated: '18 min ago', editors: 2, retention: 90, entries: [['migrations', 702, 14], ['deploy', 541, 10], ['reports', 581, 7]] },
  { id: 'signal', name: 'Signal archive', owner: 'alex', size: 29, folders: 27, files: 4912, runtime: 'Stale', state: 'Stale', updated: 'yesterday', editors: 3, retention: 30, entries: [['raw', 2801, 16], ['processed', 1520, 9], ['archive', 591, 4]] },
  { id: 'release', name: 'Release evidence', owner: 'maya', size: 18, folders: 9, files: 684, runtime: '1 connected', state: 'Healthy', updated: 'yesterday', editors: 5, retention: 180, entries: [['artifacts', 312, 11], ['signoff', 203, 4], ['archive', 169, 3]] },
  { id: 'agents', name: 'Agent experiments', owner: 'maya', size: 12, folders: 6, files: 211, runtime: 'None', state: 'Idle', updated: '4 days ago', editors: 2, retention: 30, entries: [['notebooks', 96, 7], ['runs', 88, 4], ['notes', 27, 1]] },
];
const events = [
  { id: 'req_7a2c91', time: '10:42:18', ago: '2 min ago', user: 'maya', project: 'northstar', tool: 'samplemanager_diagnose', target: '/evidence/run-42', result: 'Succeeded', duration: '842 ms', access: 'Read + execute' },
  { id: 'req_2b4d60', time: '10:26:03', ago: '18 min ago', user: 'liam', project: 'atlas', tool: 'list_workspace_files', target: '/deploy/scripts', result: 'Succeeded', duration: '122 ms', access: 'Read only' },
  { id: 'req_9f1e24', time: '09:59:41', ago: '41 min ago', user: 'sophie', project: null, tool: 'account.request', target: 'Workspace access', result: 'Pending', duration: '—', access: 'Account request' },
  { id: 'req_4a8c32', time: '09:14:27', ago: '1 h ago', user: 'alex', project: 'signal', tool: 'project_create', target: '/', result: 'Succeeded', duration: '1.2 s', access: 'Write' },
  { id: 'req_6d3e58', time: '08:48:11', ago: '2 h ago', user: 'maya', project: 'release', tool: 'knowledge_search', target: '/artifacts/index', result: 'Timeout', duration: '5.0 s', access: 'Read only' },
];
const resources = [
  { id: 'agent-northstar-01', name: 'Northstar agent', type: 'Agent', owner: 'maya', projects: ['northstar', 'release'], heartbeat: '42 sec ago', state: 'Online', detail: 'Agent is accepting requests.' },
  { id: 'ssh-atlas-prod', name: 'Atlas SSH', type: 'Server', owner: 'liam', projects: ['atlas'], heartbeat: '1 min ago', state: 'Online', detail: 'SSH probe completed successfully.' },
  { id: 'lab-legacy-02', name: 'Legacy lab', type: 'Instance', owner: 'alex', projects: ['signal'], heartbeat: '14 min ago', state: 'Probe pending', detail: 'No recent heartbeat. Probe the instance before changing access.' },
  { id: 'worker-evidence-03', name: 'Evidence worker', type: 'Instance', owner: 'maya', projects: ['release'], heartbeat: '3 min ago', state: 'Drift', detail: 'Expected image v12; reported image v11.' },
  { id: 'runner-pool-01', name: 'Unassigned runner', type: 'Agent', owner: null, projects: [], heartbeat: '7 min ago', state: 'Needs owner', detail: 'Assign an owner before linking projects.' },
];
const systems = [
  { id: 'api', name: 'Web API', kind: 'Service', endpoint: 'api:5173', latency: '42 ms', state: 'Nominal', usage: null, measure: '—', checked: '10:43:10', detail: 'HTTP request handling is available.', history: 'Health check passed at 10:43:10.' },
  { id: 'database', name: 'SQLite database', kind: 'Service', endpoint: 'relay.db', latency: '18 ms', state: 'Nominal', usage: null, measure: '—', checked: '10:43:09', detail: 'Integrity and migration checks passed.', history: 'Integrity check completed at 10:43:09.' },
  { id: 'mcp', name: 'MCP listener', kind: 'Service', endpoint: '/mcp', latency: '64 ms', state: 'Nominal', usage: null, measure: '—', checked: '10:43:10', detail: 'Streamable HTTP listener is available.', history: 'Listener check passed at 10:43:10.' },
  { id: 'knowledge', name: 'Knowledge engine', kind: 'Service', endpoint: 'knowledge-worker', latency: '410 ms', state: 'Indexing', usage: 82, measure: '82% indexed', checked: '10:42:52', detail: '42 sources remain in the indexing queue.', history: 'Indexing started 18 min ago.' },
  { id: 'workers', name: 'Background workers', kind: 'Service', endpoint: 'worker-pool', latency: '—', state: 'Nominal', usage: null, measure: '12 queued', checked: '10:43:05', detail: '12 jobs queued; 4 have waited longer than one minute.', history: 'Worker check passed at 10:43:05.' },
  { id: 'memory', name: 'Memory', kind: 'Capacity', endpoint: 'Host memory', latency: '—', state: 'Nominal', usage: 39, measure: '6.2 / 16 GB', checked: '10:43:10', detail: '9.8 GB available.', history: 'Usage sampled at 10:43:10.' },
  { id: 'disk', name: 'Workspace disk', kind: 'Capacity', endpoint: 'Project storage', latency: '—', state: 'Nominal', usage: 36, measure: '184 / 512 GB', checked: '10:43:10', detail: '328 GB available across the storage volume.', history: 'Cleanup recovered 8.4 GB yesterday.' },
];
const byId = (items, id) => items.find(item => item.id === id);
const ownerName = id => byId(users, id)?.name || 'Unassigned';
const projectName = id => byId(projects, id)?.name || '—';
const number = value => value.toLocaleString('en-US');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const tone = value => /^(Active|Healthy|Online|Nominal|Succeeded|Enabled)/.test(value) ? 'good' : /Drift|Timeout|Disabled|Failed/.test(value) ? 'bad' : /Pending|Stale|Indexing|Probe|Needs/.test(value) ? 'warn' : '';
const status = value => `<span class="status ${tone(value)}">${esc(value)}</span>`;
const detailButton = (kind, id, name) => `<button type="button" class="row-link" data-detail="${esc(kind)}" data-id="${esc(id)}">${esc(name)}</button>`;
const sumSize = items => items.reduce((total, item) => total + item.size, 0);
const states = {};
let activePage = 'overview';
let detailState = null;
let dialogTrigger = null;
let formReturn = null;
let noticeTimer;
const detailDialog = document.getElementById('detail-dialog');
const formDialog = document.getElementById('form-dialog');

function attentionRows() {
  return [
    ...users.filter(u => u.state === 'Pending').map(u => ({ id: u.id, kind: 'user', subject: `${u.name} requested access`, category: 'Users', state: 'Pending', target: u.name, updated: '41 min ago' })),
    ...resources.filter(r => r.state !== 'Online').map(r => ({ id: r.id, kind: 'resource', subject: r.name, category: 'Resources', state: r.state, target: ownerName(r.owner), updated: r.heartbeat })),
    ...events.filter(e => e.result === 'Timeout').map(e => ({ id: e.id, kind: 'event', subject: `${e.tool} timed out`, category: 'Activity', state: 'Timeout', target: projectName(e.project), updated: e.ago })),
    ...systems.filter(s => s.state !== 'Nominal').map(s => ({ id: s.id, kind: 'system', subject: s.name, category: 'System', state: s.state, target: s.endpoint, updated: s.checked })),
  ];
}
const config = {
  overview: { label: 'Overview', columns: ['Needs attention', 'Area', 'Account / target', 'Status', 'Updated'], source: attentionRows, options: ['All areas', 'Users', 'Resources', 'Activity', 'System'], filter: (r, v) => r.category === v, kind: r => r.kind, cells: r => [detailButton(r.kind, r.id, r.subject), esc(r.category), esc(r.target), status(r.state), esc(r.updated)], summary: rows => `${rows.length} items · API available · 328 GB disk free`, action: '<button class="button" data-route="system">View system</button>' },
  users: { label: 'Users', columns: ['User', 'Role', 'Projects', 'Storage', 'Last MCP call', 'Status'], source: () => users, options: ['All states', 'Active', 'Pending', 'Disabled'], filter: (r, v) => r.state === v, kind: () => 'user', cells: r => { const owned = projects.filter(p => p.owner === r.id); return [detailButton('user', r.id, r.name), esc(r.role), String(owned.length), `${sumSize(owned)} GB`, esc(events.find(e => e.user === r.id)?.ago || '—'), status(r.state)]; }, summary: rows => `${rows.length} users · ${rows.filter(u => u.state === 'Pending').length} pending`, action: '<button class="button primary" data-create="user">Add user</button>' },
  projects: { label: 'Projects', columns: ['Project', 'Owner', 'Folders / files', 'Storage', 'Runtime', 'Updated'], source: () => projects, options: ['All projects', 'With runtime', 'Stale', 'No runtime'], filter: (r, v) => v === 'With runtime' ? r.runtime.includes('connected') : v === 'Stale' ? r.state === 'Stale' : r.runtime === 'None', kind: () => 'project', cells: r => [detailButton('project', r.id, r.name), esc(ownerName(r.owner)), `${r.folders} / ${number(r.files)}`, `${r.size} GB`, status(r.runtime), esc(r.updated)], summary: rows => `${rows.length} projects · ${sumSize(rows)} GB · ${new Set(rows.map(p => p.owner)).size} owners`, action: '' },
  activity: { label: 'Activity', columns: ['MCP tool', 'Time', 'User', 'Project', 'Result', 'Duration'], source: () => events, options: ['All results', 'Succeeded', 'Pending', 'Timeout'], filter: (r, v) => r.result === v, kind: () => 'event', cells: r => [detailButton('event', r.id, r.tool), esc(r.time), esc(ownerName(r.user)), esc(projectName(r.project)), status(r.result), esc(r.duration)], summary: rows => `${rows.length} calls · ${rows.filter(e => e.result === 'Succeeded').length} succeeded`, action: '' },
  resources: { label: 'Resources', columns: ['Resource', 'Type', 'Owner', 'Projects', 'Last heartbeat', 'State'], source: () => resources, options: ['All states', 'Online', 'Needs attention', 'Unassigned'], filter: (r, v) => v === 'Online' ? r.state === 'Online' : v === 'Unassigned' ? !r.owner : r.state !== 'Online', kind: () => 'resource', cells: r => [detailButton('resource', r.id, r.name), esc(r.type), esc(ownerName(r.owner)), String(r.projects.length), esc(r.heartbeat), status(r.state)], summary: rows => `${rows.length} resources · ${rows.filter(r => r.state === 'Online').length} online`, action: '<button class="button primary" data-create="resource">Add resource</button>' },
  system: { label: 'System', columns: ['Component', 'Type', 'Capacity / queue', 'Latency', 'Last check', 'State'], source: () => systems, options: ['All components', 'Services', 'Capacity', 'Needs attention'], filter: (r, v) => v === 'Services' ? r.kind === 'Service' : v === 'Capacity' ? r.kind === 'Capacity' : r.state !== 'Nominal', kind: () => 'system', cells: r => [detailButton('system', r.id, r.name), esc(r.kind), r.usage === null ? esc(r.measure) : `<div class="capacity"><progress value="${r.usage}" max="100" aria-label="${esc(r.name)} usage">${r.usage}%</progress><span>${esc(r.measure)}</span></div>`, esc(r.latency), esc(r.checked), status(r.state)], summary: rows => `${rows.length} components · ${rows.filter(s => s.state === 'Nominal').length} nominal`, action: '<button class="button" data-diagnostics>Last diagnostics</button>' },
};

function searchable(row) {
  return `${Object.values(row).filter(value => typeof value !== 'object').join(' ')} ${ownerName(row.owner || row.user)} ${projectName(row.project)}`.toLowerCase();
}
function visibleRows(page) {
  const cfg = config[page];
  const state = states[page];
  return cfg.source().filter(row => searchable(row).includes(state.query.trim().toLowerCase()) && (state.filter === cfg.options[0] || cfg.filter(row, state.filter)));
}
function tableMarkup(columns, rows, label) {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><table class="data-table${columns.length <= 3 ? ' compact' : ''}"><thead><tr>${columns.map(c => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td class="empty-cell" colspan="${columns.length}">No matching records.</td></tr>`}</tbody></table></div>`;
}
function renderRows(page) {
  const cfg = config[page];
  const rows = visibleRows(page);
  document.querySelector(`#page-${page} .table-body`).innerHTML = tableMarkup(cfg.columns, rows.map(row => `<tr data-detail="${cfg.kind(row)}" data-id="${esc(row.id)}">${cfg.cells(row).map(cell => `<td>${cell}</td>`).join('')}</tr>`), `${cfg.label} records`);
  document.querySelector(`#page-${page} .result-count`).textContent = cfg.summary(rows);
}
function renderPages() {
  for (const [page, cfg] of Object.entries(config)) {
    states[page] ||= { query: '', filter: cfg.options[0] };
    document.getElementById(`page-${page}`).innerHTML = `<div class="page-toolbar"><div class="filters"><input class="search" type="search" aria-label="Search ${cfg.label.toLowerCase()}" placeholder="Search ${cfg.label.toLowerCase()}" value="${esc(states[page].query)}" data-search="${page}" /><select aria-label="Filter ${cfg.label.toLowerCase()}" data-filter="${page}">${cfg.options.map(value => `<option${value === states[page].filter ? ' selected' : ''}>${esc(value)}</option>`).join('')}</select></div><div class="page-actions">${cfg.action}<button class="button subtle" type="button" data-export="${page}">Export</button></div></div><div class="table-body"></div><footer class="page-footer"><span class="result-count" aria-live="polite"></span><span>Sample data</span></footer>`;
    renderRows(page);
  }
}
function showPage(page, focus = false) {
  if (!config[page]) page = 'overview';
  activePage = page;
  document.querySelectorAll('.admin-page').forEach(el => { el.hidden = el.dataset.page !== page; });
  document.querySelectorAll('[data-page-target]').forEach(button => { const selected = button.dataset.pageTarget === page; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  document.getElementById('context-label').textContent = config[page].label;
  document.title = `Relay MCP — ${config[page].label} preview`;
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);
  window.scrollTo(0, 0);
  if (focus) document.getElementById(`nav-${page}`).focus();
}
function facts(items) {
  return `<dl class="detail-facts">${items.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
}
function projectTable(items) {
  return tableMarkup(['Project', 'Folders / files', 'Storage', 'Runtime'], items.map(p => `<tr data-detail="project" data-id="${esc(p.id)}"><td>${detailButton('project', p.id, p.name)}</td><td>${p.folders} / ${number(p.files)}</td><td>${p.size} GB</td><td>${status(p.runtime)}</td></tr>`), 'Related projects');
}
function activityTable(items) {
  return tableMarkup(['MCP tool', 'Time', 'Result', 'Duration'], items.map(e => `<tr data-detail="event" data-id="${esc(e.id)}"><td>${detailButton('event', e.id, e.tool)}</td><td>${esc(e.time)}</td><td>${status(e.result)}</td><td>${esc(e.duration)}</td></tr>`), 'MCP history');
}
function getDetail(kind, id) {
  if (kind === 'user') {
    const u = byId(users, id); if (!u) return null;
    const owned = projects.filter(p => p.owner === id);
    return { title: u.name, meta: `${u.role} · ${u.state} · ${owned.length} projects · ${sumSize(owned)} GB`, tabs: [
      { label: 'Projects', content: () => projectTable(owned) },
      { label: 'MCP history', content: () => activityTable(events.filter(e => e.user === id)) },
      { label: 'Access', content: () => facts([['Account status', u.state], ['Role', u.role], ['Knowledge', u.knowledge ? 'Enabled' : 'Disabled'], ['Joined', u.joined]]) + `<div class="dialog-actions"><button class="button primary" data-edit="user" data-id="${esc(id)}">Edit access</button></div>` },
    ] };
  }
  if (kind === 'project') {
    const p = byId(projects, id); if (!p) return null;
    return { title: p.name, meta: `${ownerName(p.owner)} · ${p.size} GB · ${p.runtime}`, tabs: [
      { label: 'Folders', content: () => tableMarkup(['Folder', 'Files', 'Storage'], p.entries.map(([name, files, size]) => `<tr><td>/${esc(name)}</td><td>${number(files)}</td><td>${size} GB</td></tr>`), 'Project folders') },
      { label: 'Access', content: () => facts([['Owner', ownerName(p.owner)], ['Editors', `${p.editors} users`], ['Retention', `${p.retention} days`], ['Project ID', `project_${p.id}`], ['State', p.state]]) + `<div class="dialog-actions"><button class="button" data-edit="project" data-id="${esc(id)}">Edit project</button></div>` },
      { label: 'MCP history', content: () => activityTable(events.filter(e => e.project === id)) },
    ] };
  }
  if (kind === 'event') {
    const e = byId(events, id); if (!e) return null;
    return { title: e.tool, meta: `${e.time} · ${e.result} · ${e.duration}`, tabs: [
      { label: 'Call details', content: () => facts([['User', ownerName(e.user)], ['Project', projectName(e.project)], ['Target', e.target], ['Access', e.access], ['Request ID', e.id], ['Result', e.result]]) },
      { label: 'Request', content: () => `<p class="muted">Sanitized request</p><pre>${esc(JSON.stringify({ requestId: e.id, tool: e.tool, project: e.project, target: e.target }, null, 2))}</pre>` },
    ] };
  }
  if (kind === 'resource') {
    const r = byId(resources, id); if (!r) return null;
    return { title: r.name, meta: `${r.type} · ${r.state}`, tabs: [
      { label: 'Status', content: () => facts([['Resource ID', r.id], ['Owner', ownerName(r.owner)], ['Last heartbeat', r.heartbeat], ['State', r.state], ['Probe result', r.detail]]) + `<div class="dialog-actions"><button class="button" data-edit="resource" data-id="${esc(id)}">Edit resource</button></div>` },
      { label: 'Projects', content: () => projectTable(projects.filter(p => r.projects.includes(p.id))) },
      { label: 'Project MCP history', content: () => activityTable(events.filter(e => r.projects.includes(e.project))) },
    ] };
  }
  if (kind === 'system') {
    const s = byId(systems, id); if (!s) return null;
    return { title: s.name, meta: `${s.kind} · ${s.state}`, tabs: [
      { label: 'Status', content: () => facts([['Endpoint / process', s.endpoint], ['Last check', s.checked], ['Latency', s.latency], ['Capacity / queue', s.measure], ['Result', s.detail]]) },
      { label: 'Check history', content: () => tableMarkup(['Check', 'Time', 'Result'], [`<tr><td>${esc(s.history)}</td><td>${esc(s.checked)}</td><td>${status(s.state)}</td></tr>`], 'Check history') },
    ] };
  }
  return null;
}
function renderDetail(tab = 0) {
  const item = getDetail(detailState.kind, detailState.id); if (!item) return;
  detailState.tab = Math.min(tab, item.tabs.length - 1);
  document.getElementById('detail-title').textContent = item.title;
  document.getElementById('detail-meta').textContent = item.meta;
  document.getElementById('detail-tabs').innerHTML = item.tabs.map((t, i) => `<button type="button" id="detail-tab-${i}" role="tab" aria-controls="detail-pane" aria-selected="${i === detailState.tab}" tabindex="${i === detailState.tab ? 0 : -1}" data-detail-tab="${i}">${esc(t.label)}</button>`).join('');
  document.getElementById('detail-body').innerHTML = `<div role="tabpanel" id="detail-pane" aria-labelledby="detail-tab-${detailState.tab}">${item.tabs[detailState.tab].content()}</div>`;
}
function openDetail(kind, id) {
  if (!getDetail(kind, id)) return;
  if (!detailDialog.open) dialogTrigger = document.activeElement;
  detailState = { kind, id, tab: 0 };
  renderDetail();
  if (!detailDialog.open) detailDialog.showModal();
  document.body.style.overflow = 'hidden';
  detailDialog.querySelector('[data-close]').focus();
}
function selectDetailTab(index) {
  renderDetail(index);
  document.getElementById(`detail-tab-${detailState.tab}`).focus();
}
function field(label, name, value = '', required = true, type = 'text') {
  return `<label class="field">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${type === 'number' ? 'min="1"' : 'maxlength="120"'} /></label>`;
}
function selectField(label, name, options, selected) {
  return `<label class="field">${esc(label)}<select name="${esc(name)}">${options.map(([value, text]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
}
function openForm(kind, id) {
  const editing = Boolean(id);
  formReturn = editing && detailDialog.open ? { ...detailState } : null;
  if (detailDialog.open) detailDialog.close();
  let content = ''; let title = ''; let label = editing ? 'Save changes' : 'Create';
  const ownerOptions = users.map(u => [u.id, u.name]);
  if (kind === 'project') {
    const p = byId(projects, id);
    title = editing ? 'Edit project' : 'New project'; label = editing ? 'Save changes' : 'Create project';
    content = field('Project name', 'name', p?.name) + selectField('Owner', 'owner', ownerOptions, p?.owner || 'maya') + (editing ? field('Retention (days)', 'retention', p.retention, true, 'number') : '<label class="field">Description<textarea name="description" rows="3" maxlength="500"></textarea></label>');
  } else if (kind === 'user') {
    const u = byId(users, id);
    title = editing ? `Edit access · ${u.name}` : 'Add user'; label = editing ? 'Save access' : 'Add user';
    content = (editing ? '' : field('Username', 'name')) + selectField('Role', 'role', [['User', 'User'], ['Admin', 'Admin']], u?.role || 'User') + selectField('Account status', 'state', ['Active', 'Pending', 'Disabled'].map(s => [s, s]), u?.state || 'Pending') + `<label class="checkbox"><input type="checkbox" name="knowledge" ${u?.knowledge ? 'checked' : ''} />Enable Knowledge</label>`;
  } else if (kind === 'resource') {
    const r = byId(resources, id);
    title = editing ? 'Edit resource' : 'Add resource'; label = editing ? 'Save resource' : 'Add resource';
    content = field('Name', 'name', r?.name) + selectField('Type', 'type', ['Server', 'Instance', 'Agent'].map(s => [s, s]), r?.type || 'Server') + selectField('Owner', 'owner', [['', 'Unassigned'], ...ownerOptions], r?.owner || '');
  } else if (kind === 'token') {
    title = 'Create MCP token'; label = 'Create preview token';
    content = field('Token name', 'name') + selectField('Project scope', 'project', [['', 'All projects'], ...projects.map(p => [p.id, p.name])], '');
  }
  document.getElementById('form-title').textContent = title;
  const form = document.getElementById('edit-form');
  form.dataset.kind = kind; form.dataset.id = id || '';
  form.innerHTML = content + `<p class="form-note">Design preview. Changes apply to sample data only.</p><div class="dialog-actions"><button class="button" type="button" data-close>Cancel</button><button class="button primary" type="submit">${label}</button></div>`;
  if (!formDialog.open) formDialog.showModal();
  document.body.style.overflow = 'hidden';
  form.querySelector('input,select')?.focus();
}
function notify(message) {
  clearTimeout(noticeTimer); const notice = document.getElementById('notice'); notice.textContent = message; notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}
document.getElementById('edit-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form));
  const kind = form.dataset.kind; const id = form.dataset.id; const name = String(values.name || '').trim();
  if (form.elements.namedItem('name') && !name) { form.elements.namedItem('name').setCustomValidity('Enter a name.'); form.reportValidity(); return; }
  if (kind === 'token') {
    formReturn = null;
    form.innerHTML = `<p>A preview token was created for ${esc(name)}.</p><pre>preview_only_not_a_valid_token</pre><p class="form-note">This example cannot authenticate MCP requests.</p><div class="dialog-actions"><button type="button" class="button primary" data-close>Done</button></div>`;
    form.querySelector('button').focus(); return;
  }
  if (kind === 'user') {
    const changes = { role: values.role, state: values.state, knowledge: values.knowledge === 'on' };
    if (id) Object.assign(byId(users, id), changes); else users.push({ id: `preview-user-${Date.now()}`, name, joined: 'Today', ...changes });
  } else if (kind === 'project') {
    if (id) Object.assign(byId(projects, id), { name, owner: values.owner, retention: Math.max(1, Number(values.retention) || 90) });
    else projects.push({ id: `preview-project-${Date.now()}`, name, owner: values.owner, size: 0, folders: 0, files: 0, runtime: 'None', state: 'Idle', updated: 'Just now', editors: 1, retention: 90, entries: [] });
  } else if (kind === 'resource') {
    const changes = { name, type: values.type, owner: values.owner || null };
    if (id) {
      const resource = byId(resources, id);
      Object.assign(resource, changes);
      if (!resource.owner) { resource.state = 'Needs owner'; resource.detail = 'Assign an owner before linking projects.'; }
      else if (resource.state === 'Needs owner') { resource.state = 'Probe pending'; resource.detail = 'Owner assigned. A fresh probe is required.'; }
    } else resources.push({ id: `preview-resource-${Date.now()}`, ...changes, projects: [], heartbeat: '—', state: changes.owner ? 'Probe pending' : 'Needs owner', detail: 'Not connected in the design preview.' });
  }
  renderPages(); formDialog.close(); notify('Saved in this preview.');
});
function exportPage(page) {
  const cfg = config[page];
  const plain = value => { const element = document.createElement('div'); element.innerHTML = value; return element.textContent; };
  const cell = value => `"${String(value).replace(/^[=+@\-]/, "'$&").replaceAll('"', '""')}"`;
  const csv = [cfg.columns, ...visibleRows(page).map(row => cfg.cells(row).map(plain))].map(row => row.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `relay-${page}-preview.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', event => {
  const target = event.target.closest('button,a,tr'); if (!target) return;
  if (target.classList.contains('skip-link')) { event.preventDefault(); document.getElementById('main').focus(); }
  else if (target.dataset.pageTarget) showPage(target.dataset.pageTarget);
  else if (target.dataset.route) showPage(target.dataset.route, true);
  else if (target.dataset.detail) openDetail(target.dataset.detail, target.dataset.id);
  else if (target.hasAttribute('data-detail-tab')) selectDetailTab(Number(target.dataset.detailTab));
  else if (target.hasAttribute('data-close')) target.closest('dialog').close();
  else if (target.dataset.create) openForm(target.dataset.create);
  else if (target.dataset.edit) openForm(target.dataset.edit, target.dataset.id);
  else if (target.dataset.export) exportPage(target.dataset.export);
  else if (target.hasAttribute('data-diagnostics')) { openDetail('system', 'api'); notify('Showing the last sample diagnostic result.'); }
});
document.addEventListener('input', event => {
  const page = event.target.dataset.search;
  if (page) { states[page].query = event.target.value; renderRows(page); }
  if (event.target.name === 'name') event.target.setCustomValidity('');
});
document.addEventListener('change', event => {
  const page = event.target.dataset.filter;
  if (page) { states[page].filter = event.target.value; renderRows(page); }
});
document.addEventListener('keydown', event => {
  if (event.target.matches('[data-page-target]') && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const keys = Object.keys(config); const index = keys.indexOf(activePage);
    showPage(keys[event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + keys.length) % keys.length], true);
  }
  if (event.target.matches('[data-detail-tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); const count = getDetail(detailState.kind, detailState.id).tabs.length;
    selectDetailTab(event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (detailState.tab + (event.key === 'ArrowRight' ? 1 : -1) + count) % count);
  }
});
for (const dialog of [detailDialog, formDialog]) {
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
    const first = targets[0]; const last = targets[targets.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  });
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (dialog === formDialog && formReturn) { const previous = formReturn; formReturn = null; openDetail(previous.kind, previous.id); selectDetailTab(previous.tab); }
    if (!detailDialog.open && !formDialog.open) { document.body.style.overflow = ''; if (dialogTrigger?.isConnected) dialogTrigger.focus(); else document.getElementById(`nav-${activePage}`).focus(); }
  });
}
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
renderPages();
showPage(location.hash.slice(1));
