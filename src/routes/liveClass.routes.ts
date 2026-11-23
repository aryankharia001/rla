import { Router } from 'express';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { requireArchiveAccess, requireLiveClassAccess } from '../middlewares/liveClassAccess.middleware.js';
import { requirePermission } from '../middlewares/checkPermission.middleware.js';
import {
  getCurrentLiveClass,
  getUpcomingClasses,
  getArchivedClasses,
  getArchivedClassDetails,
  joinLiveClass,
  getMeetingCredentials,
  getMeetingHostCredentials,
  leaveLiveClass,
  heartbeatLiveClass,
  toggleAlertReminder,
  reactToArchivedClass,
  getArchivedClassComments,
  addArchivedClassComment,
  updateArchivedClassProgress,
  adminGetAllClasses,
  adminScheduleClass,
  adminStartClass,
  adminEndClass,
  adminGetAttendance,
  handleZoomWebhook,
} from '../controllers/liveClass.controller.js';

const router = Router();

// ============================================================================
// Public / Webhook Routes
// ============================================================================
router.post('/webhooks/zoom', handleZoomWebhook);

// ============================================================================
// Student Protected Routes
// ============================================================================
router.use(protect);

router.get('/current', getCurrentLiveClass);
router.get('/upcoming', getUpcomingClasses);
router.get('/archives', getArchivedClasses);
router.use('/archives/:archiveId', requireArchiveAccess);
router.get('/archives/:archiveId', getArchivedClassDetails);
router.post('/archives/:archiveId/react', reactToArchivedClass);
router.get('/archives/:archiveId/comments', getArchivedClassComments);
router.post('/archives/:archiveId/comments', addArchivedClassComment);
router.post('/archives/:archiveId/progress', updateArchivedClassProgress);

router.post('/:id/join', requireLiveClassAccess, joinLiveClass);
router.post('/:id/meeting-credentials', requireLiveClassAccess, getMeetingCredentials);
router.post('/:id/leave', requireLiveClassAccess, leaveLiveClass);
router.post('/:id/heartbeat', requireLiveClassAccess, heartbeatLiveClass);
router.post('/:id/alert-toggle', requireLiveClassAccess, toggleAlertReminder);

// ============================================================================
// Admin & Faculty Protected Routes
// ============================================================================
router.use(restrictTo('admin', 'faculty'));
router.use('/admin', (req, res, next) => requirePermission(req.method === 'GET' ? 'live_classes:view' : 'live_classes:manage')(req, res, next));

router.get('/admin/all', adminGetAllClasses);
router.post('/admin/schedule', adminScheduleClass);
router.post('/admin/:id/start', adminStartClass);
router.post('/admin/:id/host-credentials', getMeetingHostCredentials);
router.post('/admin/:id/end', adminEndClass);
router.get('/admin/:id/attendance', adminGetAttendance);

export default router;
