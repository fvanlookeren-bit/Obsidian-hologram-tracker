// app.js — Topologías de Pensamiento
// Webcam + face tracking (MediaPipe) + grafo holográfico de tu vault Obsidian.
//
// Composición: 1 <video> de fondo + 1 <canvas> Three.js con cámara ORTOGRÁFICA
// en espacio de píxeles. El grafo vive en coords abstractas (force-layout 3D);
// cada frame lo roto a mano, lo proyecto a píxeles y lo anclo a tu cabeza.
// La malla de la cara se dibuja con la teselación de MediaPipe sobre tus 478
// landmarks. Todo aditivo => glow de holograma sin un bloom pass.

import * as THREE from 'three';
import { LineSegments2 } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/lines/LineMaterial.js';
import {
  FaceLandmarker,
  HandLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist3 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

// ---- paleta NEÓN estilo Jarvis (cian/azul + oro para las memorias) ----------
const PALETTE = {
  '00-Memory':   0xffd24a, // MEMORIAS = oro neón → destacan para pincharlas
  '01-Projects': 0x35f0ff, // proyectos = cian eléctrico
  '03-Daily':    0x4aa8ff, // días = azul
  'Context':     0xb06bff, // contexto = violeta neón
  '05-AI-Chats': 0x5f86b0, // chats = azul acero (la "polvareda", tenue)
  'Projects':    0x35f0ff,
  '02-Notes':    0x46ffd0, // notas = verde menta neón
  '04-Archive':  0x55606a,
  '(root)':      0x9fd0ff,
  __default:     0x8fb8d8,
};
const colorFor = (folder) =>
  new THREE.Color(PALETTE[folder] ?? PALETTE.__default);

// ---- estado global ----------------------------------------------------------
const S = {
  showFace: true,
  showHands: true,
  showLabels: true,
  distributed: true,
  rotate: true,
  paused: false,
  hover: -1, // nodo bajo el mouse
  handHover: -1, // nodo apuntado con el índice (cursor de la mano)
  pinned: -1, // nodo seleccionado (pinchado / click)
  openAmt: -1, // apertura de la mano (0 puño .. 1 abierta; -1 = sin mano)
};
// cursor de la mano (punta del índice) para el retículo de apuntado
const cursor = { x: 0, y: 0, active: false, pinch: false };

let G; // grafo {nodes, links}
let N = 0,
  L = 0;
let pos; // Float32Array(N*3) posiciones abstractas del layout
let vel; // Float32Array(N*3) velocidades (force sim)
let proj; // Float32Array(N*2) posiciones proyectadas en píxeles (x,y) por frame
let depth; // Float32Array(N) profundidad (z rotada) por frame
let adj; // adyacencia: array de Set por nodo (vecinos)
let linkArr; // [{s,t,context}] con índices
let hubSet; // Set de índices "hub"

// three
let renderer, scene, cam;
let points, pGeo, pPos, pColor, pSize;
let lines, lGeo, lPos, lColor, lineMat;
let face, fGeo, fPos;
let faceConn = []; // pares [a,b,...] de la teselación

// face / cámara
let video, landmarker;
let lastVideoTime = -1;
let faceLm = null; // landmarks normalizados del último frame
let hasFace = false;

// manos (MediaPipe HandLandmarker)
let handLandmarker = null;
let lastHandTime = -1;
let handConn = []; // pares [a,b] de conexiones del esqueleto de la mano
// estado por mano: presencia, landmarks, pinch (pulgar 4 ↔ índice 8), punto de pinch en px
const hands = [
  { present: false, lm: null, pinch: false, px: 0, py: 0, span: 1, ratio: 1 },
  { present: false, lm: null, pinch: false, px: 0, py: 0, span: 1, ratio: 1 },
];
let handLines, hlGeo, hlPos, hlColor; // esqueleto
let handPts, hpGeo, hpPos, hpColor, hpSize; // landmarks + tips
let flow, flGeo, flPos, flColor, flSize; // flujo de energía sobre el nodo activo
let synapse, synGeo, synPos, synColor, synSize; // pulsos neuronales por toda la red
let synEdge, synT, synSpeed, synDir; // dir: 0 = s→t, 1 = t→s
let nodeFire, nodeEdges; // destello por nodo + aristas incidentes (para la cadena)
const NPULSE = 110;

// gestos → manipulación del holograma (Jarvis-style: agarrar y mover en 3D)
//   1 mano  = trasladar (X/Y sigue la mano) + profundidad (tamaño de mano)
//   2 manos = escalar (distancia) + girar (ángulo entre manos)
const grab = {
  active: false,
  mode: 'pending', // 'pending' → 'move' (arrastrar) | tap al soltar = seleccionar
  moved: 0,
  lost: 0, // frames sin pinch mientras agarras (tolerancia a parpadeo)
  startHx: 0, startHy: 0, lastHx: 0, lastHy: 0,
  startOffX: 0, startOffY: 0, startSpan: 1, startZoom: 1,
  vX: 0, vY: 0,
};
let twoHandFrames = 0; // (sin uso tras separar por manos; se conserva inofensivo)
let gestureScale = 1; // escala del cerebro por apertura de mano (puño↔abierta)
let superGlow = 0; // 0 normal .. 1 colapsado en supernova
let handSwap = false; // intercambia izq/der si MediaPipe las reporta al revés (tecla X)
const twist = { active: false, baseDist: 0, baseZoom: 1, baseAngle: 0, baseYaw: 0 };
let manualYaw = 0,
  manualPitch = 0,
  userZoom = 1,
  manualOffX = 0, // traslación objetivo en píxeles (se suma al anclaje de la cara)
  manualOffY = 0,
  dispOffX = 0, // versión suavizada que se renderiza (slight lag, anti-jitter)
  dispOffY = 0;

// anclaje suavizado (en píxeles)
const anchor = { x: 0, y: 0, scale: 220, tx: 0, ty: 0, tscale: 220 };
let spin = 0; // rotación automática acumulada
let headYaw = 0,
  headPitch = 0; // pose suavizada
let layoutCool = 1; // 1 = caliente, baja a 0 (el grafo "florece" al inicio)

const labelsEl = document.getElementById('labels');
const statusEl = document.getElementById('status');
const labelPool = []; // divs reutilizables

// =============================================================================
// 1. CARGAR GRAFO
// =============================================================================
async function loadGraph() {
  // Try your real graph first; fall back to the bundled demo (graph.sample.json)
  // so a fresh clone works before you connect your own vault.
  const tryFetch = (f) =>
    fetch(f + '?t=' + Date.now(), { cache: 'no-store' }).catch(() => null);
  let res = await tryFetch('graph.json');
  let usingSample = false;
  if (!res || !res.ok) {
    res = await tryFetch('graph.sample.json');
    usingSample = true;
  }
  if (!res || !res.ok)
    throw new Error('Could not load graph.json / graph.sample.json. Run: node scan-vault.mjs');
  G = await res.json();
  if (usingSample) {
    const sub = document.querySelector('#title .sub');
    if (sub) sub.textContent = 'demo vault · run the scanner on your own Obsidian';
  }
  N = G.nodes.length;
  L = G.links.length;

  const idx = new Map(G.nodes.map((n, i) => [n.id, i]));
  adj = Array.from({ length: N }, () => new Set());
  linkArr = [];
  for (const lk of G.links) {
    const s = idx.get(lk.source),
      t = idx.get(lk.target);
    if (s == null || t == null || s === t) continue;
    adj[s].add(t);
    adj[t].add(s);
    linkArr.push({ s, t, context: lk.context || '' });
  }
  L = linkArr.length;

  // aristas incidentes por nodo (para propagar la cadena) + energía de destello
  nodeEdges = Array.from({ length: N }, () => []);
  for (let k = 0; k < L; k++) {
    nodeEdges[linkArr[k].s].push(k);
    nodeEdges[linkArr[k].t].push(k);
  }
  nodeFire = new Float32Array(N);

  // hubs = top por grado
  hubSet = new Set(
    G.nodes
      .map((n, i) => [i, n.degree])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map((x) => x[0])
  );

  document.getElementById('sNodes').textContent = G.stats?.notes ?? N;
  document.getElementById('sLinks').textContent = L;
  buildLegend();
}

function buildLegend() {
  const present = [...new Set(G.nodes.map((n) => n.folder))]
    .filter((f) => PALETTE[f])
    .sort();
  const el = document.getElementById('legend');
  el.innerHTML = present
    .map((f) => {
      const c = '#' + colorFor(f).getHexString();
      return `<div class="row"><span>${f}</span><span class="dot" style="color:${c}"></span></div>`;
    })
    .join('');
}

// =============================================================================
// 2. FORCE LAYOUT 3D (repulsión + resortes + gravedad), enfriándose
// =============================================================================
function initLayout() {
  pos = new Float32Array(N * 3);
  vel = new Float32Array(N * 3);
  proj = new Float32Array(N * 2);
  depth = new Float32Array(N);
  // sembrado esférico determinista (sin Math.random para reproducible)
  for (let i = 0; i < N; i++) {
    const phi = i * 2.399963; // golden angle
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    pos[i * 3] = Math.cos(phi) * r * 40;
    pos[i * 3 + 1] = y * 40;
    pos[i * 3 + 2] = Math.sin(phi) * r * 40;
  }
}

function stepLayout(alpha) {
  const REP = 220; // repulsión
  const SPR = 0.018; // rigidez resorte
  const LEN = 14; // largo de reposo
  const GRAV = 0.012; // hacia el centro
  const DAMP = 0.82;

  // repulsión O(n²) — con N≈400 es barato para correr al inicio
  for (let i = 0; i < N; i++) {
    let fx = 0,
      fy = 0,
      fz = 0;
    const ix = pos[i * 3],
      iy = pos[i * 3 + 1],
      iz = pos[i * 3 + 2];
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      let dx = ix - pos[j * 3],
        dy = iy - pos[j * 3 + 1],
        dz = iz - pos[j * 3 + 2];
      let d2 = dx * dx + dy * dy + dz * dz + 0.01;
      const f = REP / d2;
      const inv = 1 / Math.sqrt(d2);
      fx += dx * inv * f;
      fy += dy * inv * f;
      fz += dz * inv * f;
    }
    fx -= ix * GRAV;
    fy -= iy * GRAV;
    fz -= iz * GRAV;
    vel[i * 3] = (vel[i * 3] + fx * alpha) * DAMP;
    vel[i * 3 + 1] = (vel[i * 3 + 1] + fy * alpha) * DAMP;
    vel[i * 3 + 2] = (vel[i * 3 + 2] + fz * alpha) * DAMP;
  }
  // resortes (aristas)
  for (const { s, t } of linkArr) {
    let dx = pos[t * 3] - pos[s * 3],
      dy = pos[t * 3 + 1] - pos[s * 3 + 1],
      dz = pos[t * 3 + 2] - pos[s * 3 + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
    const f = (d - LEN) * SPR * alpha;
    dx /= d;
    dy /= d;
    dz /= d;
    vel[s * 3] += dx * f;
    vel[s * 3 + 1] += dy * f;
    vel[s * 3 + 2] += dz * f;
    vel[t * 3] -= dx * f;
    vel[t * 3 + 1] -= dy * f;
    vel[t * 3 + 2] -= dz * f;
  }
  for (let k = 0; k < N * 3; k++) pos[k] += vel[k];

  // normalizar a radio ~1 (para anclar por tamaño de cara después)
  let maxR = 1e-6;
  for (let i = 0; i < N; i++) {
    const r = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (r > maxR) maxR = r;
  }
  layoutRadius = maxR;
}
let layoutRadius = 40;

// =============================================================================
// 3. THREE.JS (cámara ortográfica en píxeles)
// =============================================================================
function initThree() {
  const canvas = document.getElementById('scene');
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // lets the canvas be captured (toDataURL / screenshots)
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  scene = new THREE.Scene();
  cam = new THREE.OrthographicCamera(0, 1, 1, 0, -2000, 2000);
  resize();
  window.addEventListener('resize', resize);

  // --- puntos (nodos) con ShaderMaterial: tamaño y color por vértice + glow ---
  pGeo = new THREE.BufferGeometry();
  pPos = new Float32Array(N * 3);
  pColor = new Float32Array(N * 3);
  pSize = new Float32Array(N);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('acolor', new THREE.BufferAttribute(pColor, 3));
  pGeo.setAttribute('asize', new THREE.BufferAttribute(pSize, 1));
  const pMat = new THREE.ShaderMaterial({
    uniforms: { dpr: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: `
      attribute float asize; attribute vec3 acolor;
      varying vec3 vC; uniform float dpr;
      void main(){ vC=acolor;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
        gl_PointSize=asize*dpr; }`,
    fragmentShader: `
      varying vec3 vC;
      void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d);
        if(r>0.5) discard;
        float halo=smoothstep(0.5,0.14,r)*0.6;   // aura (glow)
        float core=smoothstep(0.18,0.0,r);        // núcleo nítido
        float i=halo+core;
        gl_FragColor=vec4(vC*i, i); }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  scene.add(points);

  // --- líneas (aristas) GRUESAS — LineSegments2 da grosor real (WebGL normal
  //     dibuja siempre 1px). El buffer interleaved referencia lPos/lColor, así
  //     que actualizo en sitio cada frame y marco needsUpdate.
  lPos = new Float32Array(L * 2 * 3);
  lColor = new Float32Array(L * 2 * 3);
  lGeo = new LineSegmentsGeometry();
  lGeo.setPositions(lPos);
  lGeo.setColors(lColor);
  lineMat = new LineMaterial({
    vertexColors: true,
    transparent: true,
    linewidth: 2.2, // grosor en píxeles
    worldUnits: false,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  lineMat.resolution.set(VW, VH);
  lines = new LineSegments2(lGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  // --- malla de la cara ---
  faceConn = (FaceLandmarker.FACE_LANDMARKS_TESSELATION || []).flatMap((c) => [
    c.start,
    c.end,
  ]);
  fGeo = new THREE.BufferGeometry();
  fPos = new Float32Array((faceConn.length / 2) * 2 * 3);
  fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
  const fMat = new THREE.LineBasicMaterial({
    color: 0x7fe9ff,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthTest: false,
  });
  face = new THREE.LineSegments(fGeo, fMat);
  face.frustumCulled = false;
  scene.add(face);

  // --- manos: esqueleto (líneas) + landmarks (puntos) ---
  handConn = (HandLandmarker.HAND_CONNECTIONS || []).flatMap((c) => [
    c.start,
    c.end,
  ]);
  const segs = handConn.length + 2; // esqueleto (2 manos) + 1 "puente" de pinch por mano
  hlGeo = new THREE.BufferGeometry();
  hlPos = new Float32Array(segs * 2 * 3);
  hlColor = new Float32Array(segs * 2 * 3);
  hlGeo.setAttribute('position', new THREE.BufferAttribute(hlPos, 3));
  hlGeo.setAttribute('color', new THREE.BufferAttribute(hlColor, 3));
  handLines = new THREE.LineSegments(
    hlGeo,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    })
  );
  handLines.frustumCulled = false;
  scene.add(handLines);

  hpGeo = new THREE.BufferGeometry();
  hpPos = new Float32Array(42 * 3); // 2 manos × 21 landmarks
  hpColor = new Float32Array(42 * 3);
  hpSize = new Float32Array(42);
  hpGeo.setAttribute('position', new THREE.BufferAttribute(hpPos, 3));
  hpGeo.setAttribute('acolor', new THREE.BufferAttribute(hpColor, 3));
  hpGeo.setAttribute('asize', new THREE.BufferAttribute(hpSize, 1));
  handPts = new THREE.Points(hpGeo, pMat); // reutiliza el shader de glow de los nodos
  handPts.frustumCulled = false;
  scene.add(handPts);

  // --- flujo de energía: partículas que recorren las aristas del nodo activo ---
  const FLOW_MAX = 96;
  flGeo = new THREE.BufferGeometry();
  flPos = new Float32Array(FLOW_MAX * 3);
  flColor = new Float32Array(FLOW_MAX * 3);
  flSize = new Float32Array(FLOW_MAX);
  flGeo.setAttribute('position', new THREE.BufferAttribute(flPos, 3));
  flGeo.setAttribute('acolor', new THREE.BufferAttribute(flColor, 3));
  flGeo.setAttribute('asize', new THREE.BufferAttribute(flSize, 1));
  flow = new THREE.Points(flGeo, pMat);
  flow.frustumCulled = false;
  scene.add(flow);

  // --- pulsos "neuronales": señales que recorren TODA la red sin parar ---
  synGeo = new THREE.BufferGeometry();
  synPos = new Float32Array(NPULSE * 3);
  synColor = new Float32Array(NPULSE * 3);
  synSize = new Float32Array(NPULSE);
  synEdge = new Int32Array(NPULSE);
  synT = new Float32Array(NPULSE);
  synSpeed = new Float32Array(NPULSE);
  synDir = new Int8Array(NPULSE);
  for (let i = 0; i < NPULSE; i++) {
    synEdge[i] = L > 0 ? (Math.random() * L) | 0 : 0;
    synT[i] = Math.random();
    synSpeed[i] = 0.004 + Math.random() * 0.011;
    synDir[i] = Math.random() < 0.5 ? 0 : 1;
  }
  synGeo.setAttribute('position', new THREE.BufferAttribute(synPos, 3));
  synGeo.setAttribute('acolor', new THREE.BufferAttribute(synColor, 3));
  synGeo.setAttribute('asize', new THREE.BufferAttribute(synSize, 1));
  synapse = new THREE.Points(synGeo, pMat);
  synapse.frustumCulled = false;
  scene.add(synapse);
}

let VW = 0,
  VH = 0;
function resize() {
  VW = window.innerWidth;
  VH = window.innerHeight;
  renderer.setSize(VW, VH);
  // ortho: (0,0) arriba-izquierda, +y hacia abajo (como píxeles de pantalla)
  cam.left = 0;
  cam.right = VW;
  cam.top = 0;
  cam.bottom = VH;
  cam.updateProjectionMatrix();
  if (lineMat) lineMat.resolution.set(VW, VH); // grosor correcto al cambiar tamaño
  if (!hasFace) {
    anchor.tx = anchor.x = VW / 2;
    anchor.ty = anchor.y = VH / 2;
    anchor.tscale = anchor.scale = Math.min(VW, VH) * 0.42;
  }
}

// =============================================================================
// 4. CÁMARA + MEDIAPIPE
// =============================================================================
async function initCamera() {
  video = document.getElementById('cam');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise((r) => (video.onloadedmetadata = r));
    await video.play();
  } catch (e) {
    showStatus(
      '<span class="warn">No camera.</span> The graph still works, centered.<br><span style="color:#8fa3b0">Allow camera access and reload to see your face.</span>',
      4000
    );
    return false;
  }
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
    );
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
    });
    // manos: en paralelo, reusa el mismo fileset
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  } catch (e) {
    showStatus(
      '<span class="warn">A MediaPipe model failed to load</span> (offline?).<br>The graph still works.',
      4000
    );
    if (!landmarker) landmarker = null;
  }
  return true;
}

// mapea landmark normalizado -> píxel de pantalla, respetando object-fit:cover
// y el espejo horizontal del video.
function videoToScreen(nx, ny) {
  const vw = video.videoWidth || 1280,
    vh = video.videoHeight || 720;
  const s = Math.max(VW / vw, VH / vh);
  const dw = vw * s,
    dh = vh * s;
  const ox = (VW - dw) / 2,
    oy = (VH - dh) / 2;
  return [ox + (1 - nx) * dw, oy + ny * dh]; // (1-nx) = espejo
}

function detectFace() {
  if (!landmarker || !video || video.readyState < 2) {
    hasFace = false;
    return;
  }
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let r;
  try {
    r = landmarker.detectForVideo(video, performance.now());
  } catch {
    return;
  }
  if (r && r.faceLandmarks && r.faceLandmarks.length) {
    faceLm = r.faceLandmarks[0];
    hasFace = true;
    // pose (yaw/pitch) desde la matriz de transformación, si está
    const m = r.facialTransformationMatrixes?.[0]?.data;
    if (m) {
      const yaw = Math.atan2(m[8], m[10]);
      const pitch = Math.asin(-Math.max(-1, Math.min(1, m[9])));
      headYaw += (yaw - headYaw) * 0.15;
      headPitch += (pitch - headPitch) * 0.15;
    }
  } else {
    hasFace = false;
  }
}

function detectHands() {
  if (!handLandmarker || !video || video.readyState < 2) {
    hands[0].present = hands[1].present = false;
    return;
  }
  if (video.currentTime === lastHandTime) return;
  lastHandTime = video.currentTime;
  let r;
  try {
    r = handLandmarker.detectForVideo(video, performance.now());
  } catch {
    return;
  }
  const lms = (r && r.landmarks) || [];
  const wls = (r && r.worldLandmarks) || []; // landmarks 3D métricos (metros)
  for (let i = 0; i < 2; i++) {
    const h = hands[i];
    const lm = lms[i];
    if (!lm) {
      h.present = false;
      h.pinch = false;
      h.ratio = 1;
      continue;
    }
    h.present = true;
    h.lm = lm;
    h.tipThumb = videoToScreen(lm[4].x, lm[4].y); // punta del pulgar
    h.tipIndex = videoToScreen(lm[8].x, lm[8].y); // punta del índice
    h.px = (h.tipThumb[0] + h.tipIndex[0]) / 2;
    h.py = (h.tipThumb[1] + h.tipIndex[1]) / 2;

    // ratio de pinch en 3D (worldLandmarks, métrico): distancia REAL pulgar↔índice
    // ÷ tamaño de la mano (muñeca 0 ↔ nudillo medio 9). Es lo único que no se
    // deja engañar por la pose: el 2D fallaba porque el ancho aparente cambia.
    let ratio = 1;
    const wl = wls[i];
    if (wl) {
      const d3 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      ratio = d3(wl[4], wl[8]) / (d3(wl[0], wl[9]) || 1);
    } else {
      const k5 = videoToScreen(lm[5].x, lm[5].y),
        k17 = videoToScreen(lm[17].x, lm[17].y);
      const palmW = Math.hypot(k5[0] - k17[0], k5[1] - k17[1]) || 1;
      ratio = Math.hypot(h.tipThumb[0] - h.tipIndex[0], h.tipThumb[1] - h.tipIndex[1]) / palmW;
    }
    h.ratio = h.ratio + (ratio - h.ratio) * 0.5; // suavizado anti-pico

    // extensión de CADA dedo (0 = curvado, 1 = extendido): dist tip↔muñeca
    // normalizada por dist nudillo↔muñeca. Robusto a la longitud de cada dedo.
    let eI = 0,
      eM = 0,
      eR = 0,
      eP = 0;
    const hasW = !!wl;
    if (wl) {
      const fe = (mcp, tip) =>
        clamp((dist3(wl[0], wl[tip]) / (dist3(wl[0], wl[mcp]) || 1) - 0.9) / 1.1, 0, 1);
      eI = fe(5, 8); // índice
      eM = fe(9, 12); // medio
      eR = fe(13, 16); // anular
      eP = fe(17, 20); // meñique
    }
    // ABIERTA = los CUATRO algo extendidos (piso 0.35) → promedio. Si UN dedo
    // está claramente curvado (paz, pinch) → 0, no expande. (El meñique es corto,
    // por eso uso promedio con piso en vez de mínimo estricto.)
    const allOut = eI > 0.35 && eM > 0.35 && eR > 0.35 && eP > 0.35;
    const openRaw = hasW ? (allOut ? (eI + eM + eR + eP) / 4 : 0) : 0.5;
    // PUÑO = ningún dedo extendido (todos curvados)
    const fistRaw = hasW ? 1 - Math.max(eI, eM, eR, eP) : 0;
    h.open = h.open == null ? openRaw : h.open + (openRaw - h.open) * 0.3;
    h.fist = h.fist == null ? fistRaw : h.fist + (fistRaw - h.fist) * 0.3;

    // pinch = pulgar + índice TOCÁNDOSE (r bajo). Un puño se distingue por r:
    // ahí el pulgar NO toca el índice → r más alto → no es pinch. Así un pinch
    // con los otros dedos curvados NO se confunde con un puño.
    if (h.pinch) {
      if (h.ratio > 0.4) h.pinch = false;
    } else if (h.ratio < 0.24) h.pinch = true;
  }

  // LADO de cada mano por POSICIÓN en pantalla (el feed ya está espejado, así que
  // coincide con lo que ves): la mano más a la derecha = tu mano DERECHA. Inmune
  // al lío de izquierda/derecha de MediaPipe con la cámara. X invierte si hiciera falta.
  const present = [0, 1].filter((i) => hands[i].present);
  if (present.length === 2) {
    const aRight = hands[present[0]].px >= hands[present[1]].px;
    hands[present[0]].side = aRight ? 'R' : 'L';
    hands[present[1]].side = aRight ? 'L' : 'R';
  } else if (present.length === 1) {
    const i = present[0];
    const cx = hasFace ? anchor.x : VW / 2;
    hands[i].side = hands[i].px >= cx ? 'R' : 'L';
  }
  if (handSwap) for (const i of present) hands[i].side = hands[i].side === 'L' ? 'R' : 'L';
}

// gestos → manipulación del holograma (robusto al parpadeo del pinch)
function updateGestures() {
  // pinch = mover/seleccionar. Lo hace CUALQUIER mano que pellizque (los gestos
  // se distinguen por su forma, no por la mano → ya no hay conflicto ni roles).
  const h = hands.find((hh) => hh.present && hh.pinch);
  if (h) {
    // reapareció tras un parpadeo del tracking → re-ancla para NO dar un salto
    if (grab.active && grab.lost > 0) {
      grab.startHx = grab.lastHx = h.px;
      grab.startHy = grab.lastHy = h.py;
      grab.startOffX = manualOffX;
      grab.startOffY = manualOffY;
    }
    grab.lost = 0;

    if (!grab.active) {
      grab.active = true;
      grab.mode = 'pending';
      grab.moved = 0;
      grab.startHx = grab.lastHx = h.px;
      grab.startHy = grab.lastHy = h.py;
      grab.startOffX = manualOffX;
      grab.startOffY = manualOffY;
      grab.startSpan = h.span || 1;
      grab.startZoom = userZoom;
      grab.vX = grab.vY = 0;
    } else {
      grab.moved = Math.max(grab.moved, Math.hypot(h.px - grab.startHx, h.py - grab.startHy));
      // al cruzar el umbral, RE-ANCLA aquí → empieza a mover sin saltito
      if (grab.mode === 'pending' && grab.moved > 12) {
        grab.mode = 'move';
        grab.startHx = grab.lastHx = h.px;
        grab.startHy = grab.lastHy = h.py;
        grab.startOffX = manualOffX;
        grab.startOffY = manualOffY;
      }
      if (grab.mode === 'move') {
        // UNA mano = SOLO trasladar (X/Y). El tamaño y el giro son de 2 manos.
        manualOffX = grab.startOffX + (h.px - grab.startHx);
        manualOffY = grab.startOffY + (h.py - grab.startHy);
        grab.vX = h.px - grab.lastHx;
        grab.vY = h.py - grab.lastHy;
        grab.lastHx = h.px;
        grab.lastHy = h.py;
      }
    }
  } else if (grab.active) {
    // sin pinch este frame: tolera parpadeos cortos antes de dar por SOLTADO
    grab.lost++;
    if (grab.lost > 6) {
      // soltó de verdad: si nunca arrastró → fue un TAP → selecciona
      if (grab.mode === 'pending' && grab.moved < 12) {
        const target = nearestNode(grab.startHx, grab.startHy, 60);
        if (target >= 0) S.pinned = S.pinned === target ? -1 : target;
      }
      grab.active = false;
      grab.lost = 0;
    }
  }

  // inercia al soltar de verdad (lo "lanzas" y se desliza)
  if (!grab.active && (grab.vX || grab.vY)) {
    manualOffX += grab.vX;
    manualOffY += grab.vY;
    grab.vX *= 0.9;
    grab.vY *= 0.9;
    if (Math.abs(grab.vX) < 0.05) grab.vX = 0;
    if (Math.abs(grab.vY) < 0.05) grab.vY = 0;
  }
}

// dibuja el esqueleto de las manos + puntos, con el pinch destacado en ámbar
function drawHands() {
  const anyHand = hands[0].present || hands[1].present;
  handLines.visible = S.showHands && anyHand && !!handLandmarker;
  handPts.visible = handLines.visible;
  if (!handLines.visible) return;

  let o = 0;
  const pushSeg = (x1, y1, z1, x2, y2, z2, r, g, b, a) => {
    hlPos[o] = x1; hlPos[o + 1] = y1; hlPos[o + 2] = z1;
    hlPos[o + 3] = x2; hlPos[o + 4] = y2; hlPos[o + 5] = z2;
    hlColor[o] = r * a; hlColor[o + 1] = g * a; hlColor[o + 2] = b * a;
    hlColor[o + 3] = r * a; hlColor[o + 4] = g * a; hlColor[o + 5] = b * a;
    o += 6;
  };
  for (const h of hands) {
    if (!h.present) continue;
    for (let k = 0; k < handConn.length; k += 2) {
      const a = h.lm[handConn[k]], b = h.lm[handConn[k + 1]];
      const p1 = videoToScreen(a.x, a.y), p2 = videoToScreen(b.x, b.y);
      pushSeg(p1[0], p1[1], -a.z * 250, p2[0], p2[1], -b.z * 250, 0.5, 0.78, 0.95, 0.7);
    }
    // puente pulgar↔índice: SIEMPRE visible, se ilumina al acercar los dedos
    // (feedback de "cuánto falta para pinchar"); salta a ámbar al pinchar
    if (h.pinch) {
      pushSeg(h.tipThumb[0], h.tipThumb[1], 0, h.tipIndex[0], h.tipIndex[1], 0, 1, 0.55, 0.2, 1);
    } else {
      const close = clamp(1 - h.ratio, 0, 1); // 0 abierto … 1 casi tocándose
      pushSeg(h.tipThumb[0], h.tipThumb[1], 0, h.tipIndex[0], h.tipIndex[1], 0, 0.35, 0.85, 1, 0.12 + close * 0.55);
    }
  }
  for (let k = o; k < hlPos.length; k++) { hlPos[k] = 0; hlColor[k] = 0; }
  hlGeo.attributes.position.needsUpdate = true;
  hlGeo.attributes.color.needsUpdate = true;

  let p = 0;
  for (const h of hands) {
    if (!h.present) continue;
    for (let i = 0; i < 21; i++) {
      const sp = videoToScreen(h.lm[i].x, h.lm[i].y);
      hpPos[p * 3] = sp[0]; hpPos[p * 3 + 1] = sp[1]; hpPos[p * 3 + 2] = -h.lm[i].z * 250;
      const tip = i === 4 || i === 8;
      let r = 0.45, g = 0.7, b = 0.9, s = 3.5;
      if (tip) { r = 0.6; g = 0.9; b = 1; s = 8; }
      if (tip && h.pinch) { r = 1; g = 0.5; b = 0.25; s = 11; }
      hpColor[p * 3] = r; hpColor[p * 3 + 1] = g; hpColor[p * 3 + 2] = b;
      hpSize[p] = s;
      p++;
    }
  }
  for (let k = p; k < 42; k++) hpSize[k] = 0;
  hpGeo.attributes.position.needsUpdate = true;
  hpGeo.attributes.acolor.needsUpdate = true;
  hpGeo.attributes.asize.needsUpdate = true;
}

// =============================================================================
// 5. LOOP
// =============================================================================
let frame = 0,
  fpsT = 0,
  fpsN = 0,
  fps = 0,
  T = 0; // reloj en segundos (para shimmer / flujo de energía)

function tick(t) {
  requestAnimationFrame(tick);
  frame++;
  T = t * 0.001;

  detectFace();
  detectHands();
  updateGestures();
  updateHandCursor();
  updateOpenness();

  // enfriar el layout al inicio (~el grafo florece)
  if (layoutCool > 0) {
    stepLayout(0.9 * layoutCool + 0.05);
    layoutCool = Math.max(0, layoutCool - 0.011);
    if (layoutCool === 0) hideStatus();
  } else if (!S.paused) {
    // respiración sutil para que nunca quede del todo muerto
    stepLayout(0.012);
  }

  updateAnchor();
  // auto-spin solo si no estás agarrando el holograma con la mano
  if (S.rotate && !S.paused && !grab.active) spin += 0.0016;

  projectAndDraw();
  drawHands();
  if (S.showLabels) updateLabels();
  else clearLabels();
  updateHoverInfo();
  updateReticle();
  updatePinchReadout();

  renderer.render(scene, cam);

  // fps + estado de tracking
  fpsN++;
  if (t - fpsT > 500) {
    fps = Math.round((fpsN * 1000) / (t - fpsT));
    fpsT = t;
    fpsN = 0;
    const nPinch = hands.filter((h) => h.present && h.pinch).length;
    const nHands = hands.filter((h) => h.present).length;
    const ph = hands.find((h) => h.present);
    let tag = `${fps} fps`;
    if (hasFace) tag += ' · face ✓';
    if (nHands) tag += ` · ${nHands} hand${nHands > 1 ? 's' : ''}`;
    if (nPinch) tag += ` · pinch ✊×${nPinch}`;
    if (ph) tag += ` · r=${ph.ratio.toFixed(2)}`; // ratio de pinch en vivo (para calibrar)
    document.getElementById('sFps').textContent = tag;
  }
}

function updateAnchor() {
  if (hasFace && faceLm) {
    // centro de la cara: entre-cejas (168) ; ancho: pómulo a pómulo (234↔454)
    const [cx, cy] = videoToScreen(faceLm[168].x, faceLm[168].y);
    const [lx] = videoToScreen(faceLm[234].x, faceLm[234].y);
    const [rx] = videoToScreen(faceLm[454].x, faceLm[454].y);
    const faceW = Math.abs(rx - lx) || 120;
    anchor.tx = cx;
    anchor.ty = cy - faceW * 0.15; // un pelo arriba de la cara
    anchor.tscale = faceW * 3.4; // constelación ~varias caras de ancho
  } else {
    anchor.tx = VW / 2;
    anchor.ty = VH / 2;
    anchor.tscale = Math.min(VW, VH) * 0.42;
  }
  anchor.x += (anchor.tx - anchor.x) * 0.12;
  anchor.y += (anchor.ty - anchor.y) * 0.12;
  anchor.scale += (anchor.tscale - anchor.scale) * 0.1;
}

// nodo más cercano a (px,py) dentro de un radio r (en píxeles); -1 si ninguno
function nearestNode(px, py, r) {
  let best = -1,
    bd = r * r;
  for (let i = 0; i < N; i++) {
    const dx = proj[i * 2] - px,
      dy = proj[i * 2 + 1] - py;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// cursor de apuntado = punta del índice de la primera mano presente
function updateHandCursor() {
  const h = hands.find((hh) => hh.present); // primera mano presente = cursor de apuntado
  if (!h || !S.showHands) {
    cursor.active = false;
    S.handHover = -1;
    return;
  }
  cursor.active = true;
  cursor.pinch = h.pinch;
  cursor.x = h.tipIndex[0];
  cursor.y = h.tipIndex[1];
  // mientras ARRASTRAS no apuntes (si no el grafo parpadea de foco al moverlo)
  S.handHover =
    grab.active && grab.mode === 'move' ? -1 : nearestNode(cursor.x, cursor.y, 70);
}

// apertura de la mano → escala del cerebro: PUÑO = colapsa a supernova,
// MANO ABIERTA = se expande (y se revelan todos los nombres, ver updateLabels)
function updateOpenness() {
  // puño/abrir lo hace cualquier mano que NO esté pellizcando.
  const h = hands.find((hh) => hh.present && !hh.pinch);
  let target = 1; // NEUTRAL (tamaño normal) por defecto — gestos parciales no hacen nada
  if (h && S.showHands) {
    const open = h.open != null ? h.open : 0;
    const fist = h.fist != null ? h.fist : 0;
    S.openAmt = open;
    // PUÑO = cuatro dedos curvados Y pulgar SIN tocar índice (r alto → no es pinch)
    if (fist > 0.55 && h.ratio > 0.28) {
      target = 1 + clamp((fist - 0.55) / 0.35, 0, 1) * (0.06 - 1);
    } else if (open > 0.5) {
      // MANO ABIERTA (los cuatro dedos extendidos) → se expande
      target = 1 + clamp((open - 0.5) / 0.4, 0, 1) * (1.85 - 1);
    }
  } else {
    S.openAmt = -1;
  }
  // congela la escala mientras agarras/mueves con el pinch (no interferir)
  if (!grab.active) gestureScale += (target - gestureScale) * 0.16;
  const collapse = clamp((0.5 - gestureScale) / 0.44, 0, 1); // 0 normal .. 1 colapsado
  superGlow += (collapse - superGlow) * 0.2; // brillo de supernova al colapsar
}

// selección efectiva: pinchado > apuntado con la mano > mouse
function effHover() {
  return S.pinned >= 0 ? S.pinned : S.handHover >= 0 ? S.handHover : S.hover;
}

// rota el cloud, proyecta a píxeles y rellena buffers de puntos/líneas/cara
const _rot = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _frot = new THREE.Matrix4();
const _fq = new THREE.Quaternion();
const _fe = new THREE.Euler();
function projectAndDraw() {
  // rotación del cerebro = pose de cabeza + auto-spin + gesto de la mano (manual*)
  _e.set(headPitch * 0.6 + manualPitch, spin + headYaw * 0.8 + manualYaw, 0, 'YXZ');
  _q.setFromEuler(_e);
  _rot.makeRotationFromQuaternion(_q);
  const m = _rot.elements;
  const sc = (anchor.scale * userZoom * gestureScale) / (layoutRadius || 1); // gestureScale = puño↔mano abierta
  // traslación suavizada (slight lag) → holograma fluido, no tiembla con el tracking
  dispOffX += (manualOffX - dispOffX) * 0.3;
  dispOffY += (manualOffY - dispOffY) * 0.3;
  const ax = anchor.x + dispOffX, // 1 mano agarra y mueve
    ay = anchor.y + dispOffY;

  // proyección de cada nodo
  for (let i = 0; i < N; i++) {
    const x = pos[i * 3],
      y = pos[i * 3 + 1],
      z = pos[i * 3 + 2];
    const rx = m[0] * x + m[4] * y + m[8] * z;
    const ry = m[1] * x + m[5] * y + m[9] * z;
    const rz = m[2] * x + m[6] * y + m[10] * z;
    const px = ax + rx * sc;
    const py = ay + ry * sc;
    proj[i * 2] = px;
    proj[i * 2 + 1] = py;
    depth[i] = rz; // -radius..+radius
    pPos[i * 3] = px;
    pPos[i * 3 + 1] = py;
    pPos[i * 3 + 2] = rz * sc; // sólo para orden
  }

  // colores + tamaños de nodos (neón, con realce de profundidad + apuntado)
  const hv = effHover();
  const neigh = hv >= 0 ? adj[hv] : null;
  for (let i = 0; i < N; i++) {
    const node = G.nodes[i];
    const c = colorFor(node.folder);
    const fr = layoutRadius > 0 ? depth[i] / layoutRadius : 0; // -1 (atrás)..+1 (frente)
    const front = (fr + 1) / 2; // 0..1
    let bright = (0.72 + front * 0.8) * (1 + 0.1 * Math.sin(T * 3 + i * 0.7)); // neón vivo (palpita)
    let size = (1.6 + node.size * 0.6) * (0.55 + front * 0.6); // px en CSS (más grandes = pincheable)
    // las MEMORIAS palpitan y resaltan → fáciles de apuntar y pinchar
    if (node.folder === '00-Memory') {
      bright *= 1.35 + 0.18 * Math.sin(T * 2.4 + i);
      size *= 1.45;
    }
    if (node.ghost) {
      bright *= 0.62;
      size *= 0.85;
    }
    if (hubSet.has(i)) size *= 1.25;
    // apuntado / seleccionado
    if (hv >= 0) {
      if (i === hv) {
        bright = 1.9; // nodo apuntado = blanco brillante
        size *= 1.6;
      } else if (neigh && neigh.has(i)) {
        bright = 1.25;
      } else {
        bright *= 0.25;
      }
    }
    // DESTELLO neuronal: pulsos amarillos que LLEGAN al nodo lo encienden (cadena)
    const fire = nodeFire[i];
    let cr = c.r,
      cg = c.g,
      cb = c.b;
    if (fire > 0.002) {
      bright += fire * 1.8; // fogonazo
      size *= 1 + fire * 0.8; // crece al disparar
      const y = fire > 1 ? 1 : fire;
      cr = c.r * (1 - y) + 1.0 * y; // tinte amarillo
      cg = c.g * (1 - y) + 0.85 * y;
      cb = c.b * (1 - y) + 0.2 * y;
    }
    nodeFire[i] = fire * 0.87; // decae el destello

    // SUPERNOVA: al colapsar (puño) todo blanquea y blazea en un punto
    if (superGlow > 0.001) {
      const g = superGlow;
      cr = cr * (1 - g) + 1.0 * g;
      cg = cg * (1 - g) + 1.0 * g;
      cb = cb * (1 - g) + 1.0 * g;
      bright += g * 2.6;
      size *= 1 - g * 0.5; // se encogen → punto compacto (supernova)
    }

    pColor[i * 3] = cr * bright;
    pColor[i * 3 + 1] = cg * bright;
    pColor[i * 3 + 2] = cb * bright;
    pSize[i] = size;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.acolor.needsUpdate = true;
  pGeo.attributes.asize.needsUpdate = true;

  // líneas
  for (let k = 0; k < L; k++) {
    const { s, t } = linkArr[k];
    const o = k * 6;
    lPos[o] = proj[s * 2];
    lPos[o + 1] = proj[s * 2 + 1];
    lPos[o + 2] = depth[s] * sc;
    lPos[o + 3] = proj[t * 2];
    lPos[o + 4] = proj[t * 2 + 1];
    lPos[o + 5] = depth[t] * sc;
    const fd = layoutRadius > 0 ? (depth[s] + depth[t]) / 2 / layoutRadius : 0; // -1..1
    const shimmer = 0.7 + 0.3 * Math.sin(T * 2.6 + k * 0.6); // pulso neural marcado
    let a = (0.3 + ((fd + 1) / 2) * 0.4) * shimmer; // más visible
    let r = 0.28,
      g = 0.72,
      b = 1.0; // cian eléctrico
    if (hv >= 0) {
      if (s === hv || t === hv) {
        a = 1.0;
        r = 0.72;
        g = 0.95;
        b = 1.0; // arista activa = energía cian-blanca
      } else {
        a = 0.04;
      }
    }
    lColor[o] = r * a;
    lColor[o + 1] = g * a;
    lColor[o + 2] = b * a;
    lColor[o + 3] = r * a;
    lColor[o + 4] = g * a;
    lColor[o + 5] = b * a;
  }
  // start+end comparten el mismo InstancedInterleavedBuffer (idem colores)
  lGeo.attributes.instanceStart.data.needsUpdate = true;
  lGeo.attributes.instanceColorStart.data.needsUpdate = true;

  // malla de la cara = ancla estable: sigue tu rostro real, el gesto NO la mueve
  face.visible = S.showFace && hasFace && !!faceLm;
  if (face.visible) {
    for (let k = 0; k < faceConn.length; k += 2) {
      const a = faceLm[faceConn[k]],
        b = faceLm[faceConn[k + 1]];
      const o = k * 3;
      const pa = videoToScreen(a.x, a.y);
      const pb = videoToScreen(b.x, b.y);
      fPos[o] = pa[0];
      fPos[o + 1] = pa[1];
      fPos[o + 2] = -a.z * 300;
      fPos[o + 3] = pb[0];
      fPos[o + 4] = pb[1];
      fPos[o + 5] = -b.z * 300;
    }
    fGeo.attributes.position.needsUpdate = true;
  }

  drawFlow(hv, sc); // energía fluyendo desde el nodo activo
  drawSynapses(sc); // señales neuronales recorriendo toda la red
}

// pulsos que viajan por aristas al azar de toda la red → "neuronas disparando"
function drawSynapses(sc) {
  for (let i = 0; i < NPULSE; i++) {
    synT[i] += synSpeed[i];
    if (synT[i] >= 1) {
      const e0 = linkArr[synEdge[i]];
      // ¿a qué nodo LLEGÓ el pulso? → lo enciende (destello) y la cadena sigue
      const arrived = e0 ? (synDir[i] === 0 ? e0.t : e0.s) : -1;
      if (arrived >= 0) nodeFire[arrived] = Math.min(1.8, nodeFire[arrived] + 1.0);
      respawnPulse(i, arrived);
    }
    const e = linkArr[synEdge[i]];
    if (!e) {
      synSize[i] = 0;
      continue;
    }
    const a = synDir[i] === 0 ? e.s : e.t; // desde
    const b = synDir[i] === 0 ? e.t : e.s; // hacia
    const t = synT[i];
    const sx = proj[a * 2],
      sy = proj[a * 2 + 1];
    const tx = proj[b * 2],
      ty = proj[b * 2 + 1];
    synPos[i * 3] = sx + (tx - sx) * t;
    synPos[i * 3 + 1] = sy + (ty - sy) * t;
    synPos[i * 3 + 2] = (depth[a] + (depth[b] - depth[a]) * t) * sc + 1;
    const fade = Math.sin(t * Math.PI); // brilla al pasar por el medio
    synColor[i * 3] = 1.0 * fade; // AMARILLO eléctrico
    synColor[i * 3 + 1] = 0.82 * fade;
    synColor[i * 3 + 2] = 0.18 * fade;
    synSize[i] = 3.5 + 6 * fade;
  }
  synGeo.attributes.position.needsUpdate = true;
  synGeo.attributes.acolor.needsUpdate = true;
  synGeo.attributes.asize.needsUpdate = true;
}

// reasigna un pulso. Si se le pasa un nodo, CONTINÚA la cadena saliendo de él
// (propagación); con 22% de azar salta a una arista cualquiera (mantiene viva
// toda la red y evita que la cascada quede atrapada en un rincón).
function respawnPulse(i, fromNode) {
  const list = fromNode >= 0 ? nodeEdges[fromNode] : null;
  if (list && list.length && Math.random() > 0.22) {
    const idx = list[(Math.random() * list.length) | 0];
    synEdge[i] = idx;
    synDir[i] = linkArr[idx].s === fromNode ? 0 : 1; // que salga DESDE fromNode
  } else {
    synEdge[i] = L > 0 ? (Math.random() * L) | 0 : 0;
    synDir[i] = Math.random() < 0.5 ? 0 : 1;
  }
  synT[i] = 0;
  synSpeed[i] = 0.005 + Math.random() * 0.012;
}

// partículas de energía recorriendo las aristas del nodo seleccionado/apuntado
function drawFlow(hv, sc) {
  const MAX = flSize.length;
  let p = 0;
  if (hv >= 0) {
    let count = 0;
    for (let k = 0; k < L && count < 24 && p < MAX; k++) {
      const e = linkArr[k];
      if (e.s !== hv && e.t !== hv) continue;
      const from = hv;
      const to = e.s === hv ? e.t : e.s;
      for (let kk = 0; kk < 2 && p < MAX; kk++) {
        const tt = (T * 0.5 + count * 0.17 + kk * 0.5) % 1; // 0→1 fluye hacia afuera
        const x = proj[from * 2] + (proj[to * 2] - proj[from * 2]) * tt;
        const y = proj[from * 2 + 1] + (proj[to * 2 + 1] - proj[from * 2 + 1]) * tt;
        const z = (depth[from] + (depth[to] - depth[from]) * tt) * sc;
        const fade = Math.sin(tt * Math.PI); // brilla en el medio del recorrido
        flPos[p * 3] = x;
        flPos[p * 3 + 1] = y;
        flPos[p * 3 + 2] = z;
        flColor[p * 3] = 0.6 * fade;
        flColor[p * 3 + 1] = 0.95 * fade;
        flColor[p * 3 + 2] = 1.0 * fade;
        flSize[p] = 4 + 4 * fade;
        p++;
      }
      count++;
    }
  }
  for (let k = p; k < MAX; k++) flSize[k] = 0;
  flow.visible = p > 0;
  flGeo.attributes.position.needsUpdate = true;
  flGeo.attributes.acolor.needsUpdate = true;
  flGeo.attributes.asize.needsUpdate = true;
}

// =============================================================================
// 6. ETIQUETAS (HTML proyectado)
// =============================================================================
function getLabel(i) {
  if (!labelPool[i]) {
    const d = document.createElement('div');
    d.className = 'lbl';
    labelsEl.appendChild(d);
    labelPool[i] = d;
  }
  return labelPool[i];
}
function clearLabels() {
  for (const d of labelPool) if (d) d.style.opacity = '0';
}

function updateLabels() {
  const hv = effHover();
  const neigh = hv >= 0 ? adj[hv] : null;
  let li = 0;

  // COLAPSADO (puño → supernova): es un punto de luz, sin etiquetas
  if (gestureScale < 0.45) {
    clearLabels();
    return;
  }

  // MANO ABIERTA → revela TODAS las memorias con su nombre en alto contraste.
  // (no durante un pinch, para no saturar al mover/seleccionar)
  const reveal = S.openAmt;
  if (reveal > 0.5 && !grab.active) {
    const amt = clamp((reveal - 0.5) / 0.4, 0, 1);
    for (let i = 0; i < N; i++) {
      const node = G.nodes[i];
      if (node.ghost) continue; // solo notas reales = recuerdos
      const px = proj[i * 2],
        py = proj[i * 2 + 1];
      if (px < -80 || px > VW + 80 || py < -40 || py > VH + 40) continue;
      const d = getLabel(li++);
      const cls = hubSet.has(i) ? 'lbl hub loud' : 'lbl node loud';
      if (d.className !== cls) d.className = cls;
      const txt = node.short || node.title;
      if (d.textContent !== txt) d.textContent = txt;
      d.style.opacity = 0.55 + amt * 0.45;
      d.style.transform = `translate(${px}px, ${py - 11}px) translate(-50%,-50%)`;
    }
    for (let k = li; k < labelPool.length; k++)
      if (labelPool[k]) labelPool[k].style.opacity = '0';
    return;
  }

  // qué nodos etiquetar. Con hover: el nodo + sus vecinos MÁS conectados
  // (cap, si no un hub de 52 vecinos llena la pantalla de texto) + hubs tenues.
  const toShow = new Set(hubSet);
  if (hv >= 0) {
    toShow.add(hv);
    const top = [...(neigh || [])]
      .sort((a, b) => G.nodes[b].degree - G.nodes[a].degree)
      .slice(0, 8);
    for (const n of top) toShow.add(n);
  }

  for (const i of toShow) {
    const node = G.nodes[i];
    const px = proj[i * 2],
      py = proj[i * 2 + 1];
    if (px < -100 || px > VW + 100 || py < -50 || py > VH + 50) continue;
    const d = getLabel(li++);
    let cls = 'lbl node';
    if (node.ghost) cls += ' ghost';
    if (hubSet.has(i)) cls += ' hub';
    d.className = cls;
    d.textContent = node.short || node.title;
    let op = hubSet.has(i) ? 0.92 : 0.0;
    if (hv >= 0) {
      if (i === hv) op = 1;
      else if (neigh && neigh.has(i)) op = 0.85;
      else op = hubSet.has(i) ? 0.25 : 0;
    } else {
      // sin hover: sólo hubs, y se desvanecen al fondo
      const fr = layoutRadius > 0 ? depth[i] / layoutRadius : 0;
      op = hubSet.has(i) ? 0.4 + ((fr + 1) / 2) * 0.5 : 0;
    }
    d.style.opacity = op;
    d.style.transform = `translate(${px}px, ${py - 12}px) translate(-50%,-50%)`;
  }

  // etiquetas de aristas (modo distributed): contexto de los links del hover
  if (S.distributed && hv >= 0) {
    const edges = linkArr
      .filter((e) => (e.s === hv || e.t === hv) && e.context)
      .slice(0, 3);
    for (const e of edges) {
      const mx = (proj[e.s * 2] + proj[e.t * 2]) / 2;
      const my = (proj[e.s * 2 + 1] + proj[e.t * 2 + 1]) / 2;
      const d = getLabel(li++);
      d.className = 'lbl edge';
      d.textContent =
        e.context.length > 90 ? e.context.slice(0, 88) + '…' : e.context;
      d.style.opacity = 0.92;
      d.style.transform = `translate(${mx}px, ${my}px) translate(-50%,-50%)`;
    }
  }

  for (let k = li; k < labelPool.length; k++)
    if (labelPool[k]) labelPool[k].style.opacity = '0';
}

// panel inferior: muestra el nodo efectivo (pinchado / apuntado / mouse)
function updateHoverInfo() {
  const hv = effHover();
  const el = document.getElementById('sHover');
  if (!el) return;
  if (hv >= 0) {
    const n = G.nodes[hv];
    const sel = hv === S.pinned ? ' · <span style="color:#35f0ff">● selected</span>' : '';
    el.innerHTML = `▸ <b>${n.title}</b> · ${n.folder}${
      n.ghost ? ' · <span style="color:#9fb3c0">(no file)</span>' : ''
    } · ${n.degree} connections${sel}`;
  } else {
    el.textContent = '';
  }
}

// retículo "lock-on" sobre el nodo apuntado con el índice
function updateReticle() {
  const el = document.getElementById('reticle');
  if (!el) return;
  const hv = S.handHover;
  if (cursor.active && hv >= 0) {
    el.style.opacity = cursor.pinch ? '1' : '0.75';
    el.style.borderColor = cursor.pinch ? '#ffffff' : '#35f0ff';
    const sz = cursor.pinch ? 26 : 40;
    el.style.width = el.style.height = sz + 'px';
    el.style.transform = `translate(${proj[hv * 2]}px, ${proj[hv * 2 + 1]}px) translate(-50%,-50%)`;
  } else {
    el.style.opacity = '0';
  }
}

// muestra el valor del pinch (r=) justo al lado de los dedos → calibración a ojo
function updatePinchReadout() {
  const els = [
    document.getElementById('pinchReadout'),
    document.getElementById('pinchReadout2'),
  ];
  for (let k = 0; k < 2; k++) {
    const el = els[k];
    if (!el) continue;
    const h = hands[k];
    if (!h || !h.present || !S.showHands) {
      el.style.opacity = '0';
      continue;
    }
    const mx = (h.tipThumb[0] + h.tipIndex[0]) / 2;
    const my = (h.tipThumb[1] + h.tipIndex[1]) / 2;
    const fist = h.fist || 0,
      open = h.open || 0;
    let tag, col;
    if (h.pinch) {
      tag = 'PINCH → move';
      col = '#ff7a3d';
    } else if (fist > 0.55 && h.ratio > 0.28) {
      tag = 'FIST → supernova';
      col = '#ffd24a';
    } else if (open > 0.5) {
      tag = 'OPEN → expand';
      col = '#8effa6';
    } else {
      tag = '—';
      col = '#7fdcff';
    }
    el.textContent = `${tag}  r=${h.ratio.toFixed(2)} o=${open.toFixed(2)} f=${fist.toFixed(2)}`;
    el.style.color = col;
    el.style.opacity = '1';
    el.style.transform = `translate(${mx + 16}px, ${my}px) translate(0,-50%)`;
  }
}

// =============================================================================
// 7. INTERACCIÓN
// =============================================================================
function initInteraction() {
  addEventListener('pointermove', (e) => {
    S.hover = nearestNode(e.clientX, e.clientY, 26);
    document.body.style.cursor = S.hover >= 0 ? 'pointer' : 'crosshair';
  });

  addEventListener('click', () => {
    S.pinned = S.pinned === S.hover ? -1 : S.hover;
  });

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'd') S.distributed = !S.distributed;
    else if (k === 'f') S.showFace = !S.showFace;
    else if (k === 'h') S.showHands = !S.showHands;
    else if (k === 'l') S.showLabels = !S.showLabels;
    else if (k === 'r') S.rotate = !S.rotate;
    else if (k === '0') {
      // recentrar el holograma tras moverlo / escalarlo / girarlo
      manualYaw = manualPitch = 0;
      manualOffX = manualOffY = dispOffX = dispOffY = 0;
      userZoom = 1;
      grab.vX = grab.vY = 0;
    } else if (k === 'x') {
      handSwap = !handSwap; // intercambia qué mano es izq/der si salió al revés
    } else if (e.code === 'Space') {
      e.preventDefault();
      S.paused = !S.paused;
    }
    document.getElementById('modeLabel').textContent = S.distributed
      ? 'mode: distributed'
      : 'mode: silent';
    document.getElementById('modeLabel').style.color = S.distributed
      ? '#35f0ff'
      : '#6f8492';
  });
}

// =============================================================================
// status helpers
// =============================================================================
let statusTimer;
function showStatus(html, ms) {
  statusEl.innerHTML = html;
  statusEl.classList.remove('hidden');
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => statusEl.classList.add('hidden'), ms);
}
function hideStatus() {
  statusEl.classList.add('hidden');
}

// =============================================================================
// BOOT
// =============================================================================
(async function main() {
  try {
    await loadGraph();
    initLayout();
    initThree();
    initInteraction();
    showStatus(
      'Allow the camera. <b>Point</b> your index finger to highlight a memory · <b>pinch</b> it to select, or pinch empty space to move the hologram.',
      0
    );
    requestAnimationFrame(tick); // arranca el render (el grafo ya florece)
    await initCamera(); // cámara + modelo en paralelo
    if (hasFace || landmarker) hideStatus();
  } catch (e) {
    console.error(e);
    showStatus(`<span class="warn">Error:</span> ${e.message}`, 0);
  }
})();
