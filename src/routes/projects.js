import { Router } from 'express';
import mongoose from 'mongoose';
import { Project, Report, Comment, User, TASK_STATUSES } from '../db.js';
import { requireAuth, requireHead } from '../auth.js';
import { PROJECT_STATUSES, PRIORITIES } from '../config.js';
import { clean, decorateProjects, todayStr, isDelayed, ah } from '../utils.js';
import { notify, notifyHeads } from '../notify.js';
import { handoverModels, logActivity } from '../handover-model.js';

const r = Router();
r.use(requireAuth);

const HO = handoverModels(process.env.HANDOVER_PREFIX || 'ho_');

// Shared handover-files GridFS bucket (ho_files) — used to stream a handover's attachments
// to the assigned engineer through their project, without exposing the whole handover list.
let hoBucket;
const handoverFileBucket = () => {
  if (!hoBucket) hoBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: (process.env.HANDOVER_PREFIX || 'ho_') + 'files' });
  return hoBucket;
};

// When a handover-sourced project is assigned to an engineer, record it on the handover's
// history (shown to the Sales team) including the engineer's mobile number, and notify Sales.
async function logHandoverAssignment(project, engineer, byUser) {
  if (!project.handoverId || !engineer) return;
  try {
    const h = await HO.Handover.findById(project.handoverId);
    if (!h) return;
    const actor = { id: byUser._id, name: byUser.name, role: byUser.role, portal: 'execution' };
    const mobile = engineer.phone ? ` · Mobile: ${engineer.phone}` : '';
    await logActivity(HO, h, { type: 'assignment', message: `Project assigned to ${engineer.name}${mobile}`, by: actor });
    if (h.createdBy && h.createdBy.id) {
      await HO.HandoverNotification.create({
        audience: 'sales', userId: h.createdBy.id, handoverId: h._id, ref: h.ref || null,
        type: 'assignment', title: `Project assigned — ${h.ref || h.projectName || 'handover'}`,
        message: `${engineer.name}${mobile}`, link: '/handovers',
      });
    }
  } catch (e) { /* history logging is non-fatal */ }
}

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
// A member can open a project if they are its engineer OR they have a daily task assigned on it.
const findVisible = (u, id) => Project.findOne(isHead(u) ? { _id: id } : { _id: id, $or: [{ engineerId: u._id }, { 'dailyTasks.assigneeId': u._id }] });

// Write a read-only snapshot of a project's daily tasks onto its source handover so the Sales
// team can see task progress (names resolved here; Sales never queries Execution's users).
async function syncTasksToHandover(project) {
  if (!project.handoverId) return;
  try {
    const ids = [...new Set((project.dailyTasks || []).map((t) => t.assigneeId).filter(Boolean))];
    const names = Object.fromEntries((await User.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
    const snapshot = (project.dailyTasks || []).map((t) => ({
      taskId: String(t._id), title: t.title, status: t.status,
      assigneeName: names[t.assigneeId] || 'Unassigned', dueDate: t.dueDate || '', updatedAt: t.updatedAt || new Date(),
    }));
    await HO.Handover.updateOne({ _id: project.handoverId }, { $set: { executionTasks: snapshot } });
  } catch (e) { /* snapshot is non-fatal */ }
}

r.get('/meta', (req, res) => res.json({ statuses: PROJECT_STATUSES, priorities: PRIORITIES }));

r.get('/', ah(async (req, res) => {
  const today = todayStr();
  const { status, engineerId, q } = req.query;
  const filter = {};
  const and = [];
  // Members see projects they are the engineer of OR have a daily task assigned on.
  if (!isHead(req.user)) and.push({ $or: [{ engineerId: req.user._id }, { 'dailyTasks.assigneeId': req.user._id }] });
  if (status === 'Active') filter.status = { $ne: 'Completed' };
  else if (status && status !== 'Delayed') filter.status = status;
  if (engineerId && isHead(req.user)) filter.engineerId = engineerId;
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ name: rx }, { client: rx }, { location: rx }] });
  }
  if (and.length) filter.$and = and;
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
  const ids = [...new Set([
    ...(p.assignmentHistory || []).flatMap((h) => [h.engineerId, h.by]),
    ...(p.dailyTasks || []).flatMap((t) => [t.assigneeId, t.createdBy, ...(t.reassignHistory || []).flatMap((r) => [r.fromId, r.toId, r.by])]),
  ].filter(Boolean))];
  const names = Object.fromEntries((await User.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
  const assignmentHistory = (p.assignmentHistory || []).map((h) => ({ engineerId: h.engineerId, at: h.at, by: h.by, engineerName: names[h.engineerId] || 'Unassigned', byName: names[h.by] || '' }));
  // Enrich daily tasks with resolved member names (ids stay for the UI to match the current user).
  project.dailyTasks = (project.dailyTasks || []).map((t) => ({
    ...t,
    assigneeName: names[t.assigneeId] || 'Unassigned',
    reassignHistory: (t.reassignHistory || []).map((r) => ({ ...r, fromName: names[r.fromId] || 'Unassigned', toName: names[r.toId] || 'Unassigned', byName: names[r.by] || '' })),
  }));
  res.json({ project, reports, comments, assignmentHistory: isHead(req.user) ? assignmentHistory : [] });
}));

r.post('/', requireHead, ah(async (req, res) => {
  const f = readFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Project name is required' });
  if (!(await validEngineer(f.engineerId))) return res.status(400).json({ error: 'Select a valid, active engineer' });
  const p = await Project.create({
    ...f,
    assignmentHistory: f.engineerId ? [{ engineerId: f.engineerId, at: new Date(), by: req.user._id }] : [],
    assignedAt: f.engineerId ? new Date() : undefined,
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
  if (reassigned) {
    p.assignmentHistory.push({ engineerId: f.engineerId, at: new Date(), by: req.user._id });
    p.assignedAt = f.engineerId ? new Date() : p.assignedAt; // track latest assignment date
  }
  await p.save();

  if (reassigned) {
    if (p.engineerId) {
      await notify(p.engineerId, { type: 'assigned', title: 'Project assigned to you', message: `${p.name} has been ${before.engineerId ? 're' : ''}assigned to you.`, link: `/projects/${p._id}` });
      const eng = await User.findById(p.engineerId, { name: 1, phone: 1 }).lean();
      await logHandoverAssignment(p, eng, req.user); // record on the Sales handover history (with mobile)
    }
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

// Save a project's Work Schedule (Execution Head only). Additive — does not touch any
// existing project field or workflow.
r.put('/:id/work-schedule', requireHead, ah(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  p.workSchedule = (req.body && req.body.workSchedule) || {};
  p.markModified('workSchedule');
  await p.save();
  res.json((await decorateProjects([p]))[0]);
}));

// Stream a handover attachment that belongs to THIS project. Scoped with findVisible, so the
// assigned engineer can open the Sales handover's files for their own project (and the Head for any).
r.get('/:id/attachments/:fileId', ah(async (req, res) => {
  const p = await findVisible(req.user, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const att = (p.handoverAttachments || []).find((a) => a.fileId === req.params.fileId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  res.set('Content-Type', att.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(att.filename)}"`);
  handoverFileBucket().openDownloadStream(new mongoose.Types.ObjectId(att.fileId)).on('error', () => res.status(404).end()).pipe(res);
}));

// ---------- Daily Tasks (Phase 2) ----------

// Decorate a project and resolve member names on its daily tasks (same shape as GET /:id).
async function enrichedProject(p) {
  const [project] = await decorateProjects([p]);
  const ids = [...new Set((p.dailyTasks || []).flatMap((t) => [t.assigneeId, t.createdBy, ...(t.reassignHistory || []).flatMap((r) => [r.fromId, r.toId, r.by])]).filter(Boolean))];
  const names = Object.fromEntries((await User.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [u._id, u.name]));
  project.dailyTasks = (project.dailyTasks || []).map((t) => ({
    ...t,
    assigneeName: names[t.assigneeId] || 'Unassigned',
    reassignHistory: (t.reassignHistory || []).map((r) => ({ ...r, fromName: names[r.fromId] || 'Unassigned', toName: names[r.toId] || 'Unassigned', byName: names[r.by] || '' })),
  }));
  return project;
}

// Head assigns a daily task to a team member.
r.post('/:id/tasks', requireHead, ah(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ error: 'Task title is required' });
  const assigneeId = req.body.assigneeId || null;
  if (!(await validEngineer(assigneeId))) return res.status(400).json({ error: 'Select a valid, active team member' });
  p.dailyTasks.push({
    title, details: clean(req.body.details) || '', dueDate: clean(req.body.dueDate) || '',
    status: TASK_STATUSES.includes(req.body.status) ? req.body.status : 'To Do',
    assigneeId, createdBy: req.user._id,
  });
  await p.save();
  if (assigneeId) await notify(assigneeId, { type: 'task', title: 'New task assigned', message: `${title} — ${p.name}`, link: `/projects/${p._id}` });
  await syncTasksToHandover(p);
  res.status(201).json({ project: await enrichedProject(p) });
}));

// Head edits a task's details.
r.put('/:id/tasks/:taskId', requireHead, ah(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const t = p.dailyTasks.id(req.params.taskId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (req.body.title !== undefined) { const v = clean(req.body.title); if (!v) return res.status(400).json({ error: 'Task title is required' }); t.title = v; }
  if (req.body.details !== undefined) t.details = clean(req.body.details);
  if (req.body.dueDate !== undefined) t.dueDate = clean(req.body.dueDate);
  if (req.body.status !== undefined && TASK_STATUSES.includes(req.body.status)) { t.status = req.body.status; t.completedAt = req.body.status === 'Done' ? new Date() : undefined; }
  await p.save();
  await syncTasksToHandover(p);
  res.json({ project: await enrichedProject(p) });
}));

// Head reassigns a task to another member (records history + notifies both).
r.post('/:id/tasks/:taskId/reassign', requireHead, ah(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const t = p.dailyTasks.id(req.params.taskId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const toId = req.body.assigneeId || null;
  if (!(await validEngineer(toId))) return res.status(400).json({ error: 'Select a valid, active team member' });
  const fromId = t.assigneeId || null;
  if (fromId === toId) return res.status(400).json({ error: 'Task is already assigned to that member' });
  t.reassignHistory.push({ fromId, toId, at: new Date(), by: req.user._id });
  t.assigneeId = toId;
  await p.save();
  if (toId) await notify(toId, { type: 'task', title: 'Task assigned to you', message: `${t.title} — ${p.name}`, link: `/projects/${p._id}` });
  if (fromId) await notify(fromId, { type: 'task', title: 'Task reassigned', message: `"${t.title}" has been moved to another team member.`, link: `/projects/${p._id}` });
  await syncTasksToHandover(p);
  res.json({ project: await enrichedProject(p) });
}));

// Assignee (or Head) updates a task's status.
r.patch('/:id/tasks/:taskId/status', ah(async (req, res) => {
  const p = await findVisible(req.user, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const t = p.dailyTasks.id(req.params.taskId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  if (!isHead(req.user) && t.assigneeId !== req.user._id) return res.status(403).json({ error: 'You can only update your own tasks' });
  if (!TASK_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  const old = t.status;
  t.status = req.body.status;
  t.completedAt = req.body.status === 'Done' ? new Date() : undefined;
  await p.save();
  if (old !== t.status && !isHead(req.user)) await notifyHeads({ type: 'task', title: 'Task updated', message: `${req.user.name}: "${t.title}" → ${t.status} (${p.name})`, link: `/projects/${p._id}` });
  await syncTasksToHandover(p);
  res.json({ project: await enrichedProject(p) });
}));

// Head deletes a task.
r.delete('/:id/tasks/:taskId', requireHead, ah(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const t = p.dailyTasks.id(req.params.taskId);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  p.dailyTasks.pull(req.params.taskId);
  await p.save();
  await syncTasksToHandover(p);
  res.json({ project: await enrichedProject(p) });
}));

export default r;
