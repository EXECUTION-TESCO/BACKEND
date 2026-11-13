// One-time import of data created while the portal used the local file (Backend/data/db.json + uploads/)
// into MongoDB. Existing MongoDB records with the same id are left unchanged (safe to run twice).
// Run:  npm run migrate:local
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { ROOT } from '../src/config.js';
import { connectDB, User, Project, Report, Comment, Notification, photoBucket } from '../src/db.js';

const file = path.join(ROOT, 'data', 'db.json');
if (!fs.existsSync(file)) { console.log('No local data file found (Backend/data/db.json) – nothing to migrate.'); process.exit(0); }
const local = JSON.parse(fs.readFileSync(file, 'utf8'));
await connectDB();

const d = (v) => (v ? new Date(v) : undefined);
async function put(Model, rows, map) {
  let added = 0;
  for (const row of rows || []) {
    if (await Model.exists({ _id: row.id })) continue;
    const doc = map(row);
    await Model.collection.insertOne({ _id: row.id, ...doc, createdAt: d(row.createdAt) || new Date(), updatedAt: d(row.updatedAt || row.createdAt) || new Date() });
    added++;
  }
  console.log(`  ${Model.modelName.padEnd(12)} ${added} imported, ${(rows || []).length - added} already present`);
}

console.log('Migrating local data into MongoDB…');
await put(User, local.users, (u) => ({
  name: u.name, username: u.username.toLowerCase(), employeeId: u.employeeId || undefined, email: u.email || undefined, phone: u.phone || '',
  designation: u.designation || '', role: u.role, active: u.active !== false, passwordHash: u.passwordHash, tokenVersion: 0,
  mustChangePassword: !!u.mustChangePassword, passwordSetAt: d(u.passwordSetAt), pendingSeenDate: u.pendingSeenDate, createdBy: u.createdBy,
}));
await put(Project, local.projects, (p) => ({
  name: p.name, client: p.client, location: p.location, engineerId: p.engineerId || null, startDate: p.startDate, expectedDate: p.expectedDate,
  scope: p.scope, priority: p.priority || 'Medium', instructions: p.instructions, status: p.status || 'Not Started', progressPercent: p.progressPercent || 0,
  assignmentHistory: (p.assignmentHistory || []).map((h) => ({ engineerId: h.engineerId, at: d(h.at), by: h.by })), createdBy: p.createdBy,
}));

// reports: copy photo files from uploads/ into GridFS
const uploadDir = path.join(ROOT, 'uploads');
const reports = [];
for (const r of local.reports || []) {
  const photos = [];
  for (const ph of r.photos || []) {
    const fp = path.join(uploadDir, ph.file || '');
    if (!ph.file || !fs.existsSync(fp)) continue;
    const id = await new Promise((res, rej) => {
      const s = photoBucket().openUploadStream(ph.file, { contentType: 'image/jpeg', metadata: { reportId: r.id, projectId: r.projectId, reportDate: r.reportDate, originalName: ph.originalName } });
      fs.createReadStream(fp).pipe(s).on('error', rej).on('finish', () => res(s.id));
    });
    photos.push({ id: ph.id, fileId: String(id), originalName: ph.originalName, size: ph.size, contentType: 'image/jpeg', uploadedAt: d(ph.uploadedAt) });
  }
  reports.push({ ...r, photos });
}
await put(Report, reports, (r) => ({
  engineerId: r.engineerId, engineerName: r.engineerName, projectId: r.projectId, projectName: r.projectName, siteLocation: r.siteLocation, reportDate: r.reportDate,
  todayProgress: r.todayProgress, workCompleted: r.workCompleted, tomorrowPlan: r.tomorrowPlan, materialRequired: r.materialRequired, materialStatus: r.materialStatus || '',
  materialHistory: (r.materialHistory || []).map((h) => ({ ...h, at: d(h.at) })), issues: r.issues, remarks: r.remarks, progressPercent: r.progressPercent ?? null,
  projectStatus: r.projectStatus, photos: r.photos,
}));
await put(Comment, local.comments, (c) => ({ projectId: c.projectId, reportId: c.reportId || null, authorId: c.authorId, authorName: c.authorName, authorRole: c.authorRole, text: c.text }));
await put(Notification, local.notifications, (n) => ({ userId: n.userId, type: n.type, title: n.title, message: n.message, link: n.link || '', read: !!n.read }));
await mongoose.disconnect();
console.log('Done. You can keep Backend/data as a backup; the portal now reads and writes MongoDB only.');
