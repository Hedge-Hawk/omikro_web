(() => {
  "use strict";

  const canvas = document.getElementById("pond");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const hint = document.querySelector("[data-hint]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const CELL = 7;
  const DAMPING = 0.986;
  const MAX_COLS = 240;
  const MAX_ROWS = 140;
  const FISH_COUNT = 7;

  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let cols = 0;
  let rows = 0;
  let cur = new Float32Array(0);
  let prev = new Float32Array(0);

  const low = document.createElement("canvas");
  const lowCtx = low.getContext("2d");
  let image = null;

  const pointer = { x: -9999, y: -9999 };
  const fishes = [];

  function seedFishes() {
    fishes.length = 0;
    for (let i = 0; i < FISH_COUNT; i++) {
      fishes.push({
        x: Math.random() * viewW,
        y: Math.random() * viewH,
        a: Math.random() * Math.PI * 2,
        speed: 28 + Math.random() * 30,
        size: 5 + Math.random() * 5,
        phase: Math.random() * Math.PI * 2,
        wiggle: 5 + Math.random() * 3,
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.floor(viewW * dpr);
    canvas.height = Math.floor(viewH * dpr);
    canvas.style.width = viewW + "px";
    canvas.style.height = viewH + "px";

    cols = Math.max(64, Math.min(MAX_COLS, Math.ceil(viewW / CELL)));
    rows = Math.max(48, Math.min(MAX_ROWS, Math.ceil(viewH / CELL)));
    cur = new Float32Array(cols * rows);
    prev = new Float32Array(cols * rows);
    low.width = cols;
    low.height = rows;
    image = lowCtx.createImageData(cols, rows);

    seedFishes();
  }

  function disturb(px, py, radius, strength) {
    if (!cols || !rows) return;
    const gx = (px / viewW) * cols;
    const gy = (py / viewH) * rows;
    const r = Math.max(1.5, radius);
    const x0 = Math.max(1, Math.floor(gx - r));
    const x1 = Math.min(cols - 2, Math.ceil(gx + r));
    const y0 = Math.max(1, Math.floor(gy - r));
    const y1 = Math.min(rows - 2, Math.ceil(gy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx;
        const dy = y - gy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= r) {
          cur[y * cols + x] += strength * (1 - d / (r + 1));
        }
      }
    }
  }

  function stepWater() {
    for (let y = 1; y < rows - 1; y++) {
      const row = y * cols;
      for (let x = 1; x < cols - 1; x++) {
        const i = row + x;
        const v =
          (cur[i - 1] + cur[i + 1] + cur[i - cols] + cur[i + cols]) * 0.5 -
          prev[i];
        prev[i] = v * DAMPING;
      }
    }
    const tmp = cur;
    cur = prev;
    prev = tmp;
  }

  function paintWater() {
    const data = image.data;
    for (let i = 0, n = cols * rows, p = 0; i < n; i++, p += 4) {
      const v = Math.abs(cur[i]) * 7;
      const b = v > 255 ? 255 : v;
      data[p] = b;
      data[p + 1] = b;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
    lowCtx.putImageData(image, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(low, 0, 0, cols, rows, 0, 0, canvas.width, canvas.height);
  }

  function updateFishes(dt, t) {
    for (const f of fishes) {
      f.a += Math.sin(t * 0.9 + f.phase) * 0.9 * dt;

      const dx = f.x - pointer.x;
      const dy = f.y - pointer.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 140 && d > 0.01) {
        const away = Math.atan2(dy, dx);
        let diff = away - f.a;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        f.a += diff * Math.min(1, 3 * dt);
      }

      f.x += Math.cos(f.a) * f.speed * dt;
      f.y += Math.sin(f.a) * f.speed * dt;

      const m = 24;
      if (f.x < -m) f.x = viewW + m;
      if (f.x > viewW + m) f.x = -m;
      if (f.y < -m) f.y = viewH + m;
      if (f.y > viewH + m) f.y = -m;

      if (Math.random() < dt * 2) disturb(f.x, f.y, 1.6, 6);
    }
  }

  function drawFishes(t) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.shadowColor = "rgba(255, 255, 255, 0.8)";
    ctx.shadowBlur = 12;
    for (const f of fishes) {
      const wig = Math.sin(t * f.wiggle + f.phase) * 0.35;
      const len = f.size * 2.4;
      const hx = f.x + Math.cos(f.a) * len * 0.5;
      const hy = f.y + Math.sin(f.a) * len * 0.5;
      const tx = f.x - Math.cos(f.a + wig) * len * 0.5;
      const ty = f.y - Math.sin(f.a + wig) * len * 0.5;
      ctx.lineWidth = Math.max(1.5, f.size * 0.45);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.quadraticCurveTo(f.x, f.y, hx, hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStaticRings() {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
    ctx.lineWidth = 1.5;
    const rings = [
      [viewW * 0.3, viewH * 0.4, 26],
      [viewW * 0.3, viewH * 0.4, 44],
      [viewW * 0.62, viewH * 0.58, 34],
      [viewW * 0.62, viewH * 0.58, 58],
      [viewW * 0.78, viewH * 0.3, 20],
    ];
    for (const [x, y, r] of rings) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function hideHint() {
    if (hint) hint.classList.add("is-hidden");
  }

  resize();

  if (reduceMotion.matches) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawStaticRings();
    drawFishes(0);
    if (hint) hint.hidden = true;
    window.addEventListener("resize", resize);
    return;
  }

  let lastX = null;
  let lastY = null;

  const setPointer = (clientX, clientY) => {
    pointer.x = clientX;
    pointer.y = clientY;
  };

  canvas.addEventListener("pointermove", (event) => {
    setPointer(event.clientX, event.clientY);
    if (lastX === null || Math.hypot(event.clientX - lastX, event.clientY - lastY) > 6) {
      disturb(event.clientX, event.clientY, 2, 30);
      lastX = event.clientX;
      lastY = event.clientY;
    }
  });

  canvas.addEventListener("pointerdown", (event) => {
    setPointer(event.clientX, event.clientY);
    disturb(event.clientX, event.clientY, 3.5, 220);
    hideHint();
  });

  canvas.addEventListener("pointerleave", () => {
    pointer.x = -9999;
    pointer.y = -9999;
    lastX = null;
    lastY = null;
  });

  window.addEventListener("resize", resize);

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(frame);
  });

  let last = performance.now();
  let nextDrop = 0;

  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const t = now / 1000;

    if (t >= nextDrop) {
      disturb(Math.random() * viewW, Math.random() * viewH, 2, 40);
      nextDrop = t + 0.4 + Math.random() * 0.8;
    }

    stepWater();
    paintWater();
    updateFishes(dt, t);
    drawFishes(t);

    requestAnimationFrame(frame);
  }

  disturb(viewW * 0.5, viewH * 0.45, 3.5, 200);
  requestAnimationFrame(frame);
})();
