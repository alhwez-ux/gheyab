const PROJECT = "tracker-school";
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

let started = false;
let profile = null;

function da() {
  return window.__DA || null;
}

async function token() {
  const auth = da()?.auth;
  const user = auth?.currentUser;
  if (!user) throw new Error("سجّل الدخول أولاً");
  const cached = user.stsTokenManager?.accessToken || user.accessToken;
  if (cached) return cached;
  return Promise.race([
    user.getIdToken(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("انتهت مهلة قراءة الجلسة")), 8000)),
  ]);
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

async function fsFetch(path, options = {}) {
  const t = await token();
  const method = (options.method || "GET").toUpperCase();
  const headers = { Authorization: `Bearer ${t}` };
  if (method !== "GET" && method !== "HEAD") headers["Content-Type"] = "application/json";
  const res = await fetch(`${FS}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: text } };
  }
  if (!res.ok) {
    const msg = json.error?.message || res.statusText || "تعذر الاتصال بقاعدة البيانات";
    throw new Error(msg);
  }
  return json;
}

async function getProfile() {
  const uid = da()?.auth?.currentUser?.uid;
  if (!uid) return null;
  const doc = await fsFetch(`/users/${uid}`);
  const user = decodeDoc(doc);
  user.id = uid;
  return user;
}

function isAdmin(role) {
  return ADMINS.includes(role);
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

async function listByCollection(name, extra = "") {
  const json = await fsFetch(`/${name}?pageSize=500${extra}`);
  return (json.documents || []).map(decodeDoc);
}

async function queryEquals(collectionId, field, value) {
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
  });
  return (json || [])
    .map((row) => row.document)
    .filter(Boolean)
    .map(decodeDoc);
}

async function loadStudents(user) {
  if (isAdmin(user.role)) return listByCollection("students");
  const keys = user.assignedClasses || [];
  const batches = await Promise.all(keys.map((key) => queryEquals("students", "classKey", key)));
  const map = new Map();
  for (const row of batches.flat()) map.set(row.id, row);
  return [...map.values()];
}

async function loadNotes(user) {
  try {
    if (isAdmin(user.role)) return listByCollection("notes");
    const keys = user.assignedClasses || [];
    const batches = await Promise.all([
      queryEquals("notes", "authorId", user.id),
      ...keys.map((key) => queryEquals("notes", "classKey", key)),
    ]);
    const map = new Map();
    for (const row of batches.flat()) map.set(row.id, row);
    return [...map.values()];
  } catch (err) {
    if (/PERMISSION|403|NOT_FOUND|not found/i.test(String(err.message || err))) return [];
    throw err;
  }
}

async function loadAbsences(student) {
  const reports = isAdmin(profile.role)
    ? await listByCollection("reports")
    : (await Promise.all(
        (profile.assignedClasses || []).map((key) => queryEquals("reports", "classKey", key))
      )).flat();
  const rows = [];
  for (const report of reports) {
    const entries = await loadEntries(report);
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
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows;
}

async function loadEntries(report) {
  if (Array.isArray(report.entries) && report.entries.length && typeof report.entries[0] === "object") {
    return report.entries;
  }
  try {
    const json = await fsFetch(`/reports/${report.id}/entries?pageSize=300`);
    return (json.documents || []).map(decodeDoc);
  } catch {
    return [];
  }
}

function optionList(items, selected, labelFn, valueFn) {
  return items
    .map((item) => {
      const value = valueFn(item);
      const label = labelFn(item);
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function render(root, state) {
  const students = [...state.students].sort((a, b) =>
    `${a.grade}${a.classroom}${a.name}`.localeCompare(`${b.grade}${b.classroom}${b.name}`, "ar")
  );
  const notes = [...state.notes].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const editing = state.editing;
  const missingScope = !isAdmin(profile.role) && !(profile.assignedClasses || []).length;

  root.innerHTML = `
    <section class="fu-wrap">
      <p class="fu-lead">ملاحظات المعلمين تظهر مع غياب الطالب في تقرير واحد للطباعة.</p>
      ${state.error ? `<p class="fu-flash fu-error">${escapeHtml(state.error)}</p>` : ""}
      ${state.success ? `<p class="fu-flash fu-ok">${escapeHtml(state.success)}</p>` : ""}
      ${missingScope
        ? `<p class="fu-flash fu-warn">لم تُسند إليك فصول بعد. راجع الإدارة قبل إضافة الملاحظات.</p>`
        : `
      <form class="fu-card" data-form>
        ${editing ? `<input type="hidden" name="id" value="${escapeAttr(editing.id)}">` : ""}
        <h2>${editing ? "تعديل ملاحظة" : "إضافة ملاحظة نصية"}</h2>
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
        <label>نص الملاحظة
          <textarea name="content" required minlength="3" rows="4" placeholder="اكتب الملاحظة النصية هنا">${escapeHtml(editing?.content || "")}</textarea>
        </label>
        <div class="fu-actions">
          <button type="submit" class="fu-btn">${editing ? "حفظ التعديل" : "إضافة ملاحظة"}</button>
          ${editing ? `<button type="button" class="fu-btn fu-ghost" data-cancel>إلغاء</button>` : ""}
        </div>
      </form>`}
      <div class="fu-toolbar">
        <h2>سجل المتابعة</h2>
        <button type="button" class="fu-btn fu-ghost" data-print ${state.selectedStudent ? "" : "disabled"}>طباعة تقرير الطالب</button>
      </div>
      <label class="fu-filter">عرض تقرير طالب
        <select data-report-student>
          <option value="">اختر طالباً للطباعة</option>
          ${optionList(students, state.selectedStudent || "", (s) => `${s.name} — ${classLabel(s)}`, (s) => s.id)}
        </select>
      </label>
      <div class="fu-list">
        ${notes.length ? notes.map((note) => `
          <article class="fu-note" data-id="${escapeAttr(note.id)}">
            <div class="fu-note-top">
              <strong>${escapeHtml(note.studentName || "")}</strong>
              <span>${escapeHtml(note.grade || "")} / ${escapeHtml(note.classroom || "")}</span>
              <span class="fu-chip">${escapeHtml(note.subject || "")}</span>
            </div>
            <p>${escapeHtml(note.content || "")}</p>
            <div class="fu-note-meta">
              <span>المعلم: ${escapeHtml(note.authorName || "")}</span>
              <span>${escapeHtml(formatWhen(note.createdAt))}</span>
            </div>
            ${(isAdmin(profile.role) || note.authorId === profile.id) ? `
              <div class="fu-note-actions">
                <button type="button" data-edit="${escapeAttr(note.id)}">تعديل</button>
                <button type="button" data-delete="${escapeAttr(note.id)}">حذف</button>
              </div>` : ""}
          </article>`).join("") : `<p class="fu-empty">لا توجد ملاحظات بعد.</p>`}
      </div>
    </section>
  `;

  bind(root, state);
}

function bind(root, state) {
  const form = root.querySelector("[data-form]");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      await saveNote(state, {
        id: data.get("id"),
        studentId: data.get("studentId") || state.editing?.studentId,
        subject: String(data.get("subject") || "").trim(),
        content: String(data.get("content") || "").trim(),
      });
      state.editing = null;
      state.success = "تم حفظ الملاحظة";
      state.error = "";
      state.notes = await loadNotes(profile);
      render(root, state);
    } catch (err) {
      state.error = humanError(err);
      state.success = "";
      render(root, state);
    }
  });

  root.querySelector("[data-cancel]")?.addEventListener("click", () => {
    state.editing = null;
    render(root, state);
  });

  root.querySelector("[data-report-student]")?.addEventListener("change", (event) => {
    state.selectedStudent = event.target.value;
    render(root, state);
  });

  root.querySelector("[data-print]")?.addEventListener("click", () => printReport(state));

  root.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.editing = state.notes.find((note) => note.id === btn.getAttribute("data-edit"));
      render(root, state);
    });
  });

  root.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("حذف هذه الملاحظة؟")) return;
      try {
        await fsFetch(`/notes/${btn.getAttribute("data-delete")}`, { method: "DELETE" });
        state.notes = await loadNotes(profile);
        state.success = "تم حذف الملاحظة";
        state.error = "";
        render(root, state);
      } catch (err) {
        state.error = humanError(err);
        render(root, state);
      }
    });
  });
}

async function saveNote(state, payload) {
  const content = payload.content;
  if (content.length < 3) throw new Error("اكتب نص الملاحظة");
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
    content,
    authorId: profile.id,
    authorName: profile.name || "",
    authorCivilId: profile.civilId || "",
    updatedAt: now,
  };
  if (payload.id) {
    await fsFetch(`/notes/${payload.id}?updateMask.fieldPaths=subject&updateMask.fieldPaths=content&updateMask.fieldPaths=updatedAt`, {
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
  await fsFetch("/notes", {
    method: "POST",
    body: JSON.stringify(encodeFields(body)),
  });
}

function humanError(err) {
  const msg = String(err?.message || err);
  if (/PERMISSION|permission|403/.test(msg)) {
    return "لا توجد صلاحية لحفظ الملاحظات. حدّث قواعد Firestore لمجموعة notes.";
  }
  return msg;
}

async function printReport(state) {
  const student = state.students.find((item) => item.id === state.selectedStudent);
  if (!student) return;
  const notes = state.notes.filter((note) => note.studentId === student.id);
  let absences = [];
  try {
    absences = await loadAbsences(student);
  } catch {
    absences = [];
  }
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
      <p>مدرسة هارون الرشيد الابتدائية — النظام الإلكتروني للمتابعة والغياب</p>
    </header>
    <section class="meta">
      <div><small>اسم الطالب</small><strong>${escapeHtml(student.name)}</strong></div>
      <div><small>الصف والفصل</small><strong>${escapeHtml(classLabel(student))}</strong></div>
      <div><small>السجل المدني</small><strong>${escapeHtml(student.civilId || "")}</strong></div>
    </section>
    <h2>الغياب</h2>
    ${absences.length ? absences.map((item) => `<article><strong>${escapeHtml(item.date)}</strong> — ${escapeHtml(STATUS[item.status] || item.status)} — ${escapeHtml(item.teacherName)}${item.time ? " · " + escapeHtml(item.time) : ""}</article>`).join("") : "<p>لا توجد سجلات غياب.</p>"}
    <h2>ملاحظات المعلمين</h2>
    ${notes.length ? notes.map((note) => `<article><div class="chip">${escapeHtml(note.subject)}</div><p>${escapeHtml(note.content)}</p><small>المعلم: ${escapeHtml(note.authorName)} — ${escapeHtml(formatWhen(note.createdAt))}</small></article>`).join("") : "<p>لا توجد ملاحظات مسجّلة لهذا الطالب حتى الآن.</p>"}
    </body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

async function mount(root) {
  const setMsg = (text) => {
    const live = document.getElementById("followup-root");
    if (live) live.innerHTML = `<p class="fu-empty">${escapeHtml(text)}</p>`;
  };
  setMsg("جاري تحميل المتابعة...");
  try {
    await waitForAuth();
    setMsg("جاري قراءة الحساب...");
    profile = await getProfile();
    if (!profile) throw new Error("تعذر قراءة حسابك");
    setMsg("جاري تحميل الطلاب والملاحظات...");
    const state = {
      students: await loadStudents(profile),
      notes: await loadNotes(profile),
      editing: null,
      selectedStudent: "",
      error: "",
      success: "",
    };
    const live = document.getElementById("followup-root");
    if (live) render(live, state);
  } catch (err) {
    const live = document.getElementById("followup-root");
    if (live) live.innerHTML = `<p class="fu-flash fu-error">${escapeHtml(humanError(err))}</p>`;
    started = false;
  }
}

function waitForAuth() {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const tick = () => {
      if (da()?.auth?.currentUser) return resolve();
      if (Date.now() - began > 12000) {
        return reject(new Error(da() ? "انتظر اكتمال تسجيل الدخول ثم افتح المتابعة" : "تعذر ربط المتابعة بنظام الغياب. حدّث الصفحة بـ Ctrl+F5"));
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

function watch() {
  const scan = () => {
    const root = document.getElementById("followup-root");
    if (!root) {
      started = false;
      return;
    }
    if (started) return;
    started = true;
    mount(root);
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", watch);
} else {
  watch();
}
