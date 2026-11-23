import mongoose, { Schema, type Types } from 'mongoose';

export const resourceModules = ['daily-brief', 'fact-principle', 'current-affairs', 'critical-reasoning', 'clat-pyqs', 'clat-cutoff', 'pu-daily', 'pu-syllabus', 'pu-pyqs', 'pu-circulars', 'pu-cutoff'] as const;
export interface ExamResource {
  examination: 'clat' | 'pu-law';
  module: typeof resourceModules[number];
  title: string;
  content: string;
  batchIds: Types.ObjectId[];
  isPreview: boolean;
  isPublished: boolean;
}
const schema = new Schema<ExamResource>({
  examination: { type: String, enum: ['clat', 'pu-law'], required: true, index: true },
  module: { type: String, enum: resourceModules, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  content: { type: String, required: true, maxlength: 50000 },
  batchIds: [{ type: Schema.Types.ObjectId, ref: 'Batch' }],
  isPreview: { type: Boolean, default: false },
  isPublished: { type: Boolean, default: false },
}, { timestamps: true });
export const ExamResource = mongoose.model<ExamResource>('ExamResource', schema);
