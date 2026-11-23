import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/checkPermission.middleware.js';
import { Batch, RecurringScheduleSlot } from '../models/timetable.model.js';
import { BatchEnrollment } from '../models/batchEnrollment.model.js';
import User from '../models/user.model.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import { PaymentOrder } from '../models/paymentOrder.model.js';

const router = Router();
router.use(protect);

router.get('/', catchAsync(async (req: Request, res: Response) => {
  const examination = req.query.examination;
  if (!['judiciary', 'clat', 'pu-law'].includes(String(examination))) throw new ApiError(400, 'Select a valid examination.');
  const batches = await Batch.find({ examination, published: true, enrollmentOpen: true, archived: false }).sort({ startDate: 1 }).lean();
  const memberships = await BatchEnrollment.find({ student: req.user!._id, batch: { $in: batches.map((b) => b._id) } }).lean();
  const pendingPayments = await PaymentOrder.find({ student: req.user!._id, batch: { $in: batches.map((b) => b._id) }, status: { $in: ['creating', 'pending'] } }).select('batch').lean();
  const schedule = await RecurringScheduleSlot.find({ batch: { $in: batches.map((b) => b._id) }, isActive: true }).select('batch dayOfWeek startTime endTime facultyName subject').sort({ startTime: 1 }).lean();
  const counts = await Promise.all(batches.map(async (batch) => {
    const all = await BatchEnrollment.find({ batch: batch._id }).select('student status accessEndsAt').lean();
    const active = all.filter((m) => m.status === 'active' && (!m.accessEndsAt || m.accessEndsAt > new Date())).length;
    const legacy = await User.countDocuments({ role: 'student', assignedBatch: batch._id, _id: { $nin: all.map((m) => m.student) } });
    const reserved = await PaymentOrder.countDocuments({ batch: batch._id, status: { $in: ['creating', 'pending'] } });
    return { _id: batch._id, count: active + legacy + reserved };
  }));
  res.json({ status: 'success', data: batches.map((batch) => {
    const membership = memberships.find((m) => String(m.batch) === String(batch._id));
    const enrolled = !!membership && membership.status === 'active' && (!!membership.paymentVerifiedAt || !!membership.complimentaryGrantedAt) && (!membership.accessEndsAt || membership.accessEndsAt > new Date());
    const count = counts.find((c) => String(c._id) === String(batch._id))?.count || 0;
    return { ...batch, enrolled, paymentPending: pendingPayments.some((payment) => String(payment.batch) === String(batch._id)), weeklySchedule: schedule.filter((slot) => String(slot.batch) === String(batch._id)).map((slot) => ({ day: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime, faculty: slot.facultyName, subject: slot.subject })), availableSeats: batch.capacity == null ? null : Math.max(0, batch.capacity - count) };
  }) });
}));

router.get('/mine', catchAsync(async (req: Request, res: Response) => {
  const memberships = await BatchEnrollment.find({ student: req.user!._id, status: 'active', $and: [{ $or: [{ paymentVerifiedAt: { $type: 'date' } }, { complimentaryGrantedAt: { $type: 'date' } }] }, { $or: [{ accessEndsAt: { $exists: false } }, { accessEndsAt: { $gt: new Date() } }] }] }).populate('batch').lean();
  res.json({ status: 'success', data: memberships });
}));

router.use('/admin', restrictTo('admin'), requirePermission('courses:manage'));
router.get('/admin/students', catchAsync(async (req: Request, res: Response) => {
  const term = String(req.query.search || '').trim();
  if (term.length < 2 || term.length > 100) throw new ApiError(400, 'Enter at least two characters.');
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const data = await User.find({ role: 'student', $or: [{ name: { $regex: escaped, $options: 'i' } }, { email: { $regex: escaped, $options: 'i' } }, { rollNo: { $regex: escaped, $options: 'i' } }] }).select('name rollNo email').limit(20).lean();
  res.json({ status: 'success', data });
}));
router.get('/admin', catchAsync(async (_req: Request, res: Response) => {
  res.json({ status: 'success', data: await Batch.find().sort({ createdAt: -1 }).lean() });
}));

const editable = ['name', 'code', 'examination', 'description', 'startDate', 'endDate', 'feePaise', 'capacity', 'published', 'enrollmentOpen', 'archived', 'shifts', 'defaultShiftId', 'allowShiftSwitch', 'status', 'sessionName', 'subtitle', 'learningModules'];
function fields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(editable.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
}
function validateDates(value: { startDate?: Date | null; endDate?: Date | null }): void {
  if (value.startDate && value.endDate && value.endDate < value.startDate) throw new ApiError(400, 'End date must not precede start date.');
}
// A persistent lock fails closed after a process crash; an operator must inspect
// and clear it before further enrollment changes. It never expires mid-write.
export async function withBatchLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const locked = await Batch.findOneAndUpdate({ _id: id, enrollmentLock: { $exists: false } }, { $set: { enrollmentLock: token } });
  if (!locked) {
    if (!await Batch.exists({ _id: id })) throw new ApiError(404, 'Batch not found.');
    throw new ApiError(409, 'Batch enrollment is being updated. Please try again.');
  }
  try { return await work(); }
  finally { await Batch.updateOne({ _id: id, enrollmentLock: token }, { $unset: { enrollmentLock: 1 } }); }
}
router.post('/admin', catchAsync(async (req: Request, res: Response) => {
  const batch = new Batch({ shifts: [], ...fields(req.body) });
  if (!batch.examination) throw new ApiError(400, 'Examination is required.');
  validateDates(batch);
  await batch.save();
  res.status(201).json({ status: 'success', data: batch });
}));
router.patch('/admin/:id', catchAsync(async (req: Request, res: Response) => {
  const batch = await withBatchLock(String(req.params.id), async () => {
    const found = await Batch.findById(req.params.id);
    if (!found) throw new ApiError(404, 'Batch not found.');
    found.set(fields(req.body)); validateDates(found); await found.save(); return found;
  });
  res.json({ status: 'success', data: batch });
}));
router.get('/admin/:id/enrollments', catchAsync(async (req: Request, res: Response) => {
  const data = await BatchEnrollment.find({ batch: req.params.id }).populate('student', 'name email phone rollNo').populate('enrolledBy', 'name').sort({ enrolledAt: -1 }).lean();
  res.json({ status: 'success', data });
}));
router.post('/admin/:id/enrollments', catchAsync(async (req: Request, res: Response) => {
  const { studentId, paymentVerified, complimentary } = req.body;
  if ((paymentVerified === true) === (complimentary === true)) throw new ApiError(400, 'Choose either verified payment or complimentary access.');
  if (!mongoose.isValidObjectId(studentId) || !mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'Invalid student or batch ID.');
  await withBatchLock(String(req.params.id), async () => {
      const batch = await Batch.findById(req.params.id);
      if (!batch) throw new ApiError(404, 'Batch not found.');
      const student = await User.findOne({ _id: studentId, role: 'student' }).select('assignedBatch');
      if (!student) throw new ApiError(404, 'Student not found.');
      const existing = await BatchEnrollment.findOne({ student: studentId, batch: batch._id });
      if (existing?.status === 'active' && (!existing.accessEndsAt || existing.accessEndsAt > new Date())) throw new ApiError(409, 'Student is already enrolled.');
      if (!existing && String(student.assignedBatch || '') === String(batch._id)) throw new ApiError(409, 'Student is already enrolled through a legacy assignment.');
      const allMemberships = await BatchEnrollment.find({ batch: batch._id }).select('student status accessEndsAt').lean();
      const count = allMemberships.filter((m) => m.status === 'active' && (!m.accessEndsAt || m.accessEndsAt > new Date())).length + await User.countDocuments({ role: 'student', assignedBatch: batch._id, _id: { $nin: allMemberships.map((m) => m.student) } }) + await PaymentOrder.countDocuments({ batch: batch._id, status: { $in: ['creating', 'pending'] } });
      if (batch.capacity != null && count >= batch.capacity) throw new ApiError(409, 'Batch is full.');
      if (existing) {
        if (!existing.history.length) existing.history.push({ action: 'enrolled', source: existing.source, at: existing.enrolledAt, actor: existing.enrolledBy, payment: existing.payment });
        existing.status = 'active'; existing.source = 'ADMIN'; existing.enrolledBy = req.user!._id; existing.enrolledAt = new Date(); existing.accessEndsAt = undefined; existing.payment = undefined; existing.paymentVerifiedAt = paymentVerified === true ? new Date() : undefined; existing.paymentVerifiedBy = paymentVerified === true ? req.user!._id : undefined; existing.complimentaryGrantedAt = complimentary === true ? new Date() : undefined; existing.complimentaryGrantedBy = complimentary === true ? req.user!._id : undefined;
        existing.history.push({ action: 'enrolled', source: 'ADMIN', at: existing.enrolledAt, actor: req.user!._id });
        await existing.save();
      } else await BatchEnrollment.create({ student: studentId, batch: batch._id, source: 'ADMIN', enrolledBy: req.user!._id, ...(paymentVerified === true ? { paymentVerifiedAt: new Date(), paymentVerifiedBy: req.user!._id } : { complimentaryGrantedAt: new Date(), complimentaryGrantedBy: req.user!._id }), history: [{ action: 'enrolled', source: 'ADMIN', at: new Date(), actor: req.user!._id }] });
  });
  res.status(201).json({ status: 'success', message: 'Student enrolled.' });
}));
router.post('/admin/:id/enrollments/:studentId/verify-payment', catchAsync(async (req: Request, res: Response) => {
  if (req.body.paymentVerified !== true) throw new ApiError(400, 'Confirm that payment has been verified.');
  const result = await withBatchLock(String(req.params.id), async () => {
    const membership = await BatchEnrollment.findOne({ batch: req.params.id, student: req.params.studentId, status: 'active' });
    if (!membership) throw new ApiError(404, 'Active enrollment not found. Migrate the legacy assignment first.');
    if (!membership.paymentVerifiedAt) { membership.paymentVerifiedAt = new Date(); membership.paymentVerifiedBy = req.user!._id; await membership.save(); }
    return membership;
  });
  res.json({ status: 'success', data: result });
}));
router.delete('/admin/:id/enrollments/:studentId', catchAsync(async (req: Request, res: Response) => {
  const result = await withBatchLock(String(req.params.id), async () => {
  let result = await BatchEnrollment.findOne({ batch: req.params.id, student: req.params.studentId, status: 'active' });
  if (result) {
    if (!result.history.length) result.history.push({ action: 'enrolled', source: result.source, at: result.enrolledAt, actor: result.enrolledBy, payment: result.payment });
    result.history.push({ action: 'deactivated', source: result.source, at: new Date(), actor: req.user!._id });
    result.status = 'inactive'; await result.save();
  }
  if (!result && await User.exists({ _id: req.params.studentId, role: 'student', assignedBatch: req.params.id })) {
    result = await BatchEnrollment.findOneAndUpdate(
      { batch: req.params.id, student: req.params.studentId },
      { $setOnInsert: { source: 'LEGACY', status: 'inactive', enrolledAt: new Date(), history: [{ action: 'deactivated', source: 'LEGACY', at: new Date(), actor: req.user!._id }] } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    if (!result || result.status !== 'inactive') throw new ApiError(409, 'Enrollment is not active.');
  }
  if (!result) throw new ApiError(404, 'Active enrollment not found.');
  return result;
  });
  res.json({ status: 'success', data: result });
}));

export default router;
