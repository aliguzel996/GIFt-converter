const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIcoModule = require("png-to-ico");
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const projectRoot = path.resolve(__dirname, "..");
const sourceSvg = path.join(projectRoot, "assets", "GIFt-Converterlogos.svg");
const outputPng = path.join(projectRoot, "assets", "icon.png");
const outputIco = path.join(projectRoot, "assets", "icon.ico");
const tempDir = path.join(projectRoot, "tmp", "icon-build");

const sizes = [16, 24, 32, 48, 64, 128, 256];

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function main() {
  if (!fs.existsSync(sourceSvg)) {
    throw new Error(`Source icon not found: ${sourceSvg}`);
  }

  await ensureDir(tempDir);

  await sharp(sourceSvg, { density: 144, limitInputPixels: false })
    .resize(512, 512, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    })
    .png()
    .toFile(outputPng);

  const resizedPngs = [];

  for (const size of sizes) {
    const filePath = path.join(tempDir, `icon-${size}.png`);
    await sharp(sourceSvg, { density: 144, limitInputPixels: false })
      .resize(size, size, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 0 }
      })
      .png()
      .toFile(filePath);
    resizedPngs.push(filePath);
  }

  const icoBuffer = await pngToIco(resizedPngs);
  await fs.promises.writeFile(outputIco, icoBuffer);
  console.log(`Built icon: ${outputIco}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
