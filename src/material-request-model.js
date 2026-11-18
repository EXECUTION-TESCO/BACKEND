// Shared "material request" model (Phase 4) — the bridge between the Execution Portal
// and the Procurement Portal. Both backends connect to the SAME MongoDB database and
// register this model on the shared, un-prefixed "material_requests" collection, exactly
// like the shared "ho_" handovers. Execution raises requirements; Procurement acts on them.
// Keep this schema in step with the Procurement model (backend/src/models/MaterialRequest.js).
import mongoose from 'mongoose';
import crypto from 'crypto';

export const MATERIAL_REQUEST_STATUSES = ['Requested', 'Ordered', 'Delivered', 'Rejected'];
const newId = () => crypto.randomUUID();
const toJSON = { virtuals: false, versionKey: false, transform(doc, ret) { ret.id = ret._id; delete ret._id; return ret; } };

let MODELS = null;

export function materialModels() {
  if (MODELS) return MODELS;

  const schema = new mongoose.Schema({
    _id: { type: String, default: newId },
    ref: { type: String, default: null },               // MR-2026-001
    // Source Execution project
    projectId: { type: String, index: true },
    projectName: String,
    handoverRef: { type: String, default: null },        // helps Procurement match its own project
    // What is needed
    material: { type: String, required: true },
    spec: { type: String, default: '' },
    qty: { type: Number, default: 0 },
    unit: { type: String, default: '' },
    neededBy: { type: String, default: '' },             // YYYY-MM-DD
    notes: { type: String, default: '' },
    // Procurement workflow
    status: { type: String, enum: MATERIAL_REQUEST_STATUSES, default: 'Requested', index: true },
    rejectReason: { type: String, default: '' },
    poRef: { type: String, default: '' },                // PO number once ordered / converted
    createdBy: { id: String, name: String, role: String, portal: String },
    statusLog: [{ _id: false, to: String, by: String, portal: String, at: Date, note: String }],
    // Cross-portal "unread" flags (each portal clears its own)
    procurementSeen: { type: Boolean, default: false },  // false => new/updated for Procurement
    requesterSeen: { type: Boolean, default: true },     // false => unread status update for the Execution requester
  }, { collection: 'material_requests', timestamps: true, toJSON, toObject: toJSON });
  schema.index({ 'createdBy.id': 1, createdAt: -1 });

  const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { collection: 'material_counters' });

  const MaterialRequest = mongoose.models.MaterialRequest || mongoose.model('MaterialRequest', schema);
  const MaterialCounter = mongoose.models.MaterialCounter || mongoose.model('MaterialCounter', counterSchema);

  MODELS = { MaterialRequest, MaterialCounter };
  return MODELS;
}

export async function nextMaterialRef(models, tz = 'Asia/Kolkata') {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date());
  const key = `MR-${year}`;
  const doc = await models.MaterialCounter.findByIdAndUpdate(key, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `${key}-${String(doc.seq).padStart(3, '0')}`;
}
