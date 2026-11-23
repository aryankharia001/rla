import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { Batch } from '../models/timetable.model.js';
import { BatchEnrollment } from '../models/batchEnrollment.model.js';
import User from '../models/user.model.js';
import { PaymentOrder } from '../models/paymentOrder.model.js';
import { withBatchLock } from './batch.routes.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';

const router = Router();
function credentials() {
  const id = process.env.RAZORPAY_KEY_ID; const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new ApiError(503, 'Online payment is not configured.');
  return { id, secret, authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
}
function validSignature(secret: string, message: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', secret).update(message).digest();
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
async function reconcile(orderId: string, paymentId: string) {
  const { authorization } = credentials();
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new ApiError(400, 'Invalid payment reference.');
  const order = await PaymentOrder.findOne({ razorpayOrderId: orderId });
  if (!order) throw new ApiError(404, 'Payment order not found.');
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: authorization } });
  if (!response.ok) throw new ApiError(502, 'Unable to verify payment with Razorpay.');
  const payment = await response.json() as { id?: string; order_id?: string; status?: string; amount?: number; currency?: string };
  if (payment.id !== paymentId || payment.order_id !== orderId || payment.amount !== order.amount || payment.currency !== order.currency) throw new ApiError(400, 'Payment details do not match the order.');
  if (payment.status !== 'captured') throw new ApiError(409, 'Payment is not captured yet.');
  return withBatchLock(String(order.batch), async () => {
    const current = await PaymentOrder.findById(order._id);
    if (!current) throw new ApiError(404, 'Payment order not found.');
    if (current.status === 'paid') {
      if (current.razorpayPaymentId !== paymentId) throw new ApiError(409, 'Order was already paid with another payment.');
      return current;
    }
    if (current.status !== 'pending') throw new ApiError(409, 'Order is not awaiting payment.');
    const existing = await BatchEnrollment.findOne({ student: current.student, batch: current.batch });
    let enrollment = existing;
    if (enrollment) {
      enrollment.status = 'active'; enrollment.source = 'SELF_SERVICE'; enrollment.payment = current._id; enrollment.paymentVerifiedAt = new Date(); enrollment.accessEndsAt = undefined;
      enrollment.history.push({ action: 'enrolled', source: 'SELF_SERVICE', at: new Date(), payment: current._id });
      await enrollment.save();
    } else enrollment = await BatchEnrollment.create({ student: current.student, batch: current.batch, source: 'SELF_SERVICE', status: 'active', payment: current._id, paymentVerifiedAt: new Date(), history: [{ action: 'enrolled', source: 'SELF_SERVICE', at: new Date(), payment: current._id }] });
    current.status = 'paid'; current.razorpayPaymentId = paymentId; current.paidAt = new Date(); current.enrollment = enrollment._id; await current.save();
    return current;
  });
}

router.post('/webhook', catchAsync(async (req: Request, res: Response) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET; const signature = req.get('x-razorpay-signature') || '';
  if (!secret || !req.rawBody || !validSignature(secret, req.rawBody, signature)) throw new ApiError(401, 'Invalid webhook signature.');
  if (req.body?.event === 'payment.captured') {
    const entity = req.body?.payload?.payment?.entity;
    if (!entity?.order_id || !entity?.id) throw new ApiError(400, 'Missing payment references.');
    await reconcile(String(entity.order_id), String(entity.id));
  }
  res.json({ status: 'success' });
}));
router.use(protect, restrictTo('student'));
router.post('/orders', catchAsync(async (req: Request, res: Response) => {
  const { batchId } = req.body; if (!mongoose.isValidObjectId(batchId)) throw new ApiError(400, 'Invalid batch.');
  const auth = credentials();
  const result = await withBatchLock(String(batchId), async () => {
    const batch = await Batch.findById(batchId);
    if (!batch || !batch.examination || !batch.published || !batch.enrollmentOpen || batch.archived) throw new ApiError(409, 'Batch is not open for enrollment.');
    if (!Number.isSafeInteger(batch.feePaise) || !batch.feePaise || batch.feePaise < 100) throw new ApiError(400, 'Batch fee is not configured for online payment.');
    const membership = await BatchEnrollment.findOne({ student: req.user!._id, batch: batch._id });
    if (membership?.status === 'active' && (membership.paymentVerifiedAt || membership.complimentaryGrantedAt) && (!membership.accessEndsAt || membership.accessEndsAt > new Date())) throw new ApiError(409, 'Already enrolled.');
    const existing = await PaymentOrder.findOne({ student: req.user!._id, batch: batch._id, status: { $in: ['creating', 'pending'] } });
    if (existing?.status === 'pending' && existing.razorpayOrderId) return existing;
    if (existing) throw new ApiError(409, 'Payment order is being prepared.');
    const all = await BatchEnrollment.find({ batch: batch._id }).select('student status accessEndsAt').lean();
    const active = all.filter((m) => m.status === 'active' && (!m.accessEndsAt || m.accessEndsAt > new Date())).length;
    const legacy = await User.countDocuments({ role: 'student', assignedBatch: batch._id, _id: { $nin: all.map((m) => m.student) } });
    const reserved = await PaymentOrder.countDocuments({ batch: batch._id, status: { $in: ['creating', 'pending'] } });
    if (batch.capacity != null && active + legacy + reserved >= batch.capacity) throw new ApiError(409, 'Batch is full.');
    const record = await PaymentOrder.create({ student: req.user!._id, batch: batch._id, examination: batch.examination, amount: batch.feePaise, currency: 'INR', status: 'creating' });
    try {
      const response = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { Authorization: auth.authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: record.amount, currency: record.currency, receipt: String(record._id) }) });
      if (!response.ok) throw new ApiError(502, 'Unable to create Razorpay order.');
      const remote = await response.json() as { id?: string; amount?: number; currency?: string };
      if (!remote.id || remote.amount !== record.amount || remote.currency !== record.currency) throw new ApiError(502, 'Invalid Razorpay order response.');
      record.razorpayOrderId = remote.id; record.status = 'pending'; await record.save(); return record;
    } catch (error) { record.status = 'failed'; await record.save(); throw error; }
  });
  res.json({ status: 'success', data: { orderId: result.razorpayOrderId, amount: result.amount, currency: result.currency, keyId: auth.id } });
}));
router.post('/verify', catchAsync(async (req: Request, res: Response) => {
  const { orderId, paymentId, signature } = req.body; const { secret } = credentials();
  if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') throw new ApiError(400, 'Missing payment verification details.');
  const record = await PaymentOrder.findOne({ razorpayOrderId: orderId, student: req.user!._id });
  if (!record) throw new ApiError(404, 'Payment order not found.');
  if (!validSignature(secret, `${orderId}|${paymentId}`, signature)) throw new ApiError(400, 'Invalid payment signature.');
  await reconcile(orderId, paymentId);
  res.json({ status: 'success', message: 'Payment verified and batch enrollment activated.' });
}));
router.get('/history', catchAsync(async (req: Request, res: Response) => { res.json({ status: 'success', data: await PaymentOrder.find({ student: req.user!._id }).select('-__v').sort({ createdAt: -1 }).lean() }); }));
export default router;
