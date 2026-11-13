import { Router } from 'express';
import { Designation, User, addDesignation } from '../db.js';
import { requireAuth, requireHead } from '../auth.js';
import { ah } from '../utils.js';

const r = Router();
r.use(requireAuth);

// List for the designation dropdown (saved list + any older value already used on a login)
r.get('/', ah(async (req, res) => {
  const [saved, used] = await Promise.all([Designation.find({}, { name: 1 }).lean(), User.distinct('designation')]);
  const names = new Set(saved.map((d) => d.name));
  used.filter(Boolean).forEach((d) => names.add(String(d).toUpperCase()));
  res.json([...names].sort((a, b) => a.localeCompare(b)));
}));

// Execution Head adds a new designation
r.post('/', requireHead, ah(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Designation must be 2–60 characters' });
  res.status(201).json({ name: await addDesignation(name, req.user._id) });
}));

export default r;
