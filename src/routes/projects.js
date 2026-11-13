import { Router } from 'express';
import { Project, Report, Comment, User } from '../db.js';
import { requireAuth, requireHead } from '../auth.js';
import { PROJECT_STATUSES, PRIORITIES } from '../config.js';
import { clean, decorateProjects, todayStr, isDelayed, ah } from '../utils.js';
import { notify, notifyHeads } from '../notify.js';

const r = Router();
r.use(requireAuth);

const isHead = (u) => u.role === 'head';
const scope = (u) => (isHead(u) ? {} : { engineerId: u._id }); // team members only see their own projects

function readFields(body) {
  const f = {};
  for (const k of ['name', 'client', 'location', 'scope', 'instructions', 'startDate', 'expectedDate']) if (body[k] !== undefined) f[k] = clean(body[k]);
  if (body.priority !== undefined) f.priority = PRIORITIES.includes(body.priority) ? body.priority : 'Medium';
  if (body.status !== undefined) f.status = PROJECT_STATUSES.includes(body.status) ? body.status : 'Not Started';
  if (body.engineerId !== undefined) f.engineerId = body.engineerId || null;
  return f;
}
const validEngineer = async (id) => !id || !!(await User.exists({ _id: id, role: 'engineer', active: true }));
const findVisible = (u, id) => Project.findOne({ _id: id, ...scope(u) });

r.get('/meta', (req, res) => res.json({ statuses: PROJECT_STATUSES, priorities: PRIORITIES }));

r.get('/', ah(async (req, res) => {
  const today = todayStr();
  const { status, engineerId, q } = req.query;
  const filter = { ...scope(req.user) };
  if (status === 'Active') filter.status = { $ne: 'Completed' };
  else if (status && status !== 'Delayed') filter.status = status;
  if (engineerId && isHead(req.user)) filter.engineerId = engineerId;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { client: rx }, { location: rx }];
  }
  let list = await Project.find(filter).lean();
  list = list.map((p) => ({ ...p, id: p._id }));
  if (status === 'Delayed') list = list.filter((p) => isDelayed(p, today));
  const updatedToday = new Set(await Report.distinct('projectId', { reportDate: today, projectId: { $in: list.map((p) => p.id) } }));
  const prio = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const out = (await decorateProjects(list)).map(({ _id, ...p }) => ({ ...p, updatedToday: updatedToday.has(p.id) }));
  out.sort((a, b) => (a.status === 'Completed') - (b.status === 'Completed') || (prio[a.priority] ?? 9) - (prio[b.priority] ?? 9) || a.name.localeCompare(b.name));
  res.json(out);
}));

r.get('/:id', ah(async (req, res) => {
  const p = await findVisible(req.user, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const [reports, comments, [project]] = await Promise.all([
    Report.find({ projectId: p._id }).sort({ createdAt: -1 }),
    Comment.find({ projectId: p._id }).sort({ createdAt: 1 }),
    decorateProjects([p]),
  ]);
  const ids = [...new Set((p.assignmentHistory || []).flatMap((h) => [h.engineerId, h.by]).filter(Boolean))];
  const names = Object.fromEntries((await User.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
  const assignmentHistory = (p.assignmentHistory || []).map((h) => ({ engineerId: h.engineerId, at: h.at, by: h.by, engineerName: names[h.engineerId] || 'Unassigned', byName: names[h.by] || '' }));
  res.json({ project, reports, comments, assignmentHistory: isHead(req.user) ? assignmentHistory : [] });
}));

r.post('/', requireHead, ah(async (req, res) => {
  const f = readFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Project name is required' });
  if (!(await validEngineer(f.engineerId))) return res.status(400).json({ error: 'Select a valid, active engineer' });
  const p = await Project.create({
    ...f,
    assignmentHistory: f.engineerId ? [{ engineerId: f.engineerId, at: new Date(), by: req.user._id }] : [],
    createdBy: req.user._id,
  });
  if (p.engineerId) await notify(p.engineerId, { type: 'assigned', title: 'New project assigned', message: `${p.name}${p.location ? ' – ' + p.location : ''} has been assigned to you.`, link: `/projects/${p._id}` });
  res.status(201).json((await decorateProjects([p]))[0]);
}));

r.put('/:id', requireHead, ah(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const f = readFields(req.body);
  if (f.name === '') return res.status(400).json({ error: 'Project name is required' });
  if (f.engineerId !== undefined && f.engineerId !== p.engineerId && !(await validEngineer(f.engineerId))) return res.status(400).json({ error: 'Select a valid, active engineer' });
  const before = p.toObject();
  p.set(f);
  const reassigned = f.engineerId !== undefined && f.engineerId !== before.engineerId;
  if (reassigned) p.assignmentHistory.push({ engineerId: f.engineerId, at: new Date(), by: req.user._id });
  await p.save();

  if (reassigned) {
    if (p.engineerId) await notify(p.engineerId, { type: 'assigned', title: 'Project assigned to you', message: `${p.name} has been ${before.engineerId ? 're' : ''}assigned to you.`, link: `/projects/${p._id}` });
    if (before.engineerId) await notify(before.engineerId, { type: 'reassigned', title: 'Project reassigned', message: `${p.name} has been moved to another team member.` });
  } else if (p.engineerId) {
    const labels = { name: 'name', client: 'client', location: 'location', scope: 'scope of work', instructions: 'work instructions', startDate: 'start date', expectedDate: 'expected completion date', priority: 'priority' };
    const changed = Object.keys(labels).filter((k) => f[k] !== undefined && (before[k] || '') !== (p[k] || ''));
    if (changed.length) {
      const instr = changed.includes('instructions');
      await notify(p.engineerId, {
        type: instr ? 'instructions' : 'update',
        title: instr ? `New work instructions – ${p.name}` : `Project updated – ${p.name}`,
        message: instr && p.instructions ? p.instructions.slice(0, 140) : `Updated: ${changed.map((k) => labels[k]).join(', ')}`,
        link: `/projects/${p._id}`,
      });
    }
    if (f.status !== undefined && before.status !== p.status) await notify(p.engineerId, { type: 'status', title: 'Project status changed', message: `${p.name}: ${before.status} → ${p.status}`, link: `/projects/${p._id}` });
  }
  res.json((await decorateProjects([p]))[0]);
}));

// Status: Head for any project, engineer only for their own
r.patch('/:id/status', ah(async (req, res) => {
  const p = await findVisible(req.user, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!PROJECT_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  const old = p.status;
  p.status = req.body.status;
  await p.save();
  if (old !== p.status) {
    if (isHead(req.user)) await notify(p.engineerId, { type: 'status', title: 'Project status changed', message: `${p.name}: ${old} → ${p.status}`, link: `/projects/${p._id}` });
    else await notifyHeads({ type: 'status', title: 'Project status changed', message: `${req.user.name} changed ${p.name}: ${old} → ${p.status}`, link: `/projects/${p._id}` });
  }
  res.json((await decorateProjects([p]))[0]);
}));

r.post('/:id/comments', ah(async (req, res) => {
  const p = await findVisible(req.user, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const text = clean(req.body.text);
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty' });
  if (text.length > 2000) return res.status(400).json({ error: 'Comment is too long' });
  let reportId = req.body.reportId || null;
  if (reportId && !(await Report.exists({ _id: reportId, projectId: p._id }))) reportId = null;
  const c = await Comment.create({ projectId: p._id, reportId, authorId: req.user._id, authorName: req.user.name, authorRole: req.user.role, text });
  if (isHead(req.user)) await notify(p.engineerId, { type: 'comment', title: `New instruction from ${req.user.name}`, message: `${p.name}: ${text.slice(0, 120)}`, link: `/projects/${p._id}` });
  else await notifyHeads({ type: 'comment', title: `Reply from ${req.user.name}`, message: `${p.name}: ${text.slice(0, 120)}`, link: `/projects/${p._id}` });
  res.status(201).json(c);
}));

export default r;
