// Xuat mot tep .drawio.xml (trang dau) ra PNG nen trang, do phan giai cao.
// Dung lai trang export3.html cua draw.io da duoc goi draw.io-export luu dem san.
//   node export_png.js <vao.drawio.xml> <ra.png> [scale] [border]
const path = require('path');
const fs = require('fs');
const NPM = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'draw.io-export');
const puppeteer = require(path.join(NPM, 'node_modules', 'puppeteer'));

const cacheDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'draw.io-export');
const cacheDict = {
  'https://www.draw.io/export3.html': 'export3.html',
  'https://app.diagrams.net/export3.html': 'export3.html',
  'https://www.draw.io/js/app.min.js': 'app.min.js',
  'https://app.diagrams.net/js/app.min.js': 'app.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.5/MathJax.js?config=TeX-MML-AM_HTMLorMML': 'MathJax.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.5/config/TeX-MML-AM_HTMLorMML.js?V=2.7.5': 'TeX-MML-AM_HTMLorMML.js',
  'https://cdn.mathjax.org/mathjax/contrib/a11y/accessibility-menu.js?V=2.7.5': 'accessibility-menu.js',
};

(async () => {
  const [, , input, output, scaleArg, borderArg, pageArg] = process.argv;
  const scale = parseFloat(scaleArg || '2');
  const border = parseInt(borderArg || '20', 10);
  const pageIndex = parseInt(pageArg || '0', 10);
  const xml = fs.readFileSync(input, 'utf-8');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = cacheDict[req.url()];
      if (t && fs.existsSync(path.join(cacheDir, t))) {
        req.respond({ status: 200, body: fs.readFileSync(path.join(cacheDir, t)) });
      } else {
        req.continue();
      }
    });
    await page.goto('https://www.draw.io/export3.html', { waitUntil: 'networkidle0' });
    await page.evaluate((obj) => { window.doc = mxUtils.parseXml(obj); }, xml);
    await page.evaluate((idx, opts) => {
      const root = window.doc.documentElement;
      const dup = root.cloneNode(false);
      const diagrams = Array.from(root.children).filter((n) => n.nodeType === 1);
      dup.appendChild(diagrams[idx].cloneNode(true));
      opts.xml = dup.outerHTML;
      render(opts);
    }, pageIndex, { format: 'png', w: 0, h: 0, border, bg: '#ffffff', scale });
    await page.waitForSelector('#LoadingComplete');
    const bounds = JSON.parse(await page.$eval('#LoadingComplete', (d) => d.getAttribute('bounds')));
    const w = Math.ceil(bounds.width);
    const h = Math.ceil(bounds.height);
    await page.setViewport({ width: w, height: h });
    await page.screenshot({ type: 'png', fullPage: true, path: output, omitBackground: false });
    console.log('ok', output, w, h);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
