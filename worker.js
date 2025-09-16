export default {
  async fetch(request) {
    const bing = await fetch("https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN");
    const data = await bing.json();
    const img = "https://www.bing.com" + data.images[0].url;
    const text = data.images[0].copyright;

    const css = `
    @-moz-document url("about:newtab") {
      .activity-stream {
        background-image: url("${img}") !important;
        background-size: cover !important;
        background-attachment: fixed !important;
      }
      .activity-stream::before {
        content: "${text.replace(/"/g, '\\"')}";
        position: absolute;
        bottom: 30px;
        left: 30px;
        font-size: 18px;
        color: white;
        text-shadow: 0 0 4px rgba(0,0,0,0.6);
        z-index: 9999;
      }
    }`;

    return new Response(css, {
      headers: { "content-type": "text/css; charset=utf-8" }
    });
  }
}
