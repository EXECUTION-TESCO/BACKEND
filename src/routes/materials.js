// Material Requirements (Phase 4) — Execution raises requirements to the Procurement Portal.
// Writes to the shared "material_requests" collection; Procurement reads/updates the same docs.
import { Router } from 'express';
import { Project } from '../db.js';
import { requireAuth } from '../auth.js';
import { clean, ah } from '../utils.js';
import { config } from '../config.js';
import { materialModels, nextMaterialRef } from '../material-request-model.js';

const r = Router();
r.use(requireAuth);

const M = materialModels();
const isHead = (u) => u.role === 'head';
const actorOf = (u) => ({ id: u._id, name: u.name, role: u.role, portal: 'execution' });

// Project ids the member may raise/see materials for (engineer of, or has a task on).
async function myProjectIds(user) {
  const list = await Project.find({ $or: [{ engineerId: user._id }, { 'dailyTasks.assigneeId': user._id }] }, { _id: 1 }).lean();
  return list.map((p) => p._id);
}

// ---- List (optionally for one project) ----
r.get('/', ah(async (req, res) => {
  const q = {};
  if (req.query.projectId) q.projectId = req.query.projectId;
  if (!isHead(req.user)) {
    const ids = await myProjectIds(req.user);
    q.$or = [{ 'createdBy.id': req.user._id }, { projectId: { $in: ids } }];
  }
  const list = await M.MaterialRequest.find(q).sort({ createdAt: -1 }).limit(500);
  res.json({ requests: list.map((x) => x.toJSON()) });
}));

// ---- Raise a requirement (Head, or the project's assigned engineer) ----
r.post('/', ah(async (req, res) => {
  const b = req.body || {};
  const p = await Project.findById(b.projectId);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!isHead(req.user) && p.engineerId !== req.user._id) return res.status(403).json({ error: 'Only the Execution Head or the assigned team member can raise materials for this project' });
  const material = clean(b.material);
  if (!material) return res.status(400).json({ error: 'Enter the material / item name' });

  const doc = await M.MaterialRequest.create({
    ref: await nextMaterialRef(M, config.tz),
    projectId: p._id, projectName: p.name, handoverRef: p.handoverRef || null,
    material, spec: clean(b.spec) || '', qty: Number(b.qty) || 0, unit: clean(b.unit) || '',
    neededBy: clean(b.neededBy) || '', notes: clean(b.notes) || '',
    status: 'Pending Approval',
    createdBy: actorOf(req.user),
    statusLog: [{ to: 'Pending Approval', by: req.user.name, portal: 'execution', at: new Date(), note: 'Request raised' }],
    procurementSeen: false,  // new / pending for Procurement
    requesterSeen: true,
  });
  res.status(201).json({ request: doc.toJSON() });
}));

// ---- Requester marks their status updates as seen (clears the Execution bell) ----
r.patch('/seen', ah(async (req, res) => {
  await M.MaterialRequest.updateMany({ 'createdBy.id': req.user._id, requesterSeen: false }, { $set: { requesterSeen: true } });
  res.json({ ok: true });
}));

// ---- Delete a requirement (creator or Head) while still Requested ----
r.delete('/:id', ah(async (req, res) => {
  const doc = await M.MaterialRequest.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Request not found' });
  if (!isHead(req.user) && (doc.createdBy && doc.createdBy.id) !== req.user._id) return res.status(403).json({ error: 'Not allowed' });
  if (doc.status !== 'Pending Approval') return res.status(400).json({ error: `A "${doc.status}" requirement can no longer be withdrawn` });
  await doc.deleteOne();
  res.json({ ok: true });
}));

export default r;
