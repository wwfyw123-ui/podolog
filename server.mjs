import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const adminToken = process.env.ADMIN_TOKEN || "dev-admin";
const dbPath = process.env.DATABASE_PATH || resolve(root, "data", "clinic.sqlite");
const siteConfig = JSON.parse(await readFile(resolve(root, "config", "site.json"), "utf8"));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

await mkdir(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    price_from INTEGER NOT NULL,
    icon TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    starts_at TEXT NOT NULL UNIQUE,
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL UNIQUE REFERENCES slots(id) ON DELETE RESTRICT,
    service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
    patient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    messenger TEXT NOT NULL DEFAULT 'whatsapp',
    comment TEXT NOT NULL DEFAULT '',
    privacy_accepted_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  );
`);

migrateDatabase();
seedDatabase();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (url.pathname === "/api/health" && req.method === "GET") {
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/site" && req.method === "GET") {
      return json(res, 200, publicSiteConfig());
    }

    if (url.pathname === "/api/services" && req.method === "GET") {
      const services = db.prepare(`
        SELECT id, title, description, price_from AS priceFrom, icon
        FROM services
        WHERE active = 1
        ORDER BY sort_order, title
      `).all();
      return json(res, 200, { services });
    }

    if (url.pathname === "/api/slots" && req.method === "GET") {
      const limit = clamp(Number(url.searchParams.get("limit") || 40), 1, 120);
      const slots = db.prepare(`
        SELECT
          slots.id,
          slots.starts_at AS startsAt,
          slots.duration_minutes AS durationMinutes,
          bookings.id AS bookingId
        FROM slots
        LEFT JOIN bookings ON bookings.slot_id = slots.id AND bookings.status != 'cancelled'
        WHERE slots.active = 1 AND slots.starts_at >= ?
        ORDER BY slots.starts_at
        LIMIT ?
      `).all(todayIsoDateTime(), limit);

      return json(res, 200, { slots: slots.map(publicSlot) });
    }

    if (url.pathname === "/api/bookings" && req.method === "POST") {
      const body = await readJson(req);
      const clean = validateBooking(body);
      if (!clean.ok) return json(res, 400, { error: clean.error });

      const service = db.prepare("SELECT id FROM services WHERE id = ? AND active = 1").get(clean.serviceId);
      if (!service) return json(res, 400, { error: "Выберите услугу из списка." });

      const slot = db.prepare("SELECT id FROM slots WHERE id = ? AND active = 1").get(clean.slotId);
      if (!slot) return json(res, 400, { error: "Выбранное время недоступно." });

      const taken = db.prepare(`
        SELECT id FROM bookings
        WHERE slot_id = ? AND status != 'cancelled'
      `).get(clean.slotId);
      if (taken) return json(res, 409, { error: "Это время уже заняли. Выберите другое окно." });

      const id = randomUUID();
      db.prepare(`
        INSERT INTO bookings (
          id, slot_id, service_id, patient_name, phone, messenger, comment, privacy_accepted_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
      `).run(
        id,
        clean.slotId,
        clean.serviceId,
        clean.patientName,
        clean.phone,
        clean.messenger,
        clean.comment,
        new Date().toISOString(),
        new Date().toISOString()
      );

      const booking = getBookingById(id);
      return json(res, 201, { booking });
    }

    if (url.pathname === "/api/admin/bookings" && req.method === "GET") {
      if (!isAdmin(req)) return json(res, 401, { error: "Нужен админ-токен." });
      const bookings = db.prepare(`
        SELECT
          bookings.id,
          bookings.patient_name AS patientName,
          bookings.phone,
          bookings.messenger,
          bookings.comment,
          bookings.status,
          bookings.created_at AS createdAt,
          slots.starts_at AS startsAt,
          services.title AS serviceTitle,
          services.price_from AS priceFrom
        FROM bookings
        JOIN slots ON slots.id = bookings.slot_id
        JOIN services ON services.id = bookings.service_id
        ORDER BY slots.starts_at DESC
      `).all().map(adminBooking);
      return json(res, 200, { bookings });
    }

    const statusMatch = url.pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/status$/);
    if (statusMatch && req.method === "PATCH") {
      if (!isAdmin(req)) return json(res, 401, { error: "Нужен админ-токен." });
      const body = await readJson(req);
      const status = String(body.status || "");
      if (!["new", "confirmed", "done", "cancelled"].includes(status)) {
        return json(res, 400, { error: "Неизвестный статус." });
      }
      const result = db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(status, statusMatch[1]);
      if (result.changes === 0) return json(res, 404, { error: "Запись не найдена." });
      return json(res, 200, { booking: getBookingById(statusMatch[1]) });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "На сервере что-то пошло не так." });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Site: http://127.0.0.1:${port}/`);
    console.log(`Admin: http://127.0.0.1:${port}/admin.html`);
    console.log(`Admin token: ${adminToken}`);
  });
}

export { adminToken, server };

function migrateDatabase() {
  const columns = db.prepare("PRAGMA table_info(bookings)").all().map((column) => column.name);
  if (!columns.includes("privacy_accepted_at")) {
    db.exec("ALTER TABLE bookings ADD COLUMN privacy_accepted_at TEXT NOT NULL DEFAULT ''");
  }
}

function seedDatabase() {
  const upsertService = db.prepare(`
    INSERT INTO services (id, title, description, price_from, icon, sort_order, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      price_from = excluded.price_from,
      icon = excluded.icon,
      sort_order = excluded.sort_order,
      active = 1
  `);

  siteConfig.services.forEach((service) => {
    upsertService.run(
      service.id,
      service.title,
      service.description,
      service.priceFrom,
      service.icon,
      service.sortOrder || 0
    );
  });

  const futureSlots = db.prepare(`
    SELECT COUNT(*) AS count FROM slots
    WHERE starts_at >= ? AND active = 1
  `).get(todayIsoDateTime()).count;

  if (futureSlots >= 18) return;

  const insertSlot = db.prepare(`
    INSERT OR IGNORE INTO slots (id, starts_at, duration_minutes, active)
    VALUES (?, ?, ?, 1)
  `);

  const schedule = siteConfig.schedule;
  let addedDays = 0;
  for (let offset = 0; addedDays < schedule.daysToGenerate && offset < 60; offset += 1) {
    const day = addDays(dateOnly(), offset);
    const weekday = new Date(`${day}T12:00:00`).getDay();
    if (weekday === 0) continue;

    const times = weekday === 6 ? schedule.saturdayTimes : schedule.weekdayTimes;
    times.forEach((time) => {
      const id = `slot-${day}-${time.replace(":", "")}`;
      insertSlot.run(id, `${day}T${time}:00`, schedule.durationMinutes || 60);
    });
    addedDays += 1;
  }
}

function validateBooking(body) {
  const slotId = String(body.slotId || "").trim();
  const serviceId = String(body.serviceId || "").trim();
  const patientName = String(body.patientName || "").trim();
  const phone = String(body.phone || "").trim();
  const messenger = String(body.messenger || "whatsapp").trim();
  const comment = String(body.comment || "").trim();

  if (!slotId) return { ok: false, error: "Выберите время приема." };
  if (!serviceId) return { ok: false, error: "Выберите услугу." };
  if (patientName.length < 2) return { ok: false, error: "Введите имя пациента." };
  if (!/^\+?[0-9\s().-]{7,24}$/.test(phone)) return { ok: false, error: "Введите телефон в понятном формате." };
  if (!["whatsapp", "telegram", "phone"].includes(messenger)) return { ok: false, error: "Выберите способ связи." };
  if (comment.length > 700) return { ok: false, error: "Комментарий слишком длинный." };
  if (body.privacyAccepted !== "on" && body.privacyAccepted !== true) {
    return { ok: false, error: "Нужно согласие на обработку персональных данных." };
  }

  return { ok: true, slotId, serviceId, patientName, phone, messenger, comment };
}

function publicSiteConfig() {
  return {
    clinic: siteConfig.clinic,
    seo: siteConfig.seo,
    hero: siteConfig.hero,
    legal: {
      operatorName: siteConfig.legal.operatorName,
      contactEmail: siteConfig.legal.contactEmail,
    },
  };
}

function getBookingById(id) {
  const booking = db.prepare(`
    SELECT
      bookings.id,
      bookings.patient_name AS patientName,
      bookings.phone,
      bookings.messenger,
      bookings.comment,
      bookings.status,
      bookings.created_at AS createdAt,
      slots.starts_at AS startsAt,
      services.title AS serviceTitle,
      services.price_from AS priceFrom
    FROM bookings
    JOIN slots ON slots.id = bookings.slot_id
    JOIN services ON services.id = bookings.service_id
    WHERE bookings.id = ?
  `).get(id);
  return booking ? adminBooking(booking) : null;
}

function publicSlot(slot) {
  return {
    id: slot.id,
    startsAt: slot.startsAt,
    durationMinutes: slot.durationMinutes,
    available: !slot.bookingId,
    dateLabel: formatDateLabel(slot.startsAt),
    timeLabel: slot.startsAt.slice(11, 16),
  };
}

function adminBooking(row) {
  return {
    ...row,
    dateLabel: formatDateLabel(row.startsAt),
    timeLabel: row.startsAt.slice(11, 16),
    priceLabel: `от ${new Intl.NumberFormat("ru-RU").format(row.priceFrom)} ₽`,
  };
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = resolve(root, `.${requested}`);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const body = await readFile(filePath);
  res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function isAdmin(req) {
  return req.headers["x-admin-token"] === adminToken;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function dateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function todayIsoDateTime() {
  return `${dateOnly()}T00:00:00`;
}

function addDays(date, days) {
  const current = new Date(`${date}T12:00:00`);
  current.setDate(current.getDate() + days);
  return current.toISOString().slice(0, 10);
}

function formatDateLabel(startsAt) {
  const date = new Date(`${startsAt.slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}
