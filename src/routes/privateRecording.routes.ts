import { Router, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { checkUserPermission, requirePermission } from '../middlewares/checkPermission.middleware.js';
import { requireArchiveAccess } from '../middlewares/liveClassAccess.middleware.js';
import LiveClass from '../models/liveClass.model.js';
import { ArchivedClass } from '../models/archivedClass.model.js';
import { CourseLesson } from '../models/course.model.js';
import { resolveCourse } from '../controllers/course.controller.js';
import { canAccessBatches } from '../services/batchAccess.service.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';

// This directory must not be served by a web server or an object-store public URL.
const storageDir = path.resolve(process.env.PRIVATE_RECORDINGS_DIR || path.join(process.cwd(), 'private-recordings'));
fs.mkdirSync(storageDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: storageDir, filename: (_req, _file, cb) => cb(null, `${randomUUID()}.mp4`) }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => file.mimetype === 'video/mp4' ? cb(null, true) : cb(new ApiError(400, 'Upload an MP4 recording.')),
});
const uploadHandout = multer({
  storage: multer.diskStorage({ destination: storageDir, filename: (_req, _file, cb) => cb(null, randomUUID() + '.pdf') }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => file.mimetype === 'application/pdf' ? cb(null, true) : cb(new ApiError(400, 'Upload a PDF handout.')),
});
const router = Router();
router.use(protect);

router.post('/lesson/:courseId/:lessonId', restrictTo('admin', 'faculty'), requirePermission('courses:manage'), catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  const course = await resolveCourse(req.params.courseId);
  if (!course || !await CourseLesson.exists({ _id: req.params.lessonId, courseId: course._id, type: 'video' })) throw new ApiError(404, 'Video lesson not found.');
  next();
}), upload.single('recording'), catchAsync(async (req: Request, res: Response) => {
  if (!req.file) throw new ApiError(400, 'An MP4 recording is required.');
  try {
    const course = await resolveCourse(req.params.courseId);
    const lesson = course && await CourseLesson.findOne({ _id: req.params.lessonId, courseId: course._id, type: 'video' });
    if (!lesson) throw new ApiError(404, 'Video lesson not found.');
    lesson.privateVideoFilename = req.file.filename; await lesson.save();
    res.status(201).json({ status: 'success' });
  } catch (err) { await fs.promises.unlink(req.file.path).catch(() => undefined); throw err; }
}));

router.get('/lesson/:courseId/:lessonId', catchAsync(async (req: Request, res: Response) => {
  const course = await resolveCourse(req.params.courseId);
  if (!course) throw new ApiError(404, 'Course not found.');
  if (req.user!.role === 'student' && course.status !== 'published') throw new ApiError(404, 'Course not found.');
  if (req.user!.role === 'student' && !(course.batchIds.length ? await canAccessBatches(req.user!, course.batchIds) : course.isPublic)) throw new ApiError(403, 'Batch access required.');
  if (req.user!.role !== 'student' && !checkUserPermission(req.user!, 'courses:view')) throw new ApiError(403, 'Course permission required.');
  const lesson = await CourseLesson.findOne({ _id: req.params.lessonId, courseId: course._id, type: 'video' }).select('+privateVideoFilename');
  const filename = lesson?.privateVideoFilename;
  if (!filename || !/^[0-9a-f-]{36}\.mp4$/.test(filename)) throw new ApiError(404, 'Private recording not available.');
  const filePath = path.join(storageDir, filename);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new ApiError(404, 'Private recording file not found.');
  res.set({ 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}));

router.post('/handout/:courseId/:lessonId', restrictTo('admin', 'faculty'), requirePermission('courses:manage'),
  catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
    const course = await resolveCourse(req.params.courseId);
    if (!course || !await CourseLesson.exists({ _id: req.params.lessonId, courseId: course._id, type: 'resource' })) {
      throw new ApiError(404, 'Handout lesson not found.');
    }
    next();
  }), uploadHandout.single('handout'), catchAsync(async (req: Request, res: Response) => {
    if (!req.file) throw new ApiError(400, 'A PDF handout is required.');
    try {
      const file = await fs.promises.open(req.file.path, 'r');
      try {
        const signature = Buffer.alloc(5);
        await file.read(signature, 0, signature.length, 0);
        if (signature.toString() !== '%PDF-') throw new ApiError(400, 'Upload a valid PDF handout.');
      } finally {
        await file.close();
      }
      const course = await resolveCourse(req.params.courseId);
      const previous = course && await CourseLesson.findOneAndUpdate(
        { _id: req.params.lessonId, courseId: course._id, type: 'resource' },
        { privateResourceFilename: req.file.filename },
      ).select('+privateResourceFilename');
      if (!previous) throw new ApiError(404, 'Handout lesson not found.');
      if (previous.privateResourceFilename && /^[0-9a-f-]{36}\.pdf$/.test(previous.privateResourceFilename)) {
        await fs.promises.unlink(path.join(storageDir, previous.privateResourceFilename)).catch(() => undefined);
      }
      res.status(201).json({ status: 'success' });
    } catch (err) {
      await fs.promises.unlink(req.file.path).catch(() => undefined);
      throw err;
    }
  }));

router.get('/handout/:courseId/:lessonId', catchAsync(async (req: Request, res: Response) => {
  const course = await resolveCourse(req.params.courseId);
  if (!course || (req.user!.role === 'student' && course.status !== 'published')) throw new ApiError(404, 'Course not found.');
  if (req.user!.role === 'student' && !(course.batchIds.length ? await canAccessBatches(req.user!, course.batchIds) : course.isPublic)) {
    throw new ApiError(403, 'Batch access required.');
  }
  if (req.user!.role !== 'student' && !checkUserPermission(req.user!, 'courses:view')) throw new ApiError(403, 'Course permission required.');
  const lesson = await CourseLesson.findOne({ _id: req.params.lessonId, courseId: course._id, type: 'resource' }).select('+privateResourceFilename');
  const filename = lesson?.privateResourceFilename;
  if (!filename || !/^[0-9a-f-]{36}\.pdf$/.test(filename)) throw new ApiError(404, 'Private handout not available.');
  const filePath = path.join(storageDir, filename);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new ApiError(404, 'Private handout not found.');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(stat.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.attachment('lesson-handout.pdf');
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}));

router.post('/class/:classId', restrictTo('admin', 'faculty'), requirePermission('live_classes:manage'), catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  const lecture = await LiveClass.findById(req.params.classId);
  if (!lecture) throw new ApiError(404, 'Class not found.');
  if (req.user!.role === 'faculty' && String(lecture.faculty) !== String(req.user!._id)) throw new ApiError(403, 'Only assigned faculty may manage this recording.');
  if (!lecture.batchIds.length || !['ended', 'recording_processing', 'archived'].includes(lecture.status)) throw new ApiError(400, 'Select a completed, batch-assigned class.');
  next();
}), upload.single('recording'), catchAsync(async (req: Request, res: Response) => {
  if (!req.file) throw new ApiError(400, 'An MP4 recording is required.');
  try {
    const lecture = await LiveClass.findById(req.params.classId);
    if (!lecture || !lecture.batchIds.length || !['ended', 'recording_processing', 'archived'].includes(lecture.status)) throw new ApiError(409, 'Class is no longer eligible for a recording.');
    let archive = lecture.archivedClassId ? await ArchivedClass.findById(lecture.archivedClassId) : null;
    if (!archive) archive = new ArchivedClass({ originalClassId: lecture._id, batchIds: lecture.batchIds, subject: lecture.subject, title: lecture.title, date: lecture.scheduledDate, duration: `${lecture.durationMinutes} min`, durationSeconds: lecture.durationMinutes * 60, faculty: lecture.facultyName, videoUrl: 'private-recording', isPublic: false });
    archive.privateRecordingFilename = req.file.filename;
    archive.batchIds = lecture.batchIds;
    archive.isPublic = false;
    archive.isPublished = true;
    await archive.save();
    lecture.archivedClassId = archive._id; lecture.status = 'archived'; await lecture.save();
    res.status(201).json({ status: 'success', data: { archiveId: archive._id } });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => undefined);
    throw err;
  }
}));

router.get('/:archiveId', requireArchiveAccess, catchAsync(async (req: Request, res: Response) => {
  const archive = await ArchivedClass.findById(req.params.archiveId).select('+privateRecordingFilename');
  const filename = archive?.privateRecordingFilename;
  if (!filename || !/^[0-9a-f-]{36}\.mp4$/.test(filename)) throw new ApiError(404, 'Private recording not available.');
  const filePath = path.join(storageDir, filename);
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new ApiError(404, 'Private recording file not found.');
  res.set({ 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}));
export default router;
