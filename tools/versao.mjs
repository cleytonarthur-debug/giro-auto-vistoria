// Troca a versão do app nos 3 lugares de uma vez, antes de publicar (git push).
// Uso: node tools/versao.mjs 1.0.1 "O que mudou 1" "O que mudou 2"
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [versao, ...notas] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(versao || "")) { console.error("Informe a versão, ex.: node tools/versao.mjs 1.0.1 \"nota\""); process.exit(1); }
const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const hoje = new Date();
const data = String(hoje.getDate()).padStart(2, "0") + "/" + String(hoje.getMonth() + 1).padStart(2, "0") + "/" + hoje.getFullYear();

writeFileSync(join(docs, "versao.json"), JSON.stringify({ versao, data, notas }, null, 2) + "\n");
const at = join(docs, "js", "atualizacao.js");
writeFileSync(at, readFileSync(at, "utf8")
  .replace(/var VERSAO = "[^"]*";/, `var VERSAO = "${versao}";`)
  .replace(/var DATA = "[^"]*";/, `var DATA = "${data}";`));
const sw = join(docs, "sw.js");
writeFileSync(sw, readFileSync(sw, "utf8").replace(/const CACHE = "[^"]*";/, `const CACHE = "giro-auto-vistoria-${versao}";`));
console.log("Versão " + versao + " (" + data + ") gravada em versao.json, atualizacao.js e sw.js.");
