import { Router } from 'express';
import { Notification, Project, Report } from '../db.js';
import { requireAuth } from '../auth.js';
import { todayStr, ah } from '../utils.js';

const r = Router();
r.use(requireAuth);

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
  const [mine, pending] = await Promise.all([
    Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100),
    pendingItems(req.user),
  ]);
  const items = [...pending, ...mine.map((n) => n.toJSON())];
  res.json({ items, unread: items.filter((n) => !n.read).length });
}));

r.post('/read-all', ah(async (req, res) => {
  await Notification.updateMany({ userId: req.user._id, read: false }, { $set: { read: true } });
  req.user.pendingSeenDate = todayStr();
  await req.user.save();
  res.json({ ok: true });
}));

r.post('/:id/read', ah(async (req, res) => {
  if (req.params.id.startsWith('pending-')) {
    req.user.pendingSeenDate = todayStr();
    await req.user.save();
  } else {
    await Notification.updateOne({ _id: req.params.id, userId: req.user._id }, { $set: { read: true } });
  }
  res.json({ ok: true });
}));

export default r;
