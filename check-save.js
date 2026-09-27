/**
 * يمنع رجوع خطأ إسقاط الغياب وفقدان كلمة المرور.
 * شغّله قبل أي نشر: node check-save.js
 */
const fs = require("fs");
const path = require("path");

const root = __dirname;
const bundles = ["assets/index-CuviuAWk.js", "index-CuviuAWk.js"];
const required = [
  "async function daEnsureSelf()",
  "تعذر تأكيد حفظ كلمة المرور في قاعدة البيانات",
  "تعذر تأكيد حفظ تقرير الغياب في قاعدة البيانات",
  'await sr(xn(te,"reports",id),n,{merge:!0})',
  'console.error("report-save",Y),ux(P,de),B="queued"',
  "if(de)await Nj(a);JM(i,a)",
  "if(de)await Nj(d)}catch(err)",
];
const forbidden = [
  't==="permission-denied"||t==="already-exists"',
  "!Fe?.currentUser||!te||(await a7",
  'else e?(P.synced=!0,B="ok")',
  "try{JM(i,a);if(de)await Nj(a)",
];

let failed = 0;
function fail(message) {
  failed++;
  console.error("FAIL", message);
}

for (const rel of bundles) {
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, "utf8");
  for (const needle of required) {
    if (!source.includes(needle)) fail(rel + " missing: " + needle);
  }
  for (const needle of forbidden) {
    if (source.includes(needle)) fail(rel + " still has: " + needle);
  }
}

const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
if (!rules.includes("function ownReport()")) fail("rules missing ownReport");
if (!rules.includes("allow create: if ownReport();")) fail("rules do not allow creating an own report");
if (!rules.includes("ownReport() && resource.data.teacherId == request.auth.uid")) {
  fail("rules do not allow the teacher to update the same report");
}
if (!rules.includes('"loginPin"')) fail("rules do not allow saving loginPin");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!html.includes('BUILD = "20260927-save1"')) fail("index.html build id drifted");
if (!html.includes("/assets/index-CuviuAWk.js?v=20260927-save1")) fail("index.html is not loading the fixed bundle");

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("save checks passed");
