/**
 * للصق في Google Cloud Console → Cloud Functions → Create function
 * الاسم: lookupUserByCivilId
 * المنطقة: us-central1
 * النوع: HTTP
 * المصادقة: Allow unauthenticated
 * Runtime: Node.js 20
 * Entry point: lookupUserByCivilId
 * package.json: { "dependencies": { "firebase-admin": "^12.7.0" } }
 */
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

const OWNER_CIVIL_ID = "1025774389";
const OWNER_NAME = "مالك النظام";

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function payloadOf(req) {
  const body = req.body || {};
  return body.data && typeof body.data === "object" ? body.data : body;
}

function normalizeCivilId(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits === OWNER_CIVIL_ID) return OWNER_CIVIL_ID;
  if (/^19\d{8}$/.test(digits)) return `10${digits.slice(2)}`;
  return digits;
}

exports.lookupUserByCivilId = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const civilId = normalizeCivilId(payloadOf(req).civilId);
    if (civilId.length !== 10) {
      res.json({ result: { found: false, civilId } });
      return;
    }
    if (civilId === OWNER_CIVIL_ID) {
      const snap = await admin.firestore().collection("users").where("civilId", "==", OWNER_CIVIL_ID).limit(1).get();
      const docSnap = snap.docs[0];
      res.json({
        result: {
          found: true,
          civilId: OWNER_CIVIL_ID,
          active: docSnap?.data()?.active !== false,
          role: "owner",
          name: docSnap?.data()?.name || OWNER_NAME,
          uid: docSnap?.id || null,
        },
      });
      return;
    }
    const snap = await admin.firestore().collection("users").where("civilId", "==", civilId).limit(1).get();
    if (snap.empty) {
      res.json({ result: { found: false, civilId } });
      return;
    }
    const docSnap = snap.docs[0];
    const data = docSnap.data() || {};
    res.json({
      result: {
        found: true,
        civilId,
        active: data.active !== false,
        role: data.role || "teacher",
        name: data.name || "",
        uid: docSnap.id,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: { status: "INTERNAL", message: error.message || "تعذر البحث عن المستخدم" } });
  }
};
