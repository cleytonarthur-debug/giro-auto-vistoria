// Copia a fonte Montserrat para docs/fonts e gera os ícones. Rodar depois de `npm install`.
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
for (const d of ["fonts", "icons"]) mkdirSync(join(docs, d), { recursive: true });

const ranges = {
  latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
};
let css = "";
for (const w of [400, 600, 700, 800]) for (const subset of Object.keys(ranges)) {
  const file = `montserrat-${subset}-${w}-normal.woff2`;
  const src = join(root, "node_modules", "@fontsource", "montserrat", "files", file);
  if (!existsSync(src)) throw new Error("Fonte não encontrada: " + src);
  cpSync(src, join(docs, "fonts", file));
  css += `@font-face{font-family:"Montserrat";font-style:normal;font-weight:${w};font-display:swap;src:url(${file}) format("woff2");unicode-range:${ranges[subset]}}\n`;
}
writeFileSync(join(docs, "fonts", "fonts.css"), css);

// Ícones: desenho (tools/icon.svg) sobre o fundo escuro do app.
const fg = readFileSync(join(root, "tools", "icon.svg"));
const BG = "#0B0E14";
async function icon(size, inset, round, out) {
  const inner = Math.round(size * inset);
  const fgPng = await sharp(fg, { density: 600 }).resize(inner, inner).png().toBuffer();
  const r = round ? Math.round(size * 0.2) : 0;
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="${BG}"/></svg>`);
  await sharp(bg).composite([{ input: fgPng, gravity: "center" }]).png().toFile(join(docs, "icons", out));
}
await icon(192, 0.82, true, "icon-192.png");
await icon(512, 0.82, true, "icon-512.png");
await icon(512, 0.62, false, "icon-maskable-512.png");
await icon(180, 0.76, false, "apple-touch-icon.png");
console.log("docs/ pronto");
