/**
 * Backfill legacy assignments without changing users or existing enrollments.
 * Dry run by default; pass --apply to write. Run from backend/ with MONGODB_URI set.
 */
import mongoose from 'mongoose';
import { MONGODB_URI } from '../config/env.js';
import User from '../models/user.model.js';
import { Batch } from '../models/timetable.model.js';
import { BatchEnrollment } from '../models/batchEnrollment.model.js';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  // Create the uniqueness constraint before writing, including in production.
  if (apply) await BatchEnrollment.createIndexes();
  let scanned = 0, missingBatch = 0, existing = 0, created = 0;
  const users = User.find({ role: 'student', assignedBatch: { $exists: true, $ne: null } })
    .select('_id assignedBatch createdAt').lean().cursor();
  for await (const user of users) {
    scanned++;
    if (!user.assignedBatch || !(await Batch.exists({ _id: user.assignedBatch }))) {
      missingBatch++;
      continue;
    }
    if (await BatchEnrollment.exists({ student: user._id, batch: user.assignedBatch })) {
      existing++;
      continue;
    }
    if (apply) {
      const result = await BatchEnrollment.updateOne(
        { student: user._id, batch: user.assignedBatch },
        { $setOnInsert: { student: user._id, batch: user.assignedBatch, source: 'LEGACY', status: 'active', enrolledAt: user.createdAt || new Date(), history: [] } },
        { upsert: true }
      );
      if (result.upsertedCount) created++; else existing++;
    } else created++;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', scanned, missingBatch, existing, [apply ? 'created' : 'wouldCreate']: created }, null, 2));
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
