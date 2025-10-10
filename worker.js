import { 
    handleRequest as dockerProxyHandler, 
    responseUnauthorized,
} from './docker.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const css_paths = ["/bing.css", "/bing-no-logo.css", "/bing-no-logo-search.css"]

    // / -_-
    if (url.pathname === "/")
      return new Response(`
        <!DOCTYPE html><html><head><meta><title>-_-</title>
        <style>html,body{margin:0;height:100vh;display:flex;justify-content:center;align-items:center;overflow:hidden;background:#000}img{max-width:100%;max-height:100%;width:auto;height:auto}</style></head>
        <body><img src="https://s3.sorali.org/image/mutsumi.jpg" alt="-_-"></body></html>
      `, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600"
        }
      });


    // /bing.css 用于获取 Bing 图片并替换 Firefox 新标签页的背景图片
    if (css_paths.includes(url.pathname)) {
      const bing = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN");
      const data = await bing.json();
      const img_url = "https://www.bing.com" + data.images[0].url;
      const copyright_text = data.images[0].copyright;

      const logo_visibility_css = url.pathname.includes("no-logo") ? "visibility: hidden;" : "";
      const search_visibility_css = url.pathname.includes("no-logo-search") ? "visibility: hidden;" : "";
      const css = `
      @-moz-document url("about:newtab") {
        .search-inner-wrapper {
          ${search_visibility_css}
        }
        .logo-and-wordmark-wrapper {
          ${logo_visibility_css}
        }
        .activity-stream {
          background-image: url("${img_url}") !important;
          background-size: cover !important;
          background-attachment: fixed !important;
        }
        .activity-stream::before {
          content: "${copyright_text.replace(/"/g, '\\"')}";
          position: absolute;
          bottom: 20px;
          right: 20px;
          left: unset;
          font-size: 14px;
          color: gray;
          text-shadow: 0 0 4px rgba(0,0,0,0.6);
          z-index: 9999;

          background-color: rgba(0, 0, 0, 0.2);
          padding: 8px 12px;
          border-radius: 8px;
          box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
          user-select: text;
        }
      }`;

      return new Response(css, {
        headers: { "content-type": "text/css; charset=utf-8" }
      });
    }


  //  /api/cors/ 代理请求所给出的地址并为响应结果添加CORS跨域访问
  if (url.pathname.startsWith("/api/cors/")) {
      const targetUrlString = url.toString().replace(url.origin + "/api/cors/", "");

      let targetUrl;
      try {
          targetUrl = new URL(targetUrlString);
      } catch (e) {
          return new Response("Invalid URL after /api/cors/", { status: 400 });
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

      if (request.method === "OPTIONS") {
          return new Response(null, {
              status: 204, 
              headers: newResp.headers 
          });
      }
      return newResp;
  }

    // default docker hub proxy
    return dockerProxyHandler(request);
  }
};
