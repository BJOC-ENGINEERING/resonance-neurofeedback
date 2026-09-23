// WebGL night sky behind the flock. Aurora curtains brighten and widen with reward,
// a soft light follows the flock while you hold, and milestones send out a ring.
// Renders at reduced resolution; if WebGL is unavailable the CSS stage gradient shows instead.

const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SCALE = 0.5; // backing store relative to CSS pixels; the image is soft, so this is invisible

const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `precision mediump float;
uniform vec2 u_res;
uniform float u_time, u_energy, u_hold, u_dim, u_pulse;
uniform vec3 u_col, u_col2;
uniform vec2 u_focus;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.035;
  float e = u_energy;

  vec3 col = mix(vec3(0.010, 0.013, 0.022), vec3(0.028, 0.036, 0.055), uv.y);

  // Aurora curtains: three noisy bands with vertical streaks.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float y = 0.42 + 0.14 * fi + (fbm(vec2(p.x * 1.1 + t * (1.0 + fi * 0.35), fi * 3.7 + t)) - 0.5) * 0.55;
    float d = uv.y - y;
    float width = mix(90.0, 22.0, e);
    float band = exp(-d * d * width) * smoothstep(-0.25, 0.05, d + 0.12);
    float streak = 0.45 + 0.55 * fbm(vec2(p.x * 9.0 + fi * 5.0, t * 3.0 + fi));
    vec3 c = mix(u_col, u_col2, fi * 0.5);
    col += c * band * streak * (0.07 + 0.6 * e) * (1.0 - 0.28 * fi);
  }

  // Light that follows the flock, brighter while holding.
  float fd = length(p - u_focus);
  col += u_col * exp(-fd * fd * 7.0) * (0.04 + 0.26 * u_hold + 0.14 * e);

  // Milestone ring expanding from the flock.
  float r = (1.0 - u_pulse) * 1.1;
  col += u_col2 * exp(-pow((fd - r) * 14.0, 2.0)) * u_pulse * 0.6;

  // Stars, fading as the aurora takes over.
  vec2 cell = floor(gl_FragCoord.xy);
  float h = hash(cell);
  float star = step(0.9965, h) * (0.5 + 0.5 * sin(u_time * (1.5 + h * 4.0) + h * 60.0));
  col += vec3(star) * 0.55 * (1.0 - 0.6 * e) * uv.y;

  col *= mix(1.0, 0.4, u_dim);
  vec2 v = uv - 0.5;
  col *= 1.0 - 0.9 * dot(v, v);
  col += (hash(gl_FragCoord.xy + u_time) - 0.5) / 255.0; // dither against banding
  gl_FragColor = vec4(col, 1.0);
}`;

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export class StageBackdrop {
  constructor(canvas, { getFocus } = {}) {
    this.canvas = canvas;
    this.getFocus = getFocus || (() => null);
    this.hue = 165;
    this.target = { energy: 0, hold: 0, dim: 0 };
    this.state = { energy: 0, hold: 0, dim: 0, pulse: 0, fx: 0, fy: 0 };
    this.time = Math.random() * 100;
    this.running = false;
    this.gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'low-power' });
    this.ok = !!this.gl && this.build();
    canvas.hidden = !this.ok;
    if (!this.ok) return;
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.ok = false; canvas.hidden = true; });
    this.fit();
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.fit()).observe(canvas);
  }

  build() {
    const gl = this.gl;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT), fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(['u_res', 'u_time', 'u_energy', 'u_hold', 'u_dim', 'u_pulse', 'u_col', 'u_col2', 'u_focus']
      .map(n => [n, gl.getUniformLocation(prog, n)]));
    return true;
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr * SCALE));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr * SCALE));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // energy: 0..1 how strongly rewarded; hold: 0..1 progress toward reward; dimmed: breaks, pauses, lost signal.
  set({ energy = 0, hold = 0, dimmed = false }) {
    this.target.energy = Math.max(0, Math.min(1, energy));
    this.target.hold = Math.max(0, Math.min(1, hold));
    this.target.dim = dimmed ? 1 : 0;
  }

  setHue(hue) { this.hue = hue; }
  pulse() { if (!REDUCED_MOTION) this.state.pulse = 1; }

  start() {
    if (!this.ok || this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (this.ok && !this.canvas.closest('[hidden]') && this.canvas.offsetParent !== null) this.render(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  render(dt) {
    const { gl, u, state, target } = this;
    const ease = (rate) => Math.min(1, dt * rate);
    state.energy += (target.energy - state.energy) * ease(1.6);
    state.hold += (target.hold - state.hold) * ease(3);
    state.dim += (target.dim - state.dim) * ease(2);
    state.pulse = Math.max(0, state.pulse - dt * 0.8);
    this.time += dt * (REDUCED_MOTION ? 0.3 : 1) * (1 + state.energy * 0.8);

    const w = this.canvas.width, h = this.canvas.height;
    const focus = this.getFocus();
    if (focus && focus.w && focus.h) {
      const fx = (focus.x - focus.w / 2) / focus.h, fy = (focus.h / 2 - focus.y) / focus.h;
      state.fx += (fx - state.fx) * ease(2.5);
      state.fy += (fy - state.fy) * ease(2.5);
    }

    const sat = 0.35 + 0.55 * state.energy;
    gl.uniform2f(u.u_res, w, h);
    gl.uniform1f(u.u_time, this.time);
    gl.uniform1f(u.u_energy, state.energy);
    gl.uniform1f(u.u_hold, state.hold);
    gl.uniform1f(u.u_dim, state.dim);
    gl.uniform1f(u.u_pulse, state.pulse);
    gl.uniform3fv(u.u_col, hslToRgb(this.hue, sat, 0.55));
    gl.uniform3fv(u.u_col2, hslToRgb(this.hue + 55, sat * 0.9, 0.6));
    gl.uniform2f(u.u_focus, state.fx, state.fy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
