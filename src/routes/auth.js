import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { User } from '../db.js';
import { signToken, requireAuth, requireHead, hashPassword, checkPassword, passwordProblem, publicUser } from '../auth.js';
import { clean, ah } from '../utils.js';

const r = Router();

// brute-force protection on login / setup
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' } });

r.get('/setup-status', ah(async (req, res) => {
  res.json({ needsSetup: !(await User.exists({ role: 'head' })) });
}));

// First run only: create the first Execution Head (Admin)
r.post('/setup', loginLimiter, ah(async (req, res) => {
  if (await User.exists({ role: 'head' })) return res.status(400).json({ error: 'Setup already completed' });
  const name = clean(req.body.name);
  const username = clean(req.body.username).toLowerCase();
  const password = req.body.password || '';
  if (!name || !username) return res.status(400).json({ error: 'Name and username are required' });
  const bad = passwordProblem(password);
  if (bad) return res.status(400).json({ error: bad });
  const user = await User.create({
    name, username, employeeId: clean(req.body.employeeId) || undefined, phone: clean(req.body.phone),
    role: 'head', passwordHash: await hashPassword(password), passwordSetAt: new Date(),
  });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

r.post('/login', loginLimiter, ah(async (req, res) => {
  const id = clean(req.body.username).toLowerCase();
  const role = req.body.role;
  if (!id || !req.body.password) return res.status(400).json({ error: 'Enter your username and password' });
  if (role !== 'head' && role !== 'engineer') return res.status(400).json({ error: 'Select your role (Execution Head or Execution Team)' });
  const user = await User.findOne({ $or: [{ username: id }, { employeeId: id.toUpperCase() }, { email: id }] });
  const ok = user && (await checkPassword(req.body.password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Wrong username / Employee ID or password' });
  if (!user.active) return res.status(403).json({ error: 'Your account is disabled. Contact the Execution Head.' });
  if (role !== user.role) {
    return res.status(403).json({ error: user.role === 'head' ? 'This is an Execution Head login — select "Execution Head" as the role.' : 'This is an Execution Team login — select "Execution Team" as the role.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
}));

r.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

// Update your own profile (name / designation / contact). Username and role stay fixed.
r.put('/profile', requireAuth, ah(async (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
  req.user.name = name;
  if (req.body.designation !== undefined) req.user.designation = clean(req.body.designation);
  if (req.body.phone !== undefined) req.user.phone = clean(req.body.phone);
  if (req.body.email !== undefined) req.user.email = clean(req.body.email);
  await req.user.save();
  res.json({ user: publicUser(req.user) });
}));

// Only the Execution Head changes their own password; team members' passwords are managed by the Head (Reset Password)
r.post('/change-password', requireAuth, requireHead, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await checkPassword(currentPassword, req.user.passwordHash))) return res.status(400).json({ error: 'Current password is wrong' });
  const bad = passwordProblem(newPassword);
  if (bad) return res.status(400).json({ error: bad });
  if (newPassword === currentPassword) return res.status(400).json({ error: 'New password must be different' });
  req.user.passwordHash = await hashPassword(newPassword);
  req.user.mustChangePassword = false;
  req.user.passwordSetAt = new Date();
  req.user.tokenVersion = (req.user.tokenVersion || 0) + 1; // log out other devices
  await req.user.save();
  res.json({ ok: true, token: signToken(req.user), user: publicUser(req.user) });
}));

export default r;
