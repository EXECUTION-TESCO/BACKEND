// Handover review module for the Execution Portal (ADDITIVE — does not change any existing
// route or behaviour). The Execution team views handovers submitted by the Sales Portal,
// downloads attachments, and Accepts / Rejects / Requests Changes. Handovers live in the
// shared "ho_" collections, so both portals always see the same record.
import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../auth.js';
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

// ---- Review: accept / reject / request-changes / start-review ----
r.post('/:id/review', ah(async (req, res) => {
  const h = await Handover.findById(req.params.id);
  if (!h || !VISIBLE.includes(h.status)) return res.status(404).json({ error: 'Handover not found' });
  const action = req.body.action;
  const message = clean(req.body.message);
  const from = h.status;
  const by = actorOf(req.user);

  const map = {
    'start-review': { allow: ['Submitted'], to: 'Under Review' },
    accept: { allow: ['Submitted', 'Under Review'], to: 'Accepted' },
    reject: { allow: ['Submitted', 'Under Review'], to: 'Rejected', needMsg: true },
    'request-changes': { allow: ['Submitted', 'Under Review'], to: 'Changes Requested', needMsg: true },
  };
  const step = map[action];
  if (!step) return res.status(400).json({ error: 'Unknown action' });
  if (!step.allow.includes(h.status)) return res.status(400).json({ error: `Cannot ${action.replace('-', ' ')} a handover that is "${h.status}"` });
  if (step.needMsg && !message) return res.status(400).json({ error: action === 'reject' ? 'Please give a reason for rejecting' : 'Please describe the changes needed' });

  h.status = step.to;
  h.reviewedBy = by;
  h.reviewedAt = new Date();
  h.lastActor = by;
  await h.save();
  await logActivity(HO, h, { type: 'status', fromStatus: from, toStatus: step.to, message: message || `Marked ${step.to} by ${req.user.name}`, by });

  const titles = {
    'start-review': `Handover ${h.ref} is under review`,
    accept: `Handover ${h.ref} accepted`,
    reject: `Handover ${h.ref} rejected`,
    'request-changes': `Changes requested on ${h.ref}`,
  };
  await notifyOwner(h, { type: 'status', title: titles[action], message: message || `${req.user.name} marked it ${step.to}` });
  res.json({ handover: h.toJSON() });
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
