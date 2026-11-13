import { config } from './config.js';
import { User, Report } from './db.js';

export function todayStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const clean = (v) => (typeof v === 'string' ? v.trim() : v ?? '');
export const isOverdue = (p, today = todayStr()) => p.status !== 'Completed' && !!p.expectedDate && p.expectedDate < today;
export const isDelayed = (p, today = todayStr()) => p.status === 'Delayed' || isOverdue(p, today);

// wrap async route handlers so errors reach the error middleware
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Adds engineer name, last update, report count etc. to a list of projects (2 queries total)
export async function decorateProjects(projects) {
  const list = projects.map((p) => (p.toJSON ? p.toJSON() : p));
  if (!list.length) return [];
  const engIds = [...new Set(list.map((p) => p.engineerId).filter(Boolean))];
  const ids = list.map((p) => p.id);
  const [users, stats] = await Promise.all([
    User.find({ _id: { $in: engIds } }, { name: 1 }).lean(),
    Report.aggregate([
      { $match: { projectId: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$projectId', count: { $sum: 1 }, last: { $first: '$$ROOT' } } },
    ]),
  ]);
  const names = Object.fromEntries(users.map((u) => [u._id, u.name]));
  const st = Object.fromEntries(stats.map((s) => [s._id, s]));
  const today = todayStr();
  return list.map((p) => {
    const s = st[p.id];
    const last = s?.last;
    return {
      ...p,
      engineerName: names[p.engineerId] || 'Unassigned',
      overdue: isOverdue(p, today),
      lastReportDate: last ? last.reportDate : null,
      lastReportAt: last ? last.createdAt : null,
      reportCount: s ? s.count : 0,
      progressPercent: last && last.progressPercent != null ? last.progressPercent : p.progressPercent ?? 0,
    };
  });
}
