import { type Request, type Response, type NextFunction } from 'express';
import { Batch } from '../models/timetable.model.js';
import { accessibleBatchIds } from '../services/batchAccess.service.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';

/** Existing shared Judiciary content is available only to explicitly authorized batches. */
export const requireBatchModule = (module: string) => catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  if (req.user!.role !== 'student') return next();
  const ids = await accessibleBatchIds(req.user!);
  if (await Batch.exists({ _id: { $in: ids }, learningModules: module, $or: [{ examination: 'judiciary' }, { examination: { $exists: false } }] })) return next();
  throw new ApiError(403, 'Your batch does not include this learning resource.');
});

export const requireActiveBatch = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  if (req.user!.role !== 'student' || (await accessibleBatchIds(req.user!)).length) return next();
  throw new ApiError(403, 'Active batch enrollment is required.');
});
