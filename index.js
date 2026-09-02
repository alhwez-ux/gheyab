/**
 * دوال مشروع tracker-school
 * تُنشر في المنطقة us-central1 بالأسماء نفسها التي يستدعيها التطبيق.
 *
 * loginStaffByCivilId  — إنشاء/تحديث حساب الموظف وإرجاع رمز دخول
 * ensureOwnerAccount   — إنشاء حساب المالك فقط (بدون إنشاء مئات المعلمين)
 * lookupUserByCivilId  — البحث عن المستخدم بالسجل المدني
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

setGlobalOptions({
  region: "us-central1",
  invoker: "public",
  timeoutSeconds: 60,
  memory: "256MiB",
});

initializeApp();
const db = getFirestore();
const authApi = getAuth();

const OWNER_CIVIL_ID = "1025774389";
const OWNER_NAME = "مالك النظام";
const DEFAULT_PASSWORD = "123456";
const EMAIL_DOMAINS = [
  "tracker-school.firebaseapp.com",
  "daily-absence.local",
];

const PUBLIC_CALL = {
  invoker: "public",
  cors: true,
};

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeCivilId(value) {
  const digits = digitsOnly(value);
  if (digits === OWNER_CIVIL_ID) return OWNER_CIVIL_ID;
  if (/^19\d{8}$/.test(digits)) return `10${digits.slice(2)}`;
  return digits;
}

function emailsFor(civilId) {
  const id = normalizeCivilId(civilId);
  return EMAIL_DOMAINS.map((domain) => `${id}@${domain}`);
}

function callableData(request) {
  return request.data && typeof request.data === "object" ? request.data : {};
}

async function findAuthUserByEmails(emails) {
  for (const email of emails) {
    try {
      return await authApi.getUserByEmail(email);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  return null;
}

async function upsertAuthUser({ emails, displayName, password, uid }) {
  const primaryEmail = emails[0];
  let user = null;

  if (uid) {
    try {
      user = await authApi.getUser(uid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  if (!user) user = await findAuthUserByEmails(emails);

  const payload = {
    email: primaryEmail,
    displayName: displayName || primaryEmail,
    disabled: false,
  };
  if (password && String(password).length >= 6) payload.password = String(password);

  if (user) {
    await authApi.updateUser(user.uid, payload);
    return user.uid;
  }

  const created = await authApi.createUser(payload);
  return created.uid;
}

async function findUserDocByCivilId(civilId) {
  const id = normalizeCivilId(civilId);
  if (!id) return null;
  const snap = await db.collection("users").where("civilId", "==", id).limit(5).get();
  if (!snap.empty) return snap.docs[0];
  return null;
}

async function writeUserProfile(uid, fields) {
  const ref = db.doc(`users/${uid}`);
  const current = await ref.get();
  const body = {
    civilId: fields.civilId,
    name: fields.name || "",
    role: fields.role || "teacher",
    active: fields.active !== false,
    assignedClasses: Array.isArray(fields.assignedClasses) ? fields.assignedClasses : [],
    civilIdAliases: Array.isArray(fields.civilIdAliases) ? fields.civilIdAliases : [],
    mustChangePassword: fields.mustChangePassword === true,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (!current.exists) body.createdAt = FieldValue.serverTimestamp();
  await ref.set(body, { merge: true });
  return { id: uid, ...current.data(), ...body };
}

async function ensureOwner(password = DEFAULT_PASSWORD) {
  const emails = emailsFor(OWNER_CIVIL_ID);
  const existing = await findUserDocByCivilId(OWNER_CIVIL_ID);
  const uid = await upsertAuthUser({
    emails,
    displayName: existing?.data()?.name || OWNER_NAME,
    password: password || DEFAULT_PASSWORD,
    uid: existing?.id,
  });
  await writeUserProfile(uid, {
    civilId: OWNER_CIVIL_ID,
    name: existing?.data()?.name || OWNER_NAME,
    role: "owner",
    active: true,
    assignedClasses: existing?.data()?.assignedClasses || [],
    civilIdAliases: existing?.data()?.civilIdAliases || [],
    mustChangePassword: false,
  });
  return { uid, created: !existing };
}

exports.ensureOwnerAccount = onCall(PUBLIC_CALL, async (request) => {
  try {
    const payload = callableData(request);
    const password = String(payload.password || DEFAULT_PASSWORD);
    const result = await ensureOwner(password);
    return { ok: true, created: result.created, seeded: 0, uid: result.uid };
  } catch (error) {
    console.error("ensureOwnerAccount", error);
    throw new HttpsError("internal", error.message || "تعذر إنشاء حساب المالك");
  }
});

exports.lookupUserByCivilId = onCall(PUBLIC_CALL, async (request) => {
  try {
    const payload = callableData(request);
    const civilId = normalizeCivilId(payload.civilId);
    if (civilId.length !== 10) {
      return { found: false, civilId };
    }
    if (civilId === OWNER_CIVIL_ID) {
      const ownerDoc = await findUserDocByCivilId(OWNER_CIVIL_ID);
      return {
        found: true,
        civilId: OWNER_CIVIL_ID,
        active: ownerDoc?.data()?.active !== false,
        role: "owner",
        name: ownerDoc?.data()?.name || OWNER_NAME,
        uid: ownerDoc?.id || null,
      };
    }
    const docSnap = await findUserDocByCivilId(civilId);
    if (!docSnap) return { found: false, civilId };
    const data = docSnap.data() || {};
    return {
      found: true,
      civilId,
      active: data.active !== false,
      role: data.role || "teacher",
      name: data.name || "",
      uid: docSnap.id,
    };
  } catch (error) {
    console.error("lookupUserByCivilId", error);
    throw new HttpsError("internal", error.message || "تعذر البحث عن المستخدم");
  }
});

exports.loginStaffByCivilId = onCall(PUBLIC_CALL, async (request) => {
  try {
    const payload = callableData(request);
    const civilId = normalizeCivilId(payload.civilId);
    const password = String(payload.password || DEFAULT_PASSWORD);

    if (civilId.length !== 10) {
      throw new HttpsError("invalid-argument", "السجل المدني غير صالح");
    }

    if (civilId === OWNER_CIVIL_ID) {
      const owner = await ensureOwner(password);
      const token = await authApi.createCustomToken(owner.uid, {
        civilId: OWNER_CIVIL_ID,
        role: "owner",
      });
      return {
        found: true,
        active: true,
        civilId: OWNER_CIVIL_ID,
        role: "owner",
        uid: owner.uid,
        token,
      };
    }

    const docSnap = await findUserDocByCivilId(civilId);
    if (!docSnap) {
      return { found: false, active: false, civilId, token: null };
    }

    const data = docSnap.data() || {};
    if (data.active === false) {
      return {
        found: true,
        active: false,
        civilId,
        role: data.role || "teacher",
        uid: docSnap.id,
        token: null,
      };
    }

    const uid = await upsertAuthUser({
      emails: emailsFor(civilId),
      displayName: data.name || civilId,
      password,
      uid: docSnap.id,
    });

    if (uid !== docSnap.id) {
      await writeUserProfile(uid, {
        civilId,
        name: data.name || "",
        role: data.role || "teacher",
        active: data.active !== false,
        assignedClasses: data.assignedClasses || [],
        civilIdAliases: data.civilIdAliases || [],
        mustChangePassword: data.mustChangePassword === true,
      });
    }

    const token = await authApi.createCustomToken(uid, {
      civilId,
      role: data.role || "teacher",
    });

    return {
      found: true,
      active: true,
      civilId,
      role: data.role || "teacher",
      uid,
      token,
    };
  } catch (error) {
    console.error("loginStaffByCivilId", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "تعذر تسجيل الدخول");
  }
});
