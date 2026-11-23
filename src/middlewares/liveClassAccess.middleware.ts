import { type Request, type Response, type NextFunction } from 'express';
import LiveClass from '../models/liveClass.model.js';
import { ArchivedClass } from '../models/archivedClass.model.js';
import { canAccessBatches } from '../services/batchAccess.service.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import { checkUserPermission } from './checkPermission.middleware.js';

export const requireLiveClassAccess = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  const lecture = await LiveClass.findById(req.params.id);
  if (!lecture) throw new ApiError(404, 'Class not found.');
  const user = req.user!;
  if (user.role === 'faculty' && String(lecture.faculty) === String(user._id)) return next();
  if (!(lecture.isPublic && !lecture.batchIds.length) && !(await canAccessBatches(user, lecture.batchIds))) throw new ApiError(403, 'You do not have access to this class.');
  next();
});

export const requireArchiveAccess = catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  const archive = await ArchivedClass.findById(req.params.archiveId);
  if (!archive || (!archive.isPublished && req.user!.role === 'student')) throw new ApiError(404, 'Recording not found.');
  if (req.user!.role === 'faculty' && archive.originalClassId && checkUserPermission(req.user!, 'live_classes:view')) {
    const lecture = await LiveClass.findById(archive.originalClassId).select('faculty');
    if (lecture && String(lecture.faculty) === String(req.user!._id)) return next();
  }
  if (!(archive.isPublic && !archive.batchIds.length) && !(await canAccessBatches(req.user!, archive.batchIds))) throw new ApiError(403, 'You do not have access to this recording.');
  next();
});
