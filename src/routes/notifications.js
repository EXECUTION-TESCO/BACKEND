import { Router } from 'express';
import { Notification, Project, Report } from '../db.js';
import { requireAuth } from '../auth.js';
import { todayStr, ah } from '../utils.js';
import { handoverModels } from '../handover-model.js';
import { materialModels } from '../material-request-model.js';

const r = Router();
r.use(requireAuth);

const HO = handoverModels(process.env.HANDOVER_PREFIX || 'ho_');
const MAT = materialModels();

// Material requirements whose Procurement decision (Approved / Rejected / PO Created) the
// user hasn't seen yet. The Execution Head is notified of EVERY decision (they oversee all
// requests); a team member only of the requests they raised.
async function materialItems(user) {
  const q = { requesterSeen: false };
  if (user.role !== 'head') q['createdBy.id'] = user._id;
  const list = await MAT.MaterialRequest.find(q).sort({ updatedAt: -1 }).limit(50);
  return list.map((n) => ({
    id: 'mr-' + (n._id || n.id),
    type: 'material',
    title: `Material ${n.status} — ${n.material}`,
    message: `${n.projectName || 'Project'}${n.poRef ? ' · PO ' + n.poRef : ''}${n.status === 'Rejected' && n.rejectReason ? ' · ' + n.rejectReason : ''}`,
    read: false,
    createdAt: n.updatedAt,
    link: `/projects/${n.projectId}`,
  }));
}

// Handover notifications (shared "ho_" collection) shown in the Execution Head's bell.
async function handoverItems(user) {
  if (user.role !== 'head') return []; // only the Execution Head reviews handovers
  const list = await HO.HandoverNotification.find({ audience: 'execution' }).sort({ createdAt: -1 }).limit(50);
  return list.map((n) => ({
    id: 'ho-' + (n._id || n.id),
    type: 'handover',
    title: n.title,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt,
    link: '/handovers',
  }));
}

// "Pending daily update" reminders are calculated live, so they disappear once the update is submitted.
async function pendingItems(user) {
  const today = todayStr();
  const read = user.pendingSeenDate === today;
  const pf = { status: { $ne: 'Completed' }, engineerId: user.role === 'engineer' ? user._id : { $ne: null } };
  const [active, updated] = await Promise.all([Project.find(pf, { name: 1 }).lean(), Report.distinct('projectId', { reportDate: today })]);
  const done = new Set(updated);
  const left = active.filter((p) => !done.has(p._id));
  if (!left.length) return [];
  const base = { id: 'pending-' + today, virtual: true, type: 'pending', read, createdAt: new Date().toISOString() };
  if (user.role === 'engineer') return [{ ...base, title: `Daily update pending for ${left.length} site(s)`, message: left.map((p) => p.name).join(', '), link: '/submit' }];
  return [{ ...base, title: `${left.length} site(s) without today's update`, message: left.slice(0, 8).map((p) => p.name).join(', ') + (left.length > 8 ? '…' : ''), link: '/' }];
}

r.get('/', ah(async (req, res) => {
  const [mine, pending, handovers, materials] = await Promise.all([
    Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100),
    pendingItems(req.user),
    handoverItems(req.user),
    materialItems(req.user),
  ]);
  const rest = [...handovers, ...materials, ...mine.map((n) => n.toJSON())].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const items = [...pending, ...rest];
  res.json({ items, unread: items.filter((n) => !n.read).length });
}));

r.post('/read-all', ah(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false }, { $set: { read: true } });
  if (req.user.role === 'head') await HO.HandoverNotification.updateMany({ audience: 'execution', read: false }, { $set: { read: true } });
  await MAT.MaterialRequest.updateMany(req.user.role === 'head' ? { requesterSeen: false } : { 'createdBy.id': req.user._id, requesterSeen: false }, { $set: { requesterSeen: true } });
  req.user.pendingSeenDate = todayStr();
  await req.user.save();
  res.json({ ok: true });
}));

r.post('/:id/read', ah(async (req, res) => {
  if (req.params.id.startsWith('pending-')) {
    req.user.pendingSeenDate = todayStr();
    await req.user.save();
  } else if (req.params.id.startsWith('ho-')) {
    await HO.HandoverNotification.updateOne({ _id: req.params.id.slice(3) }, { $set: { read: true } });
  } else if (req.params.id.startsWith('mr-')) {
    const mf = req.user.role === 'head' ? { _id: req.params.id.slice(3) } : { _id: req.params.id.slice(3), 'createdBy.id': req.user._id };
    await MAT.MaterialRequest.updateOne(mf, { $set: { requesterSeen: true } });
  } else {
    await Notification.updateOne({ _id: req.params.id, userId: req.user._id }, { $set: { read: true } });
  }
  res.json({ ok: true });
}));

export default r;
