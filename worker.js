export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // / -_-
    if (url.pathname === "/")
      return Response.redirect("https://s3.sorali.org/image/mutsumi-_-.jpg", 302);

    // /bing.css 用于获取 Bing 图片并替换 Firefox 新标签页的背景图片
    if (url.pathname === "/bing.css") {
      const bing = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN");
      const data = await bing.json();
      const img = "https://www.bing.com" + data.images[0].url;
      const text = data.images[0].copyright;

      const css = `
      @-moz-document url("about:newtab") {
        .search-inner-wrapper {
          visibility: hidden;
        }
        .logo-and-wordmark-wrapper {
          visibility: hidden;
        }
        .activity-stream {
          background-image: url("${img}") !important;
          background-size: cover !important;
          background-attachment: fixed !important;
        }
        .activity-stream::before {
          content: "${text.replace(/"/g, '\\"')}";
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


    // 代理访问Bing API时增加CORS头 允许跨域访问
    if (url.pathname === "/api/bing/") {
      const targetUrl = "https://www.bing.com/HPImageArchive.aspx" + url.search;
      const resp = await fetch(targetUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0",
        },
      });
      const newResp = new Response(resp.body, resp);
      newResp.headers.set("Access-Control-Allow-Origin", "*");
      newResp.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      newResp.headers.set("Access-Control-Allow-Headers", "Content-Type");

      return newResp;
    }

    // pass-through
    return fetch(request);
  }
};
