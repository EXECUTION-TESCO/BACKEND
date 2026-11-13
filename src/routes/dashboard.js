import { Router } from 'express';
import { Project, Report, User } from '../db.js';
import { requireAuth } from '../auth.js';
import { todayStr, isDelayed, decorateProjects, ah } from '../utils.js';

const r = Router();
r.use(requireAuth);

r.get('/', ah(async (req, res) => {
  const today = todayStr();
  const isHead = req.user.role === 'head';
  const pf = isHead ? {} : { engineerId: req.user._id };
  const projects = (await Project.find(pf).lean()).map((p) => ({ ...p, id: p._id }));
  const ids = projects.map((p) => p.id);
  const rf = { projectId: { $in: ids }, ...(isHead ? {} : { engineerId: req.user._id }) };
  const [todays, latest, engineers] = await Promise.all([
    Report.find({ ...rf, reportDate: today }).sort({ createdAt: -1 }).lean(),
    Report.aggregate([{ $match: rf }, { $sort: { createdAt: -1 } }, { $group: { _id: '$projectId', last: { $first: '$$ROOT' } } }]),
    User.find({ role: 'engineer' }, { name: 1 }).lean(),
  ]);
  const names = Object.fromEntries(engineers.map((u) => [u._id, u.name]));
  const active = projects.filter((p) => p.status !== 'Completed');
  const updatedToday = new Set(todays.map((x) => x.projectId));
  const pending = active.filter((p) => p.engineerId && !updatedToday.has(p.id));
  const openMaterial = latest.map((x) => x.last).filter((x) => x.materialRequired && x.materialStatus !== 'Delivered');

  const statusBreakdown = {};
  projects.forEach((p) => { statusBreakdown[p.status] = (statusBreakdown[p.status] || 0) + 1; });

  res.json({
    today,
    cards: {
      totalProjects: projects.length,
      activeProjects: active.length,
      completedProjects: projects.filter((p) => p.status === 'Completed').length,
      inProgress: projects.filter((p) => p.status === 'Work In Progress').length,
      delayedProjects: projects.filter((p) => isDelayed(p, today)).length,
      todaysSiteVisits: todays.length,
      pendingDailyUpdates: pending.length,
      materialRequirements: openMaterial.length,
    },
    statusBreakdown,
    todaysUpdates: todays.map((x) => ({ id: x._id, engineerName: x.engineerName, projectId: x.projectId, projectName: x.projectName, todayProgress: x.todayProgress || x.workCompleted, materialRequired: x.materialRequired, materialStatus: x.materialStatus, status: x.projectStatus, photoCount: (x.photos || []).length, createdAt: x.createdAt })),
    pendingUpdates: pending.map((p) => ({ projectId: p.id, projectName: p.name, engineerId: p.engineerId, engineerName: names[p.engineerId] || '' })),
    openMaterial: openMaterial.map((x) => ({ reportId: x._id, projectName: x.projectName, engineerName: x.engineerName, materialRequired: x.materialRequired, materialStatus: x.materialStatus, reportDate: x.reportDate })),
    projects: (await decorateProjects(projects)).map(({ _id, ...p }) => ({ ...p, updatedToday: updatedToday.has(p.id) })),
  });
}));

export default r;
