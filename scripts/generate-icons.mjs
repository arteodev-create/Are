import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = process.cwd();
const sourceSvg = path.join(root, 'public', 'veritas-icon.svg');
const buildDir = path.join(root, 'build');
const publicDir = path.join(root, 'public');
const androidResDir = path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'res');

const androidIconSizes = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];

async function renderPng(outputPath, size) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(sourceSvg)
    .resize(size, size)
    .png()
    .toFile(outputPath);
}

async function main() {
  await fs.mkdir(buildDir, { recursive: true });

  const icoPngs = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const outputPath = path.join(buildDir, `icon-${size}.png`);
    await renderPng(outputPath, size);
    icoPngs.push(outputPath);
  }
  await fs.writeFile(path.join(buildDir, 'icon.ico'), await pngToIco(icoPngs));

  await renderPng(path.join(publicDir, 'icon-192.png'), 192);
  await renderPng(path.join(publicDir, 'icon-512.png'), 512);
  await renderPng(path.join(publicDir, 'maskable-icon-512.png'), 512);

  for (const [density, size] of androidIconSizes) {
    const launcherPath = path.join(androidResDir, density, 'ic_launcher.png');
    const roundPath = path.join(androidResDir, density, 'ic_launcher_round.png');
    const foregroundPath = path.join(androidResDir, density, 'ic_launcher_foreground.png');
    await renderPng(launcherPath, size);
    await renderPng(roundPath, size);
    await renderPng(foregroundPath, size);
  }

  console.log('Generated Veritas icons for PWA, Android, and Windows.');
}

main().catch((error) => {
  console.error(`Icon generation failed: ${error.message}`);
  process.exit(1);
});
