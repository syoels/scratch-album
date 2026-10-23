// Scratch Album — scratch the foil, reveal the photo, tap for the next one.
import * as THREE from 'three';
import { gsap } from 'gsap';

// Treat every color/texture as plain sRGB values straight through to the screen.
THREE.ColorManagement.enabled = false;

// ---------------------------------------------------------------- settings
const CFG = {
  revealAt: 0.75,          // fraction of screen scratched before the reveal
  brush: 0.085,            // brush radius as a fraction of the short screen side
  maskShortSide: 240,      // resolution of the scratch mask
  font: '"Secular One", "Rubik", "Arial Hebrew", sans-serif',
  maxDpr: 2,
};

// Warm palettes, 4 stops each. One is picked per card.
const PALETTES = [
  ['#ff9a8b', '#ff6a88', '#ff99ac', '#ffd3a5'],
  ['#f6d365', '#fda085', '#f093fb', '#fff1c1'],
  ['#ff758c', '#ff7eb3', '#7f53ac', '#ffd1e8'],
  ['#fa709a', '#fee140', '#ff9966', '#fff4d6'],
  ['#a18cd1', '#fbc2eb', '#f68084', '#ffe3f1'],
  ['#ff5f6d', '#ffc371', '#e96443', '#ffe7c7'],
  ['#c471f5', '#fa71cd', '#ffb199', '#ffe0f5'],
  ['#f857a6', '#ff5858', '#ffb88c', '#ffe4d1'],
  ['#4facfe', '#f093fb', '#f5576c', '#ffe9f3'],
  ['#ee9ca7', '#ffdde1', '#b06ab3', '#fff0f3'],
];

// ---------------------------------------------------------------- helpers
const $ = (s) => document.querySelector(s);
const hasVibrate = 'vibrate' in navigator;
const buzz = (p) => { if (hasVibrate) try { navigator.vibrate(p); } catch (_) {} };
const hex = (h) => new THREE.Color(h); // raw sRGB values (no color management, see renderer)

// Shuffle bag: every item once per round, no immediate repeat across rounds.
function bag(items) {
  let pool = [], last;
  return () => {
    if (!pool.length) {
      pool = items.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      if (pool.length > 1 && pool[pool.length - 1] === last) pool.unshift(pool.pop());
    }
    return (last = pool.pop());
  };
}

function fail(msg) {
  const e = $('#err');
  e.textContent = msg;
  e.style.display = 'block';
  $('#loader').classList.add('gone');
}

// ---------------------------------------------------------------- renderer
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // pass colors through untouched
renderer.setClearColor(0x1a0f1f, 1);
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Camera in CSS pixels, origin bottom-left, y up.
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -100, 100);

let W = 1, H = 1, DPR = 1;

// ---------------------------------------------------------------- GLSL bits
const NOISE = /* glsl */ `
  float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++){ v += a*noise(p); p = p*2.03 + 17.1; a *= 0.5; }
    return v;
  }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ---------------------------------------------------------------- photo layer
const photoMat = new THREE.ShaderMaterial({
  uniforms: {
    uTex: { value: null },
    uImgAspect: { value: 1 },
    uScreenAspect: { value: 1 },
    uZoom: { value: 1 },
    uGlow: { value: 0 },
    uBright: { value: 1 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D uTex; uniform float uImgAspect, uScreenAspect, uZoom, uGlow, uBright;
    varying vec2 vUv;
    void main(){
      vec2 uv = vUv - 0.5;
      if (uScreenAspect > uImgAspect) uv.y *= uImgAspect / uScreenAspect;
      else uv.x *= uScreenAspect / uImgAspect;
      uv = uv / uZoom + 0.5;
      vec3 c = texture2D(uTex, uv).rgb * uBright;
      float d = length((vUv - 0.5) * vec2(uScreenAspect, 1.0));
      // warm bloom-ish glow from the centre
      c += uGlow * vec3(1.0, 0.82, 0.65) * 0.22 * (1.0 - smoothstep(0.0, 0.9, d));
      // gentle vignette
      c *= 1.0 - 0.28 * smoothstep(0.45, 1.1, d);
      gl_FragColor = vec4(c, 1.0);
    }
  `,
  depthTest: false, depthWrite: false,
});
const photo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), photoMat);
photo.renderOrder = 0;
scene.add(photo);

// ---------------------------------------------------------------- hider layer
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
// A canvas texture can't change size after upload, so it is recreated on resize.
function canvasTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}
let maskTex = canvasTex(maskCanvas);

const textCanvas = document.createElement('canvas');
const textCtx = textCanvas.getContext('2d', { willReadFrequently: true });
let textTex = canvasTex(textCanvas);

const hiderMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uSeed: { value: 0 },
    uAspect: { value: 1 },
    uMask: { value: maskTex },
    uText: { value: textTex },
    uTextAlpha: { value: 1 },
    uTextScale: { value: 1 },
    uC1: { value: hex(PALETTES[0][0]) },
    uC2: { value: hex(PALETTES[0][1]) },
    uC3: { value: hex(PALETTES[0][2]) },
    uC4: { value: hex(PALETTES[0][3]) },
    uDissolve: { value: 0 },
    uAlpha: { value: 0 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
    uniform float uTime, uSeed, uAspect, uTextAlpha, uTextScale, uDissolve, uAlpha;
    uniform sampler2D uMask, uText;
    uniform vec3 uC1, uC2, uC3, uC4;
    varying vec2 vUv;
    ${NOISE}
    void main(){
      vec2 p = vec2(vUv.x * uAspect, vUv.y) + uSeed;
      float t = uTime;

      // --- animated domain-warped gradient
      float n = fbm(p * 1.3 + vec2(t * 0.045, -t * 0.035));
      float m = fbm(p * 1.7 + n * 1.6 + vec2(-t * 0.03, t * 0.025));
      vec3 col = mix(uC1, uC2, smoothstep(0.05, 0.95, vUv.y + (n - 0.5) * 0.7));
      col = mix(col, uC3, smoothstep(0.35, 0.85, m) * 0.85);
      col = mix(col, uC4, smoothstep(0.55, 0.95, n * m * 1.9) * 0.7);

      // --- foil: soft moving sheen + grain + twinkles
      float band = sin((vUv.x * uAspect * 0.9 + vUv.y) * 5.0 + n * 5.0 - t * 0.5);
      col += pow(max(band, 0.0), 6.0) * 0.16;
      col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) * 0.035;
      vec2 g = vec2(vUv.x * uAspect, vUv.y) * 26.0;
      vec2 cell = floor(g);
      float tw = hash(cell + uSeed);
      vec2 sp = vec2(hash(cell + 3.1), hash(cell + 7.7)) * 0.6 + 0.2;   // star position in its cell
      vec2 dd = fract(g) - sp;
      float star = max(0.0, 1.0 - length(dd) * 9.0);                     // soft core
      star += max(0.0, 1.0 - abs(dd.x) * 40.0) * max(0.0, 1.0 - abs(dd.y) * 5.0) * 0.6; // cross glint
      star += max(0.0, 1.0 - abs(dd.y) * 40.0) * max(0.0, 1.0 - abs(dd.x) * 5.0) * 0.6;
      float spark = step(0.9, tw) * star * pow(0.5 + 0.5 * sin(t * 2.2 + tw * 60.0), 10.0);
      col += spark * 0.8;

      // --- message
      vec2 tuv = (vUv - 0.5) / uTextScale + 0.5;
      vec4 tx = texture2D(uText, vec2(tuv.x, tuv.y));
      col = mix(col, tx.rgb, tx.a * uTextAlpha);

      // --- scratch mask (1 = scratched away)
      float sm = texture2D(uMask, vUv).r;
      float alpha = 1.0 - smoothstep(0.35, 0.62, sm);
      float rim = smoothstep(0.12, 0.38, sm) * (1.0 - smoothstep(0.38, 0.62, sm));
      col = mix(col, col * 0.7 + 0.32, rim * 0.75);   // bright torn-foil edge

      // --- dissolve on reveal
      if (uDissolve > 0.0) {
        float dn = fbm(vec2(vUv.x * uAspect, vUv.y) * 3.5 + uSeed * 3.0);
        float th = uDissolve * 1.25 - 0.12;
        float e = smoothstep(th, th + 0.07, dn);
        col = mix(vec3(1.0, 0.93, 0.75) * 1.4, col, e);
        alpha *= smoothstep(th - 0.005, th + 0.01, dn);
      }

      gl_FragColor = vec4(col, alpha * uAlpha);
    }
  `,
  transparent: true, depthTest: false, depthWrite: false,
});
const hider = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hiderMat);
hider.renderOrder = 1;
scene.add(hider);

// ---------------------------------------------------------------- foil flakes
const FLAKES = 500;
const flakeMesh = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
  FLAKES,
);
flakeMesh.renderOrder = 2;
flakeMesh.frustumCulled = false;
flakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
const flakes = Array.from({ length: FLAKES }, () => ({ life: 0 }));
let flakeCursor = 0;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(),
  _v = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
for (let i = 0; i < FLAKES; i++) {
  flakeMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
  flakeMesh.setColorAt(i, _c.set(0xffffff));
}
scene.add(flakeMesh);

function spawnFlake(x, y, dx, dy) {
  const idx = flakeCursor;
  const f = flakes[idx];
  flakeCursor = (flakeCursor + 1) % FLAKES;
  const pal = state.palette;
  f.x = x + (Math.random() - 0.5) * brushPx * 1.2;
  f.y = y + (Math.random() - 0.5) * brushPx * 1.2;
  const a = Math.random() * Math.PI * 2;
  const sp = 40 + Math.random() * 140;
  f.vx = Math.cos(a) * sp + dx * 6;
  f.vy = Math.sin(a) * sp * 0.6 + 60 + Math.random() * 80 + dy * 6;
  f.rz = Math.random() * 6.28; f.vrz = (Math.random() - 0.5) * 14;
  f.rx = Math.random() * 6.28; f.vrx = 6 + Math.random() * 12;
  f.size = 3 + Math.random() * 6;
  f.max = f.life = 0.7 + Math.random() * 0.7;
  _c.set(pal[(Math.random() * 4) | 0]).lerp(_c.clone().set(0xffffff), Math.random() * 0.45);
  flakeMesh.setColorAt(idx, _c);
  flakeMesh.instanceColor.needsUpdate = true;
}

function updateFlakes(dt) {
  let any = false;
  for (let i = 0; i < FLAKES; i++) {
    const f = flakes[i];
    if (f.life <= 0) continue;
    any = true;
    f.life -= dt;
    f.vy -= 700 * dt;                 // gravity (y up)
    f.vx *= 1 - 1.5 * dt;
    f.x += f.vx * dt; f.y += f.vy * dt;
    f.rz += f.vrz * dt; f.rx += f.vrx * dt;
    const k = Math.max(f.life / f.max, 0);
    const s = f.size * (0.3 + 0.7 * k);
    _e.set(0, 0, f.rz);
    _q.setFromEuler(_e);
    _s.set(s * (0.25 + 0.75 * Math.abs(Math.cos(f.rx))), s * 0.7, 1); // tumbling
    flakeMesh.setMatrixAt(i, _m.compose(_v.set(f.x, f.y, 0), _q, f.life > 0 ? _s : _s.set(0, 0, 0)));
  }
  if (any) flakeMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- text particles (the "burst")
const burstMat = new THREE.ShaderMaterial({
  uniforms: {
    uT: { value: 0 },
    uCenter: { value: new THREE.Vector2() },
    uSize: { value: 3 },
    uHot: { value: hex('#fff6e0') },
    uCool: { value: hex('#ff99ac') },
    uSpread: { value: 1 },
  },
  vertexShader: /* glsl */ `
    attribute vec4 aRand; attribute vec3 aCol; attribute vec2 aSize;
    uniform float uT, uSize, uSpread; uniform vec2 uCenter;
    varying float vAlpha; varying float vMix; varying vec3 vCol; varying float vShard; varying vec2 vRot;
    void main(){
      vCol = aCol; vShard = aSize.y;
      float t = clamp(uT - aRand.w * 0.12, 0.0, 1.0);    // tiny stagger
      float e = 1.0 - pow(1.0 - t, 3.0);                   // ease-out cubic
      vec2 dir = normalize(position.xy - uCenter + (aRand.xy - 0.5) * 120.0);
      float speed = mix(120.0, 720.0, aRand.z * aRand.z) * uSpread;
      vec2 p = position.xy + dir * speed * e;
      p += vec2(sin(t * 7.0 + aRand.w * 6.28), cos(t * 6.0 + aRand.x * 6.28)) * 28.0 * t;  // swirl
      p.y += 160.0 * t * t * (aRand.y - 0.25);             // drift
      p.y -= 520.0 * t * t * aSize.y * uSpread;            // shards fall
      vAlpha = 1.0 - smoothstep(0.35 + 0.45 * aRand.y, 1.0, t);
      vMix = smoothstep(0.0, 0.6, t);
      float ang = aRand.x * 6.28 + t * (aRand.z - 0.5) * 30.0;
      vRot = vec2(cos(ang), sin(ang));
      float pop = 1.0 + 1.8 * sin(min(t * 4.0, 1.0) * 3.14159) * aRand.z;
      gl_PointSize = uSize * aSize.x * pop * (1.0 - 0.55 * t);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uHot, uCool;
    varying float vAlpha; varying float vMix; varying vec3 vCol; varying float vShard; varying vec2 vRot;
    void main(){
      vec2 q = gl_PointCoord - 0.5;
      float d = length(q);
      float a = smoothstep(0.5, 0.0, d);
      if (vShard > 0.5) {                     // foil shard: crisp tumbling diamond with a glint
        float r = abs(q.x * vRot.x - q.y * vRot.y) + abs(q.x * vRot.y + q.y * vRot.x);
        a = 1.0 - smoothstep(0.4, 0.46, r);
      }
      vec3 c = mix(vCol, uCool, vMix * (1.0 - vShard) * 0.6);
      c += vShard * 0.35 * pow(max(vRot.x, 0.0), 8.0);   // flash as it turns
      gl_FragColor = vec4(c * (1.0 + a * 0.4), a * vAlpha);
    }
  `,
  transparent: true, depthTest: false, depthWrite: false, blending: THREE.NormalBlending,
});
let burst = null;

function makeBurst() {
  if (burst) { scene.remove(burst); burst.geometry.dispose(); burst = null; }
  const tw = textCanvas.width, th = textCanvas.height;
  const img = textCtx.getImageData(0, 0, tw, th).data;
  const mw = maskCanvas.width, mh = maskCanvas.height;
  const mask = maskCtx.getImageData(0, 0, mw, mh).data;
  // pick a sampling step that keeps the count reasonable
  let filled = 0;
  for (let i = 3; i < img.length; i += 4 * 16) if (img[i] > 160) filled++;
  filled *= 16;
  const step = Math.max(2, Math.round(Math.sqrt(filled / 9000)));
  const pos = [], rnd = [], col = [], siz = [];
  const textPt = Math.max(2.5, step / DPR * 1.6);
  // 1) what's left of the message: bright white particles
  for (let y = 0; y < th; y += step) {
    for (let x = 0; x < tw; x += step) {
      const i = (y * tw + x) * 4;
      if (img[i + 3] < 160 || img[i] < 200) continue;          // solid white glyph pixels only
      const mx = Math.min(mw - 1, (x / tw * mw) | 0), my = Math.min(mh - 1, (y / th * mh) | 0);
      if (mask[(my * mw + mx) * 4] > 120) continue;            // already scratched away
      pos.push(x / tw * W, H - y / th * H, 0);
      rnd.push(Math.random(), Math.random(), Math.random(), Math.random());
      col.push(1, 0.97, 0.9);
      siz.push(textPt, 0.15);
    }
  }
  // 2) whatever foil is still covering the photo: palette-colored shards
  let left = 0;
  for (let i = 0; i < mask.length; i += 4) if (mask[i] < 120) left++;
  const keep = Math.min(1, 5000 / Math.max(left, 1));
  const pal = state.palette.map((h) => hex(h));
  for (let my = 0; my < mh; my++) {
    for (let mx = 0; mx < mw; mx++) {
      if (mask[(my * mw + mx) * 4] >= 120 || Math.random() > keep) continue;
      const c = pal[(Math.random() * 4) | 0].clone().lerp(new THREE.Color(1, 1, 1), 0.15 + Math.random() * 0.35);
      pos.push((mx + Math.random()) / mw * W, H - (my + Math.random()) / mh * H, 0);
      rnd.push(Math.random(), Math.random(), Math.random(), Math.random());
      col.push(c.r, c.g, c.b);
      siz.push(3 + Math.random() * 5, 1);
    }
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rnd, 4));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(siz, 2));
  burst = new THREE.Points(g, burstMat);
  burst.renderOrder = 3;
  burst.frustumCulled = false;
  burstMat.uniforms.uT.value = 0;
  burstMat.uniforms.uCenter.value.set(W / 2, H / 2);
  burstMat.uniforms.uSize.value = DPR;
  burstMat.uniforms.uSpread.value = Math.min(W, H) / 400;
  burstMat.uniforms.uCool.value = hex(state.palette[3]);
  scene.add(burst);
}

// ---------------------------------------------------------------- text rendering
function drawText(msg) {
  state.message = msg; // remembered so a resize can redraw it
  const cw = Math.round(W * DPR), ch = Math.round(H * DPR);
  if (textCanvas.width !== cw || textCanvas.height !== ch) {
    textCanvas.width = cw; textCanvas.height = ch;
    textTex.dispose();
    hiderMat.uniforms.uText.value = textTex = canvasTex(textCanvas);
  }
  const ctx = textCtx;
  ctx.clearRect(0, 0, cw, ch);
  const maxW = W * 0.84, maxH = H * 0.6;
  const words = msg.split(/\s+/).filter(Boolean);

  const layout = (size) => {
    ctx.font = `${size}px ${CFG.font}`;
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width <= maxW || !line) line = test;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    return { lines, ok: widest <= maxW && lines.length * size * 1.18 <= maxH };
  };

  let lo = 14, hi = Math.min(W, H) * 0.32, best = layout(lo);
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2, l = layout(mid);
    if (l.ok) { lo = mid; best = l; } else hi = mid;
  }
  const size = lo;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.font = `${size}px ${CFG.font}`;
  ctx.direction = 'rtl';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lh = size * 1.18;
  const top = H / 2 - (best.lines.length - 1) * lh / 2;
  ctx.shadowColor = 'rgba(70, 10, 40, 0.28)';
  ctx.shadowBlur = size * 0.18;
  ctx.shadowOffsetY = size * 0.05;
  ctx.fillStyle = '#ffffff';
  best.lines.forEach((l, i) => ctx.fillText(l, W / 2, top + i * lh));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  textTex.needsUpdate = true;
}

// ---------------------------------------------------------------- scratch mask
let brushPx = 30;
function resetMask() {
  const s = CFG.maskShortSide / Math.min(W, H);
  const mw = Math.round(W * s), mh = Math.round(H * s);
  if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
    maskCanvas.width = mw; maskCanvas.height = mh;
    maskTex.dispose();
    hiderMat.uniforms.uMask.value = maskTex = canvasTex(maskCanvas);
  }
  maskCtx.fillStyle = '#000';
  maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskTex.needsUpdate = true;
}

function stamp(x, y) {
  // x,y in CSS px, canvas space (y down)
  const s = maskCanvas.width / W;
  const r = brushPx * s;
  const g = maskCtx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  maskCtx.fillStyle = g;
  maskCtx.beginPath();
  maskCtx.arc(x * s, y * s, r, 0, Math.PI * 2);
  maskCtx.fill();
}

function scratchLine(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(d / (brushPx * 0.3)));
  for (let i = 1; i <= n; i++) stamp(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
  maskTex.needsUpdate = true;
}

function coverage() {
  const { width: w, height: h } = maskCanvas;
  const d = maskCtx.getImageData(0, 0, w, h).data;
  let on = 0, total = 0;
  for (let i = 0; i < d.length; i += 8) { total++; if (d[i] > 128) on++; }
  return on / total;
}

// ---------------------------------------------------------------- state
const state = {
  mode: 'loading',      // loading | hiding | bursting | revealed | transition
  palette: PALETTES[0],
  nextPhoto: null,      // Promise<{tex, aspect}>
  current: null,
  scratched: 0,
};
let nextMessage, nextPhotoName, nextPalette;
if (location.search.includes('debug')) window.__sa = { state, gsap, get msgs() { return nextMessage; } };

function loadPhoto(name) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(`photos/${encodeURIComponent(name)}`, (tex) => {
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      renderer.initTexture(tex);                       // upload now, avoid a hitch later
      resolve({ tex, aspect: tex.image.width / tex.image.height });
    }, undefined, reject);
  });
}

function queueNextPhoto() {
  state.nextPhoto = loadPhoto(nextPhotoName()).catch(() => loadPhoto(nextPhotoName()));
}

function setPhoto(p) {
  if (state.current && state.current.tex !== p.tex) state.current.tex.dispose();
  state.current = p;
  photoMat.uniforms.uTex.value = p.tex;
  photoMat.uniforms.uImgAspect.value = p.aspect;
  gsap.killTweensOf(photoMat.uniforms.uZoom);
  photoMat.uniforms.uZoom.value = 1.0;
  photoMat.uniforms.uGlow.value = 0;
  photoMat.uniforms.uBright.value = 0.92;
}

function setPalette(pal) {
  state.palette = pal;
  const u = hiderMat.uniforms;
  u.uC1.value = hex(pal[0]); u.uC2.value = hex(pal[1]);
  u.uC3.value = hex(pal[2]); u.uC4.value = hex(pal[3]);
  u.uSeed.value = Math.random() * 50;
}

// New card: hider fades + settles in (scale & opacity, ease-out), then the photo is swapped beneath it.
async function newCard(first = false) {
  state.mode = 'transition';
  const msg = nextMessage();
  const p = await state.nextPhoto;
  queueNextPhoto();

  const u = hiderMat.uniforms;
  const swap = () => {
    setPalette(nextPalette());
    drawText(msg);
    resetMask();
    u.uDissolve.value = 0;
    u.uTextAlpha.value = 1;
    if (burst) { scene.remove(burst); burst.geometry.dispose(); burst = null; }
  };

  if (first) {
    swap();
    setPhoto(p);
    $('#loader').classList.add('gone');
  } else {
    // fade the new hider in over the revealed photo
    swap();
    u.uAlpha.value = 0;
  }
  u.uTextScale.value = 1.07;
  gsap.to(u.uTextScale, { value: 1, duration: 0.9, ease: 'back.out(1.6)' });
  await new Promise((res) => gsap.fromTo(u.uAlpha, { value: 0 }, {
    value: 1, duration: first ? 0.7 : 0.55, ease: 'expo.out', onComplete: res,
  }));
  setPhoto(p);
  state.scratched = 0;
  state.mode = 'hiding';
}

// The big moment.
function reveal() {
  state.mode = 'bursting';
  buzz([18, 40, 60]);
  const u = hiderMat.uniforms, pu = photoMat.uniforms;
  const tl = gsap.timeline({ onComplete: () => { state.mode = 'revealed'; } });

  // anticipation: the words gather in a little…
  tl.to(u.uTextScale, { value: 0.93, duration: 0.14, ease: 'power2.in' });
  // …then burst into particles
  tl.add(() => { makeBurst(); u.uTextAlpha.value = 0; });
  tl.to(burstMat.uniforms.uT, { value: 1.12, duration: 1.6, ease: 'none' }, '>');
  // secondary: the remaining foil dissolves with a glowing edge
  tl.to(u.uDissolve, { value: 1, duration: 0.38, ease: 'power2.in' }, '<');
  // the photo "breathes": pop + glow, then settle into a slow drift
  tl.to(pu.uBright, { value: 1, duration: 0.6, ease: 'power2.out' }, '<');
  tl.fromTo(pu.uZoom, { value: 1.0 }, { value: 1.07, duration: 0.42, ease: 'back.out(2.2)' }, '<0.1');
  tl.to(pu.uGlow, { value: 1, duration: 0.3, ease: 'power2.out' }, '<');
  tl.to(pu.uGlow, { value: 0, duration: 1.4, ease: 'power2.inOut' }, '>');
  tl.to(pu.uZoom, { value: 1.025, duration: 1.4, ease: 'elastic.out(1, 0.45)' }, '<');
  tl.add(() => {
    // ambient: very slow Ken Burns while the photo is on screen
    gsap.to(pu.uZoom, { value: 1.06, duration: 14, ease: 'sine.inOut', yoyo: true, repeat: -1 });
  });
  // let a tap through a bit before the particles finish
  tl.add(() => { if (state.mode === 'bursting') state.mode = 'revealed'; }, 1.0);
}

// ---------------------------------------------------------------- input
let drag = null, lastBuzz = 0, lastCov = 0, downAt = null;
const el = renderer.domElement;

el.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (state.mode === 'hiding') {
    drag = { x: e.clientX, y: e.clientY };
    scratchLine(e.clientX, e.clientY, e.clientX, e.clientY);
  }
});

el.addEventListener('pointermove', (e) => {
  if (!drag || state.mode !== 'hiding') return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (evs.length ? evs : [e])) {
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) continue;
    scratchLine(drag.x, drag.y, ev.clientX, ev.clientY);
    const n = Math.min(4, Math.round(d / 7));
    for (let i = 0; i < n; i++) spawnFlake(ev.clientX, H - ev.clientY, dx / Math.max(d, 1), -dy / Math.max(d, 1));
    drag.x = ev.clientX; drag.y = ev.clientY;
  }
  const now = performance.now();
  if (now - lastBuzz > 75) { buzz(7); lastBuzz = now; }
  if (now - lastCov > 160) {
    lastCov = now;
    state.scratched = coverage();
    if (state.scratched >= CFG.revealAt) { drag = null; reveal(); }
  }
});

const end = (e) => {
  if (drag && state.mode === 'hiding') {
    state.scratched = coverage();
    if (state.scratched >= CFG.revealAt) reveal();
  }
  drag = null;
  if (downAt && state.mode === 'revealed' && e.type === 'pointerup') {
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    if (moved < 20 && performance.now() - downAt.t < 600) newCard();
  }
  downAt = null;
};
el.addEventListener('pointerup', end);
el.addEventListener('pointercancel', end);
el.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------------------------------------------------------------- layout
function resize() {
  const r = stage.getBoundingClientRect();
  const oldMask = maskCanvas.width ? (() => {
    const c = document.createElement('canvas');
    c.width = maskCanvas.width; c.height = maskCanvas.height;
    c.getContext('2d').drawImage(maskCanvas, 0, 0);
    return c;
  })() : null;

  W = Math.max(1, r.width); H = Math.max(1, r.height);
  DPR = Math.min(window.devicePixelRatio || 1, CFG.maxDpr);
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  camera.left = 0; camera.right = W; camera.top = H; camera.bottom = 0;
  camera.updateProjectionMatrix();
  for (const m of [photo, hider]) { m.scale.set(W, H, 1); m.position.set(W / 2, H / 2, 0); }
  photoMat.uniforms.uScreenAspect.value = W / H;
  hiderMat.uniforms.uAspect.value = W / H;
  brushPx = Math.min(W, H) * CFG.brush;

  resetMask();
  if (oldMask) { maskCtx.drawImage(oldMask, 0, 0, maskCanvas.width, maskCanvas.height); maskTex.needsUpdate = true; }
  if (state.message) drawText(state.message);
}
window.addEventListener('resize', resize);
window.visualViewport && window.visualViewport.addEventListener('resize', resize);

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  hiderMat.uniforms.uTime.value += dt;
  updateFlakes(dt);
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- boot
async function boot() {
  resize();
  try {
    const [photos, msgText] = await Promise.all([
      fetch('photos.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('messages.txt', { cache: 'no-cache' }).then((r) => r.text()),
    ]);
    const messages = msgText.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (!photos.length) return fail('אין תמונות ב-photos.json');
    if (!messages.length) messages.push('גרד/י אותי');
    nextMessage = bag(messages);
    nextPhotoName = bag(photos);
    nextPalette = bag(PALETTES);
    try { await document.fonts.load(`64px ${CFG.font}`, 'אבג'); } catch (_) {}
    queueNextPhoto();
    await newCard(true);
  } catch (err) {
    console.error(err);
    fail('משהו השתבש בטעינה. נסו לרענן.');
  }
}
boot();
