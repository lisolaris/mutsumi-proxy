import {
    handleRequest as dockerProxyHandler,
    responseUnauthorized,
} from './docker.js';
import { handleRequest as ddnsHandler } from './ddns.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const css_paths = ["/bing.css", "/bing-no-logo.css", "/bing-no-logo-search.css"]


    // / cucumber
    if (url.pathname === "/")
      return new Response(`
        <!DOCTYPE html><html><head><meta><title></title>
        <style>html,body{margin:0;height:100vh;display:flex;justify-content:center;align-items:center;overflow:hidden;background:#000}img{max-width:100%;max-height:100%;width:auto;height:auto}</style></head>
        <body><img src="https://s3.sorali.org/image/mutsumi.jpg" alt="-_-"></body></html>
      `, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "Content-Security-Policy": "img-src 'self' https://s3.sorali.org"
        }
      });

    // favicon: 代理返回，避免跨域 CSP 问题
    if (url.pathname === "/favicon.ico") {
      const resp = await fetch("https://s3.sorali.org/image/cucumber.ico");
      const newResp = new Response(resp.body, resp);
      newResp.headers.set("Cache-Control", "public, max-age=2592000, immutable");
      return newResp;
    }


    // teapot
    if (url.pathname === "/teapot")
      return new Response("I'm a teapot", {
        status: 418,
        statusText: "I'm a teapot",
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });


  //  /cors/ 或 /api/cors/ 代理请求所给出的地址并为响应结果添加CORS跨域访问
  if (url.pathname.startsWith("/cors/") || url.pathname.startsWith("/api/cors/")) {
      const targetUrlString = url.toString().replace(url.origin + "/cors/", "");

      let targetUrl;
      try {
          targetUrl = new URL(targetUrlString);
      } catch (e) {
          return new Response("Invalid URL after /cors/", { status: 400 });
      }

      // OPTIONS 预检请求直接返回，无需请求上游
      if (request.method === "OPTIONS") {
          return new Response(null, {
              status: 204,
              headers: {
                  "Access-Control-Allow-Origin": "*",
                  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
                  "Access-Control-Max-Age": "86400",
              }
          });
      }

      const requestHeaders = new Headers(request.headers);
      requestHeaders.delete("host");

      // 执行代理请求
      const resp = await fetch(targetUrl, {
          method: request.method,
          headers: requestHeaders,
          body: request.body,
          redirect: 'follow'
      });

      // 创建新的响应对象，保留原始响应的内容和状态
      const newResp = new Response(resp.body, resp);

      newResp.headers.set("Access-Control-Allow-Origin", "*");
      newResp.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
      newResp.headers.set("Access-Control-Max-Age", "86400");

      return newResp;
  }

  // /generate_204 产生一个204响应
  if (url.pathname.startsWith("/generate_204")) {
    return new Response(null, {
        status: 204,
        headers: {
            "Cache-Control": "public, max-age=3600"
        }
    });
  }

  // /dummy 产生一个200空响应
  if (url.pathname.startsWith("/dummy")) {
    return new Response(null, {
        status: 200,
        headers: {
            "Cache-Control": "public, max-age=3600"
        }
    });
  }


  // /echo 返回请求调试信息（IP、Headers、Geo 等）
  if (url.pathname === "/echo") {
    const { cf, headers } = request;
    const echo = {
      method: request.method,
      url: request.url,
      ip: headers.get("CF-Connecting-IP") || "unknown",
      userAgent: headers.get("User-Agent") || null,
      geo: cf ? {
        country: cf.country || null,
        city: cf.city || null,
        region: cf.region || null,
        timezone: cf.timezone || null,
        colo: cf.colo || null,
        asn: cf.asn || null,
        asOrganization: cf.asOrganization || null,
        httpProtocol: cf.httpProtocol || null,
        tlsVersion: cf.tlsVersion || null,
      } : null,
      headers: Object.fromEntries(headers.entries()),
    };
    return new Response(JSON.stringify(echo, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // /status/<code> 返回指定的 HTTP 状态码
  if (url.pathname.startsWith("/status/")) {
    const codeStr = url.pathname.replace("/status/", "");
    const statusCode = parseInt(codeStr, 10);
    // 有效的 HTTP 状态码范围: 100-599
    if (isNaN(statusCode) || statusCode < 100 || statusCode > 599) {
      return new Response(JSON.stringify({
        error: "Invalid status code",
        hint: "Provide a number between 100 and 599, e.g. /status/418"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    const body = url.searchParams.get("body") || `${statusCode} ${getStatusText(statusCode)}`;
    return new Response(body, {
      status: statusCode,
      statusText: getStatusText(statusCode),
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // /uuid 生成 UUID
  if (url.pathname === "/uuid") {
    const countStr = url.searchParams.get("n");
    const count = countStr ? Math.min(Math.max(parseInt(countStr, 10) || 1, 1), 100) : 1;
    const uuids = Array.from({ length: count }, () => crypto.randomUUID());
    const body = count === 1 ? { uuid: uuids[0] } : { count, uuids };
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    });
  }


  // /ddns/update 更新 Cloudflare DNS 记录
  if (url.pathname === "/ddns/update")
    return ddnsHandler(request, env);


  // default docker hub proxy
    return dockerProxyHandler(request);
  }
};

// 常见 HTTP 状态码对应的状态文本
function getStatusText(code) {
  const map = {
    100: "Continue", 101: "Switching Protocols", 102: "Processing",
    200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
    204: "No Content", 205: "Reset Content", 206: "Partial Content",
    300: "Multiple Choices", 301: "Moved Permanently", 302: "Found",
    304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict",
    410: "Gone", 418: "I'm a teapot", 422: "Unprocessable Entity",
    429: "Too Many Requests", 451: "Unavailable For Legal Reasons",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return map[code] || "Unknown";
}
