import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { ExamQuiz, ExamQuizAttempt, ExamQuizStar } from '../models/examQuiz.model.js';
import { Batch } from '../models/timetable.model.js';
import { accessibleBatchIds } from '../services/batchAccess.service.js';
import { protect, restrictTo } from '../middlewares/auth.middleware.js';
import { requirePermission } from '../middlewares/checkPermission.middleware.js';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';

const kinds: Record<string, string[]> = { clat: ['clat-mock', 'clat-sectional'], 'pu-law': ['pu-mock', 'pu-legal', 'pu-gk'] };
const router = Router(); router.use(protect);
router.get('/starred', catchAsync(async (req: Request, res: Response) => {
  const exam = String(req.query.examination || ''); if (!kinds[exam]) throw new ApiError(400, 'Invalid examination.');
  const ids = await accessibleBatchIds(req.user!); const quizzes = await ExamQuiz.find({ examination: exam, published: true, batchIds: { $in: ids } }).lean();
  const stars = await ExamQuizStar.find({ student: req.user!._id, quiz: { $in: quizzes.map((q) => q._id) } }).lean();
  const data = stars.flatMap((star) => { const quiz = quizzes.find((q) => String(q._id) === String(star.quiz)); const question = quiz?.questions.find((q: any) => String(q._id) === String(star.questionId)); return quiz && question ? [{ quizId: quiz._id, questionId: star.questionId, quizTitle: quiz.title, text: question.text, options: question.options }] : []; });
  res.json({ status: 'success', data });
}));
router.get('/history', catchAsync(async (req: Request, res: Response) => {
  const exam = String(req.query.examination || ''); if (!kinds[exam]) throw new ApiError(400, 'Invalid examination.');
  const ids = await accessibleBatchIds(req.user!); const quizzes = await ExamQuiz.find({ examination: exam, published: true, batchIds: { $in: ids } }).lean();
  const attempts = await ExamQuizAttempt.find({ student: req.user!._id, quiz: { $in: quizzes.map((q) => q._id) } }).sort({ createdAt: -1 }).limit(100).lean();
  const data = attempts.map((attempt) => { const quiz = quizzes.find((q) => String(q._id) === String(attempt.quiz)); return { _id: attempt._id, title: quiz?.title, score: attempt.score, total: attempt.total, createdAt: attempt.createdAt, mistakes: quiz?.questions.flatMap((q, i) => attempt.answers[i] === q.correctIndex ? [] : [{ text: q.text, selected: attempt.answers[i] == null ? 'Not answered' : q.options[attempt.answers[i] as number], correct: q.options[q.correctIndex], explanation: q.explanation }]) || [] }; });
  res.json({ status: 'success', data });
}));
router.get('/', catchAsync(async (req: Request, res: Response) => {
  const examination = String(req.query.examination || ''); const kind = String(req.query.kind || '');
  if (!kinds[examination]?.includes(kind)) throw new ApiError(400, 'Invalid examination or test type.');
  const ids = await accessibleBatchIds(req.user!);
  const quizzes = await ExamQuiz.find({ examination, kind, published: true, batchIds: { $in: ids } }).select('title examination kind questions._id').lean();
  res.json({ status: 'success', data: quizzes.map((q) => ({ _id: q._id, title: q.title, questionCount: q.questions.length })) });
}));
router.get('/:id', catchAsync(async (req: Request, res: Response) => {
  const ids = await accessibleBatchIds(req.user!); const quiz = await ExamQuiz.findOne({ _id: req.params.id, published: true, batchIds: { $in: ids } }).lean();
  if (!quiz) throw new ApiError(404, 'Test not found.');
  res.json({ status: 'success', data: { _id: quiz._id, title: quiz.title, questions: quiz.questions.map((q: any) => ({ _id: q._id, text: q.text, options: q.options })) } });
}));
router.post('/:id/submit', catchAsync(async (req: Request, res: Response) => {
  const ids = await accessibleBatchIds(req.user!); const quiz = await ExamQuiz.findOne({ _id: req.params.id, published: true, batchIds: { $in: ids } }).lean();
  if (!quiz) throw new ApiError(404, 'Test not found.');
  if (!Array.isArray(req.body.answers) || req.body.answers.length !== quiz.questions.length || req.body.answers.some((v: unknown, i: number) => v !== null && (!Number.isInteger(v) || Number(v) < 0 || Number(v) >= quiz.questions[i]!.options.length))) throw new ApiError(400, 'Invalid answers.');
  const review = quiz.questions.map((q, i) => ({ correctIndex: q.correctIndex, explanation: q.explanation, correct: req.body.answers[i] === q.correctIndex }));
  const score = review.filter((r) => r.correct).length;
  await ExamQuizAttempt.create({ student: req.user!._id, quiz: quiz._id, answers: req.body.answers, score, total: review.length });
  res.json({ status: 'success', data: { score, total: review.length, review } });
}));
router.post('/:id/star', catchAsync(async (req: Request, res: Response) => {
  const ids = await accessibleBatchIds(req.user!); const quiz = await ExamQuiz.findOne({ _id: req.params.id, published: true, batchIds: { $in: ids } }).lean();
  if (!quiz || !mongoose.isValidObjectId(req.body.questionId) || !quiz.questions.some((q: any) => String(q._id) === String(req.body.questionId))) throw new ApiError(404, 'Question not found.');
  const query = { student: req.user!._id, quiz: quiz._id, questionId: req.body.questionId };
  if (req.body.starred === true) { await ExamQuizStar.updateOne(query, { $setOnInsert: query }, { upsert: true }); res.json({ status: 'success', starred: true }); }
  else if (req.body.starred === false) { await ExamQuizStar.deleteOne(query); res.json({ status: 'success', starred: false }); }
  else throw new ApiError(400, 'Specify starred as true or false.');
}));
router.post('/admin/create', restrictTo('admin'), requirePermission('courses:manage'), catchAsync(async (req: Request, res: Response) => {
  const { examination, kind, title, batchId, questions } = req.body;
  if (!kinds[examination]?.includes(kind) || !mongoose.isValidObjectId(batchId) || !await Batch.exists({ _id: batchId, examination })) throw new ApiError(400, 'Invalid examination, test type or batch.');
  if (kind === 'clat-mock' && (!Array.isArray(questions) || questions.length !== 120)) throw new ApiError(400, 'A CLAT full-length mock must contain 120 questions.');
  const quiz = await ExamQuiz.create({ examination, kind, title, batchIds: [batchId], published: true, questions });
  res.status(201).json({ status: 'success', data: { _id: quiz._id } });
}));
router.get('/admin/list', restrictTo('admin'), requirePermission('courses:manage'), catchAsync(async (req: Request, res: Response) => {
  if (!mongoose.isValidObjectId(req.query.batchId)) throw new ApiError(400, 'Invalid batch.');
  const items = await ExamQuiz.find({ batchIds: req.query.batchId }).select('title kind published questions._id').sort({ createdAt: -1 }).lean();
  res.json({ status: 'success', data: items.map((item) => ({ _id: item._id, title: item.title, kind: item.kind, published: item.published, questionCount: item.questions.length })) });
}));
router.patch('/admin/:id', restrictTo('admin'), requirePermission('courses:manage'), catchAsync(async (req: Request, res: Response) => {
  if (typeof req.body.published !== 'boolean') throw new ApiError(400, 'Specify the published status.');
  const item = await ExamQuiz.findByIdAndUpdate(req.params.id, { published: req.body.published }, { new: true, runValidators: true });
  if (!item) throw new ApiError(404, 'Test not found.');
  res.json({ status: 'success', data: { _id: item._id, published: item.published } });
}));
export default router;
