// The redesigned Cannu UI, side by side with the old one. Serves next/index.html
// and passes everything else (the API, the logo) to the real dashboard, so both
// UIs drive the same features. Archived 2026-11-09 (only its header was kept). Run: node archive/apple-redesign/serve.js, then open :4001.
import http from "node:http";
import fs from "node:fs";

const UP = JSON.parse(fs.readFileSync(new URL("../../config.json", import.meta.url))).dashboardPort;
const PORT = Number(process.env.PORT) || 4001;
const UI = new URL("./index.html", import.meta.url);

http.createServer((req, res) => {
  if (req.method === "GET" && new URL(req.url, "http://x").pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(UI)); // read on every load, like the old one
  }
  const up = http.request({ host: "127.0.0.1", port: UP, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ msg: `The Cannu dashboard on :${UP} isn't running. Start it with node server.js in tools/cannu.` }));
  });
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`New Cannu UI on http://localhost:${PORT} (API from :${UP})`));
