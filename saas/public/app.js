const $ = (selector) => document.querySelector(selector);
const labels = { devices: '设备总览', gateways: '连接网关', access: '用户与 Agent', approvals: '操作记录', audit: '访问记录' };
const actions = { status: '查看状态', pause: '暂停', resume: '恢复', stop: '停止', adb_input: 'ADB 输入', adb_ui: '读取界面' };
const states = { pending: '等待审批', expired: '已到期', revoked: '已撤销', rejected: '已拒绝', executing: '正在发送', completed: '执行完成', delivered: '已发送 · 设备执行未确认', unknown: '结果未知 · 请检查设备' };
let token, actor, devices = [], gateways = [], principals = [], approvals = [], current = 'devices', register = false, noticeTimer, googleEnabled = false;
function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function note(message, error = false) { const e = $('#notice'); e.textContent = message; e.className = error ? 'error' : ''; e.hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => e.hidden = true, 6500); }
async function api(path, body, method) {
  const response = await fetch(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '请求失败'); return data;
}
async function busy(button, fn) { button.disabled = true; try { await fn(); } catch (e) { note(e.message, true); } finally { button.disabled = false; } }
function empty(parent, title, text) { const e = element('div', undefined, 'empty'); e.append(element('strong', title), element('p', text)); parent.append(e); }
function date(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function button(text, fn, className) { const b = element('button', text, className); b.type = 'button'; b.addEventListener('click', () => busy(b, fn)); return b; }
function showView(view) {
  if (!actor.owner && !['devices', 'approvals'].includes(view)) view = 'devices';
  current = view; for (const key of Object.keys(labels)) $(`#view-${key}`).hidden = key !== view;
  document.querySelectorAll('.nav').forEach(e => { e.classList.toggle('active', e.dataset.view === view); if (e.dataset.view === view) e.setAttribute('aria-current', 'page'); else e.removeAttribute('aria-current'); });
  $('#view-label').textContent = labels[view];
}
async function init() {
  try { actor = await api('/api/session'); if (!actor.authenticated) throw new Error('未登录'); }
  catch { $('#workspace').hidden = true; $('#auth').hidden = false; actor = undefined; return; }
  $('#auth').hidden = true; $('#workspace').hidden = false; $('#account-name').textContent = actor.name;
  $('#google-link').hidden = !actor.owner || !googleEnabled;
  $('#google-link').textContent = actor.googleLinked ? '已关联 Google' : '关联 Google 登录';
  $('#google-link').disabled = !!actor.googleLinked;
  document.querySelectorAll('.owner-only').forEach(e => e.hidden = !actor.owner); showView(current);
  try { await refresh(); } catch (e) { note(e.message, true); }
}
async function refresh() {
  devices = (await api('/api/devices')).devices; approvals = (await api('/api/approvals')).approvals;
  if (actor.owner) {
    [gateways, principals] = await Promise.all([api('/api/gateways').then(d => d.gateways), api('/api/principals').then(d => d.principals)]);
    renderGateways(); renderPrincipals(); renderOptions(); if (current === 'audit') await renderAudit();
  }
  renderDevices(); renderApprovals();
}
function renderDevices() {
  $('#device-count').textContent = devices.length; $('#device-summary').textContent = `${devices.filter(d => d.online).length} 台设备的网关已连接 / 共 ${devices.length} 台设备`;
  const list = $('#devices'); list.replaceChildren();
  if (!devices.length) {
    empty(list, actor.owner ? '从第一个网关开始。' : '暂时没有可访问的设备。', actor.owner ? '在「连接网关」生成入网文件，先用模拟 X1C 体验完整流程。' : '请联系所有者检查设备接入和访问授权。');
    if (actor.owner) list.append(button('创建连接网关 ↗', async () => showView('gateways'), 'secondary compact'));
  }
  for (const d of devices) {
    const card = element('article', undefined, 'device-card'), header = element('header');
    header.append(element('span', d.connector === 'simulator' ? 'SIMULATED / 演示' : 'LOCAL / 本地接入', 'tag'), element('span', d.online ? '● 网关在线' : '○ 网关离线', 'status-dot' + (d.online ? ' online' : '')));
    const art = element('div', undefined, 'printer-art'); art.setAttribute('aria-hidden', 'true');
    if (d.connector === 'adb' || d.connector === 'esp32_serial' || d.connector === 'home_assistant')
      art.append(element('div', d.connector === 'adb' ? '▣' : d.connector === 'esp32_serial' ? '⌁' : '⌂', 'android-icon'));
    else { const printer = element('div', undefined, 'printer'); printer.append(element('div', undefined, 'print-object')); art.append(printer); }
    const body = element('div', undefined, 'device-body'), status = element('div', undefined, 'device-status');
    status.append(element('p', d.online ? '点击读取，查看设备的最新报告。' : '请检查所在网络的网关。', 'muted'));
    body.append(element('h3', d.name), element('div', d.model, 'device-model'), status);
    const footer = element('div', undefined, 'device-footer');
    const readRoute = d.connector === 'adb' ? 'adb-status' : ['esp32_serial', 'home_assistant'].includes(d.connector) ? 'device-status' : 'status';
    const read = button('读取状态 ↗', async () => renderStatus(status, await api(`/api/devices/${d.id}/${readRoute}`))); read.disabled = !d.online; footer.append(read);
    if (d.connector === 'adb' && d.capabilities.includes('adb_ui')) {
      const ui = button('读取界面结构 ↗', async () => { const result = await api(`/api/devices/${d.id}/adb-ui`); status.replaceChildren(element('pre', result.ui.xml, 'adb-ui-xml')); });
      ui.disabled = !d.online; footer.append(ui);
    }
    if (!actor.owner) for (const action of d.capabilities.filter(a => !['status', 'adb_input', 'adb_ui'].includes(a))) footer.append(button(`申请${actions[action]}`, async () => {
      const reply = await api(`/api/devices/${d.id}/actions`, { action, idempotencyKey: crypto.randomUUID() }); note('已提交申请，所有者批准前不会执行。'); approvals.unshift(reply.approval); renderApprovals();
    }));
    body.append(footer, element('div', d.id, 'device-id')); card.append(header, art, body); list.append(card);
  }
}
function renderStatus(parent, { status, stale }) {
  parent.replaceChildren(); const state = element('div', undefined, 'device-state');
  if ('androidVersion' in status) {
    state.append(element('span', `${stale ? '过期报告 · ' : ''}ADB 已连接`));
    parent.append(state, element('p', `${status.model} · Android ${status.androidVersion}`, 'muted'), element('p', `报告时间 ${date(status.observedAt)}`, 'fine'));
    return;
  }
  if ('value' in status) {
    state.append(element('span', `${stale ? '过期报告 · ' : ''}${status.state}`));
    parent.append(state, element('p', `${status.value ?? '—'}${status.unit ? ' ' + status.unit : ''}`, 'muted'), element('p', `报告时间 ${date(status.observedAt)}`, 'fine'));
    return;
  }
  state.append(element('span', `${stale ? '过期报告 · ' : ''}${status.state}`), element('span', status.progress === null ? '—' : `${status.progress}%`));
  const track = element('div', undefined, 'progress-track'), progress = document.createElement('progress'); progress.max = 100; progress.value = status.progress ?? 0; progress.setAttribute('aria-label', '打印进度'); track.append(progress);
  const metrics = element('div', undefined, 'metric-grid');
  for (const [name, value, unit] of [['喷嘴温度', status.nozzleTemperature, '°C'], ['热床温度', status.bedTemperature, '°C'], ['剩余时间', status.remainingMinutes, 'm']]) {
    const m = element('div'); m.append(element('span', name), element('strong', value === null ? '—' : value + unit)); metrics.append(m);
  }
  parent.append(state, track, metrics, element('p', `报告时间 ${date(status.observedAt)}`, 'fine'));
}
function row(title, detail) { const r = element('div', undefined, 'list-row'), left = element('div'); left.append(element('strong', title), element('p', detail)); const right = element('div', undefined, 'row-actions'); r.append(left, right); return { r, right }; }
function renderGateways() {
  const list = $('#gateways'); list.replaceChildren(); if (!gateways.length) empty(list, '还没有网关', '创建后，在设备所在的网络运行它。');
  for (const g of gateways) {
    const { r, right } = row(g.name, `${g.id} · ${g.revoked ? '已撤销' : g.online ? '已连接' : g.enrolled ? '已入网，当前离线' : '等待入网'}`);
    if (!g.revoked) right.append(button('撤销网关', async () => { if (!confirm('撤销后，该网关下的所有设备将不可访问。继续？')) return; await api(`/api/gateways/${g.id}`, undefined, 'DELETE'); await refresh(); }, 'danger')); list.append(r);
  }
}
function renderOptions() {
  const list = $('#device-options'), selected = new Set([...list.querySelectorAll('input:checked')].map(i => i.value)); list.replaceChildren();
  if (!devices.length) list.append(element('p', '接入设备后即可签发凭证。', 'muted'));
  for (const d of devices) { const label = element('label', undefined, 'check'), input = document.createElement('input'); input.type = 'checkbox'; input.name = 'devices'; input.value = d.id; input.checked = selected.has(d.id); label.append(input, document.createTextNode(d.name)); list.append(label); }
}
function renderPrincipals() {
  const list = $('#principals'); list.replaceChildren(); if (!principals.length) empty(list, '还没有共享访问', '选择设备，为指定用户或 Agent 创建独立凭证。');
  for (const p of principals) {
    const active = !p.revoked && p.expires_at > Date.now(), { r, right } = row(`${p.kind === 'agent' ? 'Agent' : '用户'} / ${p.name}`, `${p.devices.length} 台设备 · ${p.permissions.map(x => actions[x]).join('、')} · ${p.revoked ? '已撤销' : '到期 ' + date(p.expires_at)}`);
    if (active) right.append(button('撤销访问', async () => { if (!confirm(`撤销「${p.name}」的访问？`)) return; await api(`/api/principals/${p.id}`, undefined, 'DELETE'); await refresh(); }, 'danger')); else right.append(element('span', '已失效', 'tag')); list.append(r);
  }
}
function renderApprovals() {
  $('#approval-count').textContent = approvals.filter(a => a.state === 'pending').length;
  const list = $('#approvals'); list.replaceChildren(); if (!approvals.length) empty(list, '没有操作记录', 'ADB 输入记录和打印机控制申请会出现在这里。');
  for (const a of approvals) {
    const d = devices.find(d => d.id === a.deviceId), p = principals.find(p => p.id === a.principalId);
    const detail = a.action === 'adb_input' ? ` · ${JSON.stringify(a.input)}` : '';
    const { r, right } = row(`${actions[a.action]} · ${d?.name ?? a.deviceId}`, `${p?.name ?? '当前访问者'} · ${states[a.state] ?? a.state} · ${date(a.createdAt)}${detail}`);
    if (actor.owner && a.state === 'pending' && a.expiresAt > Date.now()) {
      right.append(button('拒绝', async () => { await api(`/api/approvals/${a.id}/reject`, {}); await refresh(); }));
      right.append(button('批准执行', async () => { if (!confirm(`批准${actions[a.action]}「${d?.name ?? a.deviceId}」${detail}？这会向设备发送操作。`)) return; await api(`/api/approvals/${a.id}/approve`, {}); await refresh(); }, 'approve'));
    } else right.append(element('span', states[a.state] ?? a.state, 'tag')); list.append(r);
  }
}
async function renderAudit() {
  const list = $('#audit'), { events } = await api('/api/audit'); list.replaceChildren(); if (!events.length) empty(list, '暂无访问记录', '设备连接、读取、授权及控制操作都会记录。');
  for (const e of events) { const { r, right } = row(e.action, `${e.actor} → ${e.resource}`); r.classList.add('audit-row'); right.append(element('span', e.outcome, 'tag'), element('span', date(e.ts), 'tag')); list.append(r); }
}
function reveal(title, description, content, filename) {
  $('#secret-title').textContent = title; $('#secret-description').textContent = description; $('#secret-value').textContent = content;
  $('#download-secret').onclick = () => { const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' })); const link = element('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }; $('#secret-dialog').showModal();
}
$('#secret-dialog').addEventListener('close', () => { $('#secret-value').textContent = ''; $('#download-secret').onclick = null; });
$('#switch-auth').addEventListener('click', () => { register = !register; $('#auth-title').textContent = register ? '创建你的设备空间' : '欢迎回来'; $('#account-submit').textContent = register ? '创建账号 ↗' : '登录设备空间 ↗'; $('#switch-auth').textContent = register ? '已有账号？返回登录' : '第一次使用？创建账号'; $('#password').autocomplete = register ? 'new-password' : 'current-password'; });
$('#account-form').addEventListener('submit', e => { e.preventDefault(); busy($('#account-submit'), async () => { await api(register ? '/api/register' : '/api/login', Object.fromEntries(new FormData(e.target))); e.target.reset(); await init(); }); });
$('#token-login').addEventListener('submit', e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => { token = new FormData(e.target).get('token').trim(); try { await api('/api/session'); } catch (err) { token = undefined; throw err; } e.target.reset(); await init(); }); });
$('#logout').addEventListener('click', () => busy($('#logout'), async () => { if (actor.owner) await api('/api/logout', {}); token = undefined; actor = undefined; devices = []; gateways = []; principals = []; approvals = []; $('#workspace').hidden = true; $('#auth').hidden = false; }));
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => { showView(b.dataset.view); if (current === 'audit') renderAudit().catch(e => note(e.message, true)); if (current === 'approvals') refresh().catch(e => note(e.message, true)); }));
$('#refresh').addEventListener('click', () => busy($('#refresh'), refresh));
$('#gateway-form').addEventListener('submit', e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => { const data = await api('/api/gateways', Object.fromEntries(new FormData(e.target))); reveal('保存网关入网文件', '10 分钟内使用。首次入网成功后，可不带此文件重新启动网关。', JSON.stringify(data.enrollment, null, 2), 'enrollment.json'); e.target.reset(); await refresh(); }); });
$('#principal-form').addEventListener('submit', e => { e.preventDefault(); busy(e.target.querySelector('button'), async () => {
  const form = new FormData(e.target), selected = form.getAll('devices'); if (!selected.length) throw new Error('请至少选择一台设备。');
  const data = await api('/api/principals', { name: form.get('name'), kind: form.get('kind'), devices: selected, permissions: ['status', ...form.getAll('permissions')], expiresInHours: Number(form.get('expiresInHours')) });
  reveal('保存独立访问凭证', '只显示一次。下载后关闭此窗口，按下方「在 Codex 中配置」连接 Agent。受邀用户也可在登录页使用此凭证。', data.token, 'meshmind-token.txt'); e.target.reset(); await refresh();
}); });
const mcpUrl = location.origin + '/mcp';
$('#cli-command').textContent = 'MESHMIND_HUB=' + location.origin + ' \\\n' +
  'MESHMIND_TOKEN_FILE=/absolute/path/meshmind-token.txt \\\n' +
  'node meshmind-cli.mjs devices list';
$('#mcp-url').value = mcpUrl;
$('#mcp-command').textContent = 'chmod 600 /absolute/path/meshmind-token.txt\n' +
  'export MESHMIND_TOKEN="$(cat /absolute/path/meshmind-token.txt)"\n' +
  'codex mcp add meshmind --url ' + mcpUrl + ' --bearer-token-env-var MESHMIND_TOKEN';
$('#mcp-reachability').textContent = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  ? '当前是本机地址，仅此电脑上的 Agent 可连接。其他网络或云端 Agent 需要可访问的 HTTPS 域名。'
  : 'Agent 所在网络需要能够访问此 HTTPS 地址；设备所在网络只需保持网关在线。';
for (const [selector, content] of [['#copy-mcp-url', () => mcpUrl], ['#copy-mcp-command', () => $('#mcp-command').textContent]]) {
  $(selector).addEventListener('click', () => busy($(selector), async () => { await navigator.clipboard.writeText(content()); note('已复制。'); }));
}
$('#google-login').addEventListener('click', () => location.assign('/api/auth/google'));
$('#google-link').addEventListener('click', () => busy($('#google-link'), async () => {
  if (!confirm('将接下来选择的 Google 账号关联到当前设备空间？请确认选择的是你自己的账号。')) return;
  const reply = await api('/api/auth/google/link', {}); location.assign(reply.url);
}));
async function boot() {
  try {
    googleEnabled = (await api('/api/auth/providers')).google;
    $('#google-login').disabled = !googleEnabled;
    $('#google-hint').textContent = googleEnabled ? '仅用于登录，不申请访问你的 Google 文件。' : '管理员尚未启用 Google 登录，当前可使用邮箱和密码。';
  } catch { $('#google-hint').textContent = '暂时无法获取 Google 登录配置，请稍后刷新。'; }
  const params = new URLSearchParams(location.search), error = params.get('auth_error');
  const messages = {
    google_invalid_state: '登录验证已到期或与当前浏览器不匹配，请重新点击 Google 登录。',
    google_cancelled: 'Google 登录已取消。', google_email_unverified: '请先在 Google 账号中验证邮箱。',
    google_account_exists: '此邮箱已有账号。请先用密码登录，再选择「关联 Google 登录」。',
    google_signup_closed: '当前未开放新账号注册，请联系管理员。',
    google_link_expired: '原登录会话已到期，请重新登录后再关联 Google。',
    google_link_conflict: '此 Google 账号已关联其他设备空间，或当前账号已关联另一个 Google 账号。',
    google_busy: '登录请求繁忙，请稍后重试。', google_failed: 'Google 登录未完成，请检查网络并重试。',
  };
  if (error) note(messages[error] ?? messages.google_failed, true);
  if (params.get('auth_success') === 'google_linked') note('Google 账号已关联，下次可以直接使用 Google 登录。');
  if (params.has('auth_error') || params.has('auth_success')) history.replaceState(null, '', '/');
  await init();
}
boot();
