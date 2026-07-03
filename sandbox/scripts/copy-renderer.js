// Copy the renderer HTML + xterm.js vendor assets into dist/renderer/.
// (tsc emits dist/renderer/renderer.js; the HTML references it directly.)
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "dist", "renderer");
const vendorDir = path.join(outDir, "vendor");
fs.mkdirSync(vendorDir, { recursive: true });

fs.copyFileSync(
  path.join(root, "src", "renderer", "index.html"),
  path.join(outDir, "index.html")
);

// xterm.js UMD bundles + CSS, shipped as browser globals (no bundler)
const vendor = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
];
for (const [from, to] of vendor) {
  const src = path.join(root, "node_modules", from);
  if (!fs.existsSync(src)) {
    console.error(`missing vendor asset: ${from} (run \`npm install\`)`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(vendorDir, to));
}
console.log("copied renderer/index.html + xterm vendor assets");
