// Copy the renderer HTML into dist/ (tsc emits the JS alongside it).
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "src", "renderer", "index.html");
const outDir = path.join(__dirname, "..", "dist", "renderer");
fs.mkdirSync(outDir, { recursive: true });
// dist/renderer/renderer.js is emitted by tsc; the HTML references it directly
fs.copyFileSync(src, path.join(outDir, "index.html"));
console.log("copied renderer/index.html");
