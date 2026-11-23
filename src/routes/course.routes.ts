import { Router } from 'express';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { canAccessBatches } from '../services/batchAccess.service.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { resolveCourse } from '../controllers/course.controller.js';
import { type Request, type Response, type NextFunction } from 'express';
import mongoose from 'mongoose';
import { Batch } from '../models/timetable.model.js';
import { CourseLesson } from '../models/course.model.js';
import { checkUserPermission, requirePermission } from '../middlewares/checkPermission.middleware.js';
import {
  getEnrolledCourses,
  getCourseDetails,
  getCourseLeaderboard,
  getLessonDetails,
  updateLessonProgress,
  recordVideoTelemetry,
  submitQuizAnswers,
  toggleLessonReaction,
  getLessonComments,
  addLessonComment,
  toggleCommentLike,
  toggleLessonBookmark,
  claimCourseCertificate,
  getAdminCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  addCourseModule,
  updateCourseModule,
  deleteCourseModule,
  addCourseLesson,
  updateCourseLesson,
  deleteCourseLesson,
  postCourseAnnouncement,
  scheduleLiveSession,
  getCourseAnalytics,
  enrollBatchToCourse,
  getAdminRecordings,
  addAdminRecording,
} from '../controllers/course.controller.js';

const router = Router();

// ============================================================================
// STUDENT COURSES & LMS ROUTES (Requires Authentication)
// ============================================================================
router.use(protect);

// 1. Enrolled Courses Hub
router.get('/enrolled', getEnrolledCourses);

// 2. Admin Course Management (Restricted to Admin / Faculty)
router.use('/admin', (req, res, next) => requirePermission(req.method === 'GET' ? 'courses:view' : 'courses:manage')(req, res, next));
router.get('/admin/batches', requirePermission('courses:manage'), catchAsync(async (_req: Request, res: Response) => {
  const batches = await Batch.find({ archived: { $ne: true } }).select('name code examination').sort({ name: 1 }).lean();
  res.json({ status: 'success', data: batches });
}));
router.get('/admin/all', restrictTo('admin', 'faculty'), getAdminCourses);
router.post('/admin', restrictTo('admin', 'faculty'), createCourse);
router.put('/admin/:courseId', restrictTo('admin', 'faculty'), updateCourse);
router.delete('/admin/:courseId', restrictTo('admin', 'faculty'), deleteCourse);

// Admin Digital Recordings Vault
router.get('/admin/recordings', restrictTo('admin', 'faculty'), getAdminRecordings);
router.post('/admin/recordings', restrictTo('admin', 'faculty'), addAdminRecording);

// Admin Modules
router.post('/admin/:courseId/modules', restrictTo('admin', 'faculty'), addCourseModule);
router.put('/admin/:courseId/modules/:moduleId', restrictTo('admin', 'faculty'), updateCourseModule);
router.delete('/admin/:courseId/modules/:moduleId', restrictTo('admin', 'faculty'), deleteCourseModule);

// Admin Lessons
router.post('/admin/:courseId/modules/:moduleId/lessons', restrictTo('admin', 'faculty'), addCourseLesson);
router.put('/admin/:courseId/lessons/:lessonId', restrictTo('admin', 'faculty'), updateCourseLesson);
router.delete('/admin/:courseId/lessons/:lessonId', restrictTo('admin', 'faculty'), deleteCourseLesson);

// Admin Course Enhancements
router.post('/admin/:courseId/announcements', restrictTo('admin', 'faculty'), postCourseAnnouncement);
router.post('/admin/:courseId/live-sessions', restrictTo('admin', 'faculty'), scheduleLiveSession);
router.get('/admin/:courseId/analytics', restrictTo('admin', 'faculty'), getCourseAnalytics);
router.post('/admin/:courseId/enroll-batch', restrictTo('admin', 'faculty'), enrollBatchToCourse);

router.use('/:courseId', catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  const course = await resolveCourse(req.params.courseId);
  if (!course) throw new ApiError(404, 'Course not found.');
  if (req.user!.role === 'student' && course.status !== 'published') throw new ApiError(404, 'Course not found.');
  if (req.user!.role !== 'student' && !checkUserPermission(req.user!, 'courses:view')) throw new ApiError(403, 'Course permission required.');
  if (req.user!.role === 'student') {
    const allowed = course.batchIds.length ? await canAccessBatches(req.user!, course.batchIds) : course.isPublic;
    if (!allowed) throw new ApiError(403, 'Enrollment is required to access this course.');
  }
  next();
}));
router.use('/:courseId/lessons/:lessonId', catchAsync(async (req: Request, _res: Response, next: NextFunction) => {
  if (mongoose.isValidObjectId(req.params.lessonId)) {
    const course = await resolveCourse(req.params.courseId);
    if (!course || !await CourseLesson.exists({ _id: req.params.lessonId, courseId: course._id })) throw new ApiError(404, 'Lesson not found in this course.');
  }
  next();
}));

// 3. Course Details, Modules & Leaderboard
router.get('/:courseId', getCourseDetails);
router.get('/:courseId/leaderboard', getCourseLeaderboard);
router.post('/:courseId/claim-certificate', claimCourseCertificate);

// 4. Lesson Player & Interactive Actions
router.get('/:courseId/lessons/:lessonId', getLessonDetails);
router.post('/:courseId/lessons/:lessonId/progress', updateLessonProgress);
router.post('/:courseId/lessons/:lessonId/telemetry', recordVideoTelemetry);
router.post('/:courseId/lessons/:lessonId/quiz-submit', submitQuizAnswers);
router.post('/:courseId/lessons/:lessonId/reaction', toggleLessonReaction);
router.post('/:courseId/lessons/:lessonId/bookmark', toggleLessonBookmark);

// 5. Threaded Comments & Discussion
router.get('/:courseId/lessons/:lessonId/comments', getLessonComments);
router.post('/:courseId/lessons/:lessonId/comments', addLessonComment);
router.post('/:courseId/lessons/:lessonId/comments/:commentId/like', toggleCommentLike);

export default router;
