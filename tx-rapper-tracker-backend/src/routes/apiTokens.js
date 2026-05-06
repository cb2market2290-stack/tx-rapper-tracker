import express from 'express';
import { requireUser } from '../middleware/authenticate.js';
import { createToken, listTokens, revokeToken } from '../services/apiTokens.js';

const router = express.Router();

// All token routes require session auth + Premium
router.use(requireUser());

router.post('/', async (req, res, next) => {
  try {
    const { label } = req.body ?? {};
    const result = await createToken(req.user.id, label ?? null);
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const tokens = await listTokens(req.user.id);
    res.json(tokens);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const row = await revokeToken(req.user.id, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'token not found or already revoked' });
    res.json({ revoked: true });
  } catch (e) { next(e); }
});

export default router;
