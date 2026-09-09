(() => {
  "use strict";

  const canvas = document.getElementById("pond");
  if (!canvas) return;

  const hint = document.querySelector("[data-hint]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const isBackground = canvas.dataset.pondMode === "background";
  const MAX_SPLATS = 16;
  const settings = isBackground
    ? {
        presence: 0.7,
        pointerForce: 0.48,
        pointerInk: 0.5,
        burst: 0.42,
        seed: 0.18,
        ambient: 0.022,
        ripple: 0.55,
      }
    : {
        presence: 1,
        pointerForce: 0.78,
        pointerInk: 0.8,
        burst: 0.68,
        seed: 0.3,
        ambient: 0.04,
        ripple: 1,
      };

  let viewW = window.innerWidth;
  let viewH = window.innerHeight;
  let qualityCap = navigator.deviceMemory && navigator.deviceMemory <= 4 ? 800 : 1150;
  let renderer = null;
  let resizeFrame = 0;

  const pointer = {
    active: false,
    id: null,
    lastX: null,
    lastY: null,
    lastTime: 0,
  };
  const splats = [];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || "Unable to compile pond shader.");
    }
    return shader;
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const program = gl.createProgram();
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(message || "Unable to link pond shader.");
    }
    return program;
  }

  function createFluidRenderer(target) {
    const gl = target.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    if (!gl) return null;

    const vertexSource = `
      attribute vec2 aPosition;
      varying vec2 vUv;

      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    const updateSource = `
      precision mediump float;

      varying vec2 vUv;
      uniform sampler2D uState;
      uniform vec2 uTexel;
      uniform float uAspect;
      uniform float uTime;
      uniform float uDt;
      uniform vec4 uSplats[${MAX_SPLATS}];
      uniform float uStrengths[${MAX_SPLATS}];
      uniform float uInks[${MAX_SPLATS}];

      const float MAX_VELOCITY = 0.16;

      vec2 ambientFlow(vec2 p, float t) {
        vec2 first = vec2(
          3.4 * sin(p.x * 2.8 + t) * cos(p.y * 3.4 - t * 0.72),
          -2.8 * cos(p.x * 2.8 + t) * sin(p.y * 3.4 - t * 0.72)
        );
        vec2 second = vec2(
          -2.1 * sin(p.x * 3.9 - t * 0.6) * cos(p.y * 2.1 + t),
          3.9 * cos(p.x * 3.9 - t * 0.6) * sin(p.y * 2.1 + t)
        );
        return (first + second * 0.42) * 0.0017;
      }

      void main() {
        vec4 center = texture2D(uState, vUv);
        vec2 localVelocity = (center.gb - 0.5) * (2.0 * MAX_VELOCITY);
        vec2 domain = (vUv - 0.5) * vec2(uAspect, 1.0);
        vec2 sourceUv = clamp(
          vUv - (localVelocity + ambientFlow(domain, uTime * 0.12)) * uDt,
          uTexel,
          vec2(1.0) - uTexel
        );

        vec4 state = texture2D(uState, sourceUv);
        float density = state.r;
        vec2 velocity = (state.gb - 0.5) * (2.0 * MAX_VELOCITY);
        float neighborhood = (
          texture2D(uState, sourceUv + vec2(uTexel.x, 0.0)).r +
          texture2D(uState, sourceUv - vec2(uTexel.x, 0.0)).r +
          texture2D(uState, sourceUv + vec2(0.0, uTexel.y)).r +
          texture2D(uState, sourceUv - vec2(0.0, uTexel.y)).r
        ) * 0.25;
        density = mix(density, neighborhood, 0.15);

        for (int i = 0; i < ${MAX_SPLATS}; i++) {
          vec4 splat = uSplats[i];
          float strength = uStrengths[i];
          float ink = uInks[i];
          vec2 delta = vUv - splat.xy;
          delta.x *= uAspect;
          float plume = exp(-dot(delta, delta) * 1500.0);
          float reach = exp(-dot(delta, delta) * 300.0);
          density += plume * ink * 0.28;
          velocity += splat.zw * reach * strength * 0.052;
          velocity += vec2(-delta.y / uAspect, delta.x) * reach * strength * 0.075;
        }

        // Trails melt away continuously and are exactly zero by ~20 s:
        // exponential falloff (0.9952^60 ≈ 0.75 per second) for the smooth
        // visible fade, plus a tiny linear drain that cuts the asymptotic
        // tail so no faint residue can survive past second 20.
        float decay = pow(0.9952, uDt * 60.0);
        density = max(density * decay - 0.0001 * uDt * 60.0, 0.0);
        velocity *= pow(0.958, uDt * 60.0);
        velocity = clamp(velocity, vec2(-MAX_VELOCITY), vec2(MAX_VELOCITY));

        gl_FragColor = vec4(
          clamp(density, 0.0, 1.0),
          velocity / (2.0 * MAX_VELOCITY) + 0.5,
          1.0
        );
      }
    `;

    const displaySource = `
      precision mediump float;

      varying vec2 vUv;
      uniform sampler2D uState;
      uniform vec2 uTexel;
      uniform float uPresence;

      float sampleDensity(vec2 uv) {
        return texture2D(uState, uv).r;
      }

      void main() {
        const vec3 background = vec3(0.0667, 0.1098, 0.0941);
        const vec3 deepJade = vec3(0.1373, 0.2157, 0.1686);
        const vec3 jade = vec3(0.3137, 0.5804, 0.4588);
        const vec3 mint = vec3(0.6745, 0.8314, 0.8118);

        // Two-scale gaussian-style blur so settled trails melt into
        // soft ribbons instead of showing the simulation grid.
        vec2 t = uTexel;
        float center = sampleDensity(vUv);
        float axisNear = (
          sampleDensity(vUv + vec2(t.x, 0.0)) +
          sampleDensity(vUv - vec2(t.x, 0.0)) +
          sampleDensity(vUv + vec2(0.0, t.y)) +
          sampleDensity(vUv - vec2(0.0, t.y))
        ) * 0.25;
        float diagNear = (
          sampleDensity(vUv + t) +
          sampleDensity(vUv - t) +
          sampleDensity(vUv + vec2(-t.x, t.y)) +
          sampleDensity(vUv + vec2(t.x, -t.y))
        ) * 0.25;
        float axisFar = (
          sampleDensity(vUv + vec2(t.x * 2.2, 0.0)) +
          sampleDensity(vUv - vec2(t.x * 2.2, 0.0)) +
          sampleDensity(vUv + vec2(0.0, t.y * 2.2)) +
          sampleDensity(vUv - vec2(0.0, t.y * 2.2))
        ) * 0.25;
        float axisWide = (
          sampleDensity(vUv + vec2(t.x * 4.0, 0.0)) +
          sampleDensity(vUv - vec2(t.x * 4.0, 0.0)) +
          sampleDensity(vUv + vec2(0.0, t.y * 4.0)) +
          sampleDensity(vUv - vec2(0.0, t.y * 4.0))
        ) * 0.25;

        float soft = center * 0.2 + axisNear * 0.42 + diagNear * 0.24 + axisFar * 0.14;
        float wide = axisWide * 0.6 + axisFar * 0.4;

        // Round S-curve shaping: no hard thresholds, no crisp grid edges.
        float body = smoothstep(0.02, 0.85, soft * 1.5);
        float core = smoothstep(0.15, 0.95, soft * 1.5);
        float sheen = smoothstep(0.0, 0.55, clamp((soft - wide) * 2.2, 0.0, 1.0));

        vec3 color = mix(background, deepJade, body * 0.9 * uPresence);
        color = mix(color, jade, core * 0.55 * uPresence);
        color = mix(color, mint, sheen * 0.35 * uPresence);

        float vignette = smoothstep(0.92, 0.28, distance(vUv, vec2(0.5)));
        color = mix(background, color, 0.82 + vignette * 0.18);
        gl_FragColor = vec4(color, 1.0);
      }
    `;

    let updateProgram;
    let displayProgram;
    try {
      updateProgram = createProgram(gl, vertexSource, updateSource);
      displayProgram = createProgram(gl, vertexSource, displaySource);
    } catch (error) {
      console.warn("The GPU pond could not start.", error);
      return null;
    }

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const updateUniforms = {
      state: gl.getUniformLocation(updateProgram, "uState"),
      texel: gl.getUniformLocation(updateProgram, "uTexel"),
      aspect: gl.getUniformLocation(updateProgram, "uAspect"),
      time: gl.getUniformLocation(updateProgram, "uTime"),
      dt: gl.getUniformLocation(updateProgram, "uDt"),
      splats: gl.getUniformLocation(updateProgram, "uSplats[0]"),
      strengths: gl.getUniformLocation(updateProgram, "uStrengths[0]"),
      inks: gl.getUniformLocation(updateProgram, "uInks[0]"),
    };
    const displayUniforms = {
      state: gl.getUniformLocation(displayProgram, "uState"),
      texel: gl.getUniformLocation(displayProgram, "uTexel"),
      presence: gl.getUniformLocation(displayProgram, "uPresence"),
    };
    const splatData = new Float32Array(MAX_SPLATS * 4);
    const strengthData = new Float32Array(MAX_SPLATS);
    const inkData = new Float32Array(MAX_SPLATS);

    let width = 2;
    let height = 2;
    let targets = [];
    let current = 0;

    function bindQuad(program) {
      const position = gl.getAttribLocation(program, "aPosition");
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    }

    function createTarget() {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );

      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Unable to create a framebuffer for the pond.");
      }
      gl.clearColor(0, 0.5, 0.5, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { texture, framebuffer };
    }

    function resize(cssWidth, cssHeight, cap) {
      const scale = Math.min(1, cap / Math.max(cssWidth, cssHeight));
      width = Math.max(2, Math.round(cssWidth * scale));
      height = Math.max(2, Math.round(cssHeight * scale));
      target.width = width;
      target.height = height;

      for (const item of targets) {
        gl.deleteFramebuffer(item.framebuffer);
        gl.deleteTexture(item.texture);
      }
      targets = [createTarget(), createTarget()];
      current = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.0667, 0.1098, 0.0941, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    function render(frameSplats, dt, time) {
      if (!targets.length || gl.isContextLost()) return;

      splatData.fill(0);
      strengthData.fill(0);
      inkData.fill(0);
      frameSplats.forEach((splat, index) => {
        const offset = index * 4;
        splatData[offset] = splat.x;
        splatData[offset + 1] = splat.y;
        splatData[offset + 2] = splat.vx;
        splatData[offset + 3] = splat.vy;
        strengthData[index] = splat.strength;
        inkData[index] = splat.ink;
      });

      const next = 1 - current;
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[next].framebuffer);
      gl.useProgram(updateProgram);
      bindQuad(updateProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[current].texture);
      gl.uniform1i(updateUniforms.state, 0);
      gl.uniform2f(updateUniforms.texel, 1 / width, 1 / height);
      gl.uniform1f(updateUniforms.aspect, viewW / viewH);
      gl.uniform1f(updateUniforms.time, time);
      gl.uniform1f(updateUniforms.dt, dt);
      gl.uniform4fv(updateUniforms.splats, splatData);
      gl.uniform1fv(updateUniforms.strengths, strengthData);
      gl.uniform1fv(updateUniforms.inks, inkData);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      current = next;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(displayProgram);
      bindQuad(displayProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[current].texture);
      gl.uniform1i(displayUniforms.state, 0);
      gl.uniform2f(displayUniforms.texel, 1 / width, 1 / height);
      gl.uniform1f(displayUniforms.presence, settings.presence);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    return { isGpu: true, render, resize };
  }

  function createFallbackRenderer(target) {
    const ctx = target.getContext("2d");
    if (!ctx) return null;

    const particles = [];
    let dpr = 1;

    function resize(width, height) {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      target.width = Math.round(width * dpr);
      target.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#111c18";
      ctx.fillRect(0, 0, width, height);
      particles.length = 0;
    }

    function render(frameSplats, dt, time) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "rgba(17, 28, 24, 0.065)";
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.lineCap = "round";

      for (const splat of frameSplats) {
        if (splat.ink <= 0.001) continue;
        particles.push({
          x: splat.x * viewW,
          y: (1 - splat.y) * viewH,
          vx: splat.vx * viewW * 0.16,
          vy: -splat.vy * viewH * 0.16,
          life: 1,
          ink: splat.ink,
          width: 3 + splat.ink * 7,
        });
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const particle = particles[i];
        const oldX = particle.x;
        const oldY = particle.y;
        particle.vx += Math.sin(particle.y * 0.012 + time * 0.7) * 3 * dt;
        particle.vy += Math.cos(particle.x * 0.011 - time * 0.6) * 3 * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.vx *= 0.985;
        particle.vy *= 0.985;
        particle.life -= dt * 0.13;

        const alpha = Math.max(0, particle.life) * particle.ink * settings.presence * 0.48;
        ctx.strokeStyle = `rgba(80, 148, 117, ${alpha})`;
        ctx.lineWidth = particle.width * Math.max(0.3, particle.life);
        ctx.shadowColor = "rgba(140, 211, 203, 0.2)";
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.moveTo(oldX, oldY);
        ctx.lineTo(particle.x, particle.y);
        ctx.stroke();

        if (particle.life <= 0) particles.splice(i, 1);
      }
      if (particles.length > 240) particles.splice(0, particles.length - 240);
      ctx.restore();
    }

    return { isGpu: false, render, resize };
  }

  function queueSplat(x, y, vx, vy, strength, ink) {
    splats.push({
      x: clamp(x, 0.001, 0.999),
      y: clamp(y, 0.001, 0.999),
      vx: clamp(vx, -0.8, 0.8),
      vy: clamp(vy, -0.8, 0.8),
      strength,
      ink,
    });
    if (splats.length > 80) splats.splice(0, splats.length - 80);
  }

  function queueBurst(x, y, amount = 1) {
    const radius = 6 / Math.max(viewW, viewH);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      queueSplat(
        x + Math.cos(angle) * radius,
        y + Math.sin(angle) * radius,
        Math.cos(angle) * 0.12,
        Math.sin(angle) * 0.12,
        settings.burst * amount,
        settings.pointerInk * amount * 0.055,
      );
    }
  }

  function seedCurrent(amount = 1) {
    // A single soft breath at load: no dotted rows, just a faint presence
    // so the first paint has something to blend with.
    queueSplat(0.5, 0.55, 0.008, 0.004, settings.seed * amount, settings.seed * amount * 0.4);
  }

  const ripples = [];

  function spawnRipple(x, y) {
    // A stone in the pond: an expanding ring wave fed into the fluid
    // over ~1.5 s so it drifts with the current and fades softly.
    ripples.push({
      x: clamp(x, 0.001, 0.999),
      y: clamp(y, 0.001, 0.999),
      start: performance.now() / 1000,
      phase: Math.random() * Math.PI * 2,
    });
    if (ripples.length > 4) ripples.shift();
  }

  function updateRipples(now) {
    const RIPPLE_DURATION = 1.5;
    const MAX_RADIUS = 0.17;
    const POINTS = 16;
    const aspect = viewW / Math.max(viewH, 1);
    for (let i = ripples.length - 1; i >= 0; i--) {
      const ripple = ripples[i];
      const progress = (now - ripple.start) / RIPPLE_DURATION;
      if (progress >= 1) {
        ripples.splice(i, 1);
        continue;
      }
      const eased = 1 - (1 - progress) * (1 - progress);
      const radius = 0.012 + eased * MAX_RADIUS;
      const envelope = Math.sin(progress * Math.PI);
      // Rotating phase: consecutive frames fill each other's gaps, so the
      // 16 dots accumulate into one closed, round wave instead of spokes.
      const basePhase = ripple.phase;
      for (let k = 0; k < POINTS; k++) {
        const angle = basePhase + (k / POINTS) * Math.PI * 2;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        queueSplat(
          ripple.x + (ca * radius) / aspect,
          ripple.y + sa * radius,
          (ca * 0.02) / aspect,
          sa * 0.02,
          settings.ripple * envelope * 0.05,
          settings.ripple * envelope * 0.13,
        );
      }
      ripple.phase += Math.PI / POINTS;
    }
  }

  function hideHint() {
    if (hint) hint.classList.add("is-hidden");
  }

  function addPointerTrail(x, y, time, pressure = 0.7) {
    if (pointer.lastX === null || pointer.lastY === null) {
      queueSplat(
        x / viewW,
        1 - y / viewH,
        0,
        0,
        pressure * settings.pointerForce,
        pressure * settings.pointerInk,
      );
    } else {
      const dx = x - pointer.lastX;
      const dy = y - pointer.lastY;
      const elapsed = Math.max(8, time - pointer.lastTime) / 1000;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.min(12, Math.ceil(distance / 9)));
      const vx = (dx / viewW) / elapsed;
      const vy = (-dy / viewH) / elapsed;
      const speedFactor = clamp(0.55 + distance / elapsed / 2200, 0.55, 1);

      for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        queueSplat(
          (pointer.lastX + dx * progress) / viewW,
          1 - (pointer.lastY + dy * progress) / viewH,
          vx,
          vy,
          pressure * settings.pointerForce * speedFactor,
          pressure * settings.pointerInk * speedFactor,
        );
      }
    }
    pointer.lastX = x;
    pointer.lastY = y;
    pointer.lastTime = time;
  }

  function resize() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    if (renderer) renderer.resize(viewW, viewH, qualityCap);
  }

  if (reduceMotion.matches) {
    canvas.width = 1;
    canvas.height = 1;
    if (hint) hint.hidden = true;
    return;
  }

  renderer = createFluidRenderer(canvas) || createFallbackRenderer(canvas);
  resize();
  seedCurrent();

  canvas.addEventListener("pointerdown", (event) => {
    if (pointer.id !== null && pointer.id !== event.pointerId) return;
    pointer.active = true;
    pointer.id = event.pointerId;
    pointer.lastX = null;
    pointer.lastY = null;
    canvas.setPointerCapture?.(event.pointerId);
    addPointerTrail(event.clientX, event.clientY, event.timeStamp, 0.9);
    queueBurst(event.clientX / viewW, 1 - event.clientY / viewH, 0.75);
    spawnRipple(event.clientX / viewW, 1 - event.clientY / viewH);
    hideHint();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" && !pointer.active) return;
    if (pointer.id !== null && pointer.id !== event.pointerId) return;
    const pressure = event.pressure > 0 ? 0.5 + event.pressure * 0.45 : 0.68;
    addPointerTrail(event.clientX, event.clientY, event.timeStamp, pressure);
  });

  function releasePointer(event) {
    if (pointer.id !== event.pointerId) return;
    pointer.active = false;
    pointer.id = null;
    pointer.lastX = null;
    pointer.lastY = null;
  }

  canvas.addEventListener("pointerup", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);
  canvas.addEventListener("pointerleave", () => {
    if (pointer.active) return;
    pointer.lastX = null;
    pointer.lastY = null;
  });

  window.addEventListener("resize", () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      resize();
      seedCurrent(0.7);
    });
  });

  let running = true;
  let animationFrame = 0;
  let last = performance.now();
  let nextAmbient = last / 1000 + 3.5;
  let measuredFrames = 0;
  let measuredTime = 0;
  let qualityAdjusted = false;

  function scheduleFrame() {
    if (!animationFrame) animationFrame = requestAnimationFrame(frame);
  }

  function frame(now) {
    animationFrame = 0;
    if (!running || !renderer) return;

    const dt = Math.min(Math.max((now - last) / 1000, 0.001), 0.034);
    last = now;
    const time = now / 1000;

    if (time >= nextAmbient) {
      const angle = -0.5 + Math.random();
      queueSplat(
        0.18 + Math.random() * 0.64,
        0.2 + Math.random() * 0.6,
        Math.cos(angle) * 0.015,
        Math.sin(angle) * 0.015,
        settings.ambient,
        settings.ambient,
      );
      nextAmbient = time + 4 + Math.random() * 3;
    }

    updateRipples(time);
    renderer.render(splats.splice(0, MAX_SPLATS), dt, time);

    if (renderer.isGpu && !qualityAdjusted) {
      measuredFrames++;
      measuredTime += dt;
      if (measuredFrames === 150) {
        qualityAdjusted = true;
        if (measuredTime / measuredFrames > 1 / 42 && qualityCap > 640) {
          qualityCap = Math.max(640, Math.round(qualityCap * 0.72));
          renderer.resize(viewW, viewH, qualityCap);
          seedCurrent(0.8);
        }
      }
    }

    scheduleFrame();
  }

  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) {
      last = performance.now();
      scheduleFrame();
    }
  });

  scheduleFrame();
})();
