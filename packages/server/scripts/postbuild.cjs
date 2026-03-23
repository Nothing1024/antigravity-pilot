const fs = require("node:fs");
const path = require("node:path");

const pkgDir = path.resolve(__dirname, "..");
const distDir = path.join(pkgDir, "dist");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function patchSpecifier(spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return spec;
  if (spec.includes("?") || spec.includes("#")) return spec;

  // If there's already an extension (e.g. .js/.json/.cjs), keep it.
  if (path.posix.extname(spec)) return spec;
  return `${spec}.js`;
}

function patchCode(code) {
  let next = code;

  // Static imports / exports: `from "./x"`
  next = next.replace(/(\bfrom\s+["'])([^"']+)(["'])/g, (m, p1, spec, p3) => {
    return `${p1}${patchSpecifier(spec)}${p3}`;
  });

  // Side-effect imports: `import "./x"`
  next = next.replace(/(\bimport\s+["'])([^"']+)(["'])/g, (m, p1, spec, p3) => {
    return `${p1}${patchSpecifier(spec)}${p3}`;
  });

  // Dynamic imports: `import("./x")`
  next = next.replace(
    /(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g,
    (m, p1, spec, p3) => {
      return `${p1}${patchSpecifier(spec)}${p3}`;
    },
  );

  return next;
}

if (!fs.existsSync(distDir)) {
  console.warn(`[postbuild] dist directory not found: ${distDir}`);
  process.exit(0);
}

let patchedFiles = 0;
for (const file of walk(distDir)) {
  if (!file.endsWith(".js")) continue;
  const code = fs.readFileSync(file, "utf8");
  const next = patchCode(code);
  if (next !== code) {
    fs.writeFileSync(file, next);
    patchedFiles++;
  }
}

console.log(`[postbuild] patched ${patchedFiles} dist file(s)`);

