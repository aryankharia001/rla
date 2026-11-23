import mongoose, { Schema, type Types } from 'mongoose';
interface Question { text: string; options: string[]; correctIndex: number; explanation: string }
interface ExamQuiz { examination: 'clat' | 'pu-law'; kind: string; title: string; batchIds: Types.ObjectId[]; published: boolean; questions: Question[] }
const questionSchema = new Schema<Question>({ text: { type: String, required: true, maxlength: 5000 }, options: { type: [String], required: true, validate: (v: string[]) => v.length >= 2 && v.length <= 6 && v.every((s) => !!s.trim()) }, correctIndex: { type: Number, required: true, min: 0 }, explanation: { type: String, default: '' } }, { _id: true });
const quizSchema = new Schema<ExamQuiz>({ examination: { type: String, enum: ['clat', 'pu-law'], required: true }, kind: { type: String, enum: ['clat-mock', 'clat-sectional', 'pu-mock', 'pu-legal', 'pu-gk'], required: true }, title: { type: String, required: true, maxlength: 200 }, batchIds: [{ type: Schema.Types.ObjectId, ref: 'Batch' }], published: { type: Boolean, default: false }, questions: { type: [questionSchema], required: true, validate: (v: Question[]) => v.length > 0 && v.length <= 150 && v.every((q) => Number.isInteger(q.correctIndex) && q.correctIndex < q.options.length) } }, { timestamps: true });
quizSchema.index({ examination: 1, kind: 1, published: 1, batchIds: 1 });
export const ExamQuiz = mongoose.model<ExamQuiz>('ExamQuiz', quizSchema);
interface Attempt { student: Types.ObjectId; quiz: Types.ObjectId; answers: Array<number | null>; score: number; total: number; createdAt: Date; updatedAt: Date }
const attemptSchema = new Schema<Attempt>({ student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, quiz: { type: Schema.Types.ObjectId, ref: 'ExamQuiz', required: true, index: true }, answers: { type: [Schema.Types.Mixed], required: true }, score: { type: Number, required: true }, total: { type: Number, required: true } }, { timestamps: true });
attemptSchema.index({ student: 1, createdAt: -1 });
export const ExamQuizAttempt = mongoose.model<Attempt>('ExamQuizAttempt', attemptSchema);
interface Star { student: Types.ObjectId; quiz: Types.ObjectId; questionId: Types.ObjectId }
const starSchema = new Schema<Star>({ student: { type: Schema.Types.ObjectId, ref: 'User', required: true }, quiz: { type: Schema.Types.ObjectId, ref: 'ExamQuiz', required: true }, questionId: { type: Schema.Types.ObjectId, required: true } }, { timestamps: true });
starSchema.index({ student: 1, quiz: 1, questionId: 1 }, { unique: true });
export const ExamQuizStar = mongoose.model<Star>('ExamQuizStar', starSchema);
