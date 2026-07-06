// DDNS: 更新 Cloudflare DNS 记录
// 1:1 移植自 ddns-backend (FastAPI → Cloudflare Worker)
// 参考: ../ddns-backend/app/main.py, config.py, cloudflare.py, ip_utils.py

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ── 配置解析 ──────────────────────────────────────────────

/**
 * 从 env.DDNS_CONFIG 解析配置
 * DDNS_CONFIG 格式 (JSON):
 *   { "zone_id": "global-zone-id",
 *     "tokens": {"tok1": ["sub1"]},
 *     "records": {"sub1": {"record_id":"...","name":"sub1.example.com","type":"A","ttl":120,"proxied":false,"zone_id":"..."}}
 *   }
 * zone_id 可全局设置，也可在每条 record 中覆盖
 */
function parseConfig(env) {
  if (!env.DDNS_CONFIG) {
    throw new Error("DDNS_CONFIG not set");
  }
  let raw;
  try {
    raw = JSON.parse(env.DDNS_CONFIG);
  } catch (e) {
    throw new Error("DDNS_CONFIG is not valid JSON");
  }

  // 验证 tokens
  const tokensRaw = raw.tokens || {};
  if (typeof tokensRaw !== "object" || Array.isArray(tokensRaw)) {
    throw new Error("DDNS_CONFIG: 'tokens' must be an object");
  }
  const tokens = {};
  for (const [token, allowed] of Object.entries(tokensRaw)) {
    const t = token.trim();
    if (!t) throw new Error("DDNS_CONFIG: empty token key in 'tokens'");
    const list = Array.isArray(allowed) ? allowed : [allowed];
    tokens[t] = list.map((s) => String(s).trim()).filter(Boolean);
  }

  // 验证 records
  const recordsRaw = raw.records || {};
  if (typeof recordsRaw !== "object" || Array.isArray(recordsRaw)) {
    throw new Error("DDNS_CONFIG: 'records' must be an object");
  }
  let hasPerRecordZone = false;
  const records = {};
  for (const [subdomain, cfg] of Object.entries(recordsRaw)) {
    const sd = subdomain.trim();
    if (typeof cfg !== "object" || cfg === null) {
      throw new Error(`DDNS_CONFIG: [records.${sd}] must be an object`);
    }
    const recordId = (cfg.record_id || "").trim();
    if (!recordId) {
      throw new Error(`DDNS_CONFIG: [records.${sd}] missing 'record_id'`);
    }
    const name = (cfg.name || sd).trim();
    const recordType = (cfg.type || "A").toUpperCase();
    if (recordType !== "A" && recordType !== "AAAA") {
      throw new Error(`DDNS_CONFIG: [records.${sd}] type must be 'A' or 'AAAA'`);
    }
    const recZone = (cfg.zone_id || "").trim() || null;
    if (recZone) hasPerRecordZone = true;
    records[sd] = {
      record_id: recordId,
      name: name,
      type: recordType,
      zone_id: recZone,
      ttl: cfg.ttl != null ? cfg.ttl : 120,
      proxied: !!cfg.proxied,
    };
  }

  // 验证 zone_id：优先 per-record 自有值，回退全局
  const zoneId = (raw.zone_id || "").trim() || null;
  if (!zoneId && !hasPerRecordZone) {
    throw new Error(
      "DDNS_CONFIG: set 'zone_id' globally or in each record"
    );
  }

  return {
    zone_id: zoneId,
    tokens: tokens,
    records: records,
    /** 查找记录配置 */
    lookupRecord(subdomain) {
      const r = this.records[subdomain];
      if (!r) throw new Error(`unknown subdomain: ${subdomain}`);
      return r;
    },
    /** 解析 zone_id: per-record 覆盖 → 全局 */
    zoneFor(subdomain) {
      const r = this.lookupRecord(subdomain);
      return r.zone_id || this.zone_id;
    },
  };
}

// ── IP 状态追踪（KV 持久化） ──────────────────────────────
// 使用 Cloudflare KV 存储上次更新的 IP，Worker 重启后仍可读取。
// 如未绑定 DDNS_STATE KV 命名空间，自动降级为内存缓存（跨请求不持久）。

const _memFallback = new Map();

async function getLastIP(env, subdomain) {
  if (env.DDNS_STATE) {
    try {
      const val = await env.DDNS_STATE.get(`ip:${subdomain}`);
      if (val != null) return val;
    } catch { /* 降级到内存 */ }
  }
  return _memFallback.get(subdomain) || null;
}

async function setLastIP(env, subdomain, ip) {
  if (env.DDNS_STATE) {
    try {
      await env.DDNS_STATE.put(`ip:${subdomain}`, ip);
      return;
    } catch { /* 降级到内存 */ }
  }
  _memFallback.set(subdomain, ip);
}

// ── 子域名级别锁 ──────────────────────────────────────────

const _subdomainLocks = {};

function getLock(subdomain) {
  if (!_subdomainLocks[subdomain]) {
    _subdomainLocks[subdomain] = Promise.resolve();
  }
  return _subdomainLocks[subdomain];
}

/**
 * 简易异步互斥锁 (per-subdomain)
 * 确保同一子域名的更新请求串行执行
 */
async function withLock(subdomain, fn) {
  const prev = getLock(subdomain);
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  _subdomainLocks[subdomain] = next;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ── 辅助函数 ──────────────────────────────────────────────

function parseBool(value) {
  if (value === true || value === false) return value;
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

// ── 认证 ──────────────────────────────────────────────────

/**
 * Bearer token 验证 + 子域名权限检查
 * 返回 token 字符串
 * 失败时抛出包含 status/error 的对象
 */
function authenticate(authHeader, subdomain, config) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const token = authHeader.slice(7).trim();
  const allowed = config.tokens[token];

  if (!allowed) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  if (!allowedList.includes(subdomain)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true, token };
}

// ── IP 解析 ──────────────────────────────────────────────

/**
 * 解析客户端 IP
 * 优先级: ?ip= 显式指定 > CF-Connecting-IP > X-Forwarded-For
 */
function resolveClientIP(request, explicitIP) {
  if (explicitIP) {
    return { value: explicitIP, source: "query" };
  }

  const cfIP = request.headers.get("CF-Connecting-IP");
  if (cfIP) {
    return { value: cfIP, source: "cf-connecting-ip" };
  }

  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) {
      return { value: first, source: "x-forwarded-for" };
    }
  }

  return null;
}

/**
 * 验证 IP 与记录类型匹配
 */
function validateIPForRecordType(ip, recordType) {
  const isIPv6 = ip.includes(":");
  if (recordType === "A" && isIPv6) {
    return { ok: false, error: "IPv6 address is not valid for A record" };
  }
  if (recordType === "AAAA" && !isIPv6) {
    return { ok: false, error: "IPv4 address is not valid for AAAA record" };
  }
  return { ok: true };
}

// ── Cloudflare API ────────────────────────────────────────

/**
 * 调用 Cloudflare API 更新 DNS 记录
 * PUT /zones/{zone_id}/dns_records/{record_id}
 */
async function updateDNSRecord(apiToken, zoneId, record, ip) {
  const url = `${CF_API_BASE}/zones/${zoneId}/dns_records/${record.record_id}`;
  const payload = {
    type: record.type,
    name: record.name,
    content: ip,
    ttl: record.ttl,
    proxied: record.proxied,
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`Cloudflare API request failed: ${e.message}`);
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Cloudflare API returned non-JSON response: ${text.slice(0, 1024)}`
    );
  }

  if (!resp.ok || !body.success) {
    const cfErrors = (body.errors || [])
      .map((e) => `cf_code=${e.code} cf_message=${e.message}`)
      .join(" ");
    const msg = body.errors
      ? body.errors.map((e) => e.message).join("; ")
      : `HTTP ${resp.status}`;
    throw new Error(`Cloudflare API error: ${msg}${cfErrors ? " " + cfErrors : ""}`);
  }

  return { status_code: resp.status };
}

// ── 请求入口 ──────────────────────────────────────────────

/**
 * DDNS 更新请求处理
 * 使用方式:
 *   GET  /ddns/update/<subdomain>[?ip=...][&force=true]
 *   POST /ddns/update/<subdomain>[?ip=...][&force=true]
 */
export async function handleRequest(request, env) {
  const url = new URL(request.url);

  // ── 从路径提取子域名 ──────────────────────────────────
  // /ddns/update/<subdomain> → subdomain
  const pathParts = url.pathname.split("/");
  // pathParts = ["", "ddns", "update", "subdomain"]
  // 后面可能还有尾随斜杠或其他路径，只取第一段
  const subdomain = pathParts.length >= 4 ? pathParts[3] : null;

  if (!subdomain) {
    return new Response(
      JSON.stringify({ success: false, error: "missing subdomain in URL path" }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // ── 解析配置 ──────────────────────────────────────────
  let config;
  try {
    config = parseConfig(env);
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── 认证 ──────────────────────────────────────────────
  const auth = authenticate(request.headers.get("Authorization"), subdomain, config);
  if (!auth.ok) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── 查找记录配置 ──────────────────────────────────────
  let record;
  try {
    record = config.lookupRecord(subdomain);
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: `Subdomain '${subdomain}' not configured` }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // ── 解析 zone_id ──────────────────────────────────────
  const zoneId = config.zoneFor(subdomain);

  // ── 解析 IP ──────────────────────────────────────────
  const explicitIP = url.searchParams.get("ip");
  const resolvedIP = resolveClientIP(request, explicitIP);
  if (!resolvedIP) {
    return new Response(
      JSON.stringify({ success: false, error: "Unable to determine client IP" }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // ── 验证 IP 类型 ────────────────────────────────────
  const ipValid = validateIPForRecordType(resolvedIP.value, record.type);
  if (!ipValid.ok) {
    return new Response(JSON.stringify({ success: false, error: ipValid.error }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // ── 检查 API Token ──────────────────────────────────
  const apiToken = env.CF_API_TOKEN;
  if (!apiToken) {
    return new Response(
      JSON.stringify({ success: false, error: "CF_API_TOKEN not configured" }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  const currentIP = resolvedIP.value;
  const forced = parseBool(url.searchParams.get("force"));

  // ── 带锁执行更新 ────────────────────────────────────
  return withLock(subdomain, async () => {
    const previousIP = await getLastIP(env, subdomain);

    // IP 未变且未强制 → 跳过
    if (!forced && previousIP === currentIP) {
      return new Response(
        JSON.stringify(
          {
            success: true,
            record: record.name,
            type: record.type,
            ip: currentIP,
            ip_source: resolvedIP.source,
            changed: false,
            cloudflare_called: false,
            forced: false,
            previous_ip: previousIP,
          },
          null,
          2
        ),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // ── 调 Cloudflare API ────────────────────────────
    let result;
    try {
      result = await updateDNSRecord(apiToken, zoneId, record, currentIP);
    } catch (e) {
      return new Response(
        JSON.stringify({ success: false, error: "Cloudflare API request failed" }),
        { status: 502, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // 保存当前 IP 到 KV
    await setLastIP(env, subdomain, currentIP);

    return new Response(
      JSON.stringify(
        {
          success: true,
          record: record.name,
          type: record.type,
          ip: currentIP,
          ip_source: resolvedIP.source,
          changed: previousIP !== currentIP || forced,
          cloudflare_called: true,
          forced: forced,
          previous_ip: previousIP,
          cloudflare_status: result.status_code,
        },
        null,
        2
      ),
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  });
}
