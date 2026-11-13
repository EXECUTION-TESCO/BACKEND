import { Notification, User } from './db.js';

export async function notify(userId, { type, title, message, link = '' }) {
  if (!userId) return;
  await Notification.create({ userId, type, title, message, link });
}

export async function notifyHeads(payload, exceptId) {
  const heads = await User.find({ role: 'head', active: true, _id: { $ne: exceptId } }, { _id: 1 }).lean();
  if (heads.length) await Notification.insertMany(heads.map((h) => ({ userId: h._id, ...payload, link: payload.link || '' })));
}
