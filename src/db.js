// MongoDB (Mongoose) data layer.
// Uses the database named in MONGO_URI (no new database is created) and keeps all
// Execution Portal data in collections prefixed with "ep_" so it never touches other apps' data.
import mongoose from 'mongoose';
import crypto from 'crypto';
import { config, ROLES, PROJECT_STATUSES, PRIORITIES, MATERIAL_STATUSES } from './config.js';

const P = config.collectionPrefix;
export const newId = () => crypto.randomUUID();

const toJSON = {
  virtuals: false,
  versionKey: false,
  transform(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.passwordHash;
    delete ret.tokenVersion;
    return ret;
  },
};
const opts = (collection) => ({ collection: P + collection, timestamps: true, toJSON, toObject: toJSON });
const idField = { type: String, default: newId };

const userSchema = new mongoose.Schema({
  _id: idField,
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  employeeId: { type: String, trim: true, uppercase: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  designation: { type: String, trim: true },
  role: { type: String, enum: Object.values(ROLES), required: true },
  active: { type: Boolean, default: true },
  passwordHash: { type: String, required: true },
  tokenVersion: { type: Number, default: 0 }, // bump to invalidate all existing logins
  mustChangePassword: { type: Boolean, default: false },
  passwordSetAt: Date,
  pendingSeenDate: String,
  createdBy: String,
}, opts('users'));
userSchema.index({ employeeId: 1 }, { unique: true, partialFilterExpression: { employeeId: { $type: 'string', $gt: '' } } });

const projectSchema = new mongoose.Schema({
  _id: idField,
  name: { type: String, required: true, trim: true },
  client: String,
  location: String,
  engineerId: { type: String, default: null, index: true },
  startDate: String,
  expectedDate: String,
  scope: String,
  priority: { type: String, enum: PRIORITIES, default: 'Medium' },
  instructions: String,
  status: { type: String, enum: PROJECT_STATUSES, default: 'Not Started', index: true },
  progressPercent: { type: Number, default: 0 },
  workSchedule: { type: mongoose.Schema.Types.Mixed, default: undefined }, // project Work Schedule (activities, timeline meta)
  assignmentHistory: [{ _id: false, engineerId: String, at: Date, by: String }],
  assignedAt: Date, // when the project was last assigned to a team member
  // Source Sales handover (set when a project is auto-created from an ACCEPTED handover).
  // Uniquely indexed below (not here) so the same handover can never create two projects.
  handoverId: { type: String, default: null },
  handoverRef: { type: String, default: null },
  // Attachment metadata copied from the handover so the assigned engineer can view/download them.
  handoverAttachments: [{ _id: false, fileId: String, filename: String, mime: String, size: Number }],
  createdBy: String,
}, opts('projects'));
// Distinct name (not the auto "handoverId_1") so it never collides with an older index of that name.
projectSchema.index({ handoverId: 1 }, { unique: true, partialFilterExpression: { handoverId: { $type: 'string' } }, name: 'handoverId_unique' });

const photoSchema = new mongoose.Schema({ id: String, fileId: String, originalName: String, size: Number, contentType: String, uploadedAt: Date }, { _id: false });
const reportSchema = new mongoose.Schema({
  _id: idField,
  engineerId: { type: String, index: true },
  engineerName: String,
  projectId: { type: String, index: true },
  projectName: String,
  siteLocation: String,
  reportDate: { type: String, index: true }, // YYYY-MM-DD (portal timezone)
  todayProgress: String,
  workCompleted: String,
  tomorrowPlan: String,
  materialRequired: String,
  materialStatus: { type: String, enum: [...MATERIAL_STATUSES, ''], default: '' },
  materialHistory: [{ _id: false, from: String, to: String, by: String, at: Date }],
  issues: String,
  remarks: String,
  progressPercent: { type: Number, default: null },
  projectStatus: String,
  photos: [photoSchema],
}, opts('reports'));
reportSchema.index({ projectId: 1, createdAt: -1 });

const commentSchema = new mongoose.Schema({
  _id: idField,
  projectId: { type: String, index: true },
  reportId: { type: String, default: null, index: true },
  authorId: String,
  authorName: String,
  authorRole: String,
  text: String,
}, opts('comments'));

const notificationSchema = new mongoose.Schema({
  _id: idField,
  userId: { type: String, index: true },
  type: String,
  title: String,
  message: String,
  link: String,
  read: { type: Boolean, default: false },
}, opts('notifications'));
notificationSchema.index({ userId: 1, createdAt: -1 });

const designationSchema = new mongoose.Schema({
  _id: idField,
  name: { type: String, required: true, trim: true },
  key: { type: String, required: true, unique: true }, // upper-case name, prevents duplicates
  createdBy: String,
}, opts('designations'));

export const DEFAULT_DESIGNATIONS = ['FABRICATION ENGINEER', 'TECHNO COMMERCIAL MANAGER', 'SENIOR SITE ENGINEER'];

// ---- Work Schedule tasks (linked to an accepted project; assigned to a team member) ----
export const TASK_STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Changes Requested'];
export const TASK_PRIORITIES = ['Low', 'Medium', 'High'];

const taskAttachmentSchema = new mongoose.Schema({
  fileId: String, filename: String, mime: String, size: Number,
  kind: { type: String, default: 'reference' }, // 'reference' (Head) | 'progress' (team)
  uploadedBy: String, uploadedByName: String, uploadedAt: { type: Date, default: Date.now },
}, { _id: false });
const taskHistorySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now }, byId: String, byName: String, byRole: String, type: String, message: String,
}, { _id: false });

const taskSchema = new mongoose.Schema({
  _id: idField,
  projectId: { type: String, index: true, required: true }, // the accepted project (never a duplicate project)
  projectName: String,
  engineerId: { type: String, default: null, index: true }, // assigned team member
  title: { type: String, required: true, trim: true },
  description: String,
  instructions: String,
  priority: { type: String, enum: TASK_PRIORITIES, default: 'Medium' },
  startDate: String, // YYYY-MM-DD
  endDate: String,   // deadline YYYY-MM-DD
  status: { type: String, enum: TASK_STATUSES, default: 'Not Started', index: true },
  approvalState: { type: String, enum: ['', 'pending', 'approved', 'changes'], default: '' },
  dependsOn: [String], // task ids that must finish first
  attachments: [taskAttachmentSchema],
  progressRemarks: String,
  completionDetails: String,
  delayReason: String,
  extensionRequested: { type: Boolean, default: false },
  extensionReason: String,
  extensionUntil: String,
  reviewRemarks: String, // Head's "request changes" remarks
  assignedAt: Date,
  completedAt: Date,
  approvedAt: Date,
  history: [taskHistorySchema], // append-only — never overwritten
  createdBy: String,
}, opts('tasks'));
taskSchema.index({ engineerId: 1, status: 1 });
taskSchema.index({ projectId: 1, createdAt: -1 });

export const User = mongoose.model('User', userSchema);
export const Designation = mongoose.model('Designation', designationSchema);
export const Project = mongoose.model('Project', projectSchema);
export const Report = mongoose.model('Report', reportSchema);
export const Comment = mongoose.model('Comment', commentSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const Task = mongoose.model('Task', taskSchema);

let bucket, taskBucket_;
// Site photos are stored in MongoDB GridFS (bucket "ep_photos"), so they survive redeploys.
export const photoBucket = () => bucket;
// Task reference/progress files live in GridFS bucket "ep_taskfiles".
export const taskBucket = () => taskBucket_;

export async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, {
    dbName: config.mongoDbName,
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });
  const db = mongoose.connection.db;
  bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: P + 'photos' });
  taskBucket_ = new mongoose.mongo.GridFSBucket(db, { bucketName: P + 'taskfiles' });
  // Drop any stale/legacy "handoverId_1" index so the new "handoverId_unique" can be created
  // cleanly (an older build created a non-unique handoverId_1 that conflicts by name).
  try { await db.collection(P + 'projects').dropIndex('handoverId_1'); } catch { /* not present — fine */ }
  // Index building must never crash startup — the app works without them (idempotency is enforced
  // in code too). Sync each model independently and only warn on failure.
  await Promise.all([User, Project, Report, Comment, Notification, Designation, Task].map(
    (m) => m.syncIndexes().catch((e) => console.warn(`[index] ${m.modelName}: ${e.message}`))
  ));
  // make sure the standard designations exist (never duplicates, never removes custom ones)
  await Promise.all(DEFAULT_DESIGNATIONS.map((name) => addDesignation(name)));
  return db;
}

export const dbState = () => ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';

// Adds a designation if it does not exist yet (case-insensitive). Returns the stored name.
export async function addDesignation(name, createdBy) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!clean) return '';
  const doc = await Designation.findOneAndUpdate(
    { key: clean },
    { $setOnInsert: { _id: newId(), name: clean, key: clean, createdBy } },
    { upsert: true, new: true }
  );
  return doc.name;
}
