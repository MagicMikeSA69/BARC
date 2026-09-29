/* Broodline — cursor‑reactive egg‑liquid layer.
   A compact GPU fluid simulation (stable fluids: advect → vorticity → project)
   drives a density field rendered as the inside of an egg: a translucent, glossy
   albumen envelope around a golden yolk core. It follows the cursor, sags a
   little under gravity, and clears within a few seconds. Falls back to nothing
   when WebGL is unavailable or the viewer prefers reduced motion. */
(function () {
  "use strict";
  if (!window.matchMedia) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var coarse = matchMedia("(pointer: coarse)").matches;
  var config = {
    SIM_RES: coarse ? 96 : 144,
    DYE_RES: coarse ? 512 : 1024,
    DENSITY_DISSIPATION: 0.95, /* behind the content it can pool a little longer before it is absorbed */
    VELOCITY_DISSIPATION: 2.4, /* thick: motion dies quickly */
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 14,
    CURL: 3,                   /* little swirl; albumen doesn't billow like smoke */
    GRAVITY: 55,               /* dense yolk sags */
    SPLAT_RADIUS: 0.3,
    SPLAT_FORCE: 2400,
    AMOUNT: 0.3,               /* density added per cursor splat */
    DENSITY_CAP: 1.4,
    IDLE_MS: 6000
  };
  /* Look per theme: albumen is a clear film, yolk a golden core. */
  var THEME = {
    light: { albumen: [1.0, 0.985, 0.95], albAlpha: 0.7, yolk: [0.96, 0.66, 0.11], yolkAlpha: 0.92 },
    dark:  { albumen: [1.0, 0.96, 0.9],   albAlpha: 0.5, yolk: [0.8, 0.5, 0.09],   yolkAlpha: 0.78 }
  };
  var look = THEME.light;

  var canvas = document.createElement("canvas");
  canvas.className = "fluid-layer";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);

  var ctx = getWebGLContext(canvas);
  if (!ctx) { canvas.remove(); return; }
  var gl = ctx.gl, ext = ctx.ext;

  /* ---------- context ---------- */
  function getWebGLContext(canvas) {
    var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: true };
    var gl = canvas.getContext("webgl2", params);
    var isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext("webgl", params) || canvas.getContext("experimental-webgl", params);
    if (!gl) return null;
    var halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension("EXT_color_buffer_float");
      supportLinearFiltering = true; /* half‑float linear filtering is core in WebGL2 */
    } else {
      halfFloat = gl.getExtension("OES_texture_half_float");
      supportLinearFiltering = !!gl.getExtension("OES_texture_half_float_linear");
      if (!halfFloat) return null;
    }
    gl.clearColor(0, 0, 0, 0);
    var halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    var formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = formatRGBA;
      formatR = formatRGBA;
    }
    if (!formatRGBA || !formatRG || !formatR) return null;
    return { gl: gl, ext: { formatRGBA: formatRGBA, formatRG: formatRG, formatR: formatR, halfFloatTexType: halfFloatTexType, supportLinearFiltering: supportLinearFiltering } };
  }
  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F: return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F: return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default: return null;
      }
    }
    return { internalFormat: internalFormat, format: format };
  }
  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return ok;
  }

  /* ---------- shaders ---------- */
  function compile(type, source, keywords) {
    if (keywords) source = keywords.map(function (k) { return "#define " + k + "\n"; }).join("") + source;
    var s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); }
    return s;
  }
  function Program(vs, fs) {
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) console.warn(gl.getProgramInfoLog(this.program));
    this.uniforms = {};
    var n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var name = gl.getActiveUniform(this.program, i).name;
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }
  Program.prototype.bind = function () { gl.useProgram(this.program); };

  var baseVertex = compile(gl.VERTEX_SHADER, [
    "precision highp float;",
    "attribute vec2 aPosition;",
    "varying vec2 vUv, vL, vR, vT, vB;",
    "uniform vec2 texelSize;",
    "void main () {",
    "  vUv = aPosition * 0.5 + 0.5;",
    "  vL = vUv - vec2(texelSize.x, 0.0);",
    "  vR = vUv + vec2(texelSize.x, 0.0);",
    "  vT = vUv + vec2(0.0, texelSize.y);",
    "  vB = vUv - vec2(0.0, texelSize.y);",
    "  gl_Position = vec4(aPosition, 0.0, 1.0);",
    "}"].join("\n"));

  var clearShader = compile(gl.FRAGMENT_SHADER, [
    "precision mediump float; precision mediump sampler2D;",
    "varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value;",
    "void main () { gl_FragColor = value * texture2D(uTexture, vUv); }"].join("\n"));

  /* Density → egg liquid. Albumen is a translucent film that darkens where its
     surface tilts away (a meniscus) and catches a highlight; the yolk is a dense
     golden core with a soft membrane ring. Output is premultiplied. */
  var displayShader = compile(gl.FRAGMENT_SHADER, [
    "precision highp float; precision highp sampler2D;",
    "varying vec2 vUv, vL, vR, vT, vB;",
    "uniform sampler2D uTexture; uniform float uBump;",
    "uniform vec3 uYolk; uniform vec3 uAlbumen; uniform float uYolkAlpha; uniform float uAlbAlpha;",
    "void main () {",
    "  float C = texture2D(uTexture, vUv).r;",
    "  float L = texture2D(uTexture, vL).r; float R = texture2D(uTexture, vR).r;",
    "  float T = texture2D(uTexture, vT).r; float B = texture2D(uTexture, vB).r;",
    "  float d = (4.0 * C + L + R + T + B) / 8.0;",
    "  vec3 n = normalize(vec3(-(R - L) * uBump, -(T - B) * uBump, 1.0));",
    "  vec3 Ld = normalize(vec3(-0.45, 0.6, 0.66));",
    "  float lambert = max(dot(n, Ld), 0.0);",
    "  float spec = pow(max(dot(reflect(-Ld, n), vec3(0.0, 0.0, 1.0)), 0.0), 64.0);",
    "  float fres = pow(1.0 - n.z, 0.75);",
    "  float alb = smoothstep(0.05, 0.22, d);",
    "  float yolk = smoothstep(0.42, 0.74, d);",
    "  float ring = smoothstep(0.36, 0.5, d) * (1.0 - smoothstep(0.5, 0.72, d));",
    "  float aA = alb * uAlbAlpha * (0.14 + 0.86 * fres);",
    "  vec3 cA = uAlbumen * (0.68 + 0.32 * lambert) * aA;",
    "  float aY = yolk * uYolkAlpha;",
    "  vec3 cY = uYolk * (0.8 + 0.2 * lambert) * (1.0 - 0.22 * ring) * aY;",
    "  vec3 col = cY + cA * (1.0 - aY);",
    "  float a = aY + aA * (1.0 - aY);",
    "  float hi = spec * 0.9 * max(alb, yolk);",
    "  col += hi; a = min(a + hi, 1.0);",
    "  col = min(col, vec3(a));",
    "  gl_FragColor = vec4(col, a);",
    "}"].join("\n"));

  var splatShader = compile(gl.FRAGMENT_SHADER, [
    "precision highp float; precision highp sampler2D;",
    "varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius; uniform float cap;",
    "void main () {",
    "  vec2 p = vUv - point.xy; p.x *= aspectRatio;",
    "  vec3 splat = exp(-dot(p, p) / radius) * color;",
    "  vec3 base = texture2D(uTarget, vUv).xyz;",
    "  gl_FragColor = vec4(min(base + splat, vec3(cap)), 1.0);",
    "}"].join("\n"));

  var advectionSource = [
    "precision highp float; precision highp sampler2D;",
    "varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;",
    "uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;",
    "vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {",
    "  vec2 st = uv / tsize - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);",
    "  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize); vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);",
    "  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize); vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);",
    "  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);",
    "}",
    "void main () {",
    "#ifdef MANUAL_FILTERING",
    "  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;",
    "  vec4 result = bilerp(uSource, coord, dyeTexelSize);",
    "#else",
    "  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;",
    "  vec4 result = texture2D(uSource, coord);",
    "#endif",
    "  float decay = 1.0 + dissipation * dt;",
    "  gl_FragColor = result / decay;",
    "}"].join("\n");
  var advectionShader = compile(gl.FRAGMENT_SHADER, advectionSource, ext.supportLinearFiltering ? null : ["MANUAL_FILTERING"]);

  var divergenceShader = compile(gl.FRAGMENT_SHADER, [
    "precision mediump float; precision mediump sampler2D;",
    "varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;",
    "void main () {",
    "  float L = texture2D(uVelocity, vL).x; float R = texture2D(uVelocity, vR).x;",
    "  float T = texture2D(uVelocity, vT).y; float B = texture2D(uVelocity, vB).y;",
    "  vec2 C = texture2D(uVelocity, vUv).xy;",
    "  if (vL.x < 0.0) { L = -C.x; } if (vR.x > 1.0) { R = -C.x; }",
    "  if (vT.y > 1.0) { T = -C.y; } if (vB.y < 0.0) { B = -C.y; }",
    "  float div = 0.5 * (R - L + T - B);",
    "  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);",
    "}"].join("\n"));

  var curlShader = compile(gl.FRAGMENT_SHADER, [
    "precision mediump float; precision mediump sampler2D;",
    "varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity;",
    "void main () {",
    "  float L = texture2D(uVelocity, vL).y; float R = texture2D(uVelocity, vR).y;",
    "  float T = texture2D(uVelocity, vT).x; float B = texture2D(uVelocity, vB).x;",
    "  float vorticity = R - L - T + B;",
    "  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);",
    "}"].join("\n"));

  var vorticityShader = compile(gl.FRAGMENT_SHADER, [
    "precision highp float; precision highp sampler2D;",
    "varying vec2 vUv, vL, vR, vT, vB; uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;",
    "void main () {",
    "  float L = texture2D(uCurl, vL).x; float R = texture2D(uCurl, vR).x;",
    "  float T = texture2D(uCurl, vT).x; float B = texture2D(uCurl, vB).x;",
    "  float C = texture2D(uCurl, vUv).x;",
    "  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));",
    "  force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;",
    "  vec2 velocity = texture2D(uVelocity, vUv).xy;",
    "  velocity += force * dt; velocity = min(max(velocity, -1000.0), 1000.0);",
    "  gl_FragColor = vec4(velocity, 0.0, 1.0);",
    "}"].join("\n"));

  /* Dense liquid sags: downward force proportional to density. */
  var gravityShader = compile(gl.FRAGMENT_SHADER, [
    "precision mediump float; precision mediump sampler2D;",
    "varying highp vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uDensity; uniform float gravity; uniform float dt;",
    "void main () {",
    "  vec2 v = texture2D(uVelocity, vUv).xy;",
    "  float d = texture2D(uDensity, vUv).r;",
    "  v.y -= gravity * d * dt;",
    "  gl_FragColor = vec4(v, 0.0, 1.0);",
    "}"].join("\n"));

  var pressureShader = compile(gl.FRAGMENT_SHADER, [
    "precision mediump float; precision mediump sampler2D;",
    "varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure; uniform sampler2D uDivergence;",
    "void main () {",
    "  float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;",
    "  float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;",
    "  float divergence = texture2D(uDivergence, vUv).x;",
    "  float pressure = (L + R + B + T - divergence) * 0.25;",
    "  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);",
    "}"].join("\n"));

  var gradientSubtractShader = compile(gl.FRAGMENT_SHADER, [
    "precision mediump float; precision mediump sampler2D;",
    "varying highp vec2 vUv, vL, vR, vT, vB; uniform sampler2D uPressure; uniform sampler2D uVelocity;",
    "void main () {",
    "  float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;",
    "  float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;",
    "  vec2 velocity = texture2D(uVelocity, vUv).xy;",
    "  velocity.xy -= vec2(R - L, T - B);",
    "  gl_FragColor = vec4(velocity, 0.0, 1.0);",
    "}"].join("\n"));

  var clearProgram = new Program(baseVertex, clearShader);
  var displayProgram = new Program(baseVertex, displayShader);
  var splatProgram = new Program(baseVertex, splatShader);
  var advectionProgram = new Program(baseVertex, advectionShader);
  var divergenceProgram = new Program(baseVertex, divergenceShader);
  var curlProgram = new Program(baseVertex, curlShader);
  var vorticityProgram = new Program(baseVertex, vorticityShader);
  var gravityProgram = new Program(baseVertex, gravityShader);
  var pressureProgram = new Program(baseVertex, pressureShader);
  var gradientProgram = new Program(baseVertex, gradientSubtractShader);

  /* ---------- geometry ---------- */
  var blit = (function () {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return function (target) {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  /* ---------- framebuffers ---------- */
  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: texture, fbo: fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
  }
  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    var a = createFBO(w, h, internalFormat, format, type, param);
    var b = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
      get read() { return a; }, set read(v) { a = v; },
      get write() { return b; }, set write(v) { b = v; },
      swap: function () { var t = a; a = b; b = t; }
    };
  }
  function getResolution(resolution) {
    var aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1 / aspectRatio;
    var min = Math.round(resolution), max = Math.round(resolution * aspectRatio);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
  }

  var dye, velocity, divergence, curl, pressure;
  function initFramebuffers() {
    var simRes = getResolution(config.SIM_RES);
    var dyeRes = getResolution(config.DYE_RES);
    var texType = ext.halfFloatTexType;
    var rgba = ext.formatRGBA, rg = ext.formatRG, r = ext.formatR;
    var filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);
    dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  function resizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    var w = Math.floor(window.innerWidth * dpr), h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      return true;
    }
    return false;
  }

  /* ---------- theme ---------- */
  function isDark() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function readTheme() { look = isDark() ? THEME.dark : THEME.light; }
  readTheme();
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  var mq = matchMedia("(prefers-color-scheme: dark)");
  if (mq.addEventListener) mq.addEventListener("change", readTheme);

  /* ---------- simulation ---------- */
  function correctRadius(radius) {
    var aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1) radius *= aspectRatio;
    return radius;
  }
  /* Add motion (dx, dy) and liquid (amount) at (x, y); radiusScale widens the deposit. */
  function splat(x, y, dx, dy, amount, radiusScale) {
    var radius = correctRadius(config.SPLAT_RADIUS / 100) * (radiusScale || 1);
    splatProgram.bind();
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform1f(splatProgram.uniforms.radius, radius);
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
    gl.uniform1f(splatProgram.uniforms.cap, 1e6);
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, amount, 0, 0);
    gl.uniform1f(splatProgram.uniforms.cap, config.DENSITY_CAP);
    blit(dye.write);
    dye.swap();
  }

  function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    gravityProgram.bind();
    gl.uniform1i(gravityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(gravityProgram.uniforms.uDensity, dye.read.attach(1));
    gl.uniform1f(gravityProgram.uniforms.gravity, config.GRAVITY);
    gl.uniform1f(gravityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradientProgram.bind();
    gl.uniform2f(gradientProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    var velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render() {
    gl.disable(gl.BLEND);
    displayProgram.bind();
    /* Sample neighbours 1.5 dye texels apart so surface normals are smooth at screen resolution. */
    gl.uniform2f(displayProgram.uniforms.texelSize, 1.5 / dye.width, 1.5 / dye.height);
    gl.uniform1f(displayProgram.uniforms.uBump, 9.0);
    gl.uniform3f(displayProgram.uniforms.uYolk, look.yolk[0], look.yolk[1], look.yolk[2]);
    gl.uniform3f(displayProgram.uniforms.uAlbumen, look.albumen[0], look.albumen[1], look.albumen[2]);
    gl.uniform1f(displayProgram.uniforms.uYolkAlpha, look.yolkAlpha);
    gl.uniform1f(displayProgram.uniforms.uAlbAlpha, look.albAlpha);
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  /* ---------- pointer ---------- */
  var pointer = { x: 0, y: 0, px: 0, py: 0, dx: 0, dy: 0, moved: false, pending: false };
  var lastActivity = performance.now();
  var running = false, lastTime = performance.now();

  function onMove(clientX, clientY) {
    var x = clientX / window.innerWidth;
    var y = 1 - clientY / window.innerHeight;
    if (!pointer.moved) { pointer.px = x; pointer.py = y; pointer.moved = true; }
    var aspect = canvas.width / canvas.height;
    var dx = x - pointer.px, dy = y - pointer.py;
    if (aspect < 1) dx *= aspect; else dy *= aspect;
    pointer.x = x; pointer.y = y;
    pointer.dx = dx * config.SPLAT_FORCE; pointer.dy = dy * config.SPLAT_FORCE;
    pointer.px = x; pointer.py = y;
    if (dx !== 0 || dy !== 0) {
      pointer.pending = true;
      lastActivity = performance.now();
      start();
    }
  }
  window.addEventListener("pointermove", function (e) { onMove(e.clientX, e.clientY); }, { passive: true });
  window.addEventListener("touchmove", function (e) { if (e.touches && e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  document.addEventListener("mouseleave", function () { pointer.moved = false; });

  /* The hero holds a resting yolk that wobbles gently while it is in view. */
  var hero = document.querySelector(".hero");
  var heroVisible = false;
  if (hero && "IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      heroVisible = entries[0].isIntersecting;
      if (heroVisible) start();
    }, { threshold: 0.2 }).observe(hero);
  }
  function heroPoint(fx, fy) {
    var r = hero.getBoundingClientRect();
    return { x: (r.left + r.width * fx) / window.innerWidth, y: 1 - (r.top + r.height * fy) / window.innerHeight, r: r };
  }
  var nextAmbient = 0, seeded = false;
  function ambient(now) {
    if (!hero || !heroVisible) return;
    if (!seeded) {
      var c = heroPoint(0.5, 0.5);
      if (c.y > 0.1 && c.y < 0.9) { seedYolk(); seeded = true; nextAmbient = now + 2500; }
    }
    if (now < nextAmbient) return;
    nextAmbient = now + 2200 + Math.random() * 2200;
    var p = heroPoint(0.35 + Math.random() * 0.3, 0.3 + Math.random() * 0.4);
    if (p.r.bottom < 0 || p.r.top > window.innerHeight) return;
    var ang = Math.random() * Math.PI * 2, f = 90 + Math.random() * 120;
    splat(p.x, p.y, Math.cos(ang) * f, Math.sin(ang) * f, 0.16, 2.2);
  }
  function seedYolk() {
    if (!hero) return;
    var p = heroPoint(0.5, 0.5);
    /* albumen pool, then a dense yolk sitting in it */
    splat(p.x, p.y, 0, 0, 0.22, 7.0);
    splat(p.x, p.y, 0, 0, 0.55, 2.8);
    splat(p.x, p.y, 0, 0, 0.9, 1.6);
  }

  /* ---------- loop ---------- */
  function frame(now) {
    if (!running) return;
    var dt = Math.min((now - lastTime) / 1000, 0.0166);
    lastTime = now;
    if (resizeCanvas()) { initFramebuffers(); seeded = false; }
    if (pointer.pending) {
      pointer.pending = false;
      splat(pointer.x, pointer.y, pointer.dx, pointer.dy, config.AMOUNT, 1);
    }
    ambient(now);
    step(dt);
    render();
    var idle = now - lastActivity > config.IDLE_MS && !heroVisible;
    if (idle || document.hidden) { running = false; return; }
    requestAnimationFrame(frame);
  }
  function start() {
    if (running || document.hidden) return;
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { lastActivity = performance.now(); start(); } });
  window.addEventListener("resize", function () { if (resizeCanvas()) { initFramebuffers(); seeded = false; } if (!running) render(); });
  canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); running = false; canvas.remove(); });

  /* ---------- boot ---------- */
  resizeCanvas();
  initFramebuffers();
  lastActivity = performance.now();
  start();
})();
