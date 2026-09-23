// Canvas boids (Craig Reynolds) driven by the reward state.
// Out of zone: grey, loose, slow. Holding: the flock gathers. Rewarded: colour, glow, trails, speed.

const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class FlockCanvas {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.variant = options.variant || 'classic'; // 'classic' | 'retro'
    this.boids = [];
    this.drive = 0.5;          // 0 (slow) to 1 (fast)
    this.reward = false;
    this.hold = 0;             // 0..1 progress toward reward
    this.dimmed = false;       // breaks, pauses, lost signal
    this.colorTransition = 0;  // 0 (grey) to 1 (full colour)
    this.gather = 0;
    this.flourishT = 0;
    this.hue = options.hue ?? 165;
    this.light = !!options.light;
    this.running = false;
    this.animId = null;
    this.width = 800;
    this.height = 400;
    this.mouse = { x: 0, y: 0, active: false };

    this.glow = null;
    this.breath = null;        // pacer lung level 0..1, or null when no pacer runs

    this.fit();
    this.setCount(options.count || 64);
    this.bindEvents();
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.fit()).observe(canvas);
  }

  setCount(count) {
    while (this.boids.length > count) this.boids.pop();
    while (this.boids.length < count) {
      this.boids.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        trail: [],
        tint: (Math.random() - 0.5) * 70,
        size: 3 + Math.random() * 2.5
      });
    }
  }

  bindEvents() {
    this.canvas.addEventListener('pointermove', e => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
      this.mouse.active = true;
    });
    this.canvas.addEventListener('pointerleave', () => { this.mouse.active = false; });
  }

  // Match the backing store to the CSS box and device pixel ratio.
  fit() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setReward(reward, drive = 0.5, hold = 0) {
    this.reward = reward;
    this.drive = Math.max(0.1, Math.min(1, drive));
    this.hold = Math.max(0, Math.min(1, hold));
  }

  setDimmed(dimmed) { this.dimmed = dimmed; }
  setBreath(level) { this.breath = level; }
  setVariant(variant) { this.variant = variant; }
  setPalette({ hue, light }) { this.hue = hue; this.light = light; this.glow = null; }

  // Centre of the flock in CSS pixels, with the stage size, for lighting that follows it.
  centroid() {
    if (!this.boids.length) return null;
    let x = 0, y = 0;
    for (const b of this.boids) { x += b.x; y += b.y; }
    return { x: x / this.boids.length, y: y / this.boids.length, w: this.width, h: this.height };
  }

  // Soft radial sprite in the palette hue, drawn additively under each bird when rewarded.
  glowSprite() {
    if (this.glow) return this.glow;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `hsla(${this.hue}, 90%, 70%, 0.9)`);
    grad.addColorStop(0.35, `hsla(${this.hue}, 90%, 60%, 0.25)`);
    grad.addColorStop(1, `hsla(${this.hue}, 90%, 55%, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    this.glow = c;
    return c;
  }

  // Milestone accent: a brief outward burst.
  flourish() {
    if (REDUCED_MOTION) return;
    this.flourishT = 1;
    // Burst outward from the flock's own centre, wherever it has gathered.
    let cx = 0, cy = 0;
    for (const b of this.boids) { cx += b.x; cy += b.y; }
    cx /= this.boids.length; cy /= this.boids.length;
    for (const b of this.boids) {
      const dx = b.x - cx, dy = b.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      b.vx += (dx / d) * 2.6;
      b.vy += (dy / d) * 2.6;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (this.canvas.offsetParent !== null) { // skip while another scene hides the stage canvas
        this.update(dt);
        this.render();
      }
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.animId) cancelAnimationFrame(this.animId);
  }

  update(dt) {
    const ease = Math.min(dt * 3.5, 1);
    this.colorTransition += ((this.reward && !this.dimmed ? 1 : 0) - this.colorTransition) * ease;
    this.gather += ((this.dimmed ? 0 : this.reward ? 0.45 : this.hold * 0.9) - this.gather) * ease;
    this.flourishT = Math.max(0, this.flourishT - dt * 1.2);

    const calm = REDUCED_MOTION ? 0.55 : 1;
    const speedLimit = (this.dimmed ? 0.9 : 1.2 + this.drive * 2.8 + this.flourishT * 2.5) * calm;
    const visualRange = 52 + this.gather * 60;
    const minDistance = 26 - this.gather * 6;
    const cohesion = 0.0025 + this.gather * 0.012;
    const cx = this.width / 2, cy = this.height / 2;
    const trailLength = this.variant === 'retro' ? 6 : 12 + Math.round(this.drive * 10);

    for (let i = 0; i < this.boids.length; i++) {
      const b1 = this.boids[i];
      let avgVx = 0, avgVy = 0, centerX = 0, centerY = 0, closeCount = 0, sepX = 0, sepY = 0;

      for (let j = 0; j < this.boids.length; j++) {
        if (i === j) continue;
        const b2 = this.boids[j];
        const dx = b2.x - b1.x, dy = b2.y - b1.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= visualRange * visualRange) continue;
        avgVx += b2.vx; avgVy += b2.vy;
        centerX += b2.x; centerY += b2.y;
        closeCount++;
        if (distSq < minDistance * minDistance) {
          const dist = Math.sqrt(distSq) || 1;
          sepX -= (dx / dist) * (minDistance - dist);
          sepY -= (dy / dist) * (minDistance - dist);
        }
      }

      if (closeCount > 0) {
        b1.vx += (avgVx / closeCount - b1.vx) * 0.04;
        b1.vy += (avgVy / closeCount - b1.vy) * 0.04;
        b1.vx += (centerX / closeCount - b1.x) * cohesion;
        b1.vy += (centerY / closeCount - b1.y) * cohesion;
      }
      b1.vx += sepX * 0.07;
      b1.vy += sepY * 0.07;

      // Holding draws the whole flock toward the middle of the stage.
      const pull = 0.00025 + 0.0022 * this.gather;
      b1.vx += (cx - b1.x) * pull;
      b1.vy += (cy - b1.y) * pull;

      // With a pacer, the flock holds a ring that widens on the in-breath and narrows on the out-breath.
      if (this.breath !== null && !this.dimmed) {
        const rx = b1.x - cx, ry = b1.y - cy;
        const d = Math.hypot(rx, ry) || 1;
        const ring = Math.min(this.width, this.height) * (0.1 + 0.26 * this.breath);
        const k = Math.max(-1.2, Math.min(1.2, (ring - d) * 0.006)) * (REDUCED_MOTION ? 0.5 : 1);
        b1.vx += (rx / d) * k;
        b1.vy += (ry / d) * k;
      }

      // Wander keeps an unrewarded flock from settling into one stream.
      const jitter = 0.12 * (1 - this.colorTransition);
      b1.vx += (Math.random() - 0.5) * jitter;
      b1.vy += (Math.random() - 0.5) * jitter;

      if (this.mouse.active) {
        const mdx = this.mouse.x - b1.x, mdy = this.mouse.y - b1.y;
        const mDistSq = mdx * mdx + mdy * mdy;
        if (mDistSq < 12000) {
          const mDist = Math.sqrt(mDistSq) || 1;
          b1.vx -= (mdx / mDist) * 1.4;
          b1.vy -= (mdy / mDist) * 1.4;
        }
      }

      // Soft walls: steering grows with how far a bird has strayed into the margin.
      const margin = 60;
      const wall = (depth) => 0.2 + Math.min(2, depth / margin) * 1.1;
      if (b1.x < margin) b1.vx += wall(margin - b1.x);
      if (b1.x > this.width - margin) b1.vx -= wall(b1.x - (this.width - margin));
      if (b1.y < margin) b1.vy += wall(margin - b1.y);
      if (b1.y > this.height - margin) b1.vy -= wall(b1.y - (this.height - margin));

      const speed = Math.hypot(b1.vx, b1.vy) || 0.1;
      const floor = speedLimit * 0.45;
      const clamped = Math.max(floor, Math.min(speedLimit, speed));
      b1.vx = (b1.vx / speed) * clamped;
      b1.vy = (b1.vy / speed) * clamped;

      b1.x += b1.vx * 60 * dt;
      b1.y += b1.vy * 60 * dt;

      if (this.colorTransition > 0.1) {
        b1.trail.push(b1.x, b1.y);
        if (b1.trail.length > trailLength * 2) b1.trail.splice(0, 2);
      } else if (b1.trail.length) {
        b1.trail.splice(0, 2);
      }
    }
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.colorTransition;
    const isRetro = this.variant === 'retro';
    const lightness = this.light ? 38 : 68;
    const greyL = this.light ? 62 : 56;
    const fade = this.dimmed ? 0.45 : 1;

    if (t > 0.05) {
      // Additive light only reads on a dark stage.
      if (!this.light) ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = isRetro ? 2 : 1.5;
      ctx.lineCap = 'round';
      for (const b of this.boids) {
        if (b.trail.length < 4) continue;
        ctx.beginPath();
        ctx.moveTo(b.trail[0], b.trail[1]);
        for (let i = 2; i < b.trail.length; i += 2) ctx.lineTo(b.trail[i], b.trail[i + 1]);
        ctx.strokeStyle = `hsla(${this.hue + b.tint}, 80%, ${lightness}%, ${(t * 0.4 * fade).toFixed(2)})`;
        ctx.stroke();
      }
      if (!this.light && !isRetro) {
        const sprite = this.glowSprite();
        ctx.globalAlpha = t * 0.42 * fade;
        for (const b of this.boids) {
          const s = b.size * (7 + this.flourishT * 5);
          ctx.drawImage(sprite, b.x - s / 2, b.y - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.globalAlpha = fade;
    for (const b of this.boids) {
      const l = greyL + (lightness - greyL) * t;
      ctx.fillStyle = `hsl(${this.hue + b.tint}, ${Math.round(82 * t)}%, ${l}%)`;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(Math.atan2(b.vy, b.vx));
      if (isRetro) {
        ctx.fillRect(-3, -2, 6, 4);
        ctx.fillRect(1, -1, 3, 2);
      } else {
        const s = b.size * (1 + this.flourishT * 0.3);
        ctx.beginPath();
        ctx.moveTo(s * 2, 0);
        ctx.lineTo(-s * 1.4, -s * 1.1);
        ctx.lineTo(-s * 0.7, 0);
        ctx.lineTo(-s * 1.4, s * 1.1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
