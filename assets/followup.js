const PROJECT = "tracker-school";
const API_KEY = "AIzaSyCrjGuSQrSsFTUiBZHnQJCgEBN9LEC3sho";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ADMINS = [
  "principal",
  "vice_principal",
  "counselor",
  "absence_employee",
  "absence_supervisor",
  "owner",
];
const SUBJECTS = [
  "القرآن الكريم",
  "التوحيد",
  "الفقه",
  "الحديث",
  "التجويد",
  "اللغة العربية",
  "الرياضيات",
  "العلوم",
  "الدراسات الاجتماعية",
  "اللغة الإنجليزية",
  "التربية الفنية",
  "التربية البدنية",
  "المهارات الرقمية",
  "التربية الأسرية",
  "السلوك",
  "أخرى",
];
const STATUS = {
  present: "حاضر",
  absent: "غائب",
  late: "متأخر",
  early_leave: "استئذان",
};
const EMPTY_NOTES = "ليس هناك أي ملاحظات على الطالب نتمنى له التوفيق";
const EMPTY_HOMEWORK = "لم يتم إضافة واجب للطالب حتى الآن";

let profile = null;

function da() {
  return window.__DA || null;
}

function isAdmin(role) {
  return ADMINS.includes(role);
}

const FETCH_MS = 8000;
const AUTH_WAIT_MS = 8000;

function civilDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 10);
}

function memoryToken(user) {
  if (!user || typeof user !== "object") return "";
  const fromMgr = (mgr) => (mgr && typeof mgr === "object" && mgr.accessToken) || "";
  return (
    user.accessToken ||
    fromMgr(user.stsTokenManager) ||
    user._lat ||
    (user._delegate && (user._delegate.accessToken || fromMgr(user._delegate.stsTokenManager) || user._delegate._lat)) ||
    ""
  );
}

function token() {
  const user = da()?.auth?.currentUser;
  if (!user) throw new Error("سجّل الدخول أولاً");
  const cached = memoryToken(user);
  if (cached) return Promise.resolve(cached);
  if (typeof user.getIdToken !== "function") throw new Error("انتهت مهلة قراءة الجلسة");
  return Promise.race([
    user.getIdToken(false),
    new Promise((_, reject) => setTimeout(() => reject(new Error("انتهت مهلة قراءة الجلسة")), 1500)),
  ]);
}

function timedFetch(url, options, ms = FETCH_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function decodeValue(val) {
  if (!val || typeof val !== "object") return val;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return Number(val.doubleValue);
  if ("booleanValue" in val) return val.booleanValue;
  if ("timestampValue" in val) return val.timestampValue;
  if ("nullValue" in val) return null;
  if ("arrayValue" in val) return (val.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in val) {
    const out = {};
    for (const [key, inner] of Object.entries(val.mapValue.fields || {})) out[key] = decodeValue(inner);
    return out;
  }
  return val;
}

function decodeDoc(doc) {
  if (!doc?.fields) return { id: doc?.name?.split("/").pop() || "" };
  const out = { id: doc.name.split("/").pop() };
  for (const [key, val] of Object.entries(doc.fields)) out[key] = decodeValue(val);
  return out;
}

function encodeFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    if (typeof value === "string") fields[key] = { stringValue: value };
    else if (typeof value === "number") fields[key] = { integerValue: String(Math.trunc(value)) };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
  }
  return { fields };
}

async function fsFetch(path, options = {}, guest = false) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  delete headers["Content-Type"];
  delete headers["content-type"];
  let auth = "";
  try {
    auth = await token();
  } catch (err) {
    if (!guest) throw err;
  }
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    headers["Content-Type"] = "application/json";
  }
  const join = path.includes("?") ? "&" : "?";
  const url = auth ? `${FS}${path}` : `${FS}${path}${join}key=${API_KEY}`;
  const rest = { ...options };
  delete rest.headers;
  let res;
  try {
    res = await timedFetch(url, { ...rest, method, headers });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("انتهت مهلة الاتصال بقاعدة البيانات");
    throw err;
  }
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: text } };
  }
  if (!res.ok) {
    throw new Error(json.error?.message || res.statusText || "تعذر الاتصال بقاعدة البيانات");
  }
  return json;
}

function getProfile() {
  const ready = da()?.user;
  if (ready && (ready.role || ready.name)) {
    return {
      ...ready,
      id: ready.id || da()?.auth?.currentUser?.uid || "",
      assignedClasses: Array.isArray(ready.assignedClasses) ? ready.assignedClasses : [],
    };
  }
  return null;
}

function studentsFromMemory(user) {
  const all = Array.isArray(da()?.data?.students) ? da().data.students : [];
  if (!all.length || !user) return [];
  if (isAdmin(user.role)) return all.slice();
  const keys = new Set(user.assignedClasses || []);
  if (!keys.size) return [];
  return all.filter((s) => keys.has(s.classKey || `${s.grade || ""}|${s.classroom || s.section || ""}`));
}

function classLabel(student) {
  return `${student.grade || ""} / ${student.classroom || student.section || ""}`.trim();
}

function formatWhen(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ar-SA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function listByCollection(name, guest = false) {
  const json = await fsFetch(`/${name}?pageSize=500`, {}, guest);
  return (json.documents || []).map(decodeDoc);
}

async function queryEquals(collectionId, field, value, guest = false) {
  const json = await fsFetch(":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: "EQUAL",
            value: { stringValue: value },
          },
        },
      },
    }),
  }, guest);
  return (json || [])
    .map((row) => row.document)
    .filter(Boolean)
    .map(decodeDoc);
}

async function loadStudents(user, guest = false, civilId = "") {
  if (civilId) return queryEquals("students", "civilId", civilId, guest);
  const cached = studentsFromMemory(user);
  if (cached.length) return cached;
  if (isAdmin(user.role)) return listByCollection("students");
  const keys = user.assignedClasses || [];
  const batches = await Promise.all(keys.map((key) => queryEquals("students", "classKey", key)));
  return uniqueById(batches.flat());
}

async function loadCollectionForUser(name, user, guest = false, civilId = "") {
  try {
    if (civilId) return queryEquals(name, "civilId", civilId, guest);
    if (isAdmin(user.role)) return listByCollection(name);
    const keys = user.assignedClasses || [];
    const batches = await Promise.all([
      queryEquals(name, "authorId", user.id),
      ...keys.map((key) => queryEquals(name, "classKey", key)),
    ]);
    return uniqueById(batches.flat());
  } catch (err) {
    if (/PERMISSION|403|NOT_FOUND|not found/i.test(String(err.message || err))) return [];
    throw err;
  }
}

function uniqueById(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.id, row);
  return [...map.values()];
}

async function loadAbsences(student) {
  try {
    const reports = isAdmin(profile.role)
      ? await listByCollection("reports")
      : (await Promise.all(
          (profile.assignedClasses || []).map((key) => queryEquals("reports", "classKey", key))
        )).flat();
    const rows = [];
    for (const report of reports) {
      const entries = Array.isArray(report.entries) ? report.entries : [];
      for (const entry of entries) {
        if (entry.studentId !== student.id) continue;
        if (!entry.status || entry.status === "present") continue;
        rows.push({
          date: report.date || "",
          status: entry.status,
          time: entry.time || "",
          teacherName: report.teacherName || "",
        });
      }
    }
    return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  } catch {
    return [];
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function optionList(items, selected, labelFn, valueFn) {
  return items
    .map((item) => {
      const value = valueFn(item);
      return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
    })
    .join("");
}

function itemCard(item, canEdit, kind) {
  return `
    <article class="fu-note">
      <div class="fu-note-top">
        <strong>${escapeHtml(item.studentName || "")}</strong>
        <span>${escapeHtml(item.grade || "")} / ${escapeHtml(item.classroom || "")}</span>
        <span class="fu-chip">${escapeHtml(item.subject || "")}</span>
      </div>
      <p>${escapeHtml(item.content || "")}</p>
      <div class="fu-note-meta">
        <span>المعلم: ${escapeHtml(item.authorName || "")}</span>
        <span>${escapeHtml(formatWhen(item.createdAt))}</span>
      </div>
      ${canEdit ? `
        <div class="fu-note-actions">
          <button type="button" data-edit="${escapeHtml(item.id)}" data-kind="${kind}">تعديل</button>
          <button type="button" data-delete="${escapeHtml(item.id)}" data-kind="${kind}">حذف</button>
        </div>` : ""}
    </article>`;
}

function renderStaff(root, state) {
  const kind = state.kind;
  const title = kind === "homework" ? "الواجبات" : "المتابعة";
  const addTitle = kind === "homework" ? "إضافة واجب" : "إضافة ملاحظة نصية";
  const editTitle = kind === "homework" ? "تعديل الواجب" : "تعديل ملاحظة";
  const saveLabel = kind === "homework" ? "حفظ الواجب" : "إضافة ملاحظة";
  const lead = kind === "homework"
    ? "يسجّل المعلم الواجب المطلوب من الطالب، ويظهر في شاشة الطالب وتقريره."
    : "يسجّل المعلم ملاحظة نصية بتاريخ ووقت واسم المعلم، وتظهر كلها في تقرير الطالب.";
  const students = [...state.students].sort((a, b) =>
    `${a.grade}${a.classroom}${a.name}`.localeCompare(`${b.grade}${b.classroom}${b.name}`, "ar")
  );
  const rows = [...state.items].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const editing = state.editing;
  const missingScope = !isAdmin(profile.role) && !(profile.assignedClasses || []).length;
  const emptyList = kind === "homework" ? EMPTY_HOMEWORK : "لا توجد ملاحظات بعد.";

  root.innerHTML = `
    <section class="fu-wrap">
      <p class="fu-lead">${lead}</p>
      ${state.error ? `<p class="fu-flash fu-error">${escapeHtml(state.error)}</p>` : ""}
      ${state.success ? `<p class="fu-flash fu-ok">${escapeHtml(state.success)}</p>` : ""}
      ${missingScope
        ? `<p class="fu-flash fu-warn">لم تُسند إليك فصول بعد. راجع الإدارة قبل الإضافة.</p>`
        : `
      <form class="fu-card" data-form>
        ${editing ? `<input type="hidden" name="id" value="${escapeHtml(editing.id)}">` : ""}
        <h2>${editing ? editTitle : addTitle}</h2>
        <div class="fu-grid">
          <label>الطالب
            <select name="studentId" required ${editing ? "disabled" : ""}>
              <option value="">اختر الطالب</option>
              ${optionList(students, editing?.studentId || "", (s) => `${s.name} — ${classLabel(s)}`, (s) => s.id)}
            </select>
          </label>
          <label>المادة
            <select name="subject" required>
              <option value="">اختر المادة</option>
              ${SUBJECTS.map((name) => `<option ${editing?.subject === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
            </select>
          </label>
        </div>
        <label>${kind === "homework" ? "نص الواجب" : "نص الملاحظة"}
          <textarea name="content" required minlength="3" rows="4">${escapeHtml(editing?.content || "")}</textarea>
        </label>
        <div class="fu-actions">
          <button type="submit" class="fu-btn">${editing ? "حفظ التعديل" : saveLabel}</button>
          ${editing ? `<button type="button" class="fu-btn fu-ghost" data-cancel>إلغاء</button>` : ""}
        </div>
      </form>`}
      <div class="fu-toolbar">
        <h2>${title === "الواجبات" ? "سجل الواجبات" : "سجل المتابعة"}</h2>
        ${kind === "notes" ? `<button type="button" class="fu-btn fu-ghost" data-print ${state.selectedStudent ? "" : "disabled"}>طباعة تقرير الطالب</button>` : ""}
      </div>
      ${kind === "notes" ? `
      <label class="fu-filter">عرض تقرير طالب
        <select data-report-student>
          <option value="">اختر طالباً للطباعة</option>
          ${optionList(students, state.selectedStudent || "", (s) => `${s.name} — ${classLabel(s)}`, (s) => s.id)}
        </select>
      </label>` : ""}
      <div class="fu-list">
        ${rows.length
          ? rows.map((item) => itemCard(item, isAdmin(profile.role) || item.authorId === profile.id, kind)).join("")
          : `<p class="fu-empty">${emptyList}</p>`}
      </div>
    </section>
  `;
  bindStaff(root, state);
}

function bindStaff(root, state) {
  const collection = state.kind === "homework" ? "homework" : "notes";
  root.querySelector("[data-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await saveItem(state, collection, {
        id: data.get("id"),
        studentId: data.get("studentId") || state.editing?.studentId,
        subject: String(data.get("subject") || "").trim(),
        content: String(data.get("content") || "").trim(),
      });
      state.editing = null;
      state.success = state.kind === "homework" ? "تم حفظ الواجب" : "تم حفظ الملاحظة";
      state.error = "";
      state.items = await loadCollectionForUser(collection, profile);
      renderStaff(root, state);
    } catch (err) {
      state.error = humanError(err);
      state.success = "";
      renderStaff(root, state);
    }
  });
  root.querySelector("[data-cancel]")?.addEventListener("click", () => {
    state.editing = null;
    renderStaff(root, state);
  });
  root.querySelector("[data-report-student]")?.addEventListener("change", (event) => {
    state.selectedStudent = event.target.value;
    renderStaff(root, state);
  });
  root.querySelector("[data-print]")?.addEventListener("click", () => printReport(state));
  root.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editing = state.items.find((item) => item.id === btn.getAttribute("data-edit"));
      renderStaff(root, state);
    });
  });
  root.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("حذف هذا السجل؟")) return;
      try {
        await fsFetch(`/${collection}/${btn.getAttribute("data-delete")}`, { method: "DELETE" });
        state.items = await loadCollectionForUser(collection, profile);
        state.success = "تم الحذف";
        state.error = "";
        renderStaff(root, state);
      } catch (err) {
        state.error = humanError(err);
        renderStaff(root, state);
      }
    });
  });
}

async function saveItem(state, collection, payload) {
  if (payload.content.length < 3) throw new Error("اكتب النص أولاً");
  const student = state.students.find((item) => item.id === payload.studentId);
  if (!student) throw new Error("اختر الطالب");
  const now = new Date().toISOString();
  const body = {
    studentId: student.id,
    studentName: student.name || "",
    civilId: student.civilId || "",
    classKey: student.classKey || `${student.grade}|${student.classroom}`,
    grade: student.grade || "",
    classroom: student.classroom || "",
    subject: payload.subject,
    content: payload.content,
    authorId: profile.id,
    authorName: profile.name || "",
    authorCivilId: profile.civilId || "",
    updatedAt: now,
  };
  if (payload.id) {
    await fsFetch(`/${collection}/${payload.id}?updateMask.fieldPaths=subject&updateMask.fieldPaths=content&updateMask.fieldPaths=updatedAt`, {
      method: "PATCH",
      body: JSON.stringify(encodeFields({
        subject: body.subject,
        content: body.content,
        updatedAt: now,
      })),
    });
    return;
  }
  body.createdAt = now;
  await fsFetch(`/${collection}`, {
    method: "POST",
    body: JSON.stringify(encodeFields(body)),
  });
}

function humanError(err) {
  const msg = String(err?.message || err);
  if (/Quota|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return "تم تجاوز حد استخدام قاعدة البيانات مؤقتاً. النموذج ظاهر ويمكنك الإضافة بعد قليل.";
  }
  if (/PERMISSION|permission|403|Missing or insufficient/i.test(msg)) {
    return "تعذر قراءة السجل من قاعدة البيانات. تحقق من نشر قواعد Firestore أو حد الاستخدام.";
  }
  if (/abort|timeout|مهلة|Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return "تعذر الاتصال بقاعدة البيانات. يمكنك الإضافة من النموذج أو انشر قواعد Firestore ثم أعد المحاولة.";
  }
  return msg;
}

async function printReport(state) {
  const student = state.students.find((item) => item.id === state.selectedStudent);
  if (!student) return;
  const notes = (state.kind === "notes" ? state.items : await loadCollectionForUser("notes", profile))
    .filter((item) => item.studentId === student.id);
  const homework = (state.kind === "homework" ? state.items : await loadCollectionForUser("homework", profile))
    .filter((item) => item.studentId === student.id);
  const absences = await loadAbsences(student);
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير الطالب</title>
    <style>
      body{font-family:Tajawal,sans-serif;padding:32px;color:#173c3a}
      h1,h2{margin:0 0 8px}
      header{text-align:center;border-bottom:2px solid #0d6f68;padding-bottom:16px;margin-bottom:24px}
      .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;background:#eef7f6;padding:16px;border-radius:16px;margin-bottom:24px}
      article{border:1px solid #d9e5e3;border-radius:16px;padding:14px;margin:10px 0}
      .chip{background:#d9f0ed;border-radius:999px;padding:4px 10px;font-weight:700}
    </style></head><body>
    <header>
      <p>المملكة العربية السعودية</p>
      <h1>تقرير الطالب الموحد</h1>
      <p>مدرسة هارون الرشيد الابتدائية — النظام الإلكتروني لغياب الطلاب</p>
    </header>
    <section class="meta">
      <div><small>اسم الطالب</small><strong>${escapeHtml(student.name)}</strong></div>
      <div><small>الصف والفصل</small><strong>${escapeHtml(classLabel(student))}</strong></div>
      <div><small>السجل المدني</small><strong>${escapeHtml(student.civilId || "")}</strong></div>
    </section>
    <h2>الغياب</h2>
    ${absences.length ? absences.map((item) => `<article><strong>${escapeHtml(item.date)}</strong> — ${escapeHtml(STATUS[item.status] || item.status)} — ${escapeHtml(item.teacherName)}</article>`).join("") : "<p>لا توجد سجلات غياب.</p>"}
    <h2>ملاحظات المعلمين</h2>
    ${notes.length ? notes.map((note) => `<article><div class="chip">${escapeHtml(note.subject)}</div><p>${escapeHtml(note.content)}</p><small>المعلم: ${escapeHtml(note.authorName)} — ${escapeHtml(formatWhen(note.createdAt))}</small></article>`).join("") : `<p>${EMPTY_NOTES}</p>`}
    <h2>الواجبات</h2>
    ${homework.length ? homework.map((item) => `<article><div class="chip">${escapeHtml(item.subject)}</div><p>${escapeHtml(item.content)}</p><small>المعلم: ${escapeHtml(item.authorName)} — ${escapeHtml(formatWhen(item.createdAt))}</small></article>`).join("") : `<p>${EMPTY_HOMEWORK}</p>`}
    </body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

const SCHOOL_WHATSAPP_PHONE = "0555149545";

function arabicDigits(value) {
  return String(value || "").replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function normalizeSaudiPhone(value) {
  let digits = arabicDigits(value).replace(/\D/g, "");
  if (digits.startsWith("00966")) digits = digits.slice(2);
  if (digits.startsWith("966") && digits.length === 12) return digits;
  if (digits.startsWith("05") && digits.length === 10) return `966${digits.slice(1)}`;
  if (digits.startsWith("5") && digits.length === 9) return `966${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `966${digits.slice(1)}`;
  return "";
}

function formatLocalPhone(value) {
  const international = normalizeSaudiPhone(value);
  return international ? `0${international.slice(3)}` : String(value || "").trim();
}

function whatsappHref(phone, text) {
  const international = normalizeSaudiPhone(phone);
  if (!international) return "";
  return `https://wa.me/${international}?text=${encodeURIComponent(text)}`;
}

function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatHijri(iso) {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ar-SA-u-ca-islamic", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function noticeBodyText(student, date) {
  return applyWaTemplate(DEFAULT_WA_TEMPLATE.text, student, date);
}

function officialNoticeText(student, date, body) {
  const inner = String(body || noticeBodyText(student, date)).trim();
  if (inner.includes("ابتدائية هارون الرشيد") && inner.includes("إدارة المدرسة")) return inner;
  return [
    "وزارة التعليم",
    "ابتدائية هارون الرشيد",
    "إشعار غياب طالب",
    "",
    inner,
    "",
    "إدارة المدرسة",
  ].join("\n");
}

function absenceWhatsAppText(student, date) {
  return officialNoticeText(student, date);
}

function officialNoticeCard(student, date, body) {
  const filled = escapeHtml(String(body || noticeBodyText(student, date)).trim()).replace(/\n/g, "<br>");
  return `
    <article class="wa-notice">
      <header class="wa-notice-head">
        <img src="/moe-logo.svg" alt="وزارة التعليم" class="wa-moe">
        <p class="wa-school">ابتدائية هارون الرشيد</p>
        <h3>إشعار غياب طالب</h3>
      </header>
      <div class="wa-notice-body">${filled}</div>
      <footer class="wa-notice-foot">إدارة المدرسة</footer>
    </article>`;
}

function printOfficialNotice(student, date, body) {
  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) return;
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إشعار غياب طالب</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700;800&display=swap" rel="stylesheet">
    <style>
      body{font-family:Tajawal,sans-serif;margin:0;padding:24px;color:#173c3a}
      .wa-notice{max-width:520px;margin:0 auto;border:2px solid #0d7377;border-radius:18px;padding:28px 24px;text-align:center}
      .wa-moe{width:180px;height:auto;margin:0 auto 8px;display:block}
      .wa-school{margin:0;font-size:22px;font-weight:800;color:#0d7377}
      .wa-notice-head h3{margin:8px 0 18px;font-size:20px}
      .wa-notice-body{text-align:right;line-height:2;font-size:16px;min-height:120px}
      .wa-notice-foot{margin-top:28px;font-weight:800;font-size:18px}
    </style></head><body>${officialNoticeCard(student, date, body)}</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

function featureEnabled() {
  return da()?.data?.settings?.whatsappEnabled === true;
}

function isOwnerUser(user) {
  return (user && user.role === "owner") || false;
}

function canSendWhatsApp(user) {
  if (!user || !featureEnabled()) return false;
  if (user.role === "vice_principal" || user.role === "owner") return true;
  return user.canSendWhatsApp === true;
}

const WA_SEND_GAP_MS = 2000;

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedSet(state) {
  return state.selected instanceof Set ? state.selected : new Set(state.selected || []);
}

function absenceMessageFor(student, date, state) {
  return officialNoticeText(
    student,
    date,
    applyWaTemplate(selectedWaTemplate(state).text, student, date)
  );
}

function openWhatsAppHref(href, existing) {
  if (existing && !existing.closed) {
    try {
      existing.location.href = href;
      existing.focus();
      return existing;
    } catch (_) {
      /* open a new tab if the previous window cannot be reused */
    }
  }
  const win = window.open(href, "wa-absence-send");
  if (win) return win;
  const link = document.createElement("a");
  link.href = href;
  link.target = "wa-absence-send";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return existing || null;
}

function canGrantWhatsApp(user) {
  return isOwnerUser(user);
}

function canEditPhones(user) {
  if (!user) return false;
  if (isOwnerUser(user)) return true;
  if (user.role === "vice_principal" || user.role === "principal") return true;
  return user.canSendWhatsApp === true;
}

function canManagePhones(user) {
  return canEditPhones(user);
}

function canManageWaTemplates(user) {
  return canEditPhones(user);
}

function reportsFromMemory() {
  return Array.isArray(da()?.data?.reports) ? da().data.reports : [];
}

function usersFromMemory() {
  return Array.isArray(da()?.data?.users) ? da().data.users.slice() : [];
}

function classKeyOf(student) {
  return student.classKey || `${student.grade || ""}|${student.classroom || student.section || ""}`;
}

function uniqueClasses(students) {
  const map = new Map();
  for (const student of students) {
    const key = classKeyOf(student);
    if (!key || key === "|") continue;
    if (!map.has(key)) map.set(key, classLabel(student));
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ar"));
}

function absentIdsForDate(date) {
  const ids = new Set();
  for (const report of reportsFromMemory()) {
    if (String(report.date || "") !== date) continue;
    const entries = Array.isArray(report.entries) ? report.entries : [];
    for (const entry of entries) {
      if (entry && entry.status === "absent" && entry.studentId) ids.add(entry.studentId);
    }
  }
  return ids;
}

function seedPhonesFromStudents(students) {
  const map = {};
  for (const student of students || []) {
    const phone = String(student.parentPhone || "").trim();
    if (student.id && phone) map[student.id] = phone;
  }
  return map;
}

async function loadPhoneMap(students) {
  const map = seedPhonesFromStudents(students);
  try {
    const rows = await listByCollection("studentPrivate");
    for (const row of rows) {
      if (row.id && row.parentPhone) map[row.id] = String(row.parentPhone || "");
    }
    return map;
  } catch {
    const ids = (students || []).map((item) => item.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 20) {
      await Promise.all(ids.slice(i, i + 20).map(async (id) => {
        try {
          const doc = decodeDoc(await fsFetch(`/studentPrivate/${id}`));
          if (doc.parentPhone) map[id] = String(doc.parentPhone);
        } catch {
          /* no private phone yet */
        }
      }));
    }
    return map;
  }
}

async function saveParentPhoneOnly(student, phone) {
  const normalized = phone ? formatLocalPhone(phone) : "";
  if (phone && !normalizeSaudiPhone(phone)) throw new Error("رقم الجوال غير صحيح");
  const payload = encodeFields({
    parentPhone: normalized,
    civilId: String(student.civilId || ""),
  });
  await fsFetch(
    `/studentPrivate/${student.id}?updateMask.fieldPaths=parentPhone&updateMask.fieldPaths=civilId`,
    { method: "PATCH", body: JSON.stringify(payload) }
  );
  try {
    await fsFetch(`/students/${student.id}?updateMask.fieldPaths=parentPhone`, {
      method: "PATCH",
      body: JSON.stringify(encodeFields({ parentPhone: normalized })),
    });
  } catch {
    /* private store is enough; never send name/grade/classroom */
  }
  return normalized;
}

const DEFAULT_WA_TEMPLATE = {
  id: "builtin",
  title: "إشعار غياب طالب",
  text: [
    "السلام عليكم ورحمة الله وبركاته",
    "",
    "نفيدكم بغياب الطالب: {اسم_الطالب}",
    "الصف / الفصل: {الصف}",
    "التاريخ: {التاريخ}",
  ].join("\n"),
};

function applyWaTemplate(text, student, date) {
  return String(text || "")
    .split("{اسم_الطالب}").join(student?.name || "")
    .split("{الصف}").join(classLabel(student || {}))
    .split("{التاريخ}").join(formatHijri(date))
    .split("{رقم_المدرسة}").join(SCHOOL_WHATSAPP_PHONE);
}

function listedWaTemplates(state) {
  return [DEFAULT_WA_TEMPLATE, ...(state.templates || [])];
}

function selectedWaTemplate(state) {
  return listedWaTemplates(state).find((item) => item.id === state.templateId) || DEFAULT_WA_TEMPLATE;
}

async function loadWaTemplates() {
  try {
    const rows = await listByCollection("whatsappTemplates");
    return rows
      .filter((row) => row.id && String(row.text || "").trim())
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  } catch {
    return [];
  }
}

async function saveWaTemplate(state, payload) {
  const title = String(payload.title || "").trim() || "رسالة جاهزة";
  const text = String(payload.text || "").trim();
  if (text.length < 8) throw new Error("اكتب نص الرسالة الجاهزة أولاً");
  const now = new Date().toISOString();
  if (payload.id && payload.id !== "builtin") {
    await fsFetch(
      `/whatsappTemplates/${payload.id}?updateMask.fieldPaths=title&updateMask.fieldPaths=text&updateMask.fieldPaths=updatedAt`,
      {
        method: "PATCH",
        body: JSON.stringify(encodeFields({ title, text, updatedAt: now })),
      }
    );
    return payload.id;
  }
  const created = await fsFetch("/whatsappTemplates", {
    method: "POST",
    body: JSON.stringify(encodeFields({
      title,
      text,
      authorId: profile.id || "",
      authorName: profile.name || "",
      createdAt: now,
      updatedAt: now,
    })),
  });
  return decodeDoc(created).id;
}

async function deleteWaTemplate(id) {
  if (!id || id === "builtin") return;
  await fsFetch(`/whatsappTemplates/${id}`, { method: "DELETE" });
}

async function saveWhatsAppGrant(user, enabled) {
  await fsFetch(`/users/${user.id}?updateMask.fieldPaths=canSendWhatsApp&updateMask.fieldPaths=updatedAt`, {
    method: "PATCH",
    body: JSON.stringify(encodeFields({
      canSendWhatsApp: enabled,
      updatedAt: new Date().toISOString(),
    })),
  });
  const data = da()?.data;
  if (data && Array.isArray(data.users)) {
    data.users = data.users.map((item) => (
      item.id === user.id || item.civilId === user.civilId
        ? { ...item, canSendWhatsApp: enabled }
        : item
    ));
  }
}

function renderWhatsApp(root, state) {
  const user = profile;
  const enabled = featureEnabled();
  const canSend = canSendWhatsApp(user);
  const canGrant = canGrantWhatsApp(user);
  const canPhone = canManagePhones(user);
  const classes = uniqueClasses(state.students);
  const absentIds = absentIdsForDate(state.date);
  const rows = state.students
    .filter((student) => {
      if (state.classKey && classKeyOf(student) !== state.classKey) return false;
      if (state.absenteesOnly && !absentIds.has(student.id)) return false;
      return true;
    })
    .sort((a, b) => `${a.grade}${a.classroom}${a.name}`.localeCompare(`${b.grade}${b.classroom}${b.name}`, "ar"));
  const missing = rows.filter((student) => !normalizeSaudiPhone(state.phones[student.id] || "")).length;
  const staff = usersFromMemory()
    .filter((item) => item.role && item.role !== "student")
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ar"));
  const sample = rows.find((item) => absentIds.has(item.id)) || rows[0] || state.students[0] || { name: "................", grade: "", classroom: "" };
  const noticeBody = applyWaTemplate(selectedWaTemplate(state).text, sample, state.date);

  root.innerHTML = `
    <section class="fu-wrap wa-wrap">
      <p class="fu-lead">إرسال إشعار الغياب عبر واتساب المدرسة المعتمد ${SCHOOL_WHATSAPP_PHONE}. هذه الشاشة تعرض الأسماء والصفوف والفصول الحالية ولا تعدّلها.</p>
      ${state.error ? `<p class="fu-flash fu-error">${escapeHtml(state.error)}</p>` : ""}
      ${state.success ? `<p class="fu-flash fu-ok">${escapeHtml(state.success)}</p>` : ""}
      <section class="fu-card">
        <h2>واتساب الغياب</h2>
        <p>الإرسال متاح لوكيل المدرسة، وللمالك، ولمن يمنحه المالك صلاحية الإرسال من إعدادات الصلاحيات أدناه. لا يُرسل شيء إلا بعد الضغط على زر إرسال إشعارات الغياب ثم موافق.</p>
        <p class="wa-status">${enabled ? "الميزة مفعّلة من إعدادات المالك." : "الميزة متوقفة. المالك يفعّلها من الإعدادات ثم يحفظ."}</p>
      </section>
      <section class="fu-card wa-notice-card">
        <div class="fu-toolbar">
          <h2>نموذج الرسالة</h2>
          <button type="button" class="fu-btn fu-ghost" data-print-notice>طباعة النموذج</button>
        </div>
        ${officialNoticeCard(sample, state.date, noticeBody)}
      </section>
      ${!enabled && !canGrant ? `<p class="fu-empty">إرسال واتساب الغياب غير مفعّل حالياً.</p>` : `
      ${canGrant && !canSend ? `<p class="fu-flash fu-warn">يمكنك منح صلاحية الإرسال من الجدول أدناه. وكيل المدرسة والمالك يملكان الإرسال بعد تفعيل الميزة.</p>` : ""}
      ${enabled && !canSend && !canGrant ? `<p class="fu-empty">هذه الصفحة متاحة لوكيل المدرسة، أو لمن يمنحه المالك صلاحية الإرسال.</p>` : ""}
      ${enabled ? `
      <form class="fu-card wa-filters" data-wa-filters>
        <label>التاريخ
          <input type="date" name="date" value="${escapeHtml(state.date)}">
        </label>
        <label>الفصل
          <select name="classKey">
            <option value="">جميع الفصول</option>
            ${classes.map(([key, label]) => `<option value="${escapeHtml(key)}" ${state.classKey === key ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
          </select>
        </label>
        <label class="wa-check">
          <input type="checkbox" name="absenteesOnly" ${state.absenteesOnly ? "checked" : ""}>
          <span>الغائبون في هذا التاريخ فقط</span>
        </label>
      </form>
      <p class="fu-lead">الغائبون: ${absentIds.size} · المعروض: ${rows.length}${missing ? ` · بدون رقم: ${missing}` : ""} · المحدد: ${rows.filter((item) => selectedSet(state).has(item.id)).length}</p>
      ${canSend ? `
      <div class="fu-actions wa-send-bar">
        <label class="wa-check">
          <input type="checkbox" data-select-all ${rows.length && rows.every((item) => selectedSet(state).has(item.id)) ? "checked" : ""}>
          <span>تحديد الكل</span>
        </label>
        <button type="button" class="fu-btn" data-open-send-modal ${!state.sending && rows.some((item) => selectedSet(state).has(item.id)) ? "" : "disabled"}>إرسال إشعارات الغياب</button>
      </div>
      <p class="wa-progress" data-send-progress ${state.sending ? "" : "hidden"}>${escapeHtml(state.progress || "")}</p>` : ""}
      <div class="wa-table-wrap">
        <table class="wa-table">
          <thead>
            <tr>
              ${canSend ? "<th>اختيار</th>" : ""}
              <th>الطالب</th>
              <th>الصف / الفصل</th>
              <th>الجوال</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((student) => {
              const phone = state.phones[student.id] || "";
              const absent = absentIds.has(student.id);
              const picked = selectedSet(state).has(student.id);
              return `<tr>
                ${canSend ? `<td><input type="checkbox" data-pick="${escapeHtml(student.id)}" ${picked ? "checked" : ""}></td>` : ""}
                <td><strong>${escapeHtml(student.name || "")}</strong>${absent ? `<span class="fu-chip">غائب</span>` : ""}</td>
                <td>${escapeHtml(classLabel(student))}</td>
                <td>
                  <input data-phone="${escapeHtml(student.id)}" inputmode="numeric" placeholder="05xxxxxxxx" value="${escapeHtml(phone)}" ${canPhone ? "" : "readonly"}>
                </td>
              </tr>`;
            }).join("") : `<tr><td colspan="${canSend ? 4 : 3}" class="fu-empty">لا يوجد طلاب مطابقون. القائمة من الكشف الحالي دون تغيير الأسماء أو الصفوف.</td></tr>`}
          </tbody>
        </table>
      </div>
      ${state.confirmSend ? `
      <div class="wa-modal-backdrop" data-send-modal>
        <section class="wa-modal" role="dialog" aria-modal="true">
          <p>سيتم إرسال إشعار الغياب لجميع الطلاب الذين تم اختيارهم</p>
          <button type="button" class="fu-btn" data-confirm-send>موافق</button>
        </section>
      </div>` : ""}
      ` : ""}
      ${canGrant ? `
      <section class="fu-card">
        <h2>منح صلاحية الإرسال</h2>
        <p>المالك يمنح صلاحية الإرسال لأي مستخدم من هنا. وكيل المدرسة يملكها دائماً بعد تفعيل الميزة.</p>
        <div class="wa-grant-list">
          ${staff.map((item) => {
            const locked = item.role === "vice_principal";
            const on = locked || item.canSendWhatsApp === true;
            return `<div class="wa-grant-row">
              <div>
                <strong>${escapeHtml(item.name || "")}</strong>
                <small>${escapeHtml(item.role === "vice_principal" ? "وكيل المدرسة" : item.role === "owner" ? "مالك المشروع" : item.role || "")}</small>
              </div>
              ${locked ? `<span>وكيل — دائماً</span>` : `<button type="button" class="fu-btn ${on ? "fu-ghost" : ""}" data-grant="${escapeHtml(item.id)}" data-on="${on ? "1" : "0"}">${on ? "سحب الصلاحية" : "منح الإرسال"}</button>`}
            </div>`;
          }).join("")}
        </div>
      </section>` : ""}`}
    </section>
  `;
  bindWhatsApp(root, state);
}

function bindWhatsApp(root, state) {
  root.querySelector("[data-print-notice]")?.addEventListener("click", () => {
    const sample = state.students.find((item) => item.id && (state.phones[item.id] || true)) || state.students[0] || { name: "................", grade: "", classroom: "" };
    const absentIds = absentIdsForDate(state.date);
    const chosen = state.students.find((item) => absentIds.has(item.id)) || sample;
    printOfficialNotice(chosen, state.date, applyWaTemplate(selectedWaTemplate(state).text, chosen, state.date));
  });
  root.querySelector("[data-wa-filters]")?.addEventListener("change", (event) => {
    const form = event.currentTarget;
    state.date = form.date.value || todayIso();
    state.classKey = form.classKey.value || "";
    state.absenteesOnly = Boolean(form.absenteesOnly?.checked);
    renderWhatsApp(root, state);
  });
  root.querySelector("[data-select-all]")?.addEventListener("change", (event) => {
    const on = event.currentTarget.checked;
    const picked = selectedSet(state);
    root.querySelectorAll("[data-pick]").forEach((box) => {
      box.checked = on;
      const id = box.getAttribute("data-pick");
      if (on) picked.add(id);
      else picked.delete(id);
    });
    state.selected = picked;
    const sendBtn = root.querySelector("[data-open-send-modal]");
    if (sendBtn) sendBtn.disabled = !on || !root.querySelectorAll("[data-pick]").length;
  });
  root.querySelectorAll("[data-pick]").forEach((box) => {
    box.addEventListener("change", () => {
      const picked = selectedSet(state);
      const id = box.getAttribute("data-pick");
      if (box.checked) picked.add(id);
      else picked.delete(id);
      state.selected = picked;
      const all = [...root.querySelectorAll("[data-pick]")];
      const selectAll = root.querySelector("[data-select-all]");
      if (selectAll) selectAll.checked = all.length > 0 && all.every((item) => item.checked);
      const sendBtn = root.querySelector("[data-open-send-modal]");
      if (sendBtn) sendBtn.disabled = !all.some((item) => item.checked);
    });
  });
  root.querySelector("[data-open-send-modal]")?.addEventListener("click", () => {
    if (!canSendWhatsApp(profile)) {
      state.error = "إرسال إشعارات الغياب متاح لوكيل المدرسة، أو للمالك، أو لمن يمنحه المالك الصلاحية.";
      renderWhatsApp(root, state);
      return;
    }
    const picked = selectedSet(state);
    root.querySelectorAll("[data-pick]").forEach((box) => {
      const id = box.getAttribute("data-pick");
      if (box.checked) picked.add(id);
      else picked.delete(id);
    });
    state.selected = picked;
    if (!picked.size) {
      state.error = "اختر طالباً واحداً على الأقل قبل الإرسال.";
      renderWhatsApp(root, state);
      return;
    }
    state.confirmSend = true;
    renderWhatsApp(root, state);
  });
  root.querySelector("[data-confirm-send]")?.addEventListener("click", async () => {
    if (!canSendWhatsApp(profile) || state.sending) return;
    const ids = [...selectedSet(state)];
    const queue = [];
    for (const id of ids) {
      const student = state.students.find((item) => item.id === id);
      if (!student) continue;
      const input = root.querySelector(`[data-phone="${CSS.escape(id)}"]`);
      const raw = input ? input.value : state.phones[id] || "";
      if (raw) state.phones[id] = String(raw).trim();
      const phone = state.phones[id] || raw;
      const href = whatsappHref(phone, absenceMessageFor(student, state.date, state));
      if (!href) continue;
      queue.push({ student, href, raw });
    }
    if (!queue.length) {
      state.confirmSend = false;
      state.error = "لا يوجد رقم جوال صحيح للطلاب المختارين.";
      renderWhatsApp(root, state);
      return;
    }
    let waWin = openWhatsAppHref(queue[0].href);
    state.sent.add(queue[0].student.id);
    state.confirmSend = false;
    state.sending = true;
    state.progress = `جاري الإرسال 1 من ${queue.length}...`;
    state.error = "";
    renderWhatsApp(root, state);
    const live = document.getElementById(root.id) || root;
    const progress = () => live.querySelector("[data-send-progress]");
    try {
      for (let i = 1; i < queue.length; i += 1) {
        await waitMs(WA_SEND_GAP_MS);
        const node = progress();
        if (node) {
          node.hidden = false;
          node.textContent = `جاري الإرسال ${i + 1} من ${queue.length}...`;
        }
        waWin = openWhatsAppHref(queue[i].href, waWin);
        state.sent.add(queue[i].student.id);
      }
      if (canManagePhones(profile)) {
        for (const item of queue) {
          if (!item.raw) continue;
          try {
            state.phones[item.student.id] = await saveParentPhoneOnly(item.student, item.raw);
          } catch {
            /* keep typed number */
          }
        }
      }
      state.sending = false;
      state.progress = "";
      state.success = `تم تجهيز إرسال ${queue.length} إشعار غياب، بفاصل ثانيتين بين كل رسالة.`;
      state.error = "";
      renderWhatsApp(live, state);
    } catch (err) {
      state.sending = false;
      state.error = humanError(err);
      state.success = "";
      renderWhatsApp(live, state);
    }
  });
  root.querySelectorAll("[data-phone]").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.getAttribute("data-phone");
      const student = state.students.find((item) => item.id === id);
      if (!student) return;
      try {
        const saved = await saveParentPhoneOnly(student, input.value);
        state.phones[id] = saved;
        state.success = "حُفظ رقم الجوال دون تغيير اسم الطالب أو صفه أو فصله.";
        state.error = "";
        input.value = saved;
      } catch (err) {
        state.error = humanError(err);
        state.success = "";
        renderWhatsApp(root, state);
      }
    });
  });
  root.querySelectorAll("[data-grant]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-grant");
      const enabled = btn.getAttribute("data-on") !== "1";
      const user = usersFromMemory().find((item) => item.id === id);
      if (!user || user.role === "vice_principal") return;
      try {
        await saveWhatsAppGrant(user, enabled);
        state.success = enabled ? `مُنحت صلاحية واتساب لـ ${user.name}.` : `سُحبت صلاحية واتساب من ${user.name}.`;
        state.error = "";
        renderWhatsApp(root, state);
      } catch (err) {
        state.error = humanError(err);
        state.success = "";
        renderWhatsApp(root, state);
      }
    });
  });
}

async function mountWhatsApp(root) {
  const liveRoot = () => document.getElementById(root.id) || root;
  liveRoot().innerHTML = `<p class="fu-empty">جاري التحميل...</p>`;
  try {
    await waitForAuth();
    profile = getProfile();
    if (!profile) throw new Error("تعذر قراءة حسابك. حدّث الصفحة بعد اكتمال تسجيل الدخول.");
    let students = studentsFromMemory(profile);
    let error = "";
    let phones = {};
    try {
      if (!students.length) students = await loadStudents(profile);
      phones = await loadPhoneMap(students);
    } catch (err) {
      error = humanError(err);
      if (!students.length) students = studentsFromMemory(profile);
    }
    renderWhatsApp(liveRoot(), {
      students,
      phones,
      date: todayIso(),
      classKey: "",
      absenteesOnly: true,
      selected: new Set(),
      confirmSend: false,
      sending: false,
      progress: "",
      sent: new Set(),
      error,
      success: "",
    });
  } catch (err) {
    liveRoot().innerHTML = `<p class="fu-flash fu-error">${escapeHtml(humanError(err))}</p>`;
  }
}

function hostFor(kind) {
  const id = kind === "homework" ? "fu-host-homework" : kind === "whatsapp" ? "fu-host-whatsapp" : "fu-host-notes";
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement("section");
    host.id = id;
    host.className = "fu-host";
    host.hidden = true;
    document.body.appendChild(host);
  } else if (host.parentElement !== document.body) {
    document.body.appendChild(host);
  }
  return host;
}

function placeHost(host) {
  if (!host || host.hidden) return;
  const sidebar = document.querySelector(".sidebar");
  const topbar = document.querySelector("header.topbar");
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const top = topbar ? Math.ceil(topbar.getBoundingClientRect().bottom) : 0;
  const side = !mobile && sidebar ? sidebar.getBoundingClientRect() : null;
  host.style.position = "fixed";
  host.style.top = `${Math.max(0, top)}px`;
  host.style.left = "0";
  host.style.right = side ? `${Math.max(0, Math.round(window.innerWidth - side.left))}px` : "0";
  host.style.bottom = mobile ? `${Math.max(64, sidebar ? Math.round(sidebar.getBoundingClientRect().height) : 72)}px` : "0";
}

function paintStaff(root, kind, extra = {}) {
  const live = document.getElementById(root.id) || root;
  if (!live || !profile) return;
  renderStaff(live, {
    kind,
    students: extra.students || studentsFromMemory(profile),
    items: extra.items || [],
    editing: extra.editing || null,
    selectedStudent: extra.selectedStudent || "",
    error: extra.error || "",
    success: extra.success || "",
  });
}

async function mountStaff(root, kind) {
  const liveRoot = () => document.getElementById(root.id) || root;
  const setMsg = (text) => {
    liveRoot().innerHTML = `<p class="fu-empty">${escapeHtml(text)}</p>`;
  };
  setMsg("جاري التحميل...");
  try {
    await waitForAuth();
    profile = getProfile();
    if (!profile) throw new Error("تعذر قراءة حسابك. حدّث الصفحة بعد اكتمال تسجيل الدخول.");
    const collection = kind === "homework" ? "homework" : "notes";
    let students = studentsFromMemory(profile);
    let items = [];
    let error = "";
    try {
      const [st, it] = await Promise.all([
        students.length ? Promise.resolve(students) : loadStudents(profile),
        loadCollectionForUser(collection, profile),
      ]);
      students = st;
      items = it;
    } catch (err) {
      error = humanError(err);
      if (!students.length) students = studentsFromMemory(profile);
    }
    renderStaff(liveRoot(), {
      kind,
      students,
      items,
      editing: null,
      selectedStudent: "",
      error,
      success: "",
    });
  } catch (err) {
    profile = profile || getProfile();
    if (profile) paintStaff(liveRoot(), kind, { error: humanError(err) });
    else liveRoot().innerHTML = `<p class="fu-flash fu-error">${escapeHtml(humanError(err))}</p>`;
  }
}

function waitForAuth() {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const tick = () => {
      const ready = da()?.user;
      if (ready && (ready.role || ready.name)) return resolve();
      if (da()?.auth?.currentUser && Date.now() - began > 400) {
        const u = da().auth.currentUser;
        window.__DA.user = window.__DA.user || {
          id: u.uid,
          name: u.displayName || "",
          role: "teacher",
          assignedClasses: [],
        };
        return resolve();
      }
      if (Date.now() - began > AUTH_WAIT_MS) {
        return reject(new Error("انتظر اكتمال تسجيل الدخول ثم افتح الصفحة"));
      }
      setTimeout(tick, 80);
    };
    tick();
  });
}

function renderStudent(box, student, notes, homework) {
  box.innerHTML = `
    <section class="fu-student">
      <div class="fu-student-head">
        <div>
          <p class="fu-lead">شاشة الطالب</p>
          <h2>${escapeHtml(student.name || "")}</h2>
          <p>${escapeHtml(classLabel(student))} · ${escapeHtml(student.civilId || "")}</p>
        </div>
        <button type="button" class="fu-btn fu-ghost" data-student-close>رجوع</button>
      </div>
      <section class="fu-card">
        <h2>الملاحظات</h2>
        ${notes.length ? notes.map((item) => itemCard(item, false, "notes")).join("") : `<p class="fu-empty">${EMPTY_NOTES}</p>`}
      </section>
      <section class="fu-card">
        <h2>الواجبات</h2>
        ${homework.length ? homework.map((item) => itemCard(item, false, "homework")).join("") : `<p class="fu-empty">${EMPTY_HOMEWORK}</p>`}
      </section>
    </section>
  `;
  box.querySelector("[data-student-close]")?.addEventListener("click", () => box.remove());
}

async function openStudentPortal(civilId) {
  const id = civilDigits(civilId);
  if (id.length !== 10) {
    alert("أدخل السجل المدني المكون من 10 أرقام");
    return;
  }
  let box = document.getElementById("fu-student-portal");
  if (!box) {
    box = document.createElement("div");
    box.id = "fu-student-portal";
    document.body.appendChild(box);
  }
  box.innerHTML = `<section class="fu-student"><p class="fu-empty">جاري عرض ملاحظاتك وواجباتك...</p></section>`;
  try {
    const students = await loadStudents({}, true, id);
    const student = students[0];
    if (!student) throw new Error("لا يوجد طالب بهذا السجل المدني");
    const notes = await loadCollectionForUser("notes", {}, true, id);
    const homework = await loadCollectionForUser("homework", {}, true, id);
    renderStudent(box, student, notes, homework);
  } catch (err) {
    box.innerHTML = `
      <section class="fu-student">
        <p class="fu-flash fu-error">${escapeHtml(humanError(err))}</p>
        <button type="button" class="fu-btn fu-ghost" data-student-close>رجوع</button>
      </section>`;
    box.querySelector("[data-student-close]")?.addEventListener("click", () => box.remove());
  }
}

function injectStudentEntry() {
  document.querySelectorAll("[data-student-login]").forEach((btn) => btn.remove());
}

function watch() {
  let visible = { notes: false, homework: false, whatsapp: false };
  let timer = 0;
  const scan = () => {
    injectStudentEntry();
    const notesOn = Boolean(document.getElementById("followup-root"));
    const hwOn = Boolean(document.getElementById("homework-root"));
    const waOn = Boolean(document.getElementById("whatsapp-root"));
    const notesHost = hostFor("notes");
    const hwHost = hostFor("homework");
    const waHost = hostFor("whatsapp");
    notesHost.hidden = !notesOn;
    hwHost.hidden = !hwOn;
    waHost.hidden = !waOn;
    if (notesOn) placeHost(notesHost);
    if (hwOn) placeHost(hwHost);
    if (waOn) placeHost(waHost);
    if (notesOn && !visible.notes) {
      visible.notes = true;
      mountStaff(notesHost, "notes");
    }
    if (!notesOn) visible.notes = false;
    if (hwOn && !visible.homework) {
      visible.homework = true;
      mountStaff(hwHost, "homework");
    }
    if (!hwOn) visible.homework = false;
    if (waOn && !visible.whatsapp) {
      visible.whatsapp = true;
      mountWhatsApp(waHost);
    }
    if (!waOn) visible.whatsapp = false;
  };
  const queued = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 60);
  };
  new MutationObserver(queued).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", () => {
    const notesHost = document.getElementById("fu-host-notes");
    const hwHost = document.getElementById("fu-host-homework");
    const waHost = document.getElementById("fu-host-whatsapp");
    if (notesHost) placeHost(notesHost);
    if (hwHost) placeHost(hwHost);
    if (waHost) placeHost(waHost);
  });
  scan();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
else watch();
