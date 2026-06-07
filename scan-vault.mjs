#!/usr/bin/env node
// scan-vault.mjs — reads your Obsidian vault and generates graph.json
//
// Vault path is resolved in this order:
//   1. CLI arg:           node scan-vault.mjs "/path/to/vault"
//   2. VAULT_PATH env:    VAULT_PATH="/path/to/vault" node scan-vault.mjs
//   3. .vault-path file:  first non-comment line (gitignored)
//   4. ./sample-vault     (the bundled demo vault)
//
// Design:
//   - Each note = a node (id = relative path without .md).
//   - Each resolved [[wikilink]] = a directed edge.
//   - Filters noise (code blocks: n8n JSON [[{"node":...}]], regex classes
//     [[:space:]], template placeholders, empty links).
//   - Keeps unresolved targets as "ghost" nodes, like Obsidian's graph view.
//   - Stores the surrounding sentence of each link as the edge label
//     (this feeds the "distributed mode": how ideas connect).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, basename, sep } from 'node:path';
import { homedir } from 'node:os';

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

function resolveVault() {
  if (process.argv[2]) return expandHome(process.argv[2]);
  if (process.env.VAULT_PATH) return expandHome(process.env.VAULT_PATH);
  try {
    const line = readFileSync(join(process.cwd(), '.vault-path'), 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'));
    if (line) return expandHome(line);
  } catch {
    /* no .vault-path → fall through to the bundled demo */
  }
  return join(process.cwd(), 'sample-vault');
}

const VAULT = resolveVault();
const OUT = join(process.cwd(), 'graph.json');

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.smart-env']);

// ---- recoger todos los .md ----------------------------------------------
async function walk(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, acc);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

// ---- limpiar un target de wikilink --------------------------------------
function cleanTarget(raw) {
  let t = raw.split('|')[0]; // alias  [[link|texto]]
  t = t.split('#')[0]; // heading [[link#sec]]
  t = t.split('^')[0]; // block   [[link^id]]
  t = t.trim();
  if (!t) return null;
  // Ruido de código/exports: n8n JSON ([[{"node":…}]]), clases POSIX de regex
  // ([[:space:]]), rutas con backslash, etc. En macOS un nombre de nota no
  // puede contener ':' ni '\', así que se descartan con seguridad.
  if (/[{}"\\:<>]/.test(t)) return null;
  if (t.length > 200) return null;
  if (/Y{2,}|M{2,}-D{2,}/.test(t)) return null; // placeholders de plantilla (YYYY-MM-DD)
  // normalizar separadores
  t = t.replace(/^\.\//, '').replace(/\\/g, '/');
  return t;
}

// limpia una línea para usarla como etiqueta de arista
function cleanContext(line) {
  return line
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, a, __, b) => b || basename(a))
    .replace(/[*_`>#]+/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function topFolder(id) {
  const parts = id.split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

// etiqueta corta y legible (quita prefijo de fecha de los AI-chats, trunca)
function makeShort(title) {
  const m = title.match(/^\d{4}-\d{2}-\d{2}\s*[-–]\s*(.+)$/);
  let s = (m ? m[1] : title).replace(/\s+/g, ' ').trim();
  if (s.length > 46) s = s.slice(0, 44).trimEnd() + '…';
  return s;
}

// ---- main ----------------------------------------------------------------
const files = await walk(VAULT);
if (files.length === 0) {
  console.error(`No se encontraron .md en:\n  ${VAULT}\nPasa la ruta como argumento: node scan-vault.mjs "/ruta/al/vault"`);
  process.exit(1);
}

const nodes = new Map(); // id -> nodo
const byBasename = new Map(); // basename(lower) -> [ids]

function idFor(file) {
  return relative(VAULT, file).split(sep).join('/').replace(/\.md$/i, '');
}

// primera pasada: registrar nodos
const raw = new Map(); // id -> texto
for (const file of files) {
  const id = idFor(file);
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue;
  }
  raw.set(id, text);
  const bn = basename(id).toLowerCase();
  const node = {
    id,
    title: basename(id),
    short: makeShort(basename(id)),
    folder: topFolder(id),
    ghost: false,
    words: text.split(/\s+/).filter(Boolean).length,
    degree: 0,
  };
  nodes.set(id, node);
  if (!byBasename.has(bn)) byBasename.set(bn, []);
  byBasename.get(bn).push(id);
}

function resolve(target, fromId) {
  // 1) match exacto por ruta (con o sin extensión)
  const direct = target.replace(/\.md$/i, '');
  if (nodes.has(direct)) return direct;
  // 2) match por basename único
  const bn = basename(direct).toLowerCase();
  const cands = byBasename.get(bn);
  if (cands && cands.length === 1) return cands[0];
  if (cands && cands.length > 1) {
    // preferir el que comparte carpeta con el origen
    const fromFolder = topFolder(fromId);
    const same = cands.find((c) => topFolder(c) === fromFolder);
    return same || cands[0];
  }
  return null; // no resuelto -> se creará un nodo "ghost"
}

// crea (o recupera) un nodo ghost para un link a una nota que no existe como
// archivo. Obsidian los muestra igual en su grafo. Devuelve el id o null si
// el target no parece una nota real.
function getOrCreateGhost(target) {
  const id = target.replace(/\.md$/i, '');
  if (nodes.has(id)) return id;
  if (!/[a-zA-Z]/.test(id)) return null; // sin letras -> basura
  if (id.length < 2) return null;
  const node = {
    id,
    title: basename(id),
    short: makeShort(basename(id)),
    folder: topFolder(id),
    ghost: true,
    words: 0,
    degree: 0,
  };
  nodes.set(id, node);
  const bn = basename(id).toLowerCase();
  if (!byBasename.has(bn)) byBasename.set(bn, []);
  byBasename.get(bn).push(id);
  return id;
}

// segunda pasada: extraer links + contexto
const linkMap = new Map(); // "src|dst" -> {source,target,context}
const WIKILINK = /\[\[([^\]\n]+?)\]\]/g;
let totalLinks = 0,
  noise = 0,
  unresolved = 0;

for (const [id, text] of raw) {
  const lines = text.split('\n');
  for (const line of lines) {
    let m;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(line))) {
      totalLinks++;
      const target = cleanTarget(m[1]);
      if (!target) {
        noise++;
        continue;
      }
      let dst = resolve(target, id);
      if (!dst) {
        dst = getOrCreateGhost(target);
        if (!dst) {
          unresolved++;
          continue;
        }
      }
      if (dst === id) continue; // self-loop
      const key = id + '|' + dst;
      if (!linkMap.has(key)) {
        linkMap.set(key, { source: id, target: dst, context: cleanContext(line) });
        nodes.get(id).degree++;
        nodes.get(dst).degree++;
      }
    }
  }
}

const links = [...linkMap.values()];

// tamaño del nodo según grado (con piso) y carpeta
const nodeArr = [...nodes.values()].map((n) => ({
  ...n,
  size: 1 + Math.sqrt(n.degree) * 1.6,
}));

const graph = {
  generatedAt: new Date().toISOString(),
  vault: VAULT,
  stats: {
    notes: nodeArr.filter((n) => !n.ghost).length,
    ghosts: nodeArr.filter((n) => n.ghost).length,
    totalNodes: nodeArr.length,
    links: links.length,
    rawWikilinks: totalLinks,
    filteredNoise: noise,
    unresolved,
  },
  nodes: nodeArr,
  links,
};

await writeFile(OUT, JSON.stringify(graph, null, 0));

// ---- reporte -------------------------------------------------------------
const byFolder = {};
for (const n of nodeArr) byFolder[n.folder] = (byFolder[n.folder] || 0) + 1;
const hubs = [...nodeArr].sort((a, b) => b.degree - a.degree).slice(0, 12);

console.log(`\n✓ graph.json escrito en ${OUT}\n`);
console.log(`Notas (archivo):  ${graph.stats.notes}`);
console.log(`Ghosts (sin file):${String(graph.stats.ghosts).padStart(5)}`);
console.log(`Nodos totales:    ${graph.stats.totalNodes}`);
console.log(`Aristas (limpias):${String(graph.stats.links).padStart(5)}`);
console.log(`Wikilinks brutos: ${graph.stats.rawWikilinks}`);
console.log(`  · ruido (n8n…): ${graph.stats.filteredNoise}`);
console.log(`  · descartados:  ${graph.stats.unresolved}`);
console.log(`\nNodos por carpeta:`);
for (const [f, c] of Object.entries(byFolder).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(c).padStart(4)}  ${f}`);
console.log(`\nHubs (más conectados):`);
for (const h of hubs) console.log(`  ${String(h.degree).padStart(3)}  ${h.id}`);
console.log('');
