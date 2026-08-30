/**
 * The face of the voice input: a liquid-glass sphere that moves with your voice.
 *
 * The look is taken from LerSent001/orb (MIT), which Osama picked, down to the
 * palette — its `colorA`…`colorD`, highlight and glow are the constants below.
 * The implementation is not taken from it, for one reason: that renderer is
 * WebGPU only, with no fallback, and WebGPU does not exist on most of the
 * phones this product is for. iOS got it in Safari 18 and Android only in
 * recent Chrome, so shipping it would mean the voice button showing nothing at
 * all to a large share of the people most likely to press it.
 *
 * This is WebGL2, which is on essentially every device made since 2017, and a
 * CSS sphere underneath for the rest. Same picture, no cliff.
 *
 * Everything moves off one number: `level`, the microphone's current loudness
 * from 0 to 1. It is not decoration driven by a timer — when you stop talking,
 * it settles, and that is how you can tell it is hearing you.
 */
import { useEffect, useRef, useState } from "react";


const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/**
 * A sphere lit from one side, with a rim that splits into colour.
 *
 * The three things that make glass read as glass, and none of them is the
 * sphere itself: a fresnel rim that brightens hard at the silhouette, a
 * refraction that bends what is behind it, and chromatic separation at the
 * edge, where the three channels are sampled at slightly different radii. The
 * body is nearly black; the whole effect is at the boundary.
 */
const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;

uniform float uTime;
uniform float uLevel;
uniform vec2 uSize;

// ── The parameters, exactly as the editor exported them ─────────────────────
//
// Each has an idle value and an active one, and the orb sits between them on
// the microphone's loudness. That is what the editor's own "activation" is for,
// and it is why this reacts rather than plays: silence is genuinely the idle
// preset, not a slowed-down version of the loud one.
const vec3 COLOR_A      = vec3(0.0353, 0.0118, 0.0549);
const vec3 IDLE_COLOR_A = vec3(0.0314, 0.0196, 0.0431);
const vec3 COLOR_B      = vec3(0.8078, 0.1725, 0.7961);
const vec3 IDLE_COLOR_B = vec3(0.4157, 0.1843, 0.4118);
const vec3 COLOR_C      = vec3(1.0000, 0.3608, 0.4431);
const vec3 IDLE_COLOR_C = vec3(0.5490, 0.2745, 0.3216);
const vec3 COLOR_D      = vec3(0.4824, 0.3255, 1.0000);
const vec3 IDLE_COLOR_D = vec3(0.3333, 0.2745, 0.4980);
const vec3 HIGHLIGHT      = vec3(1.0000, 0.8510, 0.9412);
const vec3 IDLE_HIGHLIGHT = vec3(0.7098, 0.5412, 0.6471);
const vec3 SHELL_INNER = vec3(1.0, 1.0, 1.0);
const vec3 SHELL_MID   = vec3(0.8941, 0.5451, 1.0000);
const vec3 SHELL_EDGE  = vec3(1.0000, 0.4706, 0.5647);
const vec3 SHEEN_COLOR = vec3(1.0000, 0.9451, 0.9804);
const vec3 SPEC_COLOR  = vec3(0.9059, 0.8510, 1.0000);
const vec3 CANVAS      = vec3(0.0078, 0.0039, 0.0196);

const float RADIUS         = 0.7;
const float CONTOUR_DEFORM = 0.1;
const float IDLE_CONTOUR   = 0.03;
const float SPEED          = 0.95;
const float IDLE_SPEED     = 0.266;
const float ZOOM           = 0.36;
const float IDLE_ZOOM      = 0.3312;
const float WARP           = 2.6;
const float IDLE_WARP      = 1.196;
const float RIDGE          = 0.46;
const float IDLE_RIDGE     = 0.1932;
const float EXPOSURE       = 1.35;
const float IDLE_EXPOSURE  = 0.837;
const float SHADE          = 0.08;
const float SHEEN          = 0.22;
const float GLOSS          = 0.36;
const float GLASS_OPACITY  = 0.48;
const float SHELL_MID_A    = 0.18;
const float SHELL_EDGE_A   = 0.2;
const float EDGE_SOFTNESS  = 0.005;

float k;                 // how far from idle toward active, 0..1
float uZoom, uWarp, uRidge, uContour, uExposure;
vec3 cA, cB, cC, cD, cHi;

float edgeD() { return EDGE_SOFTNESS - 0.005; }

vec3 over(vec3 dst, vec3 src, float a) {
  float m = clamp(a, 0.0, 1.0);
  return src * m + dst * (1.0 - m);
}

// The contour, which is the wobble of the silhouette. Style 19's own numbers.
vec2 contourWave(float angle, float t) {
  float wave = sin(angle * 2.0 + t * 0.27) * 0.72
             + sin(angle * 4.0 - t * 0.16 + 2.1) * 0.28;
  float slope = cos(angle * 2.0 + t * 0.27) * 1.44
              + cos(angle * 4.0 - t * 0.16 + 2.1) * 1.12;
  return vec2(wave, slope);
}
float contourStrength() { return 0.11; }   // style >= 18.5

float contourScale(vec2 p, float t) {
  if (uContour <= 0.0) return 1.0;
  return 1.0 + clamp(uContour, 0.0, 1.0) * contourStrength() * contourWave(atan(p.y, p.x), t).x;
}

vec2 contourNormal(vec2 p, float rad, float t) {
  float d = length(p);
  if (d <= 0.0001) return vec2(0.0);
  vec2 radial = p / d;
  vec2 c = contourWave(atan(p.y, p.x), t);
  float slope = clamp(uContour, 0.0, 1.0) * contourStrength() * c.y;
  vec2 tangent = vec2(-radial.y, radial.x);
  return normalize(radial - tangent * (rad * slope / d));
}

float refractionProfile(float t) {
  float depth = clamp(t, 0.0, 1.0);
  float circular = sqrt(max(1.0 - (1.0 - depth) * (1.0 - depth), 0.0));
  return 1.0 - circular;
}

float highlightLobe(vec2 n, vec2 dir, float cut, float power) {
  float angular = clamp((dot(n, dir) - cut) / max(1.0 - cut, 0.001), 0.0, 1.0);
  return pow(angular, power);
}

vec3 finishFluid(vec3 colorIn, vec2 p) {
  vec3 color = colorIn;
  color = mix(color, cHi, SHADE * 0.22 * smoothstep(0.15, 1.15, dot(p, vec2(-0.32, 0.78))));
  color = color * (1.0 - SHADE * 0.34 * smoothstep(-0.1, 1.2, dot(p, vec2(0.45, -0.62))));
  color = color * (1.0 - SHADE * 0.22 * smoothstep(0.72, 1.08, length(p)));
  return clamp(color, vec3(0.0), vec3(1.0));
}

// ── The membrane ────────────────────────────────────────────────────────────
//
// This is what "voiceWave" is, and it is not what the parameter names suggest:
// one broad band that stays phase-coherent across the sphere, with two
// translucent veils above and below it for volume. Not ribbons — ribbonCount
// and its friends belong to a different style entirely and this one never
// reads them.
vec3 voiceWaveFluid(vec2 p, float t) {
  float scale = 0.76 + uZoom * 0.34;
  vec2 q = p / scale;
  float rimEnvelope = pow(max(1.0 - q.x * q.x, 0.0), 0.72);
  float drift = t * 0.82;
  float amplitude = 0.2 + uWarp * 0.018;
  float mainY = rimEnvelope * (amplitude * sin(q.x * 1.48 + drift)
              + 0.055 * sin(q.x * 3.2 - drift * 0.43 + 1.1));
  float distance = q.y - mainY;
  float width = 0.11 + (1.0 - uRidge) * 0.075;
  float membrane = exp(-distance * distance / max(width * width, 0.001)) * rimEnvelope;
  float upperVeil = exp(-(distance - 0.105) * (distance - 0.105)
                    / max(width * width * 2.4, 0.001)) * rimEnvelope;
  float lowerVeil = exp(-(distance + 0.115) * (distance + 0.115)
                    / max(width * width * 2.8, 0.001)) * rimEnvelope;
  float crest = exp(-distance * distance / 0.0026) * rimEnvelope;
  float depth = sqrt(max(1.0 - clamp(dot(p, p), 0.0, 1.0), 0.0));
  vec3 color = mix(cA * 0.7, cD * 0.34, smoothstep(-0.82, 0.82, q.y));
  color = mix(color, cB, upperVeil * 0.7);
  color = mix(color, cC, lowerVeil * 0.62);
  color = color + mix(cB, cC, 0.46) * membrane * 0.34;
  color = color + cHi * crest * 0.14;
  color = color * (0.58 + 0.42 * depth);
  return finishFluid(color, p);
}

void main() {
  k = clamp(uLevel, 0.0, 1.0);
  uZoom     = mix(IDLE_ZOOM, ZOOM, k);
  uWarp     = mix(IDLE_WARP, WARP, k);
  uRidge    = mix(IDLE_RIDGE, RIDGE, k);
  uContour  = mix(IDLE_CONTOUR, CONTOUR_DEFORM, k);
  uExposure = mix(IDLE_EXPOSURE, EXPOSURE, k);
  cA  = mix(IDLE_COLOR_A, COLOR_A, k);
  cB  = mix(IDLE_COLOR_B, COLOR_B, k);
  cC  = mix(IDLE_COLOR_C, COLOR_C, k);
  cD  = mix(IDLE_COLOR_D, COLOR_D, k);
  cHi = mix(IDLE_HIGHLIGHT, HIGHLIGHT, k);

  // The orb was authored in a square, bottom-left origin.
  vec2 fc = vec2(uv.x, uv.y) * 0.5 + 0.5;
  vec2 st = (2.0 * (fc * uSize) - uSize) / max(min(uSize.x, uSize.y), 1.0);

  float t = uTime * mix(IDLE_SPEED, SPEED, k);
  float rad = max(RADIUS, 0.05);
  float cRad = rad * contourScale(st, t);

  if (length(st) > cRad * (1.01 + edgeD())) {
    outColor = vec4(0.0);
    return;
  }

  vec2 p = st / cRad;
  float pd = length(p);

  float clearFa = 1.0 - smoothstep(0.985, 1.0, pd);
  vec2 normal = contourNormal(st, rad, t);
  float edgeDepth = max(1.0 - pd, 0.0);
  float refractionWidth = 0.015 + 0.95 * clamp(SHELL_MID_A, 0.0, 1.0);
  float refractionT = edgeDepth / max(refractionWidth, 0.001);
  float profile = pow(refractionProfile(refractionT), 0.68);
  float refractionAmount = 1.6 * clamp(GLASS_OPACITY, 0.0, 1.0) * profile;
  vec2 refractedP = p - normal * refractionAmount;

  vec3 fcol = vec3(0.0);
  if (clearFa > 0.0) {
    // Three evaluations, which is what makes the edge disperse into colour
    // rather than being a tinted stroke.
    float channelSplit = 0.14 * clamp(GLOSS, 0.0, 2.0) * clamp(GLASS_OPACITY, 0.0, 1.0) * profile;
    vec3 r = voiceWaveFluid(refractedP - normal * channelSplit, t);
    vec3 g = voiceWaveFluid(refractedP, t);
    vec3 b = voiceWaveFluid(refractedP + normal * channelSplit, t);
    fcol = vec3(r.r, g.g, b.b);
  }

  float lum = dot(fcol, vec3(0.213, 0.715, 0.072));
  vec3 clearSat = clamp(vec3(lum) + (fcol - vec3(lum)) * 1.22, vec3(0.0), vec3(1.0));
  vec3 col = over(CANVAS, clearSat, 0.99 * clearFa);

  float surfaceWidth = 0.026 + 0.055 * clamp(SHELL_EDGE_A, 0.0, 1.0);
  float surfaceBand = (1.0 - smoothstep(0.0, surfaceWidth, edgeDepth)) * clearFa;
  float opticalRim = pow(surfaceBand, 1.8);
  col = over(col, SHELL_INNER, opticalRim * GLASS_OPACITY * 0.45);

  vec2 coolDirection = normalize(vec2(0.84, 0.54));
  vec2 warmDirection = normalize(vec2(-0.62, -0.78));
  float dispersion = opticalRim * clamp(GLOSS, 0.0, 2.0) * (0.8 + 0.8 * SHELL_EDGE_A);
  col = over(col, SHELL_MID, dispersion * highlightLobe(normal, coolDirection, -0.32, 1.8));
  col = over(col, SHELL_EDGE, dispersion * highlightLobe(normal, warmDirection, -0.28, 2.0));

  float edgeShadow = opticalRim * (0.015 + 0.15 * SHELL_EDGE_A)
                   * (0.15 + 0.85 * max(dot(normal, vec2(0.45, -0.89)), 0.0));
  col = col * (1.0 - edgeShadow);

  vec2 keyDirection = normalize(vec2(-0.68, 0.73));
  vec2 fillDirection = normalize(vec2(0.74, -0.67));
  col = over(col, SHEEN_COLOR, opticalRim * highlightLobe(normal, keyDirection, 0.2, 2.8) * clamp(SHEEN, 0.0, 2.0) * 1.4);
  col = over(col, SPEC_COLOR, opticalRim * highlightLobe(normal, fillDirection, 0.4, 3.6) * clamp(SHEEN, 0.0, 2.0) * 1.0);

  float ballA = 1.0 - smoothstep(0.99 - edgeD(), 1.01 + edgeD(), pd);
  col = clamp(col * max(uExposure, 0.0), vec3(0.0), vec3(1.0)) * ballA;
  outColor = vec4(col, ballA);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // A shader that failed to compile is a black box on the screen, and the
    // reason is only ever in this log.
    console.error("voice orb shader:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function VoiceOrb({
  level,
  listening,
  className = "",
}: {
  /** Microphone loudness, 0 to 1. */
  level: number;
  listening: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /*
   * Whether the shader is actually painting.
   *
   * The fallback sphere was drawn unconditionally, on the reasoning that the
   * canvas would cover it. It did not: the canvas draws a sphere at 62% of the
   * frame and the fallback's glow spilled past it, so every browser *with*
   * WebGL2 showed a second ring around the orb — one object rendered twice, at
   * two sizes. It is a fallback, so it goes when there is nothing to fall back
   * from, and the flag flips on the first frame rather than on context creation
   * so that a context which is created and then fails to draw still leaves
   * something on screen.
   */
  const [painting, setPainting] = useState(false);
  // Read inside the animation frame rather than closed over, so the loop is
  // started once and never restarted by a level that changes 60 times a second.
  const levelRef = useRef(level);
  const listeningRef = useRef(listening);
  levelRef.current = level;
  listeningRef.current = listening;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: true });
    if (!gl) return; // The CSS sphere underneath is already showing.

    const program = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!program || !vs || !fs) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("voice orb link:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uTime = u("uTime"), uLevel = u("uLevel"), uSize = u("uSize");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // The level the orb actually draws, chasing the microphone rather than
    // following it exactly: a sphere that tracks every sample jitters, and a
    // voice is not a smooth signal.
    let shown = 0;
    let raf = 0;
    let painted = false;
    const started = performance.now();

    const frame = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      const target = listeningRef.current ? levelRef.current : 0;
      // Rises quickly, falls slowly: the shape of an envelope follower, and the
      // reason it reads as "hearing" rather than "animating".
      shown += (target - shown) * (target > shown ? 0.35 : 0.07);

      gl.uniform1f(uTime, (now - started) / 1000);
      gl.uniform1f(uLevel, shown);
      gl.uniform2f(uSize, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!painted) {
        painted = true;
        setPainting(true);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      setPainting(false);
      cancelAnimationFrame(raf);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buffer);
    };
  }, []);

  return (
    <div className={`relative isolate ${className}`} data-testid="voice-orb">
      {/*
        Underneath the canvas, and always drawn until the shader paints.
        On a browser with no WebGL2 this is the orb; everywhere else it is
        covered before the first frame. The same three shell colours the glass
        uses, so the two do not look like different objects.
      */}
      <div
        aria-hidden="true"
        data-testid="voice-orb-fallback"
        hidden={painting}
        className="absolute inset-[6%] rounded-full transition-transform duration-150"
        style={{
          transform: `scale(${1 + (listening ? level : 0) * 0.08})`,
          background:
            "radial-gradient(circle at 42% 38%, #E48BFF 0%, #CE2CCB 22%, #7B53FF 52%, #09030E 86%)",
          boxShadow: "inset 0 0 24px rgba(255,120,144,0.35), 0 0 22px rgba(206,44,203,0.35)",
        }}
      />
      <canvas ref={canvasRef} className="relative w-full h-full block" />
    </div>
  );
}
