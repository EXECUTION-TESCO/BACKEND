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

// A daily task the Execution Head assigns to a team member on a project.
export const TASK_STATUSES = ['To Do', 'In Progress', 'Done'];
const taskJSON = { virtuals: false, versionKey: false, transform(doc, ret) { ret.id = ret._id; delete ret._id; return ret; } };
const dailyTaskSchema = new mongoose.Schema({
  _id: idField,
  title: { type: String, required: true, trim: true },
  details: { type: String, default: '' },
  dueDate: { type: String, default: '' },            // YYYY-MM-DD
  status: { type: String, enum: TASK_STATUSES, default: 'To Do' },
  assigneeId: { type: String, default: null },        // the team member responsible
  createdBy: String,
  completedAt: Date,
  // Recorded each time the Head moves this task to another member.
  reassignHistory: [{ _id: false, fromId: String, toId: String, at: Date, by: String }],
}, { timestamps: true, toJSON: taskJSON, toObject: taskJSON });

const projectSchema = new mongoose.Schema({
  _id: idField,
  name: { type: String, required: true, trim: true },
  client: String,
  location: String,
  engineerId: { type: String, default: null, index: true },
  startDate: String,
  expectedDate: String,
  scope: String,
  // Commercial & size values carried over from the Sales handover (view-only in Execution).
  projectValue: { type: Number, default: 0 },   // total quoted value of the project
  length: { type: Number, default: 0 },          // in `unit`
  width: { type: Number, default: 0 },
  unit: { type: String, default: 'ft' },         // ft | m
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
  // Daily tasks the Head assigns to team members (Phase 2).
  dailyTasks: [dailyTaskSchema],
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
  client: String,            // client name copied from the project (for lists & PDF)
  siteLocation: String,
  reportDate: { type: String, index: true }, // YYYY-MM-DD (portal timezone)
  // Selected work activities (from the fixed list) for today and tomorrow — multiple allowed.
  todayActivities: { type: [String], default: [] },
  tomorrowActivities: { type: [String], default: [] },
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

// A work schedule the Execution Head shares with ONE team member (date-wise history kept).
const workScheduleSchema = new mongoose.Schema({
  _id: idField,
  projectId: { type: String, index: true },
  projectName: String,
  assigneeId: { type: String, index: true },   // the team member it is shared with
  assigneeName: String,
  workDetails: { type: String, default: '' },
  startDate: { type: String, default: '' },               // YYYY-MM-DD
  expectedCompletionDate: { type: String, default: '' },  // YYYY-MM-DD
  instructions: { type: String, default: '' },
  createdBy: { id: String, name: String },
}, opts('work_schedules'));
workScheduleSchema.index({ assigneeId: 1, createdAt: -1 });

export const DEFAULT_DESIGNATIONS = ['FABRICATION ENGINEER', 'TECHNO COMMERCIAL MANAGER', 'SENIOR SITE ENGINEER'];

export const User = mongoose.model('User', userSchema);
export const Designation = mongoose.model('Designation', designationSchema);
export const Project = mongoose.model('Project', projectSchema);
export const Report = mongoose.model('Report', reportSchema);
export const Comment = mongoose.model('Comment', commentSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const WorkScheduleShare = mongoose.model('WorkScheduleShare', workScheduleSchema);

let bucket;
// Site photos are stored in MongoDB GridFS (bucket "ep_photos"), so they survive redeploys.
export const photoBucket = () => bucket;

export async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, {
    dbName: config.mongoDbName,
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 20,
  });
  const db = mongoose.connection.db;
  bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: P + 'photos' });
  // Drop any stale/legacy "handoverId_1" index so the new "handoverId_unique" can be created
  // cleanly (an older build created a non-unique handoverId_1 that conflicts by name).
  try { await db.collection(P + 'projects').dropIndex('handoverId_1'); } catch { /* not present — fine */ }
  // Index building must never crash startup — the app works without them (idempotency is enforced
  // in code too). Sync each model independently and only warn on failure.
  await Promise.all([User, Project, Report, Comment, Notification, Designation, WorkScheduleShare].map(
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
