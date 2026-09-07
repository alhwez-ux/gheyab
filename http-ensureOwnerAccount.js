/**
 * للصق في Google Cloud Console → Cloud Functions → Create function
 * الاسم: ensureOwnerAccount
 * المنطقة: us-central1
 * النوع: HTTP
 * المصادقة: Allow unauthenticated
 * Runtime: Node.js 20
 * Entry point: ensureOwnerAccount
 * package.json: { "dependencies": { "firebase-admin": "^12.7.0" } }
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

function emailsFor(civilId) {
  return EMAIL_DOMAINS.map((domain) => `${civilId}@${domain}`);
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

exports.ensureOwnerAccount = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const data = payloadOf(req);
    const password = String(data.password || DEFAULT_PASSWORD);
    const db = admin.firestore();
    const snap = await db.collection("users").where("civilId", "==", OWNER_CIVIL_ID).limit(1).get();
    const existing = snap.docs[0];
    const emails = emailsFor(OWNER_CIVIL_ID);

    let user = existing ? null : await findAuthByEmails(emails);
    if (existing) {
      try {
        user = await admin.auth().getUser(existing.id);
      } catch (error) {
        if (error.code !== "auth/user-not-found") throw error;
      }
    }
    if (!user) user = await findAuthByEmails(emails);

    const authPayload = {
      email: emails[0],
      displayName: existing?.data()?.name || OWNER_NAME,
      password,
      disabled: false,
    };
    const uid = user
      ? (await admin.auth().updateUser(user.uid, authPayload), user.uid)
      : (await admin.auth().createUser(authPayload)).uid;

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

    res.json({ result: { ok: true, created: !existing, seeded: 0, uid } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: { status: "INTERNAL", message: error.message || "تعذر إنشاء حساب المالك" } });
  }
};
