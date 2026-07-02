const state = {
  activeView: 'audit',
  auditRows: [],
  slowRows: [],
  slowFingerprints: [],
  loadingAudit: false,
  loadingSlow: false,
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  auditView: $('#audit-view'),
  slowView: $('#slow-view'),
  navItems: [...document.querySelectorAll('.nav-item[data-view]')],
  audit: {
    from: $('#from'),
    to: $('#to'),
    database: $('#database'),
    user: $('#user'),
    keyword: $('#keyword'),
    ip: $('#ip'),
    status: $('#status'),
    limit: $('#limit'),
    searchBtn: $('#search-btn'),
    refreshBtn: $('#refresh-btn'),
    body: $('#audit-body'),
    count: $('#result-count'),
    userList: $('#user-list'),
    metrics: {
      total: $('#metric-total'),
      failed: $('#metric-failed'),
      avg: $('#metric-avg'),
      rows: $('#metric-rows'),
    },
  },
  slow: {
    from: $('#slow-from'),
    to: $('#slow-to'),
    database: $('#slow-database'),
    user: $('#slow-user'),
    keyword: $('#slow-keyword'),
    ip: $('#slow-ip'),
    threshold: $('#slow-threshold'),
    limit: $('#slow-limit'),
    searchBtn: $('#slow-search-btn'),
    refreshBtn: $('#slow-refresh-btn'),
    body: $('#slow-body'),
    recordCount: $('#slow-record-count'),
    fingerprintCount: $('#slow-fingerprint-count'),
    fingerprintList: $('#slow-fingerprints'),
    metrics: {
      total: $('#slow-total'),
      p95: $('#slow-p95'),
      max: $('#slow-max'),
      rows: $('#slow-rows'),
    },
  },
  sqlDialog: $('#sql-dialog'),
  sqlDetail: $('#sql-detail'),
  connectionText: $('#connection-text'),
  connectionMeta: $('#connection-meta'),
  statusDot: $('#status-dot'),
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function toDatetimeLocal(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number);
}

function formatDuration(value) {
  const number = Number(value || 0);
  if (number >= 1000) return `${(number / 1000).toFixed(2)}s`;
  return `${Math.round(number)}ms`;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (number >= 1024 ** 3) return `${(number / 1024 ** 3).toFixed(2)} GB`;
  if (number >= 1024 ** 2) return `${(number / 1024 ** 2).toFixed(2)} MB`;
  if (number >= 1024) return `${(number / 1024).toFixed(2)} KB`;
  return `${number} B`;
}

function formatTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeIpInput(value) {
  return String(value || '').trim().replace(/^::ffff:/i, '');
}

async function request(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `请求失败：${response.status}`);
  }
  return payload;
}

function fillSelect(select, values, placeholder) {
  const current = select.value;
  select.innerHTML = `<option value="">${placeholder}</option>`;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  if (values.includes(current)) select.value = current;
}

function setDefaultRanges() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  elements.audit.from.value = toDatetimeLocal(dayAgo);
  elements.audit.to.value = toDatetimeLocal(now);
  elements.slow.from.value = toDatetimeLocal(dayAgo);
  elements.slow.to.value = toDatetimeLocal(now);
}

function getAuditParams() {
  const params = new URLSearchParams({
    from: new Date(elements.audit.from.value).toISOString(),
    to: new Date(elements.audit.to.value).toISOString(),
    limit: elements.audit.limit.value,
  });
  if (elements.audit.database.value) params.set('database', elements.audit.database.value);
  if (elements.audit.user.value.trim()) params.set('user', elements.audit.user.value.trim());
  if (elements.audit.keyword.value.trim()) params.set('keyword', elements.audit.keyword.value.trim());
  if (elements.audit.ip.value.trim()) params.set('ip', elements.audit.ip.value.trim());
  if (elements.audit.status.value) params.set('status', elements.audit.status.value);
  return params;
}

function getSlowParams() {
  const params = new URLSearchParams({
    from: new Date(elements.slow.from.value).toISOString(),
    to: new Date(elements.slow.to.value).toISOString(),
    limit: elements.slow.limit.value,
    minDurationMs: elements.slow.threshold.value || '1000',
  });
  if (elements.slow.database.value) params.set('database', elements.slow.database.value);
  if (elements.slow.user.value.trim()) params.set('user', elements.slow.user.value.trim());
  if (elements.slow.keyword.value.trim()) params.set('keyword', elements.slow.keyword.value.trim());
  if (elements.slow.ip.value.trim()) params.set('ip', normalizeIpInput(elements.slow.ip.value));
  return params;
}

function renderAuditMetrics(summary) {
  elements.audit.metrics.total.textContent = formatNumber(summary.total);
  elements.audit.metrics.failed.textContent = formatNumber(summary.failed);
  elements.audit.metrics.avg.textContent = formatDuration(summary.avg_duration_ms);
  elements.audit.metrics.rows.textContent = formatNumber(summary.read_rows);
}

function renderAuditUsers(users) {
  if (!users.length) {
    elements.audit.userList.innerHTML = '<div class="empty">暂无用户数据</div>';
    return;
  }

  elements.audit.userList.innerHTML = users
    .map((item) => {
      const failed = Number(item.failed || 0);
      return `
        <div class="user-item">
          <div>
            <strong>${escapeHtml(item.user || 'unknown')}</strong>
            <span>${formatDuration(item.avg_duration_ms)} 平均耗时</span>
          </div>
          <div>
            <strong>${formatNumber(item.total)}</strong>
            <span>${failed ? `${formatNumber(failed)} 失败` : '无失败'}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAuditRows(records) {
  state.auditRows = records;
  if (!records.length) {
    elements.audit.body.innerHTML = '<tr><td colspan="9" class="empty">没有匹配的审计记录</td></tr>';
    elements.audit.count.textContent = '0 条记录';
    return;
  }

  elements.audit.count.textContent = `${records.length} 条记录`;
  elements.audit.body.innerHTML = records
    .map((row, index) => {
      const failed = Number(row.exception_code || 0) !== 0;
      return `
        <tr data-index="${index}">
          <td>${escapeHtml(formatTime(row.event_time))}</td>
          <td>${escapeHtml(row.client_address || row.initial_client_address || row.query_address || '--')}</td>
          <td>${escapeHtml(row.user || '--')}</td>
          <td>${escapeHtml(row.database || '--')}</td>
          <td>${escapeHtml(row.query_kind || '--')}</td>
          <td>${escapeHtml(formatDuration(row.duration_ms))}</td>
          <td>${escapeHtml(formatNumber(row.read_rows))}</td>
          <td><span class="pill ${failed ? 'error' : 'ok'}">${failed ? '失败' : '成功'}</span></td>
          <td class="sql-cell">
            <span class="sql-preview">${escapeHtml(row.query || row.exception || '--')}</span>
            <button class="link-button" type="button" data-index="${index}">查看</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderSlowMetrics(summary) {
  elements.slow.metrics.total.textContent = formatNumber(summary.total);
  elements.slow.metrics.p95.textContent = formatDuration(summary.p95_duration_ms);
  elements.slow.metrics.max.textContent = formatDuration(summary.max_duration_ms);
  elements.slow.metrics.rows.textContent = formatNumber(summary.read_rows);
}

function renderSlowFingerprints(rows) {
  state.slowFingerprints = rows;
  elements.slow.fingerprintCount.textContent = rows.length ? `${rows.length} 个模板` : '暂无模板';

  if (!rows.length) {
    elements.slow.fingerprintList.innerHTML = '<div class="empty">暂无慢 SQL 模板</div>';
    return;
  }

  elements.slow.fingerprintList.innerHTML = rows
    .map((row, index) => {
      return `
        <article class="fingerprint-card" data-fingerprint-index="${index}">
          <div class="fingerprint-head">
            <div>
              <strong>${escapeHtml(row.query_kind || 'SQL')}</strong>
              <span>${escapeHtml(row.database || '--')} · ${escapeHtml(row.user || '--')} · ${escapeHtml(row.client_address || '--')}</span>
            </div>
            <div class="fingerprint-pill">${formatDuration(row.max_duration_ms)}</div>
          </div>
          <div class="fingerprint-stats">
            <span>次数 <strong>${formatNumber(row.total)}</strong></span>
            <span>P95 <strong>${formatDuration(row.p95_duration_ms)}</strong></span>
            <span>扫描 <strong>${formatNumber(row.read_rows)}</strong></span>
            <span>内存 <strong>${formatBytes(row.max_memory_usage)}</strong></span>
          </div>
          <pre class="fingerprint-sql">${escapeHtml(row.sample_query || '--')}</pre>
        </article>
      `;
    })
    .join('');
}

function renderSlowRows(records) {
  state.slowRows = records;
  if (!records.length) {
    elements.slow.body.innerHTML = '<tr><td colspan="8" class="empty">没有匹配的慢 SQL 记录</td></tr>';
    elements.slow.recordCount.textContent = '0 条记录';
    return;
  }

  elements.slow.recordCount.textContent = `${records.length} 条记录`;
  elements.slow.body.innerHTML = records
    .map((row, index) => {
      const failed = Number(row.exception_code || 0) !== 0;
      return `
        <tr data-index="${index}">
          <td>${escapeHtml(formatTime(row.event_time))}</td>
          <td>${escapeHtml(formatDuration(row.duration_ms))}</td>
          <td>${escapeHtml(row.database || '--')}</td>
          <td>${escapeHtml(row.user || '--')}</td>
          <td>${escapeHtml(row.client_address || '--')}</td>
          <td>${escapeHtml(formatNumber(row.read_rows))}</td>
          <td>${escapeHtml(formatBytes(row.memory_usage))}</td>
          <td class="sql-cell">
            <span class="sql-preview">${escapeHtml(row.query || row.exception || '--')}</span>
            <div class="slow-meta">
              <span class="pill ${failed ? 'error' : 'ok'}">${failed ? '失败' : '成功'}</span>
              <button class="link-button" type="button" data-index="${index}">查看</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function showSqlDetail(sql) {
  elements.sqlDetail.textContent = sql || '';
  elements.sqlDialog.showModal();
}

async function checkHealth() {
  try {
    const health = await request('/api/health');
    elements.statusDot.className = `status-dot ${health.ok ? 'ok' : 'error'}`;
    elements.connectionText.textContent = health.ok ? '已连接' : '连接异常';
    const db = health.configured_database || 'system';
    elements.connectionMeta.textContent = `${health.url} / ${db} / ${health.latency_ms || 0}ms`;
  } catch (error) {
    elements.statusDot.className = 'status-dot error';
    elements.connectionText.textContent = '连接失败';
    elements.connectionMeta.textContent = error.message;
  }
}

async function loadDatabases() {
  try {
    const databases = await request('/api/databases');
    fillSelect(elements.audit.database, databases, '全部库');
    fillSelect(elements.slow.database, databases, '全部库');
  } catch {
    fillSelect(elements.audit.database, [], '全部库');
    fillSelect(elements.slow.database, [], '全部库');
  }
}

async function loadAudit() {
  if (state.loadingAudit) return;
  state.loadingAudit = true;
  elements.audit.searchBtn.disabled = true;
  elements.audit.refreshBtn.disabled = true;
  elements.audit.count.textContent = '查询中';

  try {
    const params = getAuditParams();
    const [summary, users, audit] = await Promise.all([
      request(`/api/audit/summary?${params}`),
      request(`/api/audit/top-users?${params}`),
      request(`/api/audit/records?${params}`),
    ]);

    renderAuditMetrics(summary);
    renderAuditUsers(users);
    renderAuditRows(audit.records || []);
  } catch (error) {
    elements.audit.body.innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(error.message)}</td></tr>`;
    elements.audit.count.textContent = '查询失败';
  } finally {
    elements.audit.searchBtn.disabled = false;
    elements.audit.refreshBtn.disabled = false;
    state.loadingAudit = false;
  }
}

async function loadSlow() {
  if (state.loadingSlow) return;
  state.loadingSlow = true;
  elements.slow.searchBtn.disabled = true;
  elements.slow.refreshBtn.disabled = true;
  elements.slow.recordCount.textContent = '查询中';

  try {
    const params = getSlowParams();
    const [summary, fingerprints, slow] = await Promise.all([
      request(`/api/slow/summary?${params}`),
      request(`/api/slow/fingerprints?${params}`),
      request(`/api/slow/records?${params}`),
    ]);

    renderSlowMetrics(summary);
    renderSlowFingerprints(fingerprints);
    renderSlowRows(slow.records || []);
  } catch (error) {
    elements.slow.body.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(error.message)}</td></tr>`;
    elements.slow.recordCount.textContent = '查询失败';
    elements.slow.fingerprintList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  } finally {
    elements.slow.searchBtn.disabled = false;
    elements.slow.refreshBtn.disabled = false;
    state.loadingSlow = false;
  }
}

function setActiveView(view) {
  state.activeView = view;
  elements.navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  elements.auditView.classList.toggle('hidden', view !== 'audit');
  elements.slowView.classList.toggle('hidden', view !== 'slow');
  if (view === 'slow' && !state.slowRows.length && !state.loadingSlow) {
    loadSlow();
  }
}

function bindEvents() {
  elements.navItems.forEach((item) => {
    item.addEventListener('click', () => setActiveView(item.dataset.view));
  });

  elements.audit.searchBtn.addEventListener('click', loadAudit);
  elements.audit.refreshBtn.addEventListener('click', async () => {
    await checkHealth();
    await loadDatabases();
    await loadAudit();
  });
  elements.audit.limit.addEventListener('change', loadAudit);
  elements.audit.body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const row = state.auditRows[Number(button.dataset.index)];
    showSqlDetail(row?.query || row?.exception || '');
  });

  elements.slow.searchBtn.addEventListener('click', loadSlow);
  elements.slow.refreshBtn.addEventListener('click', async () => {
    await checkHealth();
    await loadDatabases();
    await loadSlow();
  });
  elements.slow.limit.addEventListener('change', loadSlow);
  elements.slow.body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const row = state.slowRows[Number(button.dataset.index)];
    showSqlDetail(row?.query || row?.exception || '');
  });
  elements.slow.fingerprintList.addEventListener('click', (event) => {
    const card = event.target.closest('[data-fingerprint-index]');
    if (!card) return;
    const row = state.slowFingerprints[Number(card.dataset.fingerprintIndex)];
    showSqlDetail(row?.sample_query || '');
  });
}

async function bootstrap() {
  setDefaultRanges();
  bindEvents();
  await Promise.all([checkHealth(), loadDatabases()]);
  await loadAudit();
}

bootstrap();
