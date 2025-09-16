export default {
  async fetch(request) {
    const url = new URL(request.url);

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


    // pass-through
    return fetch(request);
  }
}
