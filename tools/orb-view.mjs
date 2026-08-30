/**
 * Look at the voice orb, at four loudnesses, on one strip.
 *
 * Not a test — it asserts nothing and CI does not run it. It exists because the
 * orb is 36px in a chat bar, and at 36px no screenshot can tell you whether the
 * glass is right, which is how three wrong versions of this shipped before
 * anyone could see they were wrong.
 *
 * It reads VERT and FRAG out of the component rather than keeping a copy, so
 * what it renders is what the app renders. Writes /tmp/orb-levels.png.
 *
 *   node tools/orb-view.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
const src = readFileSync(new URL("../artifacts/editly/src/components/voice/orb.tsx", import.meta.url), "utf8");
const grab = (name) => { const i = src.indexOf(`const ${name} = \``); const j = src.indexOf("`;", i); return src.slice(i + `const ${name} = \``.length, j); };
const VERT = grab("VERT"), FRAG = grab("FRAG");
const html = `<!doctype html><meta charset=utf8><style>body{margin:0;background:#020105;display:flex;gap:8px;padding:8px}canvas{width:220px;height:220px;background:#020105;border-radius:12px}</style>
<canvas id=a></canvas><canvas id=b></canvas><canvas id=c></canvas><canvas id=d></canvas>
<script>
const V=${JSON.stringify(VERT)}, F=${JSON.stringify(FRAG)};
function draw(id, level){
  const cv=document.getElementById(id); cv.width=440; cv.height=440;
  const gl=cv.getContext("webgl2",{alpha:true,premultipliedAlpha:false,antialias:true});
  if(!gl){document.title="NOGL";return;}
  const mk=(t,s)=>{const sh=gl.createShader(t);gl.shaderSource(sh,s);gl.compileShader(sh);
    if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){document.title="ERR:"+gl.getShaderInfoLog(sh);}
    return sh;};
  const p=gl.createProgram();gl.attachShader(p,mk(gl.VERTEX_SHADER,V));gl.attachShader(p,mk(gl.FRAGMENT_SHADER,F));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)){document.title="LINK:"+gl.getProgramInfoLog(p);}
  gl.useProgram(p);
  const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const loc=gl.getAttribLocation(p,"p");gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  gl.uniform1f(gl.getUniformLocation(p,"uTime"),2.4);
  gl.uniform1f(gl.getUniformLocation(p,"uLevel"),level);
  gl.uniform2f(gl.getUniformLocation(p,"uSize"),440,440);
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0,0,440,440);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES,0,3);
}
draw("a",0);draw("b",0.25);draw("c",0.6);draw("d",1);
</script>`;
writeFileSync("/tmp/orbview.html", html);
const { chromium } = await import("playwright");
function fc(){const r=process.env.PLAYWRIGHT_BROWSERS_PATH;if(!r||!existsSync(r))return undefined;for(const d of readdirSync(r)){if(!/^chromium[-_]/.test(d))continue;const c=path.join(r,d,"chrome-linux","chrome");if(existsSync(c))return c;}return undefined;}
const b=await chromium.launch({...(fc()?{executablePath:fc()}:{}),args:["--no-sandbox","--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
const page=await(await b.newContext({viewport:{width:940,height:240},deviceScaleFactor:2})).newPage();
page.on("console",m=>console.log("console:",m.text().slice(0,200)));
await page.goto("file:///tmp/orbview.html");
await page.waitForTimeout(1200);
console.log("title:", await page.title());
await page.screenshot({path:"/tmp/orb-levels.png"});
await b.close();
