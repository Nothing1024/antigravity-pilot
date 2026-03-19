/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");

const pkgDir = path.resolve(__dirname, "..");
const distDir = path.join(pkgDir, "dist");
const cjsDir = path.join(pkgDir, "dist-cjs");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

fs.mkdirSync(distDir, { recursive: true });

// 1) Copy CommonJS build artifacts next to ESM artifacts, using .cjs extension
//    to avoid clobbering dist/*.js (ESM).
for (const src of walk(cjsDir)) {
  if (!src.endsWith(".js")) continue;
  const rel = path.relative(cjsDir, src);
  const dest = path.join(distDir, rel).replace(/\.js$/, ".cjs");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 2) Patch index.cjs requires to point at the copied .cjs files.
const indexCjs = path.join(distDir, "index.cjs");
let code = fs.readFileSync(indexCjs, "utf8");
code = code.replace(/require\(\"(\.\/[^"]+)\"\)/g, (m, p) => {
  if (p.endsWith(".cjs")) return m;
  if (p.endsWith(".js")) return `require("${p.slice(0, -3)}.cjs")`;
  return `require("${p}.cjs")`;
});
fs.writeFileSync(indexCjs, code);

// 3) Mark dist as CommonJS for legacy `require("./dist")` consumers.
fs.writeFileSync(
  path.join(distDir, "package.json"),
  // Keep `type: module` so Node treats dist/*.js as ESM (used by package exports "import").
  // `require("./dist")` still works because main points to an explicit .cjs file.
  JSON.stringify({ private: true, type: "module", main: "./index.cjs" }, null, 2) +
    "\n"
);
