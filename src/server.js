import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@clickhouse/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3020);

const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: Number(process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS || 30000)
});

const publicDir = path.resolve(__dirname, '..', 'public');
const queryLogColumnsCache = { value: null, loadedAt: 0 };

app.use(express.json({ limit: '512kb' }));
app.use(express.static(publicDir));

function limitNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeIsoDate(value, fallbackOffsetHours = -24) {
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const date = new Date(Date.now() + fallbackOffsetHours * 60 * 60 * 1000);
  return date.toISOString();
}

function normalizeIpValue(value) {
  return String(value || '')
    .trim()
    .replace(/^::ffff:/i, '');
}

function has(columns, column) {
  return columns.has(column);
}

function firstAvailable(columns, names, fallbackExpression = "''") {
  const matched = names.find((name) => columns.has(name));
  return matched || fallbackExpression;
}

async function getQueryLogColumns() {
  const now = Date.now();
  if (queryLogColumnsCache.value && now - queryLogColumnsCache.loadedAt < 5 * 60 * 1000) {
    return queryLogColumnsCache.value;
  }

  const result = await clickhouse.query({
    query: 'DESCRIBE TABLE system.query_log',
    format: 'JSONEachRow'
  });
  const rows = await result.json();
  const columns = new Set(rows.map((row) => row.name));
  queryLogColumnsCache.value = columns;
  queryLogColumnsCache.loadedAt = now;
  return columns;
}

function buildAuditWhere(columns, filters, params) {
  const conditions = [];

  if (has(columns, 'event_time')) {
    conditions.push('event_time >= parseDateTimeBestEffort({from:String})');
    conditions.push('event_time <= parseDateTimeBestEffort({to:String})');
    params.from = filters.from;
    params.to = filters.to;
  }

  if (has(columns, 'type')) {
    conditions.push("type IN ('QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing')");
  }

  const userExpr = firstAvailable(columns, ['initial_user', 'user']);
  if (filters.user && userExpr !== "''") {
    conditions.push(`positionCaseInsensitive(toString(${userExpr}), {user:String}) > 0`);
    params.user = filters.user;
  }

  const databaseExpr = firstAvailable(columns, ['current_database', 'database']);
  if (filters.database && databaseExpr !== "''") {
    conditions.push(`${databaseExpr} = {database:String}`);
    params.database = filters.database;
  }

  if (filters.keyword && has(columns, 'query')) {
    conditions.push('positionCaseInsensitive(query, {keyword:String}) > 0');
    params.keyword = filters.keyword;
  }

  if (filters.ip) {
    const ipConditions = [];
    const normalizedIp = normalizeIpValue(filters.ip);
    if (has(columns, 'address')) {
      ipConditions.push(
        `positionCaseInsensitive(replaceRegexpAll(toString(address), '^::ffff:', ''), {ip:String}) > 0`
      );
    }
    if (has(columns, 'initial_address')) {
      ipConditions.push(
        `positionCaseInsensitive(replaceRegexpAll(toString(initial_address), '^::ffff:', ''), {ip:String}) > 0`
      );
    }
    if (has(columns, 'forwarded_for')) {
      ipConditions.push(`positionCaseInsensitive(forwarded_for, {ip:String}) > 0`);
    }
    if (ipConditions.length) {
      conditions.push(`(${ipConditions.join(' OR ')})`);
      params.ip = normalizedIp;
    }
  }

  if (filters.status === 'success' && has(columns, 'exception_code')) {
    conditions.push('exception_code = 0');
  }

  if (filters.status === 'error' && has(columns, 'exception_code')) {
    conditions.push('exception_code != 0');
  }

  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

function getAuditFilters(req) {
  const from = normalizeIsoDate(req.query.from, -24);
  const to = normalizeIsoDate(req.query.to, 0);

  return {
    from,
    to,
    user: String(req.query.user || '').trim(),
    database: String(req.query.database || '').trim(),
    keyword: String(req.query.keyword || '').trim(),
    ip: normalizeIpValue(req.query.ip),
    status: ['success', 'error'].includes(req.query.status) ? req.query.status : '',
    limit: limitNumber(req.query.limit, 100, 1, 500),
    offset: limitNumber(req.query.offset, 0, 0, 100000)
  };
}

function getSlowFilters(req) {
  const filters = getAuditFilters(req);
  return {
    ...filters,
    status: '',
    minDurationMs: limitNumber(req.query.minDurationMs, 1000, 1, 24 * 60 * 60 * 1000)
  };
}

function buildSlowWhere(columns, filters, params) {
  let where = buildAuditWhere(columns, filters, params);
  if (has(columns, 'query_duration_ms')) {
    params.minDurationMs = filters.minDurationMs;
    where = where
      ? `${where} AND query_duration_ms >= {minDurationMs:UInt64}`
      : 'WHERE query_duration_ms >= {minDurationMs:UInt64}';
  }
  return where;
}

function auditSelect(columns) {
  const eventTime = has(columns, 'event_time') ? 'event_time' : 'now()';
  const userExpr = firstAvailable(columns, ['initial_user', 'user']);
  const databaseExpr = firstAvailable(columns, ['current_database', 'database']);
  const typeExpr = has(columns, 'type') ? 'toString(type)' : "''";
  const queryKindExpr = has(columns, 'query_kind')
    ? 'query_kind'
    : has(columns, 'query')
      ? "upper(extract(query, '^\\\\s*([a-zA-Z]+)'))"
      : "''";
  const addressExpr = has(columns, 'initial_address')
    ? "replaceRegexpAll(toString(initial_address), '^::ffff:', '')"
    : has(columns, 'address')
      ? "replaceRegexpAll(toString(address), '^::ffff:', '')"
      : "''";

  return `
    SELECT
      ${eventTime} AS event_time,
      toString(${userExpr}) AS user,
      toString(${databaseExpr}) AS database,
      ${has(columns, 'query_id') ? 'query_id' : "''"} AS query_id,
      ${queryKindExpr} AS query_kind,
      ${typeExpr} AS type,
      ${has(columns, 'query_duration_ms') ? 'query_duration_ms' : '0'} AS duration_ms,
      ${has(columns, 'read_rows') ? 'read_rows' : '0'} AS read_rows,
      ${has(columns, 'read_bytes') ? 'read_bytes' : '0'} AS read_bytes,
      ${has(columns, 'written_rows') ? 'written_rows' : '0'} AS written_rows,
      ${has(columns, 'memory_usage') ? 'memory_usage' : '0'} AS memory_usage,
      ${has(columns, 'exception_code') ? 'exception_code' : '0'} AS exception_code,
      ${has(columns, 'exception') ? 'exception' : "''"} AS exception,
      ${addressExpr} AS client_address,
      ${has(columns, 'address') ? "replaceRegexpAll(toString(address), '^::ffff:', '')" : "''"} AS query_address,
      ${has(columns, 'initial_address') ? "replaceRegexpAll(toString(initial_address), '^::ffff:', '')" : "''"} AS initial_client_address,
      ${has(columns, 'forwarded_for') ? 'forwarded_for' : "''"} AS forwarded_for,
      ${has(columns, 'query') ? 'query' : "''"} AS query
  `;
}

function durationExpression(columns) {
  return has(columns, 'query_duration_ms') ? 'query_duration_ms' : '0';
}

function readRowsExpression(columns) {
  return has(columns, 'read_rows') ? 'read_rows' : '0';
}

function readBytesExpression(columns) {
  return has(columns, 'read_bytes') ? 'read_bytes' : '0';
}

function memoryExpression(columns) {
  return has(columns, 'memory_usage') ? 'memory_usage' : '0';
}

function exceptionExpression(columns) {
  return has(columns, 'exception_code') ? 'exception_code' : '0';
}

function fingerprintExpression(columns) {
  if (has(columns, 'normalized_query_hash')) return 'normalized_query_hash';
  if (has(columns, 'query')) return 'cityHash64(query)';
  return '0';
}

app.get('/api/health', async (_req, res) => {
  const startedAt = Date.now();
  try {
    const ping = await clickhouse.ping();
    const success = typeof ping === 'boolean' ? ping : ping.success;
    res.json({
      ok: success,
      latency_ms: Date.now() - startedAt,
      configured_database: process.env.CLICKHOUSE_DATABASE || '',
      url: process.env.CLICKHOUSE_URL
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      message: error.message,
      configured_database: process.env.CLICKHOUSE_DATABASE || '',
      url: process.env.CLICKHOUSE_URL
    });
  }
});

app.get('/api/audit/records', async (req, res) => {
  try {
    const filters = getAuditFilters(req);
    const params = {};
    const columns = await getQueryLogColumns();
    const where = buildAuditWhere(columns, filters, params);
    params.limit = filters.limit;
    params.offset = filters.offset;

    const result = await clickhouse.query({
      query: `
        ${auditSelect(columns)}
        FROM system.query_log
        ${where}
        ORDER BY event_time DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `,
      format: 'JSONEachRow',
      query_params: params
    });

    res.json({
      filters,
      records: await result.json()
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/audit/summary', async (req, res) => {
  try {
    const filters = getAuditFilters(req);
    const params = {};
    const columns = await getQueryLogColumns();
    const where = buildAuditWhere(columns, filters, params);
    const userExpr = firstAvailable(columns, ['initial_user', 'user']);
    const durationExpr = has(columns, 'query_duration_ms') ? 'query_duration_ms' : '0';
    const readRowsExpr = has(columns, 'read_rows') ? 'read_rows' : '0';
    const readBytesExpr = has(columns, 'read_bytes') ? 'read_bytes' : '0';
    const exceptionExpr = has(columns, 'exception_code') ? 'exception_code' : '0';

    const result = await clickhouse.query({
      query: `
        SELECT
          count() AS total,
          countIf(${exceptionExpr} != 0) AS failed,
          round(avg(${durationExpr}), 2) AS avg_duration_ms,
          max(${durationExpr}) AS max_duration_ms,
          sum(${readRowsExpr}) AS read_rows,
          sum(${readBytesExpr}) AS read_bytes,
          uniqExact(toString(${userExpr})) AS users
        FROM system.query_log
        ${where}
      `,
      format: 'JSONEachRow',
      query_params: params
    });

    const [summary] = await result.json();
    res.json(summary || {});
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/audit/top-users', async (req, res) => {
  try {
    const filters = getAuditFilters(req);
    const params = {};
    const columns = await getQueryLogColumns();
    const where = buildAuditWhere(columns, filters, params);
    const userExpr = firstAvailable(columns, ['initial_user', 'user']);
    const durationExpr = has(columns, 'query_duration_ms') ? 'query_duration_ms' : '0';
    const exceptionExpr = has(columns, 'exception_code') ? 'exception_code' : '0';

    const result = await clickhouse.query({
      query: `
        SELECT
          toString(${userExpr}) AS user,
          count() AS total,
          countIf(${exceptionExpr} != 0) AS failed,
          round(avg(${durationExpr}), 2) AS avg_duration_ms
        FROM system.query_log
        ${where}
        GROUP BY user
        ORDER BY total DESC
        LIMIT 8
      `,
      format: 'JSONEachRow',
      query_params: params
    });

    res.json(await result.json());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/slow/summary', async (req, res) => {
  try {
    const filters = getSlowFilters(req);
    const params = {};
    const columns = await getQueryLogColumns();
    const where = buildSlowWhere(columns, filters, params);
    const durationExpr = durationExpression(columns);
    const readRowsExpr = readRowsExpression(columns);
    const readBytesExpr = readBytesExpression(columns);
    const memoryExpr = memoryExpression(columns);
    const exceptionExpr = exceptionExpression(columns);
    const fingerprintExpr = fingerprintExpression(columns);

    const result = await clickhouse.query({
      query: `
        SELECT
          count() AS total,
          uniqExact(${fingerprintExpr}) AS fingerprints,
          countIf(${exceptionExpr} != 0) AS failed,
          round(avg(${durationExpr}), 2) AS avg_duration_ms,
          round(quantile(0.95)(${durationExpr}), 2) AS p95_duration_ms,
          round(quantile(0.99)(${durationExpr}), 2) AS p99_duration_ms,
          max(${durationExpr}) AS max_duration_ms,
          sum(${readRowsExpr}) AS read_rows,
          sum(${readBytesExpr}) AS read_bytes,
          max(${memoryExpr}) AS max_memory_usage
        FROM system.query_log
        ${where}
      `,
      format: 'JSONEachRow',
      query_params: params
    });

    const [summary] = await result.json();
    res.json(summary || {});
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/slow/records', async (req, res) => {
  try {
    const filters = getSlowFilters(req);
    const params = {};
    const columns = await getQueryLogColumns();
    const where = buildSlowWhere(columns, filters, params);
    params.limit = filters.limit;
    params.offset = filters.offset;

    const result = await clickhouse.query({
      query: `
        ${auditSelect(columns)}
        FROM system.query_log
        ${where}
        ORDER BY duration_ms DESC, event_time DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}
      `,
      format: 'JSONEachRow',
      query_params: params
    });

    res.json({
      filters,
      records: await result.json()
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/slow/fingerprints', async (req, res) => {
  try {
    const filters = getSlowFilters(req);
    const params = {};
    const columns = await getQueryLogColumns();
    const where = buildSlowWhere(columns, filters, params);
    const fingerprintExpr = fingerprintExpression(columns);
    params.limit = limitNumber(req.query.limit, 12, 1, 50);

    const result = await clickhouse.query({
      query: `
        SELECT
          fingerprint,
          count() AS total,
          countIf(exception_code != 0) AS failed,
          round(avg(duration_ms), 2) AS avg_duration_ms,
          round(quantile(0.95)(duration_ms), 2) AS p95_duration_ms,
          max(duration_ms) AS max_duration_ms,
          sum(read_rows) AS read_rows,
          sum(read_bytes) AS read_bytes,
          max(memory_usage) AS max_memory_usage,
          argMax(user, duration_ms) AS user,
          argMax(database, duration_ms) AS database,
          argMax(client_address, duration_ms) AS client_address,
          argMax(query_kind, duration_ms) AS query_kind,
          argMax(query, duration_ms) AS sample_query,
          max(event_time) AS last_seen
        FROM (
          ${auditSelect(columns)},
          ${fingerprintExpr} AS fingerprint
          FROM system.query_log
          ${where}
        )
        GROUP BY fingerprint
        ORDER BY max_duration_ms DESC, total DESC
        LIMIT {limit:UInt32}
      `,
      format: 'JSONEachRow',
      query_params: params
    });

    res.json(await result.json());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/databases', async (_req, res) => {
  try {
    const result = await clickhouse.query({
      query: 'SHOW DATABASES',
      format: 'JSONEachRow'
    });
    const rows = await result.json();
    res.json(rows.map((row) => row.name || row.database || Object.values(row)[0]).filter(Boolean));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`ClickHouse DAS is running at http://localhost:${port}`);
});
