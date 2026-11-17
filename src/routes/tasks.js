// Work Schedule — task management for the Execution Portal.
// The Execution Head plans tasks on an accepted PROJECT and assigns them to a team member.
// The member updates progress; the Head reviews and approves. Tasks are linked to the real
// project (projectId) — never a duplicate project. Every change is appended to task.history.
import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { Task, Project, User, taskBucket, TASK_STATUSES, TASK_PRIORITIES } from '../db.js';
import { requireAuth, requireHead } from '../auth.js';
import { clean, todayStr, ah } from '../utils.js';
import { notify, notifyHeads } from '../notify.js';

const r = Router();
r.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
const isHead = (u) => u.role === 'head';
const scope = (u) => (isHead(u) ? {} : { engineerId: u._id }); // members only ever see their own tasks
const hist = (user, type, message) => ({ at: new Date(), byId: user._id, byName: user.name, byRole: user.role, type, message });
const validEng = async (id) => !id || !!(await User.exists({ _id: id, role: 'engineer', active: true }));

// Add engineer name/phone and deadline flags for the UI.
async function decorate(tasks) {
  const list = tasks.map((t) => (t.toJSON ? t.toJSON() : { ...t, id: t._id }));
  const engIds = [...new Set(list.map((t) => t.engineerId).filter(Boolean))];
  const users = await User.find({ _id: { $in: engIds } }, { name: 1, phone: 1 }).lean();
  const names = Object.fromEntries(users.map((u) => [u._id, u.name]));
  const phones = Object.fromEntries(users.map((u) => [u._id, u.phone]));
  const today = todayStr();
  return list.map((t) => {
    const open = t.status !== 'Completed' || t.approvalState === 'pending';
    const overdue = open && !!t.endDate && t.endDate < today;
    const dueToday = open && t.endDate === today;
    const daysLeft = t.endDate ? Math.round((new Date(t.endDate) - new Date(today)) / 86400000) : null;
    const approaching = open && daysLeft != null && daysLeft >= 0 && daysLeft <= 3;
    return { ...t, id: t.id || t._id, engineerName: names[t.engineerId] || 'Unassigned', engineerPhone: phones[t.engineerId] || '', overdue, dueToday, approaching, daysLeft };
  });
}

const canSee = (user, t) => isHead(user) || t.engineerId === user._id;

r.get('/meta', (req, res) => res.json({ statuses: TASK_STATUSES, priorities: TASK_PRIORITIES }));

// ---- List (filters) ----
r.get('/', ah(async (req, res) => {
  const f = { ...scope(req.user) };
  const { projectId, engineerId, status, priority, from, to } = req.query;
  if (projectId) f.projectId = projectId;
  if (engineerId && isHead(req.user)) f.engineerId = engineerId;
  if (priority && TASK_PRIORITIES.includes(priority)) f.priority = priority;
  if (status && TASK_STATUSES.includes(status)) f.status = status; // 'Overdue' handled after decorate
  if (from || to) { f.endDate = {}; if (from) f.endDate.$gte = from; if (to) f.endDate.$lte = to; }
  let list = await decorate(await Task.find(f).sort({ createdAt: -1 }).lean());
  if (status === 'Overdue') list = list.filter((t) => t.overdue);
  res.json(list);
}));

// ---- Stats (role-scoped) ----
r.get('/stats', ah(async (req, res) => {
  const list = await decorate(await Task.find(scope(req.user)).lean());
  const by = (s) => list.filter((t) => t.status === s).length;
  res.json({
    total: list.length,
    notStarted: by('Not Started'),
    inProgress: by('In Progress'),
    onHold: by('On Hold'),
    completed: list.filter((t) => t.status === 'Completed' && t.approvalState !== 'pending').length,
    changesRequested: by('Changes Requested'),
    overdue: list.filter((t) => t.overdue).length,
    dueToday: list.filter((t) => t.dueToday).length,
    approaching: list.filter((t) => t.approaching).length,
    pendingApproval: list.filter((t) => t.approvalState === 'pending').length,
    extensionRequests: list.filter((t) => t.extensionRequested).length,
  });
}));

// ---- Create (HEAD ONLY) ----
r.post('/', requireHead, ah(async (req, res) => {
  const b = req.body || {};
  const project = await Project.findById(b.projectId);
  if (!project) return res.status(400).json({ error: 'Select a valid project' });
  if (!clean(b.title)) return res.status(400).json({ error: 'Task title is required' });
  const engineerId = b.engineerId || null;
  if (!(await validEng(engineerId))) return res.status(400).json({ error: 'Select a valid, active team member' });
  const priority = TASK_PRIORITIES.includes(b.priority) ? b.priority : 'Medium';
  const t = await Task.create({
    projectId: project._id, projectName: project.name,
    engineerId, title: clean(b.title), description: clean(b.description), instructions: clean(b.instructions),
    priority, startDate: clean(b.startDate), endDate: clean(b.endDate),
    dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn : [],
    status: 'Not Started', assignedAt: engineerId ? new Date() : undefined,
    createdBy: req.user._id,
    history: [hist(req.user, 'created', `Task created on ${project.name}${engineerId ? '' : ' (unassigned)'}`)],
  });
  if (engineerId) await notify(engineerId, { type: 'assigned', title: `New task assigned – ${t.title}`, message: `${project.name}${t.endDate ? ` · due ${t.endDate}` : ''}`, link: '/work-schedule' });
  res.status(201).json((await decorate([t]))[0]);
}));

// ---- Detail (Head or assigned member) ----
r.get('/:id', ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  res.json((await decorate([t]))[0]);
}));

// ---- Edit / reschedule / reassign (HEAD ONLY) ----
r.put('/:id', requireHead, ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const b = req.body || {};
  const before = t.toObject();
  for (const k of ['title', 'description', 'instructions', 'startDate', 'endDate']) if (b[k] !== undefined) t[k] = clean(b[k]);
  if (b.priority !== undefined && TASK_PRIORITIES.includes(b.priority)) t.priority = b.priority;
  if (b.dependsOn !== undefined) t.dependsOn = Array.isArray(b.dependsOn) ? b.dependsOn : [];

  let reassigned = false;
  if (b.engineerId !== undefined && (b.engineerId || null) !== (before.engineerId || null)) {
    if (!(await validEng(b.engineerId))) return res.status(400).json({ error: 'Select a valid, active team member' });
    t.engineerId = b.engineerId || null;
    t.assignedAt = t.engineerId ? new Date() : t.assignedAt;
    reassigned = true;
  }
  const rescheduled = (b.startDate !== undefined && clean(b.startDate) !== (before.startDate || '')) || (b.endDate !== undefined && clean(b.endDate) !== (before.endDate || ''));
  if (reassigned) t.history.push(hist(req.user, 'assigned', `Reassigned${t.engineerId ? '' : ' to Unassigned'}`));
  if (rescheduled) t.history.push(hist(req.user, 'rescheduled', `Rescheduled → ${t.startDate || '—'} to ${t.endDate || '—'}`));
  if (!reassigned && !rescheduled) t.history.push(hist(req.user, 'updated', 'Task details updated'));
  await t.save();

  if (reassigned && t.engineerId) await notify(t.engineerId, { type: 'assigned', title: `Task assigned to you – ${t.title}`, message: `${t.projectName}${t.endDate ? ` · due ${t.endDate}` : ''}`, link: '/work-schedule' });
  if (reassigned && before.engineerId) await notify(before.engineerId, { type: 'reassigned', title: 'Task reassigned', message: `${t.title} has been moved to another team member.` });
  if (rescheduled && t.engineerId) await notify(t.engineerId, { type: 'update', title: `Task rescheduled – ${t.title}`, message: `New deadline: ${t.endDate || '—'}`, link: '/work-schedule' });
  res.json((await decorate([t]))[0]);
}));

// ---- Status update (member for own task; Head for any) ----
r.patch('/:id/status', ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const status = req.body.status;
  if (!TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const memberAllowed = ['Not Started', 'In Progress', 'On Hold', 'Completed'];
  if (!isHead(req.user) && !memberAllowed.includes(status)) return res.status(403).json({ error: 'Not allowed' });
  const old = t.status;
  if (clean(req.body.delayReason)) t.delayReason = clean(req.body.delayReason);

  if (status === 'Completed' && !isHead(req.user)) {
    // member submits for the Head's approval
    t.status = 'Completed';
    t.approvalState = 'pending';
    if (clean(req.body.completionDetails)) t.completionDetails = clean(req.body.completionDetails);
    t.history.push(hist(req.user, 'completed', `Marked Completed — submitted for approval${t.completionDetails ? `: ${t.completionDetails}` : ''}`));
    await t.save();
    await notifyHeads({ type: 'status', title: `Task completed – ${t.title}`, message: `${t.engineerName || 'Team member'} submitted "${t.title}" for approval`, link: '/work-schedule' });
    return res.json((await decorate([t]))[0]);
  }

  t.status = status;
  if (['Not Started', 'In Progress', 'On Hold'].includes(status)) t.approvalState = '';
  t.history.push(hist(req.user, 'status', `${old} → ${status}${t.delayReason && status === 'On Hold' ? ` (reason: ${t.delayReason})` : ''}`));
  await t.save();
  if (!isHead(req.user)) await notifyHeads({ type: 'status', title: `Task ${status} – ${t.title}`, message: `${req.user.name}: ${old} → ${status}`, link: '/work-schedule' });
  else if (t.engineerId) await notify(t.engineerId, { type: 'status', title: `Task status changed – ${t.title}`, message: `${old} → ${status}`, link: '/work-schedule' });
  res.json((await decorate([t]))[0]);
}));

// ---- Progress remark (member or Head) ----
r.post('/:id/remarks', ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const message = clean(req.body.message);
  if (!message) return res.status(400).json({ error: 'Enter a remark' });
  t.progressRemarks = message;
  t.history.push(hist(req.user, 'remark', message));
  await t.save();
  if (!isHead(req.user)) await notifyHeads({ type: 'comment', title: `Progress update – ${t.title}`, message: `${req.user.name}: ${message.slice(0, 100)}`, link: '/work-schedule' });
  else if (t.engineerId) await notify(t.engineerId, { type: 'comment', title: `Note on ${t.title}`, message: message.slice(0, 120), link: '/work-schedule' });
  res.json((await decorate([t]))[0]);
}));

// ---- Request extension (member) ----
r.post('/:id/extension', ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  if (isHead(req.user)) return res.status(403).json({ error: 'Only the assigned member requests an extension' });
  const reason = clean(req.body.reason);
  const until = clean(req.body.until);
  if (!reason) return res.status(400).json({ error: 'Give a reason for the extension' });
  t.extensionRequested = true; t.extensionReason = reason; t.extensionUntil = until;
  t.history.push(hist(req.user, 'extension', `Requested extension${until ? ` until ${until}` : ''}: ${reason}`));
  await t.save();
  await notifyHeads({ type: 'status', title: `Extension requested – ${t.title}`, message: `${req.user.name}${until ? ` → ${until}` : ''}: ${reason.slice(0, 80)}`, link: '/work-schedule' });
  res.json((await decorate([t]))[0]);
}));

// ---- Extension decision (HEAD ONLY) ----
r.post('/:id/extension-decision', requireHead, ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const grant = req.body.action === 'grant';
  const until = clean(req.body.until) || t.extensionUntil;
  if (grant && until) t.endDate = until;
  t.extensionRequested = false;
  t.history.push(hist(req.user, grant ? 'extended' : 'extension-denied', grant ? `Deadline extended to ${until}` : 'Extension request declined'));
  await t.save();
  if (t.engineerId) await notify(t.engineerId, { type: grant ? 'update' : 'status', title: grant ? `Deadline extended – ${t.title}` : `Extension declined – ${t.title}`, message: grant ? `New deadline: ${until}` : 'Please complete by the current deadline.', link: '/work-schedule' });
  res.json((await decorate([t]))[0]);
}));

// ---- Review completed work: approve / request-changes (HEAD ONLY) ----
r.post('/:id/review', requireHead, ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const action = req.body.action;
  const remarks = clean(req.body.remarks);
  if (action === 'approve') {
    t.status = 'Completed'; t.approvalState = 'approved'; t.completedAt = new Date(); t.approvedAt = new Date();
    t.history.push(hist(req.user, 'approved', `Work approved${remarks ? `: ${remarks}` : ''}`));
    await t.save();
    if (t.engineerId) await notify(t.engineerId, { type: 'status', title: `Task approved – ${t.title}`, message: 'Your completed work was approved.', link: '/work-schedule' });
  } else if (action === 'request-changes') {
    if (!remarks) return res.status(400).json({ error: 'Add remarks describing the changes needed' });
    t.status = 'Changes Requested'; t.approvalState = 'changes'; t.reviewRemarks = remarks;
    t.history.push(hist(req.user, 'changes', `Changes requested: ${remarks}`));
    await t.save();
    if (t.engineerId) await notify(t.engineerId, { type: 'instructions', title: `Changes requested – ${t.title}`, message: remarks.slice(0, 140), link: '/work-schedule' });
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }
  res.json((await decorate([t]))[0]);
}));

// ---- Upload attachments (Head → reference; member → progress) ----
r.post('/:id/attachments', upload.array('files', 20), ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files received' });
  const kind = isHead(req.user) ? 'reference' : 'progress';
  const added = [];
  for (const file of files) {
    const stream = taskBucket().openUploadStream(file.originalname, { contentType: file.mimetype, metadata: { taskId: t._id } });
    await new Promise((resolve, reject) => { stream.on('error', reject); stream.on('finish', resolve); stream.end(file.buffer); });
    added.push({ fileId: String(stream.id), filename: file.originalname, mime: file.mimetype, size: file.size, kind, uploadedBy: req.user._id, uploadedByName: req.user.name, uploadedAt: new Date() });
  }
  t.attachments.push(...added);
  t.history.push(hist(req.user, 'attachment', `Added ${added.length} ${kind} file(s): ${added.map((a) => a.filename).join(', ')}`));
  await t.save();
  if (!isHead(req.user)) await notifyHeads({ type: 'comment', title: `Files uploaded – ${t.title}`, message: `${req.user.name} added ${added.length} file(s)`, link: '/work-schedule' });
  res.json((await decorate([t]))[0]);
}));

// ---- Download an attachment (Head or assigned member) ----
r.get('/:id/attachments/:fileId', ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Task not found' });
  const att = (t.attachments || []).find((a) => a.fileId === req.params.fileId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  res.set('Content-Type', att.mime || 'application/octet-stream');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(att.filename)}"`);
  taskBucket().openDownloadStream(new mongoose.Types.ObjectId(att.fileId)).on('error', () => res.status(404).end()).pipe(res);
}));

// ---- Delete a task (HEAD ONLY) ----
r.delete('/:id', requireHead, ah(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  await Promise.all((t.attachments || []).map((a) => taskBucket().delete(new mongoose.Types.ObjectId(a.fileId)).catch(() => {})));
  await t.deleteOne();
  res.json({ ok: true });
}));

export default r;
