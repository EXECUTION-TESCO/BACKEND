// Create (and reconcile) Execution projects from ACCEPTED Sales handovers.
// Kept in one place so both the handover review route and the server bootstrap use the
// exact same logic. Idempotent — a handover can never produce two projects.
import { Project } from './db.js';

// Map a Sales handover document to Execution project fields.
export function projectFromHandover(h) {
  const d = h.details || {}, sc = h.scope || {}, tl = h.timeline || {};
  const design = [sc.design3D && '3D', sc.design2D && '2D'].filter(Boolean).join(' + ');
  const scopeText = [sc.typeOfProject, sc.projectSizeArea, design && `Design: ${design}`].filter(Boolean).join(' · ');
  const instructions = [
    h.ref && `From Sales handover ${h.ref}`,
    d.salespersonName && `Salesperson: ${d.salespersonName}`,
    d.contactDetails && `Contact: ${d.contactDetails}`,
    tl.leadTimePromised && `Lead time promised: ${tl.leadTimePromised}`,
  ].filter(Boolean).join('\n');
  return {
    name: h.projectName || d.projectLocation || h.clientName || h.ref || 'New Project',
    client: h.clientName || d.clientName || '',
    location: d.projectLocation || d.siteAddress || '',
    scope: scopeText,
    instructions,
    startDate: tl.tentativeStartDate || '',
    expectedDate: tl.tentativeCompletionDate || '',
    status: 'Not Started',
    priority: h.priority || 'Medium', // priority chosen by Sales on the handover form
    engineerId: null, // Execution Head assigns a team member later, from Projects
    handoverId: h._id,
    handoverRef: h.ref || null,
    handoverAttachments: (h.attachments || []).map((a) => ({ fileId: a.fileId, filename: a.filename, mime: a.mime, size: a.size })),
  };
}

// Create the Execution project for an accepted handover — idempotent (never duplicates,
// even if the same handover is processed twice or two requests race).
export async function ensureProjectForHandover(h, byUserId) {
  const existing = await Project.findOne({ handoverId: h._id });
  if (existing) return existing;
  try {
    return await Project.create({ ...projectFromHandover(h), createdBy: byUserId });
  } catch (e) {
    if (e && e.code === 11000) return Project.findOne({ handoverId: h._id }); // unique index caught a race
    throw e;
  }
}

// On startup: make sure every already-ACCEPTED handover has its project. This backfills
// handovers that were accepted before this feature existed (or before a restart).
export async function reconcileAcceptedHandovers(HO) {
  try {
    const accepted = await HO.Handover.find({ status: 'Accepted' }).lean();
    let created = 0;
    for (const h of accepted) {
      if (await Project.exists({ handoverId: h._id })) continue;
      await ensureProjectForHandover(h, (h.reviewedBy && h.reviewedBy.id) || (h.createdBy && h.createdBy.id) || null);
      created++;
    }
    if (created) console.log(`[handovers] Backfilled ${created} project(s) for already-accepted handover(s).`);
    return created;
  } catch (e) {
    console.error('[handovers] reconcile failed:', e.message);
    return 0;
  }
}
