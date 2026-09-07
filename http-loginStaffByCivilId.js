/**
 * للصق في Google Cloud Console → Cloud Functions → Create function
 * الاسم: loginStaffByCivilId
 * المنطقة: us-central1
 * النوع: HTTP
 * المصادقة: Allow unauthenticated
 * Runtime: Node.js 20
 * Entry point: loginStaffByCivilId
 * package.json لنفس الدالة:
 * { "dependencies": { "firebase-admin": "^12.7.0" } }
 */
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

const OWNER_CIVIL_ID = "1025774389";
const OWNER_NAME = "مالك النظام";
const DEFAULT_PASSWORD = "123456";
const EMAIL_DOMAINS = ["tracker-school.firebaseapp.com", "daily-absence.local"];

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

function emailsFor(civilId) {
  return EMAIL_DOMAINS.map((domain) => `${normalizeCivilId(civilId)}@${domain}`);
}

async function findAuthByEmails(emails) {
  for (const email of emails) {
    try {
      return await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  return null;
}

async function upsertAuth({ emails, displayName, password, uid }) {
  let user = null;
  if (uid) {
    try {
      user = await admin.auth().getUser(uid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  if (!user) user = await findAuthByEmails(emails);
  const payload = {
    email: emails[0],
    displayName: displayName || emails[0],
    password: password || DEFAULT_PASSWORD,
    disabled: false,
  };
  if (user) {
    await admin.auth().updateUser(user.uid, payload);
    return user.uid;
  }
  return (await admin.auth().createUser(payload)).uid;
}

async function ensureOwner(password) {
  const db = admin.firestore();
  const snap = await db.collection("users").where("civilId", "==", OWNER_CIVIL_ID).limit(1).get();
  const existing = snap.docs[0];
  const uid = await upsertAuth({
    emails: emailsFor(OWNER_CIVIL_ID),
    displayName: existing?.data()?.name || OWNER_NAME,
    password,
    uid: existing?.id,
  });
  await db.doc(`users/${uid}`).set(
    {
      civilId: OWNER_CIVIL_ID,
      name: existing?.data()?.name || OWNER_NAME,
      role: "owner",
      active: true,
      assignedClasses: existing?.data()?.assignedClasses || [],
      civilIdAliases: existing?.data()?.civilIdAliases || [],
      mustChangePassword: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: existing ? existing.data().createdAt : admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return uid;
}

exports.loginStaffByCivilId = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const data = payloadOf(req);
    const civilId = normalizeCivilId(data.civilId);
    const password = String(data.password || DEFAULT_PASSWORD);
    if (civilId.length !== 10) {
      res.status(400).json({ error: { status: "INVALID_ARGUMENT", message: "السجل المدني غير صالح" } });
      return;
    }

    const db = admin.firestore();
    if (civilId === OWNER_CIVIL_ID) {
      const uid = await ensureOwner(password);
      const token = await admin.auth().createCustomToken(uid, { civilId, role: "owner" });
      res.json({ result: { found: true, active: true, civilId, role: "owner", uid, token } });
      return;
    }

    const snap = await db.collection("users").where("civilId", "==", civilId).limit(1).get();
    if (snap.empty) {
      res.json({ result: { found: false, active: false, civilId, token: null } });
      return;
    }
    const docSnap = snap.docs[0];
    const profile = docSnap.data() || {};
    if (profile.active === false) {
      res.json({
        result: {
          found: true,
          active: false,
          civilId,
          role: profile.role || "teacher",
          uid: docSnap.id,
          token: null,
        },
      });
      return;
    }

    const uid = await upsertAuth({
      emails: emailsFor(civilId),
      displayName: profile.name || civilId,
      password,
      uid: docSnap.id,
    });
    const token = await admin.auth().createCustomToken(uid, {
      civilId,
      role: profile.role || "teacher",
    });
    res.json({
      result: {
        found: true,
        active: true,
        civilId,
        role: profile.role || "teacher",
        uid,
        token,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: { status: "INTERNAL", message: error.message || "تعذر تسجيل الدخول" } });
  }
};
