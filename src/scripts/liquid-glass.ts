/** Nebula-style liquid glass for Astro.
 * Uses one shared WebGL2 context and copies each result into a panel-owned 2D canvas.
 * The material follows Nebula's rounded-box SDF -> height gradient -> refract pipeline.
 * Pointer trails are intentionally disabled, matching LiquidGlass.vue's default.
 */
const nestedSurfaces = '.device-card, .skill-glass-item, .skills-chart-glass, .learning';
const surfaces = `.card-base, .card-base-transparent, .float-panel, .dropdown-content, #navbar > div, ${nestedSurfaces}`;
const vertex = `
#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = position * .5 + .5;
  gl_Position = vec4(position, 0., 1.);
}
`;
const fragment = `
#version 300 es
precision highp float;
in vec2 uv;
out vec4 fragColor;
uniform sampler2D backdrop;
uniform vec2 viewport, imageSize, size, origin, slice;
uniform float radius, dark, screenTop;
uniform float ior, thickness, normalStrength, displacementScale;
uniform float transitionWidth, smoothing, highlightWidth;

float sminPolynomial(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float smaxPolynomial(float a, float b, float k) {
  return -sminPolynomial(-a, -b, k);
}

float roundedBoxSdf(vec2 p, vec2 halfSize, float corner, float smoothness) {
  vec2 q = abs(p) - halfSize + corner;
  float joined = smaxPolynomial(q.x, q.y, smoothness);
  float interior = sminPolynomial(joined, 0.0, smoothness * 0.5);
  vec2 exterior = vec2(
    smaxPolynomial(q.x, 0.0, smoothness),
    smaxPolynomial(q.y, 0.0, smoothness)
  );
  return interior + length(exterior) - corner;
}

float glassHeight(vec2 p, vec2 halfSize, float corner) {
  float distanceToEdge = roundedBoxSdf(p, halfSize, corner, smoothing);
  float normalizedDistance = distanceToEdge / transitionWidth;
  return clamp(1.0 - (1.0 / (1.0 + exp(-normalizedDistance * 6.0))), 0.0, 1.0);
}

vec2 cover(vec2 p) {
  vec2 rendered = imageSize * max(viewport.x / imageSize.x, viewport.y / imageSize.y);
  vec2 t = (p - viewport * .5) / rendered + .5;
  return clamp(vec2(t.x, 1. - t.y), .001, .999);
}

void main() {
  vec2 localPoint = vec2(uv.x, 1. - uv.y) * slice + vec2(0.0, origin.y);
  vec2 centeredPoint = localPoint - size * .5;
  vec2 halfSize = size * .5;
  float actualRadius = min(radius, min(size.x, size.y) * .5);
  float distanceToEdge = roundedBoxSdf(centeredPoint, halfSize, actualRadius, smoothing);

  float edgeWidth = max(fwidth(distanceToEdge), 1.0);
  float shapeAlpha = 1.0 - smoothstep(0.0, edgeWidth * 2.0, distanceToEdge - edgeWidth * 0.5);
  if (shapeAlpha <= 0.0) discard;

  float stepNear = .75;
  float stepFar = 1.5;
  float gradXNear = (glassHeight(centeredPoint + vec2(stepNear, 0.0), halfSize, actualRadius)
    - glassHeight(centeredPoint - vec2(stepNear, 0.0), halfSize, actualRadius)) / (2.0 * stepNear);
  float gradXFar = (glassHeight(centeredPoint + vec2(stepFar, 0.0), halfSize, actualRadius)
    - glassHeight(centeredPoint - vec2(stepFar, 0.0), halfSize, actualRadius)) / (2.0 * stepFar);
  float gradYNear = (glassHeight(centeredPoint + vec2(0.0, stepNear), halfSize, actualRadius)
    - glassHeight(centeredPoint - vec2(0.0, stepNear), halfSize, actualRadius)) / (2.0 * stepNear);
  float gradYFar = (glassHeight(centeredPoint + vec2(0.0, stepFar), halfSize, actualRadius)
    - glassHeight(centeredPoint - vec2(0.0, stepFar), halfSize, actualRadius)) / (2.0 * stepFar);

  vec3 surfaceNormal = normalize(vec3(
    -mix(gradXNear, gradXFar, .5) * normalStrength,
    -mix(gradYNear, gradYFar, .5) * normalStrength,
    1.0
  ));
  vec3 incident = vec3(0.0, 0.0, -1.0);
  vec3 intoGlass = refract(incident, surfaceNormal, 1.0 / ior);
  vec3 outOfGlass = refract(intoGlass, -surfaceNormal, ior);
  vec2 refractionOffset = outOfGlass.xy * thickness * displacementScale;

  vec2 base = vec2(localPoint.x + origin.x, (1. - uv.y) * slice.y + screenTop);
  vec4 backgroundColor = texture(backdrop, cover(base + refractionOffset));
  float heightValue = glassHeight(centeredPoint, halfSize, actualRadius);
  vec3 overlay = mix(vec3(.42, .50, .62), vec3(.20, .26, .32), dark);
  vec4 materialColor = mix(backgroundColor, vec4(overlay, 1.0), heightValue * .15);

  float highlight = 1.0 - smoothstep(0.0, highlightWidth, abs(distanceToEdge));
  float directional = (surfaceNormal.x * surfaceNormal.y + 1.0) * .5;
  vec4 shaded = mix(materialColor, vec4(1.0), highlight * directional);
  fragColor = vec4(shaded.rgb, shaded.a * shapeAlpha);
}
`;

type Panel = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; visible: boolean };

function startLiquidGlass() {
  const opaque = matchMedia('(prefers-reduced-transparency: reduce)');
  const gpu = document.createElement('canvas');
  gpu.dataset.liquidRenderer = '';
  gpu.hidden = true;
  document.body.append(gpu);
  const context = gpu.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!context) { gpu.remove(); return; }
  const gl: WebGL2RenderingContext = context;
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
    for (const name of [
      'backdrop', 'viewport', 'imageSize', 'size', 'origin', 'slice',
      'radius', 'dark', 'screenTop', 'ior', 'thickness', 'normalStrength',
      'displacementScale', 'transitionWidth', 'smoothing', 'highlightWidth',
    ]) {
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
  }, { rootMargin: '100px' });
  const resize = new ResizeObserver(() => requestDraw());
  function discover() {
    for (const [el, panel] of panels) {
      if (!el.isConnected) {
        intersection.unobserve(el); resize.unobserve(el); panel.canvas.remove(); panels.delete(el);
      }
    }
    document.querySelectorAll<HTMLElement>(surfaces).forEach(el => {
      if (panels.has(el)) return;
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
    gl.useProgram(program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(uniforms.get('backdrop')!, 0);
    two('viewport', innerWidth, innerHeight);
    two('imageSize', image.naturalWidth, image.naturalHeight);
    one('dark', dark ? 1 : 0);
    const mobile = innerWidth <= 768;
    one('ior', dark ? (mobile ? 1.16 : 1.2) : 1.1);
    one('thickness', dark ? (mobile ? 60 : 38) : (mobile ? 38 : 40));
    one('normalStrength', dark ? (mobile ? 8.5 : 6.5) : (mobile ? 7 : 8));
    one('displacementScale', dark ? (mobile ? .95 : .68) : 1);
    one('transitionWidth', dark ? 10 : (mobile ? 6 : 8));
    one('smoothing', mobile && !dark ? 15 : 20);
    one('highlightWidth', dark ? (mobile ? 5 : 4) : (mobile ? 3.5 : 3));
    let activePanels = 0;
    for (const [el, panel] of panels) {
      if (activePanels >= 6) break;
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
      one('screenTop', rect.top + top);
      one('radius', Math.min(parseFloat(style.borderTopLeftRadius) || 16, rect.width / 2, rect.height / 2));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (panel.canvas.width !== width) panel.canvas.width = width;
      if (panel.canvas.height !== physicalHeight) panel.canvas.height = physicalHeight;
      panel.canvas.style.top = `${top}px`;
      panel.canvas.style.height = `${height}px`;
      panel.context.clearRect(0, 0, width, physicalHeight);
      panel.context.drawImage(gpu, 0, 0);
      el.classList.add('liquid-ready');
      drawCount++;
      activePanels++;
    }
    gpu.dataset.drawCount = String(drawCount);
    gpu.dataset.activePanels = String(activePanels);
    if (now < movingUntil) requestDraw();
  }
  gpu.addEventListener('webglcontextlost', event => {
    event.preventDefault(); lost = true; ready = false;
    panels.forEach((_, el) => el.classList.remove('liquid-ready'));
  });
  gpu.addEventListener('webglcontextrestored', () => {
    try { initialize(); lost = false; backgroundUrl = ''; loadBackground(); }
    catch { lost = true; }
  });
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
  opaque.addEventListener('change', requestDraw);
  discover();
  movingUntil = performance.now() + 1800;
}

startLiquidGlass();
