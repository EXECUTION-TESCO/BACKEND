// Material Requirements (Phase 4) — Execution raises requirements to the Procurement Portal.
// Writes to the shared "material_requests" collection; Procurement reads/updates the same docs.
import { Router } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { Project } from '../db.js';
import { requireAuth } from '../auth.js';
import { clean, ah } from '../utils.js';
import { config, MATERIAL_CATEGORIES } from '../config.js';
import { materialModels, nextMaterialRef } from '../material-request-model.js';

const r = Router();
r.use(requireAuth);

const M = materialModels();
const isHead = (u) => u.role === 'head';
const actorOf = (u) => ({ id: u._id, name: u.name, role: u.role, portal: 'execution' });

// BOQ documents (Excel / PDF) live in the shared "material_boq" GridFS bucket so the Execution
// team AND the Procurement team can view/download them. Memoised on the shared connection.
let boqBucketRef;
const boqBucket = () => (boqBucketRef || (boqBucketRef = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'material_boq' })));
const BOQ_OK = /(pdf|excel|spreadsheet|ms-excel|officedocument\.spreadsheetml)/i;
const boqUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

// Can this user see/attach BOQ for a material request? Head, the request's creator, or a member
// assigned to its project (engineer / has a task on it).
async function canAccessMaterial(user, doc) {
  if (isHead(user)) return true;
  if (doc.createdBy && doc.createdBy.id === user._id) return true;
  const p = await Project.findById(doc.projectId, { engineerId: 1, 'dailyTasks.assigneeId': 1 }).lean();
  if (!p) return false;
  if (p.engineerId === user._id) return true;
  return (p.dailyTasks || []).some((t) => t.assigneeId === user._id);
}

// Project ids the member may raise/see materials for (engineer of, or has a task on).
async function myProjectIds(user) {
  const list = await Project.find({ $or: [{ engineerId: user._id }, { 'dailyTasks.assigneeId': user._id }] }, { _id: 1 }).lean();
  return list.map((p) => p._id);
}

// ---- List (optionally for one project) ----
r.get('/', ah(async (req, res) => {
  const q = {};
  if (req.query.projectId) q.projectId = req.query.projectId;
  if (!isHead(req.user)) {
    const ids = await myProjectIds(req.user);
    q.$or = [{ 'createdBy.id': req.user._id }, { projectId: { $in: ids } }];
  }
  const list = await M.MaterialRequest.find(q).sort({ createdAt: -1 }).limit(500);
  res.json({ requests: list.map((x) => x.toJSON()) });
}));

// ---- Raise a requirement (Head, or the project's assigned engineer) ----
r.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const p = await Project.findById(b.projectId);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!isHead(req.user) && p.engineerId !== req.user._id) return res.status(403).json({ error: 'Only the Execution Head or the assigned team member can raise materials for this project' });
  const material = clean(b.material);
  if (!material) return res.status(400).json({ error: 'Enter the material / item name' });

  const category = MATERIAL_CATEGORIES.includes(b.category) ? b.category : '';
  const doc = await M.MaterialRequest.create({
    ref: await nextMaterialRef(M, config.tz),
    projectId: p._id, projectName: p.name, handoverRef: p.handoverRef || null,
    material, spec: clean(b.spec) || '', qty: Number(b.qty) || 0, unit: clean(b.unit) || '',
    neededBy: clean(b.neededBy) || '', notes: clean(b.notes) || '', category, boq: [],
    assigneeId: p.engineerId || req.user._id, deliveryStage: '',
    status: 'Pending Approval',
    createdBy: actorOf(req.user),
    statusLog: [{ to: 'Pending Approval', by: req.user.name, portal: 'execution', at: new Date(), note: 'Request raised' }],
    procurementSeen: false,  // new / pending for Procurement
    requesterSeen: true,
  });
  res.status(201).json({ request: doc.toJSON() });
}));

// ---- Requester marks their status updates as seen (clears the Execution bell) ----
r.patch('/seen', ah(async (req, res) => {
  await M.MaterialRequest.updateMany({ 'createdBy.id': req.user._id, requesterSeen: false }, { $set: { requesterSeen: true } });
  res.json({ ok: true });
}));

// ---- Upload BOQ document(s) (Excel / PDF) to a material request ----
r.post('/:id/boq', boqUpload.array('files', 10), ah(async (req, res) => {
  const doc = await M.MaterialRequest.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Request not found' });
  if (!(await canAccessMaterial(req.user, doc))) return res.status(403).json({ error: 'Not allowed' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files received' });
  const bad = files.find((f) => !BOQ_OK.test(f.mimetype) && !/\.(xlsx?|pdf)$/i.test(f.originalname || ''));
  if (bad) return res.status(400).json({ error: `"${bad.originalname}" is not an Excel or PDF file` });
  const added = [];
  for (const f of files) {
    const stream = boqBucket().openUploadStream(f.originalname, { contentType: f.mimetype, metadata: { materialId: doc._id } });
    await new Promise((resolve, reject) => { stream.on('error', reject); stream.on('finish', resolve); stream.end(f.buffer); });
    added.push({ fileId: String(stream.id), filename: f.originalname, mime: f.mimetype, size: f.size, uploadedAt: new Date(), uploadedBy: req.user.name });
  }
  doc.boq.push(...added);
  await doc.save();
  res.json({ request: doc.toJSON() });
}));

// ---- View / download a BOQ document (token allowed in the URL for <a> links) ----
r.get('/:id/boq/:fileId', ah(async (req, res) => {
  const doc = await M.MaterialRequest.findById(req.params.id, { boq: 1, projectId: 1, createdBy: 1 });
  if (!doc) return res.status(404).end();
  if (!(await canAccessMaterial(req.user, doc))) return res.status(403).end();
  const att = (doc.boq || []).find((a) => a.fileId === req.params.fileId);
  if (!att) return res.status(404).end();
  let oid;
  try { oid = new mongoose.mongo.ObjectId(att.fileId); } catch { return res.status(404).end(); }
  res.set('Content-Type', att.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(att.filename || 'boq')}"`);
  boqBucket().openDownloadStream(oid).on('error', () => res.status(404).end()).pipe(res);
}));

// ---- Delete a requirement (creator or Head) while still Requested ----
r.delete('/:id', ah(async (req, res) => {
  const doc = await M.MaterialRequest.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Request not found' });
  if (!isHead(req.user) && (doc.createdBy && doc.createdBy.id) !== req.user._id) return res.status(403).json({ error: 'Not allowed' });
  if (doc.status !== 'Pending Approval') return res.status(400).json({ error: `A "${doc.status}" requirement can no longer be withdrawn` });
  await doc.deleteOne();
  res.json({ ok: true });
}));

export default r;
