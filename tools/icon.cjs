// Rasterise src/icon.svg -> icon.png + icon.ico.  npm run icon
// Uses electron (already a devDependency) rather than adding a rasteriser.
//
// Draws the SVG into a canvas and reads the bytes back, rather than
// capturePage(): a hidden window never paints, so capturePage never resolves.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const DIR = path.join(__dirname, '..', 'src');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** ICO container: 6-byte header, 16 bytes per entry, then the PNGs verbatim. */
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type 1 = icon
  head.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const dir = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...images.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
  const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body>');

  const out = [];
  for (const size of SIZES) {
    const data = await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = c.height = ${size};
          c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('svg failed to decode'));
        img.src = ${JSON.stringify(url)};
      })
    `);
    out.push({ size, png: Buffer.from(data.split(',')[1], 'base64') });
  }

  fs.writeFileSync(path.join(DIR, 'icon.png'), out.at(-1).png);
  fs.writeFileSync(path.join(DIR, 'icon.ico'), ico(out));

  for (const { size, png } of out) console.log(`  ${size}x${size}: ${png.length} bytes`);
  win.destroy();
  app.quit();
});
