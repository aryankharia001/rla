import { Router, type Request, type Response } from 'express';
import mongoose, { Schema } from 'mongoose';
import { protect } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/checkPermission.middleware.js';
import { recordAuditLog } from '../services/auditLog.service.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';

const examinations = ['judiciary', 'clat', 'pu-law'];
const tabSchema = new Schema({
  _id: { type: String, required: true },
  examination: { type: String, enum: examinations, required: true, index: true },
  tab: { type: String, required: true },
  title: { type: String, maxlength: 80, default: '' },
  note: { type: String, maxlength: 1200, default: '' },
}, { timestamps: true });
const PortalTab = mongoose.model('PortalTab', tabSchema);

export const studentPortalRoutes = Router();
studentPortalRoutes.get('/:examination', protect, catchAsync(async (req: Request, res: Response) => {
  const examination = req.params.examination;
  if (typeof examination !== 'string' || !examinations.includes(examination)) throw new ApiError(400, 'Invalid examination.');
  const tabs = await PortalTab.find({ examination }).select('tab title note -_id').lean();
  res.set('Cache-Control', 'private, no-store').json({ data: tabs });
}));

export const adminPortalRoutes = Router();
adminPortalRoutes.put('/:examination/:tab', protect, requirePermission('settings:edit'), catchAsync(async (req: Request, res: Response) => {
  const { examination, tab } = req.params;
  const { title, note } = req.body ?? {};
  if (typeof examination !== 'string' || !examinations.includes(examination) || typeof tab !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(tab)) {
    throw new ApiError(400, 'Invalid student portal tab.');
  }
  if (typeof title !== 'string' || typeof note !== 'string' || title.trim().length > 80 || note.trim().length > 1200) {
    throw new ApiError(400, 'Enter a title up to 80 characters and a note up to 1,200 characters.');
  }
  const id = examination + ':' + tab;
  const content = { title: title.trim(), note: note.trim() };
  await PortalTab.findByIdAndUpdate(id, { $set: { examination, tab, ...content } }, { upsert: true, runValidators: true });
  await recordAuditLog(req, {
    action: 'settings:update',
    targetResource: 'student_portal_tab',
    targetResourceId: id,
    description: 'Administrator updated student portal tab content.',
  });
  res.json({ data: { tab, ...content } });
}));

