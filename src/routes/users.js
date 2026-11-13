import { Router } from 'express';
import crypto from 'crypto';
import { User, Project, Report, Comment, Notification, addDesignation } from '../db.js';
import { requireAuth, requireHead, hashPassword, passwordProblem, publicUser } from '../auth.js';
import { clean, todayStr, isDelayed, ah } from '../utils.js';

const r = Router();
r.use(requireAuth, requireHead);

// Readable random password, e.g. "Steel-4827-kq7m" (≈ 12+ chars)
export function generatePassword() {
  const words = ['Site', 'Build', 'Steel', 'Panel', 'Frame', 'Plan', 'Work', 'Tower', 'Beam', 'Truss'];
  const al = 'abcdefghjkmnpqrstuvwxyz23456789';
  const tail = Array.from({ length: 4 }, () => al[crypto.randomInt(al.length)]).join('');
  return `${words[crypto.randomInt(words.length)]}-${crypto.randomInt(1000, 9999)}-${tail}`;
}

async function taken(value, exceptId) {
  if (!value) return false;
  const v = value.toLowerCase();
  return !!(await User.exists({ _id: { $ne: exceptId }, $or: [{ username: v }, { employeeId: v.toUpperCase() }] }));
}

r.get('/', ah(async (req, res) => {
  const today = todayStr();
  const q = req.query.role ? { role: req.query.role } : {};
  const [users, projects, reports] = await Promise.all([
    User.find(q),
    Project.find({}, { name: 1, status: 1, engineerId: 1, expectedDate: 1 }).lean(),
    Report.aggregate([{ $group: { _id: '$engineerId', last: { $max: '$createdAt' }, today: { $push: { $cond: [{ $eq: ['$reportDate', today] }, '$projectId', null] } } } }]),
  ]);
  const rep = Object.fromEntries(reports.map((x) => [x._id, x]));
  const list = users.map((u) => {
    const mine = projects.filter((p) => p.engineerId === u._id);
    const active = mine.filter((p) => p.status !== 'Completed');
    const todayIds = new Set((rep[u._id]?.today || []).filter(Boolean));
    return {
      ...publicUser(u),
      totalProjects: mine.length,
      activeProjects: active.length,
      delayedProjects: active.filter((p) => isDelayed(p, today)).length,
      reportsToday: (rep[u._id]?.today || []).filter(Boolean).length,
      pendingToday: active.filter((p) => !todayIds.has(p._id)).length,
      lastReportAt: rep[u._id]?.last || null,
      projects: mine.map((p) => ({ id: p._id, name: p.name, status: p.status })),
    };
  });
  list.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'head' ? -1 : 1));
  res.json(list);
}));

r.get('/generate-password', (req, res) => res.json({ password: generatePassword() }));

// Create login credentials for a team member (or another Execution Head)
r.post('/', ah(async (req, res) => {
  const b = req.body;
  const name = clean(b.name);
  const username = clean(b.username).toLowerCase().replace(/\s+/g, '');
  const employeeId = clean(b.employeeId).toUpperCase();
  const role = b.role === 'head' ? 'head' : 'engineer';
  const password = b.password || generatePassword();
  if (!name || !username) return res.status(400).json({ error: 'Name and username are required' });
  if (!/^[a-z0-9._@-]{3,60}$/.test(username)) return res.status(400).json({ error: 'Username: 3–60 characters – letters, numbers, dot, dash, underscore or @ (email allowed)' });
  const bad = passwordProblem(password);
  if (bad) return res.status(400).json({ error: bad });
  if (await taken(username)) return res.status(400).json({ error: 'That username is already taken' });
  if (employeeId && (await taken(employeeId))) return res.status(400).json({ error: 'That Employee ID is already used' });
  const user = await User.create({
    name, username, employeeId: employeeId || undefined, phone: clean(b.phone), email: clean(b.email), designation: await addDesignation(b.designation, req.user._id),
    role, passwordHash: await hashPassword(password), mustChangePassword: false, passwordSetAt: new Date(), createdBy: req.user._id,
  });
  // the plain password is returned ONCE so the Head can share it; only the bcrypt hash is stored
  res.status(201).json({ user: publicUser(user), credentials: { username, employeeId, password } });
}));

r.put('/:id', ah(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body;
  if (b.name !== undefined) u.name = clean(b.name) || u.name;
  for (const k of ['phone', 'email']) if (b[k] !== undefined) u[k] = clean(b[k]);
  if (b.designation !== undefined) u.designation = await addDesignation(b.designation, req.user._id);
  if (b.employeeId !== undefined) {
    const e = clean(b.employeeId).toUpperCase();
    if (e && (await taken(e, u._id))) return res.status(400).json({ error: 'That Employee ID is already used' });
    u.employeeId = e || undefined;
  }
  if (b.role !== undefined && u._id !== req.user._id) {
    const role = b.role === 'head' ? 'head' : 'engineer';
    if (role !== u.role) {
      if (role === 'head' && (await Project.exists({ engineerId: u._id, status: { $ne: 'Completed' } }))) return res.status(400).json({ error: "Reassign this engineer's active projects before making them an Execution Head" });
      u.role = role;
      u.tokenVersion = (u.tokenVersion || 0) + 1; // role changed -> must log in again
    }
  }
  if (b.active !== undefined) {
    if (u._id === req.user._id && !b.active) return res.status(400).json({ error: 'You cannot disable your own login' });
    if (u.active && !b.active) u.tokenVersion = (u.tokenVersion || 0) + 1; // disabled -> logged out everywhere
    u.active = !!b.active;
  }
  await u.save();
  res.json(publicUser(u));
}));

// Reset password -> returns the new password once and logs the user out everywhere
r.post('/:id/reset-password', ah(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const password = req.body.password || generatePassword();
  const bad = passwordProblem(password);
  if (bad) return res.status(400).json({ error: bad });
  u.passwordHash = await hashPassword(password);
  u.passwordSetAt = new Date();
  u.mustChangePassword = false;
  u.tokenVersion = (u.tokenVersion || 0) + 1;
  await u.save();
  res.json({ user: publicUser(u), credentials: { username: u.username, employeeId: u.employeeId || '', password } });
}));

// Delete a login created by mistake – only if it was never used (no projects, reports or comments).
// Used logins must be disabled instead, so the history stays complete.
r.delete('/:id', ah(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u._id === req.user._id) return res.status(400).json({ error: 'You cannot delete your own login' });
  const used = await Promise.all([
    Project.exists({ $or: [{ engineerId: u._id }, { 'assignmentHistory.engineerId': u._id }, { createdBy: u._id }] }),
    Report.exists({ engineerId: u._id }),
    Comment.exists({ authorId: u._id }),
  ]);
  if (used.some(Boolean)) return res.status(400).json({ error: 'This login has project history – disable it instead of deleting' });
  await Notification.deleteMany({ userId: u._id });
  await u.deleteOne();
  res.json({ ok: true });
}));

export default r;
