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

/** The palette, exactly as it was chosen in the editor that produced it. */
const PALETTE = {
  a: [0x09 / 255, 0x03 / 255, 0x0e / 255],
  b: [0xce / 255, 0x2c / 255, 0xcb / 255],
  c: [0xff / 255, 0x5c / 255, 0x71 / 255],
  d: [0x7b / 255, 0x53 / 255, 0xff / 255],
  highlight: [0xff / 255, 0xd9 / 255, 0xf0 / 255],
};

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
uniform vec2 uAspect;
uniform vec3 uA, uB, uC, uD, uHi;

// Cheap value noise. Good enough for a surface that is always moving.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}

void main() {
  vec2 st = uv * uAspect;
  float t = uTime;

  // The silhouette breathes with the voice, and ripples along its edge.
  float loud = clamp(uLevel, 0.0, 1.0);
  float angle = atan(st.y, st.x);
  float ripple =
      sin(angle * 3.0 + t * 1.3) * 0.012
    + sin(angle * 5.0 - t * 0.9) * 0.008
    + fbm(vec2(angle * 1.6, t * 0.35)) * 0.03;
  float radius = 0.62 + loud * 0.09 + ripple * (0.35 + loud * 1.7);

  float d = length(st);
  // A soft edge rather than a hard one: a sphere with an aliased silhouette
  // reads as a circle, not as an object.
  float inside = smoothstep(radius + 0.012, radius - 0.012, d);
  float ndc = clamp(d / max(radius, 0.0001), 0.0, 1.0);

  // Fake the surface normal's z, which is all the shading needs.
  float z = sqrt(max(0.0, 1.0 - ndc * ndc));
  vec3 normal = normalize(vec3(st / max(radius, 0.0001), z));
  vec3 lightDir = normalize(vec3(-0.45, 0.62, 0.75));

  // The interior.
  //
  // First attempt mixed *from* the near-black colorA, and the result was a
  // dark ball inside a bright ring: glass lit from behind is mostly its own
  // colour, not mostly shadow. The mix runs between the three lit colours and
  // uses the dark one only to deepen the lower half, which is where a sphere's
  // shadow actually is.
  vec2 flowP = st * 1.9 + vec2(t * 0.13, -t * 0.10);
  float flow = fbm(flowP + loud * 0.35);
  float swirl = fbm(flowP * 1.7 + vec2(-t * 0.08, t * 0.06));
  vec3 body = mix(uD, uB, smoothstep(0.20, 0.85, flow));
  body = mix(body, uC, smoothstep(0.45, 1.0, swirl) * (0.55 + loud * 0.35));
  // Depth, from the dark end, weighted to the bottom of the sphere.
  body = mix(body, uA, smoothstep(0.15, 1.0, ndc) * 0.55 * (0.75 - 0.35 * normal.y));
  // The core, where the light gets through.
  body += uHi * pow(max(0.0, z), 3.5) * (0.16 + loud * 0.22);

  // Fresnel: nearly nothing face-on, bright at the silhouette.
  float fres = pow(1.0 - z, 3.0);
  // ...separated per channel, which is what makes an edge look like glass
  // rather than like a stroke.
  float chroma = 0.42;
  vec3 rim = vec3(
    pow(1.0 - sqrt(max(0.0, 1.0 - pow(ndc * (1.0 - 0.012 * chroma), 2.0))), 3.0),
    fres,
    pow(1.0 - sqrt(max(0.0, 1.0 - pow(ndc * (1.0 + 0.012 * chroma), 2.0))), 3.0)
  );
  vec3 rimColor = mix(uB, uC, 0.5 + 0.5 * sin(angle * 2.0 + t * 0.6));

  // One specular, kept small, so the sphere has a direction to it.
  float spec = pow(max(0.0, dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0))), 26.0);

  vec3 color = body * (0.80 + 0.30 * max(0.0, dot(normal, lightDir)));
  color += rim * rimColor * (0.85 + loud * 0.7);
  color += uHi * spec * (0.55 + loud * 0.6);
  color *= inside;

  // The glow outside the glass, which is where the loudness is most readable.
  // Tighter and dimmer than it was: a halo wider than the sphere reads as the
  // subject, and the sphere becomes the hole in the middle of it.
  float halo = exp(-max(0.0, d - radius) * 13.0) * (0.16 + loud * 0.55);
  color += mix(uB, uD, 0.5) * halo * (1.0 - inside);

  outColor = vec4(color, max(inside, halo * 0.85));
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
    const uTime = u("uTime"), uLevel = u("uLevel"), uAspect = u("uAspect");
    gl.uniform3fv(u("uA"), PALETTE.a);
    gl.uniform3fv(u("uB"), PALETTE.b);
    gl.uniform3fv(u("uC"), PALETTE.c);
    gl.uniform3fv(u("uD"), PALETTE.d);
    gl.uniform3fv(u("uHi"), PALETTE.highlight);

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
      const aspect = w >= h ? [w / h, 1] : [1, h / w];
      gl.uniform2f(uAspect, aspect[0], aspect[1]);
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
        Underneath the canvas, and always drawn: on a browser with no WebGL2
        this is the orb, and on every other one it is covered before the first
        frame. Same palette, same silhouette, no ripple.
      */}
      <div
        aria-hidden="true"
        data-testid="voice-orb-fallback"
        hidden={painting}
        className="absolute inset-[12%] rounded-full transition-transform duration-150"
        style={{
          transform: `scale(${1 + (listening ? level : 0) * 0.12})`,
          background:
            "radial-gradient(circle at 34% 30%, #FFD9F0 0%, #CE2CCB 26%, #7B53FF 58%, #09030E 88%)",
          boxShadow: "0 0 40px rgba(206,44,203,0.45), inset 0 0 30px rgba(255,92,113,0.35)",
        }}
      />
      <canvas ref={canvasRef} className="relative w-full h-full block" />
    </div>
  );
}
