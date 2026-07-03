// DDNS: 更新 Cloudflare DNS 记录
// 逻辑参考 ddns-backend (FastAPI → Cloudflare Worker 移植)

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * 从 env.DDNS_CONFIG 解析配置
 * DDNS_CONFIG 格式: {"tokens":{"tok1":["sub1"]},"records":{"sub1":{"zone_id":"...","record_id":"...","name":"sub1.example.com","type":"A","ttl":120,"proxied":false}}}
 */
function parseConfig(env) {
  if (!env.DDNS_CONFIG) {
    throw new Error("DDNS_CONFIG not set");
  }
  try {
    return JSON.parse(env.DDNS_CONFIG);
  } catch (e) {
    throw new Error("DDNS_CONFIG is not valid JSON");
  }
}

/**
 * Bearer token 验证 + 子域名权限检查
 * 返回 token 标识符（用于日志）
 */
function authenticate(authHeader, subdomain, config) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "missing or invalid authorization header" };
  }

  const token = authHeader.slice(7).trim();
  const allowed = config.tokens[token];

  if (!allowed) {
    return { ok: false, status: 401, error: "unknown token" };
  }

  const allowedList = Array.isArray(allowed) ? allowed : [allowed];
  if (!allowedList.includes(subdomain)) {
    return { ok: false, status: 403, error: "subdomain not allowed for this token" };
  }

  return { ok: true };
}

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
    return { value: xff.split(",")[0].trim(), source: "x-forwarded-for" };
  }

  return null;
}

/**
 * 验证 IP 与记录类型匹配
 * IPv4 → A, IPv6 → AAAA
 */
function validateIPForRecordType(ip, recordType) {
  const isIPv6 = ip.includes(":");
  if (recordType === "A" && isIPv6) {
    return { ok: false, error: `IPv6 address not allowed for A record` };
  }
  if (recordType === "AAAA" && !isIPv6) {
    return { ok: false, error: `IPv4 address not allowed for AAAA record` };
  }
  return { ok: true };
}

/**
 * 调用 Cloudflare API 更新 DNS 记录
 * PUT /zones/{zone_id}/dns_records/{record_id}
 */
async function updateDNSRecord(apiToken, record, ip) {
  const url = `${CF_API_BASE}/zones/${record.zone_id}/dns_records/${record.record_id}`;
  const payload = {
    type: record.type,
    name: record.name,
    content: ip,
    ttl: record.ttl || 120,
    proxied: record.proxied || false,
  };

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await resp.json();

  if (!resp.ok || !body.success) {
    const errors = body.errors?.map(e => e.message).join("; ") || `HTTP ${resp.status}`;
    throw new Error(`Cloudflare API error: ${errors}`);
  }

  return body;
}

/**
 * DDNS 请求入口
 */
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const subdomain = url.searchParams.get("name");

  if (!subdomain) {
    return new Response(JSON.stringify({
      success: false,
      error: "missing 'name' parameter",
      hint: "Usage: /ddns/update?name=<subdomain>"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 解析配置
  let config;
  try {
    config = parseConfig(env);
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 认证
  const auth = authenticate(request.headers.get("Authorization"), subdomain, config);
  if (!auth.ok) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: auth.status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 查找记录配置
  const record = config.records[subdomain];
  if (!record) {
    return new Response(JSON.stringify({
      success: false,
      error: `unknown subdomain: ${subdomain}`
    }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 解析客户端 IP
  const explicitIP = url.searchParams.get("ip");
  const resolvedIP = resolveClientIP(request, explicitIP);
  if (!resolvedIP) {
    return new Response(JSON.stringify({
      success: false,
      error: "cannot determine client IP"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 验证 IP 与记录类型
  const ipValid = validateIPForRecordType(resolvedIP.value, record.type);
  if (!ipValid.ok) {
    return new Response(JSON.stringify({ success: false, error: ipValid.error }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // 调用 Cloudflare API
  const apiToken = env.CF_API_TOKEN;
  if (!apiToken) {
    return new Response(JSON.stringify({
      success: false,
      error: "CF_API_TOKEN not configured"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  try {
    await updateDNSRecord(apiToken, record, resolvedIP.value);
    return new Response(JSON.stringify({
      success: true,
      record: record.name,
      type: record.type,
      ip: resolvedIP.value,
      ip_source: resolvedIP.source,
      changed: true,
      cloudflare_called: true,
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      success: false,
      error: e.message
    }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
}
