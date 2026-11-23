import { type Types } from 'mongoose';
import { BatchEnrollment } from '../models/batchEnrollment.model.js';
import type { IUser } from '../models/user.model.js';

export async function accessibleBatchIds(user: IUser): Promise<Types.ObjectId[]> {
  const memberships = await BatchEnrollment.find({ student: user._id }).lean();
  const now = Date.now();
  return memberships.filter((m) => m.status === 'active' && (!!m.paymentVerifiedAt || !!m.complimentaryGrantedAt) && (!m.accessEndsAt || m.accessEndsAt.getTime() > now)).map((m) => m.batch);
}

export async function canAccessBatches(user: IUser, batches: Types.ObjectId[]): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (!batches.length) return false;
  if (user.role !== 'student') return false;
  const allowed = new Set((await accessibleBatchIds(user)).map(String));
  return batches.some((id) => allowed.has(String(id)));
}

export async function batchVisibilityFilter(user: IUser): Promise<Record<string, unknown>> {
  if (user.role === 'admin') return {};
  const ids = user.role === 'student' ? await accessibleBatchIds(user) : [];
  return { $or: [{ isPublic: true, batchIds: { $size: 0 } }, { batchIds: { $in: ids } }] };
}
