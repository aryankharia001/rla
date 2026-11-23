import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { ExamResource, resourceModules } from '../models/examResource.model.js';
import { Batch } from '../models/timetable.model.js';
import { accessibleBatchIds } from '../services/batchAccess.service.js';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/checkPermission.middleware.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';

const router = Router();
router.use(protect);
router.get('/', catchAsync(async (req: Request, res: Response) => {
  const examination = String(req.query.examination || ''); const module = String(req.query.module || '');
  if (!['clat', 'pu-law'].includes(examination) || !resourceModules.includes(module as typeof resourceModules[number]) || (examination === 'clat' ? module.startsWith('pu-') : !module.startsWith('pu-'))) throw new ApiError(400, 'Invalid examination module.');
  const ids = await accessibleBatchIds(req.user!);
  const data = await ExamResource.find({ examination, module, isPublished: true, $or: [{ isPreview: true, batchIds: { $size: 0 } }, { batchIds: { $in: ids } }] }).sort({ createdAt: -1 }).lean();
  res.json({ status: 'success', data });
}));
router.use('/admin', restrictTo('admin'), requirePermission('courses:manage'));
router.get('/admin', catchAsync(async (_req: Request, res: Response) => { res.json({ status: 'success', data: await ExamResource.find().sort({ createdAt: -1 }).lean() }); }));
router.post('/admin', catchAsync(async (req: Request, res: Response) => {
  const { examination, module, title, content, batchIds, isPreview, isPublished } = req.body;
  if (!['clat', 'pu-law'].includes(examination) || !resourceModules.includes(module) || (examination === 'clat' ? String(module).startsWith('pu-') : !String(module).startsWith('pu-'))) throw new ApiError(400, 'Invalid examination module.');
  if (!Array.isArray(batchIds) || batchIds.some((id: unknown) => !mongoose.isValidObjectId(id))) throw new ApiError(400, 'Invalid batch selection.');
  if (isPreview === true && batchIds.length) throw new ApiError(400, 'A public preview cannot contain batch-restricted content.');
  if (!isPreview && !batchIds.length) throw new ApiError(400, 'Select a batch for paid content.');
  if (await Batch.countDocuments({ _id: { $in: batchIds }, examination }) !== new Set(batchIds.map(String)).size) throw new ApiError(400, 'Batches must belong to the selected examination.');
  const item = await ExamResource.create({ examination, module, title, content, batchIds, isPreview: isPreview === true, isPublished: isPublished === true });
  res.status(201).json({ status: 'success', data: item });
}));
router.patch('/admin/:id', catchAsync(async (req: Request, res: Response) => {
  const item = await ExamResource.findById(req.params.id);
  if (!item) throw new ApiError(404, 'Resource not found.');
  for (const key of ['title', 'content', 'isPublished'] as const) if (Object.hasOwn(req.body, key)) (item as any)[key] = req.body[key];
  await item.save(); res.json({ status: 'success', data: item });
}));
export default router;
