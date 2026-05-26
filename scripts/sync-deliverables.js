const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));
const version = packageJson.version || "0.1.0";

const args = new Set(process.argv.slice(2));
const mode = [...args][0] || "all";

const paths = {
  webSource: path.join(projectRoot, "cpanel", "gift-converter"),
  webDest: path.join(projectRoot, "GIFt-Converter", "web"),
  portableSource: path.join(projectRoot, "release", "portable-build", "gift-converter-win32-x64"),
  portableDest: path.join(projectRoot, "GIFt-Converter", "windows app"),
  setupSource: path.join(projectRoot, "release", `gift-converter-${version}.exe`),
  setupDestDir: path.join(projectRoot, "GIFt-Converter", "itch build"),
  setupDest: path.join(projectRoot, "GIFt-Converter", "itch build", "gift-converter-setup.exe"),
  schemaSource: path.join(projectRoot, "metadata", "schema", "software-application.schema.json"),
  webSchemaDest: path.join(projectRoot, "cpanel", "gift-converter", "software-application.schema.json"),
  webSchemaMirror: path.join(projectRoot, "GIFt-Converter", "web", "software-application.schema.json"),
  logoSvgSource: path.join(projectRoot, "assets", "GIFt-Converterlogos.svg"),
  logoPngSource: path.join(projectRoot, "assets", "icon.png"),
  webLogoSvgDest: path.join(projectRoot, "cpanel", "gift-converter", "GIFt-Converterlogos.svg"),
  webLogoPngDest: path.join(projectRoot, "cpanel", "gift-converter", "icon.png"),
  webLogoSvgMirror: path.join(projectRoot, "GIFt-Converter", "web", "GIFt-Converterlogos.svg"),
  webLogoPngMirror: path.join(projectRoot, "GIFt-Converter", "web", "icon.png")
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDir(sourceDir, destDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing source directory: ${sourceDir}`);
  }
  resetDir(destDir);
  fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
}

function copyFile(sourceFile, destFile) {
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Missing source file: ${sourceFile}`);
  }
  ensureDir(path.dirname(destFile));
  fs.copyFileSync(sourceFile, destFile);
}

function syncMetadata() {
  copyFile(paths.schemaSource, paths.webSchemaDest);
  copyFile(paths.logoSvgSource, paths.webLogoSvgDest);
  copyFile(paths.logoPngSource, paths.webLogoPngDest);
}

function syncWeb() {
  syncMetadata();
  copyDir(paths.webSource, paths.webDest);
  copyFile(paths.schemaSource, paths.webSchemaMirror);
  copyFile(paths.logoSvgSource, paths.webLogoSvgMirror);
  copyFile(paths.logoPngSource, paths.webLogoPngMirror);
}

function syncPortable() {
  copyDir(paths.portableSource, paths.portableDest);
}

function syncSetup() {
  ensureDir(paths.setupDestDir);
  copyFile(paths.setupSource, paths.setupDest);
}

function main() {
  if (mode === "metadata") {
    syncMetadata();
    console.log("Synced metadata into web source.");
    return;
  }

  if (mode === "web") {
    syncWeb();
    console.log("Synced web deliverable.");
    return;
  }

  if (mode === "portable") {
    syncPortable();
    console.log("Synced portable Windows app.");
    return;
  }

  if (mode === "setup") {
    syncSetup();
    console.log("Synced setup installer.");
    return;
  }

  if (mode === "all") {
    syncMetadata();
    syncWeb();
    syncPortable();
    syncSetup();
    console.log("Synced all deliverables.");
    return;
  }

  throw new Error(`Unknown sync mode: ${mode}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
