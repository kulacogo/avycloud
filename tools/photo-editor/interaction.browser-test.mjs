// Run: npm run build && node --test tools/photo-editor/interaction.browser-test.mjs
// Real React editor and Canvas pixels; generated fixtures and loopback HTTP only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
let browser, server, origin, script, css = "";
before(async () => {
  const result = await build({ absWorkingDir: root, bundle: true, write: false, format: "iife",
    define: { "import.meta.env": JSON.stringify({ DEV: true }) },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import PhotoEditor from "./components/PhotoEditor";
      import { defaultRecipe } from "./utils/photoEditor";
      const source = document.createElement("canvas"); source.width = 600; source.height = 800;
      const c = source.getContext("2d");
      const gradient = c.createLinearGradient(0,0,600,800); gradient.addColorStop(0,"#303030"); gradient.addColorStop(1,"#eeeeee");
      c.fillStyle = gradient; c.fillRect(0,0,600,800);
      c.fillStyle = "rgb(220,30,40)"; c.fillRect(160,230,40,40);
      c.fillStyle = "rgb(160,150,140)"; c.fillRect(280,400,80,80);
      c.fillStyle = "rgb(40,130,210)"; c.fillRect(400,540,40,40);
      c.fillStyle = "#f8f8f8"; c.fillRect(100,600,30,30);
      const original = source.toDataURL("image/png");
      c.clearRect(0,0,600,800); c.fillStyle = "white"; c.fillRect(70,100,430,560); c.clearRect(410,550,20,20);
      const mask = source.toDataURL("image/png");
      const query = new URLSearchParams(location.search);
      const recipe = {...defaultRecipe(), rotation:Number(query.get("rotation") || 270),
        straighten:Number(query.get("straighten") || 0), flipX:query.has("flipX"), flipY:query.has("flipY"),
        padding:Number(query.get("padding") || 0), exposure:.2, background:"white"};
      const initial = {source:"upload",url_or_base64:original,photoEditor:{version:1,originalUrl:original,
        originalMimeType:"image/png",maskUrl:mask,recipe,updatedAt:"2026-09-29T00:00:00.000Z"}};
      function App() {
        const [images,setImages]=React.useState([initial]),[open,setOpen]=React.useState(true);
        return <><button onClick={()=>setOpen(true)}>Werkstatt öffnen</button>{open&&<PhotoEditor images={images} initialIndex={0}
          onClose={()=>setOpen(false)} onApply={changes=>{window.applied=changes;setImages([changes[0].image]);setOpen(false);}}/>}</>;
      }
      createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);
    ` },
    plugins: [{ name: "no-inference", setup(builder) {
      builder.onResolve({ filter: /utils\/photoBackground$/ }, () => ({ path: "background", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const removePhotoBackground=()=>{throw Error("Unexpected model call in interaction test");};' }));
    } }],
  });
  script = result.outputFiles[0].text;
  for (const file of (await readdir(resolve(root, "dist/assets"))).filter(name => name.endsWith(".css"))) css += await readFile(resolve(root, "dist/assets", file), "utf8");
  server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html");
    res.end(req.url === "/bundle.js" ? script : req.url === "/style.css" ? css : '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

const button = (p, name) => p.getByRole("button", { name, exact: true });
const tab = (p, name) => p.getByRole("tab", { name, exact: true });
const canvas = p => p.getByLabel("Bildvorschau 1", { exact: true });
const paint = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function fixture(t, query = "") {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; p.on("pageerror", error => errors.push(error.message)); p.setDefaultTimeout(5000);
  await p.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await p.goto(origin + "/?" + query);
  await p.waitForFunction(() => document.querySelector("canvas")?.width > 1); await paint(p);
  t.after(async () => { await p.close(); assert.deepEqual(errors, []); });
  return p;
}
async function signature(p) {
  await paint(p);
  return canvas(p).evaluate(c => {
    const data = c.getContext("2d").getImageData(0,0,c.width,c.height).data;
    let hash = 2166136261;
    for (const v of data) hash = Math.imul(hash ^ v, 16777619) >>> 0;
    return { width:c.width, height:c.height, hash };
  });
}
async function slider(p, name, value) {
  await p.getByRole("slider", { name, exact: true }).evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,String(next));
    input.dispatchEvent(new Event("input",{bubbles:true}));
  }, value);
  await p.getByRole("slider", { name, exact: true }).dispatchEvent("pointerup"); await paint(p);
}
async function redMarker(p) {
  await paint(p);
  return canvas(p).evaluate(c => {
    const data=c.getContext("2d").getImageData(0,0,c.width,c.height).data;
    let x=0,y=0,count=0;
    for(let row=0;row<c.height;row++)for(let col=0;col<c.width;col++){
      const i=(row*c.width+col)*4;
      if(data[i]>175&&data[i+1]<85&&data[i+2]<95&&data[i+3]>200){x+=col+.5;y+=row+.5;count++;}
    }
    return {x:x/count/c.width,y:y/count/c.height,count};
  });
}
async function clickPhoto(p, point) {
  const r=await canvas(p).boundingBox(); await p.mouse.click(r.x+r.width*point.x,r.y+r.height*point.y); await paint(p);
}
async function apply(p) {
  await button(p,"Ins Datenblatt übernehmen").click();
  await p.waitForFunction(()=>window.applied?.length===1);
  return p.evaluate(()=>window.applied[0].image.photoEditor.recipe);
}

test("all editing modes retain the saved orientation and visible geometry", async t => {
  const p=await fixture(t,"straighten=8.3&flipX=1&padding=.1"); const before=await signature(p);
  for(const [section,tool]of [["Ausrichten","Zuschneiden"],["Licht & Farbe","Weißabgleich-Pipette"],["Freistellen","Radieren"],["Freistellen","Zurückmalen"],["Freistellen","Schrift / Innenfläche retten"]]){
    await tab(p,section).click(); await button(p,tool).click();
    assert.deepEqual(await signature(p),before,tool); await button(p,"Fertig").click();
  }
  await button(p,"Vorher / Nachher").click(); const compared=await signature(p);
  assert.equal(compared.width,before.width); assert.equal(compared.height,before.height); assert.notEqual(compared.hash,before.hash);
  await button(p,"Zur Bearbeitung").click(); assert.deepEqual(await signature(p),before);
});

test("each light/color control visibly changes pixels and undo restores them exactly", async t => {
  const p=await fixture(t); await button(p,"Neutral").click(); const before=await signature(p);
  for(const[name,value]of [["Belichtung",.7],["Tiefen",70],["Lichter",-60],["Kontrast",50],["Wärme",60],["Farbton",-60],["Sättigung",-70],["Schärfe",100]]){
    await slider(p,name,value); assert.notEqual((await signature(p)).hash,before.hash,name);
    await button(p,"Rückgängig").click(); assert.deepEqual(await signature(p),before,name+" undo");
  }
  await button(p,"Vorher / Nachher").click(); await slider(p,"Belichtung",.7);
  assert.notEqual((await signature(p)).hash,before.hash,"slider must immediately leave original comparison");
  assert.equal(await button(p,"Vorher / Nachher").count(),1);
});

test("brush targets the visible source pixel through rotation, straighten, flip and padding", async t => {
  const p=await fixture(t,"straighten=8.3&flipY=1&padding=.1"); const before=await signature(p); const marker=await redMarker(p);
  assert.ok(marker.count>100);
  await tab(p,"Freistellen").click(); await button(p,"Radieren").click(); await slider(p,"Pinselgröße",6);
  await clickPhoto(p,marker); const erased=await redMarker(p); assert.ok(erased.count<marker.count*.1,"paint must cover the visible red marker");
  await button(p,"Zurückmalen").click(); await clickPhoto(p,marker);
  assert.ok((await redMarker(p)).count>=marker.count*.98,"restore must recover the source marker at the same position");
  // Antialiasing can leave a soft brush fringe after erase+restore. Undo must be exact.
  await button(p,"Rückgängig").click(); await button(p,"Rückgängig").click();
  assert.deepEqual(await signature(p),before,"undo must restore every original pixel");
  await button(p,"Wiederholen").click(); await button(p,"Wiederholen").click();
  const recipe=await apply(p); assert.equal(recipe.maskStrokes.length,2);
  for(const stroke of recipe.maskStrokes){assert.ok(Math.abs(stroke.points[0].x-.3)<.005);assert.ok(Math.abs(stroke.points[0].y-.3125)<.005);}
});

test("pipette samples original pixels at the visible position and is idempotent", async t => {
  const p=await fixture(t); await button(p,"Neutral").click();
  // Source warm-neutral patch at (320,440); rotation270 maps it to (440/800,1-320/600).
  const point={x:.55,y:1-320/600};
  await button(p,"Weißabgleich-Pipette").click(); await clickPhoto(p,point);
  const first=await signature(p); const values=await Promise.all(["Wärme","Farbton"].map(name=>p.getByRole("slider",{name,exact:true}).inputValue()));
  assert.notEqual(values[0],"0");
  const pixel=await canvas(p).evaluate((c,point)=>Array.from(c.getContext("2d").getImageData(Math.floor(point.x*c.width),Math.floor(point.y*c.height),1,1).data),point);
  assert.ok(Math.max(...pixel.slice(0,3))-Math.min(...pixel.slice(0,3))<=1,`neutral pixel ${pixel}`);
  await button(p,"Weißabgleich-Pipette").click(); await clickPhoto(p,point);
  assert.deepEqual(await signature(p),first);
  assert.deepEqual(await Promise.all(["Wärme","Farbton"].map(name=>p.getByRole("slider",{name,exact:true}).inputValue())),values);
});

test("mirror actions reflect the displayed axes, including a straightened quarter turn", async t => {
  const p=await fixture(t,"straighten=8.3&padding=.1"); await tab(p,"Ausrichten").click(); const first=await redMarker(p);
  await button(p,"↔ Spiegeln").click(); const horizontal=await redMarker(p);
  assert.ok(Math.abs(horizontal.x-(1-first.x))<.002); assert.ok(Math.abs(horizontal.y-first.y)<.002);
  await button(p,"Rückgängig").click(); await button(p,"↕ Spiegeln").click(); const vertical=await redMarker(p);
  assert.ok(Math.abs(vertical.y-(1-first.y))<.002); assert.ok(Math.abs(vertical.x-first.x)<.002);
});

test("crop uses source pixels under the pointer without turning the displayed photo", async t => {
  const p=await fixture(t); await tab(p,"Ausrichten").click(); const before=await signature(p); await button(p,"Zuschneiden").click();
  assert.deepEqual(await signature(p),before);
  const r=await canvas(p).boundingBox();
  // Two source corners (.2,.2) and (.8,.8), transformed independently for 270 degrees.
  await p.mouse.move(r.x+r.width*.2,r.y+r.height*.8); await p.mouse.down();
  await p.mouse.move(r.x+r.width*.8,r.y+r.height*.2,{steps:3}); await p.mouse.up(); await paint(p);
  const recipe=await apply(p);
  assert.equal(recipe.rotation,270);
  for(const[key,value]of Object.entries({x:.2,y:.2,width:.6,height:.6}))assert.ok(Math.abs(recipe.crop[key]-value)<.003,`${key}: ${recipe.crop[key]}`);
});

test("centering preserves the original aspect and every explicitly selected format", async t => {
  const p=await fixture(t); await tab(p,"Ausrichten").click(); await button(p,"Produkt automatisch zentrieren").click();
  let size=await signature(p); assert.ok(Math.abs(size.width/size.height-4/3)<.002);
  for(const[name,ratio]of [["1:1 Quadrat",1],["4:5 Hochformat",.8],["4:3 Querformat",4/3]]){
    await button(p,name).click(); await button(p,"Produkt automatisch zentrieren").click(); size=await signature(p);
    assert.ok(Math.abs(size.width/size.height-ratio)<.003,name);
  }
});

test("300 percent zoom makes all four image edges reachable by scrolling", async t => {
  const p=await fixture(t); for(let i=0;i<4;i++)await button(p,"Vergrößern").click(); await paint(p);
  const result=await canvas(p).evaluate(c=>{
    const stage=c.closest("main").querySelector("div.overflow-auto");
    stage.scrollLeft=0;stage.scrollTop=0;
    let image=c.getBoundingClientRect(),area=stage.getBoundingClientRect();
    const first={left:image.left-area.left,top:image.top-area.top};
    stage.scrollLeft=stage.scrollWidth;stage.scrollTop=stage.scrollHeight;
    image=c.getBoundingClientRect();area=stage.getBoundingClientRect();
    return{first,last:{right:image.right-area.right,bottom:image.bottom-area.bottom},scrollLeft:stage.scrollLeft,scrollTop:stage.scrollTop};
  });
  assert.ok(result.first.left>=0&&result.first.top>=0,JSON.stringify(result));
  assert.ok(result.last.right<=0&&result.last.bottom<=0,JSON.stringify(result));
  assert.ok(result.scrollLeft>0&&result.scrollTop>0);
});
