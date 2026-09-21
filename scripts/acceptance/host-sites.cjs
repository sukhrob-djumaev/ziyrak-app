// Two tiny "customer websites" on distinct origins (different ports = different origins),
// so the widget's cross-origin behaviour (CORS, Origin allowlist) is genuinely exercised.
// Serves whatever HTML the driver wrote to pages/<port>.html (the product-issued embed snippet).
const http = require("http");
const fs = require("fs");
const path = require("path");
const dir = path.join(process.env.ACC_WORK_DIR || path.join(__dirname, ".work"), "pages");
fs.mkdirSync(dir, { recursive: true });
for (const port of [4020, 4021, 4022]) {
  http
    .createServer((req, res) => {
      const f = path.join(dir, `${port}.html`);
      if (!fs.existsSync(f)) {
        res.writeHead(404);
        return res.end("no page yet");
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(f));
    })
    .listen(port, "127.0.0.1", () => console.log("host site on " + port));
}
