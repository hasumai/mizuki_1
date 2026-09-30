/** Background-texture refraction, inspired by Nebula's shared-renderer architecture.
 * One WebGL context, viewport-sized copies, event-driven frames. DOM content stays native.
 * This is an independent renderer, not a copy of Nebula's Vue implementation.
 */
const surfaces = '.card-base, .card-base-transparent, .float-panel, .dropdown-content, #navbar > div:nth-child(2)';
const vertex = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;
const fragment = `
precision highp float;
varying vec2 uv;
uniform sampler2D backdrop;
uniform vec2 viewport, imageSize, size, origin, slice, pointer;
uniform float radius, dark, pulse, age, screenTop;
float shape(vec2 p) {
  vec2 q = abs(p - size * .5) - size * .5 + radius;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - radius;
}
vec2 cover(vec2 p) {
  vec2 rendered = imageSize * max(viewport.x / imageSize.x, viewport.y / imageSize.y);
  vec2 t = (p - viewport * .5) / rendered + .5;
  return clamp(vec2(t.x, 1. - t.y), .001, .999);
}
void main() {
  vec2 p = vec2(uv.x, 1. - uv.y) * slice + vec2(0., origin.y);
  float d = shape(p);
  float inside = max(-d, 0.);
  vec2 n = normalize(vec2(shape(p+vec2(.5,0.))-shape(p-vec2(.5,0.)),
                         shape(p+vec2(0.,.5))-shape(p-vec2(0.,.5))) + .0001);
  // Curved rim acts as a lens; interior stays flat for legibility.
  float rim = exp(-inside / 14.);
  vec2 offset = -n * sin(clamp(inside / 32., 0., 1.) * 3.14159) * 24. * rim;
  vec2 delta = p - pointer;
  float distanceToPointer = length(delta);
  float ripple = sin(distanceToPointer * .065 - age * 10.) * exp(-distanceToPointer / 150.) * pulse;
  offset += delta / max(distanceToPointer, 1.) * ripple * 8.;
  vec2 base = vec2(p.x + origin.x, (1. - uv.y) * slice.y + screenTop);
  vec3 color = texture2D(backdrop, cover(base + offset)).rgb;
  float split = rim * .75;
  color.r = texture2D(backdrop, cover(base + offset + n * split)).r;
  color.b = texture2D(backdrop, cover(base + offset - n * split)).b;
  float center = smoothstep(0., 22., inside);
  color = mix(color, mix(vec3(.98,.97,.99), vec3(.065,.065,.095), dark),
              mix(.40, .48, dark) + center * .23);
  vec2 light = normalize(pointer - size * .5 + vec2(-180., -240.));
  float specular = pow(max(dot(n, light), 0.), 2.);
  float edge = exp(-inside / 1.8) * (.25 + .65 * specular);
  color += vec3(edge * mix(.58,.38,dark) + rim * specular * .07);
  color += vec3(.03,.045,.06) * ripple;
  gl_FragColor = vec4(color, 1. - smoothstep(-.8,.6,d));
}
`;

type Panel = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; visible: boolean };

function startLiquidGlass() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const opaque = matchMedia('(prefers-reduced-transparency: reduce)');
  const gpu = document.createElement('canvas');
  gpu.dataset.liquidRenderer = '';
  gpu.hidden = true;
  document.body.append(gpu);
  const context = gpu.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!context) { gpu.remove(); return; }
  const gl: WebGLRenderingContext = context;
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  let program: WebGLProgram;
  let texture: WebGLTexture;
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  function initialize() {
    const shaders = [[gl!.VERTEX_SHADER, vertex], [gl!.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
      const shader = gl!.createShader(type as number)!;
      gl!.shaderSource(shader, source as string);
      gl!.compileShader(shader);
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(shader) || 'Glass shader failed');
      return shader;
    });
    program = gl!.createProgram()!;
    shaders.forEach(shader => gl!.attachShader(program, shader));
    gl!.linkProgram(program);
    shaders.forEach(shader => gl!.deleteShader(shader));
    if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) throw new Error('Glass program failed');
    gl!.useProgram(program);
    const buffer = gl!.createBuffer();
    gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl!.STATIC_DRAW);
    const position = gl!.getAttribLocation(program, 'position');
    gl!.enableVertexAttribArray(position);
    gl!.vertexAttribPointer(position, 2, gl!.FLOAT, false, 0, 0);
    uniforms.clear();
    for (const name of ['backdrop','viewport','imageSize','size','origin','slice','pointer','radius','dark','pulse','age','screenTop']) {
      uniforms.set(name, gl!.getUniformLocation(program, name));
    }
    texture = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
  }
  try { initialize(); } catch (error) { console.warn('[Liquid glass]', error); gpu.remove(); return; }
  const panels = new Map<HTMLElement, Panel>();
  let ready = false, lost = false, frame = 0, movingUntil = 0;
  let pointerX = -1000, pointerY = -1000, pointerAt = -10000;
  let image = new Image();
  let backgroundUrl = '';
  let drawCount = 0;
  const one = (name: string, value: number) => gl.uniform1f(uniforms.get(name)!, value);
  const two = (name: string, x: number, y: number) => gl.uniform2f(uniforms.get(name)!, x, y);
  function requestDraw() {
    if (!frame && !document.hidden && !lost) frame = requestAnimationFrame(draw);
  }
  function loadBackground() {
    // Match the fixed page backdrop, including fullscreen wallpaper selection.
    const full = document.querySelector<HTMLImageElement>('[data-fullscreen-wallpaper] img');
    const source = document.body.classList.contains('wallpaper-transparent') && full
      ? full.currentSrc || full.src : '/assets/desktop-banner/pote4.jpg';
    if (backgroundUrl === source) return;
    backgroundUrl = source;
    ready = false;
    panels.forEach((_, el) => el.classList.remove('liquid-ready'));
    const next = new Image();
    next.crossOrigin = 'anonymous';
    next.onload = () => {
      if (backgroundUrl !== source) return;
      image = next;
      try {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        ready = true;
        requestDraw();
      } catch { ready = false; }
    };
    next.src = source;
  }
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const panel = panels.get(entry.target as HTMLElement);
      if (panel) panel.visible = entry.isIntersecting;
    }
    requestDraw();
  });
  const resize = new ResizeObserver(() => requestDraw());
  function discover() {
    for (const [el, panel] of panels) {
      if (!el.isConnected) {
        intersection.unobserve(el); resize.unobserve(el); panel.canvas.remove(); panels.delete(el);
      }
    }
    document.querySelectorAll<HTMLElement>(surfaces).forEach(el => {
      if (panels.has(el) || el.parentElement?.closest('.card-base, .card-base-transparent')) return;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.className = 'liquid-glass-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      if (getComputedStyle(el).position === 'static') el.classList.add('liquid-positioned');
      el.classList.add('liquid-panel');
      el.prepend(canvas);
      panels.set(el, { canvas, context, visible: true });
      intersection.observe(el); resize.observe(el);
    });
    loadBackground(); requestDraw();
  }
  function draw(now: number) {
    frame = 0;
    if (document.hidden || lost || !ready) return;
    const enabled = !opaque.matches && (document.body.classList.contains('enable-banner') || document.body.classList.contains('wallpaper-transparent'));
    if (!enabled) { panels.forEach((_, el) => el.classList.remove('liquid-ready')); return; }
    const dark = document.documentElement.classList.contains('dark');
    const scale = Math.min(devicePixelRatio, innerWidth < 768 ? 1 : 1.25);
    const age = (now - pointerAt) / 1000;
    const pulse = reduced.matches ? 0 : Math.max(0, 1 - age / .9);
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniforms.get('backdrop')!, 0);
    two('viewport', innerWidth, innerHeight);
    two('imageSize', image.naturalWidth, image.naturalHeight);
    one('dark', dark ? 1 : 0);
    one('age', age);
    for (const [el, panel] of panels) {
      if (!el.isConnected || !panel.visible) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.right < 0 || rect.left > innerWidth || rect.bottom < 0 || rect.top > innerHeight) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const top = Math.max(0, -rect.top);
      const height = Math.min(rect.height, innerHeight - rect.top) - top;
      if (height <= 0) continue;
      const width = Math.ceil(rect.width * scale), physicalHeight = Math.ceil(height * scale);
      if (width > maxSize || physicalHeight > maxSize) continue;
      if (gpu.width !== width) gpu.width = width;
      if (gpu.height !== physicalHeight) gpu.height = physicalHeight;
      gl.viewport(0, 0, width, physicalHeight);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      two('size', rect.width, rect.height);
      two('origin', rect.left, top);
      two('slice', rect.width, height);
      two('pointer', pointerX - rect.left, pointerY - rect.top);
      one('screenTop', rect.top + top);
      one('radius', Math.min(parseFloat(style.borderTopLeftRadius) || 16, rect.width / 2, rect.height / 2));
      one('pulse', pulse);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (panel.canvas.width !== width) panel.canvas.width = width;
      if (panel.canvas.height !== physicalHeight) panel.canvas.height = physicalHeight;
      panel.canvas.style.top = `${top}px`;
      panel.canvas.style.height = `${height}px`;
      panel.context.clearRect(0, 0, width, physicalHeight);
      panel.context.drawImage(gpu, 0, 0);
      el.classList.add('liquid-ready');
      drawCount++;
    }
    gpu.dataset.drawCount = String(drawCount);
    if (pulse > 0 || now < movingUntil) requestDraw();
  }
  gpu.addEventListener('webglcontextlost', event => {
    event.preventDefault(); lost = true; ready = false;
    panels.forEach((_, el) => el.classList.remove('liquid-ready'));
  });
  gpu.addEventListener('webglcontextrestored', () => {
    try { initialize(); lost = false; backgroundUrl = ''; loadBackground(); }
    catch { lost = true; }
  });
  window.addEventListener('pointermove', event => {
    if (reduced.matches || event.pointerType === 'touch') return;
    pointerX = event.clientX; pointerY = event.clientY; pointerAt = performance.now(); requestDraw();
  }, { passive: true });
  window.addEventListener('scroll', requestDraw, { passive: true, capture: true });
  window.addEventListener('resize', requestDraw, { passive: true });
  document.addEventListener('visibilitychange', requestDraw);
  for (const type of ['transitionrun', 'animationstart']) document.addEventListener(type, () => {
    movingUntil = performance.now() + 1200; requestDraw();
  }, true);
  for (const type of ['transitionend', 'animationend']) document.addEventListener(type, requestDraw, true);
  const tree = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement && !node.matches('.liquid-glass-canvas')))) discover();
  });
  tree.observe(document.body, { childList: true, subtree: true });
  const theme = new MutationObserver(() => { loadBackground(); requestDraw(); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  theme.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  reduced.addEventListener('change', requestDraw);
  opaque.addEventListener('change', requestDraw);
  discover();
  movingUntil = performance.now() + 1800;
}

startLiquidGlass();
