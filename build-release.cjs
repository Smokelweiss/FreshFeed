// Builds dist/freshfeed-<version>.zip from the extension sources.
//
// The archive layout matches the existing releases: extension files at the
// root of the zip (so Firefox can load it directly), plus docs/.
// Scratch files (_fix_content.py) and the dist/ folder itself are excluded.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const outName = `freshfeed-${version}.zip`;
const outPath = path.join(ROOT, "dist", outName);

// Extension files that ship. Order mirrors the real extension layout.
const FILES = [
  "manifest.json",
  "content.js",
  "content.css",
  "page-filter.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "options.html",
  "options.js",
  "README.md",
  "LICENSE"
];

// Derive the icon list from the manifest so a newly-referenced icon can never
// be left out of the package.
const ICONS = Array.from(new Set([
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  "icons/icon.svg"
])).filter(Boolean);

// Ship the whole docs/ tree (including docs/superpowers/) the way previous
// releases did, so the archives stay structurally identical.
function collectDir(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = relDir + "/" + entry.name;
    if (entry.isDirectory()) out.push(...collectDir(rel));
    else out.push(rel);
  }
  return out;
}

const DOCS = collectDir("docs");

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const missing = [...FILES, ...ICONS, ...DOCS].filter((rel) => !exists(rel));
if (missing.length) {
  console.error("Missing required file(s):\n  " + missing.join("\n  "));
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

const toPack = [...FILES, ...ICONS, ...DOCS].filter(exists);

// Use tar's zip writer so no third-party dependency is needed.
execFileSync("tar", ["-a", "-c", "-f", outPath, ...toPack], { cwd: ROOT, stdio: "inherit" });

const size = fs.statSync(outPath).size;
console.log(`\nBuilt ${outName} (${(size / 1024).toFixed(1)} KB) with ${toPack.length} entries:`);
for (const f of toPack) console.log("  " + f);
