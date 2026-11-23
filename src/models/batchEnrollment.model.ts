import mongoose, { Schema, type Document, type Types } from 'mongoose';

/** A batch membership is independent of course progress and payment records. */
export interface IBatchEnrollment extends Document {
  student: Types.ObjectId;
  batch: Types.ObjectId;
  source: 'LEGACY' | 'ADMIN' | 'SELF_SERVICE';
  status: 'active' | 'inactive';
  enrolledBy?: Types.ObjectId;
  payment?: Types.ObjectId;
  enrolledAt: Date;
  paymentVerifiedAt?: Date;
  paymentVerifiedBy?: Types.ObjectId;
  complimentaryGrantedAt?: Date;
  complimentaryGrantedBy?: Types.ObjectId;
  accessEndsAt?: Date;
  history: Array<{ action: 'enrolled' | 'deactivated'; source: 'LEGACY' | 'ADMIN' | 'SELF_SERVICE'; at: Date; actor?: Types.ObjectId; payment?: Types.ObjectId }>;
}

const BatchEnrollmentSchema = new Schema<IBatchEnrollment>(
  {
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    batch: { type: Schema.Types.ObjectId, ref: 'Batch', required: true },
    source: { type: String, enum: ['LEGACY', 'ADMIN', 'SELF_SERVICE'], required: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
    enrolledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    enrolledAt: { type: Date, default: Date.now, required: true },
    paymentVerifiedAt: { type: Date },
    paymentVerifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    complimentaryGrantedAt: { type: Date },
    complimentaryGrantedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    accessEndsAt: { type: Date },
    history: { type: [{ action: { type: String, enum: ['enrolled', 'deactivated'], required: true }, source: { type: String, enum: ['LEGACY', 'ADMIN', 'SELF_SERVICE'], required: true }, at: { type: Date, required: true }, actor: { type: Schema.Types.ObjectId, ref: 'User' }, payment: { type: Schema.Types.ObjectId, ref: 'Payment' } }], default: [] },
  },
  { timestamps: true }
);

// One durable record per student/batch; changes of status must update that record.
BatchEnrollmentSchema.index({ student: 1, batch: 1 }, { unique: true });
BatchEnrollmentSchema.index({ batch: 1, status: 1 });

export const BatchEnrollment = mongoose.model<IBatchEnrollment>('BatchEnrollment', BatchEnrollmentSchema);
