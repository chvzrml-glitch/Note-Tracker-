import { firebaseConfig } from "./firebase-config.js";

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  getDocs,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

const LOCAL = {
  subjects: "mynotes_subjects",
  notes: "mynotes_notes",
  reminders: "mynotes_reminders",
};

const defaultSubjectColors = [
  "#4f7cff",
  "#59c98b",
  "#ffbf4b",
  "#ff6475",
  "#9a5cff",
  "#42c7d9"
];

let subjects = [];
let notes = [];
let reminders = [];
let currentUser = null;
let unsubscribers = [];

let selectedDate = new Date();
selectedDate.setHours(0, 0, 0, 0);

const firebaseConfigured =
  firebaseConfig.apiKey &&
  !firebaseConfig.apiKey.includes("PASTE_") &&
  firebaseConfig.projectId &&
  !firebaseConfig.projectId.includes("PASTE_");

let auth = null;
let db = null;

if (firebaseConfigured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    updateAuthUI();

    stopListeners();

    if (user) {
      await migrateLocalDataIfNeeded(user.uid);
      startRealtimeListeners(user.uid);
      $("authModal").classList.add("hidden");
    } else {
      subjects = [];
      notes = [];
      reminders = [];
      renderAll();
    }
  });
} else {
  $("firebaseSetupBanner").classList.remove("hidden");
  loadLocalPreview();
}

function loadLocalPreview() {
  const rawSubjects = JSON.parse(localStorage.getItem(LOCAL.subjects)) || [
    { name: "IT0017", color: "#4f7cff" },
    { name: "CCS0023", color: "#59c98b" },
    { name: "ITE0003", color: "#ffbf4b" }
  ];

  subjects = rawSubjects.map((subject, index) =>
    typeof subject === "string"
      ? { name: subject, color: defaultSubjectColors[index % defaultSubjectColors.length] }
      : subject
  );

  notes = JSON.parse(localStorage.getItem(LOCAL.notes)) || [];
  reminders = JSON.parse(localStorage.getItem(LOCAL.reminders)) || [];

  renderAll();
}

function userPath(uid, collectionName) {
  return collection(db, "users", uid, collectionName);
}

function stopListeners() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
}

function startRealtimeListeners(uid) {
  unsubscribers.push(
    onSnapshot(userPath(uid, "subjects"), (snapshot) => {
      subjects = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      renderSubjects();
      renderReminders();
      renderNotes();
    })
  );

  unsubscribers.push(
    onSnapshot(userPath(uid, "notes"), (snapshot) => {
      notes = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotes();
    })
  );

  unsubscribers.push(
    onSnapshot(userPath(uid, "reminders"), (snapshot) => {
      reminders = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderReminders();
    })
  );
}

async function migrateLocalDataIfNeeded(uid) {
  const subjectsRef = userPath(uid, "subjects");
  const notesRef = userPath(uid, "notes");
  const remindersRef = userPath(uid, "reminders");

  const [subjectSnap, noteSnap, reminderSnap] = await Promise.all([
    getDocs(subjectsRef),
    getDocs(notesRef),
    getDocs(remindersRef)
  ]);

  // Only auto-migrate when the cloud account is empty.
  if (!subjectSnap.empty || !noteSnap.empty || !reminderSnap.empty) return;

  const localSubjectsRaw = JSON.parse(localStorage.getItem(LOCAL.subjects)) || [];
  const localNotes = JSON.parse(localStorage.getItem(LOCAL.notes)) || [];
  const localReminders = JSON.parse(localStorage.getItem(LOCAL.reminders)) || [];

  const localSubjects = localSubjectsRaw.map((subject, index) =>
    typeof subject === "string"
      ? { name: subject, color: defaultSubjectColors[index % defaultSubjectColors.length] }
      : subject
  );

  if (!localSubjects.length && !localNotes.length && !localReminders.length) {
    const defaults = [
      { name: "IT0017", color: "#4f7cff" },
      { name: "CCS0023", color: "#59c98b" },
      { name: "ITE0003", color: "#ffbf4b" }
    ];

    const batch = writeBatch(db);
    defaults.forEach((subject, index) => {
      const id = safeId(subject.name);
      batch.set(doc(db, "users", uid, "subjects", id), {
        ...subject,
        createdAt: Date.now() + index
      });
    });
    await batch.commit();
    return;
  }

  const batch = writeBatch(db);

  localSubjects.forEach((subject, index) => {
    batch.set(doc(db, "users", uid, "subjects", safeId(subject.name)), {
      name: subject.name,
      color: subject.color || defaultSubjectColors[index % defaultSubjectColors.length],
      createdAt: Date.now() + index
    });
  });

  localNotes.forEach((note) => {
    const id = note.id || crypto.randomUUID();
    batch.set(doc(db, "users", uid, "notes", id), {
      date: note.date,
      subject: note.subject,
      text: note.text,
      createdAt: note.createdAt || Date.now()
    });
  });

  localReminders.forEach((reminder) => {
    const id = reminder.id || crypto.randomUUID();
    batch.set(doc(db, "users", uid, "reminders", id), {
      date: reminder.date,
      text: reminder.text,
      time: reminder.time || "",
      subject: reminder.subject || "",
      done: !!reminder.done,
      createdAt: reminder.createdAt || Date.now()
    });
  });

  await batch.commit();
}

function requireUser() {
  if (!firebaseConfigured) {
    alert("Add your Firebase configuration first.");
    return false;
  }

  if (!currentUser) {
    $("authModal").classList.remove("hidden");
    return false;
  }

  return true;
}

function safeId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatShort(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

function formatLong(date) {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatDay(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function cloneDate(date, offset) {
  const d = new Date(date);
  d.setDate(d.getDate() + offset);
  return d;
}

function renderDates() {
  $("dateBefore").textContent = formatShort(cloneDate(selectedDate, -1));
  $("currentDateChip").textContent = formatShort(selectedDate);
  $("dateAfter").textContent = formatShort(cloneDate(selectedDate, 1));
  $("reminderDateText").textContent = formatDay(selectedDate);
  $("notesTitle").textContent = `Notes for ${formatLong(selectedDate)}`;
}

function renderSubjects() {
  const list = $("subjectList");
  list.innerHTML = "";

  if (!currentUser && firebaseConfigured) {
    list.innerHTML = '<div class="empty-state">Sign in to load subjects.</div>';
    return;
  }

  subjects.forEach((subject) => {
    const row = document.createElement("div");
    row.className = "subject-item";

    const left = document.createElement("div");
    left.className = "subject-label";

    const dot = document.createElement("span");
    dot.className = "subject-dot";
    dot.style.background = subject.color;

    const name = document.createElement("span");
    name.textContent = subject.name;

    left.append(dot, name);

    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete subject";
    del.addEventListener("click", async () => {
      if (!requireUser()) return;

      if (confirm(`Delete ${subject.name}? Existing notes will stay saved.`)) {
        await deleteDoc(doc(db, "users", currentUser.uid, "subjects", subject.id || safeId(subject.name)));
      }
    });

    row.append(left, del);
    list.appendChild(row);
  });
}

function renderSubjectOptions() {
  const wrap = $("subjectOptions");
  wrap.innerHTML = "";

  if (!subjects.length) {
    wrap.innerHTML = '<div class="empty-state">Add a subject from the left sidebar first.</div>';
    return;
  }

  subjects.forEach((subject) => {
    const btn = document.createElement("button");
    btn.className = "subject-option";
    btn.innerHTML = `<span class="subject-dot" style="background:${subject.color}"></span><span>${escapeHtml(subject.name)}</span>`;
    btn.addEventListener("click", () => saveNoteWithSubject(subject.name));
    wrap.appendChild(btn);
  });
}

async function saveNoteWithSubject(subject) {
  if (!requireUser()) return;

  const text = $("noteInput").value.trim();
  if (!text) return;

  const id = crypto.randomUUID();

  await setDoc(doc(db, "users", currentUser.uid, "notes", id), {
    date: dateKey(selectedDate),
    subject,
    text,
    createdAt: Date.now()
  });

  $("noteInput").value = "";
  $("subjectModal").classList.add("hidden");
}

function getSubjectColor(subjectName) {
  return subjects.find((subject) => subject.name === subjectName)?.color || "#4f7cff";
}

function renderNotes() {
  const key = dateKey(selectedDate);
  const query = $("searchInput").value.trim().toLowerCase();
  let dayNotes = notes.filter((n) => n.date === key);

  if (query) {
    dayNotes = dayNotes.filter((n) =>
      `${n.subject} ${n.text}`.toLowerCase().includes(query)
    );
  }

  dayNotes.sort((a, b) =>
    $("sortSelect").value === "oldest"
      ? a.createdAt - b.createdAt
      : b.createdAt - a.createdAt
  );

  const list = $("notesList");
  list.innerHTML = "";

  if (!currentUser && firebaseConfigured) {
    list.innerHTML = '<div class="empty-state">Sign in to see your cloud notes.</div>';
    return;
  }

  if (!dayNotes.length) {
    list.innerHTML = '<div class="empty-state">No notes for this date yet.</div>';
    return;
  }

  dayNotes.forEach((note) => {
    const card = document.createElement("article");
    card.className = "note-card";
    card.style.borderLeft = `5px solid ${getSubjectColor(note.subject)}`;

    const created = new Date(note.createdAt);
    const time = created.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    card.innerHTML = `
      <div class="note-card-top">
        <div class="note-subject">${escapeHtml(note.subject)}</div>
        <div class="note-time">${time}</div>
      </div>
      <p class="note-preview">${escapeHtml(note.text)}</p>
      <div class="note-actions">
        <button data-edit="${note.id}">Edit</button>
        <button class="delete" data-delete="${note.id}">Delete</button>
      </div>
    `;

    list.appendChild(card);
  });

  list.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!requireUser()) return;
      await deleteDoc(doc(db, "users", currentUser.uid, "notes", btn.dataset.delete));
    });
  });

  list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!requireUser()) return;

      const note = notes.find((n) => n.id === btn.dataset.edit);
      if (!note) return;

      const updated = prompt("Edit note:", note.text);
      if (updated === null) return;

      await setDoc(
        doc(db, "users", currentUser.uid, "notes", note.id),
        { ...note, text: updated.trim() },
        { merge: true }
      );
    });
  });
}

function renderReminders() {
  const key = dateKey(selectedDate);
  const dayReminders = reminders
    .filter((r) => r.date === key)
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  const row = $("reminderRow");
  row.innerHTML = "";

  if (!currentUser && firebaseConfigured) {
    row.innerHTML = '<div class="empty-state">Sign in to see your reminders.</div>';
    return;
  }

  if (!dayReminders.length) {
    row.innerHTML = '<div class="empty-state">No reminders for this date.</div>';
    return;
  }

  dayReminders.forEach((reminder) => {
    const card = document.createElement("div");
    card.className = `reminder-card${reminder.done ? " done" : ""}`;
    card.style.borderLeft = `5px solid ${getSubjectColor(reminder.subject)}`;

    card.innerHTML = `
      <div class="reminder-card-top">
        <input type="checkbox" ${reminder.done ? "checked" : ""} data-reminder-check="${reminder.id}" />
        <strong>${escapeHtml(reminder.text)}</strong>
      </div>
      <p>${escapeHtml(reminder.subject || "General")} ${reminder.time ? "• " + reminder.time : ""}</p>
    `;

    row.appendChild(card);
  });

  row.querySelectorAll("[data-reminder-check]").forEach((check) => {
    check.addEventListener("change", async () => {
      if (!requireUser()) return;

      await setDoc(
        doc(db, "users", currentUser.uid, "reminders", check.dataset.reminderCheck),
        { done: check.checked },
        { merge: true }
      );
    });
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function changeDate(offset) {
  selectedDate.setDate(selectedDate.getDate() + offset);
  renderAll();
}

function renderAll() {
  renderDates();
  renderSubjects();
  renderNotes();
  renderReminders();
}

function updateAuthUI() {
  const btn = $("accountBtn");

  if (currentUser) {
    btn.textContent = currentUser.email || "Account";
    btn.classList.add("signed-in");
    btn.title = "Click to sign out";
  } else {
    btn.textContent = "Sign in";
    btn.classList.remove("signed-in");
    btn.title = "";
  }
}

function showAuthMessage(message, type = "") {
  const box = $("authMessage");
  box.textContent = message;
  box.className = `auth-message ${type}`.trim();
}

function friendlyAuthError(error) {
  const code = error?.code || "";

  const messages = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/email-already-in-use": "That email already has an account.",
    "auth/weak-password": "Use a stronger password (at least 6 characters).",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Try again later."
  };

  return messages[code] || error?.message || "Something went wrong.";
}

$("sidebarToggle").addEventListener("click", () => {
  if (window.innerWidth <= 760) {
    $("sidebar").classList.remove("mobile-open");
  } else {
    $("sidebar").classList.toggle("collapsed");
  }
});

$("mobileMenuBtn").addEventListener("click", () => {
  $("sidebar").classList.add("mobile-open");
});

$("prevDate").addEventListener("click", () => changeDate(-1));
$("nextDate").addEventListener("click", () => changeDate(1));
$("dateBefore").addEventListener("click", () => changeDate(-1));
$("dateAfter").addEventListener("click", () => changeDate(1));

$("addSubjectBtn").addEventListener("click", async () => {
  if (!requireUser()) return;

  const value = $("newSubjectInput").value.trim().toUpperCase();
  const color = $("newSubjectColor").value;
  if (!value) return;

  if (!subjects.some((subject) => subject.name === value)) {
    await setDoc(
      doc(db, "users", currentUser.uid, "subjects", safeId(value)),
      {
        name: value,
        color,
        createdAt: Date.now()
      }
    );

    $("newSubjectInput").value = "";
    $("newSubjectColor").value =
      defaultSubjectColors[subjects.length % defaultSubjectColors.length];
  }
});

$("newSubjectInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("addSubjectBtn").click();
});

$("saveNoteBtn").addEventListener("click", () => {
  if (!requireUser()) return;

  if (!$("noteInput").value.trim()) {
    alert("Write a note first.");
    return;
  }

  renderSubjectOptions();
  $("subjectModal").classList.remove("hidden");
});

$("closeSubjectModal").addEventListener("click", () => {
  $("subjectModal").classList.add("hidden");
});

$("addReminderBtn").addEventListener("click", () => {
  if (!requireUser()) return;

  const select = $("reminderSubject");
  select.innerHTML = '<option value="">General</option>';

  subjects.forEach((subject) => {
    const option = document.createElement("option");
    option.value = subject.name;
    option.textContent = subject.name;
    select.appendChild(option);
  });

  $("reminderText").value = "";
  $("reminderTime").value = "";
  $("reminderModal").classList.remove("hidden");
});

$("closeReminderModal").addEventListener("click", () => {
  $("reminderModal").classList.add("hidden");
});

$("saveReminderBtn").addEventListener("click", async () => {
  if (!requireUser()) return;

  const text = $("reminderText").value.trim();

  if (!text) {
    alert("Enter a reminder.");
    return;
  }

  const id = crypto.randomUUID();

  await setDoc(doc(db, "users", currentUser.uid, "reminders", id), {
    date: dateKey(selectedDate),
    text,
    time: $("reminderTime").value,
    subject: $("reminderSubject").value,
    done: false,
    createdAt: Date.now()
  });

  $("reminderModal").classList.add("hidden");
});

$("scrollReminderLeft").addEventListener("click", () => {
  $("reminderRow").scrollBy({ left: -260, behavior: "smooth" });
});

$("scrollReminderRight").addEventListener("click", () => {
  $("reminderRow").scrollBy({ left: 260, behavior: "smooth" });
});

$("searchInput").addEventListener("input", renderNotes);
$("sortSelect").addEventListener("change", renderNotes);

$("accountBtn").addEventListener("click", async () => {
  if (!firebaseConfigured) {
    $("firebaseSetupBanner").classList.remove("hidden");
    return;
  }

  if (currentUser) {
    if (confirm("Sign out of MyNotes?")) {
      await signOut(auth);
    }
  } else {
    showAuthMessage("");
    $("authModal").classList.remove("hidden");
  }
});

$("closeAuthModal").addEventListener("click", () => {
  $("authModal").classList.add("hidden");
});

$("loginBtn").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;

  if (!email || !password) {
    showAuthMessage("Enter your email and password.", "error");
    return;
  }

  try {
    showAuthMessage("Signing in...");
    await signInWithEmailAndPassword(auth, email, password);
    showAuthMessage("Signed in!", "success");
  } catch (error) {
    showAuthMessage(friendlyAuthError(error), "error");
  }
});

$("registerBtn").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;

  if (!email || !password) {
    showAuthMessage("Enter an email and password first.", "error");
    return;
  }

  try {
    showAuthMessage("Creating account...");
    await createUserWithEmailAndPassword(auth, email, password);
    showAuthMessage("Account created!", "success");
  } catch (error) {
    showAuthMessage(friendlyAuthError(error), "error");
  }
});

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    if (window.innerWidth <= 760) {
      $("sidebar").classList.remove("mobile-open");
    }
  });
});

renderAll();
