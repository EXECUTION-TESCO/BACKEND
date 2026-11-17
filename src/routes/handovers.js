// Handover review module for the Execution Portal (ADDITIVE — does not change any existing
// route or behaviour). The Execution team views handovers submitted by the Sales Portal,
// downloads attachments, and Accepts / Rejects / Requests Changes. Handovers live in the
// shared "ho_" collections, so both portals always see the same record.
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth, requireHead } from '../auth.js';
import { Project } from '../db.js';
import { ah } from '../utils.js';
import { handoverModels, logActivity, HANDOVER_STATUSES } from '../handover-model.js';

const PREFIX = process.env.HANDOVER_PREFIX || 'ho_';
const HO = handoverModels(PREFIX);
const { Handover, HandoverActivity, HandoverNotification } = HO;

const r = Router();
r.use(requireAuth);

// Lazily open the shared GridFS bucket on the already-connected mongoose connection.
let bucket;
const fileBucket = () => {
  if (!bucket) bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: PREFIX + 'files' });
  return bucket;
};

const actorOf = (user) => ({ id: user._id || user.id, name: user.name, role: user.role, portal: 'execution' });
const clean = (v) => (typeof v === 'string' ? v.trim() : v ?? '');

// Notify the sales owner of a handover.
async function notifyOwner(h, { type, title, message }) {
  if (!h.createdBy?.id) return;
  await HandoverNotification.create({ audience: 'sales', userId: h.createdBy.id, handoverId: h._id, ref: h.ref || null, type, title, message, link: '/handovers' });
}

// The Execution team sees every handover that has been sent (never Sales drafts).
const VISIBLE = ['Submitted', 'Under Review', 'Changes Requested', 'Accepted', 'Rejected'];

// ---- Build an Execution project from an accepted Sales handover ----
function projectFromHandover(h) {
  const d = h.details || {}, sc = h.scope || {}, tl = h.timeline || {};
  const design = [sc.design3D && '3D', sc.design2D && '2D'].filter(Boolean).join(' + ');
  const scopeText = [sc.typeOfProject, sc.projectSizeArea, design && `Design: ${design}`].filter(Boolean).join(' · ');
  const instructions = [
    h.ref && `From Sales handover ${h.ref}`,
    d.salespersonName && `Salesperson: ${d.salespersonName}`,
    d.contactDetails && `Contact: ${d.contactDetails}`,
    tl.leadTimePromised && `Lead time promised: ${tl.leadTimePromised}`,
  ].filter(Boolean).join('\n');
  return {
    name: h.projectName || d.projectLocation || h.clientName || h.ref || 'New Project',
    client: h.clientName || d.clientName || '',
    location: d.projectLocation || d.siteAddress || '',
    scope: scopeText,
    instructions,
    startDate: tl.tentativeStartDate || '',
    expectedDate: tl.tentativeCompletionDate || '',
    status: 'Not Started',
    priority: 'Medium',
    engineerId: null, // Execution Head assigns a team member later, from Projects
    handoverId: h._id,
    handoverRef: h.ref || null,
    handoverAttachments: (h.attachments || []).map((a) => ({ fileId: a.fileId, filename: a.filename, mime: a.mime, size: a.size })),
  };
}

// Create the Execution project for an accepted handover — idempotent (never duplicates,
// even if the same handover is processed twice or two requests race).
async function ensureProjectForHandover(h, byUserId) {
  const existing = await Project.findOne({ handoverId: h._id });
  if (existing) return existing;
  try {
    return await Project.create({ ...projectFromHandover(h), createdBy: byUserId });
  } catch (e) {
    if (e && e.code === 11000) return Project.findOne({ handoverId: h._id }); // unique index caught a race
    throw e;
  }
}

// ---- Dashboard stats ----
r.get('/dashboard', ah(async (req, res) => {
  const all = await Handover.find({ status: { $in: VISIBLE } }).lean();
  const by = (s) => all.filter((h) => h.status === s).length;
  res.json({
    total: all.length,
    submitted: by('Submitted'),
    underReview: by('Under Review'),
    changesRequested: by('Changes Requested'),
    accepted: by('Accepted'),
    rejected: by('Rejected'),
    pending: all.filter((h) => ['Submitted', 'Under Review'].includes(h.status)).length,
  });
}));

// ---- Handover notifications (shown in the Execution Handovers page) ----
r.get('/notifications', ah(async (req, res) => {
  const items = await HandoverNotification.find({ audience: 'execution' }).sort({ createdAt: -1 }).limit(100);
  const out = items.map((n) => n.toJSON());
  res.json({ items: out, unread: out.filter((n) => !n.read).length });
}));
r.post('/notifications/read-all', ah(async (req, res) => {
  await HandoverNotification.updateMany({ audience: 'execution', read: false }, { $set: { read: true } });
  res.json({ ok: true });
}));
r.post('/notifications/:id/read', ah(async (req, res) => {
  await HandoverNotification.updateOne({ _id: req.params.id, audience: 'execution' }, { $set: { read: true } });
  res.json({ ok: true });
}));

// ---- List ----
r.get('/', ah(async (req, res) => {
  const filter = { status: { $in: VISIBLE } };
  if (req.query.status && HANDOVER_STATUSES.includes(req.query.status) && VISIBLE.includes(req.query.status)) filter.status = req.query.status;
  const q = clean(req.query.q).toLowerCase();
  let list = await Handover.find(filter).sort({ updatedAt: -1 }).lean();
  if (q) list = list.filter((h) => [h.ref, h.clientName, h.projectName, h.details?.proposalRefNo, h.details?.leadId, h.createdBy?.name].filter(Boolean).join(' ').toLowerCase().includes(q));
  res.json({ handovers: list.map((h) => ({ ...h, id: h._id, attachmentCount: (h.attachments || []).length })) });
}));

// ---- Detail (+ history) ----
r.get('/:id', ah(async (req, res) => {
  const h = await Handover.findById(req.params.id);
  if (!h || !VISIBLE.includes(h.status)) return res.status(404).json({ error: 'Handover not found' });
  const activity = await HandoverActivity.find({ handoverId: h._id }).sort({ createdAt: 1 });
  res.json({ handover: h.toJSON(), activity: activity.map((a) => a.toJSON()) });
}));

// ---- Download an attachment ----
r.get('/:id/attachments/:fileId', ah(async (req, res) => {
  const h = await Handover.findById(req.params.id);
  if (!h || !VISIBLE.includes(h.status)) return res.status(404).json({ error: 'Handover not found' });
  const att = (h.attachments || []).find((a) => a.fileId === req.params.fileId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  res.set('Content-Type', att.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(att.filename)}"`);
  fileBucket().openDownloadStream(new mongoose.Types.ObjectId(att.fileId)).on('error', () => res.status(404).end()).pipe(res);
}));

// ---- Review: accept / reject (EXECUTION HEAD ONLY) ----
// Accept  → handover marked Accepted AND an Execution project is created (idempotent).
// Reject  → handover marked Rejected; nothing is added to Projects.
r.post('/:id/review', requireHead, ah(async (req, res) => {
  const h = await Handover.findById(req.params.id);
  if (!h || !VISIBLE.includes(h.status)) return res.status(404).json({ error: 'Handover not found' });
  const action = req.body.action;
  const message = clean(req.body.message);
  const from = h.status;
  const by = actorOf(req.user);

  // Only a handover that is still pending (just arrived / under review) can be accepted or rejected.
  if (!['Submitted', 'Under Review'].includes(h.status)) {
    return res.status(400).json({ error: `This handover is already "${h.status}"` });
  }

  let project = null;
  if (action === 'accept') {
    h.status = 'Accepted';
    project = await ensureProjectForHandover(h, req.user._id); // create the project (no duplicates)
  } else if (action === 'reject') {
    if (!message) return res.status(400).json({ error: 'Please give a reason for rejecting' });
    h.status = 'Rejected';
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }

  h.reviewedBy = by;
  h.reviewedAt = new Date();
  h.lastActor = by;
  await h.save();
  await logActivity(HO, h, { type: 'status', fromStatus: from, toStatus: h.status, message: message || `${h.status} by ${req.user.name}`, by });

  // Tell the Sales owner the outcome.
  await notifyOwner(h, {
    type: 'status',
    title: action === 'accept' ? `Handover ${h.ref} accepted` : `Handover ${h.ref} rejected`,
    message: message || `${req.user.name} marked it ${h.status}`,
  });

  res.json({ handover: h.toJSON(), projectId: project ? String(project._id || project.id) : null });
}));

// ---- Comment back to the Sales team ----
r.post('/:id/comments', ah(async (req, res) => {
  const h = await Handover.findById(req.params.id);
  if (!h || !VISIBLE.includes(h.status)) return res.status(404).json({ error: 'Handover not found' });
  const message = clean(req.body.message);
  if (!message) return res.status(400).json({ error: 'Enter a comment' });
  await logActivity(HO, h, { type: 'comment', message, by: actorOf(req.user) });
  await notifyOwner(h, { type: 'comment', title: `Comment on ${h.ref}`, message: `${req.user.name}: ${message.slice(0, 80)}` });
  res.json({ ok: true });
}));

export default r;
