const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const root = "C:/Users/user/Desktop/daily-absence-vercel";
const files = [
  "assets/index-CuviuAWk.js",
  "gheyab/assets/index-CuviuAWk.js",
  "gheyab/index-CuviuAWk.js",
  "sw.js",
  "gheyab/sw.js",
];
for (const rel of files) {
  const p = path.join(root, rel);
  const buf = fs.readFileSync(p);
  const hash = crypto.createHash("md5").update(buf).digest("hex").slice(0, 12);
  console.log(rel, buf.length, hash);
}
const js = fs.readFileSync(path.join(root, "assets/index-CuviuAWk.js"), "utf8");
console.log("uM k0", js.includes("await k0();try{const U=Fe.currentUser"));
console.log("uM upsert", js.includes("else await sr(c,{...e,createdAt:Fa(),updatedAt:Fa()})"));
console.log("AN sc", js.includes("const W=await sc(Q,t)"));
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
console.log("sw rev", (sw.match(/20260902-[a-f0-9]+/) || [])[0]);
