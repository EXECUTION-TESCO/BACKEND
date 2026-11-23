import { Router } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import path from 'path';
import { Report, Project, Comment, photoBucket, newId } from '../db.js';
import { requireAuth } from '../auth.js';
import { MATERIAL_STATUSES, PROJECT_STATUSES, WORK_ACTIVITIES } from '../config.js';
import { clean, todayStr, ah } from '../utils.js';
import { notifyHeads, notify } from '../notify.js';
import { handoverModels, logActivity } from '../handover-model.js';

const r = Router();
r.use(requireAuth);

const HO = handoverModels(process.env.HANDOVER_PREFIX || 'ho_');

// Mirror a daily update onto its source Sales handover (so Sales can follow progress + export),
// and log it on the handover history. Non-fatal — a failure here never blocks the report.
async function mirrorUpdateToHandover(project, rep, actor) {
  if (!project.handoverId) return;
  try {
    const snap = {
      reportId: String(rep._id), reportDate: rep.reportDate, engineerName: rep.engineerName,
      projectStatus: rep.projectStatus, progressPercent: rep.progressPercent,
      todayProgress: rep.todayProgress, workCompleted: rep.workCompleted, tomorrowPlan: rep.tomorrowPlan,
      materialRequired: rep.materialRequired, materialStatus: rep.materialStatus, issues: rep.issues, remarks: rep.remarks,
      photoCount: (rep.photos || []).length, createdAt: rep.createdAt || new Date(),
    };
    await HO.Handover.updateOne({ _id: project.handoverId }, { $push: { executionUpdates: { $each: [snap], $position: 0, $slice: 500 } } });
    const h = await HO.Handover.findById(project.handoverId);
    if (h) await logActivity(HO, h, { type: 'update', message: `Daily update (${rep.reportDate}) — ${rep.projectStatus}${rep.progressPercent != null ? ` · ${rep.progressPercent}%` : ''}`, by: actor });
  } catch (e) { /* non-fatal */ }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.mimetype)),
});

const visible = (u) => (u.role === 'head' ? {} : { engineerId: u._id });

export function reportFilter(user, q) {
  const f = { ...visible(user) };
  if (q.date) f.reportDate = String(q.date);
  if (q.from || q.to) f.reportDate = { ...(q.from ? { $gte: String(q.from) } : {}), ...(q.to ? { $lte: String(q.to) } : {}) };
  if (q.engineerId && user.role === 'head') f.engineerId = String(q.engineerId);
  if (q.projectId) f.projectId = String(q.projectId);
  if (q.material === 'open') { f.materialRequired = { $nin: ['', null] }; f.materialStatus = { $ne: 'Delivered' }; }
  if (q.q) {
    const rx = new RegExp(String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = ['projectName', 'engineerName', 'todayProgress', 'workCompleted', 'materialRequired', 'issues'].map((k) => ({ [k]: rx }));
  }
  return f;
}
export const findReports = (user, q) => Report.find(reportFilter(user, q)).sort({ reportDate: -1, createdAt: -1 }).limit(5000);

r.get('/', ah(async (req, res) => {
  const list = (await findReports(req.user, req.query)).map((x) => x.toJSON());
  // Resolve the client name per report from its project (covers reports saved before `client` existed).
  const ids = [...new Set(list.map((r) => r.projectId).filter(Boolean))];
  if (ids.length) {
    const byId = Object.fromEntries((await Project.find({ _id: { $in: ids } }, { client: 1 }).lean()).map((p) => [p._id, p.client]));
    for (const r of list) if (!r.client) r.client = byId[r.projectId] || '';
  }
  res.json(list);
}));

r.get('/:id', ah(async (req, res) => {
  const rep = await Report.findOne({ _id: req.params.id, ...visible(req.user) });
  if (!rep) return res.status(404).json({ error: 'Report not found' });
  const [previous, comments, project] = await Promise.all([
    Report.findOne({ projectId: rep.projectId, createdAt: { $lt: rep.createdAt } }).sort({ createdAt: -1 }),
    Comment.find({ reportId: rep._id }).sort({ createdAt: 1 }),
    Project.findById(rep.projectId),
  ]);
  res.json({ report: rep, previous, comments, project });
}));

function storePhoto(file, date, meta) {
  return new Promise((resolve, reject) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().replace(/[^.a-z0-9]/g, '');
    const stream = photoBucket().openUploadStream(`${date}/${newId()}${ext}`, { contentType: file.mimetype, metadata: { ...meta, reportDate: date, originalName: file.originalname } });
    stream.on('error', reject).on('finish', () => resolve(stream.id));
    stream.end(file.buffer);
  });
}

r.post('/', upload.array('photos', 20), ah(async (req, res) => {
  const b = req.body;
  const p = await Project.findById(b.projectId);
  if (!p) return res.status(400).json({ error: 'Select a site / project' });
  if (req.user.role !== 'head' && p.engineerId !== req.user._id) return res.status(403).json({ error: 'This site is not assigned to you' });
  const hasTodayActs = (() => { try { const a = JSON.parse(b.todayActivities || '[]'); return Array.isArray(a) && a.length > 0; } catch { return false; } })();
  if (!clean(b.todayProgress) && !clean(b.workCompleted) && !hasTodayActs) return res.status(400).json({ error: "Select today's work activity or fill in today's progress" });

  const date = todayStr();
  const reportId = newId();
  const photos = [];
  for (const f of req.files || []) {
    const fileId = await storePhoto(f, date, { reportId, projectId: p._id, engineerId: req.user._id });
    photos.push({ id: newId(), fileId: String(fileId), originalName: f.originalname, size: f.size, contentType: f.mimetype, uploadedAt: new Date() });
  }
  const progress = b.progressPercent !== undefined && b.progressPercent !== '' ? Math.max(0, Math.min(100, Number(b.progressPercent) || 0)) : null;
  const projectStatus = PROJECT_STATUSES.includes(b.projectStatus) ? b.projectStatus : p.status;
  const materialRequired = clean(b.materialRequired);
  // Work activities arrive as a JSON array (multipart). Keep only values from the fixed list.
  const parseActs = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter((x) => WORK_ACTIVITIES.includes(x)) : []; } catch { return []; } };
  const todayActivities = parseActs(b.todayActivities);
  const tomorrowActivities = parseActs(b.tomorrowActivities);
  const rep = await Report.create({
    _id: reportId,
    engineerId: req.user._id, engineerName: req.user.name, projectId: p._id, projectName: p.name, client: p.client || '', siteLocation: p.location,
    reportDate: date,
    todayActivities, tomorrowActivities,
    todayProgress: clean(b.todayProgress), workCompleted: clean(b.workCompleted), tomorrowPlan: clean(b.tomorrowPlan),
    materialRequired, materialStatus: materialRequired ? (MATERIAL_STATUSES.includes(b.materialStatus) ? b.materialStatus : 'Required') : '',
    issues: clean(b.issues), remarks: clean(b.remarks), progressPercent: progress, projectStatus, photos,
  });

  // reflect latest status / progress on the project (reports themselves are never overwritten)
  const oldStatus = p.status;
  p.status = projectStatus;
  if (progress !== null) p.progressPercent = progress;
  await p.save();

  await notifyHeads({ type: 'report', title: `Daily update: ${p.name}`, message: `${req.user.name} submitted today's update${photos.length ? ` with ${photos.length} photo(s)` : ''}.`, link: `/reports/${rep._id}` }, req.user._id);
  if (materialRequired && rep.materialStatus === 'Required') await notifyHeads({ type: 'material', title: `Material requested – ${p.name}`, message: `${req.user.name}: ${materialRequired}`, link: `/reports/${rep._id}` }, req.user._id);
  if (oldStatus !== projectStatus) await notifyHeads({ type: 'status', title: 'Project status changed', message: `${p.name}: ${oldStatus} → ${projectStatus}`, link: `/projects/${p._id}` }, req.user._id);
  // Mirror the update onto the Sales handover (progress visible to Sales + exportable).
  await mirrorUpdateToHandover(p, rep, { id: req.user._id, name: req.user.name, role: req.user.role, portal: 'execution' });
  res.status(201).json(rep);
}));

// Material tracking (Required -> Ordered -> Delivered) with history. Report text is never changed.
r.patch('/:id/material', ah(async (req, res) => {
  const rep = await Report.findOne({ _id: req.params.id, ...visible(req.user) });
  if (!rep) return res.status(404).json({ error: 'Report not found' });
  if (!MATERIAL_STATUSES.includes(req.body.materialStatus)) return res.status(400).json({ error: 'Invalid material status' });
  rep.materialHistory.push({ from: rep.materialStatus, to: req.body.materialStatus, by: req.user.name, at: new Date() });
  rep.materialStatus = req.body.materialStatus;
  await rep.save();
  if (req.user.role === 'head') await notify(rep.engineerId, { type: 'material', title: `Material ${req.body.materialStatus.toLowerCase()}`, message: `${rep.projectName}: ${rep.materialRequired}`, link: `/reports/${rep._id}` });
  res.json(rep);
}));

// Secure photo stream from GridFS: /api/reports/:id/photos/:photoId?token=...&download=1
r.get('/:id/photos/:photoId', ah(async (req, res) => {
  const rep = await Report.findOne({ _id: req.params.id, ...visible(req.user) }, { photos: 1, projectName: 1, reportDate: 1 });
  const ph = rep?.photos.find((x) => x.id === req.params.photoId);
  if (!ph) return res.status(404).end();
  let fid;
  try { fid = new mongoose.mongo.ObjectId(ph.fileId); } catch { return res.status(404).end(); }
  res.set('Content-Type', ph.contentType || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  if (req.query.download) {
    const safe = `${rep.projectName}_${rep.reportDate}_${ph.originalName || 'photo.jpg'}`.replace(/[^\w.\- ]+/g, '_');
    res.set('Content-Disposition', `attachment; filename="${safe}"`);
  }
  photoBucket().openDownloadStream(fid).on('error', () => res.status(404).end()).pipe(res);
}));

export default r;
