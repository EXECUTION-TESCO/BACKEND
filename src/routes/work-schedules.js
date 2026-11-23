// Work Schedule Sharing — the Execution Head shares a work schedule with ONE team member.
// A date-wise history is kept (every shared schedule is a record). The assigned member gets an
// in-app notification and can see their schedules on their dashboard.
import { Router } from 'express';
import { WorkScheduleShare, Project, User } from '../db.js';
import { requireAuth } from '../auth.js';
import { clean, ah } from '../utils.js';
import { notify } from '../notify.js';

const r = Router();
r.use(requireAuth);

const isHead = (u) => u.role === 'head';

// ---- List schedules (Head: all / optional ?assigneeId= or ?projectId=; member: only their own). Newest first = date-wise history. ----
r.get('/', ah(async (req, res) => {
  const q = {};
  if (isHead(req.user)) {
    if (req.query.assigneeId) q.assigneeId = String(req.query.assigneeId);
    if (req.query.projectId) q.projectId = String(req.query.projectId);
  } else {
    q.assigneeId = req.user._id;   // a team member only sees schedules shared with them
  }
  const list = await WorkScheduleShare.find(q).sort({ createdAt: -1 }).limit(1000);
  res.json({ schedules: list.map((x) => x.toJSON()) });
}));

// ---- Share a new work schedule with a team member (Head only) ----
r.post('/', ah(async (req, res) => {
  if (!isHead(req.user)) return res.status(403).json({ error: 'Only the Execution Head can share work schedules' });
  const b = req.body || {};
  const project = await Project.findById(b.projectId);
  if (!project) return res.status(400).json({ error: 'Select a project' });
  const member = await User.findOne({ _id: b.assigneeId, role: 'engineer', active: true });
  if (!member) return res.status(400).json({ error: 'Select a team member' });
  const workDetails = clean(b.workDetails);
  if (!workDetails) return res.status(400).json({ error: 'Enter the work details' });

  const doc = await WorkScheduleShare.create({
    projectId: project._id, projectName: project.name,
    assigneeId: member._id, assigneeName: member.name,
    workDetails,
    startDate: clean(b.startDate) || '',
    expectedCompletionDate: clean(b.expectedCompletionDate) || '',
    instructions: clean(b.instructions) || '',
    createdBy: { id: req.user._id, name: req.user.name },
  });

  // In-app notification to the assigned team member.
  await notify(member._id, {
    type: 'schedule',
    title: `New work schedule — ${project.name}`,
    message: `${req.user.name} shared a work schedule${doc.startDate ? ` starting ${doc.startDate}` : ''}${doc.expectedCompletionDate ? `, due ${doc.expectedCompletionDate}` : ''}.`,
    link: '/',
  });

  res.status(201).json({ schedule: doc.toJSON() });
}));

// ---- Delete a shared schedule (Head only) ----
r.delete('/:id', ah(async (req, res) => {
  if (!isHead(req.user)) return res.status(403).json({ error: 'Not allowed' });
  const doc = await WorkScheduleShare.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Schedule not found' });
  res.json({ ok: true });
}));

export default r;
