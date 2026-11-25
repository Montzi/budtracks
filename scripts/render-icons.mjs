// Renders icons/icon-source.svg's design to the PNGs in icons/. Needs the Instrument Serif italic woff2: npm pack @fontsource/instrument-serif, then fix the paths below.
// After changing the icon, bump ?v= in index.html, manifest.webmanifest and sw.js so Safari fetches the new files.
import { execFileSync } from 'node:child_process';
import { pw } from '/home/claude/budtracks/tests/lib.mjs';
const svgs = JSON.parse(execFileSync('python3', ['-c', `
import sys, json; sys.path.insert(0, '/home/claude/tools')
from icons import A
s = A('q')
sq = s.replace('rx="228"', 'rx="0"').replace('M0 228 A228 228 0 0 1 228 0 H796 A228 228 0 0 1 1024 228 V420', 'M0 0 H1024 V420')
sq = sq[:sq.rindex('<rect x="2"')] + '</svg>'
i = sq.index('<text'); j = sq.rindex('</svg>')
mask = sq[:i] + '<g transform="translate(512 528) scale(.78) translate(-512 -528)">' + sq[i:j] + '</g></svg>'
print(json.dumps({'square': sq, 'mask': mask}))
`]).toString());
import { readFileSync } from 'node:fs';
const font = 'data:font/woff2;base64,' + readFileSync('/home/claude/fontpkg/x/package/files/instrument-serif-latin-400-italic.woff2').toString('base64');
const out = '/home/claude/budtracks/icons/';
const b = await pw.chromium.launch();
for (const [file, size, kind] of [['apple-touch-icon.png', 180, 'square'], ['icon-192.png', 192, 'square'], ['icon-512.png', 512, 'square'], ['icon-maskable-512.png', 512, 'mask'], ['/tmp/icon-preview-1024.png', 1024, 'square']]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<style>@font-face{font-family:"Instrument Serif";font-style:italic;src:url(${font}) format("woff2")}html,body{margin:0;background:#0c1428}svg{display:block;width:${size}px;height:${size}px}</style>${svgs[kind]}`);
  await p.evaluate(() => document.fonts.load('italic 100px "Instrument Serif"'));
  await p.evaluate(() => document.fonts.ready);
  const ok = await p.evaluate(() => document.fonts.check('italic 100px "Instrument Serif"'));
  await p.screenshot({ path: file.startsWith('/') ? file : out + file, omitBackground: false });
  console.log(file, size, 'font loaded:', ok);
  await p.close();
}
await b.close();
